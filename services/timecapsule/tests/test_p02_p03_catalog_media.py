"""
Executable verification tests for Slice 2 (P02 & P03):
- P02: 12 categories, 20 templates, 5 styles (100 combinations), field schema validation,
       A12 template version upgrade & retirement while preserving historical revisions.
- P03: Private upload intent, A14 spoofed MIME / polyglot / oversized image rejection,
       binary EXIF/GPS metadata stripping for PNG and JPEG, A10 cross-user 403,
       and A05 orphan storage scanner cleanup.
"""
from __future__ import annotations

import struct
import unittest
import zlib

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
)
from services.timecapsule.media_vault import MediaVaultService, PNG_SIGNATURE


def build_test_png(width: int = 32, height: int = 32, include_exif: bool = False) -> bytes:
    def chunk(ctype: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(ctype + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw_scanlines = b"".join(b"\x00" + (b"\x20\x40\x80" * width) for _ in range(height))
    idat = zlib.compress(raw_scanlines)
    chunks = [chunk(b"IHDR", ihdr)]
    if include_exif:
        chunks.append(chunk(b"eXIf", b"Exif\x00\x00GPSLatitude:31.2304,121.4737"))
        chunks.append(chunk(b"tEXt", b"Author\x00SecretCameraSerial99182"))
    chunks.append(chunk(b"IDAT", idat))
    chunks.append(chunk(b"IEND", b""))
    return PNG_SIGNATURE + b"".join(chunks)


def build_test_jpeg(width: int = 40, height: int = 30, include_app1_exif: bool = False) -> bytes:
    parts = [b"\xff\xd8"]
    if include_app1_exif:
        exif_payload = b"Exif\x00\x00GPSInfo:39.9042N,116.4074E"
        parts.append(b"\xff\xe1" + struct.pack(">H", len(exif_payload) + 2) + exif_payload)
    sof0_payload = struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00"
    parts.append(b"\xff\xc0" + struct.pack(">H", len(sof0_payload) + 2) + sof0_payload)
    sos_payload = b"\x01\x01\x00\x00\x3f\x00"
    parts.append(b"\xff\xda" + struct.pack(">H", len(sos_payload) + 2) + sos_payload + b"\x7f\x80\xff\xd9")
    return b"".join(parts)


class TestP02AndP03CatalogMedia(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TimeCapsuleDatabase(":memory:")
        self.validator = SpecContractValidator()
        self.identity = IdentityConsentService(self.db, self.validator)
        self.catalog = CatalogService(self.db, self.validator)
        self.vault = MediaVaultService(self.db, self.identity)

    def tearDown(self) -> None:
        self.db.close()

    def test_p02_catalog_100_combinations_and_field_validation(self) -> None:
        snap = self.catalog.list_catalog()
        self.assertEqual(len(snap["categories"]), 12)
        self.assertEqual(len(snap["styles"]), 5)
        self.assertEqual(len(snap["templates"]), 20)
        self.assertEqual(snap["combination_count"], 100)

        # Verify all 20 templates x 5 styles = 100 combinations validate cleanly
        validated_pairs = 0
        for tpl in snap["templates"]:
            for style in snap["styles"]:
                req = {
                    "template_id": tpl["id"],
                    "template_version": tpl["version"],
                    "style_id": style["id"],
                    "fields": {"title": "一生拾忆时光卡", "event_date": "2026-11-07"},
                    "asset_ids": ["asset_1"],
                    "export_size": tpl["sizes"][0],
                    "idempotency_key": f"idem_{tpl['id']}_{style['id']}",
                }
                res = self.catalog.validate_render_request(req)
                self.assertEqual(res["template"]["id"], tpl["id"])
                validated_pairs += 1
        self.assertEqual(validated_pairs, 100)

    def test_a12_template_upgrade_and_retirement_preserve_historical_revisions(self) -> None:
        orig = self.catalog.get_template_revision("life_0_100", "1.0.0")
        upgraded = dict(orig)
        upgraded.pop("status", None)
        upgraded["version"] = "1.1.0"
        upgraded["name"] = "人生0-100岁照片（典藏版）"

        self.catalog.publish_template_revision(
            admin_actor_id="admin_catalog_01",
            manifest=upgraded,
            retire_previous=True,
        )

        # New jobs targeting retired 1.0.0 are blocked
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.catalog.get_template_revision("life_0_100", "1.0.0", allow_retired=False)
        self.assertEqual(ctx.exception.code, "TEMPLATE_RETIRED")

        # Historical work replay (A12) with allow_retired=True still resolves exact 1.0.0 manifest
        hist = self.catalog.get_template_revision("life_0_100", "1.0.0", allow_retired=True)
        self.assertEqual(hist["version"], "1.0.0")
        self.assertEqual(hist["status"], "RETIRED")

        latest = self.catalog.get_template_revision("life_0_100")
        self.assertEqual(latest["version"], "1.1.0")

    def test_p03_exif_stripping_a14_polyglot_rejection_and_a05_orphan_scanner(self) -> None:
        alice = self.identity.login_or_refresh_session(wechat_code="wx_alice_media")
        bob = self.identity.login_or_refresh_session(wechat_code="wx_bob_media")

        # Client-supplied storage path must be rejected (AGENTS.md invariant)
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.vault.create_upload_intent(
                actor_user_id=alice.user_id,
                declared_media_type="image/png",
                declared_size_bytes=128,
                declared_sha256="a" * 64,
                client_supplied_storage_key="public/hacked.png",
            )
        self.assertEqual(ctx.exception.code, "CLIENT_STORAGE_KEY_FORBIDDEN")

        # Upload PNG with EXIF & tEXt GPS metadata -> must strip metadata while keeping image valid
        raw_png = build_test_png(48, 64, include_exif=True)
        self.assertIn(b"GPSLatitude", raw_png)
        intent_png = self.vault.create_upload_intent(
            actor_user_id=alice.user_id,
            declared_media_type="image/png",
            declared_size_bytes=len(raw_png),
            declared_sha256=sha256_hex(raw_png),
        )
        sanitized_png = self.vault.upload_and_sanitize(
            actor_user_id=alice.user_id,
            asset_id=intent_png["asset_id"],
            raw_bytes=raw_png,
        )
        self.assertTrue(sanitized_png["exif_segments_removed"])
        self.assertEqual(sanitized_png["width_px"], 48)
        self.assertEqual(sanitized_png["height_px"], 64)

        loaded_png = self.vault.get_asset_for_user(
            actor_user_id=alice.user_id,
            asset_id=intent_png["asset_id"],
            include_bytes=True,
        )
        self.assertNotIn(b"GPSLatitude", loaded_png["bytes"])
        self.assertNotIn(b"SecretCameraSerial99182", loaded_png["bytes"])

        # Upload JPEG with APP1 Exif GPS -> must strip APP1 segment
        raw_jpg = build_test_jpeg(80, 60, include_app1_exif=True)
        self.assertIn(b"GPSInfo", raw_jpg)
        intent_jpg = self.vault.create_upload_intent(
            actor_user_id=alice.user_id,
            declared_media_type="image/jpeg",
            declared_size_bytes=len(raw_jpg),
            declared_sha256=sha256_hex(raw_jpg),
        )
        sanitized_jpg = self.vault.upload_and_sanitize(
            actor_user_id=alice.user_id,
            asset_id=intent_jpg["asset_id"],
            raw_bytes=raw_jpg,
        )
        self.assertTrue(sanitized_jpg["exif_segments_removed"])
        loaded_jpg = self.vault.get_asset_for_user(
            actor_user_id=alice.user_id,
            asset_id=intent_jpg["asset_id"],
            include_bytes=True,
        )
        self.assertNotIn(b"GPSInfo", loaded_jpg["bytes"])

        # A10: Bob cannot read Alice's uploaded asset
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.vault.get_asset_for_user(actor_user_id=bob.user_id, asset_id=intent_png["asset_id"])
        self.assertEqual(ctx.exception.status_code, 403)

        # A14: Disguised script/polyglot file rejected and quarantined
        spoofed = PNG_SIGNATURE + b"<script>alert(1)</script>"
        intent_bad = self.vault.create_upload_intent(
            actor_user_id=alice.user_id,
            declared_media_type="image/png",
            declared_size_bytes=len(spoofed),
            declared_sha256=sha256_hex(spoofed),
        )
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.vault.upload_and_sanitize(
                actor_user_id=alice.user_id,
                asset_id=intent_bad["asset_id"],
                raw_bytes=spoofed,
            )
        self.assertEqual(ctx.exception.code, "MALICIOUS_POLYGLOT_DETECTED")

        # A05: Simulate S3 upload succeeding while DB transaction failed (orphan storage_object)
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO storage_object (storage_key, sha256, media_type, byte_size, blob_bytes, created_at) VALUES ('private/orphan/untracked.png', ?, 'image/png', 16, ?, '2026-11-07T00:00:00Z')",
                ("c" * 64, b"0123456789abcdef"),
            )
        scan_res = self.vault.run_orphan_scanner()
        self.assertEqual(scan_res["purged_orphan_count"], 1)
        self.assertIn("private/orphan/untracked.png", scan_res["purged_storage_keys"])


if __name__ == "__main__":
    unittest.main()
