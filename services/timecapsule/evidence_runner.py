"""Independent E0-E5 Evidence Runner & Verifier for TimeCapsule (P00-P14).

Enforces Skill 10 (Independent Verification & Evidence):
- E0, E1, E2 are executed via real OS child processes (pid > 0, exit_code == 0)
  with pinned raw logs and SHA-256 digests.
- E3, E4, E5 are strictly marked BLOCKED unless real external middleware,
  vendor sandbox credentials, and physical device farm receipts are configured.
  Simulated or local SQLite/in-memory runs are NEVER marked as E3/E4/E5 PASS.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from .db_and_identity import (
    SPEC_ROOT,
    SpecContractValidator,
    sha256_hex,
    utc_now_iso,
)

REPO_ROOT = SPEC_ROOT.parents[1]


class IndependentEvidenceRunner:
    """Runs E0-E5 verification gates and produces schema-validated evidence manifests."""

    def __init__(self, repo_root: Path | None = None, output_dir: Path | None = None) -> None:
        self.repo_root = repo_root or REPO_ROOT
        self.output_dir = output_dir or (self.repo_root / "evidence" / "timecapsule")
        self.logs_dir = self.output_dir / "logs"
        self.validator = SpecContractValidator(SPEC_ROOT)
        self._git_commit_sha = self._resolve_git_commit()
        self._env_digest = self._compute_environment_digest()
        self._contract_revision = "TimeCapsule_Industrial_Skills_v1_0"

    def _resolve_git_commit(self) -> str:
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                check=True,
            )
            sha = proc.stdout.strip()
            if len(sha) >= 7:
                return sha
        except Exception:
            pass
        return "0000000"

    def _compute_environment_digest(self) -> str:
        env_fingerprint = {
            "python_version": sys.version,
            "platform": platform.platform(),
            "machine": platform.machine(),
            "repo_root": str(self.repo_root),
        }
        return "sha256:" + sha256_hex(json.dumps(env_fingerprint, sort_keys=True))

    def _run_subprocess_gate(
        self,
        *,
        level: str,
        suite: str,
        commands: list[list[str]],
        log_filename: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.logs_dir / log_filename
        combined_lines: list[str] = []
        pids: list[int] = []
        final_exit_code = 0

        env = dict(os.environ)
        env["PYTHONPATH"] = str(self.repo_root)

        for cmd in commands:
            cmd_display = " ".join(cmd)
            proc = subprocess.Popen(
                cmd,
                cwd=str(self.repo_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            pids.append(int(proc.pid))
            stdout, _ = proc.communicate(timeout=120)
            rc = int(proc.returncode or 0)
            combined_lines.append(f"=== COMMAND: {cmd_display} (PID={proc.pid}, EXIT={rc}) ===")
            combined_lines.append(stdout)
            if rc != 0:
                final_exit_code = rc
                break

        log_bytes = "\n".join(combined_lines).encode("utf-8")
        log_path.write_bytes(log_bytes)
        artifact_digest = sha256_hex(log_bytes)

        try:
            rel_log = str(log_path.relative_to(self.repo_root))
        except ValueError:
            rel_log = str(log_path)

        exec_id = f"exec_{level.lower()}_{uuid.uuid4().hex[:12]}"
        ts = utc_now_iso()
        status = "PASS" if final_exit_code == 0 else "FAIL"
        record = {
            "execution_id": exec_id,
            "level": level,
            "commit_sha": self._git_commit_sha,
            "environment_digest": self._env_digest,
            "contract_revision": self._contract_revision,
            "status": status,
            "artifact_sha256": artifact_digest,
            "timestamp": ts,
            "notes": (
                f"suite={suite}; exit_code={final_exit_code}; pids={pids}; "
                f"commands={len(commands)}; log={rel_log}"
            ),
        }
        self.validator.validate("evidence", record)
        detail = {
            "execution_id": exec_id,
            "level": level,
            "suite": suite,
            "command": " && ".join(" ".join(c) for c in commands),
            "exit_code": final_exit_code,
            "pid": pids[-1] if pids else 1,
            "child_pids": pids,
            "artifact_sha256": artifact_digest,
            "log_path": rel_log,
            "status": status,
        }
        return record, detail

    def _build_blocked_external_gate(
        self,
        *,
        level: str,
        suite: str,
        required_command: str,
        log_filename: str,
        blocker_reason: str,
        unlock_condition: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.logs_dir / log_filename
        blocker_payload = {
            "level": level,
            "status": "BLOCKED",
            "blocker_reason": blocker_reason,
            "unlock_condition": unlock_condition,
            "anti_fake_policy": "Simulated or local SQLite/in-memory runs are strictly prohibited from claiming E3/E4/E5 PASS.",
            "recorded_at": utc_now_iso(),
        }
        log_bytes = json.dumps(blocker_payload, indent=2, ensure_ascii=False).encode("utf-8")
        log_path.write_bytes(log_bytes)
        artifact_digest = sha256_hex(log_bytes)
        exec_id = f"exec_{level.lower()}_{uuid.uuid4().hex[:12]}"
        ts = utc_now_iso()
        record = {
            "execution_id": exec_id,
            "level": level,
            "commit_sha": self._git_commit_sha,
            "environment_digest": self._env_digest,
            "contract_revision": self._contract_revision,
            "status": "BLOCKED",
            "artifact_sha256": artifact_digest,
            "timestamp": ts,
            "notes": f"suite={suite} | {blocker_reason} | Unlock: {unlock_condition}",
        }
        self.validator.validate("evidence", record)
        detail = {
            "execution_id": exec_id,
            "level": level,
            "suite": suite,
            "command": required_command,
            "exit_code": 0,
            "pid": int(os.getpid()),
            "child_pids": [],
            "artifact_sha256": artifact_digest,
            "status": "BLOCKED",
            "blocker_reason": blocker_reason,
            "unlock_condition": unlock_condition,
        }
        return record, detail

    def run_all(self, include_current_runner_test: bool = False) -> dict[str, Any]:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        python_bin = sys.executable

        # E0: Static & Schema Validation
        e0_commands: list[list[str]] = [
            [python_bin, str(SPEC_ROOT / "tests" / "validate_package.py")],
            ["node", str(self.repo_root / "tools" / "verify-source.mjs")],
        ]
        zero_fake_eval = Path("/Users/stephen/DevProjects/AIProjects/elmos/certification/strict_zero_fake_industrial_evaluator.py")
        if zero_fake_eval.exists():
            e0_commands.append([python_bin, str(zero_fake_eval), str(self.repo_root / "services" / "timecapsule")])

        e0_record, e0_detail = self._run_subprocess_gate(
            level="E0",
            suite="timecapsule-static-schema-and-zero-fake-gate",
            commands=e0_commands,
            log_filename="E0-static-schema.log",
        )

        # E1: Contract & State Machine Unit Tests (P00-P04 + Spec State Machine)
        e1_commands: list[list[str]] = [
            [
                python_bin,
                "-m",
                "unittest",
                "discover",
                "-s",
                str(SPEC_ROOT / "tests"),
                "-p",
                "test_*.py",
                "-v",
            ],
            [
                python_bin,
                "-m",
                "unittest",
                str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p00_p01_identity_consent.py"),
                str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p02_p03_catalog_media.py"),
                str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p04_deterministic_renderer.py"),
                "-v",
            ],
        ]
        e1_record, e1_detail = self._run_subprocess_gate(
            level="E1",
            suite="timecapsule-contract-and-state-machine-tests",
            commands=e1_commands,
            log_filename="E1-contracts-and-state-machines.log",
        )

        # E2: Local / Hermetic Integration & Fault Injection (A01-A15, P05-P14, HTTP OpenAPI E2E)
        e2_test_files = [
            str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p05_p06_ai_and_jobs.py"),
            str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p08_p09_export_payments.py"),
            str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p10_p11_timeline_moderation.py"),
            str(self.repo_root / "services" / "timecapsule" / "tests" / "test_p07_p12_p13_p14_http_e2e.py"),
        ]
        if include_current_runner_test:
            e2_test_files.append(
                str(self.repo_root / "services" / "timecapsule" / "tests" / "test_evidence_runner.py")
            )
        e2_commands: list[list[str]] = [
            [python_bin, "-m", "unittest", *e2_test_files, "-v"]
        ]
        e2_record, e2_detail = self._run_subprocess_gate(
            level="E2",
            suite="timecapsule-hermetic-integration-and-fault-injection-A01-A15",
            commands=e2_commands,
            log_filename="E2-hermetic-integration-A01-A15.log",
        )

        # E3: Real Middleware & Storage Verification (strictly BLOCKED without external PostgreSQL + S3 + Queue cluster)
        e3_record, e3_detail = self._build_blocked_external_gate(
            level="E3",
            suite="timecapsule-real-postgres-s3-outbox-worker-verification",
            required_command="TIMECAPSULE_E3_POSTGRES_DSN=... TIMECAPSULE_E3_S3_ENDPOINT=... pytest -m e3_real_middleware",
            log_filename="E3-blocked-external-middleware.json",
            blocker_reason="Local verification uses SQLite WAL + local filesystem vault; live PostgreSQL 16 + S3/OSS + distributed worker cluster not provisioned in local sandbox.",
            unlock_condition="Provide TIMECAPSULE_E3_POSTGRES_DSN and TIMECAPSULE_E3_S3_ENDPOINT pointing to real PostgreSQL and S3/COS instances.",
        )

        # E4: External Sandbox & Provider E2E (strictly BLOCKED without real WeChat Pay merchant cert & GPU AI API keys)
        e4_record, e4_detail = self._build_blocked_external_gate(
            level="E4",
            suite="timecapsule-wechat-pay-sandbox-and-live-ai-provider-e2e",
            required_command="TIMECAPSULE_E4_WECHAT_MCH_ID=... TIMECAPSULE_E4_AI_API_KEY=... pytest -m e4_vendor_sandbox",
            log_filename="E4-blocked-vendor-sandbox.json",
            blocker_reason="Live WeChat Pay merchant APIv3 private key/certificates and external GPU model API keys (Seedream/Doubao) are not present in offline environment.",
            unlock_condition="Provision TIMECAPSULE_E4_WECHAT_MCH_ID, TIMECAPSULE_E4_WECHAT_API_V3_KEY, and TIMECAPSULE_E4_AI_API_KEY in staging environment.",
        )

        # E5: Device, Accessibility & Release Gate (strictly BLOCKED without real iOS/Android WeChat client device QA)
        e5_record, e5_detail = self._build_blocked_external_gate(
            level="E5",
            suite="timecapsule-physical-device-ios-android-wechat-release-gate",
            required_command="TIMECAPSULE_E5_DEVICE_RECEIPT_PATH=... python3 -m services.timecapsule.verify_device_release",
            log_filename="E5-blocked-physical-device-qa.json",
            blocker_reason="Physical iOS and Android WeChat client device farm execution and screen-reader manual accessibility sign-off require hardware devices.",
            unlock_condition="Attach signed physical device test receipt via TIMECAPSULE_E5_DEVICE_RECEIPT_PATH.",
        )

        gates = [e0_record, e1_record, e2_record, e3_record, e4_record, e5_record]
        details = [e0_detail, e1_detail, e2_detail, e3_detail, e4_detail, e5_detail]
        manifest = {
            "package": "TimeCapsule_Industrial_Skills_v1_0",
            "domain": "services/timecapsule",
            "slices_implemented": [
                "P00",
                "P01",
                "P02",
                "P03",
                "P04",
                "P05",
                "P06",
                "P07",
                "P08",
                "P09",
                "P10",
                "P11",
                "P12",
                "P13",
                "P14",
            ],
            "fault_scenarios_verified_in_e2": [f"A{i:02d}" for i in range(1, 16)],
            "generated_at": utc_now_iso(),
            "commit_sha": self._git_commit_sha,
            "environment_digest": self._env_digest,
            "summary": {
                "E0": e0_record["status"],
                "E1": e1_record["status"],
                "E2": e2_record["status"],
                "E3": e3_record["status"],
                "E4": e4_record["status"],
                "E5": e5_record["status"],
            },
            "evidence_records": gates,
            "execution_details": details,
        }
        manifest_path = self.output_dir / "evidence-manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return manifest


def main() -> int:
    runner = IndependentEvidenceRunner()
    manifest = runner.run_all(include_current_runner_test=True)
    print(json.dumps(manifest["summary"], indent=2, ensure_ascii=False))
    for gate in manifest["evidence_records"]:
        if gate["level"] in ("E0", "E1", "E2") and gate["status"] != "PASS":
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
