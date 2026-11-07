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

    def test_b08_builtin_portrait_templates_catalog_and_draft_optimistic_locking(self) -> None:
        templates = self.svc.list_portrait_templates(channel="mp-xhs")
        self.assertEqual(len(templates), 5)
        template_ids = [t.template_id for t in templates]
        self.assertIn("tpl_xhs_silver_halide_0_100", template_ids)
        self.assertIn("tpl_xhs_oriental_aesthetics_portrait", template_ids)
        self.assertIn("tpl_xhs_era_chronicle_documentary", template_ids)
        self.assertIn("tpl_xhs_warm_family_co_aging", template_ids)
        self.assertIn("tpl_xhs_master_fine_art_photobook", template_ids)

        # Legacy template ID alias compatibility
        legacy_resolved = self.svc.get_portrait_template("tpl_xhs_0_100_timeline")
        self.assertEqual(legacy_resolved.template_id, "tpl_xhs_silver_halide_0_100")
        self.assertEqual(legacy_resolved.optics_and_lighting.focal_length_mm, 85)
        self.assertEqual(len(legacy_resolved.age_band_recipes), 8)

        # Composition draft save & versioned update (B08-R03)
        draft_v1 = self.svc.save_composition_draft(
            draft_id="drf_001",
            tenant_id="tenant_cn_b2c",
            actor_id="act_01",
            template_id="tpl_xhs_oriental_aesthetics_portrait",
            current_age_anchor=28,
            timeline_ages=[6, 18, 28, 45, 65, 85],
            aspect_ratio="3:4",
            participant_count=1,
        )
        self.assertEqual(draft_v1.version, 1)

        draft_v2 = self.svc.save_composition_draft(
            draft_id="drf_001",
            tenant_id="tenant_cn_b2c",
            actor_id="act_01",
            template_id="tpl_xhs_oriental_aesthetics_portrait",
            current_age_anchor=30,
            timeline_ages=[18, 30, 45, 65],
            aspect_ratio="4:5",
            participant_count=1,
            expected_version=1,
        )
        self.assertEqual(draft_v2.version, 2)

        with self.assertRaises(ControlPlaneError) as stale_ctx:
            self.svc.save_composition_draft(
                draft_id="drf_001",
                tenant_id="tenant_cn_b2c",
                actor_id="act_01",
                template_id="tpl_xhs_oriental_aesthetics_portrait",
                current_age_anchor=32,
                timeline_ages=[18, 32, 65],
                expected_version=1,
            )
        self.assertEqual(stale_ctx.exception.code, "DRAFT_VERSION_CONFLICT")

    def test_b08_negative_guards_participant_limit_aspect_ratio_retired_and_minor_safety(self) -> None:
        # Exceeding solo template participant limit
        with self.assertRaises(ControlPlaneError) as part_ctx:
            self.svc.compile_project_timeline_plan(
                project_id="proj_neg_1",
                template_id="tpl_xhs_silver_halide_0_100",
                timeline_ages=[18, 28, 45],
                participant_count=2,
            )
        self.assertEqual(part_ctx.exception.code, "PARTICIPANT_COUNT_EXCEEDED")

        # Unsupported aspect ratio
        with self.assertRaises(ControlPlaneError) as ratio_ctx:
            self.svc.compile_project_timeline_plan(
                project_id="proj_neg_2",
                template_id="tpl_xhs_oriental_aesthetics_portrait",
                timeline_ages=[18, 28, 45],
                aspect_ratio="1:1",
            )
        self.assertEqual(ratio_ctx.exception.code, "UNSUPPORTED_ASPECT_RATIO")

        # Minor adultification forbidden (B08 deterministic constraint)
        with self.assertRaises(ControlPlaneError) as minor_ctx:
            self.svc.compile_project_timeline_plan(
                project_id="proj_neg_3",
                template_id="tpl_xhs_silver_halide_0_100",
                timeline_ages=[6, 18, 28],
                contains_minor=True,
                custom_notes="请使用性感成人化妆造",
            )
        self.assertEqual(minor_ctx.exception.code, "MINOR_SAFETY_POLICY_VIOLATION")

        # Retired template blocked from new compilation
        self.svc.template_engine.update_template_status(
            template_id="tpl_xhs_era_chronicle_documentary",
            new_status="retired",
            expected_row_version=1,
        )
        with self.assertRaises(ControlPlaneError) as ret_ctx:
            self.svc.compile_project_timeline_plan(
                project_id="proj_neg_4",
                template_id="tpl_xhs_era_chronicle_documentary",
                timeline_ages=[18, 28, 45],
            )
        self.assertEqual(ret_ctx.exception.code, "TEMPLATE_RETIRED")

    def test_b14_deterministic_timeline_plan_and_retroactive_childhood_disclosure(self) -> None:
        plan_a = self.svc.compile_project_timeline_plan(
            project_id="proj_det_100",
            template_id="tpl_xhs_silver_halide_0_100",
            timeline_ages=[6, 18, 28, 45, 65, 85],
            current_age_anchor=28,
            aspect_ratio="3:4",
            source_asset_ids=["asset_primary_01"],
        )
        plan_b = self.svc.compile_project_timeline_plan(
            project_id="proj_det_100",
            template_id="tpl_xhs_silver_halide_0_100",
            timeline_ages=[6, 18, 28, 45, 65, 85],
            current_age_anchor=28,
            aspect_ratio="3:4",
            source_asset_ids=["asset_primary_01"],
        )
        self.assertEqual(len(plan_a.nodes), 6)
        # Deterministic seed and prompt replayability (B14-R02 / B14-R04)
        self.assertEqual(plan_a.nodes[0].deterministic_seed, plan_b.nodes[0].deterministic_seed)
        self.assertEqual(plan_a.nodes[0].compiled_prompt, plan_b.nodes[0].compiled_prompt)

        # 6 and 18 are < current_age_anchor (28) -> retroactive simulation must be flagged (B14-R01)
        node_6 = plan_a.nodes[0]
        self.assertTrue(node_6.is_retroactive_simulation)
        self.assertIsNotNone(node_6.retroactive_disclosure)
        self.assertIn("回溯艺术创作示意", node_6.retroactive_disclosure or "")
        self.assertIn("plastic over-smoothed skin", node_6.negative_prompt)
        self.assertIn("adultified minor styling", node_6.negative_prompt)

        # 28 is at anchor -> not retroactive, highest identity lock
        node_28 = plan_a.nodes[2]
        self.assertFalse(node_28.is_retroactive_simulation)
        self.assertIsNone(node_28.retroactive_disclosure)
        self.assertGreaterEqual(node_28.identity_anchor_weight, node_6.identity_anchor_weight)

    def test_b15_quality_gate_evaluation_and_bounded_retry_routing(self) -> None:
        plan = self.svc.compile_project_timeline_plan(
            project_id="proj_qual_01",
            template_id="tpl_xhs_master_fine_art_photobook",
            timeline_ages=[28, 65],
            current_age_anchor=28,
        )
        # Passing metrics for master print template
        pass_report = self.svc.evaluate_frame_quality(
            plan_id=plan.plan_id,
            template_id=plan.template_id,
            target_age=28,
            observed_metrics={
                "identity_similarity": 0.91,
                "age_plausibility": 0.92,
                "facial_drift": 0.08,
                "pose_background_coherence": 0.93,
                "artifact_free_score": 0.96,
                "sharpness_score": 0.91,
                "aesthetic_score": 0.92,
            },
            attempt_number=1,
        )
        self.assertTrue(pass_report.passed)
        self.assertEqual(pass_report.recommended_action, "publish")

        # Low identity similarity & high facial drift -> auto-retry on attempt 1, fallback on attempt 4, manual-review on attempt 5
        fail_metrics = {
            "identity_similarity": 0.72,
            "age_plausibility": 0.89,
            "facial_drift": 0.24,
            "pose_background_coherence": 0.90,
            "artifact_free_score": 0.94,
            "sharpness_score": 0.90,
            "aesthetic_score": 0.82,
        }
        retry_report = self.svc.evaluate_frame_quality(
            plan_id=plan.plan_id,
            template_id=plan.template_id,
            target_age=65,
            observed_metrics=fail_metrics,
            attempt_number=1,
        )
        self.assertFalse(retry_report.passed)
        self.assertEqual(retry_report.recommended_action, "auto-retry")
        self.assertGreaterEqual(len(retry_report.failure_reasons), 2)

        fallback_report = self.svc.evaluate_frame_quality(
            plan_id=plan.plan_id,
            template_id=plan.template_id,
            target_age=65,
            observed_metrics=fail_metrics,
            attempt_number=4,
        )
        self.assertEqual(fallback_report.recommended_action, "fallback-provider")

        manual_report = self.svc.evaluate_frame_quality(
            plan_id=plan.plan_id,
            template_id=plan.template_id,
            target_age=65,
            observed_metrics=fail_metrics,
            attempt_number=5,
        )
        self.assertEqual(manual_report.recommended_action, "manual-review")


if __name__ == "__main__":
    unittest.main()
