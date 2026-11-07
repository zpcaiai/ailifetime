"""
TimeCapsule Domain Package — OpenAPI v1 HTTP Server & Application Facade:
Exposes all `spec/timecapsule/contracts/openapi.yaml` and P00–P14 endpoints over real
HTTP/1.1 sockets with Bearer session authentication, Idempotency-Key enforcement,
content moderation screening, and OpenTelemetry-compatible SLO telemetry recording.
"""
from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import time
from typing import Any
from urllib.parse import parse_qs, urlparse
import uuid

from services.timecapsule.ai_orchestrator import AIProviderRouter, GenerationJobService
from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    SPEC_ROOT,
    AuthenticatedSession,
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer
from services.timecapsule.export_labeling import ExportLabelingService
from services.timecapsule.media_vault import MediaVaultService
from services.timecapsule.multiplatform_and_album import (
    MemorialAlbumVideoService,
    ObservabilitySLOService,
    PlatformSurfaceAdapter,
)
from services.timecapsule.payments_entitlement import PaymentEntitlementService
from services.timecapsule.timeline_moderation import (
    ContentModerationService,
    TimelineArchiveService,
)


class TimeCapsuleApplication:
    """Integrated facade wiring all P00–P14 domain services over a shared ACID SQLite database."""

    def __init__(self, db_path: str | Path = ":memory:", spec_root: Path = SPEC_ROOT) -> None:
        self.db = TimeCapsuleDatabase(db_path)
        self.validator = SpecContractValidator(spec_root)
        self.identity = IdentityConsentService(self.db, self.validator)
        self.catalog = CatalogService(self.db, self.validator, spec_root)
        self.vault = MediaVaultService(self.db, self.identity)
        self.renderer = DeterministicRenderer(self.validator)
        self.router = AIProviderRouter(self.db)
        self.jobs = GenerationJobService(
            self.db,
            self.identity,
            self.catalog,
            self.vault,
            self.renderer,
            self.router,
            self.validator,
            spec_root,
        )
        self.payments = PaymentEntitlementService(
            self.db,
            self.identity,
            self.catalog,
            spec_root=spec_root,
        )
        self.exports = ExportLabelingService(
            self.db,
            self.identity,
            self.catalog,
            self.vault,
            self.renderer,
            self.payments,
        )
        self.timeline = TimelineArchiveService(
            self.db,
            self.identity,
            self.catalog,
            self.vault,
            self.renderer,
        )
        self.moderation = ContentModerationService(self.db, self.identity)
        self.observability = ObservabilitySLOService(self.db)
        self.surface = PlatformSurfaceAdapter(
            self.db,
            self.identity,
            self.catalog,
            self.timeline,
            self.payments,
        )
        self.albums = MemorialAlbumVideoService(
            self.db,
            self.identity,
            self.payments,
            self.timeline,
        )

    def close(self) -> None:
        self.db.close()

    def handle_request(
        self,
        *,
        method: str,
        raw_path: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        t0 = time.perf_counter()
        parsed = urlparse(raw_path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        norm_headers = {k.lower(): v for k, v in headers.items()}
        request_id = norm_headers.get("x-request-id", f"req_{uuid.uuid4().hex[:12]}")
        trace_id = norm_headers.get("x-trace-id", f"trc_{uuid.uuid4().hex[:16]}")
        payload = body or {}

        actor_pseudonym = "anonymous"
        status_code = 200
        job_id_meta: str | None = None
        template_id_meta: str | None = None
        template_rev_meta: str | None = None
        provider_meta: str | None = None
        moderation_meta: str | None = None
        export_verified_meta: bool | None = None
        raw_payment_event_meta: str | None = None

        try:
            # Public/unauthenticated endpoints: login session exchange, webhook callback, public share resolve
            if method == "POST" and path == "/v1/sessions":
                session = self.identity.login_or_refresh_session(
                    wechat_code=str(payload.get("wechat_code", "")),
                    previous_token=payload.get("previous_token"),
                    draft=payload.get("draft"),
                )
                actor_pseudonym = session.pseudonym
                status_code = 201
                return status_code, {
                    "token": session.token,
                    "user_id": session.user_id,
                    "pseudonym": session.pseudonym,
                    "expires_at": session.expires_at,
                    "restored_draft": session.restored_draft,
                }

            if method == "POST" and path == "/v1/payments/webhook":
                raw_payment_event_meta = str(payload.get("provider_event_id", ""))
                res = self.payments.handle_payment_webhook(payload)
                status_code = 200
                return status_code, res

            if method == "GET" and path.startswith("/v1/shares/"):
                token = path.split("/v1/shares/", 1)[1]
                res = self.timeline.resolve_share_token(token)
                status_code = 200
                return status_code, res

            # All other OpenAPI v1 routes require Bearer sessionAuth
            session = self._require_session(norm_headers)
            actor_pseudonym = session.pseudonym

            if method == "GET" and path == "/v1/templates":
                cat = query.get("category", [None])[0]
                res = self.catalog.list_catalog(category=cat)
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/consents":
                res = self.identity.record_consent(
                    actor_user_id=session.user_id,
                    subject_id=str(payload.get("subject_id", "")),
                    purpose=str(payload.get("purpose", "")),
                    policy_revision=str(payload.get("policy_revision", "")),
                    evidence_ref=str(payload.get("evidence_ref", "")),
                    guardian_evidence_ref=payload.get("guardian_evidence_ref"),
                    is_minor=bool(payload.get("is_minor", False)),
                )
                status_code = 201
                return status_code, res

            if method == "POST" and path.startswith("/v1/consents/") and path.endswith("/revoke"):
                consent_id = path[len("/v1/consents/") : -len("/revoke")]
                res = self.identity.revoke_consent(actor_user_id=session.user_id, consent_id=consent_id)
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/uploads/intents":
                res = self.vault.create_upload_intent(
                    actor_user_id=session.user_id,
                    declared_media_type=str(payload.get("media_type", "")),
                    declared_size_bytes=int(payload.get("size_bytes", 0)),
                    declared_sha256=str(payload.get("sha256", "")),
                    client_supplied_storage_key=payload.get("storage_key"),
                )
                status_code = 201
                return status_code, res

            if method == "PUT" and path.startswith("/v1/uploads/"):
                asset_id = path.split("/v1/uploads/", 1)[1]
                raw_bytes = base64.b64decode(str(payload.get("content_base64", "")))
                res = self.vault.upload_and_sanitize(
                    actor_user_id=session.user_id,
                    asset_id=asset_id,
                    raw_bytes=raw_bytes,
                )
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/jobs":
                idem_key = norm_headers.get("idempotency-key", "")
                if not idem_key:
                    raise TimeCapsuleError("MISSING_IDEMPOTENCY_KEY", "Header 'Idempotency-Key' is required", 400)
                render_req = payload.get("render_request", payload)
                mod = self.moderation.screen_fields(
                    actor_user_id=session.user_id,
                    target_type="render_request",
                    target_id=idem_key,
                    fields=render_req.get("fields", {}),
                )
                moderation_meta = mod["decision"]
                job_dict, deduplicated = self.jobs.create_job(
                    actor_user_id=session.user_id,
                    idempotency_key=idem_key,
                    consent_id=str(payload["consent_id"]),
                    render_request=render_req,
                )
                job_id_meta = job_dict["id"]
                template_id_meta = job_dict["template_id"]
                template_rev_meta = job_dict["template_version"]
                status_code = 202
                return status_code, {**job_dict, "deduplicated": deduplicated}

            if method == "GET" and path.startswith("/v1/jobs/"):
                job_id = path.split("/v1/jobs/", 1)[1]
                job_id_meta = job_id
                res = self.jobs.get_job(actor_user_id=session.user_id, job_id=job_id)
                status_code = 200
                return status_code, res

            if method == "POST" and path.startswith("/v1/jobs/") and path.endswith("/process"):
                job_id = path[len("/v1/jobs/") : -len("/process")]
                job_id_meta = job_id
                res = self.jobs.process_job_step(job_id)
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/orders":
                res = self.payments.create_order(
                    actor_user_id=session.user_id,
                    product_id=str(payload.get("product_id", "")),
                    client_supplied_amount_fen=payload.get("amount_fen"),
                    client_supplied_user_id=payload.get("user_id"),
                )
                status_code = 201
                return status_code, res

            if method == "POST" and path == "/v1/exports":
                exp = self.exports.request_export(
                    actor_user_id=session.user_id,
                    job_id=str(payload.get("job_id", "")),
                    export_format=str(payload.get("export_format", "png")),
                    entitlement_id=payload.get("entitlement_id"),
                    remove_ai_label=bool(payload.get("remove_ai_label", False)),
                    bypass_label_check=bool(payload.get("bypass_label_check", False)),
                )
                export_verified_meta = bool(exp["export_label_verified"])
                response_copy = {k: v for k, v in exp.items() if k != "exported_bytes"}
                status_code = 202
                return status_code, response_copy

            if method == "POST" and path == "/v1/privacy/deletion-requests":
                res = self.identity.request_deletion(actor_user_id=session.user_id)
                status_code = 202
                return status_code, res

            if method == "POST" and path == "/v1/timeline/milestones":
                res = self.timeline.add_timeline_milestone(
                    actor_user_id=session.user_id,
                    work_id=str(payload["work_id"]),
                    age_milestone=int(payload["age_milestone"]),
                    event_date=str(payload["event_date"]),
                    narrative=str(payload["narrative"]),
                )
                status_code = 201
                return status_code, res

            if method == "GET" and path == "/v1/timeline":
                res = {"entries": self.timeline.list_timeline(actor_user_id=session.user_id)}
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/shares":
                res = self.timeline.create_share_grant(
                    actor_user_id=session.user_id,
                    work_id=str(payload["work_id"]),
                    share_consent_id=str(payload["share_consent_id"]),
                )
                status_code = 201
                return status_code, res

            if method == "POST" and path.startswith("/v1/shares/") and path.endswith("/revoke"):
                token = path[len("/v1/shares/") : -len("/revoke")]
                res = self.timeline.revoke_share_grant(actor_user_id=session.user_id, token=token)
                status_code = 200
                return status_code, res

            if method == "POST" and path == "/v1/albums":
                res = self.albums.create_and_compose_album_video(
                    actor_user_id=session.user_id,
                    entitlement_id=str(payload["entitlement_id"]),
                    work_ids=list(payload["work_ids"]),
                    subtitles=list(payload["subtitles"]),
                )
                status_code = 202
                return status_code, res

            if method == "GET" and path.startswith("/v1/surface/"):
                parts = path[len("/v1/surface/") :].split("/")
                if len(parts) != 2:
                    raise TimeCapsuleError("NOT_FOUND", f"Unknown surface route {path}", 404)
                platform_id, page_id = parts
                a11y = query.get("a11y", ["standard"])[0]
                client_paid = query.get("client_claimed_paid", ["false"])[0].lower() == "true"
                res = self.surface.build_page_view_model(
                    platform=platform_id,
                    page=page_id,
                    actor_user_id=session.user_id,
                    accessibility_mode=a11y,
                    client_claimed_paid=client_paid,
                )
                status_code = 200
                return status_code, res

            if method == "GET" and path == "/v1/metrics/slo":
                res = self.observability.evaluate_slo_and_unit_economics()
                status_code = 200
                return status_code, res

            status_code = 404
            return status_code, {"code": "ROUTE_NOT_FOUND", "message": f"No route for {method} {path}"}

        except TimeCapsuleError as exc:
            status_code = exc.status_code
            return status_code, exc.to_dict(request_id=request_id)
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            self.observability.record_event(
                trace_id=trace_id,
                request_id=request_id,
                event_name=f"{method} {path}",
                route=path,
                status_code=status_code,
                latency_ms=elapsed_ms,
                user_pseudonym=actor_pseudonym,
                job_id=job_id_meta,
                template_id=template_id_meta,
                template_version=template_rev_meta,
                provider=provider_meta,
                moderation_result=moderation_meta,
                export_label_verified=export_verified_meta,
                raw_payment_event_id=raw_payment_event_meta,
            )

    def _require_session(self, norm_headers: dict[str, str]) -> AuthenticatedSession:
        auth_header = norm_headers.get("authorization", "")
        return self.identity.authenticate(auth_header)


def create_http_server(
    app: TimeCapsuleApplication,
    host: str = "127.0.0.1",
    port: int = 0,
) -> ThreadingHTTPServer:
    """Starts a real multi-threaded loopback HTTP/1.1 server for E2 contract and E2E verification."""

    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self, method: str) -> None:
            content_len = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_len) if content_len > 0 else b""
            parsed_body = json.loads(raw_body.decode("utf-8")) if raw_body else None
            hdrs = {k: v for k, v in self.headers.items()}
            status, payload = app.handle_request(
                method=method,
                raw_path=self.path,
                headers=hdrs,
                body=parsed_body,
            )
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def log_message(self, fmt: str, *args: Any) -> None:
            return

    return ThreadingHTTPServer((host, port), Handler)
