from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from xhs_service import (  # noqa: E402
    AI_WATERMARK_BADGE,
    ControlPlaneError,
    ShareGrantRecord,
    XhsControlPlaneService,
)


class XhsControlPlaneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = XhsControlPlaneService()
        self.now = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)

    def test_b70_r01_xhs_session_exchange_pseudonymizes_actor_and_isolates_review_account(self) -> None:
        session = self.svc.exchange_mini_program_session(
            platform="mp-xhs",
            js_code="xhs_auth_code_998877",
            idempotency_key="idem_xhs_login_000001",
            is_review_account=False,
            now=self.now,
        )
        self.assertEqual(session.platform, "mp-xhs")
        self.assertTrue(session.actor_pseudonym.startswith("act_mp_xhs_"))
        self.assertNotIn("xhs_auth_code_998877", session.actor_pseudonym)
        self.assertEqual(session.tenant_id, "tenant_cn_b2c")

        review_session = self.svc.exchange_mini_program_session(
            platform="mp-xhs",
            js_code="xhs_reviewer_001",
            idempotency_key="idem_xhs_review_000002",
            is_review_account=True,
            now=self.now,
        )
        self.assertTrue(review_session.is_review_sandbox)
        self.assertEqual(review_session.tenant_id, "tenant_review_sandbox")
        with self.assertRaises(ControlPlaneError) as ctx:
            self.svc.assert_tenant_access(review_session, "tenant_cn_b2c")
        self.assertEqual(ctx.exception.code, "REVIEW_ACCOUNT_TENANT_FORBIDDEN")

    def test_b71_r01_r02_xhs_payment_webhook_signature_dedup_and_amount_guard(self) -> None:
        self.svc.register_server_priced_order(
            order_id="ord_xhs_1001",
            checkout_id="chk_xhs_1001",
            amount_minor=9900,
            currency="CNY",
        )
        sig = self.svc.sign_xhs_webhook_payload(
            event_id="evt_pay_001",
            out_trade_no="ord_xhs_1001",
            xhs_trade_no="xhs_tx_888",
            amount_minor=9900,
            currency="CNY",
            status="PAID",
            timestamp="1793966400",
            nonce="nonce_abc_123",
        )
        payload = {
            "event_id": "evt_pay_001",
            "out_trade_no": "ord_xhs_1001",
            "xhs_trade_no": "xhs_tx_888",
            "amount_minor": 9900,
            "currency": "CNY",
            "status": "PAID",
            "timestamp": "1793966400",
            "nonce": "nonce_abc_123",
            "signature": sig,
        }
        first = self.svc.handle_xhs_payment_webhook(payload)
        self.assertFalse(first["deduplicated"])
        self.assertEqual(first["state"], "paid")
        self.assertEqual(len(self.svc.ledger_entries), 1)

        second = self.svc.handle_xhs_payment_webhook(payload)
        self.assertTrue(second["deduplicated"])
        self.assertEqual(len(self.svc.ledger_entries), 1)

        tampered_sig = self.svc.sign_xhs_webhook_payload(
            event_id="evt_pay_002",
            out_trade_no="ord_xhs_1001",
            xhs_trade_no="xhs_tx_889",
            amount_minor=1,
            currency="CNY",
            status="PAID",
            timestamp="1793966401",
            nonce="nonce_abc_124",
        )
        with self.assertRaises(ControlPlaneError) as ctx:
            self.svc.handle_xhs_payment_webhook({
                **payload,
                "event_id": "evt_pay_002",
                "xhs_trade_no": "xhs_tx_889",
                "amount_minor": 1,
                "timestamp": "1793966401",
                "nonce": "nonce_abc_124",
                "signature": tampered_sig,
            })
        self.assertEqual(ctx.exception.code, "AMOUNT_MISMATCH")

    def test_b71_r03_xhs_note_mount_enforces_ai_watermark_and_blocks_minors_or_revoked_shares(self) -> None:
        expires = (self.now + timedelta(hours=2)).isoformat()
        self.svc.register_share_grant(
            ShareGrantRecord(
                share_id="shr_adult_01",
                artifact_ids=["job_01"],
                participant_consent_refs=["con_01", "con_02"],
                status="active",
                expires_at=expires,
                contains_minor=False,
            )
        )
        card = self.svc.create_xhs_note_mount(
            share_id="shr_adult_01",
            title="我和父母的时光合影",
            topic_tags=["AI人生时光机", "家庭合拍"],
            participant_consent_refs=["con_01", "con_02"],
            contains_minor=False,
            idempotency_key="idem_mount_adult_0001",
            now=self.now,
        )
        self.assertEqual(card.ai_watermark_badge, AI_WATERMARK_BADGE)
        self.assertTrue(card.enforced_title.startswith("【AI艺术示意】"))
        self.assertIn("ai_label=1", card.xhs_path)

        with self.assertRaises(ControlPlaneError) as minor_ctx:
            self.svc.create_xhs_note_mount(
                share_id="shr_adult_01",
                title="儿童成长记录",
                topic_tags=["亲子"],
                participant_consent_refs=["con_01", "con_02"],
                contains_minor=True,
                idempotency_key="idem_mount_minor_0002",
                now=self.now,
            )
        self.assertEqual(minor_ctx.exception.code, "MINOR_PUBLIC_MOUNT_FORBIDDEN")

        self.svc.revoke_share_grant("shr_adult_01")
        with self.assertRaises(ControlPlaneError) as rev_ctx:
            self.svc.create_xhs_note_mount(
                share_id="shr_adult_01",
                title="撤销后再次挂载",
                topic_tags=["AI人生时光机"],
                participant_consent_refs=["con_01", "con_02"],
                contains_minor=False,
                idempotency_key="idem_mount_revoked_0003",
                now=self.now,
            )
        self.assertEqual(rev_ctx.exception.code, "SHARE_NOT_ACTIVE")

    def test_state_machine_and_idempotency_replay_guards(self) -> None:
        # 1. Idempotent session exchange replay & conflict check
        s1 = self.svc.exchange_mini_program_session(
            platform="mp-weixin",
            js_code="wx_code_112233",
            idempotency_key="idem_wx_login_000010",
            now=self.now,
        )
        s2 = self.svc.exchange_mini_program_session(
            platform="mp-weixin",
            js_code="wx_code_112233",
            idempotency_key="idem_wx_login_000010",
            now=self.now + timedelta(minutes=5),
        )
        self.assertEqual(s1, s2)
        with self.assertRaises(ControlPlaneError) as conflict_ctx:
            self.svc.exchange_mini_program_session(
                platform="mp-xhs",
                js_code="wx_code_112233",
                idempotency_key="idem_wx_login_000010",
            )
        self.assertEqual(conflict_ctx.exception.code, "IDEMPOTENCY_KEY_CONFLICT")

        # 2. Prevent refunding an unpaid pending order & prevent double ledger entries on new event_id
        self.svc.register_server_priced_order(
            order_id="ord_xhs_2002",
            checkout_id="chk_xhs_2002",
            amount_minor=19900,
            currency="CNY",
        )
        refund_unpaid_sig = self.svc.sign_xhs_webhook_payload(
            event_id="evt_ref_unpaid",
            out_trade_no="ord_xhs_2002",
            xhs_trade_no="xhs_tx_2002",
            amount_minor=19900,
            currency="CNY",
            status="REFUNDED",
            timestamp="1793966500",
            nonce="nonce_ref_01",
        )
        with self.assertRaises(ControlPlaneError) as unpaid_ref_ctx:
            self.svc.handle_xhs_payment_webhook({
                "event_id": "evt_ref_unpaid",
                "out_trade_no": "ord_xhs_2002",
                "xhs_trade_no": "xhs_tx_2002",
                "amount_minor": 19900,
                "currency": "CNY",
                "status": "REFUNDED",
                "timestamp": "1793966500",
                "nonce": "nonce_ref_01",
                "signature": refund_unpaid_sig,
            })
        self.assertEqual(unpaid_ref_ctx.exception.code, "INVALID_ORDER_STATE_TRANSITION")

        paid_sig_1 = self.svc.sign_xhs_webhook_payload(
            event_id="evt_paid_2002_a",
            out_trade_no="ord_xhs_2002",
            xhs_trade_no="xhs_tx_2002",
            amount_minor=19900,
            currency="CNY",
            status="PAID",
            timestamp="1793966501",
            nonce="nonce_paid_a",
        )
        self.svc.handle_xhs_payment_webhook({
            "event_id": "evt_paid_2002_a",
            "out_trade_no": "ord_xhs_2002",
            "xhs_trade_no": "xhs_tx_2002",
            "amount_minor": 19900,
            "currency": "CNY",
            "status": "PAID",
            "timestamp": "1793966501",
            "nonce": "nonce_paid_a",
            "signature": paid_sig_1,
        })
        self.assertEqual(len(self.svc.ledger_entries), 1)

        # Second PAID webhook with different event_id must not double-post ledger entry
        paid_sig_2 = self.svc.sign_xhs_webhook_payload(
            event_id="evt_paid_2002_b",
            out_trade_no="ord_xhs_2002",
            xhs_trade_no="xhs_tx_2002",
            amount_minor=19900,
            currency="CNY",
            status="PAID",
            timestamp="1793966502",
            nonce="nonce_paid_b",
        )
        dup_paid = self.svc.handle_xhs_payment_webhook({
            "event_id": "evt_paid_2002_b",
            "out_trade_no": "ord_xhs_2002",
            "xhs_trade_no": "xhs_tx_2002",
            "amount_minor": 19900,
            "currency": "CNY",
            "status": "PAID",
            "timestamp": "1793966502",
            "nonce": "nonce_paid_b",
            "signature": paid_sig_2,
        })
        self.assertTrue(dup_paid["deduplicated"])
        self.assertEqual(len(self.svc.ledger_entries), 1)

        # Late CLOSED webhook must not overwrite paid state
        closed_sig = self.svc.sign_xhs_webhook_payload(
            event_id="evt_closed_late",
            out_trade_no="ord_xhs_2002",
            xhs_trade_no="xhs_tx_2002",
            amount_minor=19900,
            currency="CNY",
            status="CLOSED",
            timestamp="1793966503",
            nonce="nonce_closed",
        )
        late_closed = self.svc.handle_xhs_payment_webhook({
            "event_id": "evt_closed_late",
            "out_trade_no": "ord_xhs_2002",
            "xhs_trade_no": "xhs_tx_2002",
            "amount_minor": 19900,
            "currency": "CNY",
            "status": "CLOSED",
            "timestamp": "1793966503",
            "nonce": "nonce_closed",
            "signature": closed_sig,
        })
        self.assertEqual(late_closed["state"], "paid")


if __name__ == "__main__":
    unittest.main()
