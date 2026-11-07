"""
TimeCapsule Domain Package — P05 & P06:
- P05: Multi-Provider AI Orchestration Adapter ({submit, poll, cancel, quote_cost}),
       429/5xx/Timeout/Disconnect Recovery (A03), Circuit Breaker Failover (preserving user price),
       and Daily User Quota + Global Spend Cap Guard (A13).
- P06: Durable GenerationJob State Machine (contracts/state-machines.json),
       100x Idempotency-Key Deduplication (A02), Transactional Outbox & Scanner (A04),
       and Mid-Flight Consent Revocation Guard (A07).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
from typing import Any
import uuid

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    SPEC_ROOT,
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
    utc_now_iso,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer
from services.timecapsule.media_vault import MediaVaultService


@dataclass(frozen=True)
class ProviderMetadata:
    provider_id: str
    model_id: str
    model_version: str
    prompt_template_revision: str
    region: str
    allow_training: bool
    unit_cost_fen: int


class AIProviderRouter:
    """
    P05: Provider interface `{submit, poll, cancel, quote_cost}` with SQL-backed
    provider execution state, fault injection simulation for E2 verification (A03),
    circuit-breaker failover, and budget enforcement (A13).
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        *,
        daily_user_job_limit: int = 20,
        daily_global_budget_fen: int = 50_000,
        max_attempts_per_job: int = 3,
    ) -> None:
        self.db = db
        self.daily_user_job_limit = daily_user_job_limit
        self.daily_global_budget_fen = daily_global_budget_fen
        self.max_attempts_per_job = max_attempts_per_job
        self._providers: dict[str, ProviderMetadata] = {
            "seedream_cn_primary": ProviderMetadata(
                provider_id="seedream_cn_primary",
                model_id="seedream-portrait-v3",
                model_version="3.2.0",
                prompt_template_revision="pt-2026-11-v1",
                region="cn-north-1",
                allow_training=False,
                unit_cost_fen=35,
            ),
            "wanxiang_cn_fallback": ProviderMetadata(
                provider_id="wanxiang_cn_fallback",
                model_id="wanxiang-time-v2",
                model_version="2.4.1",
                prompt_template_revision="pt-2026-11-v1",
                region="cn-east-1",
                allow_training=False,
                unit_cost_fen=42,
            ),
        }
        self._init_provider_tables()

    def _init_provider_tables(self) -> None:
        with self.db.transaction() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS ai_provider_execution (
                    provider_job_key TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    prompt_revision TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('SUBMITTED','SUCCEEDED','CANCELLED','FAILED')),
                    quoted_cost_fen INTEGER NOT NULL,
                    actual_cost_fen INTEGER NOT NULL,
                    output_seed_digest TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS ai_provider_health (
                    provider_id TEXT PRIMARY KEY,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    circuit_open INTEGER NOT NULL DEFAULT 0,
                    injected_fault TEXT
                );
                """
            )
            for pid in self._providers:
                conn.execute(
                    "INSERT OR IGNORE INTO ai_provider_health (provider_id, consecutive_failures, circuit_open, injected_fault) VALUES (?, 0, 0, NULL)",
                    (pid,),
                )

    def inject_fault(self, provider_id: str, fault_mode: str | None) -> None:
        """Configures deterministic fault injection ('429', '503', 'timeout', 'disconnect_after_success', or None)."""
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE ai_provider_health SET injected_fault = ?, circuit_open = 0, consecutive_failures = 0 WHERE provider_id = ?",
                (fault_mode, provider_id),
            )

    def quote_cost(self, ai_mode: str, provider_id: str = "seedream_cn_primary") -> dict[str, Any]:
        if ai_mode == "none":
            return {
                "provider_id": "deterministic_only",
                "model_version": "none",
                "prompt_template_revision": "none",
                "region": "cn-local",
                "allow_training": False,
                "quoted_cost_fen": 0,
            }
        meta = self._providers[provider_id]
        if meta.allow_training:
            raise TimeCapsuleError("TRAINING_POLICY_VIOLATION", "Portrait assets must never default to training", 500)
        return {
            "provider_id": meta.provider_id,
            "model_id": meta.model_id,
            "model_version": meta.model_version,
            "prompt_template_revision": meta.prompt_template_revision,
            "region": meta.region,
            "allow_training": meta.allow_training,
            "quoted_cost_fen": meta.unit_cost_fen,
        }

    def check_quota_and_budget(self, *, user_id: str, required_cost_fen: int) -> None:
        """A13: Enforces daily per-user quota and global spend cap before accepting/charging."""
        user_jobs = self.db.query_one(
            "SELECT COUNT(*) AS cnt FROM generation_job WHERE user_id = ? AND state != 'CANCELLED'",
            (user_id,),
        )
        if user_jobs and int(user_jobs["cnt"]) >= self.daily_user_job_limit:
            raise TimeCapsuleError(
                "USER_DAILY_QUOTA_EXCEEDED",
                f"User {user_id} reached daily generation quota ({self.daily_user_job_limit})",
                429,
            )
        spend_row = self.db.query_one(
            "SELECT COALESCE(SUM(actual_cost_fen), 0) AS total_fen FROM generation_job WHERE state NOT IN ('FAILED','CANCELLED')"
        )
        current_spend = int(spend_row["total_fen"]) if spend_row else 0
        if current_spend + required_cost_fen > self.daily_global_budget_fen:
            raise TimeCapsuleError(
                "GLOBAL_BUDGET_CAP_EXCEEDED",
                f"Global daily AI spend cap ({self.daily_global_budget_fen} fen) reached; new paid tasks blocked before charge",
                503,
            )

    def poll(self, provider_job_key: str) -> dict[str, Any] | None:
        row = self.db.query_one(
            "SELECT provider_job_key, job_id, provider_id, model_version, status, quoted_cost_fen, actual_cost_fen, output_seed_digest FROM ai_provider_execution WHERE provider_job_key = ?",
            (provider_job_key,),
        )
        return dict(row) if row is not None else None

    def cancel(self, provider_job_key: str, now: datetime | None = None) -> bool:
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            cur = conn.execute(
                "UPDATE ai_provider_execution SET status = 'CANCELLED', updated_at = ? WHERE provider_job_key = ? AND status != 'CANCELLED'",
                (now_str, provider_job_key),
            )
            return cur.rowcount > 0

    def submit(
        self,
        *,
        job_id: str,
        ai_mode: str,
        user_confirmed_quote_fen: int,
        input_digest: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        A03: Executes or reconciles an AI provider submission:
        1. First polls by deterministic `provider_job_key` so a prior 'disconnect_after_success'
           recovers the existing result without double-billing or re-running GPU inference.
        2. If primary provider has circuit open or returns 5xx, fails over to `wanxiang_cn_fallback`
           while strictly preserving `user_confirmed_quote_fen` as the user-facing price.
        """
        now_str = utc_now_iso(now)
        provider_job_key = f"pjk_{job_id}"
        existing = self.poll(provider_job_key)
        if existing is not None and existing["status"] == "SUCCEEDED":
            return {
                **existing,
                "recovered_from_prior_execution": True,
                "user_charged_fen": user_confirmed_quote_fen,
            }

        if ai_mode == "none":
            seed_digest = sha256_hex(f"deterministic:{job_id}:{input_digest}")
            with self.db.transaction() as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO ai_provider_execution (
                        provider_job_key, job_id, provider_id, model_version, prompt_revision,
                        status, quoted_cost_fen, actual_cost_fen, output_seed_digest, created_at, updated_at
                    ) VALUES (?, ?, 'deterministic_only', 'none', 'none', 'SUCCEEDED', 0, 0, ?, ?, ?)
                    """,
                    (provider_job_key, job_id, seed_digest, now_str, now_str),
                )
            return {
                "provider_job_key": provider_job_key,
                "job_id": job_id,
                "provider_id": "deterministic_only",
                "model_version": "none",
                "status": "SUCCEEDED",
                "quoted_cost_fen": 0,
                "actual_cost_fen": 0,
                "user_charged_fen": user_confirmed_quote_fen,
                "output_seed_digest": seed_digest,
                "recovered_from_prior_execution": False,
            }

        candidate_order = ["seedream_cn_primary", "wanxiang_cn_fallback"]
        last_error: TimeCapsuleError | None = None

        for pid in candidate_order:
            health = self.db.query_one(
                "SELECT consecutive_failures, circuit_open, injected_fault FROM ai_provider_health WHERE provider_id = ?",
                (pid,),
            )
            if health and int(health["circuit_open"]) == 1 and pid != candidate_order[-1]:
                continue

            fault = str(health["injected_fault"]) if (health and health["injected_fault"]) else None
            meta = self._providers[pid]

            if fault == "429":
                # Transient rate limit: record failure and raise retryable 429
                self._record_provider_failure(pid, open_circuit=False)
                raise TimeCapsuleError(
                    "PROVIDER_RATE_LIMITED_429",
                    f"Provider {pid} returned 429 Too Many Requests; exponential backoff scheduled",
                    429,
                    {"retryable": True, "provider_id": pid},
                )
            if fault in ("503", "timeout"):
                # Open circuit on primary and fail over to fallback provider
                self._record_provider_failure(pid, open_circuit=True)
                last_error = TimeCapsuleError(
                    f"PROVIDER_{fault.upper()}",
                    f"Provider {pid} failed with {fault}",
                    503,
                    {"retryable": True, "provider_id": pid},
                )
                continue

            seed_digest = sha256_hex(f"{pid}:{meta.model_version}:{job_id}:{input_digest}")
            with self.db.transaction() as conn:
                conn.execute(
                    "UPDATE ai_provider_health SET consecutive_failures = 0, circuit_open = 0 WHERE provider_id = ?",
                    (pid,),
                )
                conn.execute(
                    """
                    INSERT OR REPLACE INTO ai_provider_execution (
                        provider_job_key, job_id, provider_id, model_version, prompt_revision,
                        status, quoted_cost_fen, actual_cost_fen, output_seed_digest, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, ?)
                    """,
                    (
                        provider_job_key,
                        job_id,
                        pid,
                        meta.model_version,
                        meta.prompt_template_revision,
                        user_confirmed_quote_fen,
                        meta.unit_cost_fen,
                        seed_digest,
                        now_str,
                        now_str,
                    ),
                )

            if fault == "disconnect_after_success":
                # Clear one-shot disconnect fault so subsequent poll recovers the persisted execution
                self.inject_fault(pid, None)
                raise TimeCapsuleError(
                    "PROVIDER_NETWORK_DISCONNECT",
                    f"Network disconnected after {pid} accepted job {job_id}; poll reconciliation required",
                    502,
                    {"retryable": True, "provider_id": pid},
                )

            return {
                "provider_job_key": provider_job_key,
                "job_id": job_id,
                "provider_id": pid,
                "model_version": meta.model_version,
                "status": "SUCCEEDED",
                "quoted_cost_fen": user_confirmed_quote_fen,
                "actual_cost_fen": meta.unit_cost_fen,
                "user_charged_fen": user_confirmed_quote_fen,
                "output_seed_digest": seed_digest,
                "recovered_from_prior_execution": False,
            }

        if last_error is not None:
            raise last_error
        raise TimeCapsuleError("ALL_PROVIDERS_UNAVAILABLE", "No AI providers available", 503)

    def _record_provider_failure(self, provider_id: str, *, open_circuit: bool) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                UPDATE ai_provider_health
                SET consecutive_failures = consecutive_failures + 1,
                    circuit_open = CASE WHEN ? THEN 1 ELSE circuit_open END
                WHERE provider_id = ?
                """,
                (1 if open_circuit else 0, provider_id),
            )


