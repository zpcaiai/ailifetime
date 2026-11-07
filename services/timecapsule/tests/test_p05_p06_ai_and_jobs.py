"""
Executable verification tests for Slice 4 (P05 & P06):
- A02: Submitting the same Idempotency-Key 100 times produces exactly 1 logical GenerationJob;
       reusing the same Idempotency-Key with a different payload raises 409 IDEMPOTENCY_KEY_CONFLICT.
- A03: AI provider 429 rate-limit backoff, 503 circuit-breaker failover to fallback provider
       without changing user-confirmed price, and network disconnect recovery via idempotent poll.
- A04: PostgreSQL/SQLite commit succeeds while outbox delivery fails -> OutboxScanner delivers
       and processes the job exactly once.
- A07: Revoking consent before job reaches READY aborts publication and transitions job to CANCELLED.
- A13: Global budget cap reached -> blocks new jobs before charging.
"""
from __future__ import annotations

import unittest

from services.timecapsule.ai_orchestrator import AIProviderRouter, GenerationJobService
from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer
from services.timecapsule.media_vault import MediaVaultService
from services.timecapsule.tests.test_p02_p03_catalog_media import build_test_png


class TestP05AndP06AIAndJobs(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TimeCapsuleDatabase(":memory:")
        self.validator = SpecContractValidator()
        self.identity = IdentityConsentService(self.db, self.validator)
        self.catalog = CatalogService(self.db, self.validator)
        self.vault = MediaVaultService(self.db, self.identity)
        self.renderer = DeterministicRenderer(self.validator)
        self.router = AIProviderRouter(self.db, daily_user_job_limit=10, daily_global_budget_fen=500)
        self.jobs = GenerationJobService(
            self.db,
            self.identity,
            self.catalog,
            self.vault,
            self.renderer,
            self.router,
            self.validator,
        )

        self.user = self.identity.login_or_refresh_session(wechat_code="wx_job_tester_01")
        self.consent = self.identity.record_consent(
            actor_user_id=self.user.user_id,
            subject_id="self_01",
            purpose="portrait_generation",
            policy_revision="2026.11-v1",
            evidence_ref="ev_portrait_job_01",
        )
        png_bytes = build_test_png(32, 32)
        intent = self.vault.create_upload_intent(
            actor_user_id=self.user.user_id,
            declared_media_type="image/png",
            declared_size_bytes=len(png_bytes),
            declared_sha256=sha256_hex(png_bytes),
        )
        self.asset = self.vault.upload_and_sanitize(
            actor_user_id=self.user.user_id,
            asset_id=intent["asset_id"],
            raw_bytes=png_bytes,
        )

    def tearDown(self) -> None:
        self.db.close()

    def _base_render_request(self, idem: str = "idem_key_00001") -> dict:
        return {
            "template_id": "life_0_100",
            "template_version": "1.0.0",
            "style_id": "minimal",
            "fields": {"title": "我的0-100岁时光", "display_name": "小忆"},
            "asset_ids": [self.asset["asset_id"]],
            "export_size": "3:4",
            "idempotency_key": idem,
        }

    def test_a02_100x_duplicate_idempotency_key_creates_single_logical_job(self) -> None:
        first_job, dedup0 = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_100x_repeat_key",
            consent_id=self.consent["id"],
            render_request=self._base_render_request("idem_100x_repeat_key"),
        )
        self.assertFalse(dedup0)

        for _ in range(99):
            repeated_job, dedup = self.jobs.create_job(
                actor_user_id=self.user.user_id,
                idempotency_key="idem_100x_repeat_key",
                consent_id=self.consent["id"],
                render_request=self._base_render_request("idem_100x_repeat_key"),
            )
            self.assertTrue(dedup)
            self.assertEqual(repeated_job["id"], first_job["id"])

        cnt = self.db.query_one("SELECT COUNT(*) AS c FROM generation_job WHERE user_id = ?", (self.user.user_id,))
        self.assertEqual(int(cnt["c"]), 1)

        # Reusing same idempotency_key with mutated payload raises 409
        mutated = self._base_render_request("idem_100x_repeat_key")
        mutated["style_id"] = "retro"
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.jobs.create_job(
                actor_user_id=self.user.user_id,
                idempotency_key="idem_100x_repeat_key",
                consent_id=self.consent["id"],
                render_request=mutated,
            )
        self.assertEqual(ctx.exception.status_code, 409)

    def test_a03_provider_429_503_failover_and_disconnect_reconciliation(self) -> None:
        job, _ = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_fault_job_01",
            consent_id=self.consent["id"],
            render_request=self._base_render_request("idem_fault_job_01"),
        )

        # 1. Inject 429 on primary -> retryable error, job remains in RUNNING for retry
        self.router.inject_fault("seedream_cn_primary", "429")
        with self.assertRaises(TimeCapsuleError) as ctx_429:
            self.jobs.process_job_step(job["id"])
        self.assertEqual(ctx_429.exception.code, "PROVIDER_RATE_LIMITED_429")

        # 2. Inject 503 on primary -> circuit opens & fails over to wanxiang_cn_fallback without changing user price
        self.router.inject_fault("seedream_cn_primary", "503")
        completed = self.jobs.process_job_step(job["id"])
        self.assertEqual(completed["status"], "READY")

        exec_row = self.router.poll(f"pjk_{job['id']}")
        self.assertEqual(exec_row["provider_id"], "wanxiang_cn_fallback")
        # User quoted_cost_fen (35 fen) is preserved even though fallback unit cost is 42 fen
        self.assertEqual(exec_row["quoted_cost_fen"], 35)
        self.assertEqual(exec_row["actual_cost_fen"], 42)

        # 3. Disconnect after provider success -> next retry recovers persisted execution without double execution
        self.router.inject_fault("seedream_cn_primary", "disconnect_after_success")
        job2, _ = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_fault_job_02",
            consent_id=self.consent["id"],
            render_request=self._base_render_request("idem_fault_job_02"),
        )
        with self.assertRaises(TimeCapsuleError) as ctx_disc:
            self.jobs.process_job_step(job2["id"])
        self.assertEqual(ctx_disc.exception.code, "PROVIDER_NETWORK_DISCONNECT")

        recovered = self.jobs.process_job_step(job2["id"])
        self.assertEqual(recovered["status"], "READY")

    def test_a04_outbox_scanner_and_a07_consent_revocation_and_a13_budget_cap(self) -> None:
        # A04: Simulate DB commit succeeding while immediate outbox dispatch failed
        job_outbox, _ = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_outbox_01",
            consent_id=self.consent["id"],
            render_request=self._base_render_request("idem_outbox_01"),
            simulate_outbox_delivery_failure=True,
        )
        self.assertEqual(job_outbox["status"], "QUEUED")
        scan_report = self.jobs.run_outbox_scanner()
        self.assertIn(job_outbox["id"], scan_report["processed_job_ids"])
        self.assertEqual(self.jobs.get_job(actor_user_id=self.user.user_id, job_id=job_outbox["id"])["status"], "READY")

        # Second outbox scan is a no-op (at-least-once delivery, idempotent consumption)
        scan_report_2 = self.jobs.run_outbox_scanner()
        self.assertEqual(scan_report_2["processed_job_ids"], [])

        # A13: Set global budget cap below current spend + next quote -> blocks before charge
        self.router.daily_global_budget_fen = 40  # Already spent 35 fen above, next quote is 35 fen -> 70 > 40
        with self.assertRaises(TimeCapsuleError) as ctx_budget:
            self.jobs.create_job(
                actor_user_id=self.user.user_id,
                idempotency_key="idem_over_budget_01",
                consent_id=self.consent["id"],
                render_request=self._base_render_request("idem_over_budget_01"),
            )
        self.assertEqual(ctx_budget.exception.code, "GLOBAL_BUDGET_CAP_EXCEEDED")

        # Raise budget cap and verify A07: revoking consent before worker runs cancels job
        self.router.daily_global_budget_fen = 5000
        job_a07, _ = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_a07_revoke",
            consent_id=self.consent["id"],
            render_request=self._base_render_request("idem_a07_revoke"),
            simulate_outbox_delivery_failure=True,
        )
        self.identity.revoke_consent(actor_user_id=self.user.user_id, consent_id=self.consent["id"])
        after_revoke = self.jobs.process_job_step(job_a07["id"])
        self.assertEqual(after_revoke["status"], "CANCELLED")
        self.assertEqual(after_revoke["error_code"], "CONSENT_REVOKED_ABORT")


if __name__ == "__main__":
    unittest.main()
