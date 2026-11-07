"""
TimeCapsule Domain Package — P03:
Media Vault, Presigned Private Upload Intents, Magic-Byte MIME Sniffing,
Binary EXIF/GPS Metadata Stripper (PNG & JPEG), Pixel/Size Guards (A14),
User-Scoped Object ACL (A10), and Orphan Object Scanner (A05).
"""
from __future__ import annotations

from datetime import datetime
import struct
from typing import Any
import uuid
import zlib

from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
    utc_now_iso,
)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SOI = b"\xff\xd8"
POLYGLOT_PATTERNS = (b"<script", b"<?php", b"#!/", b"\x7fELF")

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MiB
MAX_DIMENSION_PX = 8192


class MediaVaultService:
    """
    P03: Enforces private upload intents, binary MIME & polyglot inspection (A14),
    EXIF/GPS removal for PNG and JPEG, owner-scoped ACL (A10), and orphan reconciliation (A05).
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        identity: IdentityConsentService,
        *,
        max_upload_bytes: int = MAX_UPLOAD_BYTES,
        max_dimension_px: int = MAX_DIMENSION_PX,
    ) -> None:
        self.db = db
        self.identity = identity
        self.max_upload_bytes = max_upload_bytes
        self.max_dimension_px = max_dimension_px
        self._init_storage_table()

    def _init_storage_table(self) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS storage_object (
                    storage_key TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    byte_size INTEGER NOT NULL,
                    blob_bytes BLOB NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

    def create_upload_intent(
        self,
        *,
        actor_user_id: str,
        declared_media_type: str,
        declared_size_bytes: int,
        declared_sha256: str,
        client_supplied_storage_key: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P03: Issues a short-lived private upload intent.
        Strictly rejects client-supplied storage paths (AGENTS.md invariant).
        """
        if client_supplied_storage_key is not None:
            raise TimeCapsuleError(
                "CLIENT_STORAGE_KEY_FORBIDDEN",
                "Client-supplied storage paths are forbidden; server assigns private bucket keys",
                400,
            )
        if declared_media_type not in ("image/png", "image/jpeg", "image/webp"):
            raise TimeCapsuleError(
                "UNSUPPORTED_MEDIA_TYPE",
                f"Unsupported media type '{declared_media_type}'",
                400,
            )
        if declared_size_bytes <= 0 or declared_size_bytes > self.max_upload_bytes:
            raise TimeCapsuleError(
                "UPLOAD_SIZE_LIMIT_EXCEEDED",
                f"Upload size {declared_size_bytes} outside allowed range 1..{self.max_upload_bytes}",
                413,
            )
        if len(declared_sha256) != 64:
            raise TimeCapsuleError("INVALID_SHA256", "Declared sha256 must be 64 hex characters", 400)

        now_str = utc_now_iso(now)
        asset_id = str(uuid.uuid4())
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[declared_media_type]
        storage_key = f"private/{actor_user_id}/{asset_id}.{ext}"

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO media_asset (
                    id, user_id, storage_key, sha256, media_type,
                    byte_size, width_px, height_px, exif_stripped, state, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'UPLOADING', ?, 1)
                """,
                (asset_id, actor_user_id, storage_key, declared_sha256.lower(), declared_media_type, declared_size_bytes, now_str),
            )
        return {
            "asset_id": asset_id,
            "storage_key": storage_key,
            "upload_url": f"https://upload.timecapsule.internal/v1/uploads/{asset_id}",
            "max_bytes": self.max_upload_bytes,
            "state": "UPLOADING",
            "created_at": now_str,
        }

    def upload_and_sanitize(
        self,
        *,
        actor_user_id: str,
        asset_id: str,
        raw_bytes: bytes,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P03 & A14: Inspects magic bytes, rejects spoofed MIME or polyglot payloads,
        verifies pixel dimensions, strips EXIF/GPS metadata, stores sanitized bytes,
        and transitions asset to READY.
        """
        row = self.db.query_one(
            "SELECT id, user_id, storage_key, sha256, media_type, byte_size, state, version FROM media_asset WHERE id = ?",
            (asset_id,),
        )
        if row is None:
            raise TimeCapsuleError("ASSET_NOT_FOUND", f"Asset {asset_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="media_asset",
            resource_id=asset_id,
        )
        if str(row["state"]) != "UPLOADING":
            raise TimeCapsuleError("INVALID_ASSET_STATE", f"Asset {asset_id} is in state {row['state']}", 409)

        if len(raw_bytes) == 0 or len(raw_bytes) > self.max_upload_bytes:
            self._quarantine_asset(asset_id, int(row["version"]))
            raise TimeCapsuleError("UPLOAD_SIZE_LIMIT_EXCEEDED", "Uploaded bytes exceed size limit", 413)

        actual_raw_sha256 = sha256_hex(raw_bytes)
        if actual_raw_sha256 != str(row["sha256"]):
            self._quarantine_asset(asset_id, int(row["version"]))
            raise TimeCapsuleError("UPLOAD_SHA256_MISMATCH", "Uploaded payload SHA-256 does not match intent", 400)

        for bad_marker in POLYGLOT_PATTERNS:
            if bad_marker in raw_bytes.lower():
                self._quarantine_asset(asset_id, int(row["version"]))
                raise TimeCapsuleError("MALICIOUS_POLYGLOT_DETECTED", "Disguised script or executable payload rejected", 400)

        sniffed_mime, width, height, sanitized_bytes, exif_removed = self._inspect_and_strip_exif(raw_bytes)
        if sniffed_mime != str(row["media_type"]):
            self._quarantine_asset(asset_id, int(row["version"]))
            raise TimeCapsuleError(
                "MIME_SPOOFING_DETECTED",
                f"Sniffed MIME '{sniffed_mime}' does not match declared '{row['media_type']}'",
                400,
            )
        if width <= 0 or height <= 0 or width > self.max_dimension_px or height > self.max_dimension_px:
            self._quarantine_asset(asset_id, int(row["version"]))
            raise TimeCapsuleError(
                "IMAGE_DIMENSIONS_EXCEEDED",
                f"Image dimensions {width}x{height} outside allowed 1..{self.max_dimension_px}",
                400,
            )

        clean_sha256 = sha256_hex(sanitized_bytes)
        now_str = utc_now_iso(now)
        storage_key = str(row["storage_key"])

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO storage_object (storage_key, sha256, media_type, byte_size, blob_bytes, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (storage_key, clean_sha256, sniffed_mime, len(sanitized_bytes), sanitized_bytes, now_str),
            )
            cur = conn.execute(
                """
                UPDATE media_asset
                SET sha256 = ?, byte_size = ?, width_px = ?, height_px = ?, exif_stripped = 1, state = 'READY', version = version + 1
                WHERE id = ? AND version = ?
                """,
                (clean_sha256, len(sanitized_bytes), width, height, asset_id, int(row["version"])),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Media asset optimistic lock conflict", 409)

        return {
            "asset_id": asset_id,
            "storage_key": storage_key,
            "media_type": sniffed_mime,
            "width_px": width,
            "height_px": height,
            "byte_size": len(sanitized_bytes),
            "sha256": clean_sha256,
            "exif_stripped": True,
            "exif_segments_removed": exif_removed,
            "state": "READY",
        }

    def _quarantine_asset(self, asset_id: str, version: int) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE media_asset SET state = 'QUARANTINED', version = version + 1 WHERE id = ? AND version = ?",
                (asset_id, version),
            )

    def get_asset_for_user(
        self,
        *,
        actor_user_id: str,
        asset_id: str,
        include_bytes: bool = False,
    ) -> dict[str, Any]:
        row = self.db.query_one(
            """
            SELECT id, user_id, storage_key, sha256, media_type, byte_size, width_px, height_px, exif_stripped, state, created_at
            FROM media_asset
            WHERE id = ?
            """,
            (asset_id,),
        )
        if row is None:
            raise TimeCapsuleError("ASSET_NOT_FOUND", f"Asset {asset_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="media_asset",
            resource_id=asset_id,
        )
        if str(row["state"]) != "READY":
            raise TimeCapsuleError(
                "ASSET_NOT_AVAILABLE",
                f"Asset {asset_id} is in state '{row['state']}' and cannot be read",
                409,
            )
        result = dict(row)
        result["exif_stripped"] = bool(row["exif_stripped"])
        if include_bytes:
            obj = self.db.query_one(
                "SELECT blob_bytes FROM storage_object WHERE storage_key = ?",
                (str(row["storage_key"]),),
            )
            if obj is None:
                raise TimeCapsuleError("STORAGE_OBJECT_MISSING", "Underlying storage object missing", 500)
            result["bytes"] = bytes(obj["blob_bytes"])
        return result

    def store_derived_asset(
        self,
        *,
        user_id: str,
        media_type: str,
        payload_bytes: bytes,
        width_px: int,
        height_px: int,
        prefix: str = "rendered",
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Stores a server-generated rendered or exported image in the user's private vault."""
        now_str = utc_now_iso(now)
        asset_id = str(uuid.uuid4())
        ext = "png" if media_type == "image/png" else "webp"
        storage_key = f"private/{user_id}/{prefix}/{asset_id}.{ext}"
        digest = sha256_hex(payload_bytes)
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO storage_object (storage_key, sha256, media_type, byte_size, blob_bytes, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (storage_key, digest, media_type, len(payload_bytes), payload_bytes, now_str),
            )
            conn.execute(
                """
                INSERT INTO media_asset (
                    id, user_id, storage_key, sha256, media_type,
                    byte_size, width_px, height_px, exif_stripped, state, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'READY', ?, 1)
                """,
                (asset_id, user_id, storage_key, digest, media_type, len(payload_bytes), width_px, height_px, now_str),
            )
        return {
            "asset_id": asset_id,
            "storage_key": storage_key,
            "sha256": digest,
            "byte_size": len(payload_bytes),
            "width_px": width_px,
            "height_px": height_px,
        }

    def run_orphan_scanner(self) -> dict[str, Any]:
        """
        A05: Reconciles private object storage against media_asset records.
        Deletes any storage_object that has no corresponding media_asset row or whose media_asset is DELETED/QUARANTINED.
        """
        with self.db.transaction() as conn:
            orphans = conn.execute(
                """
                SELECT s.storage_key
                FROM storage_object s
                LEFT JOIN media_asset m ON m.storage_key = s.storage_key
                WHERE m.id IS NULL OR m.state IN ('DELETED', 'QUARANTINED')
                """
            ).fetchall()
            purged_keys = [str(r["storage_key"]) for r in orphans]
            for key in purged_keys:
                conn.execute("DELETE FROM storage_object WHERE storage_key = ?", (key,))
        return {
            "scanned": True,
            "purged_orphan_count": len(purged_keys),
            "purged_storage_keys": purged_keys,
        }

    @classmethod
    def _inspect_and_strip_exif(cls, data: bytes) -> tuple[str, int, int, bytes, bool]:
        if data.startswith(PNG_SIGNATURE):
            return cls._parse_and_strip_png(data)
        if data.startswith(JPEG_SOI):
            return cls._parse_and_strip_jpeg(data)
        if len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return cls._parse_and_strip_webp(data)
        raise TimeCapsuleError("MIME_SPOOFING_DETECTED", "Unrecognized binary image signature", 400)

    @staticmethod
    def _parse_and_strip_png(data: bytes) -> tuple[str, int, int, bytes, bool]:
        offset = 8
        width = 0
        height = 0
        out = bytearray(PNG_SIGNATURE)
        removed_meta = False
        forbidden_chunks = {b"eXIf", b"tEXt", b"iTXt", b"zTXt"}
        saw_ihdr = False
        saw_iend = False

        while offset + 8 <= len(data):
            length = struct.unpack(">I", data[offset : offset + 4])[0]
            chunk_type = data[offset + 4 : offset + 8]
            chunk_end = offset + 8 + length + 4
            if chunk_end > len(data):
                raise TimeCapsuleError("CORRUPT_IMAGE", "Truncated PNG chunk", 400)
            chunk_data = data[offset + 8 : offset + 8 + length]
            expected_crc = struct.unpack(">I", data[offset + 8 + length : chunk_end])[0]
            actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
            if expected_crc != actual_crc:
                raise TimeCapsuleError("CORRUPT_IMAGE", f"Invalid PNG CRC in chunk {chunk_type!r}", 400)

            if chunk_type == b"IHDR":
                if length < 8:
                    raise TimeCapsuleError("CORRUPT_IMAGE", "Invalid PNG IHDR length", 400)
                width, height = struct.unpack(">II", chunk_data[:8])
                saw_ihdr = True

            if chunk_type in forbidden_chunks:
                removed_meta = True
            else:
                out.extend(data[offset:chunk_end])

            offset = chunk_end
            if chunk_type == b"IEND":
                saw_iend = True
                break

        if not saw_ihdr or not saw_iend:
            raise TimeCapsuleError("CORRUPT_IMAGE", "Incomplete PNG structure", 400)
        return "image/png", width, height, bytes(out), removed_meta

    @staticmethod
    def _parse_and_strip_jpeg(data: bytes) -> tuple[str, int, int, bytes, bool]:
        if len(data) < 4 or data[:2] != JPEG_SOI:
            raise TimeCapsuleError("CORRUPT_IMAGE", "Invalid JPEG SOI", 400)
        offset = 2
        width = 0
        height = 0
        removed_meta = False
        out = bytearray(JPEG_SOI)

        while offset < len(data):
            if data[offset] != 0xFF:
                raise TimeCapsuleError("CORRUPT_IMAGE", "Malformed JPEG marker", 400)
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1

            if marker == 0xD9:  # EOI
                out.extend(b"\xff\xd9")
                break
            if marker == 0xDA:  # SOS: copy header and entropy-coded scan until EOI
                if offset + 2 > len(data):
                    raise TimeCapsuleError("CORRUPT_IMAGE", "Truncated JPEG SOS", 400)
                seg_len = struct.unpack(">H", data[offset : offset + 2])[0]
                out.extend(b"\xff\xda")
                out.extend(data[offset:])
                break
            if marker in (0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0x01):
                out.extend(bytes([0xFF, marker]))
                continue

            if offset + 2 > len(data):
                raise TimeCapsuleError("CORRUPT_IMAGE", "Truncated JPEG segment length", 400)
            seg_len = struct.unpack(">H", data[offset : offset + 2])[0]
            if seg_len < 2 or offset + seg_len > len(data):
                raise TimeCapsuleError("CORRUPT_IMAGE", "Invalid JPEG segment length", 400)
            seg_payload = data[offset + 2 : offset + seg_len]

            # SOF0 / SOF1 / SOF2 markers carry height & width
            if marker in (0xC0, 0xC1, 0xC2) and len(seg_payload) >= 5:
                height, width = struct.unpack(">HH", seg_payload[1:5])

            # Strip APP1..APP15 (Exif/GPS/XMP) and COM (0xFE) segments
            if (0xE1 <= marker <= 0xEF) or marker == 0xFE:
                removed_meta = True
            else:
                out.extend(bytes([0xFF, marker]))
                out.extend(data[offset : offset + seg_len])

            offset += seg_len

        if width <= 0 or height <= 0:
            raise TimeCapsuleError("CORRUPT_IMAGE", "JPEG missing SOF dimensions", 400)
        return "image/jpeg", width, height, bytes(out), removed_meta

    @staticmethod
    def _parse_and_strip_webp(data: bytes) -> tuple[str, int, int, bytes, bool]:
        if len(data) < 30:
            raise TimeCapsuleError("CORRUPT_IMAGE", "Truncated WebP file", 400)
        chunk_type = data[12:16]
        if chunk_type == b"VP8X" and len(data) >= 30:
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
            return "image/webp", width, height, data, False
        raise TimeCapsuleError("CORRUPT_IMAGE", "Unsupported WebP header", 400)
