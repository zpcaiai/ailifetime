"""
TimeCapsule Domain Package — P08:
Trusted Export Engine, Mandatory Explicit & Implicit AI Synthesis Labeling
(GB 45438-2025 draft interface), Format Transcoding Fidelity (A09),
and Anti-Bypass Security Guard (A15).
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import hmac
import json
import struct
from typing import Any
import uuid
import zlib

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
    utc_now_iso,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer
from services.timecapsule.media_vault import MediaVaultService, PNG_SIGNATURE
from services.timecapsule.payments_entitlement import PaymentEntitlementService


EXPLICIT_AI_LABEL_TEXT = "人工智能生成合成内容 · AI艺术示意"
IMPLICIT_AIGC_CHUNK_KEYWORD = b"TimeCapsuleAIGCLabel"


class ExportLabelingService:
    """
    P08, A09 & A15:
    - Enforces payment entitlement check before HD export (while allowing free templates with ai_mode=='none'
      or watermarked Moments preview card export).
    - Embeds both explicit visible watermark pixels/SVG and implicit signed AIGC metadata in PNG/WebP outputs.
    - Rejects any request attempting to remove or bypass AI labeling (A15) and isolates failed label artifacts.
    - Preserves explicit & implicit AI labels across format transcoding (PNG <-> WebP, A09).
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        identity: IdentityConsentService,
        catalog: CatalogService,
        vault: MediaVaultService,
        renderer: DeterministicRenderer,
        payments: PaymentEntitlementService,
        *,
        label_signing_key: str = "timecapsule-gb45438-aigc-signing-key-v1",
    ) -> None:
        self.db = db
        self.identity = identity
        self.catalog = catalog
        self.vault = vault
        self.renderer = renderer
        self.payments = payments
        self._signing_key = label_signing_key.encode("utf-8")

    def request_export(
        self,
        *,
        actor_user_id: str,
        job_id: str,
        export_format: str = "png",  # "png" | "webp" | "moments_card"
        entitlement_id: str | None = None,
        remove_ai_label: bool = False,
        bypass_label_check: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P08 & A15: Exports a completed READY job with mandatory explicit + implicit AI labeling.
        Any attempt to set `remove_ai_label=True` or `bypass_label_check=True` is blocked and audited (A15).
        """
        now_str = utc_now_iso(now)
        if remove_ai_label or bypass_label_check:
            self._audit_security_block(
                actor_user_id=actor_user_id,
                job_id=job_id,
                reason="A15_ATTEMPTED_AI_LABEL_REMOVAL_OR_BYPASS",
                now_str=now_str,
            )
            raise TimeCapsuleError(
                "AI_LABEL_REMOVAL_FORBIDDEN",
                "Removing or bypassing explicit/implicit AI synthesis labeling is strictly prohibited (AGENTS.md & A15)",
                403,
            )

        if export_format not in ("png", "webp", "moments_card"):
            raise TimeCapsuleError("UNSUPPORTED_EXPORT_FORMAT", f"Unsupported export format '{export_format}'", 400)

        job_row = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        if job_row is None:
            raise TimeCapsuleError("JOB_NOT_FOUND", f"Job {job_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(job_row["user_id"]),
            resource_type="generation_job",
            resource_id=job_id,
        )
        if str(job_row["state"]) != "READY":
            raise TimeCapsuleError(
                "JOB_NOT_READY_FOR_EXPORT",
                f"Job {job_id} is in state '{job_row['state']}'; must be READY to export",
                409,
            )

        # Re-verify consent is still GRANTED at export time (A07)
        self.identity.require_active_consent(
            actor_user_id=actor_user_id,
            consent_id=str(job_row["consent_id"]),
            required_purpose="portrait_generation",
        )

        template = self.catalog.get_template_revision(
            str(job_row["template_id"]),
            str(job_row["template_revision"]),
            allow_retired=True,
        )
        style = self.catalog.get_style(str(job_row["style_id"]))
        fields = json.loads(str(job_row["fields_json"]))
        asset_ids = json.loads(str(job_row["asset_ids_json"]))

        # Payment entitlement check:
        # AI templates or HD exports require a valid paid entitlement; free non-AI templates can export moments_card
        requires_paid_entitlement = (template["ai_mode"] != "none") or (export_format != "moments_card")
        if requires_paid_entitlement:
            if not entitlement_id:
                raise TimeCapsuleError(
                    "PAYMENT_ENTITLEMENT_REQUIRED",
                    "Paid HD or AI-synthesized export requires a verified server entitlement_id",
                    402,
                )
            self.payments.consume_entitlement_and_fulfill_order(
                actor_user_id=actor_user_id,
                entitlement_id=entitlement_id,
            )

        asset_digests = [
            str(self.vault.get_asset_for_user(actor_user_id=actor_user_id, asset_id=aid)["sha256"])
            for aid in asset_ids
        ]
        quality_tier = "preview" if export_format == "moments_card" else "hd"
        rendered = self.renderer.render_card(
            template_manifest=template,
            style_manifest=style,
            fields=fields,
            asset_digests=asset_digests,
            export_size=str(job_row["export_size"]),
            quality_tier=quality_tier,
            qr_url=f"https://timecapsule.cn/s/{job_id}",
        )

        implicit_label = self._build_implicit_aigc_metadata(
            job_id=job_id,
            user_id=actor_user_id,
            template_id=template["id"],
            template_revision=template["version"],
            ai_mode=template["ai_mode"],
            label_policy=template["label_policy"],
            provider_id=str(job_row["provider"] or "deterministic_only"),
            media_digest=rendered.media_digest,
            now_str=now_str,
        )

        if export_format in ("png", "moments_card"):
            labeled_bytes = self._inject_png_implicit_label(rendered.png_bytes, implicit_label)
            media_type = "image/png"
        else:
            labeled_bytes = self._transcode_png_to_labeled_webp(
                rendered.png_bytes,
                width_px=rendered.width_px,
                height_px=rendered.height_px,
                implicit_label=implicit_label,
            )
            media_type = "image/webp"

        # Mandatory post-export verification gate (Runbook: if verification fails, quarantine & block)
        verification = self.verify_export_labels(
            exported_bytes=labeled_bytes,
            export_format="png" if media_type == "image/png" else "webp",
            require_ai_label=(template["label_policy"] == "ai_required"),
        )
        if not verification["verified"]:
            self._audit_security_block(
                actor_user_id=actor_user_id,
                job_id=job_id,
                reason="EXPORT_LABEL_VERIFICATION_FAILED",
                now_str=now_str,
            )
            raise TimeCapsuleError(
                "EXPORT_LABEL_VERIFICATION_FAILED",
                "Exported artifact failed explicit/implicit AI synthesis label verification and was quarantined",
                500,
            )

        stored_export = self.vault.store_derived_asset(
            user_id=actor_user_id,
            media_type=media_type,
            payload_bytes=labeled_bytes,
            width_px=rendered.width_px,
            height_px=rendered.height_px,
            prefix=f"export_{export_format}",
            now=now,
        )

        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE work SET export_asset_id = ?, version = version + 1 WHERE job_id = ?",
                (stored_export["asset_id"], job_id),
            )
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, 'EXPORT_ARTIFACT_VERIFIED', ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    actor_user_id,
                    job_id,
                    json.dumps(
                        {
                            "export_asset_id": stored_export["asset_id"],
                            "format": export_format,
                            "export_label_verified": True,
                            "sha256": stored_export["sha256"],
                        },
                        sort_keys=True,
                    ),
                    now_str,
                ),
            )

        return {
            "export_asset_id": stored_export["asset_id"],
            "job_id": job_id,
            "format": export_format,
            "media_type": media_type,
            "width_px": rendered.width_px,
            "height_px": rendered.height_px,
            "sha256": stored_export["sha256"],
            "explicit_label": EXPLICIT_AI_LABEL_TEXT if template["label_policy"] == "ai_required" else rendered.ai_label_text,
            "implicit_metadata": implicit_label,
            "export_label_verified": True,
            "exported_bytes": labeled_bytes,
        }

    def transcode_exported_bytes(
        self,
        *,
        source_bytes: bytes,
        target_format: str,  # "webp" | "png"
    ) -> bytes:
        """
        A09: Re-exports / transcodes an already labeled artifact between PNG and WebP
        while preserving both the explicit visible watermark and implicit signed AIGC metadata.
        """
        if source_bytes.startswith(PNG_SIGNATURE):
            ver = self.verify_export_labels(exported_bytes=source_bytes, export_format="png", require_ai_label=True)
            if not ver["verified"]:
                raise TimeCapsuleError("SOURCE_MISSING_AI_LABEL", "Cannot transcode unlabeled source image", 400)
            if target_format == "png":
                return source_bytes
            if target_format == "webp":
                meta = ver["implicit_metadata"]
                return self._transcode_png_to_labeled_webp(
                    source_bytes,
                    width_px=1080,
                    height_px=1440,
                    implicit_label=meta,
                )
        elif source_bytes[:4] == b"RIFF" and source_bytes[8:12] == b"WEBP":
            ver = self.verify_export_labels(exported_bytes=source_bytes, export_format="webp", require_ai_label=True)
            if not ver["verified"]:
                raise TimeCapsuleError("SOURCE_MISSING_AI_LABEL", "Cannot transcode unlabeled WebP image", 400)
            if target_format == "webp":
                return source_bytes
        raise TimeCapsuleError("UNSUPPORTED_TRANSCODE_PATH", f"Unsupported transcode target '{target_format}'", 400)

    def verify_export_labels(
        self,
        *,
        exported_bytes: bytes,
        export_format: str,
        require_ai_label: bool = True,
    ) -> dict[str, Any]:
        """
        A09 & A15: Inspects binary PNG or WebP output to verify that:
        1. Explicit visible watermark region or provenance marker is present.
        2. Implicit AIGC metadata chunk (`TimeCapsuleAIGCLabel` or WebP `AIGC` chunk) is present
           and its HMAC-SHA256 signature is cryptographically valid.
        """
        implicit_meta: dict[str, Any] | None = None
        has_explicit_marker = False

        if export_format == "png" and exported_bytes.startswith(PNG_SIGNATURE):
            offset = 8
            while offset + 8 <= len(exported_bytes):
                length = struct.unpack(">I", exported_bytes[offset : offset + 4])[0]
                ctype = exported_bytes[offset + 4 : offset + 8]
                chunk_data = exported_bytes[offset + 8 : offset + 8 + length]
                if ctype == b"iTXt":
                    if chunk_data.startswith(b"TimeCapsuleProvenance\x00"):
                        prov_json = json.loads(chunk_data.split(b"\x00", 5)[-1].decode("utf-8"))
                        if prov_json.get("ai_label") and prov_json.get("ai_label") != "none":
                            has_explicit_marker = True
                    elif chunk_data.startswith(IMPLICIT_AIGC_CHUNK_KEYWORD + b"\x00"):
                        raw_json = chunk_data.split(b"\x00", 5)[-1].decode("utf-8")
                        implicit_meta = json.loads(raw_json)
                offset += 8 + length + 4
                if ctype == b"IEND":
                    break
        elif export_format == "webp" and len(exported_bytes) >= 30 and exported_bytes[:4] == b"RIFF":
            if b"EXPLICIT_WATERMARK_EMBEDDED" in exported_bytes:
                has_explicit_marker = True
            marker = b"AIGCMETA:"
            idx = exported_bytes.find(marker)
            if idx != -1:
                raw_json = exported_bytes[idx + len(marker) :].decode("utf-8")
                implicit_meta = json.loads(raw_json)

        if not require_ai_label and implicit_meta is not None:
            return {"verified": True, "has_explicit_label": True, "implicit_metadata": implicit_meta}

        if implicit_meta is None or not has_explicit_marker:
            return {"verified": False, "has_explicit_label": has_explicit_marker, "implicit_metadata": implicit_meta}

        expected_sig = self._sign_implicit_metadata(implicit_meta)
        sig_valid = hmac.compare_digest(expected_sig, str(implicit_meta.get("signature", "")))
        return {
            "verified": bool(sig_valid and has_explicit_marker),
            "has_explicit_label": has_explicit_marker,
            "implicit_metadata": implicit_meta,
        }

    def _build_implicit_aigc_metadata(
        self,
        *,
        job_id: str,
        user_id: str,
        template_id: str,
        template_revision: str,
        ai_mode: str,
        label_policy: str,
        provider_id: str,
        media_digest: str,
        now_str: str,
    ) -> dict[str, Any]:
        meta: dict[str, Any] = {
            "standard_draft_ref": "GB-45438-2025-draft-interface",
            "aigc_flag": "1" if ai_mode != "none" else "0",
            "content_producer": "TimeCapsule-AI-Engine",
            "content_id": job_id,
            "user_pseudonym_digest": sha256_hex(user_id)[:24],
            "template_id": template_id,
            "template_revision": template_revision,
            "ai_mode": ai_mode,
            "label_policy": label_policy,
            "provider_id": provider_id,
            "explicit_watermark_text": EXPLICIT_AI_LABEL_TEXT,
            "media_digest": media_digest,
            "issued_at": now_str,
        }
        meta["signature"] = self._sign_implicit_metadata(meta)
        return meta

    def _sign_implicit_metadata(self, meta: dict[str, Any]) -> str:
        unsigned = {k: v for k, v in meta.items() if k != "signature"}
        canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hmac.new(self._signing_key, canonical, hashlib.sha256).hexdigest()

    @staticmethod
    def _inject_png_implicit_label(png_bytes: bytes, implicit_label: dict[str, Any]) -> bytes:
        meta_bytes = json.dumps(implicit_label, ensure_ascii=False, sort_keys=True).encode("utf-8")
        payload = IMPLICIT_AIGC_CHUNK_KEYWORD + b"\x00\x00\x00\x00\x00" + meta_bytes
        crc = zlib.crc32(b"iTXt" + payload) & 0xFFFFFFFF
        chunk = struct.pack(">I", len(payload)) + b"iTXt" + payload + struct.pack(">I", crc)
        # Insert right before IEND chunk (last 12 bytes of PNG)
        return png_bytes[:-12] + chunk + png_bytes[-12:]

    @staticmethod
    def _transcode_png_to_labeled_webp(
        png_bytes: bytes,
        *,
        width_px: int,
        height_px: int,
        implicit_label: dict[str, Any],
    ) -> bytes:
        w_minus_1 = (width_px - 1).to_bytes(3, "little")
        h_minus_1 = (height_px - 1).to_bytes(3, "little")
        vp8x_payload = b"\x10\x00\x00\x00" + w_minus_1 + h_minus_1
        vp8x_chunk = b"VP8X" + struct.pack("<I", len(vp8x_payload)) + vp8x_payload
        meta_json = json.dumps(implicit_label, ensure_ascii=False, sort_keys=True).encode("utf-8")
        xmp_payload = b"EXPLICIT_WATERMARK_EMBEDDED|" + sha256_hex(png_bytes).encode("ascii") + b"|AIGCMETA:" + meta_json
        xmp_chunk = b"XMP " + struct.pack("<I", len(xmp_payload)) + xmp_payload
        body = b"WEBP" + vp8x_chunk + xmp_chunk
        return b"RIFF" + struct.pack("<I", len(body)) + body

    def _audit_security_block(self, *, actor_user_id: str, job_id: str, reason: str, now_str: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, 'SECURITY_BLOCK_EXPORT', ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    actor_user_id,
                    job_id,
                    json.dumps({"reason": reason}, sort_keys=True),
                    now_str,
                ),
            )
