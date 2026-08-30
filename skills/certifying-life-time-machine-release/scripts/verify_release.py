#!/usr/bin/env python3
"""Fail-closed verification of completion reports and trusted command receipts."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from trusted_execution import (
    BUNDLE_SCHEMA,
    ENVIRONMENT_POLICY,
    RECEIPT_SCHEMA,
    TrustError,
    argv_sha256,
    atomic_write_bytes,
    canonical_argv,
    changed_files,
    commit_file,
    commit_tree,
    ensure_output_directory,
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
PACKAGE = json.loads((PACKAGE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BATCHES = json.loads((PACKAGE_ROOT / "manifests/batches.json").read_text(encoding="utf-8"))
BY_ID = {item["id"]: item for item in BATCHES}
TOPO = json.loads((PACKAGE_ROOT / "manifests/topological-order.json").read_text(encoding="utf-8"))
SOURCE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".go", ".h", ".hcl", ".hpp", ".html",
    ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".py", ".rs", ".scss", ".sh",
    ".sql", ".svelte", ".swift", ".tf", ".ts", ".tsx", ".vue", ".yaml", ".yml",
}
PLACEHOLDER_PATTERNS = (
    re.compile(rb"\bTODO\b", re.IGNORECASE),
    re.compile(rb"\bFIXME\b", re.IGNORECASE),
    re.compile(rb"NotImplementedError"),
    re.compile(rb"UnsupportedOperationException"),
    re.compile(rb"throw\s+new\s+Error\s*\(\s*['\"](?:TODO|not implemented)", re.IGNORECASE),
)
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
)
ANTI_CHEATING_PATTERNS = (
    ("skipped test", re.compile(rb"\b(?:describe|it|test)\.skip\s*\(|@(?:unittest\.)?skip\b|@Disabled\b|pytest\.mark\.skip\b|#\[ignore\]")),
    ("empty assertion", re.compile(rb"\bassert\s+(?:True|true|1)\b|expect\(\s*true\s*\)\.toBe\(\s*true\s*\)")),
    ("disabled failure gate", re.compile(rb"continue-on-error\s*:\s*true|allow[_-]?failure\s*[:=]\s*true|\|\|\s*true\b", re.IGNORECASE)),
    ("hard-coded verifier success", re.compile(
        rb"(?:def|function)\s+(?:verify|validate|certify)[A-Za-z0-9_]*[^\n{]*(?:\{|:)\s*(?:\r?\n\s*)?return\s+(?:True|true)\b",
        re.IGNORECASE,
    )),
)
DONE_STATES = {"merged", "factory_attested"}


def validate_datetime(value: Any, label: str, errors: list[str]) -> datetime | None:
    if not isinstance(value, str):
        errors.append(f"{label} must be an ISO date-time string")
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{label} is not a valid ISO date-time: {value}")
        return None
    if parsed.tzinfo is None:
        errors.append(f"{label} must include a timezone")
        return None
    return parsed.astimezone(timezone.utc)


def read_json(path: Path, label: str, errors: list[str]) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{label} is invalid JSON: {exc}")
        return None
    if not isinstance(payload, dict):
        errors.append(f"{label} must be a JSON object")
        return None
    return payload


def safe_repo_file(repo: Path, value: str, label: str, errors: list[str]) -> Path | None:
    try:
        return repository_path(repo, value, label, regular_file=True)
    except TrustError as exc:
        errors.append(str(exc))
        return None


def load_state(repo: Path, value: Path | None, errors: list[str]) -> tuple[Path | None, dict[str, Any] | None]:
    candidate = value or repo / ".ai-life-time-machine/state/orchestration.json"
    path = safe_repo_file(repo, str(candidate), "orchestration state", errors)
    if path is None:
        return None, None
    payload = read_json(path, "orchestration state", errors)
    if payload is None:
        return path, None
    try:
        if Path(str(payload.get("repo_root", ""))).resolve() != repo:
            errors.append("orchestration state belongs to another repository")
    except (OSError, RuntimeError):
        errors.append("orchestration state repo_root is invalid")
    if not isinstance(payload.get("batches"), dict):
        errors.append("orchestration state has no Batch records")
    return path, payload


def actual_change_map(repo: Path, base_commit: str, result_commit: str, errors: list[str]) -> dict[str, str]:
    try:
        changes = changed_files(repo, base_commit, result_commit)
    except TrustError as exc:
        errors.append(str(exc))
        return {}
    result: dict[str, str] = {}
    for item in changes:
        path = item["path"]
        if path in result:
            errors.append(f"Git diff contains duplicate path: {path}")
        result[path] = item["change"]
    return result


def state_completion_is_verified(state: dict[str, Any], batch_id: str, repo: Path) -> bool:
    record = state.get("batches", {}).get(batch_id)
    if not isinstance(record, dict) or record.get("state") not in DONE_STATES:
        return False
    report_value = record.get("completion_report")
    if not isinstance(report_value, str):
        return False
    try:
        report = repository_path(repo, report_value, f"dependency {batch_id} report", regular_file=True)
    except TrustError:
        return False
    gate = record.get("gate_receipt")
    lease = record.get("lease_receipt")
    if not isinstance(gate, dict) or not isinstance(lease, dict):
        return False
    try:
        receipt = repository_path(repo, str(gate.get("path", "")), f"dependency {batch_id} gate receipt", regular_file=True)
        lease_path = repository_path(repo, str(lease.get("path", "")), f"dependency {batch_id} lease receipt", regular_file=True)
        receipt_payload = json.loads(receipt.read_text(encoding="utf-8"))
        lease_payload = json.loads(lease_path.read_text(encoding="utf-8"))
    except (TrustError, OSError, json.JSONDecodeError):
        return False
    return (
        gate.get("all_passed") is True
        and isinstance(record.get("verified_result_commit"), str)
        and gate.get("source_commit") == record.get("verified_result_commit")
        and record.get("completion_report_sha256") == sha256_file(report)
        and gate.get("sha256") == sha256_file(receipt)
        and lease.get("sha256") == sha256_file(lease_path)
        and isinstance(receipt_payload, dict)
        and isinstance(lease_payload, dict)
        and lease_payload.get("schema_version") == "ltm.execution-lease.v1"
        and lease_payload.get("batch_id") == batch_id
        and lease_payload.get("execution_nonce") == gate.get("execution_nonce")
        and receipt_payload.get("schema_version") == BUNDLE_SCHEMA
        and receipt_payload.get("all_passed") is True
        and receipt_payload.get("source_commit") == record.get("verified_result_commit")
        and receipt_payload.get("source_tree") == gate.get("source_tree")
        and receipt_payload.get("execution_nonce") == gate.get("execution_nonce")
        and receipt_payload.get("lease_receipt_sha256") == lease.get("sha256")
    )


def validate_command_receipts(
    repo: Path,
    expected_batch: str,
    report: dict[str, Any],
    tests: list[Any],
    evidence_by_path: dict[str, dict[str, Any]],
    state: dict[str, Any] | None,
    receipt_index: Path | None,
    errors: list[str],
) -> dict[str, Any] | None:
    if state is None:
        errors.append("trusted orchestration state is required for a passing report")
        return None
    record = state.get("batches", {}).get(expected_batch)
    if not isinstance(record, dict):
        errors.append(f"orchestration state has no record for {expected_batch}")
        return None
    reference = record.get("gate_receipt")
    if not isinstance(reference, dict):
        errors.append("current lease has no gate receipt")
        return None
    lease_reference = record.get("lease_receipt")
    if not isinstance(lease_reference, dict):
        errors.append("current execution has no immutable lease receipt")
        return None
    lease_path = safe_repo_file(repo, str(lease_reference.get("path", "")), "execution lease receipt", errors)
    lease_payload: dict[str, Any] | None = None
    if lease_path:
        if sha256_file(lease_path) != lease_reference.get("sha256"):
            errors.append("execution lease receipt hash differs from orchestration state")
        lease_payload = read_json(lease_path, "execution lease receipt", errors)
    if lease_payload is None:
        return None
    if receipt_index is None:
        receipt_index = safe_repo_file(repo, str(reference.get("path", "")), "receipt index", errors)
    if receipt_index is None:
        return None
    try:
        receipt_index = repository_path(repo, str(receipt_index), "receipt index", regular_file=True)
    except TrustError as exc:
        errors.append(str(exc))
        return None
    if str(reference.get("path")) != receipt_index.relative_to(repo).as_posix():
        errors.append("receipt index is not the receipt recorded for the current lease")
    receipt_hash = sha256_file(receipt_index)
    if reference.get("sha256") != receipt_hash:
        errors.append("receipt index hash differs from orchestration state")
    bundle = read_json(receipt_index, "receipt index", errors)
    if bundle is None:
        return None
    if bundle.get("schema_version") != BUNDLE_SCHEMA:
        errors.append("receipt index schema is invalid")
    if bundle.get("batch_id") != expected_batch:
        errors.append("receipt index belongs to another Batch")
    if bundle.get("execution_nonce") != record.get("execution_nonce") or bundle.get("execution_nonce") != reference.get("execution_nonce"):
        errors.append("receipt index is stale or belongs to another lease")
    if bundle.get("lease_receipt_sha256") != lease_reference.get("sha256"):
        errors.append("receipt index is not bound to the immutable execution lease")
    lease_started = validate_datetime(record.get("execution_started_at"), "execution_started_at", errors)
    receipt_started = validate_datetime(bundle.get("started_at"), "receipt index started_at", errors)
    validate_datetime(bundle.get("completed_at"), "receipt index completed_at", errors)
    if lease_started and receipt_started and receipt_started < lease_started:
        errors.append("receipt index predates the current lease")
    for flag in ("all_passed", "clean_checkout_before", "clean_checkout_after", "temporary_worktree_removed"):
        if bundle.get(flag) is not True:
            errors.append(f"receipt index {flag} must be true")
    if bundle.get("branch") != record.get("branch") or bundle.get("worktree") != record.get("worktree"):
        errors.append("receipt index worktree/branch differs from the current lease")
    if bundle.get("allowed_paths") != record.get("allowed_paths"):
        errors.append("receipt index ownership differs from the current lease")

    base_commit = report.get("base_commit")
    result_commit = report.get("result_commit")
    if bundle.get("base_commit") != base_commit:
        errors.append("receipt index base commit differs from report")
    if bundle.get("source_commit") != result_commit or reference.get("source_commit") != result_commit:
        errors.append("receipt index result commit differs from report")
    try:
        expected_tree = commit_tree(repo, str(result_commit))
    except TrustError as exc:
        errors.append(str(exc))
        expected_tree = None
    if expected_tree and (bundle.get("source_tree") != expected_tree or reference.get("source_tree") != expected_tree):
        errors.append("receipt index tree differs from the immutable result commit")

    expected_specs = record.get("acceptance_command_specs") or []
    expected_commands = [{"argv": item.get("argv"), "argv_sha256": item.get("argv_sha256")} for item in expected_specs]
    expected_lease = {
        "schema_version": "ltm.execution-lease.v1",
        "batch_id": expected_batch,
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
    for key, expected in expected_lease.items():
        if lease_payload.get(key) != expected:
            errors.append(f"execution lease field differs from orchestration state: {key}")
    lease_producer = lease_payload.get("producer")
    if not isinstance(lease_producer, dict):
        errors.append("execution lease producer is invalid")
    else:
        lease_orchestrator = safe_repo_file(repo, str(lease_producer.get("orchestrator", "")), "execution lease producer", errors)
        if lease_orchestrator and lease_producer.get("orchestrator_sha256") != sha256_file(lease_orchestrator):
            errors.append("execution lease orchestrator digest mismatch")
        helper_path = repo / "skills/certifying-life-time-machine-release/scripts/trusted_execution.py"
        if not helper_path.is_file() or lease_producer.get("trusted_execution_sha256") != sha256_file(helper_path):
            errors.append("execution lease trusted-execution digest mismatch")
    if bundle.get("acceptance_commands") != expected_commands:
        errors.append("receipt index commands differ from the current lease allowlist")
    receipts = bundle.get("command_receipts")
    if not isinstance(receipts, list) or len(receipts) != len(expected_specs):
        errors.append("receipt index does not contain exactly one receipt per acceptance command")
        receipts = []
    if len(tests) != len(expected_specs):
        errors.append("completion report tests must map one-to-one to executed acceptance commands")

    tests_by_command: dict[str, dict[str, Any]] = {}
    trusted_artifact_paths: set[str] = {
        receipt_index.relative_to(repo).as_posix(),
        lease_path.relative_to(repo).as_posix(),
    }
    for test in tests:
        if isinstance(test, dict) and isinstance(test.get("command"), str):
            if test["command"] in tests_by_command:
                errors.append(f"duplicate test command: {test['command']}")
            tests_by_command[test["command"]] = test

    for index, receipt_ref in enumerate(receipts):
        if not isinstance(receipt_ref, dict):
            errors.append(f"command_receipts[{index}] must be an object")
            continue
        path = safe_repo_file(repo, str(receipt_ref.get("path", "")), f"command receipt {index}", errors)
        if path is None:
            continue
        trusted_artifact_paths.add(path.relative_to(repo).as_posix())
        if sha256_file(path) != receipt_ref.get("sha256"):
            errors.append(f"command receipt hash mismatch: {receipt_ref.get('path')}")
        receipt = read_json(path, f"command receipt {index}", errors)
        if receipt is None:
            continue
        spec = expected_specs[index] if index < len(expected_specs) else {}
        if receipt.get("schema_version") != RECEIPT_SCHEMA:
            errors.append(f"command receipt {index} schema is invalid")
        if receipt.get("batch_id") != expected_batch or receipt.get("execution_nonce") != record.get("execution_nonce"):
            errors.append(f"command receipt {index} belongs to another execution")
        if receipt.get("command_index") != index:
            errors.append(f"command receipt {index} index is invalid")
        if receipt.get("argv") != spec.get("argv") or receipt.get("argv_sha256") != spec.get("argv_sha256"):
            errors.append(f"command receipt {index} argv was replaced")
        if receipt.get("argv_sha256") != argv_sha256(receipt.get("argv") or []):
            errors.append(f"command receipt {index} argv digest is invalid")
        if receipt.get("source_commit") != result_commit or receipt.get("source_tree") != expected_tree:
            errors.append(f"command receipt {index} is bound to the wrong commit/tree")
        if receipt.get("base_commit") != base_commit:
            errors.append(f"command receipt {index} is bound to the wrong base commit")
        if receipt.get("environment_policy") != ENVIRONMENT_POLICY:
            errors.append(f"command receipt {index} did not use the clean environment policy")
        keys = receipt.get("environment_keys")
        expected_environment_keys = sorted({
            "CI", "COREPACK_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG",
            "LC_ALL", "NO_COLOR", "PATH", "TMPDIR", "TZ", "XDG_CACHE_HOME", "npm_config_cache",
        })
        if keys != expected_environment_keys:
            errors.append(f"command receipt {index} environment was not sanitized")
        if not isinstance(receipt.get("environment_sha256"), str) or len(receipt["environment_sha256"]) != 64:
            errors.append(f"command receipt {index} environment digest is invalid")
        if receipt.get("timeout_seconds") != record.get("acceptance_timeout_seconds"):
            errors.append(f"command receipt {index} timeout differs from the lease policy")
        if receipt.get("timed_out") is not False or receipt.get("exit_code") != 0 or receipt.get("status") != "passed":
            errors.append(f"command receipt {index} is not an actual passing execution")
        if receipt_ref.get("exit_code") != receipt.get("exit_code") or receipt_ref.get("status") != receipt.get("status"):
            errors.append(f"receipt index outcome differs from command receipt {index}")
        producer = receipt.get("producer")
        if not isinstance(producer, dict):
            errors.append(f"command receipt {index} producer is invalid")
        else:
            producer_path = safe_repo_file(repo, str(producer.get("orchestrator", "")), f"command receipt {index} producer", errors)
            if producer_path and producer.get("orchestrator_sha256") != sha256_file(producer_path):
                errors.append(f"command receipt {index} orchestrator digest mismatch")
            helper_path = repo / "skills/certifying-life-time-machine-release/scripts/trusted_execution.py"
            if not helper_path.is_file() or producer.get("trusted_execution_sha256") != sha256_file(helper_path):
                errors.append(f"command receipt {index} trusted-execution digest mismatch")
        try:
            current_executable = resolve_executable(list(receipt.get("argv") or []), Path(str(record.get("worktree", ""))))
            recorded_executable = receipt.get("executable")
            if not isinstance(recorded_executable, dict) or any(
                recorded_executable.get(field) != current_executable.get(field) for field in ("kind", "path", "sha256")
            ):
                errors.append(f"command receipt {index} executable identity changed")
        except TrustError as exc:
            errors.append(str(exc))
        for stream in ("stdout", "stderr"):
            stream_record = receipt.get(stream)
            if not isinstance(stream_record, dict):
                errors.append(f"command receipt {index}.{stream} is invalid")
                continue
            stream_path = safe_repo_file(repo, str(stream_record.get("path", "")), f"command receipt {index}.{stream}", errors)
            if stream_path is None:
                continue
            trusted_artifact_paths.add(stream_path.relative_to(repo).as_posix())
            if stream_path.parent != path.parent:
                errors.append(f"command receipt {index}.{stream} must be stored beside its receipt")
            size = stream_path.stat().st_size
            if stream_record.get("size") != size or stream_record.get("sha256") != sha256_file(stream_path):
                errors.append(f"command receipt {index}.{stream} bytes/hash mismatch")
        artifact_value = receipt_ref.get("path")
        evidence_record = evidence_by_path.get(str(artifact_value))
        if evidence_record is None or evidence_record.get("sha256") != receipt_ref.get("sha256"):
            errors.append(f"command receipt {index} must be a hash-matched evidence record")
        command = canonical_argv(receipt.get("argv") or [])
        test = tests_by_command.get(command)
        if test is None:
            errors.append(f"command receipt {index} has no exact canonical test mapping")
        else:
            if test.get("artifact") != artifact_value:
                errors.append(f"test artifact does not reference command receipt {index}")
            if test.get("exit_code") != receipt.get("exit_code") or test.get("status") != receipt.get("status"):
                errors.append(f"test self-reported outcome differs from command receipt {index}")
            if test.get("duration_ms") not in {None, receipt.get("duration_ms")}:
                errors.append(f"test duration differs from command receipt {index}")
    bundle_evidence = evidence_by_path.get(receipt_index.relative_to(repo).as_posix())
    if bundle_evidence is None or bundle_evidence.get("sha256") != receipt_hash:
        errors.append("receipt index itself must be included as hash-matched evidence")
    lease_evidence = evidence_by_path.get(lease_path.relative_to(repo).as_posix())
    if lease_evidence is None or lease_evidence.get("sha256") != lease_reference.get("sha256"):
        errors.append("execution lease itself must be included as hash-matched evidence")

    try:
        worktree = Path(str(record.get("worktree", "")))
        validate_worktree(repo, worktree, str(record.get("branch", "")), str(result_commit), require_clean=True)
    except TrustError as exc:
        errors.append(str(exc))
    bundle["_trusted_artifact_paths"] = sorted(trusted_artifact_paths)
    return bundle


def validate_report(
    repo: Path,
    report_path: Path,
    expected_batch: str,
    *,
    state: dict[str, Any] | None = None,
    receipt_index: Path | None = None,
) -> tuple[list[str], dict[str, Any] | None]:
    errors: list[str] = []
    try:
        report_path = repository_path(repo, str(report_path), "completion report", regular_file=True)
    except TrustError as exc:
        return [str(exc)], None
    report = read_json(report_path, "completion report", errors)
    if report is None:
        return errors, None

    def require(key: str, kind: type | tuple[type, ...] | None = None) -> Any:
        if key not in report:
            errors.append(f"missing required field: {key}")
            return None
        value = report[key]
        if kind is not None and not isinstance(value, kind):
            errors.append(f"{key} has wrong type")
        return value

    require("schema_version")
    require("package_version")
    batch_id = require("batch_id")
    status = require("status")
    require("repo_root")
    base_value = require("base_commit")
    result_value = require("result_commit")
    started_at = validate_datetime(require("started_at"), "started_at", errors)
    completed_at = validate_datetime(require("completed_at"), "completed_at", errors)
    agent = require("agent", dict)
    dependencies = require("dependencies", list) or []
    changed_report = require("changed_files", list) or []
    entrypoints = require("entrypoints", list) or []
    tests = require("tests", list) or []
    evidence = require("evidence", list) or []
    traceability = require("traceability", list) or []
    risks = require("risks", list) or []
    require("follow_ups", list)
    assertions = require("assertions", dict) or {}

    if report.get("schema_version") != "1.0":
        errors.append("schema_version must be 1.0")
    if report.get("package_version") != PACKAGE["version"]:
        errors.append(f"package_version must be {PACKAGE['version']}")
    if batch_id != expected_batch:
        errors.append(f"batch_id must be {expected_batch}, got {batch_id}")
    if status != "passed":
        errors.append(f"status must be passed, got {status}")
    try:
        if Path(str(report.get("repo_root", ""))).resolve() != repo:
            errors.append(f"repo_root must resolve to the verified repository: {repo}")
    except (OSError, RuntimeError):
        errors.append("repo_root is invalid")
    if started_at and completed_at and completed_at < started_at:
        errors.append("completed_at precedes started_at")
    if report.get("blockers"):
        errors.append("passed report must have no blockers")
    for key in ("no_placeholders", "no_skipped_required_tests", "no_fake_evidence", "no_real_customer_media", "no_secrets", "clean_room_reproducible"):
        if assertions.get(key) is not True:
            errors.append(f"assertions.{key} must be true (and is independently verified where observable)")

    base_commit: str | None = None
    result_commit: str | None = None
    try:
        base_commit = resolve_commit(repo, str(base_value), "base_commit")
        if base_value != base_commit:
            errors.append("base_commit must be a full immutable commit SHA")
    except TrustError as exc:
        errors.append(str(exc))
    try:
        result_commit = resolve_commit(repo, str(result_value), "result_commit")
        if result_value != result_commit:
            errors.append("result_commit must be a full immutable commit SHA")
    except TrustError as exc:
        errors.append(str(exc))
    if base_commit and result_commit and not is_ancestor(repo, base_commit, result_commit):
        errors.append("base_commit is not an ancestor of result_commit")

    if agent is not None:
        if agent.get("host") not in {"claude-code", "codex", "human", "other"}:
            errors.append("agent.host is invalid")
        if not isinstance(agent.get("session_id"), str) or not agent["session_id"].strip():
            errors.append("agent.session_id is required")
        state_record = state.get("batches", {}).get(expected_batch) if isinstance(state, dict) else None
        try:
            agent_worktree = Path(str(agent.get("worktree", "")))
            state_worktree = Path(str(state_record.get("worktree", ""))) if isinstance(state_record, dict) else Path("")
            worktree_matches = not agent_worktree.is_symlink() and agent_worktree.resolve() == state_worktree.resolve()
        except (OSError, RuntimeError):
            worktree_matches = False
        if not worktree_matches:
            errors.append("agent.worktree differs from the trusted orchestration lease")

    expected_deps = set(BY_ID[expected_batch]["depends_on"])
    seen_deps: set[str] = set()
    for index, dep in enumerate(dependencies):
        if not isinstance(dep, dict):
            errors.append(f"dependencies[{index}] must be an object")
            continue
        dep_id = dep.get("batch_id")
        if not isinstance(dep_id, str) or dep_id in seen_deps:
            errors.append(f"duplicate or invalid dependency record: {dep_id}")
            continue
        seen_deps.add(dep_id)
        if dep_id not in expected_deps:
            errors.append(f"unexpected dependency record: {dep_id}")
        path = safe_repo_file(repo, str(dep.get("report_path", "")), f"dependency {dep_id} report", errors)
        if path:
            if dep.get("sha256") != sha256_file(path):
                errors.append(f"dependency {dep_id} report hash mismatch")
            payload = read_json(path, f"dependency {dep_id} report", errors)
            if payload and (payload.get("batch_id") != dep_id or payload.get("status") != "passed"):
                errors.append(f"dependency {dep_id} report content is not passing")
        if dep.get("status") != "passed":
            errors.append(f"dependency {dep_id} status must be passed")
        if state is None or not state_completion_is_verified(state, dep_id, repo):
            errors.append(f"dependency {dep_id} has no trusted verified completion in orchestration state")
    if seen_deps != expected_deps:
        errors.append(f"dependency set mismatch: expected {sorted(expected_deps)}, got {sorted(seen_deps)}")

    evidence_by_path: dict[str, dict[str, Any]] = {}
    supported_requirements: set[str] = set()
    for index, item in enumerate(evidence):
        if not isinstance(item, dict):
            errors.append(f"evidence[{index}] must be an object")
            continue
        value = item.get("path")
        path = safe_repo_file(repo, str(value or ""), f"evidence[{index}]", errors)
        if path:
            if item.get("sha256") != sha256_file(path):
                errors.append(f"evidence hash mismatch: {value}")
            if path.stat().st_size == 0 and item.get("type") != "command-log":
                errors.append(f"evidence file is empty: {value}")
        if item.get("contains_sensitive_data") is True:
            errors.append(f"release evidence must not contain sensitive data: {value}")
        supports = item.get("supports")
        if not isinstance(supports, list) or not supports:
            errors.append(f"evidence supports must be non-empty: {value}")
        else:
            supported_requirements.update(str(requirement) for requirement in supports)
        if not isinstance(value, str) or value in evidence_by_path:
            errors.append(f"duplicate or invalid evidence path: {value}")
        else:
            evidence_by_path[value] = item
        validate_datetime(item.get("created_at"), f"evidence[{index}].created_at", errors)

    test_names: set[str] = set()
    scopes: set[Any] = set()
    for index, test in enumerate(tests):
        if not isinstance(test, dict):
            errors.append(f"tests[{index}] must be an object")
            continue
        name = test.get("name")
        if not isinstance(name, str) or not name.strip() or name in test_names:
            errors.append(f"test name missing or duplicate: tests[{index}]")
        else:
            test_names.add(name)
        scopes.add(test.get("scope"))
    if not tests:
        errors.append("at least one executed test receipt is required")
    if not ({"unit", "integration", "contract", "e2e", "negative", "security", "privacy"} & scopes):
        errors.append("test evidence must include at least one substantive scope")

    bundle = validate_command_receipts(
        repo, expected_batch, report, tests, evidence_by_path, state, receipt_index, errors,
    )

    if result_commit:
        trusted_artifacts = set(bundle.get("_trusted_artifact_paths", [])) if bundle else set()
        for evidence_path, evidence_record in evidence_by_path.items():
            if evidence_path in trusted_artifacts:
                continue
            try:
                committed = commit_file(repo, result_commit, evidence_path, f"evidence {evidence_path}")
            except TrustError:
                errors.append(
                    f"evidence is neither a trusted execution artifact nor an immutable result-commit blob: {evidence_path}"
                )
                continue
            if evidence_record.get("sha256") != sha256_bytes(committed):
                errors.append(f"committed evidence digest mismatch: {evidence_path}")

    report_changes: dict[str, str] = {}
    for index, item in enumerate(changed_report):
        if not isinstance(item, dict) or item.get("change") not in {"added", "modified", "deleted", "renamed"}:
            errors.append(f"changed_files[{index}] is invalid")
            continue
        path = item.get("path")
        if not isinstance(path, str) or path in report_changes:
            errors.append(f"changed_files[{index}] path is invalid or duplicate")
            continue
        report_changes[path] = item["change"]
    actual_changes = actual_change_map(repo, base_commit, result_commit, errors) if base_commit and result_commit else {}
    if report_changes != actual_changes:
        errors.append(f"changed_files does not equal committed diff: expected {actual_changes}, got {report_changes}")
    if bundle is not None:
        try:
            exact_changes = changed_files(repo, str(base_commit), str(result_commit))
        except TrustError:
            exact_changes = []
        if bundle.get("actual_changes") != exact_changes:
            errors.append("receipt index exact changed-files binding differs from committed diff")
        bundle_changes = {item.get("path"): item.get("change") for item in bundle.get("actual_changes", []) if isinstance(item, dict)}
        if bundle_changes != actual_changes:
            errors.append("receipt index changed-files binding differs from committed diff")

    changed_contents: dict[str, bytes] = {}
    if result_commit:
        for path, change in actual_changes.items():
            if change == "deleted":
                continue
            try:
                changed_contents[path] = commit_file(repo, result_commit, path, f"changed file {path}")
            except TrustError as exc:
                errors.append(str(exc))
    for path, content in changed_contents.items():
        if Path(path).suffix.lower() not in SOURCE_SUFFIXES:
            continue
        generated_or_vendored = any(part in {"evidence", "generated", "vendor", "node_modules"} for part in Path(path).parts)
        if not generated_or_vendored:
            for label, pattern in ANTI_CHEATING_PATTERNS:
                if pattern.search(content):
                    errors.append(f"{label} detected in committed {path}: {pattern.pattern!r}")
        production_source = not any(
            part in {"test", "tests", "__tests__", "fixtures", "evidence", "generated", "vendor", "node_modules"}
            for part in Path(path).parts
        )
        if production_source:
            for pattern in PLACEHOLDER_PATTERNS:
                if pattern.search(content):
                    errors.append(f"production placeholder detected in committed {path}: {pattern.pattern!r}")
            for pattern in SECRET_PATTERNS:
                if pattern.search(content):
                    errors.append(f"possible secret detected in committed {path}: {pattern.pattern!r}")

    if not entrypoints:
        errors.append("entrypoints must be non-empty for a passing implementation Batch")
    if result_commit:
        for index, value in enumerate(entrypoints):
            try:
                commit_file(repo, result_commit, str(value), f"entrypoints[{index}]")
            except TrustError as exc:
                errors.append(str(exc))
        migrations = report.get("migrations") or []
        for index, value in enumerate(migrations):
            try:
                commit_file(repo, result_commit, str(value), f"migrations[{index}]")
            except TrustError as exc:
                errors.append(str(exc))
        changed_migrations = {path for path in actual_changes if "migration" in Path(path).parts or Path(path).suffix.lower() == ".sql"}
        declared_migrations = set(str(item) for item in migrations)
        if not changed_migrations.issubset(declared_migrations):
            errors.append(f"changed migrations are not declared: {sorted(changed_migrations - declared_migrations)}")
        if migrations and "migration" not in scopes:
            errors.append("changed migrations require an actually executed migration-scope acceptance receipt")

    expected_requirements = set(BY_ID[expected_batch]["requirement_ids"])
    trace_map: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(traceability):
        if not isinstance(item, dict):
            errors.append(f"traceability[{index}] must be an object")
            continue
        requirement = item.get("requirement_id")
        if not isinstance(requirement, str) or requirement in trace_map:
            errors.append(f"duplicate or invalid traceability item: {requirement}")
            continue
        trace_map[requirement] = item
        source_contents: list[bytes] = []
        sources = item.get("source_files")
        for source in sources if isinstance(sources, list) else []:
            if result_commit:
                try:
                    source_contents.append(commit_file(repo, result_commit, str(source), f"traceability {requirement}.source_files"))
                except TrustError as exc:
                    errors.append(str(exc))
        if not source_contents:
            errors.append(f"traceability {requirement}.source_files must resolve in result commit")
        combined = b"\n".join(source_contents)
        symbols = item.get("symbols")
        if not isinstance(symbols, list) or not symbols:
            errors.append(f"traceability {requirement}.symbols must be non-empty")
        else:
            for symbol in symbols:
                if not isinstance(symbol, str) or not symbol.strip() or symbol.lower() in {"replace-me", "placeholder", "n/a"}:
                    errors.append(f"traceability {requirement} contains an invalid symbol: {symbol}")
                elif symbol.encode("utf-8") not in combined:
                    errors.append(f"traceability {requirement} symbol is absent from result commit: {symbol}")
        mapped_tests = item.get("tests")
        if not isinstance(mapped_tests, list) or not mapped_tests:
            errors.append(f"traceability {requirement}.tests must be non-empty")
        else:
            for test_name in mapped_tests:
                if test_name not in test_names:
                    errors.append(f"traceability {requirement} references an undeclared test: {test_name}")
        mapped_evidence = item.get("evidence")
        if not isinstance(mapped_evidence, list) or not mapped_evidence:
            errors.append(f"traceability {requirement}.evidence must be non-empty")
        else:
            for evidence_path in mapped_evidence:
                evidence_record = evidence_by_path.get(str(evidence_path))
                if evidence_record is None:
                    errors.append(f"traceability {requirement} references undeclared evidence: {evidence_path}")
                elif requirement not in evidence_record.get("supports", []):
                    errors.append(f"traceability {requirement} references evidence that does not support it: {evidence_path}")
    if set(trace_map) != expected_requirements:
        errors.append(f"traceability set mismatch: expected {sorted(expected_requirements)}, got {sorted(trace_map)}")
    if not expected_requirements.issubset(supported_requirements):
        errors.append(f"evidence does not support all requirements: {sorted(expected_requirements - supported_requirements)}")

    for index, risk in enumerate(risks):
        if not isinstance(risk, dict):
            errors.append(f"risks[{index}] must be an object")
            continue
        if risk.get("disposition") == "blocked":
            errors.append(f"risks[{index}] is unresolved and blocks passing")
        if risk.get("disposition") == "accepted":
            if not isinstance(risk.get("owner"), str) or not risk["owner"].strip():
                errors.append(f"risks[{index}] accepted risk requires an owner")
            expires = validate_datetime(risk.get("expires_at"), f"risks[{index}].expires_at", errors)
            if expires and expires <= datetime.now(timezone.utc):
                errors.append(f"risks[{index}] acceptance is expired")
            if risk.get("severity") in {"critical", "high"}:
                errors.append(f"risks[{index}] critical/high risk cannot pass on self-accepted evidence")
    return errors, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--batch", choices=TOPO)
    target.add_argument("--all", action="store_true")
    parser.add_argument("--report", type=Path, help="Completion report path for --batch")
    parser.add_argument("--reports-dir", type=Path, help="Default: evidence/completion")
    parser.add_argument("--orchestration-state", type=Path)
    parser.add_argument("--receipt-index", type=Path, help="Current execution receipt; only valid with --batch")
    parser.add_argument("--issue-certificate", type=Path)
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        print(f"ERROR: invalid repository: {repo}", file=sys.stderr)
        return 2
    state_errors: list[str] = []
    _state_path, state = load_state(repo, args.orchestration_state, state_errors)
    selected = TOPO if args.all else [args.batch]
    if args.receipt_index and len(selected) != 1:
        print("ERROR: --receipt-index is only valid with --batch", file=sys.stderr)
        return 2
    try:
        reports_dir = repository_path(repo, str(args.reports_dir or "evidence/completion"), "reports directory", must_exist=True)
    except TrustError as exc:
        if args.report and len(selected) == 1:
            reports_dir = repo
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
    report_hashes: dict[str, str] = {}
    report_commits: dict[str, str] = {}
    all_errors: list[str] = list(state_errors)
    for batch_id in selected:
        try:
            if args.report and len(selected) == 1:
                report_path = repository_path(repo, str(args.report), "completion report", regular_file=True)
            else:
                report_path = repository_path(repo, str(reports_dir / f"{batch_id}.json"), "completion report", regular_file=True)
        except TrustError as exc:
            all_errors.append(f"{batch_id}: {exc}")
            continue
        receipt_index: Path | None = None
        if args.receipt_index:
            try:
                receipt_index = repository_path(repo, str(args.receipt_index), "receipt index", regular_file=True)
            except TrustError as exc:
                all_errors.append(f"{batch_id}: {exc}")
        errors, report = validate_report(repo, report_path, batch_id, state=state, receipt_index=receipt_index)
        if errors:
            all_errors.extend(f"{batch_id}: {error}" for error in errors)
        elif report is not None:
            report_hashes[batch_id] = sha256_file(report_path)
            report_commits[batch_id] = str(report["result_commit"])
            print(f"PASS {batch_id} {report_path}")
    if all_errors:
        for error in all_errors:
            print(f"FAIL {error}", file=sys.stderr)
        print(f"Verification failed with {len(all_errors)} error(s).", file=sys.stderr)
        return 1
    if args.issue_certificate:
        try:
            requested = args.issue_certificate.expanduser()
            if requested.is_absolute():
                relative_path = requested.resolve(strict=False).relative_to(repo)
            else:
                relative_path = requested
            if not relative_path.parts or any(part in {"", ".", ".."} for part in relative_path.parts):
                raise TrustError("certificate output must be a repository-relative non-traversing file")
            if relative_path.parent != Path("."):
                ensure_output_directory(repo, relative_path.parent.as_posix())
            relative = relative_path.as_posix()
            certificate_path = repository_path(repo, relative, "certificate output", must_exist=False)
            certificate = {
                "schema_version": "ltm.release-certificate.v2",
                "package": PACKAGE["name"],
                "package_version": PACKAGE["version"],
                "status": "EVIDENCE_PENDING",
                "scope": selected,
                "repository": str(repo),
                "report_sha256": report_hashes,
                "result_commits": report_commits,
                "productionReleaseApproved": False,
                "externalCertification": "NOT_CERTIFIED",
                "independent_signature": None,
                "blocking_reason": "No trusted independent signing authority was provided",
                "issued_at": datetime.now(timezone.utc).isoformat(),
                "verifier": str(Path(__file__).resolve()),
            }
            atomic_write_bytes(repo, relative, json.dumps(certificate, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n")
        except (TrustError, OSError) as exc:
            print(f"ERROR: cannot write pending certificate record: {exc}", file=sys.stderr)
            return 1
        print(f"EVIDENCE_PENDING: {certificate_path}", file=sys.stderr)
        print("Independent signature is required; no production certificate was issued.", file=sys.stderr)
        return 3
    print(f"Verified {len(selected)} Batch report(s) against trusted execution receipts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
