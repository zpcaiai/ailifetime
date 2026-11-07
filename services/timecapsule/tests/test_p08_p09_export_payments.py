"""
Executable verification tests for Slice 5 (P08 & P09):
- P09 & A08: Server-priced orders, client price/user tamper rejection, webhook signature verification,
             100x duplicate payment callback replay & out-of-order callback handling (single entitlement grant),
             active merchant order reconciliation, refund entitlement revocation, and double-entry ledger balance.
- P08, A09 & A15: Export entitlement check, mandatory explicit + implicit GB-45438 AIGC labeling,
                  PNG -> WebP transcoding label preservation (A09), and anti-bypass export security block (A15).
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
from services.timecapsule.export_labeling import ExportLabelingService
from services.timecapsule.media_vault import MediaVaultService
from services.timecapsule.payments_entitlement import PaymentEntitlementService
from services.timecapsule.tests.test_p02_p03_catalog_media import build_test_png


class TestP08AndP09ExportPayments(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TimeCapsuleDatabase(":memory:")
        self.validator = SpecContractValidator()
        self.identity = IdentityConsentService(self.db, self.validator)
        self.catalog = CatalogService(self.db, self.validator)
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
        )
        self.payments = PaymentEntitlementService(self.db, self.identity, self.catalog)
        self.exports = ExportLabelingService(
            self.db,
            self.identity,
            self.catalog,
            self.vault,
            self.renderer,
            self.payments,
        )

        self.user = self.identity.login_or_refresh_session(wechat_code="wx_pay_user_01")
        self.consent = self.identity.record_consent(
            actor_user_id=self.user.user_id,
            subject_id="self_01",
            purpose="portrait_generation",
            policy_revision="2026.11-v1",
            evidence_ref="ev_pay_01",
        )
        raw_png = build_test_png(32, 32)
        intent = self.vault.create_upload_intent(
            actor_user_id=self.user.user_id,
            declared_media_type="image/png",
            declared_size_bytes=len(raw_png),
            declared_sha256=sha256_hex(raw_png),
        )
        self.asset = self.vault.upload_and_sanitize(
            actor_user_id=self.user.user_id,
            asset_id=intent["asset_id"],
            raw_bytes=raw_png,
        )

    def tearDown(self) -> None:
        self.db.close()

    def test_a08_100x_duplicate_and_out_of_order_payment_callbacks_and_refund_reconciliation(self) -> None:
        # Client-supplied amount or user_id is rejected
        with self.assertRaises(TimeCapsuleError) as ctx_price:
            self.payments.create_order(
                actor_user_id=self.user.user_id,
                product_id="single",
                client_supplied_amount_fen=1,
            )
        self.assertEqual(ctx_price.exception.code, "CLIENT_PRICE_FORBIDDEN")

        order = self.payments.create_order(actor_user_id=self.user.user_id, product_id="single")
        self.assertEqual(order["state"], "PENDING")
        self.assertEqual(order["amount_fen"], 990)

        sig = self.payments.sign_webhook(
            provider_event_id="wx_evt_paid_001",
            merchant_order_no=order["merchant_order_no"],
            amount_fen=990,
            currency="CNY",
            event_type="PAID",
            timestamp="2026-11-07T08:00:00Z",
            nonce="nonce_001",
        )
        payload = {
            "provider_event_id": "wx_evt_paid_001",
            "merchant_order_no": order["merchant_order_no"],
            "amount_fen": 990,
            "currency": "CNY",
            "event_type": "PAID",
            "timestamp": "2026-11-07T08:00:00Z",
            "nonce": "nonce_001",
            "signature": sig,
        }

        # Replay the exact PAID callback 100 times (A08)
        first_res = self.payments.handle_payment_webhook(payload)
        self.assertFalse(first_res["deduplicated"])
        self.assertEqual(first_res["state"], "PAID")
        self.assertIsNotNone(first_res["entitlement_id"])

        for _ in range(99):
            rep_res = self.payments.handle_payment_webhook(payload)
            self.assertTrue(rep_res["deduplicated"])
            self.assertEqual(rep_res["entitlement_id"], first_res["entitlement_id"])

        # Out-of-order CLOSED callback arriving after PAID must not downgrade PAID
        sig_closed = self.payments.sign_webhook(
            provider_event_id="wx_evt_late_closed_002",
            merchant_order_no=order["merchant_order_no"],
            amount_fen=990,
            currency="CNY",
            event_type="CLOSED",
            timestamp="2026-11-07T08:01:00Z",
            nonce="nonce_002",
        )
        res_closed = self.payments.handle_payment_webhook(
            {
                "provider_event_id": "wx_evt_late_closed_002",
                "merchant_order_no": order["merchant_order_no"],
                "amount_fen": 990,
                "currency": "CNY",
                "event_type": "CLOSED",
                "timestamp": "2026-11-07T08:01:00Z",
                "nonce": "nonce_002",
                "signature": sig_closed,
            }
        )
        self.assertEqual(res_closed["state"], "PAID")

        reconciled = self.payments.reconcile_ledger()
        self.assertTrue(reconciled["balanced"])
        self.assertEqual(reconciled["active_entitlements"], 1)
        self.assertEqual(reconciled["net_clearing_fen"], 990)

        # Refund gateway transient failure -> REFUND_FAILED -> retry -> REFUNDED & entitlement revoked
        failed_refund = self.payments.request_refund(
            actor_user_id=self.user.user_id,
            order_id=order["id"],
            simulate_gateway_failure=True,
        )
        self.assertEqual(failed_refund["state"], "REFUND_FAILED")

        completed_refund = self.payments.request_refund(
            actor_user_id=self.user.user_id,
            order_id=order["id"],
            simulate_gateway_failure=False,
        )
        self.assertEqual(completed_refund["state"], "REFUNDED")
        self.assertIsNotNone(completed_refund["entitlement"]["revoked_at"])

        reconciled_after = self.payments.reconcile_ledger()
        self.assertTrue(reconciled_after["balanced"])
        self.assertEqual(reconciled_after["active_entitlements"], 0)
        self.assertEqual(reconciled_after["net_clearing_fen"], 0)

    def test_p08_a09_transcoding_label_preservation_and_a15_anti_bypass_guard(self) -> None:
        job, _ = self.jobs.create_job(
            actor_user_id=self.user.user_id,
            idempotency_key="idem_export_job_01",
            consent_id=self.consent["id"],
            render_request={
                "template_id": "life_0_100",
                "template_version": "1.0.0",
                "style_id": "luxury",
                "fields": {"title": "时光典藏高清版", "display_name": "小忆"},
                "asset_ids": [self.asset["asset_id"]],
                "export_size": "3:4",
                "idempotency_key": "idem_export_job_01",
            },
        )
        self.jobs.process_job_step(job["id"])

        # Exporting AI template without paid entitlement fails with 402
        with self.assertRaises(TimeCapsuleError) as ctx_unpaid:
            self.exports.request_export(
                actor_user_id=self.user.user_id,
                job_id=job["id"],
                export_format="png",
                entitlement_id=None,
            )
        self.assertEqual(ctx_unpaid.exception.status_code, 402)

        # Create & settle paid order via merchant query reconciliation
        order = self.payments.create_order(actor_user_id=self.user.user_id, product_id="single")
        paid_rec = self.payments.reconcile_order_with_merchant_query(
            order_id=order["id"],
            merchant_reported_status="PAID",
            merchant_query_id="mch_query_paid_01",
        )
        entitlement_id = paid_rec["entitlement_id"]
        self.assertIsNotNone(entitlement_id)

        # A15: Attempting to remove or bypass AI synthesis label is blocked and audited
        with self.assertRaises(TimeCapsuleError) as ctx_bypass:
            self.exports.request_export(
                actor_user_id=self.user.user_id,
                job_id=job["id"],
                export_format="png",
                entitlement_id=entitlement_id,
                remove_ai_label=True,
            )
        self.assertEqual(ctx_bypass.exception.code, "AI_LABEL_REMOVAL_FORBIDDEN")

        # Valid export embeds both explicit and implicit GB-45438 draft AIGC labels
        exp = self.exports.request_export(
            actor_user_id=self.user.user_id,
            job_id=job["id"],
            export_format="png",
            entitlement_id=entitlement_id,
        )
        self.assertTrue(exp["export_label_verified"])
        self.assertEqual(exp["implicit_metadata"]["aigc_flag"], "1")

        # A09: Transcode exported PNG -> WebP and verify both explicit and implicit labels remain intact
        webp_bytes = self.exports.transcode_exported_bytes(
            source_bytes=exp["exported_bytes"],
            target_format="webp",
        )
        ver_webp = self.exports.verify_export_labels(
            exported_bytes=webp_bytes,
            export_format="webp",
            require_ai_label=True,
        )
        self.assertTrue(ver_webp["verified"])
        self.assertTrue(ver_webp["has_explicit_label"])
        self.assertEqual(ver_webp["implicit_metadata"]["content_id"], job["id"])


if __name__ == "__main__":
    unittest.main()
