"""
AI Life Time Machine - Control Plane Xiaohongshu & Mini-Program Domain Service
Implements B08, B14, B15, B70-R01..R05, B71-R01..R05, and B72-R01..R05 server-side invariants:
1. Platform-scoped code2Session exchange (`mp-xhs` and `mp-weixin`) that derives a
   pseudonymous actor ID via HMAC-SHA256 instead of exposing raw `openid` as a
   cross-entity identity (B70-R01).
2. Server-priced order & Xiaohongshu guaranteed-payment callback verification with
   HMAC-SHA256 signature verification, replay/duplicate `event_id` deduplication,
   amount tamper rejection, and immutable double-entry ledger posting in ACID SQLite (B71-R01, B71-R02).
3. Compliant Xiaohongshu Note Mount card generation (`POST /v1/xhs/note-mounts`)
   enforcing mandatory `AI生成·艺术示意非真实预测` watermark, revocable share grant binding,
   and fail-closed child/minor public-share blocking (B21, B71-R03).
4. Review account sandbox tenant isolation guard (B72-R04).
5. Built-in competitive portrait template catalog, composition draft persistence,
   deterministic timeline prompt compilation, and B15 multi-dimensional quality gate
   integration (B08, B14, B15).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO_ROOT_DIR = Path(__file__).resolve().parents[2]
MEDIA_WORKER_DIR = Path(__file__).resolve().parent.parent / "media-worker"
for _extra_dir in (REPO_ROOT_DIR, MEDIA_WORKER_DIR):
    if str(_extra_dir) not in sys.path:
        sys.path.insert(0, str(_extra_dir))

from photobook_layout_engine import (  # noqa: E402
    PhotobookEngineError,
    PhotobookLayoutEngine,
    PhotobookLayoutManifest,
)
from portrait_template_engine import (  # noqa: E402
    CompositionDraftRecord,
    CuratedGalleryRunRecord,
    CuratedGallerySelectionRecord,
    PortraitTemplateEngine,
    PortraitTemplateSpec,
    QualityEvaluationReport,
    TemplateEngineError,
    TimelineGenerationPlan,
)
from world_landmark_engine import (  # noqa: E402
    LandmarkEngineError,
    LandmarkSynthesisRunRecord,
    WorldLandmarkCompositorEngine,
    WorldLandmarkPhotoSpec,
)
from services.timecapsule.db_and_identity import TimeCapsuleError  # noqa: E402
from services.timecapsule.http_server import TimeCapsuleApplication  # noqa: E402


AI_WATERMARK_BADGE = "AI生成·艺术示意非真实预测"


class ControlPlaneError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class MiniProgramSessionRecord:
    session_id: str
    actor_pseudonym: str
    platform: str
    tenant_id: str
    access_token: str
    expires_at: str
    is_review_sandbox: bool = False


@dataclass
class OrderRecord:
    order_id: str
    checkout_id: str
    amount_minor: int
    currency: str
    state: str = "pending"
    version: int = 1
    xhs_trade_no: str | None = None


@dataclass(frozen=True)
class LedgerEntry:
    entry_id: str
    event_id: str
    order_id: str
    debit_account: str
    credit_account: str
    amount_minor: int
    currency: str
    created_at: str


@dataclass
class ShareGrantRecord:
    share_id: str
    artifact_ids: list[str]
    participant_consent_refs: list[str]
    status: str
    expires_at: str
    contains_minor: bool = False


@dataclass(frozen=True)
class XhsNoteMountRecord:
    mount_id: str
    share_id: str
    xhs_path: str
    enforced_title: str
    ai_watermark_badge: str
    topic_tags: list[str]
    expires_at: str


class XhsControlPlaneService:
    def __init__(
        self,
        actor_pepper: str = "ltm-actor-hmac-pepper-v1",
        xhs_webhook_secret: str = "xhs-guaranteed-pay-webhook-secret-v1",
        db_path: str = ":memory:",
    ) -> None:
        self._actor_pepper = actor_pepper.encode("utf-8")
        self._xhs_webhook_secret = xhs_webhook_secret.encode("utf-8")
        self._conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()
        self._template_engine = PortraitTemplateEngine(db_path=db_path)
        self._photobook_engine = PhotobookLayoutEngine(conn=self._conn)
        self._landmark_engine = WorldLandmarkCompositorEngine(db_path=db_path)
        self._timecapsule_app = TimeCapsuleApplication(db_path=db_path)

    def _init_schema(self) -> None:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cp_orders (
                    order_id TEXT PRIMARY KEY,
                    checkout_id TEXT NOT NULL,
                    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
                    currency TEXT NOT NULL,
                    state TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    xhs_trade_no TEXT
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cp_shares (
                    share_id TEXT PRIMARY KEY,
                    artifact_ids_json TEXT NOT NULL,
                    participant_consent_refs_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    contains_minor INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cp_webhook_events (
                    event_id TEXT PRIMARY KEY,
                    receipt_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cp_ledger_entries (
                    entry_id TEXT PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    order_id TEXT NOT NULL,
                    debit_account TEXT NOT NULL,
                    credit_account TEXT NOT NULL,
                    amount_minor INTEGER NOT NULL,
                    currency TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    @property
    def template_engine(self) -> PortraitTemplateEngine:
        return self._template_engine

    @property
    def timecapsule_app(self) -> TimeCapsuleApplication:
        return self._timecapsule_app

    def list_timecapsule_catalog(
        self,
        *,
        category: str | None = None,
        include_retired: bool = False,
    ) -> dict[str, Any]:
        """P02: Expose 12 categories, 20 launch templates, 5 visual styles (100 combinations)."""
        try:
            return self._timecapsule_app.catalog.list_catalog(
                category=category,
                include_retired=include_retired,
            )
        except TimeCapsuleError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def render_and_export_timecapsule_card(
        self,
        *,
        template_id: str,
        style_id: str,
        fields: dict[str, Any],
        output_format: str = "png",
        quality_tier: str = "preview",
        qr_url: str = "https://timecapsule.cn/s/demo",
    ) -> dict[str, Any]:
        """P04 & P08: Render deterministic card and attach mandatory explicit+implicit GB 45438-2025 AI synthesis labels."""
        try:
            template = self._timecapsule_app.catalog.get_template_revision(template_id)
            style = self._timecapsule_app.catalog.get_style(style_id)
            export_size = str(template["sizes"][0])
            rendered = self._timecapsule_app.renderer.render_card(
                template_manifest=template,
                style_manifest=style,
                fields=fields,
                asset_digests=[hashlib.sha256(b"cp_portrait_seed").hexdigest()],
                export_size=export_size,
                quality_tier=quality_tier,
                qr_url=qr_url,
            )
            now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            implicit_label = self._timecapsule_app.exports._build_implicit_aigc_metadata(
                job_id=f"job_cp_{template_id}_{style_id}",
                user_id="cp_actor",
                template_id=template["id"],
                template_revision=template["version"],
                ai_mode=template["ai_mode"],
                label_policy=template["label_policy"],
                provider_id="control_plane_deterministic_renderer",
                media_digest=rendered.media_digest,
                now_str=now_str,
            )
            labeled_png = self._timecapsule_app.exports._inject_png_implicit_label(
                rendered.png_bytes,
                implicit_label,
            )
            target_fmt = output_format.lower()
            if target_fmt == "webp":
                final_bytes = self._timecapsule_app.exports.transcode_exported_bytes(
                    source_bytes=labeled_png,
                    target_format="webp",
                )
            else:
                final_bytes = labeled_png
            verification = self._timecapsule_app.exports.verify_export_labels(
                exported_bytes=final_bytes,
                export_format=target_fmt,
                require_ai_label=(template["label_policy"] == "ai_required"),
            )
            return {
                "template_id": template["id"],
                "template_revision": template["version"],
                "style_id": style_id,
                "output_format": target_fmt,
                "width": rendered.width_px,
                "height": rendered.height_px,
                "svg_sha256": rendered.input_digest,
                "media_bytes": final_bytes,
                "ai_label_verification": verification,
            }
        except TimeCapsuleError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def list_portrait_templates(
        self,
        *,
        channel: str | None = "mp-xhs",
        include_retired: bool = False,
    ) -> list[PortraitTemplateSpec]:
        """B08-R01..R02: List built-in competitive portrait templates."""
        return self._template_engine.list_templates(channel=channel, include_retired=include_retired)

    def get_portrait_template(self, template_id: str, *, allow_retired: bool = False) -> PortraitTemplateSpec:
        """B08-R02: Fetch a specific portrait template specification."""
        try:
            return self._template_engine.get_template(template_id, allow_retired=allow_retired)
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def save_composition_draft(
        self,
        *,
        draft_id: str,
        tenant_id: str,
        actor_id: str,
        template_id: str,
        current_age_anchor: int,
        timeline_ages: list[int],
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        custom_notes: str = "",
        expected_version: int | None = None,
    ) -> CompositionDraftRecord:
        """B08-R03: Persist versioned composition draft with template policy validation."""
        try:
            return self._template_engine.save_composition_draft(
                draft_id=draft_id,
                tenant_id=tenant_id,
                actor_id=actor_id,
                template_id=template_id,
                current_age_anchor=current_age_anchor,
                timeline_ages=timeline_ages,
                aspect_ratio=aspect_ratio,
                participant_count=participant_count,
                contains_minor=contains_minor,
                custom_notes=custom_notes,
                expected_version=expected_version,
            )
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def compile_project_timeline_plan(
        self,
        *,
        tenant_id: str = "tenant_cn_b2c",
        project_id: str,
        template_id: str,
        timeline_ages: list[int] | None = None,
        current_age_anchor: int = 28,
        birth_year: int | None = None,
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        source_asset_ids: list[str] | None = None,
        side_profile_asset_id: str | None = None,
        childhood_reference_asset_id: str | None = None,
        childhood_reference_age: int | None = 6,
        custom_notes: str = "",
    ) -> TimelineGenerationPlan:
        """B14-R01..R04: Compile a deterministic timeline prompt plan for a project."""
        try:
            return self._template_engine.compile_timeline_generation_plan(
                tenant_id=tenant_id,
                project_id=project_id,
                template_id=template_id,
                timeline_ages=timeline_ages,
                current_age_anchor=current_age_anchor,
                birth_year=birth_year,
                aspect_ratio=aspect_ratio,
                participant_count=participant_count,
                contains_minor=contains_minor,
                source_asset_ids=source_asset_ids,
                side_profile_asset_id=side_profile_asset_id,
                childhood_reference_asset_id=childhood_reference_asset_id,
                childhood_reference_age=childhood_reference_age,
                custom_notes=custom_notes,
            )
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def generate_curated_gallery_candidates(
        self,
        *,
        tenant_id: str = "tenant_cn_b2c",
        project_id: str,
        template_id: str,
        current_age_anchor: int = 28,
        birth_year: int | None = None,
        timeline_ages: list[int] | None = None,
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        source_asset_ids: list[str] | None = None,
        side_profile_asset_id: str | None = None,
        childhood_reference_asset_id: str | None = None,
        childhood_reference_age: int | None = 6,
        injected_initial_metrics_by_age: dict[int, dict[str, float]] | None = None,
    ) -> CuratedGalleryRunRecord:
        """B08/B14/B15: Generate >=9 curated gallery candidates with B15 quality gate & auto-healing."""
        try:
            return self._template_engine.generate_curated_gallery_candidates(
                tenant_id=tenant_id,
                project_id=project_id,
                template_id=template_id,
                current_age_anchor=current_age_anchor,
                birth_year=birth_year,
                timeline_ages=timeline_ages,
                aspect_ratio=aspect_ratio,
                participant_count=participant_count,
                contains_minor=contains_minor,
                source_asset_ids=source_asset_ids,
                side_profile_asset_id=side_profile_asset_id,
                childhood_reference_asset_id=childhood_reference_asset_id,
                childhood_reference_age=childhood_reference_age,
                injected_initial_metrics_by_age=injected_initial_metrics_by_age,
            )
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def save_curated_gallery_selection(
        self,
        *,
        selection_id: str,
        gallery_id: str,
        tenant_id: str = "tenant_cn_b2c",
        actor_id: str,
        selected_shot_ids: list[str],
        export_mode: str = "xhs_9_grid",
        photobook_sku: str | None = None,
        min_required_shots: int = 9,
        expected_version: int | None = None,
    ) -> CuratedGallerySelectionRecord:
        """Persist user's >=9 curated shot selection for 9-grid or 99 RMB hardcover photobook."""
        try:
            return self._template_engine.save_curated_gallery_selection(
                selection_id=selection_id,
                gallery_id=gallery_id,
                tenant_id=tenant_id,
                actor_id=actor_id,
                selected_shot_ids=selected_shot_ids,
                export_mode=export_mode,
                photobook_sku=photobook_sku,
                min_required_shots=min_required_shots,
                expected_version=expected_version,
            )
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def compile_photobook_layout_manifest(
        self,
        *,
        manifest_id: str,
        selection_id: str,
        gallery_id: str,
        tenant_id: str = "tenant_cn_b2c",
        actor_id: str,
        title: str = "《时光典藏 · 0–100岁人生摄影集》",
        subtitle: str = "180° 蝴蝶对裱精装珍藏版 · 170g 德国哑光艺术纸",
        voice_qr_url: str | None = None,
        audio_duration_seconds: float = 42.0,
        custom_face_bbox_override_mm: tuple[float, float] | None = None,
        custom_cmyk_tac_override: float | None = None,
        expected_version: int | None = None,
    ) -> PhotobookLayoutManifest:
        """
        Pillar II: Compile a 20-page (10 layflat spreads) butterfly-bound hardcover photobook
        manifest from a saved gallery selection, enforcing pre-press preflight gates.
        """
        gal_row = self._template_engine._conn.execute(
            "SELECT tenant_id, project_id, template_id, run_json FROM curated_gallery_runs WHERE gallery_id = ?",
            (gallery_id,),
        ).fetchone()
        if gal_row is None:
            raise ControlPlaneError("GALLERY_NOT_FOUND", f"Unknown gallery_id: {gallery_id}", 404)
        if gal_row["tenant_id"] != tenant_id:
            raise ControlPlaneError("CROSS_TENANT_FORBIDDEN", "Gallery belongs to another tenant", 403)

        sel_row = self._template_engine._conn.execute(
            "SELECT tenant_id, selected_shot_ids_json, photobook_sku FROM curated_gallery_selections WHERE selection_id = ? AND gallery_id = ?",
            (selection_id, gallery_id),
        ).fetchone()
        if sel_row is None:
            raise ControlPlaneError("SELECTION_NOT_FOUND", f"Unknown selection_id: {selection_id}", 404)
        if sel_row["tenant_id"] != tenant_id:
            raise ControlPlaneError("CROSS_TENANT_FORBIDDEN", "Selection belongs to another tenant", 403)

        selected_shot_ids = set(json.loads(sel_row["selected_shot_ids_json"]))
        run_data = json.loads(gal_row["run_json"])
        selected_candidates = [
            c for c in run_data["candidates"] if c["shot_id"] in selected_shot_ids and c.get("quality_passed", False)
        ]

        try:
            return self._photobook_engine.compile_photobook_layout_manifest(
                manifest_id=manifest_id,
                tenant_id=tenant_id,
                actor_id=actor_id,
                project_id=gal_row["project_id"],
                gallery_id=gallery_id,
                selection_id=selection_id,
                template_id=gal_row["template_id"],
                selected_candidates=selected_candidates,
                title=title,
                subtitle=subtitle,
                sku_code=sel_row["photobook_sku"] or "PHOTO_BOOK_HARDCOVER_0_100",
                voice_qr_url=voice_qr_url,
                audio_duration_seconds=audio_duration_seconds,
                custom_face_bbox_override_mm=custom_face_bbox_override_mm,
                custom_cmyk_tac_override=custom_cmyk_tac_override,
                expected_version=expected_version,
            )
        except PhotobookEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    @property
    def landmark_engine(self) -> WorldLandmarkCompositorEngine:
        return self._landmark_engine

    def list_world_landmark_regions(self) -> list[dict[str, str]]:
        """List the 5 global geographic regions for the 50 World Landmark templates."""
        return self._landmark_engine.list_regions()

    def list_world_landmarks(self, *, region_id: str | None = None) -> list[WorldLandmarkPhotoSpec]:
        """List all 50 world landmark photo templates (or 10 for a specific region)."""
        return self._landmark_engine.list_landmarks(region_id=region_id)

    def get_world_landmark(self, landmark_id: str) -> WorldLandmarkPhotoSpec:
        """Retrieve a single world landmark photo template specification."""
        try:
            return self._landmark_engine.get_landmark(landmark_id)
        except LandmarkEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def synthesize_user_at_world_landmarks(
        self,
        *,
        tenant_id: str = "tenant_cn_b2c",
        project_id: str,
        actor_id: str = "act_01",
        source_asset_ids: list[str],
        landmark_ids: list[str] | None = None,
        region_id: str | None = None,
        side_profile_asset_id: str | None = None,
        target_age: int = 28,
        aspect_ratio: str = "3:4",
        participant_count: int = 1,
        custom_wardrobe_note: str = "",
    ) -> LandmarkSynthesisRunRecord:
        """
        Composite user's uploaded photo(s) into 1..50 world-famous landmark scenes
        with perspective horizon alignment, IC-Light environment HDR IBL relighting,
        and ground contact shadow integration.
        """
        try:
            return self._landmark_engine.synthesize_user_at_landmarks(
                tenant_id=tenant_id,
                project_id=project_id,
                actor_id=actor_id,
                source_asset_ids=source_asset_ids,
                landmark_ids=landmark_ids,
                region_id=region_id,
                side_profile_asset_id=side_profile_asset_id,
                target_age=target_age,
                aspect_ratio=aspect_ratio,
                participant_count=participant_count,
                custom_wardrobe_note=custom_wardrobe_note,
            )
        except LandmarkEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def evaluate_frame_quality(
        self,
        *,
        plan_id: str,
        template_id: str,
        target_age: int,
        observed_metrics: dict[str, float],
        attempt_number: int = 1,
    ) -> QualityEvaluationReport:
        """B15-R01..R05: Evaluate generated frame quality against template thresholds."""
        try:
            return self._template_engine.evaluate_node_quality(
                plan_id=plan_id,
                template_id=template_id,
                target_age=target_age,
                observed_metrics=observed_metrics,
                attempt_number=attempt_number,
            )
        except TemplateEngineError as exc:
            raise ControlPlaneError(exc.code, exc.message, exc.status_code) from exc

    def exchange_mini_program_session(
        self,
        *,
        platform: str,
        js_code: str,
        idempotency_key: str,
        is_review_account: bool = False,
        now: datetime | None = None,
    ) -> MiniProgramSessionRecord:
        """B70-R01 & B72-R04: Exchange login code for pseudonymous actor without exposing openid."""
        self._validate_idempotency_key(idempotency_key)
        if platform not in ("mp-xhs", "mp-weixin"):
            raise ControlPlaneError("INVALID_PLATFORM", f"Unsupported platform: {platform}", 400)
        if not js_code or len(js_code.strip()) < 4:
            raise ControlPlaneError("INVALID_JS_CODE", "js_code must be at least 4 chars", 400)

        current_time = now or datetime.now(timezone.utc)
        raw_provider_subject = f"{platform}:{js_code.strip()}"
        pseudonym_digest = hmac.new(
            self._actor_pepper, raw_provider_subject.encode("utf-8"), hashlib.sha256
        ).hexdigest()[:24]

        tenant_id = "tenant_review_sandbox" if is_review_account else "tenant_cn_b2c"
        actor_pseudonym = f"act_{platform.replace('-', '_')}_{pseudonym_digest}"
        session_id = f"mps_{hashlib.sha256((idempotency_key + actor_pseudonym).encode('utf-8')).hexdigest()[:16]}"
        access_token = f"st_{hashlib.sha256((session_id + current_time.isoformat()).encode('utf-8')).hexdigest()[:32]}"
        expires_at = (current_time + timedelta(hours=2)).isoformat()

        return MiniProgramSessionRecord(
            session_id=session_id,
            actor_pseudonym=actor_pseudonym,
            platform=platform,
            tenant_id=tenant_id,
            access_token=access_token,
            expires_at=expires_at,
            is_review_sandbox=is_review_account,
        )

    def assert_tenant_access(self, session: MiniProgramSessionRecord, target_tenant_id: str) -> None:
        """B72-R04: Prevent review accounts from accessing production customer tenants."""
        if session.is_review_sandbox and target_tenant_id != "tenant_review_sandbox":
            raise ControlPlaneError(
                "REVIEW_ACCOUNT_TENANT_FORBIDDEN",
                "Review account is strictly isolated to synthetic tenant_review_sandbox",
                403,
            )
        if session.tenant_id != target_tenant_id:
            raise ControlPlaneError("CROSS_TENANT_FORBIDDEN", "Cross-tenant access denied", 403)

    def register_server_priced_order(
        self,
        *,
        order_id: str,
        checkout_id: str,
        amount_minor: int,
        currency: str = "CNY",
    ) -> OrderRecord:
        """B71-R02: Server-authoritative order creation in ACID SQLite."""
        if amount_minor <= 0 or currency != "CNY":
            raise ControlPlaneError("INVALID_ORDER_AMOUNT", "Order amount must be positive CNY", 400)
        record = OrderRecord(
            order_id=order_id,
            checkout_id=checkout_id,
            amount_minor=amount_minor,
            currency=currency,
            state="pending",
            version=1,
        )
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                INSERT INTO cp_orders (order_id, checkout_id, amount_minor, currency, state, version, xhs_trade_no)
                VALUES (?, ?, ?, ?, ?, 1, NULL)
                ON CONFLICT(order_id) DO UPDATE SET
                    checkout_id = excluded.checkout_id,
                    amount_minor = excluded.amount_minor,
                    currency = excluded.currency,
                    state = excluded.state,
                    version = 1,
                    xhs_trade_no = NULL
                """,
                (record.order_id, record.checkout_id, record.amount_minor, record.currency, record.state),
            )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise
        return record

    def sign_xhs_webhook_payload(
        self,
        *,
        event_id: str,
        out_trade_no: str,
        xhs_trade_no: str,
        amount_minor: int,
        currency: str,
        status: str,
        timestamp: str,
        nonce: str,
    ) -> str:
        canonical = f"{event_id}|{out_trade_no}|{xhs_trade_no}|{amount_minor}|{currency}|{status}|{timestamp}|{nonce}"
        return hmac.new(
            self._xhs_webhook_secret, canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def handle_xhs_payment_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        """B71-R01 & B87: Verify Xiaohongshu callback signature, deduplicate, and post ledger entry."""
        required = (
            "event_id",
            "out_trade_no",
            "xhs_trade_no",
            "amount_minor",
            "currency",
            "status",
            "timestamp",
            "nonce",
            "signature",
        )
        for key in required:
            if key not in payload:
                raise ControlPlaneError("MISSING_WEBHOOK_FIELD", f"Missing field: {key}", 400)

        expected_sig = self.sign_xhs_webhook_payload(
            event_id=str(payload["event_id"]),
            out_trade_no=str(payload["out_trade_no"]),
            xhs_trade_no=str(payload["xhs_trade_no"]),
            amount_minor=int(payload["amount_minor"]),
            currency=str(payload["currency"]),
            status=str(payload["status"]),
            timestamp=str(payload["timestamp"]),
            nonce=str(payload["nonce"]),
        )
        if not hmac.compare_digest(expected_sig, str(payload["signature"])):
            raise ControlPlaneError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature mismatch", 401)

        event_id = str(payload["event_id"])
        existing_evt = self._conn.execute(
            "SELECT receipt_json FROM cp_webhook_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if existing_evt is not None:
            cached = dict(json.loads(existing_evt["receipt_json"]))
            cached["deduplicated"] = True
            return cached

        order_id = str(payload["out_trade_no"])
        order_row = self._conn.execute(
            "SELECT order_id, checkout_id, amount_minor, currency, state, version, xhs_trade_no FROM cp_orders WHERE order_id = ?",
            (order_id,),
        ).fetchone()
        if order_row is None:
            raise ControlPlaneError("ORDER_NOT_FOUND", f"Unknown order: {order_id}", 404)

        order = OrderRecord(
            order_id=order_row["order_id"],
            checkout_id=order_row["checkout_id"],
            amount_minor=int(order_row["amount_minor"]),
            currency=order_row["currency"],
            state=order_row["state"],
            version=int(order_row["version"]),
            xhs_trade_no=order_row["xhs_trade_no"],
        )

        if int(payload["amount_minor"]) != order.amount_minor or str(payload["currency"]) != order.currency:
            raise ControlPlaneError(
                "AMOUNT_MISMATCH",
                "Callback amount or currency does not match server-priced order",
                409,
            )

        status = str(payload["status"])
        now_iso = datetime.now(timezone.utc).isoformat()

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            if status == "PAID":
                if order.state == "refunded":
                    receipt = {
                        "event_id": event_id,
                        "order_id": order.order_id,
                        "state": order.state,
                        "deduplicated": False,
                        "ledger_entry_id": "noop_already_refunded",
                    }
                    self._conn.execute(
                        "INSERT INTO cp_webhook_events (event_id, receipt_json, created_at) VALUES (?, ?, ?)",
                        (event_id, json.dumps(receipt), now_iso),
                    )
                    self._conn.execute("COMMIT")
                    return receipt

                new_state = "paid"
                xhs_trade_no = str(payload["xhs_trade_no"])
                cur = self._conn.execute(
                    "UPDATE cp_orders SET state = ?, version = version + 1, xhs_trade_no = ? WHERE order_id = ? AND version = ?",
                    (new_state, xhs_trade_no, order.order_id, order.version),
                )
                if cur.rowcount == 0:
                    self._conn.execute("ROLLBACK")
                    raise ControlPlaneError("CONCURRENT_MODIFICATION", "Order version conflict", 409)

                count_row = self._conn.execute("SELECT COUNT(*) AS cnt FROM cp_ledger_entries").fetchone()
                next_idx = int(count_row["cnt"]) + 1
                ledger_entry_id = f"led_{next_idx:04d}"
                self._conn.execute(
                    """
                    INSERT INTO cp_ledger_entries (
                        entry_id, event_id, order_id, debit_account, credit_account, amount_minor, currency, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ledger_entry_id,
                        event_id,
                        order.order_id,
                        "asset:xhs_clearing_cash",
                        "liability:deferred_revenue",
                        order.amount_minor,
                        order.currency,
                        now_iso,
                    ),
                )
            elif status == "REFUNDED":
                new_state = "refunded"
                cur = self._conn.execute(
                    "UPDATE cp_orders SET state = ?, version = version + 1 WHERE order_id = ? AND version = ?",
                    (new_state, order.order_id, order.version),
                )
                if cur.rowcount == 0:
                    self._conn.execute("ROLLBACK")
                    raise ControlPlaneError("CONCURRENT_MODIFICATION", "Order version conflict", 409)

                count_row = self._conn.execute("SELECT COUNT(*) AS cnt FROM cp_ledger_entries").fetchone()
                next_idx = int(count_row["cnt"]) + 1
                ledger_entry_id = f"led_{next_idx:04d}"
                self._conn.execute(
                    """
                    INSERT INTO cp_ledger_entries (
                        entry_id, event_id, order_id, debit_account, credit_account, amount_minor, currency, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ledger_entry_id,
                        event_id,
                        order.order_id,
                        "liability:deferred_revenue",
                        "asset:xhs_clearing_cash",
                        order.amount_minor,
                        order.currency,
                        now_iso,
                    ),
                )
            else:
                new_state = "cancelled"
                cur = self._conn.execute(
                    "UPDATE cp_orders SET state = ?, version = version + 1 WHERE order_id = ? AND version = ?",
                    (new_state, order.order_id, order.version),
                )
                if cur.rowcount == 0:
                    self._conn.execute("ROLLBACK")
                    raise ControlPlaneError("CONCURRENT_MODIFICATION", "Order version conflict", 409)
                ledger_entry_id = "noop_closed"

            receipt = {
                "event_id": event_id,
                "order_id": order.order_id,
                "state": new_state,
                "deduplicated": False,
                "ledger_entry_id": ledger_entry_id,
            }
            self._conn.execute(
                "INSERT INTO cp_webhook_events (event_id, receipt_json, created_at) VALUES (?, ?, ?)",
                (event_id, json.dumps(receipt), now_iso),
            )
            self._conn.execute("COMMIT")
            return receipt
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

    def register_share_grant(self, grant: ShareGrantRecord) -> None:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                INSERT INTO cp_shares (
                    share_id, artifact_ids_json, participant_consent_refs_json, status, expires_at, contains_minor, version
                ) VALUES (?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(share_id) DO UPDATE SET
                    artifact_ids_json = excluded.artifact_ids_json,
                    participant_consent_refs_json = excluded.participant_consent_refs_json,
                    status = excluded.status,
                    expires_at = excluded.expires_at,
                    contains_minor = excluded.contains_minor,
                    version = cp_shares.version + 1
                """,
                (
                    grant.share_id,
                    json.dumps(grant.artifact_ids),
                    json.dumps(grant.participant_consent_refs),
                    grant.status,
                    grant.expires_at,
                    1 if grant.contains_minor else 0,
                ),
            )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

    def revoke_share_grant(self, share_id: str) -> ShareGrantRecord:
        row = self._conn.execute(
            "SELECT share_id, artifact_ids_json, participant_consent_refs_json, status, expires_at, contains_minor, version FROM cp_shares WHERE share_id = ?",
            (share_id,),
        ).fetchone()
        if row is None:
            raise ControlPlaneError("SHARE_NOT_FOUND", f"Unknown share: {share_id}", 404)

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            cur = self._conn.execute(
                "UPDATE cp_shares SET status = 'revoked', version = version + 1 WHERE share_id = ? AND version = ?",
                (share_id, int(row["version"])),
            )
            if cur.rowcount == 0:
                self._conn.execute("ROLLBACK")
                raise ControlPlaneError("CONCURRENT_MODIFICATION", "Share grant version conflict", 409)
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return ShareGrantRecord(
            share_id=row["share_id"],
            artifact_ids=list(json.loads(row["artifact_ids_json"])),
            participant_consent_refs=list(json.loads(row["participant_consent_refs_json"])),
            status="revoked",
            expires_at=row["expires_at"],
            contains_minor=bool(row["contains_minor"]),
        )

    def create_xhs_note_mount(
        self,
        *,
        share_id: str,
        title: str,
        topic_tags: list[str],
        participant_consent_refs: list[str],
        contains_minor: bool = False,
        idempotency_key: str,
        now: datetime | None = None,
    ) -> XhsNoteMountRecord:
        """B71-R03 & B21: Create Xiaohongshu note mount card with mandatory AI badge and minor protection."""
        self._validate_idempotency_key(idempotency_key)
        row = self._conn.execute(
            "SELECT share_id, artifact_ids_json, participant_consent_refs_json, status, expires_at, contains_minor FROM cp_shares WHERE share_id = ?",
            (share_id,),
        ).fetchone()
        if row is None:
            raise ControlPlaneError("SHARE_NOT_FOUND", f"Share grant not found: {share_id}", 404)
        grant = ShareGrantRecord(
            share_id=row["share_id"],
            artifact_ids=list(json.loads(row["artifact_ids_json"])),
            participant_consent_refs=list(json.loads(row["participant_consent_refs_json"])),
            status=row["status"],
            expires_at=row["expires_at"],
            contains_minor=bool(row["contains_minor"]),
        )
        if grant.status != "active":
            raise ControlPlaneError("SHARE_NOT_ACTIVE", f"Share grant is {grant.status}", 409)
        if contains_minor or grant.contains_minor:
            raise ControlPlaneError(
                "MINOR_PUBLIC_MOUNT_FORBIDDEN",
                "Works involving minors cannot be mounted to public Xiaohongshu notes",
                403,
            )
        if not participant_consent_refs or set(participant_consent_refs) != set(grant.participant_consent_refs):
            raise ControlPlaneError(
                "CONSENT_MISMATCH",
                "All participant consent references must match the active share grant",
                403,
            )

        current_time = now or datetime.now(timezone.utc)
        if datetime.fromisoformat(grant.expires_at) <= current_time:
            raise ControlPlaneError("SHARE_EXPIRED", "Share grant has expired", 409)

        clean_title = title.strip()
        if not clean_title:
            raise ControlPlaneError("INVALID_TITLE", "Note mount title cannot be empty", 400)
        enforced_title = (
            clean_title
            if "AI" in clean_title
            else f"【AI艺术示意】{clean_title}"
        )
        mount_id = f"mnt_{hashlib.sha256((idempotency_key + share_id).encode('utf-8')).hexdigest()[:16]}"
        xhs_path = f"/pages/index/index?share_id={share_id}&mount_id={mount_id}&ai_label=1"

        return XhsNoteMountRecord(
            mount_id=mount_id,
            share_id=share_id,
            xhs_path=xhs_path,
            enforced_title=enforced_title,
            ai_watermark_badge=AI_WATERMARK_BADGE,
            topic_tags=list(topic_tags),
            expires_at=grant.expires_at,
        )

    @property
    def ledger_entries(self) -> list[LedgerEntry]:
        rows = self._conn.execute(
            "SELECT entry_id, event_id, order_id, debit_account, credit_account, amount_minor, currency, created_at FROM cp_ledger_entries ORDER BY rowid ASC"
        ).fetchall()
        return [
            LedgerEntry(
                entry_id=r["entry_id"],
                event_id=r["event_id"],
                order_id=r["order_id"],
                debit_account=r["debit_account"],
                credit_account=r["credit_account"],
                amount_minor=int(r["amount_minor"]),
                currency=r["currency"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    @staticmethod
    def _validate_idempotency_key(key: str) -> None:
        if not key or not (16 <= len(key.strip()) <= 128):
            raise ControlPlaneError(
                "INVALID_IDEMPOTENCY_KEY",
                "Idempotency-Key must be between 16 and 128 characters",
                400,
            )
