from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PRODUCT_ROOT = Path(__file__).resolve().parents[3]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FactoryFixture:
    def __init__(
        self,
        *,
        command_exit: int = 0,
        command_sleep: int = 0,
        timeout_seconds: int = 30,
        allowed_path: str = "src",
        run_gates: bool = True,
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="ltm-trusted-orchestration-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.worktree = self.root / "worktree-b00"
        self.repo.mkdir()
        self._copy_runtime()
        (self.repo / "src").mkdir()
        (self.repo / "tests").mkdir()
        (self.repo / "src/feature.py").write_text("def baseline_feature():\n    return 'base'\n", encoding="utf-8")
        (self.repo / "tests/acceptance.py").write_text(
            f"import time\ntime.sleep({command_sleep})\nprint('raw-byte-output')\nraise SystemExit({command_exit})\n",
            encoding="utf-8",
        )
        self.git("init", "-b", "main")
        self.git("config", "user.email", "factory@example.invalid")
        self.git("config", "user.name", "Factory Test")
        self.git("add", ".")
        self.git("commit", "-m", "fixture base")
        self.base_commit = self.git("rev-parse", "HEAD").stdout.strip()
        self.orchestrator = self.repo / "skills/orchestrating-life-time-machine/scripts/orchestrate_batches.py"
        self.verifier = self.repo / "skills/certifying-life-time-machine-release/scripts/verify_release.py"
        self.state_path = self.repo / ".ai-life-time-machine/state/orchestration.json"
        self.run_orchestrator("init")
        self.run_orchestrator(
            "create-worktree", "B00", "--worktree", str(self.worktree), "--branch", "feat/b00",
        )
        self.run_orchestrator(
            "start", "B00",
            "--owner", "agent-a",
            "--worktree", str(self.worktree),
            "--branch", "feat/b00",
            "--allowed-path", allowed_path,
            "--acceptance-command", '["python3","tests/acceptance.py"]',
            "--acceptance-timeout-seconds", str(timeout_seconds),
        )
        (self.worktree / "src/feature.py").write_text(
            "def implemented_feature():\n    return 'production'\n",
            encoding="utf-8",
        )
        self.git("add", "src/feature.py", cwd=self.worktree)
        self.git("commit", "-m", "implement B00", cwd=self.worktree)
        self.result_commit = self.git("rev-parse", "HEAD", cwd=self.worktree).stdout.strip()
        if not run_gates:
            self.gate_result = None
            return
        self.gate_result = self.run_orchestrator("run-gates", "B00", "--owner", "agent-a", check=False)
        self.state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.gate_reference = self.state["batches"]["B00"]["gate_receipt"]
        self.bundle_path = self.repo / self.gate_reference["path"]
        self.bundle = json.loads(self.bundle_path.read_text(encoding="utf-8"))
        self.report_path = self.repo / "evidence/completion/B00.json"
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        self.report = self._report()
        self.write_report()

    def close(self) -> None:
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "remove", "--force", str(self.worktree)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.temporary.cleanup()

    def _copy_runtime(self) -> None:
        package_source = PRODUCT_ROOT / ".ai-life-time-machine/skill-package"
        package_target = self.repo / ".ai-life-time-machine/skill-package"
        (package_target / "manifests").mkdir(parents=True)
        shutil.copy2(package_source / "manifest.json", package_target / "manifest.json")
        for name in ("batches.json", "topological-order.json"):
            shutil.copy2(package_source / "manifests" / name, package_target / "manifests" / name)
        for skill in ("certifying-life-time-machine-release", "orchestrating-life-time-machine"):
            source = PRODUCT_ROOT / "skills" / skill
            target = self.repo / "skills" / skill
            shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"))

    def git(self, *arguments: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(cwd or self.repo), *arguments],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise AssertionError(f"git {' '.join(arguments)} failed: {result.stderr}")
        return result

    def run_orchestrator(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["python3", str(self.orchestrator), "--repo", str(self.repo), *arguments],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
        if check and result.returncode != 0:
            raise AssertionError(f"orchestrator {' '.join(arguments)} failed: {result.stderr}")
        return result

    def run_verifier(self, *extra_arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3", str(self.verifier),
                "--repo", str(self.repo),
                "--batch", "B00",
                "--report", str(self.report_path),
                "--orchestration-state", str(self.state_path),
                "--receipt-index", str(self.bundle_path),
                *extra_arguments,
            ],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )

    def _report(self) -> dict:
        requirements = [f"B00-R0{index}" for index in range(1, 6)]
        command_reference = self.bundle["command_receipts"][0]
        command_receipt = json.loads((self.repo / command_reference["path"]).read_text(encoding="utf-8"))
        lease_reference = self.state["batches"]["B00"]["lease_receipt"]
        evidence_paths = [command_reference["path"], self.gate_reference["path"], lease_reference["path"]]
        created_at = self.bundle["completed_at"]
        evidence = [
            {
                "type": "command-log",
                "path": command_reference["path"],
                "sha256": command_reference["sha256"],
                "created_at": created_at,
                "producer": "trusted-orchestrator",
                "supports": requirements,
                "contains_sensitive_data": False,
                "redaction": None,
                "notes": "Actual shell-free command receipt.",
            },
            {
                "type": "command-log",
                "path": self.gate_reference["path"],
                "sha256": self.gate_reference["sha256"],
                "created_at": created_at,
                "producer": "trusted-orchestrator",
                "supports": requirements,
                "contains_sensitive_data": False,
                "redaction": None,
                "notes": "Execution receipt index.",
            },
            {
                "type": "command-log",
                "path": lease_reference["path"],
                "sha256": lease_reference["sha256"],
                "created_at": created_at,
                "producer": "trusted-orchestrator",
                "supports": requirements,
                "contains_sensitive_data": False,
                "redaction": None,
                "notes": "Immutable execution lease.",
            },
        ]
        return {
            "schema_version": "1.0",
            "package_version": "2.0.0",
            "batch_id": "B00",
            "status": "passed",
            "repo_root": str(self.repo),
            "base_commit": self.base_commit,
            "result_commit": self.result_commit,
            "started_at": self.bundle["started_at"],
            "completed_at": self.bundle["completed_at"],
            "agent": {
                "host": "codex",
                "model": None,
                "session_id": "fixture-session",
                "worktree": str(self.worktree),
            },
            "dependencies": [],
            "changed_files": [{"path": "src/feature.py", "change": "modified", "reason": "B00 implementation"}],
            "entrypoints": ["src/feature.py"],
            "contracts": [],
            "migrations": [],
            "tests": [{
                "name": "trusted-acceptance",
                "scope": "unit",
                "command": '["python3","tests/acceptance.py"]',
                "exit_code": command_receipt["exit_code"],
                "status": command_receipt["status"],
                "artifact": command_reference["path"],
                "duration_ms": command_receipt["duration_ms"],
            }],
            "evidence": evidence,
            "traceability": [{
                "requirement_id": requirement,
                "source_files": ["src/feature.py"],
                "symbols": ["implemented_feature"],
                "tests": ["trusted-acceptance"],
                "evidence": evidence_paths,
                "notes": "Fixture binding.",
            } for requirement in requirements],
            "risks": [],
            "follow_ups": [],
            "blockers": [],
            "assertions": {
                "no_placeholders": True,
                "no_skipped_required_tests": True,
                "no_fake_evidence": True,
                "no_real_customer_media": True,
                "no_secrets": True,
                "clean_room_reproducible": True,
            },
        }

    def write_report(self) -> None:
        self.report_path.write_text(json.dumps(self.report, indent=2) + "\n", encoding="utf-8")


class TrustedOrchestrationTests(unittest.TestCase):
    def test_clean_checkout_receipts_drive_finish_and_pr_stays_pending(self) -> None:
        fixture = FactoryFixture()
        self.addCleanup(fixture.close)
        self.assertEqual(fixture.gate_result.returncode, 0, fixture.gate_result.stderr)
        command_reference = fixture.bundle["command_receipts"][0]
        command_receipt = json.loads((fixture.repo / command_reference["path"]).read_text(encoding="utf-8"))
        stdout_path = fixture.repo / command_receipt["stdout"]["path"]
        self.assertEqual(stdout_path.read_bytes(), b"raw-byte-output\n")
        self.assertEqual(digest(stdout_path), command_receipt["stdout"]["sha256"])
        verified = fixture.run_verifier()
        self.assertEqual(verified.returncode, 0, verified.stderr)
        pending_certificate = fixture.repo / "evidence/release/release-certificate.json"
        pending_result = fixture.run_verifier("--issue-certificate", str(pending_certificate))
        self.assertEqual(pending_result.returncode, 3)
        certificate = json.loads(pending_certificate.read_text(encoding="utf-8"))
        self.assertEqual(certificate["status"], "EVIDENCE_PENDING")
        self.assertFalse(certificate["productionReleaseApproved"])
        self.assertEqual(certificate["externalCertification"], "NOT_CERTIFIED")
        finished = fixture.run_orchestrator(
            "finish", "B00", "--owner", "agent-a", "--report", str(fixture.report_path),
        )
        self.assertEqual(finished.returncode, 0, finished.stderr)
        pending = fixture.run_orchestrator("mark-merged", "B00", "--commit", fixture.result_commit, check=False)
        self.assertEqual(pending.returncode, 3)
        self.assertIn("EVIDENCE_PENDING", pending.stdout)
        state = json.loads(fixture.state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["batches"]["B00"]["state"], "review")
        self.assertEqual(state["batches"]["B00"]["pr_status"], "EVIDENCE_PENDING")

    def test_forged_pass_is_rejected_when_actual_command_failed(self) -> None:
        fixture = FactoryFixture(command_exit=7)
        self.addCleanup(fixture.close)
        self.assertEqual(fixture.gate_result.returncode, 1)
        fixture.report["tests"][0]["exit_code"] = 0
        fixture.report["tests"][0]["status"] = "passed"
        fixture.write_report()
        result = fixture.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertRegex(result.stderr, r"all_passed must be true|not an actual passing execution|self-reported outcome")

    def test_timeout_is_recorded_as_actual_failure(self) -> None:
        fixture = FactoryFixture(command_sleep=2, timeout_seconds=1)
        self.addCleanup(fixture.close)
        self.assertEqual(fixture.gate_result.returncode, 1)
        command_reference = fixture.bundle["command_receipts"][0]
        receipt = json.loads((fixture.repo / command_reference["path"]).read_text(encoding="utf-8"))
        self.assertTrue(receipt["timed_out"])
        self.assertEqual(receipt["exit_code"], 124)
        self.assertEqual(receipt["status"], "failed")

    def test_command_replacement_and_wrong_commit_are_rejected(self) -> None:
        fixture = FactoryFixture()
        self.addCleanup(fixture.close)
        fixture.report["tests"][0]["command"] = '["python3","tests/replaced.py"]'
        fixture.report["result_commit"] = fixture.base_commit
        fixture.write_report()
        result = fixture.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("wrong commit", result.stderr)
        self.assertIn("no exact canonical test mapping", result.stderr)

    def test_execution_lease_rejects_command_replacement_before_run(self) -> None:
        fixture = FactoryFixture(run_gates=False)
        self.addCleanup(fixture.close)
        state = json.loads(fixture.state_path.read_text(encoding="utf-8"))
        replacement = ["python3", "tests/replaced.py"]
        spec = state["batches"]["B00"]["acceptance_command_specs"][0]
        spec["argv"] = replacement
        spec["canonical_argv"] = json.dumps(replacement, ensure_ascii=False, separators=(",", ":"))
        spec["argv_sha256"] = hashlib.sha256(
            json.dumps(replacement, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        rejected = fixture.run_orchestrator("run-gates", "B00", "--owner", "agent-a", check=False)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("Execution lease field was replaced after start: acceptance_commands", rejected.stderr)

    def test_path_traversal_and_symlink_evidence_are_rejected(self) -> None:
        fixture = FactoryFixture()
        self.addCleanup(fixture.close)
        outside = fixture.root / "outside.json"
        outside.write_text("{}\n", encoding="utf-8")
        fixture.report["evidence"][0]["path"] = "../outside.json"
        fixture.write_report()
        traversed = fixture.run_verifier()
        self.assertEqual(traversed.returncode, 1)
        self.assertIn("escapes repository root", traversed.stderr)

        fixture.report = fixture._report()
        link = fixture.repo / "evidence/symlink-receipt.json"
        link.symlink_to(fixture.repo / fixture.bundle["command_receipts"][0]["path"])
        fixture.report["evidence"][0]["path"] = link.relative_to(fixture.repo).as_posix()
        fixture.write_report()
        symlinked = fixture.run_verifier()
        self.assertEqual(symlinked.returncode, 1)
        self.assertIn("symbolic link", symlinked.stderr)

    def test_dirty_worktree_and_stale_receipt_are_rejected(self) -> None:
        fixture = FactoryFixture()
        self.addCleanup(fixture.close)
        (fixture.worktree / "untracked.txt").write_text("dirty\n", encoding="utf-8")
        dirty = fixture.run_verifier()
        self.assertEqual(dirty.returncode, 1)
        self.assertIn("Worktree must be clean", dirty.stderr)
        (fixture.worktree / "untracked.txt").unlink()

        state = json.loads(fixture.state_path.read_text(encoding="utf-8"))
        state["batches"]["B00"]["execution_nonce"] = "f" * 64
        fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        stale = fixture.run_verifier()
        self.assertEqual(stale.returncode, 1)
        self.assertIn("stale", stale.stderr)

    def test_start_rejects_unregistered_and_symlink_worktrees(self) -> None:
        fixture = FactoryFixture()
        self.addCleanup(fixture.close)
        state = json.loads(fixture.state_path.read_text(encoding="utf-8"))
        state["batches"]["B00"].update({
            "state": "ready", "worktree": None, "branch": None, "lease_owner": None,
        })
        fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        unregistered = fixture.root / "not-a-worktree"
        unregistered.mkdir()
        rejected = fixture.run_orchestrator(
            "start", "B00", "--owner", "agent-b", "--worktree", str(unregistered),
            "--branch", "feat/other", "--allowed-path", "src",
            check=False,
        )
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("registered Git worktree", rejected.stderr)

        link = fixture.root / "worktree-link"
        link.symlink_to(fixture.worktree, target_is_directory=True)
        symlinked = fixture.run_orchestrator(
            "start", "B00", "--owner", "agent-b", "--worktree", str(link),
            "--branch", "feat/b00", "--allowed-path", "src",
            check=False,
        )
        self.assertEqual(symlinked.returncode, 1)
        self.assertIn("symbolic link", symlinked.stderr)

    def test_run_gates_rejects_committed_diff_outside_owned_paths(self) -> None:
        fixture = FactoryFixture(allowed_path="docs", run_gates=False)
        self.addCleanup(fixture.close)
        rejected = fixture.run_orchestrator("run-gates", "B00", "--owner", "agent-a", check=False)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("outside the lease", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
