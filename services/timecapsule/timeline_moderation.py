"""
TimeCapsule Domain Package — P10 & P11:
- P10: Private Work Gallery, 0–100 Digital Life Timeline with Mandatory Simulation Disclosure,
       Historical Manifest Re-Rendering across Template Upgrades (A12), and Revocable Opaque Share Tokens (A11).
- P11: Pre/Post Content Moderation Gate (Prompt Injection & Official ID Forgery Blocking)
       and Manual Review / Appeal Workflow with SLA Governance.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any
import uuid

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    TimeCapsuleDatabase,
    TimeCapsuleError,
     parse_iso_datetime,
    sha256_hex,
    utc_now_iso,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer
from services.timecapsule.media_vault import MediaVaultService


TIMELINE_SIMULATION_DISCLOSURE = (
    "【模拟声明】本数字人生档案中的童年追忆与未来年龄推演均为AI艺术化模拟示意，不代表真实容貌预测、医学评估或法定身份证明。"
)

HIGH_RISK_BLOCK_PATTERNS = (
    re.compile(r"ignore\s+(?:all\s+)?previous\s+instructions", re.IGNORECASE),
    re.compile(r"system\s*prompt|jailbreak|developer\s*mode", re.IGNORECASE),
    re.compile(r"伪造(?:身份证|护照|公章|营业执照|学位证|毕业证)", re.IGNORECASE),
    re.compile(r"<script\b|javascript:", re.IGNORECASE),
)

REVIEW_QUEUE_PATTERNS = (
    re.compile(r"名人|明星|政治人物|领导人|总统", re.IGNORECASE),
    re.compile(r"裸露|暴力|血腥|赌博", re.IGNORECASE),
)


class TimelineArchiveService:
    """
    P10, A10, A11 & A12:
    Manages user-private works, 0–100 life timeline milestones, historical work re-rendering
    bound to original template revisions, and opaque revocable share links.
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        identity: IdentityConsentService,
        catalog: CatalogService,
        vault: MediaVaultService,
        renderer: DeterministicRenderer,
    ) -> None:
        self.db = db
        self.identity = identity
        self.catalog = catalog
        self.vault = vault
        self.renderer = renderer

    def get_work(self, *, actor_user_id: str, work_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM work WHERE id = ?", (work_id,))
        if row is None:
            raise TimeCapsuleError("WORK_NOT_FOUND", f"Work {work_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="work",
            resource_id=work_id,
        )
        return self._row_to_work(row)

    def list_user_works(self, *, actor_user_id: str) -> list[dict[str, Any]]:
        rows = self.db.query_all(
            "SELECT * FROM work WHERE user_id = ? ORDER BY created_at DESC",
            (actor_user_id,),
        )
        return [self._row_to_work(r) for r in rows]

    def rerender_historical_work(
        self,
        *,
        actor_user_id: str,
        work_id: str,
    ) -> dict[str, Any]:
        """
        A12: Re-renders an existing work after its template has been upgraded or retired.
        Strictly binds to the work's recorded `template_revision` and `manifest_json`
        and verifies that the deterministic `input_digest` and `media_digest` match.
        """
        work = self.get_work(actor_user_id=actor_user_id, work_id=work_id)
        manifest = work["manifest"]

        # Load exact historical template revision (even if RETIRED)
        historical_template = self.catalog.get_template_revision(
            work["template_id"],
            work["template_revision"],
            allow_retired=True,
        )
        style = self.catalog.get_style(work["style_id"])
        job_row = self.db.query_one("SELECT asset_ids_json, export_size FROM generation_job WHERE id = ?", (work["job_id"],))
        if job_row is None:
            raise TimeCapsuleError("JOB_NOT_FOUND", "Underlying job record missing", 404)

        asset_ids = json.loads(str(job_row["asset_ids_json"]))
        asset_digests = [
            str(self.vault.get_asset_for_user(actor_user_id=actor_user_id, asset_id=aid)["sha256"])
            for aid in asset_ids
        ]
        rendered = self.renderer.render_card(
            template_manifest=historical_template,
            style_manifest=style,
            fields=manifest["fields"],
            asset_digests=asset_digests,
            export_size=str(job_row["export_size"]),
            quality_tier="preview",
        )
        return {
            "work_id": work_id,
            "bound_template_id": historical_template["id"],
            "bound_template_revision": historical_template["version"],
            "template_status": historical_template["status"],
            "original_input_digest": manifest["input_digest"],
            "rerendered_input_digest": rendered.input_digest,
            "original_media_digest": manifest["media_digest"],
            "rerendered_media_digest": rendered.media_digest,
            "reproducible": (
                rendered.input_digest == manifest["input_digest"]
                and rendered.media_digest == manifest["media_digest"]
            ),
        }

    def add_timeline_milestone(
        self,
        *,
        actor_user_id: str,
        work_id: str,
        age_milestone: int,
        event_date: str,
        narrative: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """P10: Adds a 0–100 age milestone to the user's private digital life timeline."""
        if not (0 <= age_milestone <= 120):
            raise TimeCapsuleError("INVALID_AGE_MILESTONE", "age_milestone must be between 0 and 120", 400)
        self.get_work(actor_user_id=actor_user_id, work_id=work_id)
        now_str = utc_now_iso(now)
        entry_id = str(uuid.uuid4())

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO timeline_entry (
                    id, user_id, work_id, age_milestone, event_date,
                    narrative, illustrative_disclosure, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    entry_id,
                    actor_user_id,
                    work_id,
                    age_milestone,
                    event_date,
                    narrative.strip(),
                    TIMELINE_SIMULATION_DISCLOSURE,
                    now_str,
                ),
            )
        return {
            "id": entry_id,
            "user_id": actor_user_id,
            "work_id": work_id,
            "age_milestone": age_milestone,
            "event_date": event_date,
            "narrative": narrative.strip(),
            "illustrative_disclosure": TIMELINE_SIMULATION_DISCLOSURE,
            "created_at": now_str,
        }

    def list_timeline(self, *, actor_user_id: str) -> list[dict[str, Any]]:
        rows = self.db.query_all(
            "SELECT * FROM timeline_entry WHERE user_id = ? ORDER BY age_milestone ASC, created_at ASC",
            (actor_user_id,),
        )
        return [dict(r) for r in rows]

    def create_share_grant(
        self,
        *,
        actor_user_id: str,
        work_id: str,
        share_consent_id: str,
        ttl_hours: int = 24,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P10 & A11: Creates an opaque, revocable share token (`shr_...`).
        Never exposes `user_id` in the URL and blocks public sharing of minor works.
        """
        work = self.get_work(actor_user_id=actor_user_id, work_id=work_id)
        if work["contains_minor"]:
            raise TimeCapsuleError(
                "MINOR_PUBLIC_SHARE_FORBIDDEN",
                "Works containing minors cannot be shared via public tokens",
                403,
            )
        self.identity.require_active_consent(
            actor_user_id=actor_user_id,
            consent_id=share_consent_id,
            required_purpose="share_public",
        )
        current_dt = now or datetime.now(timezone.utc)
        now_str = utc_now_iso(current_dt)
        expires_str = utc_now_iso(current_dt + timedelta(hours=ttl_hours))
        token = f"shr_{sha256_hex(f'{work_id}:{share_consent_id}:{now_str}:{uuid.uuid4()}')[:36]}"

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO share_grant (token, work_id, user_id, consent_id, status, expires_at, created_at, version)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, 1)
                """,
                (token, work_id, actor_user_id, share_consent_id, expires_str, now_str),
            )
        return {
            "token": token,
            "share_url": f"https://timecapsule.cn/s/{token}",
            "work_id": work_id,
            "status": "ACTIVE",
            "expires_at": expires_str,
            "illustrative_disclosure": TIMELINE_SIMULATION_DISCLOSURE,
        }

    def resolve_share_token(self, token: str, *, now: datetime | None = None) -> dict[str, Any]:
        """A11: Resolves an opaque share token; fails closed if revoked or expired."""
        row = self.db.query_one("SELECT * FROM share_grant WHERE token = ?", (token,))
        if row is None:
            raise TimeCapsuleError("SHARE_NOT_FOUND", "Share link does not exist", 404)
        if str(row["status"]) != "ACTIVE":
            raise TimeCapsuleError("SHARE_REVOKED", "Share link has been revoked and is no longer accessible", 410)
        current_dt = now or datetime.now(timezone.utc)
        if parse_iso_datetime(str(row["expires_at"])) <= current_dt:
            raise TimeCapsuleError("SHARE_EXPIRED", "Share link has expired", 410)

        work_row = self.db.query_one("SELECT template_id, template_revision, style_id, manifest_json FROM work WHERE id = ?", (str(row["work_id"]),))
        if work_row is None:
            raise TimeCapsuleError("WORK_NOT_FOUND", "Shared work no longer exists", 404)
        manifest = json.loads(str(work_row["manifest_json"]))
        return {
            "token": token,
            "work_id": str(row["work_id"]),
            "template_id": str(work_row["template_id"]),
            "template_revision": str(work_row["template_revision"]),
            "style_id": str(work_row["style_id"]),
            "fields": manifest.get("fields", {}),
            "ai_label_text": manifest.get("ai_label_text"),
            "illustrative_disclosure": TIMELINE_SIMULATION_DISCLOSURE,
            "expires_at": str(row["expires_at"]),
        }

    def revoke_share_grant(self, *, actor_user_id: str, token: str) -> dict[str, Any]:
        """A11: Immediately revokes a share link; only the owner can revoke."""
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM share_grant WHERE token = ?", (token,)).fetchone()
            if row is None:
                raise TimeCapsuleError("SHARE_NOT_FOUND", "Share token not found", 404)
            self.identity.assert_owner_access(
                actor_user_id=actor_user_id,
                owner_user_id=str(row["user_id"]),
                resource_type="share_grant",
                resource_id=token,
            )
            cur = conn.execute(
                "UPDATE share_grant SET status = 'REVOKED', version = version + 1 WHERE token = ? AND version = ?",
                (token, int(row["version"])),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Share revoke optimistic lock conflict", 409)
        return {"token": token, "status": "REVOKED"}

    @staticmethod
    def _row_to_work(row: Any) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "user_id": str(row["user_id"]),
            "job_id": str(row["job_id"]),
            "template_id": str(row["template_id"]),
            "template_revision": str(row["template_revision"]),
            "style_id": str(row["style_id"]),
            "manifest": json.loads(str(row["manifest_json"])),
            "manifest_sha256": str(row["manifest_sha256"]),
            "export_asset_id": str(row["export_asset_id"]) if row["export_asset_id"] else None,
            "contains_minor": bool(row["contains_minor"]),
            "created_at": str(row["created_at"]),
        }


class ContentModerationService:
    """
    P11: Pre/post-generation content safety gate, prompt-injection & official-ID forgery filter,
    and manual review / appeal workflow with 24-hour SLA tracking.
    """

    def __init__(self, db: TimeCapsuleDatabase, identity: IdentityConsentService) -> None:
        self.db = db
        self.identity = identity

    def screen_fields(
        self,
        *,
        actor_user_id: str,
        target_type: str,
        target_id: str,
        fields: dict[str, Any],
        now: datetime | None = None,
    ) -> dict[str, Any]:
        now_str = utc_now_iso(now)
        combined = " ".join(str(v) for v in fields.values())
        decision = "PASS"
        reason_code = "CLEAN"

        for pat in HIGH_RISK_BLOCK_PATTERNS:
            if pat.search(combined):
                decision = "BLOCK"
                reason_code = "HIGH_RISK_PROMPT_OR_FORGERY_BLOCKED"
                break

        if decision == "PASS":
            for pat in REVIEW_QUEUE_PATTERNS:
                if pat.search(combined):
                    decision = "REVIEW"
                    reason_code = "SENSITIVE_ENTITY_MANUAL_REVIEW"
                    break

        case_id = str(uuid.uuid4())
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO moderation_case (id, user_id, target_type, target_id, decision, reason_code, created_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (case_id, actor_user_id, target_type, target_id, decision, reason_code, now_str),
            )
        if decision == "BLOCK":
            raise TimeCapsuleError(
                "CONTENT_MODERATION_BLOCKED",
                f"Content blocked by safety gate ({reason_code})",
                422,
                {"moderation_case_id": case_id, "reason_code": reason_code},
            )
        return {
            "moderation_case_id": case_id,
            "decision": decision,
            "reason_code": reason_code,
            "created_at": now_str,
        }

    def submit_appeal(
        self,
        *,
        actor_user_id: str,
        moderation_case_id: str,
        reason: str,
        sla_hours: int = 24,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        if not reason or len(reason.strip()) < 4:
            raise TimeCapsuleError("INVALID_APPEAL_REASON", "Appeal reason must be at least 4 characters", 400)
        case_row = self.db.query_one("SELECT * FROM moderation_case WHERE id = ?", (moderation_case_id,))
        if case_row is None:
            raise TimeCapsuleError("MODERATION_CASE_NOT_FOUND", f"Case {moderation_case_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(case_row["user_id"]),
            resource_type="moderation_case",
            resource_id=moderation_case_id,
        )
        current_dt = now or datetime.now(timezone.utc)
        now_str = utc_now_iso(current_dt)
        sla_due_str = utc_now_iso(current_dt + timedelta(hours=sla_hours))
        ticket_id = str(uuid.uuid4())

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO appeal_ticket (
                    id, moderation_case_id, user_id, reason, status, sla_due_at, created_at, resolved_at, version
                ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, NULL, 1)
                """,
                (ticket_id, moderation_case_id, actor_user_id, reason.strip(), sla_due_str, now_str),
            )
        return {
            "ticket_id": ticket_id,
            "moderation_case_id": moderation_case_id,
            "status": "OPEN",
            "sla_due_at": sla_due_str,
            "created_at": now_str,
        }

    def resolve_appeal(
        self,
        *,
        reviewer_actor_id: str,
        ticket_id: str,
        approved: bool,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        now_str = utc_now_iso(now)
        new_status = "APPROVED" if approved else "REJECTED"
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM appeal_ticket WHERE id = ?", (ticket_id,)).fetchone()
            if row is None:
                raise TimeCapsuleError("APPEAL_NOT_FOUND", f"Appeal ticket {ticket_id} not found", 404)
            cur = conn.execute(
                "UPDATE appeal_ticket SET status = ?, resolved_at = ?, version = version + 1 WHERE id = ? AND version = ?",
                (new_status, now_str, ticket_id, int(row["version"])),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Appeal ticket optimistic lock conflict", 409)
            if approved:
                conn.execute(
                    "UPDATE moderation_case SET decision = 'PASS', reason_code = 'APPEAL_APPROVED', version = version + 1 WHERE id = ?",
                    (str(row["moderation_case_id"]),),
                )
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, 'RESOLVE_APPEAL', ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    reviewer_actor_id,
                    ticket_id,
                    json.dumps({"approved": approved}, sort_keys=True),
                    now_str,
                ),
            )
        return {
            "ticket_id": ticket_id,
            "status": new_status,
            "resolved_at": now_str,
        }
