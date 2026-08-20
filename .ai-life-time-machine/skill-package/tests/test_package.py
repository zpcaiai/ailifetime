from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def run(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(list(args), cwd=cwd, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        raise AssertionError(
            f"command failed ({result.returncode}): {' '.join(args)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PackageTests(unittest.TestCase):
    def test_manifest_counts_and_full_profile(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text())
        self.assertEqual(
            manifest["counts"], {"skills": 22, "batches": 128, "requirements": 640}
        )
        batches = json.loads((ROOT / "manifests/batches.json").read_text())
        skills = json.loads((ROOT / "manifests/skills.json").read_text())
        topo = json.loads((ROOT / "manifests/topological-order.json").read_text())
        full = json.loads((ROOT / "profiles/full-commercial.json").read_text())
        self.assertEqual([b["id"] for b in batches], [f"B{i:02d}" for i in range(128)])
        self.assertEqual(len(skills), 22)
        self.assertEqual(full["required_batches"], topo)
        self.assertEqual(len(full["required_batches"]), 128)

    def test_package_validator(self) -> None:
        result = run(PYTHON, str(ROOT / "scripts/validate_package.py"), "--root", str(ROOT))
        self.assertIn("PASS", result.stdout)

    def test_install_both_hosts_and_conflict_guard(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            result = run(
                PYTHON,
                str(ROOT / "scripts/install_skills.py"),
                "--target",
                str(repo),
                "--host",
                "both",
                "--profile",
                "lean-mvp",
                "--all-skills",
            )
            self.assertIn("Installation complete", result.stdout)
            self.assertEqual(len(list((repo / ".agents/skills").glob("*/SKILL.md"))), 22)
            self.assertEqual(len(list((repo / ".claude/skills").glob("*/SKILL.md"))), 22)
            self.assertTrue((repo / ".ai-life-time-machine/skill-package/manifest.json").is_file())
            conflict = run(
                PYTHON,
                str(ROOT / "scripts/install_skills.py"),
                "--target",
                str(repo),
                "--profile",
                "lean-mvp",
                check=False,
            )
            self.assertEqual(conflict.returncode, 3)
            self.assertIn("conflicts", conflict.stderr)

    def test_scaffold_full_project_and_initial_ready_batch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "commercial-project"
            result = run(
                PYTHON,
                str(ROOT / "scripts/scaffold_project.py"),
                "--target",
                str(repo),
                "--mode",
                "new",
                "--profile",
                "full-commercial",
                "--stack",
                "reference-polyglot",
                "--host",
                "both",
                "--project-name",
                "Test Time Machine",
            )
            self.assertIn("Scaffold complete", result.stdout)
            state_path = repo / ".ai-life-time-machine/state/orchestration.json"
            state = json.loads(state_path.read_text())
            self.assertEqual(state["profile_id"], "full-commercial")
            self.assertEqual(len(state["batches"]), 128)
            self.assertTrue(all(row["included"] for row in state["batches"].values()))
            self.assertEqual(state["batches"]["B00"]["state"], "ready")
            self.assertTrue((repo / "apps/consumer-web").is_dir())
            self.assertTrue((repo / "services/media-worker").is_dir())
            prompt = run(
                PYTHON,
                str(repo / ".ai-life-time-machine/skill-package/scripts/generate_batch_prompt.py"),
                "--repo",
                str(repo),
                "--batch",
                "B00",
                "--host",
                "codex",
            )
            self.assertIn("$orchestrating-life-time-machine", prompt.stdout)
            self.assertIn("B00-R01", prompt.stdout)

    def test_profile_aware_projectctl_excludes_optional_batches(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            run(
                PYTHON,
                str(ROOT / "scripts/install_skills.py"),
                "--target",
                str(repo),
                "--host",
                "codex",
                "--profile",
                "lean-mvp",
                "--all-skills",
            )
            ctl = repo / ".ai-life-time-machine/skill-package/scripts/projectctl.py"
            run(PYTHON, str(ctl), "--repo", str(repo), "init", "--profile", "lean-mvp")
            state = json.loads((repo / ".ai-life-time-machine/state/orchestration.json").read_text())
            required = set(json.loads((ROOT / "profiles/lean-mvp.json").read_text())["required_batches"])
            self.assertEqual(sum(1 for r in state["batches"].values() if r["included"]), len(required))
            excluded = next(bid for bid in state["batches"] if bid not in required)
            result = run(PYTHON, str(ctl), "--repo", str(repo), "prompt", excluded, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("excluded", result.stderr)

    def test_release_verifier_passes_and_rejects_placeholder(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            run("git", "init", cwd=repo)
            run("git", "config", "user.email", "test@example.invalid", cwd=repo)
            run("git", "config", "user.name", "Test", cwd=repo)
            (repo / "README.md").write_text("baseline\n")
            run("git", "add", ".", cwd=repo)
            run("git", "commit", "-m", "baseline", cwd=repo)
            base = run("git", "rev-parse", "HEAD", cwd=repo).stdout.strip()

            (repo / "src").mkdir()
            source = repo / "src/main.py"
            source.write_text("VALUE = 1\n")
            run("git", "add", "src/main.py", cwd=repo)
            run("git", "commit", "-m", "implement B00 fixture", cwd=repo)
            result_commit = run("git", "rev-parse", "HEAD", cwd=repo).stdout.strip()

            evidence_dir = repo / "evidence/B00"
            evidence_dir.mkdir(parents=True)
            runtime = evidence_dir / "runtime.txt"
            runtime.write_text("repository inventory and command evidence\n")
            test_artifact = evidence_dir / "unit.txt"
            test_artifact.write_text("1 passed\n")
            evidence_path = "evidence/B00/runtime.txt"
            reqs = [f"B00-R{i:02d}" for i in range(1, 6)]
            now = datetime.now(timezone.utc).isoformat()
            report = {
                "schema_version": "1.0",
                "package_version": "2.0.0",
                "batch_id": "B00",
                "status": "passed",
                "repo_root": str(repo),
                "base_commit": base,
                "result_commit": result_commit,
                "started_at": now,
                "completed_at": now,
                "agent": {"host": "human", "model": None, "session_id": "unit-test", "worktree": str(repo)},
                "dependencies": [],
                "changed_files": [{"path": "src/main.py", "change": "added"}],
                "entrypoints": ["src/main.py"],
                "contracts": [],
                "migrations": [],
                "tests": [{
                    "name": "unit-fixture",
                    "scope": "unit",
                    "command": "python3 -c 'assert True'",
                    "exit_code": 0,
                    "status": "passed",
                    "artifact": "evidence/B00/unit.txt",
                    "duration_ms": 1,
                }],
                "evidence": [{
                    "type": "runtime-capture",
                    "path": evidence_path,
                    "sha256": sha256(runtime),
                    "created_at": now,
                    "producer": "unit-test",
                    "supports": reqs,
                    "contains_sensitive_data": False,
                    "redaction": None,
                    "notes": "synthetic",
                }],
                "traceability": [{
                    "requirement_id": req,
                    "source_files": ["src/main.py"],
                    "symbols": ["VALUE"],
                    "tests": ["unit-fixture"],
                    "evidence": [evidence_path],
                    "notes": "synthetic",
                } for req in reqs],
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
            report_path = repo / "evidence/completion/B00.json"
            report_path.parent.mkdir(parents=True)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            verifier = ROOT / "scripts/verify_release.py"
            passed = run(PYTHON, str(verifier), "--repo", str(repo), "--batch", "B00", "--report", str(report_path))
            self.assertIn("PASS B00", passed.stdout)

            source.write_text("# TODO remove placeholder\nVALUE = 1\n")
            failed = run(PYTHON, str(verifier), "--repo", str(repo), "--batch", "B00", "--report", str(report_path), check=False)
            self.assertEqual(failed.returncode, 1)
            self.assertIn("placeholder", failed.stderr.lower())


if __name__ == "__main__":
    unittest.main()
