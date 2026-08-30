#!/usr/bin/env python3
"""Deterministically coordinate B00-B127 across Claude Code/Codex worktrees."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

TRUSTED_EXECUTION_PATH = Path(__file__).resolve().parents[2] / "certifying-life-time-machine-release" / "scripts"
if str(TRUSTED_EXECUTION_PATH) not in sys.path:
    sys.path.insert(0, str(TRUSTED_EXECUTION_PATH))

from trusted_execution import (  # noqa: E402
    BUNDLE_SCHEMA,
    ENVIRONMENT_POLICY,
    RECEIPT_SCHEMA,
    TrustError,
    argv_sha256,
    atomic_write_bytes,
    canonical_json_bytes,
    changed_files,
    clean_environment,
    command_spec,
    commit_tree,
    ensure_output_directory,
    git as trusted_git,
    git_text,
    is_ancestor,
    repository_path,
    resolve_commit,
    resolve_executable,
    sha256_bytes,
    sha256_file,
    validate_worktree,
)

def package_root() -> Path:
    script = Path(__file__).resolve()
    for ancestor in script.parents:
        for candidate in (ancestor, ancestor / ".ai-life-time-machine/skill-package"):
            if (candidate / "manifest.json").is_file() and (candidate / "manifests/batches.json").is_file():
                return candidate
    raise RuntimeError("AI Life Time Machine skill package could not be located from this repository")


PACKAGE_ROOT = package_root()
PACKAGE_MANIFEST = json.loads((PACKAGE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BATCHES = json.loads((PACKAGE_ROOT / "manifests/batches.json").read_text(encoding="utf-8"))
BY_ID = {item["id"]: item for item in BATCHES}
TOPO = json.loads((PACKAGE_ROOT / "manifests/topological-order.json").read_text(encoding="utf-8"))
DONE_STATES = {"merged", "factory_attested"}
ORCHESTRATOR = Path(__file__).resolve()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def git_output(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def atomic_json(path: Path, payload: dict) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError(f"Refusing to write orchestration data through a symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    os.replace(temp, path)


@contextlib.contextmanager
def lock_state(path: Path, timeout_seconds: float = 10.0) -> Iterator[None]:
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError(f"Refusing orchestration state through a symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(path.suffix + ".lock")
    deadline = time.monotonic() + timeout_seconds
    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timed out waiting for state lock: {lock}")
            time.sleep(0.1)
    try:
        os.write(fd, f"pid={os.getpid()} created={now()}\n".encode())
        yield
    finally:
        os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            lock.unlink()


def load_state(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(f"State not initialized: {path}. Run `init` first.")
    if path.is_symlink():
        raise RuntimeError(f"Orchestration state must not be a symlink: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("batches"), dict):
        raise RuntimeError("Orchestration state is malformed")
    return payload


def parse_time(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"{label} must be an ISO date-time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError(f"{label} is not a valid ISO date-time") from exc
    if parsed.tzinfo is None:
        raise RuntimeError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def owned_path(repo: Path, value: str) -> str:
    candidate = Path(value)
    if candidate.is_absolute() or not value.strip():
        raise RuntimeError(f"Owned path must be a non-empty repository-relative path: {value!r}")
    resolved = (repo / candidate).resolve()
    try:
        relative = resolved.relative_to(repo)
    except ValueError as exc:
        raise RuntimeError(f"Owned path escapes repository: {value}") from exc
    normalized = relative.as_posix().rstrip("/")
    if normalized in {"", "."}:
        raise RuntimeError("Repository root cannot be claimed as an owned path")
    return normalized


def paths_overlap(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def assert_path_ownership_available(state: dict, batch_id: str, paths: list[str]) -> None:
    for other_id, other in state["batches"].items():
        if other_id == batch_id or other.get("state") != "running":
            continue
        for requested in paths:
            for claimed in other.get("allowed_paths") or []:
                if paths_overlap(requested, claimed):
                    raise RuntimeError(
                        f"Owned path conflict: {requested} overlaps {other_id}:{claimed}; serialize the work or change ownership"
                    )


def assert_lease_owner(record: dict, owner: str, batch_id: str) -> None:
    if record.get("lease_owner") != owner:
        raise RuntimeError(f"{batch_id} lease is owned by {record.get('lease_owner')!r}, not {owner!r}")


def assert_report_paths(repo: Path, record: dict, report: Path) -> None:
    payload = json.loads(report.read_text(encoding="utf-8"))
    allowed = record.get("allowed_paths") or []
    if not allowed:
        raise RuntimeError("Running Batch has no declared allowed_paths")
    violations: list[str] = []
    for item in payload.get("changed_files", []):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise RuntimeError("Completion report contains an invalid changed_files entry")
        path = owned_path(repo, item["path"])
        if not any(paths_overlap(path, prefix) and (path == prefix or path.startswith(prefix + "/")) for prefix in allowed):
            violations.append(path)
    if violations:
        raise RuntimeError(f"Completion report changed files outside the lease: {sorted(violations)}")


def path_is_owned(path: str, allowed: list[str]) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in allowed)


def assert_owned_diff(repo: Path, record: dict, base_commit: str, result_commit: str) -> list[dict[str, str]]:
    allowed = record.get("allowed_paths") or []
    if not allowed:
        raise RuntimeError("Running Batch has no declared allowed_paths")
    actual = changed_files(repo, base_commit, result_commit)
    if not actual:
        raise RuntimeError("Passing implementation Batch must contain a committed diff")
    violations: list[str] = []
    for item in actual:
        for value in (item.get("old_path"), item.get("path")):
            if value is None:
                continue
            normalized = owned_path(repo, value)
            if not path_is_owned(normalized, allowed):
                violations.append(normalized)
    if violations:
        raise RuntimeError(f"Committed diff contains files outside the lease: {sorted(set(violations))}")
    return actual


def assert_branch_name(repo: Path, branch: str) -> None:
    if not branch.strip() or any(character.isspace() for character in branch):
        raise RuntimeError("--branch must be non-empty and cannot contain whitespace")
    result = trusted_git(repo, "check-ref-format", "--branch", branch)
    if result.returncode != 0:
        raise RuntimeError(f"Invalid Git branch name: {branch}")


def receipt_relative_path(repo: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError as exc:
        raise RuntimeError(f"Receipt escaped coordinator repository: {path}") from exc


def create_execution_lease(
    repo: Path,
    *,
    batch_id: str,
    nonce: str,
    owner: str,
    worktree: Path,
    branch: str,
    base_commit: str,
    allowed_paths: list[str],
    shared_contracts: list[str],
    command_specs: list[dict[str, Any]],
    timeout_seconds: int,
    started_at: str,
    expires_at: str,
) -> dict[str, Any]:
    relative_directory = f"evidence/{batch_id}/leases"
    ensure_output_directory(repo, relative_directory)
    payload = {
        "schema_version": "ltm.execution-lease.v1",
        "batch_id": batch_id,
        "execution_nonce": nonce,
        "owner": owner,
        "worktree": str(worktree.resolve()),
        "branch": branch,
        "base_commit": base_commit,
        "allowed_paths": allowed_paths,
        "shared_contracts": shared_contracts,
        "acceptance_commands": [{
            "argv": list(item["argv"]),
            "argv_sha256": item["argv_sha256"],
        } for item in command_specs],
        "timeout_seconds": timeout_seconds,
        "started_at": started_at,
        "expires_at": expires_at,
        "producer": {
            "orchestrator": receipt_relative_path(repo, ORCHESTRATOR),
            "orchestrator_sha256": sha256_file(ORCHESTRATOR),
            "trusted_execution_sha256": sha256_file(TRUSTED_EXECUTION_PATH / "trusted_execution.py"),
        },
    }
    path = atomic_write_bytes(
        repo,
        f"{relative_directory}/{nonce}.json",
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n",
    )
    return {"path": receipt_relative_path(repo, path), "sha256": sha256_file(path)}


def validate_execution_lease(repo: Path, record: dict, batch_id: str) -> dict[str, Any]:
    reference = record.get("lease_receipt")
    if not isinstance(reference, dict):
        raise RuntimeError("Running Batch has no immutable execution lease receipt")
    path = repository_path(repo, str(reference.get("path", "")), "execution lease receipt", regular_file=True)
    if sha256_file(path) != reference.get("sha256"):
        raise RuntimeError("Execution lease receipt hash mismatch")
    payload = json.loads(path.read_text(encoding="utf-8"))
    expected_commands = [{
        "argv": list(item["argv"]),
        "argv_sha256": item["argv_sha256"],
    } for item in record.get("acceptance_command_specs") or []]
    expected = {
        "batch_id": batch_id,
        "execution_nonce": record.get("execution_nonce"),
        "owner": record.get("lease_owner"),
        "worktree": record.get("worktree"),
        "branch": record.get("branch"),
        "base_commit": record.get("base_commit"),
        "allowed_paths": record.get("allowed_paths"),
        "shared_contracts": record.get("shared_contracts"),
        "acceptance_commands": expected_commands,
        "timeout_seconds": record.get("acceptance_timeout_seconds"),
        "started_at": record.get("execution_started_at"),
    }
    if not isinstance(payload, dict) or payload.get("schema_version") != "ltm.execution-lease.v1":
        raise RuntimeError("Execution lease receipt schema is invalid")
    for key, value in expected.items():
        if payload.get(key) != value:
            raise RuntimeError(f"Execution lease field was replaced after start: {key}")
    producer = payload.get("producer")
    if not isinstance(producer, dict):
        raise RuntimeError("Execution lease producer is invalid")
    orchestrator = repository_path(repo, str(producer.get("orchestrator", "")), "execution lease producer", regular_file=True)
    if producer.get("orchestrator_sha256") != sha256_file(orchestrator):
        raise RuntimeError("Execution lease orchestrator digest mismatch")
    if producer.get("trusted_execution_sha256") != sha256_file(TRUSTED_EXECUTION_PATH / "trusted_execution.py"):
        raise RuntimeError("Execution lease trusted-execution digest mismatch")
    return payload


def execute_argv(
    argv: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    timeout_seconds: int,
) -> tuple[int, bytes, bytes, bool]:
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
        return process.returncode, stdout, stderr, False
    except subprocess.TimeoutExpired as exc:
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        return 124, stdout if stdout is not None else (exc.stdout or b""), stderr if stderr is not None else (exc.stderr or b""), True


def run_acceptance_gates(repo: Path, record: dict, batch_id: str) -> dict[str, Any]:
    validate_execution_lease(repo, record, batch_id)
    worktree = Path(str(record.get("worktree", "")))
    branch = str(record.get("branch", ""))
    base_commit = resolve_commit(repo, str(record.get("base_commit", "")), "recorded base commit")
    live = validate_worktree(repo, worktree, branch, None, require_clean=True)
    result_commit = live["head"]
    if not is_ancestor(repo, base_commit, result_commit):
        raise RuntimeError("Recorded base commit is not an ancestor of the result commit")
    actual_changes = assert_owned_diff(repo, record, base_commit, result_commit)
    specs = record.get("acceptance_command_specs") or []
    if not specs:
        raise RuntimeError("At least one acceptance command is required before run-gates")
    for spec in specs:
        if not isinstance(spec, dict) or spec.get("argv_sha256") != argv_sha256(spec.get("argv") or []):
            raise RuntimeError("Stored acceptance command specification was replaced or corrupted")

    nonce = str(record.get("execution_nonce", ""))
    if not re_fullmatch_hex(nonce, 64):
        raise RuntimeError("Running lease has no valid execution nonce")
    relative_directory = f"evidence/{batch_id}/commands/{nonce}"
    output_directory = ensure_output_directory(repo, relative_directory)
    if any(output_directory.iterdir()):
        raise RuntimeError("Execution receipt directory is not empty; refusing stale evidence reuse")

    result_tree = commit_tree(repo, result_commit)
    started_at = now()
    command_receipts: list[dict[str, Any]] = []
    all_passed = True
    clean_after = False
    cleanup_succeeded = False
    with tempfile.TemporaryDirectory(prefix=f"ltm-{batch_id.lower()}-gate-") as temporary_value:
        temporary_root = Path(temporary_value)
        checkout = temporary_root / "checkout"
        add = trusted_git(repo, "worktree", "add", "--detach", str(checkout), result_commit)
        if add.returncode != 0:
            raise RuntimeError(add.stderr.decode("utf-8", errors="replace").strip() or "Failed to create clean execution worktree")
        try:
            if resolve_commit(checkout, "HEAD", "execution checkout HEAD") != result_commit:
                raise RuntimeError("Clean execution checkout resolved to the wrong commit")
            if trusted_git(checkout, "status", "--porcelain=v1", "--untracked-files=all").stdout:
                raise RuntimeError("New execution checkout is not clean")
            executable_records = [resolve_executable(list(spec["argv"]), checkout) for spec in specs]
            environment = clean_environment(
                temporary_root,
                [str(Path(item["resolved_path"]).parent) for item in executable_records],
            )
            environment_sha256 = sha256_bytes(canonical_json_bytes(environment))
            timeout_seconds = int(record.get("acceptance_timeout_seconds", 900))
            for index, (spec, executable) in enumerate(zip(specs, executable_records, strict=True)):
                argv = list(spec["argv"])
                actual_argv = [str(executable["resolved_path"]), *argv[1:]]
                command_started = datetime.now(timezone.utc)
                exit_code, stdout, stderr, timed_out = execute_argv(
                    actual_argv,
                    cwd=checkout,
                    environment=environment,
                    timeout_seconds=timeout_seconds,
                )
                command_completed = datetime.now(timezone.utc)
                prefix = f"{index:03d}-{spec['argv_sha256'][:16]}"
                stdout_path = atomic_write_bytes(repo, f"{relative_directory}/{prefix}.stdout.bin", stdout)
                stderr_path = atomic_write_bytes(repo, f"{relative_directory}/{prefix}.stderr.bin", stderr)
                receipt = {
                    "schema_version": RECEIPT_SCHEMA,
                    "batch_id": batch_id,
                    "execution_nonce": nonce,
                    "command_index": index,
                    "argv": argv,
                    "argv_sha256": spec["argv_sha256"],
                    "base_commit": base_commit,
                    "source_commit": result_commit,
                    "source_tree": result_tree,
                    "cwd": ".",
                    "environment_policy": ENVIRONMENT_POLICY,
                    "environment_sha256": environment_sha256,
                    "environment_keys": sorted(environment),
                    "executable": {
                        "kind": executable["kind"],
                        "path": executable["path"],
                        "sha256": executable["sha256"],
                    },
                    "started_at": command_started.isoformat(),
                    "completed_at": command_completed.isoformat(),
                    "duration_ms": max(0, int((command_completed - command_started).total_seconds() * 1000)),
                    "timeout_seconds": timeout_seconds,
                    "timed_out": timed_out,
                    "exit_code": exit_code,
                    "status": "passed" if exit_code == 0 and not timed_out else "failed",
                    "stdout": {
                        "path": receipt_relative_path(repo, stdout_path),
                        "sha256": sha256_bytes(stdout),
                        "size": len(stdout),
                    },
                    "stderr": {
                        "path": receipt_relative_path(repo, stderr_path),
                        "sha256": sha256_bytes(stderr),
                        "size": len(stderr),
                    },
                    "producer": {
                        "orchestrator": receipt_relative_path(repo, ORCHESTRATOR),
                        "orchestrator_sha256": sha256_file(ORCHESTRATOR),
                        "trusted_execution_sha256": sha256_file(TRUSTED_EXECUTION_PATH / "trusted_execution.py"),
                    },
                }
                receipt_path = atomic_write_bytes(
                    repo,
                    f"{relative_directory}/{prefix}.receipt.json",
                    json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n",
                )
                command_receipts.append({
                    "path": receipt_relative_path(repo, receipt_path),
                    "sha256": sha256_file(receipt_path),
                    "argv_sha256": spec["argv_sha256"],
                    "exit_code": exit_code,
                    "status": receipt["status"],
                })
                if receipt["status"] != "passed":
                    all_passed = False
                    break
            clean_after = not trusted_git(checkout, "status", "--porcelain=v1", "--untracked-files=all").stdout
            if not clean_after:
                all_passed = False
        finally:
            removal = trusted_git(repo, "worktree", "remove", "--force", str(checkout))
            cleanup_succeeded = removal.returncode == 0

    completed_at = now()
    bundle = {
        "schema_version": BUNDLE_SCHEMA,
        "batch_id": batch_id,
        "execution_nonce": nonce,
        "lease_receipt_sha256": record["lease_receipt"]["sha256"],
        "lease_started_at": record.get("execution_started_at"),
        "started_at": started_at,
        "completed_at": completed_at,
        "base_commit": base_commit,
        "source_commit": result_commit,
        "source_tree": result_tree,
        "branch": branch,
        "worktree": str(worktree.resolve()),
        "allowed_paths": list(record.get("allowed_paths") or []),
        "actual_changes": actual_changes,
        "acceptance_commands": [{
            "argv": list(spec["argv"]),
            "argv_sha256": spec["argv_sha256"],
        } for spec in specs],
        "command_receipts": command_receipts,
        "clean_checkout_before": True,
        "clean_checkout_after": clean_after,
        "temporary_worktree_removed": cleanup_succeeded,
        "all_passed": all_passed and len(command_receipts) == len(specs) and cleanup_succeeded,
        "production_release": "EVIDENCE_PENDING",
    }
    bundle_path = atomic_write_bytes(
        repo,
        f"{relative_directory}/execution-receipt.json",
        json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n",
    )
    return {
        "path": receipt_relative_path(repo, bundle_path),
        "sha256": sha256_file(bundle_path),
        "execution_nonce": nonce,
        "source_commit": result_commit,
        "source_tree": result_tree,
        "completed_at": completed_at,
        "all_passed": bundle["all_passed"],
    }


def load_current_gate_receipt(repo: Path, record: dict, batch_id: str) -> tuple[Path, dict[str, Any]]:
    validate_execution_lease(repo, record, batch_id)
    reference = record.get("gate_receipt")
    if not isinstance(reference, dict):
        raise RuntimeError("No acceptance execution receipt exists for this lease")
    path = repository_path(repo, str(reference.get("path", "")), "gate receipt", regular_file=True)
    if sha256_file(path) != reference.get("sha256"):
        raise RuntimeError("Gate receipt hash does not match orchestration state")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != BUNDLE_SCHEMA:
        raise RuntimeError("Gate receipt schema is invalid")
    if payload.get("batch_id") != batch_id or payload.get("execution_nonce") != record.get("execution_nonce"):
        raise RuntimeError("Gate receipt is stale or belongs to another execution")
    if payload.get("lease_receipt_sha256") != record.get("lease_receipt", {}).get("sha256"):
        raise RuntimeError("Gate receipt is not bound to the immutable execution lease")
    if payload.get("source_commit") != reference.get("source_commit") or payload.get("source_tree") != reference.get("source_tree"):
        raise RuntimeError("Gate receipt commit binding differs from orchestration state")
    if payload.get("all_passed") is not True:
        raise RuntimeError("Acceptance execution did not pass")
    if payload.get("acceptance_commands") != [{
        "argv": list(spec["argv"]),
        "argv_sha256": spec["argv_sha256"],
    } for spec in record.get("acceptance_command_specs") or []]:
        raise RuntimeError("Gate receipt commands differ from the current lease")
    started = parse_time(payload.get("started_at"), "gate receipt started_at")
    lease_started = parse_time(record.get("execution_started_at"), "execution_started_at")
    if started < lease_started:
        raise RuntimeError("Gate receipt predates the current execution lease")
    return path, payload


def re_fullmatch_hex(value: str, length: int) -> bool:
    return len(value) == length and all(character in "0123456789abcdef" for character in value)


def context_package(repo: Path, state: dict, batch_id: str) -> dict[str, Any]:
    batch = BY_ID[batch_id]
    record = state["batches"][batch_id]
    dependencies = [{
        "batch_id": dependency,
        "state": state["batches"][dependency]["state"],
        "completion_report": state["batches"][dependency].get("completion_report"),
    } for dependency in batch["depends_on"]]
    canonical_skill = repo / "skills" / batch["skill"] / "SKILL.md"
    canonical_reference = repo / batch["reference"]
    if not canonical_skill.is_file() or not canonical_reference.is_file():
        raise RuntimeError(f"Canonical Skill or Batch reference is missing for {batch_id}")
    return {
        "schema_version": "ltm.orchestration-context.v1",
        "scope": "code_implementation_only",
        "production_certification": "NOT_CERTIFIED",
        "package_version": PACKAGE_MANIFEST["version"],
        "repo_root": str(repo),
        "base_commit": state["base_commit"],
        "generated_at": now(),
        "batch": batch,
        "state": record["state"],
        "lease_owner": record.get("lease_owner"),
        "lease_expires_at": record.get("lease_expires_at"),
        "allowed_paths": record.get("allowed_paths") or [],
        "shared_contracts": record.get("shared_contracts") or [],
        "forbidden_operations": record.get("forbidden_operations") or [],
        "acceptance_commands": record.get("acceptance_commands") or [],
        "acceptance_argv": [item.get("argv") for item in record.get("acceptance_command_specs") or []],
        "acceptance_timeout_seconds": record.get("acceptance_timeout_seconds"),
        "execution_nonce": record.get("execution_nonce"),
        "skill_file": str(canonical_skill),
        "batch_reference": str(canonical_reference),
        "dependencies": dependencies,
        "baseline_report": state["batches"]["B00"].get("completion_report"),
    }


def has_verified_completion(repo: Path, batch_id: str, record: dict) -> bool:
    gate = record.get("gate_receipt")
    lease = record.get("lease_receipt")
    structural = (
        record.get("state") in DONE_STATES
        and isinstance(record.get("completion_report"), str)
        and re_fullmatch_hex(str(record.get("completion_report_sha256", "")), 64)
        and (
            re_fullmatch_hex(str(record.get("verified_result_commit", "")), 40)
            or re_fullmatch_hex(str(record.get("verified_result_commit", "")), 64)
        )
        and isinstance(gate, dict)
        and isinstance(lease, dict)
        and gate.get("all_passed") is True
        and re_fullmatch_hex(str(gate.get("sha256", "")), 64)
        and re_fullmatch_hex(str(lease.get("sha256", "")), 64)
        and gate.get("source_commit") == record.get("verified_result_commit")
    )
    if not structural:
        return False
    try:
        validate_execution_lease(repo, record, batch_id)
        report = repository_path(repo, str(record["completion_report"]), "dependency completion report", regular_file=True)
        receipt = repository_path(repo, str(gate["path"]), "dependency gate receipt", regular_file=True)
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        return (
            sha256_file(report) == record["completion_report_sha256"]
            and sha256_file(receipt) == gate["sha256"]
            and isinstance(payload, dict)
            and payload.get("schema_version") == BUNDLE_SCHEMA
            and payload.get("all_passed") is True
            and payload.get("source_commit") == record["verified_result_commit"]
            and payload.get("source_tree") == gate.get("source_tree")
            and payload.get("execution_nonce") == gate.get("execution_nonce")
            and payload.get("lease_receipt_sha256") == lease.get("sha256")
        )
    except (TrustError, OSError, json.JSONDecodeError, KeyError, TypeError):
        return False


def refresh_ready(state: dict) -> None:
    repo = Path(str(state.get("repo_root", ""))).resolve()
    for batch_id in TOPO:
        record = state["batches"][batch_id]
        if record["state"] == "certified":
            record["state"] = "factory_attested"
        if record["state"] not in {"planned", "ready"}:
            continue
        deps = BY_ID[batch_id]["depends_on"]
        record["state"] = "ready" if all(has_verified_completion(repo, dep, state["batches"][dep]) for dep in deps) else "planned"
    state["updated_at"] = now()


def write_state(path: Path, state: dict) -> None:
    refresh_ready(state)
    atomic_json(path, state)


def print_rows(state: dict, only_ready: bool = False, as_json: bool = False) -> None:
    rows = []
    for batch_id in TOPO:
        item = BY_ID[batch_id]
        record = state["batches"][batch_id]
        if only_ready and record["state"] != "ready":
            continue
        rows.append({
            "id": batch_id,
            "state": record["state"],
            "phase": item["phase"],
            "skill": item["skill"],
            "title": item["title"],
            "depends_on": item["depends_on"],
            "owner": record.get("lease_owner"),
            "branch": record.get("branch"),
            "lease_expires_at": record.get("lease_expires_at"),
            "allowed_paths": record.get("allowed_paths") or [],
        })
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    print("Scope: CODE_IMPLEMENTATION_WORKFLOW_ONLY; production certification is separate and evidence-gated")
    print(f"{'ID':<4} {'STATE':<18} {'PHASE':<18} TITLE")
    for row in rows:
        print(f"{row['id']:<4} {row['state']:<18} {row['phase']:<18} {row['title']}")


def resolve_report(repo: Path, value: str) -> Path:
    return repository_path(repo, value, "completion report", regular_file=True)


def resolve_state_path(repo: Path, value: Path | None) -> Path:
    candidate = (value or Path(".ai-life-time-machine/state/orchestration.json")).expanduser()
    candidate = candidate if candidate.is_absolute() else repo / candidate
    if candidate.is_symlink():
        raise RuntimeError("Orchestration state path must not be a symlink")
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(repo)
    except ValueError as exc:
        raise RuntimeError("Orchestration state path must stay inside the repository") from exc
    return resolved


def verify_report(repo: Path, batch_id: str, report: Path, state_path: Path, receipt_index: Path) -> None:
    verifier = repo / "skills/certifying-life-time-machine-release/scripts/verify_release.py"
    if not verifier.is_file():
        raise RuntimeError("Canonical product release verifier is missing")
    result = subprocess.run(
        [
            sys.executable,
            str(verifier),
            "--repo", str(repo),
            "--batch", batch_id,
            "--report", str(report),
            "--orchestration-state", str(state_path),
            "--receipt-index", str(receipt_index),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Completion report verification failed for {batch_id}: {detail}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--repo", required=True, type=Path)
    root.add_argument("--state", type=Path, help="Override orchestration state path")
    root.add_argument("--json", action="store_true", help="Print list outputs as JSON")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--force", action="store_true")
    commands.add_parser("status")
    commands.add_parser("ready")
    plan = commands.add_parser("worktree-plan")
    plan.add_argument("batch_id", choices=TOPO)
    plan.add_argument("--base", help="Base commit/branch; defaults to orchestration base commit")
    create = commands.add_parser("create-worktree")
    create.add_argument("batch_id", choices=TOPO)
    create.add_argument("--base", help="Base commit; defaults to orchestration base commit")
    create.add_argument("--worktree", type=Path, help="Target path; defaults beside the coordinator repository")
    create.add_argument("--branch", help="Branch; defaults to feat/ai-life-time-machine-<batch>")
    start = commands.add_parser("start")
    start.add_argument("batch_id", choices=TOPO)
    start.add_argument("--owner", required=True)
    start.add_argument("--worktree", required=True)
    start.add_argument("--branch", required=True)
    start.add_argument("--lease-minutes", type=int, default=120)
    start.add_argument("--allowed-path", action="append", required=True, help="Repository-relative owned path; repeatable")
    start.add_argument("--shared-contract", action="append", default=[], help="Shared contract touched by this Batch")
    start.add_argument("--forbid", action="append", default=[], help="Explicitly forbidden operation; repeatable")
    start.add_argument("--acceptance-command", action="append", default=[], help="Shell-free argv as JSON array or a command string; repeatable")
    start.add_argument("--acceptance-timeout-seconds", type=int, default=900)
    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument("batch_id", choices=TOPO)
    heartbeat.add_argument("--owner", required=True)
    heartbeat.add_argument("--lease-minutes", type=int, default=120)
    reclaim = commands.add_parser("reclaim-expired")
    reclaim.add_argument("batch_id", choices=TOPO)
    reclaim.add_argument("--reclaimed-by", required=True)
    context = commands.add_parser("context-package")
    context.add_argument("batch_id", choices=TOPO)
    context.add_argument("--output", type=Path)
    gates = commands.add_parser("run-gates")
    gates.add_argument("batch_id", choices=TOPO)
    gates.add_argument("--owner", required=True)
    finish = commands.add_parser("finish")
    finish.add_argument("batch_id", choices=TOPO)
    finish.add_argument("--owner", required=True)
    finish.add_argument("--report", required=True)
    merged = commands.add_parser("mark-merged")
    merged.add_argument("batch_id", choices=TOPO)
    merged.add_argument("--commit")
    certify = commands.add_parser("certify")
    certify.add_argument("batch_id", choices=TOPO)
    certify.add_argument("--certificate", required=True)
    block = commands.add_parser("block")
    block.add_argument("batch_id", choices=TOPO)
    block.add_argument("--note", required=True)
    reset = commands.add_parser("reset")
    reset.add_argument("batch_id", choices=TOPO)
    reset.add_argument("--note", required=True)
    return root


def main() -> int:
    args = parser().parse_args()
    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        print(f"ERROR: invalid repository: {repo}", file=sys.stderr)
        return 2
    state_path = resolve_state_path(repo, args.state)
    try:
        with lock_state(state_path):
            if args.command == "init":
                if state_path.exists() and not args.force:
                    raise RuntimeError(f"State already exists: {state_path}; use --force to reset")
                base_commit = resolve_commit(repo, "HEAD", "orchestration base commit")
                state = {
                    "schema_version": "1.0",
                    "package_version": PACKAGE_MANIFEST["version"],
                    "repo_root": str(repo),
                    "base_commit": base_commit,
                    "updated_at": now(),
                    "batches": {
                        batch_id: {
                            "state": "planned",
                            "worktree": None,
                            "branch": None,
                            "lease_owner": None,
                            "lease_expires_at": None,
                            "last_heartbeat_at": None,
                            "allowed_paths": [],
                            "shared_contracts": [],
                            "forbidden_operations": [],
                            "acceptance_commands": [],
                            "acceptance_command_specs": [],
                            "acceptance_timeout_seconds": None,
                            "base_commit": None,
                            "execution_nonce": None,
                            "execution_started_at": None,
                            "lease_receipt": None,
                            "gate_receipt": None,
                            "verified_result_commit": None,
                            "completion_report_sha256": None,
                            "pr_status": "EVIDENCE_PENDING",
                            "completion_report": None,
                            "notes": None,
                        }
                        for batch_id in TOPO
                    },
                }
                write_state(state_path, state)
                print(f"Initialized {state_path}")
                print_rows(state, only_ready=True, as_json=args.json)
                return 0

            state = load_state(state_path)
            if Path(str(state.get("repo_root", ""))).resolve() != repo:
                raise RuntimeError("Orchestration state belongs to a different repository")
            resolve_commit(repo, str(state.get("base_commit", "")), "orchestration base commit")
            refresh_ready(state)
            if args.command in {"status", "ready"}:
                atomic_json(state_path, state)
                print_rows(state, only_ready=args.command == "ready", as_json=args.json)
                return 0

            batch_id = args.batch_id
            record = state["batches"][batch_id]
            if args.command == "context-package":
                payload = context_package(repo, state, batch_id)
                if args.output is None:
                    print(json.dumps(payload, ensure_ascii=False, indent=2))
                else:
                    output = args.output.expanduser()
                    output = output.resolve() if output.is_absolute() else (repo / output).resolve()
                    try:
                        output.relative_to(repo)
                    except ValueError as exc:
                        raise RuntimeError("Context package output must stay inside the repository") from exc
                    atomic_json(output, payload)
                    print(f"Context package: {output}")
                return 0
            if args.command == "worktree-plan":
                if record["state"] != "ready":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not ready")
                branch = f"feat/ai-life-time-machine-{batch_id.lower()}"
                worktree = repo.parent / f"{repo.name}-{batch_id.lower()}"
                base = resolve_commit(repo, args.base or state["base_commit"], "worktree plan base commit")
                if base != resolve_commit(repo, state["base_commit"], "orchestration base commit"):
                    raise RuntimeError("Worktree plan base must equal the immutable orchestration base commit")
                print(f"git -C {repo} worktree add -b {branch} {worktree} {base}")
                print(f"python3 {ORCHESTRATOR} --repo {repo} start {batch_id} --owner <agent> --worktree {worktree} --branch {branch} --allowed-path <repo-relative-path>")
                return 0
            if args.command == "create-worktree":
                if record["state"] != "ready":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not ready")
                branch = args.branch or f"feat/ai-life-time-machine-{batch_id.lower()}"
                assert_branch_name(repo, branch)
                base_commit = resolve_commit(repo, args.base or state["base_commit"], "worktree base commit")
                if base_commit != resolve_commit(repo, state["base_commit"], "orchestration base commit"):
                    raise RuntimeError("Worktree base must equal the immutable orchestration base commit")
                worktree = (args.worktree or (repo.parent / f"{repo.name}-{batch_id.lower()}"))
                worktree = Path(os.path.abspath(worktree.expanduser()))
                if worktree.exists() or worktree.is_symlink():
                    raise RuntimeError(f"Worktree target already exists: {worktree}")
                add = trusted_git(repo, "worktree", "add", "-b", branch, str(worktree), base_commit)
                if add.returncode != 0:
                    detail = add.stderr.decode("utf-8", errors="replace").strip()
                    raise RuntimeError(f"Failed to create worktree: {detail}")
                validate_worktree(repo, worktree, branch, base_commit, require_clean=True)
                print(json.dumps({
                    "status": "created",
                    "batch_id": batch_id,
                    "worktree": str(worktree.resolve()),
                    "branch": branch,
                    "base_commit": base_commit,
                    "next": "start",
                }, ensure_ascii=False, sort_keys=True))
                return 0
            if args.command == "start":
                if record["state"] != "ready":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not ready")
                if args.lease_minutes <= 0:
                    raise RuntimeError("--lease-minutes must be positive")
                if not args.owner.strip():
                    raise RuntimeError("--owner must be non-empty")
                assert_branch_name(repo, args.branch)
                if args.acceptance_timeout_seconds <= 0 or args.acceptance_timeout_seconds > 3600:
                    raise RuntimeError("--acceptance-timeout-seconds must be between 1 and 3600")
                allowed_paths = sorted(set(owned_path(repo, path) for path in args.allowed_path))
                shared_contracts = sorted(set(owned_path(repo, path) for path in args.shared_contract))
                assert_path_ownership_available(state, batch_id, allowed_paths)
                base_commit = resolve_commit(repo, state["base_commit"], "orchestration base commit")
                for dependency_id in BY_ID[batch_id]["depends_on"]:
                    dependency = state["batches"][dependency_id]
                    if not has_verified_completion(repo, dependency_id, dependency):
                        raise RuntimeError(f"Dependency {dependency_id} has no trusted completion receipt")
                    if not is_ancestor(repo, str(dependency["verified_result_commit"]), base_commit):
                        raise RuntimeError(
                            f"Dependency {dependency_id} result is not contained in the Batch base; trusted merge evidence is required"
                        )
                worktree = Path(os.path.abspath(Path(args.worktree).expanduser()))
                validate_worktree(repo, worktree, args.branch, base_commit, require_clean=True)
                acceptance_commands = list(dict.fromkeys(args.acceptance_command))
                command_specs = [command_spec(value) for value in acceptance_commands]
                heartbeat_at = now()
                lease_expires_at = (datetime.now(timezone.utc) + timedelta(minutes=args.lease_minutes)).isoformat()
                execution_nonce = secrets.token_hex(32)
                lease_receipt = create_execution_lease(
                    repo,
                    batch_id=batch_id,
                    nonce=execution_nonce,
                    owner=args.owner,
                    worktree=worktree,
                    branch=args.branch,
                    base_commit=base_commit,
                    allowed_paths=allowed_paths,
                    shared_contracts=shared_contracts,
                    command_specs=command_specs,
                    timeout_seconds=args.acceptance_timeout_seconds,
                    started_at=heartbeat_at,
                    expires_at=lease_expires_at,
                )
                record.update({
                    "state": "running",
                    "worktree": str(worktree.resolve()),
                    "branch": args.branch,
                    "lease_owner": args.owner,
                    "lease_expires_at": lease_expires_at,
                    "last_heartbeat_at": heartbeat_at,
                    "allowed_paths": allowed_paths,
                    "shared_contracts": shared_contracts,
                    "forbidden_operations": sorted(set(args.forbid)),
                    "acceptance_commands": acceptance_commands,
                    "acceptance_command_specs": command_specs,
                    "acceptance_timeout_seconds": args.acceptance_timeout_seconds,
                    "base_commit": base_commit,
                    "execution_nonce": execution_nonce,
                    "execution_started_at": heartbeat_at,
                    "lease_receipt": lease_receipt,
                    "gate_receipt": None,
                    "verified_result_commit": None,
                    "completion_report_sha256": None,
                    "pr_status": "EVIDENCE_PENDING",
                    "notes": None,
                })
            elif args.command == "heartbeat":
                if record["state"] != "running":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not running")
                if args.lease_minutes <= 0:
                    raise RuntimeError("--lease-minutes must be positive")
                assert_lease_owner(record, args.owner, batch_id)
                if parse_time(record.get("lease_expires_at"), "lease_expires_at") <= datetime.now(timezone.utc):
                    raise RuntimeError(f"{batch_id} lease already expired; use reclaim-expired")
                record["last_heartbeat_at"] = now()
                record["lease_expires_at"] = (datetime.now(timezone.utc) + timedelta(minutes=args.lease_minutes)).isoformat()
            elif args.command == "reclaim-expired":
                if record["state"] != "running":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not running")
                if not args.reclaimed_by.strip():
                    raise RuntimeError("--reclaimed-by must be non-empty")
                expired_at = parse_time(record.get("lease_expires_at"), "lease_expires_at")
                if expired_at > datetime.now(timezone.utc):
                    raise RuntimeError(f"{batch_id} lease has not expired")
                previous_owner = record.get("lease_owner")
                record.update({
                    "state": "planned",
                    "worktree": None,
                    "branch": None,
                    "lease_owner": None,
                    "lease_expires_at": None,
                    "last_heartbeat_at": None,
                    "allowed_paths": [],
                    "shared_contracts": [],
                    "forbidden_operations": [],
                    "acceptance_commands": [],
                    "acceptance_command_specs": [],
                    "acceptance_timeout_seconds": None,
                    "base_commit": None,
                    "execution_nonce": None,
                    "execution_started_at": None,
                    "lease_receipt": None,
                    "gate_receipt": None,
                    "verified_result_commit": None,
                    "completion_report_sha256": None,
                    "pr_status": "EVIDENCE_PENDING",
                    "notes": f"expired_lease_reclaimed_by={args.reclaimed_by};previous_owner={previous_owner};expired_at={expired_at.isoformat()}",
                })
            elif args.command == "run-gates":
                if record["state"] != "running":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not running")
                assert_lease_owner(record, args.owner, batch_id)
                if parse_time(record.get("lease_expires_at"), "lease_expires_at") <= datetime.now(timezone.utc):
                    raise RuntimeError(f"{batch_id} lease expired before acceptance execution")
                if record.get("gate_receipt") is not None:
                    raise RuntimeError("Acceptance gates already ran for this lease; start a new execution for a rerun")
                gate_reference = run_acceptance_gates(repo, record, batch_id)
                record["gate_receipt"] = gate_reference
                record["notes"] = "acceptance_receipt_recorded" if gate_reference["all_passed"] else "acceptance_failed"
                write_state(state_path, state)
                print(json.dumps(gate_reference, ensure_ascii=False, sort_keys=True))
                return 0 if gate_reference["all_passed"] else 1
            elif args.command == "finish":
                if record["state"] != "running":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not running")
                assert_lease_owner(record, args.owner, batch_id)
                if parse_time(record.get("lease_expires_at"), "lease_expires_at") <= datetime.now(timezone.utc):
                    raise RuntimeError(f"{batch_id} lease expired before finish")
                receipt_index, receipt_payload = load_current_gate_receipt(repo, record, batch_id)
                worktree = Path(str(record.get("worktree", "")))
                validate_worktree(
                    repo,
                    worktree,
                    str(record.get("branch", "")),
                    str(receipt_payload["source_commit"]),
                    require_clean=True,
                )
                assert_owned_diff(repo, record, str(receipt_payload["base_commit"]), str(receipt_payload["source_commit"]))
                report = resolve_report(repo, args.report)
                verify_report(repo, batch_id, report, state_path, receipt_index)
                assert_report_paths(repo, record, report)
                record["state"] = "review"
                record["completion_report"] = str(report)
                record["completion_report_sha256"] = sha256_file(report)
                record["verified_result_commit"] = receipt_payload["source_commit"]
                record["pr_status"] = "EVIDENCE_PENDING"
                record["notes"] = "completion_verified;PR_MERGE_EVIDENCE_PENDING"
                record["lease_expires_at"] = None
                record["last_heartbeat_at"] = None
            elif args.command == "mark-merged":
                if record["state"] != "review":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not review")
                candidate = resolve_commit(repo, args.commit or "HEAD", "candidate merge commit")
                result_commit = str(record.get("verified_result_commit", ""))
                if not result_commit or not is_ancestor(repo, result_commit, candidate):
                    raise RuntimeError("Candidate merge commit does not contain the verified Batch result")
                record["pr_status"] = "EVIDENCE_PENDING"
                record["notes"] = f"PR_MERGE_EVIDENCE_PENDING;candidate_commit={candidate};trusted_provider_receipt=absent"
                write_state(state_path, state)
                print("EVIDENCE_PENDING: no trusted remote PR/provider receipt; Batch remains in review")
                print(f"{batch_id}: {state['batches'][batch_id]['state']}")
                return 3
            elif args.command == "certify":
                if record["state"] not in {"review", "merged"}:
                    raise RuntimeError(f"{batch_id} is {record['state']}, not review/merged")
                certificate = resolve_report(repo, args.certificate)
                if not certificate.is_file():
                    raise RuntimeError(f"Factory attestation not found: {certificate}")
                attestation = json.loads(certificate.read_text(encoding="utf-8"))
                if (attestation.get("status") != "factory_attested" or
                        attestation.get("scope") != "code_implementation_only" or
                        attestation.get("productionReleaseApproved") is not False or
                        attestation.get("externalCertification") != "NOT_CERTIFIED"):
                    raise RuntimeError("File is not a fail-closed code-only factory attestation")
                receipt_index, receipt_payload = load_current_gate_receipt(repo, record, batch_id)
                completion_report = resolve_report(repo, str(record.get("completion_report", "")))
                verify_report(repo, batch_id, completion_report, state_path, receipt_index)
                if (
                    attestation.get("completionReportSha256") != sha256_file(completion_report)
                    or attestation.get("resultCommit") != record.get("verified_result_commit")
                    or attestation.get("resultTree") != receipt_payload.get("source_tree")
                    or attestation.get("gateReceiptSha256") != sha256_file(receipt_index)
                ):
                    raise RuntimeError("Factory attestation is not bound to the verified report, receipt, commit, and tree")
                record["state"] = "factory_attested"
                record["notes"] = f"factory_attestation={certificate};production=NOT_CERTIFIED"
                record["lease_owner"] = None
                record["lease_expires_at"] = None
                record["last_heartbeat_at"] = None
            elif args.command == "block":
                if record["state"] in DONE_STATES:
                    raise RuntimeError(f"Cannot block completed batch {batch_id}")
                record["state"] = "blocked"
                record["notes"] = args.note
                record["lease_expires_at"] = None
                record["last_heartbeat_at"] = None
            elif args.command == "reset":
                if record["state"] in DONE_STATES:
                    raise RuntimeError(f"Cannot reset completed batch {batch_id}")
                record.update({
                    "state": "planned",
                    "worktree": None,
                    "branch": None,
                    "lease_owner": None,
                    "lease_expires_at": None,
                    "last_heartbeat_at": None,
                    "allowed_paths": [],
                    "shared_contracts": [],
                    "forbidden_operations": [],
                    "acceptance_commands": [],
                    "acceptance_command_specs": [],
                    "acceptance_timeout_seconds": None,
                    "base_commit": None,
                    "execution_nonce": None,
                    "execution_started_at": None,
                    "lease_receipt": None,
                    "gate_receipt": None,
                    "verified_result_commit": None,
                    "completion_report_sha256": None,
                    "pr_status": "EVIDENCE_PENDING",
                    "completion_report": None,
                    "notes": args.note,
                })
            write_state(state_path, state)
            print(f"{batch_id}: {state['batches'][batch_id]['state']}")
            return 0
    except (RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
