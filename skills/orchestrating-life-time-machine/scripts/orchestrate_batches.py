#!/usr/bin/env python3
"""Deterministically coordinate B00-B127 across Claude Code/Codex worktrees."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

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


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def git_output(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


@contextlib.contextmanager
def lock_state(path: Path, timeout_seconds: float = 10.0) -> Iterator[None]:
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
    return json.loads(path.read_text(encoding="utf-8"))


def refresh_ready(state: dict) -> None:
    for batch_id in TOPO:
        record = state["batches"][batch_id]
        if record["state"] == "certified":
            record["state"] = "factory_attested"
        if record["state"] not in {"planned", "ready"}:
            continue
        deps = BY_ID[batch_id]["depends_on"]
        record["state"] = "ready" if all(state["batches"][dep]["state"] in DONE_STATES for dep in deps) else "planned"
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
        })
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    print("Scope: CODE_IMPLEMENTATION_WORKFLOW_ONLY; production certification is separate and evidence-gated")
    print(f"{'ID':<4} {'STATE':<18} {'PHASE':<18} TITLE")
    for row in rows:
        print(f"{row['id']:<4} {row['state']:<18} {row['phase']:<18} {row['title']}")


def resolve_report(repo: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (repo / candidate).resolve()


def verify_report(repo: Path, batch_id: str, report: Path) -> None:
    verifier = PACKAGE_ROOT / "scripts/verify_release.py"
    result = subprocess.run(
        [sys.executable, str(verifier), "--repo", str(repo), "--batch", batch_id, "--report", str(report)],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Completion report verification failed for {batch_id}")


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
    start = commands.add_parser("start")
    start.add_argument("batch_id", choices=TOPO)
    start.add_argument("--owner", required=True)
    start.add_argument("--worktree", required=True)
    start.add_argument("--branch", required=True)
    start.add_argument("--lease-minutes", type=int, default=120)
    finish = commands.add_parser("finish")
    finish.add_argument("batch_id", choices=TOPO)
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
    state_path = (args.state.expanduser().resolve() if args.state else repo / ".ai-life-time-machine/state/orchestration.json")
    try:
        with lock_state(state_path):
            if args.command == "init":
                if state_path.exists() and not args.force:
                    raise RuntimeError(f"State already exists: {state_path}; use --force to reset")
                state = {
                    "schema_version": "1.0",
                    "package_version": PACKAGE_MANIFEST["version"],
                    "repo_root": str(repo),
                    "base_commit": git_output(repo, "rev-parse", "HEAD"),
                    "updated_at": now(),
                    "batches": {
                        batch_id: {
                            "state": "planned",
                            "worktree": None,
                            "branch": None,
                            "lease_owner": None,
                            "lease_expires_at": None,
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
            refresh_ready(state)
            if args.command in {"status", "ready"}:
                atomic_json(state_path, state)
                print_rows(state, only_ready=args.command == "ready", as_json=args.json)
                return 0

            batch_id = args.batch_id
            record = state["batches"][batch_id]
            if args.command == "worktree-plan":
                if record["state"] != "ready":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not ready")
                branch = f"feat/ai-life-time-machine-{batch_id.lower()}"
                worktree = repo.parent / f"{repo.name}-{batch_id.lower()}"
                base = args.base or state["base_commit"]
                print(f"git -C {repo} worktree add -b {branch} {worktree} {base}")
                print(f"python3 {PACKAGE_ROOT / 'scripts/orchestrate_batches.py'} --repo {repo} start {batch_id} --owner <agent> --worktree {worktree} --branch {branch}")
                return 0
            if args.command == "start":
                if record["state"] != "ready":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not ready")
                if args.lease_minutes <= 0:
                    raise RuntimeError("--lease-minutes must be positive")
                record.update({
                    "state": "running",
                    "worktree": str(Path(args.worktree).expanduser().resolve()),
                    "branch": args.branch,
                    "lease_owner": args.owner,
                    "lease_expires_at": (datetime.now(timezone.utc) + timedelta(minutes=args.lease_minutes)).isoformat(),
                    "notes": None,
                })
            elif args.command == "finish":
                if record["state"] != "running":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not running")
                report = resolve_report(repo, args.report)
                verify_report(repo, batch_id, report)
                record["state"] = "review"
                record["completion_report"] = str(report)
                record["lease_expires_at"] = None
            elif args.command == "mark-merged":
                if record["state"] != "review":
                    raise RuntimeError(f"{batch_id} is {record['state']}, not review")
                record["state"] = "merged"
                record["notes"] = f"merged_commit={args.commit or git_output(repo, 'rev-parse', 'HEAD')}"
                record["lease_owner"] = None
                record["lease_expires_at"] = None
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
                record["state"] = "factory_attested"
                record["notes"] = f"factory_attestation={certificate};production=NOT_CERTIFIED"
                record["lease_owner"] = None
                record["lease_expires_at"] = None
            elif args.command == "block":
                if record["state"] in DONE_STATES:
                    raise RuntimeError(f"Cannot block completed batch {batch_id}")
                record["state"] = "blocked"
                record["notes"] = args.note
                record["lease_expires_at"] = None
            elif args.command == "reset":
                if record["state"] in DONE_STATES:
                    raise RuntimeError(f"Cannot reset completed batch {batch_id}")
                record.update({
                    "state": "planned",
                    "worktree": None,
                    "branch": None,
                    "lease_owner": None,
                    "lease_expires_at": None,
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
