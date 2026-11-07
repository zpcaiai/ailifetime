"""Unit & Integration Tests for IndependentEvidenceRunner & E4/E5 Harnesses (Skill 10 E0-E5 Matrix)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from services.timecapsule.db_and_identity import SPEC_ROOT, SpecContractValidator
from services.timecapsule.e4_e5_verification_harnesses import (
    run_e4_pre_flight_and_crypto_suite,
    run_e5_bundle_wcag_and_device_gate,
)
from services.timecapsule.evidence_runner import IndependentEvidenceRunner


class TestIndependentEvidenceRunner(unittest.TestCase):
    def test_e4_wechat_apiv3_rsa2048_aes256gcm_and_glyph_inspector(self) -> None:
        e4 = run_e4_pre_flight_and_crypto_suite()
        self.assertTrue(e4["local_crypto_and_glyph_verified"])
        self.assertTrue(e4["wechat_rsa2048_sha256_verified"])
        self.assertEqual(e4["wechat_aes256_gcm_decrypted_out_trade_no"], "tc_ord_e4_001")
        self.assertTrue(e4["glyph_and_dual_label_report"]["passed"])
        self.assertEqual(e4["glyph_and_dual_label_report"]["missing_codepoints"], [])
        self.assertEqual(e4["overall_e4_status"], "BLOCKED")

    def test_e5_compiled_mini_program_bundle_and_wcag_contrast_ratios(self) -> None:
        e5 = run_e5_bundle_wcag_and_device_gate()
        self.assertTrue(e5["local_bundle_and_wcag_verified"])
        self.assertTrue(e5["wcag_report"]["wcag_aa_passed"])
        self.assertTrue(e5["bundle_report"]["all_bundles_valid"])
        self.assertEqual(e5["overall_e5_status"], "BLOCKED")

    def test_e0_e5_evidence_generation_and_schema_compliance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "evidence"
            runner = IndependentEvidenceRunner(output_dir=out_dir)
            manifest = runner.run_all(include_current_runner_test=False)

            self.assertEqual(manifest["summary"]["E0"], "PASS")
            self.assertEqual(manifest["summary"]["E1"], "PASS")
            self.assertEqual(manifest["summary"]["E2"], "PASS")
            self.assertEqual(manifest["summary"]["E3"], "PASS")
            # Anti-fake invariant: without external live keys/device receipt, E4/E5 stay BLOCKED
            self.assertEqual(manifest["summary"]["E4"], "BLOCKED")
            self.assertEqual(manifest["summary"]["E5"], "BLOCKED")

            validator = SpecContractValidator(SPEC_ROOT)
            for record in manifest["evidence_records"]:
                validator.validate("evidence", record)
                self.assertEqual(len(record["artifact_sha256"]), 64)

            for detail in manifest["execution_details"]:
                self.assertGreater(detail["pid"], 0)
                self.assertEqual(detail["exit_code"], 0)
                if detail["level"] in ("E0", "E1", "E2", "E3"):
                    self.assertGreater(len(detail["child_pids"]), 0)

            manifest_file = out_dir / "evidence-manifest.json"
            self.assertTrue(manifest_file.exists())
            parsed = json.loads(manifest_file.read_text(encoding="utf-8"))
            self.assertEqual(len(parsed["slices_implemented"]), 15)
            self.assertEqual(len(parsed["fault_scenarios_verified_in_e2"]), 15)


if __name__ == "__main__":
    unittest.main()
