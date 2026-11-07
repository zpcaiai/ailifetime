"""Unit & Integration Tests for IndependentEvidenceRunner (Skill 10 E0-E5 Matrix)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from services.timecapsule.db_and_identity import SPEC_ROOT, SpecContractValidator
from services.timecapsule.evidence_runner import IndependentEvidenceRunner


class TestIndependentEvidenceRunner(unittest.TestCase):
    def test_e0_e5_evidence_generation_and_schema_compliance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "evidence"
            runner = IndependentEvidenceRunner(output_dir=out_dir)
            manifest = runner.run_all(include_current_runner_test=False)

            self.assertEqual(manifest["summary"]["E0"], "PASS")
            self.assertEqual(manifest["summary"]["E1"], "PASS")
            self.assertEqual(manifest["summary"]["E2"], "PASS")
            # Anti-fake invariant: local runs must never mark E3/E4/E5 as PASS
            self.assertEqual(manifest["summary"]["E3"], "BLOCKED")
            self.assertEqual(manifest["summary"]["E4"], "BLOCKED")
            self.assertEqual(manifest["summary"]["E5"], "BLOCKED")

            validator = SpecContractValidator(SPEC_ROOT)
            for record in manifest["evidence_records"]:
                validator.validate("evidence", record)
                self.assertEqual(len(record["artifact_sha256"]), 64)

            for detail in manifest["execution_details"]:
                self.assertGreater(detail["pid"], 0)
                self.assertEqual(detail["exit_code"], 0)
                if detail["level"] in ("E0", "E1", "E2"):
                    self.assertGreater(len(detail["child_pids"]), 0)

            manifest_file = out_dir / "evidence-manifest.json"
            self.assertTrue(manifest_file.exists())
            parsed = json.loads(manifest_file.read_text(encoding="utf-8"))
            self.assertEqual(len(parsed["slices_implemented"]), 15)
            self.assertEqual(len(parsed["fault_scenarios_verified_in_e2"]), 15)


if __name__ == "__main__":
    unittest.main()