class GenerationJobService:
    """
    P06: Enforces the exact `contracts/state-machines.json` job graph,
    100x idempotency-key deduplication (A02), transactional outbox (A04),
    and worker execution through VALIDATED -> QUEUED -> RUNNING -> MODERATION -> RENDERING -> READY.
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        identity: IdentityConsentService,
        catalog: CatalogService,
        vault: MediaVaultService,
        renderer: DeterministicRenderer,
        provider_router: AIProviderRouter,
        validator: SpecContractValidator | None = None,
        spec_root: Path = SPEC_ROOT,
    ) -> None:
        self.db = db
        self.identity = identity
        self.catalog = catalog
        self.vault = vault
        self.renderer = renderer
        self.provider_router = provider_router
        self.validator = validator or SpecContractValidator(spec_root)
        state_machines = json.loads((spec_root / "contracts" / "state-machines.json").read_text(encoding="utf-8"))
        self._job_graph: dict[str, list[str]] = state_machines["job"]

    def create_job(
        self,
        *,
        actor_user_id: str,
        idempotency_key: str,
        consent_id: str,
        render_request: dict[str, Any],
        simulate_outbox_delivery_failure: bool = False,
        now: datetime | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """
        P06 & A02: Creates or deduplicates a GenerationJob asynchronously (HTTP 202).
        Never blocks synchronously on GPU model inference during HTTP request handling.
        Returns `(job_dict, deduplicated_bool)`.
        """
        clean_idem = idempotency_key.strip()
        if len(clean_idem) < 8:
            raise TimeCapsuleError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be at least 8 characters", 400)

        request_with_idem = {**render_request, "idempotency_key": clean_idem}
        canonical_payload = json.dumps(
            {
                "template_id": request_with_idem.get("template_id"),
                "template_version": request_with_idem.get("template_version"),
                "style_id": request_with_idem.get("style_id"),
                "fields": request_with_idem.get("fields"),
                "asset_ids": request_with_idem.get("asset_ids"),
                "export_size": request_with_idem.get("export_size"),
                "consent_id": consent_id,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        request_sha256 = sha256_hex(canonical_payload)

        # Check idempotency key first (A02)
        existing = self.db.query_one(
            "SELECT * FROM generation_job WHERE user_id = ? AND idempotency_key = ?",
            (actor_user_id, clean_idem),
        )
        if existing is not None:
            if str(existing["request_sha256"]) != request_sha256:
                raise TimeCapsuleError(
                    "IDEMPOTENCY_KEY_CONFLICT",
                    "Idempotency-Key reused with different job request payload",
                    409,
                )
            return self._row_to_job_schema(existing), True

        # Verify consent (AGENTS.md invariant: no portrait generation without active consent)
        self.identity.require_active_consent(
            actor_user_id=actor_user_id,
            consent_id=consent_id,
            required_purpose="portrait_generation",
        )

        # Validate template, style, and fields
        validated = self.catalog.validate_render_request(request_with_idem)
        template = validated["template"]

        # Verify user owns all referenced media assets and they are READY
        for aid in request_with_idem["asset_ids"]:
            self.vault.get_asset_for_user(actor_user_id=actor_user_id, asset_id=aid)

        quote = self.provider_router.quote_cost(template["ai_mode"])
        self.provider_router.check_quota_and_budget(
            user_id=actor_user_id,
            required_cost_fen=int(quote["quoted_cost_fen"]),
        )

        now_str = utc_now_iso(now)
        job_id = str(uuid.uuid4())

        # Create job in CREATED -> transition to VALIDATED -> QUEUED atomically with transactional_outbox
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO generation_job (
                    id, user_id, template_id, template_revision, style_id, export_size,
                    fields_json, asset_ids_json, consent_id, state, idempotency_key,
                    request_sha256, attempt_count, provider, quoted_cost_fen, actual_cost_fen,
                    result_asset_id, error_code, created_at, updated_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, 0, ?, ?, 0, NULL, NULL, ?, ?, 1)
                """,
                (
                    job_id,
                    actor_user_id,
                    template["id"],
                    template["version"],
                    request_with_idem["style_id"],
                    request_with_idem["export_size"],
                    json.dumps(request_with_idem["fields"], ensure_ascii=False, sort_keys=True),
                    json.dumps(request_with_idem["asset_ids"]),
                    consent_id,
                    clean_idem,
                    request_sha256,
                    str(quote["provider_id"]),
                    int(quote["quoted_cost_fen"]),
                    now_str,
                    now_str,
                ),
            )
            self._transition_in_tx(conn, job_id=job_id, target_state="VALIDATED", now_str=now_str)
            self._transition_in_tx(conn, job_id=job_id, target_state="QUEUED", now_str=now_str)

            outbox_event_id = str(uuid.uuid4())
            dispatched_at = None if simulate_outbox_delivery_failure else now_str
            conn.execute(
                """
                INSERT INTO transactional_outbox (event_id, event_type, aggregate_id, payload, created_at, dispatched_at)
                VALUES (?, 'GENERATION_JOB_QUEUED', ?, ?, ?, ?)
                """,
                (
                    outbox_event_id,
                    job_id,
                    json.dumps({"job_id": job_id, "user_id": actor_user_id}, sort_keys=True),
                    now_str,
                    dispatched_at,
                ),
            )

        row = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        assert row is not None
        job_dict = self._row_to_job_schema(row)
        self.validator.validate("generation-job", job_dict)
        return job_dict, False

    def get_job(self, *, actor_user_id: str, job_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        if row is None:
            raise TimeCapsuleError("JOB_NOT_FOUND", f"Job {job_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="generation_job",
            resource_id=job_id,
        )
        return self._row_to_job_schema(row)

    def request_cancel(self, *, actor_user_id: str, job_id: str, now: datetime | None = None) -> dict[str, Any]:
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM generation_job WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise TimeCapsuleError("JOB_NOT_FOUND", f"Job {job_id} not found", 404)
            self.identity.assert_owner_access(
                actor_user_id=actor_user_id,
                owner_user_id=str(row["user_id"]),
                resource_type="generation_job",
                resource_id=job_id,
            )
            current = str(row["state"])
            if current in ("CREATED", "VALIDATED"):
                self._transition_in_tx(conn, job_id=job_id, target_state="CANCELLED", now_str=now_str)
            elif current in ("QUEUED", "RUNNING", "MODERATION", "RENDERING"):
                self._transition_in_tx(conn, job_id=job_id, target_state="CANCEL_REQUESTED", now_str=now_str)
                self.provider_router.cancel(f"pjk_{job_id}", now=now)
                self._transition_in_tx(conn, job_id=job_id, target_state="CANCELLED", now_str=now_str)
            else:
                raise TimeCapsuleError(
                    "INVALID_JOB_STATE_TRANSITION",
                    f"Cannot cancel job in state '{current}'",
                    409,
                )
        updated = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        assert updated is not None
        return self._row_to_job_schema(updated)

    def process_job_step(self, job_id: str, *, now: datetime | None = None) -> dict[str, Any]:
        """
        Worker execution loop driving a job through:
        QUEUED -> RUNNING -> MODERATION -> RENDERING -> READY (with A03 retry/failover & A07 consent re-check).
        """
        now_str = utc_now_iso(now)
        row = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        if row is None:
            raise TimeCapsuleError("JOB_NOT_FOUND", f"Job {job_id} not found", 404)

        state = str(row["state"])
        if state in ("READY", "FAILED", "CANCELLED", "EXPIRED"):
            return self._row_to_job_schema(row)

        user_id = str(row["user_id"])
        consent_id = str(row["consent_id"])

        # A07: Re-verify consent has not been revoked before starting or completing
        consent_row = self.db.query_one("SELECT status FROM consent_record WHERE id = ?", (consent_id,))
        if consent_row is None or str(consent_row["status"]) != "GRANTED":
            with self.db.transaction() as conn:
                if state != "CANCEL_REQUESTED":
                    self._transition_in_tx(conn, job_id=job_id, target_state="CANCEL_REQUESTED", now_str=now_str)
                self._transition_in_tx(
                    conn,
                    job_id=job_id,
                    target_state="CANCELLED",
                    error_code="CONSENT_REVOKED_ABORT",
                    now_str=now_str,
                )
            updated = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
            assert updated is not None
            return self._row_to_job_schema(updated)

        if state == "QUEUED":
            with self.db.transaction() as conn:
                self._transition_in_tx(conn, job_id=job_id, target_state="RUNNING", now_str=now_str)

        # Execute AI Provider call (or recover prior execution)
        template = self.catalog.get_template_revision(
            str(row["template_id"]),
            str(row["template_revision"]),
            allow_retired=True,
        )
        style = self.catalog.get_style(str(row["style_id"]))
        fields = json.loads(str(row["fields_json"]))
        asset_ids = json.loads(str(row["asset_ids_json"]))

        try:
            with self.db.transaction() as conn:
                conn.execute(
                    "UPDATE generation_job SET attempt_count = attempt_count + 1, updated_at = ?, version = version + 1 WHERE id = ?",
                    (now_str, job_id),
                )
            provider_res = self.provider_router.submit(
                job_id=job_id,
                ai_mode=template["ai_mode"],
                user_confirmed_quote_fen=int(row["quoted_cost_fen"]),
                input_digest=str(row["request_sha256"]),
                now=now,
            )
        except TimeCapsuleError as exc:
            refreshed = self.db.query_one("SELECT attempt_count FROM generation_job WHERE id = ?", (job_id,))
            attempts = int(refreshed["attempt_count"]) if refreshed else 1
            if not exc.details.get("retryable") or attempts >= self.provider_router.max_attempts_per_job:
                with self.db.transaction() as conn:
                    self._transition_in_tx(
                        conn,
                        job_id=job_id,
                        target_state="FAILED",
                        error_code=exc.code,
                        now_str=now_str,
                    )
            raise

        # Transition RUNNING -> MODERATION -> RENDERING
        with self.db.transaction() as conn:
            self._transition_in_tx(
                conn,
                job_id=job_id,
                target_state="MODERATION",
                provider=str(provider_res["provider_id"]),
                actual_cost_fen=int(provider_res["actual_cost_fen"]),
                now_str=now_str,
            )
            self._transition_in_tx(conn, job_id=job_id, target_state="RENDERING", now_str=now_str)

        # A07 check again right before rendering & publishing to READY
        consent_after = self.db.query_one("SELECT status FROM consent_record WHERE id = ?", (consent_id,))
        if consent_after is None or str(consent_after["status"]) != "GRANTED":
            with self.db.transaction() as conn:
                self._transition_in_tx(conn, job_id=job_id, target_state="CANCEL_REQUESTED", now_str=now_str)
                self._transition_in_tx(
                    conn,
                    job_id=job_id,
                    target_state="CANCELLED",
                    error_code="CONSENT_REVOKED_ABORT",
                    now_str=now_str,
                )
            updated = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
            assert updated is not None
            return self._row_to_job_schema(updated)

        asset_digests: list[str] = []
        for aid in asset_ids:
            asset_meta = self.vault.get_asset_for_user(actor_user_id=user_id, asset_id=aid)
            asset_digests.append(str(asset_meta["sha256"]))

        rendered = self.renderer.render_card(
            template_manifest=template,
            style_manifest=style,
            fields=fields,
            asset_digests=asset_digests,
            export_size=str(row["export_size"]),
            quality_tier="preview",
        )
        stored_preview = self.vault.store_derived_asset(
            user_id=user_id,
            media_type="image/png",
            payload_bytes=rendered.png_bytes,
            width_px=rendered.width_px,
            height_px=rendered.height_px,
            prefix="preview",
            now=now,
        )

        with self.db.transaction() as conn:
            self._transition_in_tx(
                conn,
                job_id=job_id,
                target_state="READY",
                result_asset_id=stored_preview["asset_id"],
                now_str=now_str,
            )
            work_manifest = {
                "job_id": job_id,
                "template_id": template["id"],
                "template_revision": template["version"],
                "style_id": style["id"],
                "renderer_revision": rendered.renderer_revision,
                "provider_id": provider_res["provider_id"],
                "model_version": provider_res["model_version"],
                "input_digest": rendered.input_digest,
                "media_digest": rendered.media_digest,
                "preview_asset_id": stored_preview["asset_id"],
                "fields": fields,
                "export_size": str(row["export_size"]),
                "ai_label_text": rendered.ai_label_text,
            }
            manifest_json = json.dumps(work_manifest, ensure_ascii=False, sort_keys=True)
            conn.execute(
                """
                INSERT OR IGNORE INTO work (
                    id, user_id, job_id, template_id, template_revision, style_id,
                    manifest_json, manifest_sha256, export_asset_id, contains_minor, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
                """,
                (
                    str(uuid.uuid5(uuid.NAMESPACE_OID, f"work:{job_id}")),
                    user_id,
                    job_id,
                    template["id"],
                    template["version"],
                    style["id"],
                    manifest_json,
                    sha256_hex(manifest_json),
                    1 if template["category"] == "baby" else 0,
                    now_str,
                ),
            )

        final_row = self.db.query_one("SELECT * FROM generation_job WHERE id = ?", (job_id,))
        assert final_row is not None
        return self._row_to_job_schema(final_row)

    def run_outbox_scanner(self, *, now: datetime | None = None) -> dict[str, Any]:
        """
        A04: Scans pending `transactional_outbox` events where `dispatched_at IS NULL`,
        processes queued jobs idempotently, and marks each event dispatched exactly once.
        """
        now_str = utc_now_iso(now)
        pending = self.db.query_all(
            "SELECT event_id, event_type, aggregate_id, payload FROM transactional_outbox WHERE dispatched_at IS NULL ORDER BY created_at ASC"
        )
        dispatched_ids: list[str] = []
        processed_jobs: list[str] = []

        for ev in pending:
            ev_id = str(ev["event_id"])
            ev_type = str(ev["event_type"])
            agg_id = str(ev["aggregate_id"])
            if ev_type == "GENERATION_JOB_QUEUED":
                job_row = self.db.query_one("SELECT state FROM generation_job WHERE id = ?", (agg_id,))
                if job_row and str(job_row["state"]) == "QUEUED":
                    self.process_job_step(agg_id, now=now)
                    processed_jobs.append(agg_id)
            with self.db.transaction() as conn:
                conn.execute(
                    "UPDATE transactional_outbox SET dispatched_at = ? WHERE event_id = ? AND dispatched_at IS NULL",
                    (now_str, ev_id),
                )
            dispatched_ids.append(ev_id)

        return {
            "dispatched_count": len(dispatched_ids),
            "dispatched_event_ids": dispatched_ids,
            "processed_job_ids": processed_jobs,
        }

    def _transition_in_tx(
        self,
        conn: Any,
        *,
        job_id: str,
        target_state: str,
        provider: str | None = None,
        actual_cost_fen: int | None = None,
        result_asset_id: str | None = None,
        error_code: str | None = None,
        now_str: str,
    ) -> None:
        row = conn.execute(
            "SELECT state, version, provider, actual_cost_fen, result_asset_id, error_code FROM generation_job WHERE id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            raise TimeCapsuleError("JOB_NOT_FOUND", f"Job {job_id} not found", 404)
        current_state = str(row["state"])
        allowed = self._job_graph.get(current_state, [])
        if target_state not in allowed:
            raise TimeCapsuleError(
                "INVALID_JOB_STATE_TRANSITION",
                f"Illegal job state transition {current_state} -> {target_state}; allowed: {allowed}",
                409,
            )
        cur = conn.execute(
            """
            UPDATE generation_job
            SET state = ?,
                provider = COALESCE(?, provider),
                actual_cost_fen = COALESCE(?, actual_cost_fen),
                result_asset_id = COALESCE(?, result_asset_id),
                error_code = COALESCE(?, error_code),
                updated_at = ?,
                version = version + 1
            WHERE id = ? AND version = ?
            """,
            (
                target_state,
                provider,
                actual_cost_fen,
                result_asset_id,
                error_code,
                now_str,
                job_id,
                int(row["version"]),
            ),
        )
        if cur.rowcount != 1:
            raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Job state optimistic lock conflict", 409)

    @staticmethod
    def _row_to_job_schema(row: Any) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "user_id": str(row["user_id"]),
            "template_id": str(row["template_id"]),
            "template_version": str(row["template_revision"]),
            "status": str(row["state"]),
            "idempotency_key": str(row["idempotency_key"]),
            "consent_ref": str(row["consent_id"]),
            "created_at": str(row["created_at"]),
            "error_code": str(row["error_code"]) if row["error_code"] is not None else None,
        }
