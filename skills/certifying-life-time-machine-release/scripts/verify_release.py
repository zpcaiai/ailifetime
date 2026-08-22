#!/usr/bin/env python3
"""Fail-closed verification of batch completion reports and release evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE = json.loads((PACKAGE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BATCHES = json.loads((PACKAGE_ROOT / "manifests/batches.json").read_text(encoding="utf-8"))
BY_ID = {item["id"]: item for item in BATCHES}
TOPO = json.loads((PACKAGE_ROOT / "manifests/topological-order.json").read_text(encoding="utf-8"))
SOURCE_SUFFIXES = {".py", ".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".sh", ".yaml", ".yml"}
PLACEHOLDER_PATTERNS = (
    re.compile(r"\bTODO\b", re.IGNORECASE),
    re.compile(r"\bFIXME\b", re.IGNORECASE),
    re.compile(r"NotImplementedError"),
    re.compile(r"UnsupportedOperationException"),
    re.compile(r"throw\s+new\s+Error\s*\(\s*['\"](?:TODO|not implemented)", re.IGNORECASE),
)
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_path(repo: Path, value: str, errors: list[str], label: str) -> Path | None:
    candidate = Path(value).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (repo / candidate).resolve()
    try:
        resolved.relative_to(repo)
    except ValueError:
        errors.append(f"{label} escapes repository root: {value}")
        return None
    return resolved


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=False)


def is_git_repo(repo: Path) -> bool:
    return git(repo, "rev-parse", "--is-inside-work-tree").returncode == 0


def validate_datetime(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, str):
        errors.append(f"{label} must be an ISO date-time string")
        return
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{label} is not a valid ISO date-time: {value}")


def validate_report(repo: Path, report_path: Path, expected_batch: str) -> tuple[list[str], dict | None]:
    errors: list[str] = []
    if not report_path.is_file():
        return [f"report not found: {report_path}"], None
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"invalid report JSON {report_path}: {exc}"], None
    if not isinstance(report, dict):
        return [f"report must be an object: {report_path}"], None

    def require(key: str, kind=None):
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
    require("base_commit")
    result_commit = require("result_commit")
    validate_datetime(require("started_at"), "started_at", errors)
    validate_datetime(require("completed_at"), "completed_at", errors)
    agent = require("agent", dict)
    dependencies = require("dependencies", list) or []
    changed_files = require("changed_files", list) or []
    require("entrypoints", list)
    tests = require("tests", list) or []
    evidence = require("evidence", list) or []
    traceability = require("traceability", list) or []
    require("risks", list)
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
    if not isinstance(result_commit, str) or len(result_commit) < 7:
        errors.append("result_commit must be a commit identifier of at least 7 characters")
    if agent is not None:
        if agent.get("host") not in {"claude-code", "codex", "human", "other"}:
            errors.append("agent.host is invalid")
        if not agent.get("session_id"):
            errors.append("agent.session_id is required")
    blockers = report.get("blockers", [])
    if blockers:
        errors.append("passed report must have no blockers")
    for key in ("no_placeholders", "no_skipped_required_tests", "no_fake_evidence", "no_real_customer_media", "no_secrets", "clean_room_reproducible"):
        if assertions.get(key) is not True:
            errors.append(f"assertions.{key} must be true")

    expected_deps = set(BY_ID[expected_batch]["depends_on"])
    seen_deps: set[str] = set()
    for index, dep in enumerate(dependencies):
        if not isinstance(dep, dict):
            errors.append(f"dependencies[{index}] must be an object")
            continue
        dep_id = dep.get("batch_id")
        if dep_id in seen_deps:
            errors.append(f"duplicate dependency record: {dep_id}")
        seen_deps.add(dep_id)
        if dep_id not in expected_deps:
            errors.append(f"unexpected dependency record: {dep_id}")
        if dep.get("status") != "passed":
            errors.append(f"dependency {dep_id} status must be passed")
        dep_path = safe_path(repo, str(dep.get("report_path", "")), errors, f"dependency {dep_id} report")
        if dep_path and dep_path.is_file():
            actual = sha256(dep_path)
            if dep.get("sha256") != actual:
                errors.append(f"dependency {dep_id} report hash mismatch")
            try:
                dep_report = json.loads(dep_path.read_text(encoding="utf-8"))
                if dep_report.get("batch_id") != dep_id or dep_report.get("status") != "passed":
                    errors.append(f"dependency {dep_id} report content is not passing")
            except (OSError, json.JSONDecodeError):
                errors.append(f"dependency {dep_id} report is invalid JSON")
        elif dep_path:
            errors.append(f"dependency {dep_id} report not found: {dep_path}")
    if seen_deps != expected_deps:
        errors.append(f"dependency set mismatch: expected {sorted(expected_deps)}, got {sorted(seen_deps)}")

    evidence_by_path: dict[str, dict] = {}
    supported_requirements: set[str] = set()
    for index, item in enumerate(evidence):
        if not isinstance(item, dict):
            errors.append(f"evidence[{index}] must be an object")
            continue
        value = item.get("path")
        path = safe_path(repo, str(value or ""), errors, f"evidence[{index}]")
        if path and path.is_file():
            actual = sha256(path)
            if item.get("sha256") != actual:
                errors.append(f"evidence hash mismatch: {value}")
        elif path:
            errors.append(f"evidence file not found: {value}")
        if item.get("contains_sensitive_data") is True:
            errors.append(f"release evidence must not contain sensitive data: {value}")
        supports = item.get("supports")
        if not isinstance(supports, list) or not supports:
            errors.append(f"evidence supports must be non-empty: {value}")
        else:
            supported_requirements.update(str(req) for req in supports)
        if value in evidence_by_path:
            errors.append(f"duplicate evidence path: {value}")
        elif value:
            evidence_by_path[str(value)] = item
        validate_datetime(item.get("created_at"), f"evidence[{index}].created_at", errors)

    if not tests:
        errors.append("at least one test result is required")
    scopes = set()
    for index, test in enumerate(tests):
        if not isinstance(test, dict):
            errors.append(f"tests[{index}] must be an object")
            continue
        scopes.add(test.get("scope"))
        if test.get("status") != "passed" or test.get("exit_code") != 0:
            errors.append(f"test must pass with exit_code=0: {test.get('name', index)}")
        command = test.get("command")
        if not isinstance(command, str) or not command.strip():
            errors.append(f"test command missing: tests[{index}]")
        artifact = test.get("artifact")
        artifact_path = safe_path(repo, str(artifact or ""), errors, f"tests[{index}].artifact")
        if artifact_path and not artifact_path.is_file():
            errors.append(f"test artifact not found: {artifact}")
    if not ({"unit", "integration", "contract", "e2e", "negative", "security", "privacy"} & scopes):
        errors.append("test evidence must include at least one substantive scope")

    expected_requirements = set(BY_ID[expected_batch]["requirement_ids"])
    trace_map: dict[str, dict] = {}
    for index, item in enumerate(traceability):
        if not isinstance(item, dict):
            errors.append(f"traceability[{index}] must be an object")
            continue
        req = item.get("requirement_id")
        if req in trace_map:
            errors.append(f"duplicate traceability item: {req}")
        elif req:
            trace_map[str(req)] = item
        for field in ("source_files", "symbols", "tests", "evidence"):
            if not isinstance(item.get(field), list) or not item.get(field):
                errors.append(f"traceability {req}.{field} must be non-empty")
        for evidence_path in item.get("evidence", []):
            if evidence_path not in evidence_by_path:
                errors.append(f"traceability {req} references undeclared evidence: {evidence_path}")
    if set(trace_map) != expected_requirements:
        errors.append(f"traceability set mismatch: expected {sorted(expected_requirements)}, got {sorted(trace_map)}")
    if not expected_requirements.issubset(supported_requirements):
        missing = sorted(expected_requirements - supported_requirements)
        errors.append(f"evidence does not support all requirements: {missing}")

    changed_paths: list[Path] = []
    for index, item in enumerate(changed_files):
        if not isinstance(item, dict) or item.get("change") not in {"added", "modified", "deleted", "renamed"}:
            errors.append(f"changed_files[{index}] is invalid")
            continue
        path = safe_path(repo, str(item.get("path", "")), errors, f"changed_files[{index}]")
        if path and item.get("change") != "deleted":
            if not path.exists():
                errors.append(f"changed file not found: {item.get('path')}")
            elif path.is_file():
                changed_paths.append(path)
    if not changed_files:
        errors.append("changed_files must be non-empty for a passing implementation batch")

    for path in changed_paths:
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        relative = path.relative_to(repo)
        if any(part in {"test", "tests", "__tests__", "fixtures", "evidence", "generated", "vendor", "node_modules"} for part in relative.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            errors.append(f"cannot scan {relative}: {exc}")
            continue
        for pattern in PLACEHOLDER_PATTERNS:
            if pattern.search(text):
                errors.append(f"production placeholder detected in {relative}: {pattern.pattern}")
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                errors.append(f"possible secret detected in {relative}: {pattern.pattern}")

    if is_git_repo(repo) and isinstance(result_commit, str):
        if git(repo, "cat-file", "-e", f"{result_commit}^{{commit}}").returncode != 0:
            errors.append(f"result_commit does not exist in repository: {result_commit}")
    return errors, report


def report_path_for(repo: Path, reports_dir: Path, batch_id: str) -> Path:
    return reports_dir / f"{batch_id}.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--batch", choices=TOPO)
    target.add_argument("--all", action="store_true")
    parser.add_argument("--report", type=Path, help="Completion report path for --batch")
    parser.add_argument("--reports-dir", type=Path, help="Default: evidence/completion")
    parser.add_argument("--issue-certificate", type=Path)
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        print(f"ERROR: invalid repository: {repo}", file=sys.stderr)
        return 2
    reports_dir = (args.reports_dir.expanduser().resolve() if args.reports_dir else repo / "evidence/completion")
    selected = TOPO if args.all else [args.batch]
    report_hashes: dict[str, str] = {}
    all_errors: list[str] = []
    for batch_id in selected:
        if args.report and len(selected) == 1:
            report_path = args.report.expanduser()
            report_path = report_path.resolve() if report_path.is_absolute() else (repo / report_path).resolve()
        else:
            report_path = report_path_for(repo, reports_dir, batch_id)
        errors, _ = validate_report(repo, report_path, batch_id)
        if errors:
            all_errors.extend(f"{batch_id}: {error}" for error in errors)
        else:
            report_hashes[batch_id] = sha256(report_path)
            print(f"PASS {batch_id} {report_path}")
    if all_errors:
        for error in all_errors:
            print(f"FAIL {error}", file=sys.stderr)
        print(f"Verification failed with {len(all_errors)} error(s).", file=sys.stderr)
        return 1
    if args.issue_certificate:
        certificate_path = args.issue_certificate.expanduser()
        certificate_path = certificate_path.resolve() if certificate_path.is_absolute() else (repo / certificate_path).resolve()
        certificate_path.parent.mkdir(parents=True, exist_ok=True)
        head = git(repo, "rev-parse", "HEAD").stdout.strip() if is_git_repo(repo) else "unknown"
        certificate = {
            "schema_version": "1.0",
            "package": PACKAGE["name"],
            "package_version": PACKAGE["version"],
            "status": "passed",
            "scope": selected,
            "repository": str(repo),
            "repository_commit": head,
            "issued_at": datetime.now(timezone.utc).isoformat(),
            "report_sha256": report_hashes,
            "verifier": str(Path(__file__).resolve()),
        }
        certificate_path.write_text(json.dumps(certificate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Certificate: {certificate_path}")
    print(f"Verified {len(selected)} batch report(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
