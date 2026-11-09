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
        self.assertEqual(len(templates), 10)
        template_ids = [t.template_id for t in templates]
        self.assertIn("tpl_xhs_silver_halide_0_100", template_ids)
        self.assertIn("tpl_xhs_oriental_aesthetics_portrait", template_ids)
        self.assertIn("tpl_xhs_era_chronicle_documentary", template_ids)
        self.assertIn("tpl_xhs_warm_family_co_aging", template_ids)
        self.assertIn("tpl_xhs_master_fine_art_photobook", template_ids)
        self.assertIn("tpl_xhs_cinematic_wong_kar_wai", template_ids)
        self.assertIn("tpl_xhs_three_generations_heirloom", template_ids)
        self.assertIn("tpl_xhs_vogue_editorial_bw", template_ids)
        self.assertIn("tpl_xhs_24_solar_terms_poetic", template_ids)
        self.assertIn("tpl_xhs_world_landmarks_50_global", template_ids)

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

    def test_timecapsule_12_categories_20_templates_100_combinations_and_labeled_export(self) -> None:
        catalog = self.svc.list_timecapsule_catalog()
        self.assertEqual(len(catalog["categories"]), 12)
        self.assertEqual(len(catalog["styles"]), 5)
        self.assertEqual(len(catalog["templates"]), 20)
        self.assertEqual(catalog["combination_count"], 100)

        png_export = self.svc.render_and_export_timecapsule_card(
            template_id="life_0_100",
            style_id="retro",
            fields={
                "title": "人生0-100岁时光纪念",
                "subtitle": "愿每一程都有温暖相伴",
                "event_date": "2026-11-07",
                "display_name": "林小满",
            },
            output_format="png",
        )
        self.assertTrue(png_export["ai_label_verification"]["verified"])
        self.assertTrue(png_export["ai_label_verification"]["has_explicit_label"])
        self.assertEqual(png_export["output_format"], "png")

        webp_export = self.svc.render_and_export_timecapsule_card(
            template_id="life_0_100",
            style_id="luxury",
            fields={
                "title": "人生0-100岁时光纪念",
                "subtitle": "愿每一程都有温暖相伴",
                "event_date": "2026-11-07",
                "display_name": "林小满",
            },
            output_format="webp",
        )
        self.assertTrue(webp_export["ai_label_verification"]["verified"])
        self.assertTrue(webp_export["ai_label_verification"]["has_explicit_label"])
        self.assertEqual(webp_export["output_format"], "webp")

    def test_v22_every_template_has_at_least_9_curated_shots_and_physiological_era_matrix(self) -> None:
        templates = self.svc.list_portrait_templates(channel="mp-xhs")
        self.assertEqual(len(templates), 10)
        for tpl in templates:
            self.assertIn(tpl.version, ("2.3.0", "2.4.0"))
            self.assertGreaterEqual(tpl.min_curated_shots, 9)
            self.assertGreaterEqual(len(tpl.recommended_ages), 9)
            self.assertEqual(len(tpl.recommended_ages), 10)
            self.assertGreaterEqual(len(tpl.curated_gallery_shots), 9)
            self.assertEqual(len(tpl.curated_gallery_shots), 10)
            default_selected_shots = [s for s in tpl.curated_gallery_shots if s.default_selected]
            self.assertEqual(len(default_selected_shots), 9)
            # Verify multi-crop storyboard rhythm across the 10 curated shots
            scales = {s.shot_scale for s in tpl.curated_gallery_shots}
            self.assertEqual(
                scales,
                {"extreme_closeup_eyes", "medium_bust", "three_quarter_profile", "half_body_hands"},
            )
            center_heroes = [s for s in tpl.curated_gallery_shots if s.nine_grid_position == "center_hero"]
            self.assertEqual(len(center_heroes), 1)
            self.assertEqual(center_heroes[0].shot_index, 5)

        # Compile era chronicle plan with explicit birth_year=1992 across all 10 recommended ages
        era_plan = self.svc.compile_project_timeline_plan(
            project_id="proj_era_1992",
            template_id="tpl_xhs_era_chronicle_documentary",
            current_age_anchor=32,
            birth_year=1992,
        )
        self.assertEqual(era_plan.birth_year, 1992)
        self.assertEqual(len(era_plan.nodes), 10)

        by_age = {n.target_age: n for n in era_plan.nodes}
        # 6岁 (1998年): high craniofacial neoteny (0.90) & crystal-clear catchlights (0.98)
        node_6 = by_age[6]
        self.assertEqual(node_6.era_context.calendar_year, 1998)
        self.assertIn("1990年代", node_6.era_context.decade_label)
        self.assertAlmostEqual(node_6.physiological_weights.craniofacial_neoteny_weight, 0.90, places=2)
        self.assertAlmostEqual(node_6.physiological_weights.eye_catchlight_clarity, 0.98, places=2)

        # 45岁 (2037年): taut mandibular contour (collagen=0.78) & capped nasolabial depth (<=0.28)
        node_45 = by_age[45]
        self.assertEqual(node_45.era_context.calendar_year, 2037)
        self.assertAlmostEqual(node_45.physiological_weights.dermal_collagen_elasticity, 0.78, places=2)
        self.assertLessEqual(node_45.physiological_weights.nasolabial_fold_depth_limit, 0.28)

        # 72岁 & 85岁: natural silver hair strand ratio & gentle nasolabial progression
        node_72 = by_age[72]
        node_85 = by_age[85]
        self.assertGreater(node_72.physiological_weights.silver_strand_ratio, 0.70)
        self.assertGreater(node_85.physiological_weights.silver_strand_ratio, node_72.physiological_weights.silver_strand_ratio)
        self.assertGreater(node_85.physiological_weights.age_spot_micro_density, 0.40)

        # Master photobook template compiles 3mm print bleed and CMYK ICC profile
        print_plan = self.svc.compile_project_timeline_plan(
            project_id="proj_print_01",
            template_id="tpl_xhs_master_fine_art_photobook",
            current_age_anchor=28,
            birth_year=1998,
        )
        self.assertEqual(print_plan.nodes[0].provider_payload.print_bleed_mm, 3)
        self.assertEqual(print_plan.nodes[0].provider_payload.cmyk_profile, "ISOcoated_v2_300_eci.icc")

    def test_v22_multi_provider_curated_gallery_generation_auto_healing_and_selection_lock(self) -> None:
        # Inject an initial low-quality frame at age 45 to verify B15 auto-retry healing in gallery run
        gallery_run = self.svc.generate_curated_gallery_candidates(
            project_id="proj_gal_001",
            template_id="tpl_xhs_oriental_aesthetics_portrait",
            current_age_anchor=28,
            birth_year=1998,
            injected_initial_metrics_by_age={
                45: {
                    "identity_similarity": 0.71,
                    "age_plausibility": 0.88,
                    "facial_drift": 0.22,
                    "pose_background_coherence": 0.90,
                    "artifact_free_score": 0.92,
                    "sharpness_score": 0.89,
                    "aesthetic_score": 0.90,
                }
            },
        )
        self.assertEqual(gallery_run.total_candidates, 10)
        self.assertEqual(gallery_run.passed_candidates, 10)
        self.assertTrue(gallery_run.ready_for_curation)
        self.assertEqual(len(gallery_run.default_selected_shot_ids), 9)

        cand_45 = [c for c in gallery_run.candidates if c.target_age == 45][0]
        self.assertEqual(cand_45.attempts_used, 2)
        self.assertTrue(cand_45.quality_passed)

        # Reject selection with fewer than 9 shots
        with self.assertRaises(ControlPlaneError) as small_ctx:
            self.svc.save_curated_gallery_selection(
                selection_id="sel_001",
                gallery_id=gallery_run.gallery_id,
                actor_id="act_01",
                selected_shot_ids=gallery_run.default_selected_shot_ids[:6],
                export_mode="xhs_9_grid",
            )
        self.assertEqual(small_ctx.exception.code, "CURATED_SELECTION_TOO_SMALL")

        # Save 9-shot selection for Xiaohongshu 9-grid
        sel_v1 = self.svc.save_curated_gallery_selection(
            selection_id="sel_001",
            gallery_id=gallery_run.gallery_id,
            actor_id="act_01",
            selected_shot_ids=gallery_run.default_selected_shot_ids,
            export_mode="xhs_9_grid",
        )
        self.assertEqual(sel_v1.selected_count, 9)
        self.assertEqual(sel_v1.version, 1)

        # Update to all 10 shots for 99 RMB hardcover photobook with optimistic lock
        all_10_ids = [c.shot_id for c in gallery_run.candidates]
        sel_v2 = self.svc.save_curated_gallery_selection(
            selection_id="sel_001",
            gallery_id=gallery_run.gallery_id,
            actor_id="act_01",
            selected_shot_ids=all_10_ids,
            export_mode="photobook_hardcover",
            expected_version=1,
        )
        self.assertEqual(sel_v2.selected_count, 10)
        self.assertEqual(sel_v2.photobook_sku, "PHOTO_BOOK_HARDCOVER_0_100")
        self.assertEqual(sel_v2.version, 2)

    def test_v23_pillars_1_2_3_nine_templates_multi_anchor_4stage_quality_and_20page_photobook_preflight(self) -> None:
        # Pillar I & III: Compile Wong Kar-Wai cinema template with 45-deg side profile + childhood dual anchor
        wkw_gal = self.svc.generate_curated_gallery_candidates(
            project_id="proj_wkw_2046",
            template_id="tpl_xhs_cinematic_wong_kar_wai",
            current_age_anchor=28,
            birth_year=1998,
            source_asset_ids=["asset_adult_frontal_01"],
            side_profile_asset_id="asset_side_profile_45deg",
            childhood_reference_asset_id="asset_childhood_6yo_photo",
            childhood_reference_age=6,
        )
        self.assertEqual(wkw_gal.total_candidates, 10)
        self.assertEqual(wkw_gal.passed_candidates, 10)

        cand_6 = [c for c in wkw_gal.candidates if c.target_age == 6][0]
        cand_25 = [c for c in wkw_gal.candidates if c.target_age == 25][0]
        # Verify childhood dual anchor boosts childhood node (childhood_anchor_weight=0.72) and 3D profile boost (0.22)
        anchor_6 = cand_6.image_enhancement_pipeline["multi_photo_anchor"]
        self.assertTrue(anchor_6["dual_anchor_active"])
        self.assertAlmostEqual(anchor_6["childhood_anchor_weight"], 0.72, places=2)
        self.assertAlmostEqual(anchor_6["profile_3d_depth_boost"], 0.22, places=2)

        # Verify 4-stage physical pipeline on Wong Kar-Wai 25yo hero shot
        pipe_25 = cand_25.image_enhancement_pipeline
        self.assertEqual(cand_25.nine_grid_position, "center_hero")
        self.assertEqual(pipe_25["relighting_pass"]["color_temp_kelvin"], 3200)
        self.assertIn("vellus_facial_fuzz", pipe_25["frequency_separated_skin_pass"]["micro_features_injected"])
        self.assertGreater(pipe_25["optical_post_process"]["halation_strength"], 0.30)

        # Verify Three Generations Heirloom template supports up to 4 participants
        heirloom_plan = self.svc.compile_project_timeline_plan(
            project_id="proj_3gen_01",
            template_id="tpl_xhs_three_generations_heirloom",
            participant_count=4,
            current_age_anchor=32,
            birth_year=1994,
        )
        self.assertEqual(heirloom_plan.participant_count, 4)
        self.assertEqual(heirloom_plan.nodes[0].provider_payload.print_bleed_mm, 3)

        # Pillar II: Save 10-shot selection and compile 20-page (10 layflat spreads) hardcover photobook
        sel = self.svc.save_curated_gallery_selection(
            selection_id="sel_photobook_20p",
            gallery_id=wkw_gal.gallery_id,
            actor_id="act_01",
            selected_shot_ids=[c.shot_id for c in wkw_gal.candidates],
            export_mode="photobook_hardcover",
        )
        manifest_v1 = self.svc.compile_photobook_layout_manifest(
            manifest_id="pb_manifest_001",
            selection_id=sel.selection_id,
            gallery_id=wkw_gal.gallery_id,
            actor_id="act_01",
            title="《流金岁月 · 0–100岁典藏画册》",
        )
        self.assertEqual(manifest_v1.page_count, 20)
        self.assertEqual(manifest_v1.spread_count, 10)
        self.assertEqual(len(manifest_v1.spreads), 10)
        self.assertTrue(manifest_v1.vellum_frontispiece_enabled)
        self.assertTrue(manifest_v1.gold_foil_emboss_enabled)
        self.assertEqual(manifest_v1.spreads[0].layout_archetype, "vellum_gold_foil_frontispiece")
        self.assertEqual(manifest_v1.spreads[3].layout_archetype, "gatefold_childhood_vs_prime_comparison")
        self.assertEqual(manifest_v1.spreads[9].layout_archetype, "acoustic_voiceprint_colophon_spread")
        self.assertEqual(len(manifest_v1.acoustic_colophon.voiceprint_bars), 32)
        self.assertTrue(manifest_v1.acoustic_colophon.qr_whitelisted)
        self.assertTrue(manifest_v1.preflight_report.preflight_passed)
        self.assertLessEqual(manifest_v1.preflight_report.max_cmyk_tac_percent, 300.0)
        self.assertAlmostEqual(manifest_v1.preflight_report.shadow_gamma_lift, 1.135, places=3)
        self.assertEqual(manifest_v1.preflight_report.gutter_face_collisions, 0)

        # Negative test 1: Reject face bounding box crossing center spine gutter [198.0, 222.0] mm
        with self.assertRaises(ControlPlaneError) as gutter_ctx:
            self.svc.compile_photobook_layout_manifest(
                manifest_id="pb_manifest_bad_gutter",
                selection_id=sel.selection_id,
                gallery_id=wkw_gal.gallery_id,
                actor_id="act_01",
                custom_face_bbox_override_mm=(190.0, 215.0),
            )
        self.assertEqual(gutter_ctx.exception.code, "GUTTER_FACE_COLLISION_FORBIDDEN")

        # Negative test 2: Reject CMYK Total Area Coverage > 300%
        with self.assertRaises(ControlPlaneError) as tac_ctx:
            self.svc.compile_photobook_layout_manifest(
                manifest_id="pb_manifest_bad_tac",
                selection_id=sel.selection_id,
                gallery_id=wkw_gal.gallery_id,
                actor_id="act_01",
                custom_cmyk_tac_override=318.0,
            )
        self.assertEqual(tac_ctx.exception.code, "CMYK_TAC_LIMIT_EXCEEDED")

        # Negative test 3: Reject non-whitelisted QR code domain
        with self.assertRaises(ControlPlaneError) as qr_ctx:
            self.svc.compile_photobook_layout_manifest(
                manifest_id="pb_manifest_bad_qr",
                selection_id=sel.selection_id,
                gallery_id=wkw_gal.gallery_id,
                actor_id="act_01",
                voice_qr_url="https://phishing.example.com/audio",
            )
        self.assertEqual(qr_ctx.exception.code, "UNSAFE_VOICE_QR_DOMAIN")

    def test_v24_world_landmarks_50_catalog_and_user_photo_synthesis(self) -> None:
        # 1. Verify 5 global geographic regions and 100 distinct world landmark templates (20 per region)
        regions = self.svc.list_world_landmark_regions()
        self.assertEqual(len(regions), 5)
        all_landmarks = self.svc.list_world_landmarks()
        self.assertEqual(len(all_landmarks), 100)

        for r in regions:
            reg_landmarks = self.svc.list_world_landmarks(region_id=r["region_id"])
            self.assertEqual(len(reg_landmarks), 20)
            for lmk in reg_landmarks:
                self.assertTrue(lmk.reference_photo_uri.startswith("https://cdn.ailifetime.cn/landmarks/100/"))
                self.assertGreater(lmk.ground_contact_shadow_opacity, 0.70)
                self.assertTrue(lmk.unesco_code.startswith("UNESCO-"))

        # 2. Verify dedicated world-landmarks category in PortraitTemplateEngine
        landmark_tpl = self.svc.get_portrait_template("tpl_xhs_world_landmarks_50_global")
        self.assertEqual(landmark_tpl.category, "world-landmarks")
        self.assertEqual(landmark_tpl.version, "2.4.0")
        self.assertEqual(len(landmark_tpl.curated_gallery_shots), 10)

        # 3. Synthesize user's uploaded photo across all 100 world landmarks with 45-deg side profile 3D anchor
        run_100 = self.svc.synthesize_user_at_world_landmarks(
            project_id="proj_world_100_tour",
            actor_id="act_traveler_01",
            source_asset_ids=["asset_user_frontal_selfie_01"],
            side_profile_asset_id="asset_user_side_45deg_01",
            target_age=28,
            aspect_ratio="3:4",
            participant_count=2,
            custom_wardrobe_note="情侣浅色亚麻旅拍穿搭",
        )
        self.assertEqual(run_100.total_landmarks, 100)
        self.assertEqual(run_100.passed_landmarks, 100)
        self.assertEqual(len(run_100.items), 100)

        first_item = run_100.items[0]
        mid_item = run_100.items[50]
        last_item = run_100.items[99]
        self.assertEqual(first_item.landmark_id, "lmk_001_forbidden_city_taihedian")
        self.assertEqual(mid_item.landmark_id, "lmk_051_jiuzhaigou_five_flower_lake")
        self.assertEqual(last_item.landmark_id, "lmk_100_svalbard_arctic_blue_glacier")
        self.assertIn("IC-Light IBL", first_item.relighting_ibl_summary)
        self.assertIn("足底接触阴影", first_item.ground_shadow_and_haze_summary)
        self.assertIn("AI合成每刻·世界名胜实景旅拍艺术示意", first_item.ai_watermark_text)
        self.assertGreaterEqual(first_item.identity_similarity, 0.93)

        # 4. Synthesize specific region (20 landmarks) or custom 9-grid landmark selection
        china_run = self.svc.synthesize_user_at_world_landmarks(
            project_id="proj_china_20",
            source_asset_ids=["asset_user_frontal_selfie_01"],
            region_id="china_oriental_heritage",
        )
        self.assertEqual(china_run.total_landmarks, 20)

        # 5. Negative guard: missing source photo or invalid landmark ID
        with self.assertRaises(ControlPlaneError) as missing_ctx:
            self.svc.synthesize_user_at_world_landmarks(
                project_id="proj_bad_photo",
                source_asset_ids=[],
            )
        self.assertEqual(missing_ctx.exception.code, "MISSING_SOURCE_PHOTO")

        with self.assertRaises(ControlPlaneError) as not_found_ctx:
            self.svc.get_world_landmark("lmk_999_atlantis")
        self.assertEqual(not_found_ctx.exception.code, "LANDMARK_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
