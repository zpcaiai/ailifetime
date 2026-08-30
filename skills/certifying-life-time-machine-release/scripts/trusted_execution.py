#!/usr/bin/env python3
"""Shared fail-closed primitives for Factory command and Git evidence.

This module intentionally uses only the Python standard library.  Acceptance
commands are argv arrays executed without a shell, against an immutable commit
in a detached temporary worktree.
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
from pathlib import Path
from typing import Any, Iterable


RECEIPT_SCHEMA = "ltm.command-receipt.v1"
BUNDLE_SCHEMA = "ltm.execution-receipt.v1"
ENVIRONMENT_POLICY = "ltm.clean-environment.v1"
ALLOWED_TOOLS = frozenset({
    "bun", "cargo", "deno", "go", "gradle", "gradlew", "java", "javac",
    "git", "make", "mvn", "mvnw", "node", "npm", "pnpm", "py.test",
    "pytest", "python", "python3", "uv", "yarn",
})
INLINE_CODE_OPTIONS = {
    "node": {"-e", "--eval", "-p", "--print"},
    "python": {"-c"},
    "python3": {"-c"},
}
PACKAGE_EXEC_OPTIONS = {
    "npm": {"exec", "x"},
    "pnpm": {"dlx", "exec"},
    "yarn": {"dlx", "exec"},
}
READ_ONLY_GIT_COMMANDS = frozenset({"diff", "grep", "ls-files", "rev-parse", "show", "status"})


class TrustError(RuntimeError):
    """Raised when an evidence or execution trust boundary is violated."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(repo: Path, *args: str, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def git_text(repo: Path, *args: str) -> str:
    result = git(repo, *args)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise TrustError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout.decode("utf-8", errors="strict").strip()


def resolve_commit(repo: Path, value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or any(character.isspace() for character in value):
        raise TrustError(f"{label} must be a non-empty Git revision without whitespace")
    resolved = git_text(repo, "rev-parse", "--verify", f"{value}^{{commit}}")
    if not _is_hex_sha(resolved):
        raise TrustError(f"{label} did not resolve to a full commit SHA")
    return resolved


def commit_tree(repo: Path, commit: str) -> str:
    tree = git_text(repo, "rev-parse", "--verify", f"{commit}^{{tree}}")
    if not _is_hex_sha(tree):
        raise TrustError("Git tree did not resolve to a full object SHA")
    return tree


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return git(repo, "merge-base", "--is-ancestor", ancestor, descendant).returncode == 0


def parse_command(value: str) -> list[str]:
    if not isinstance(value, str) or not value.strip():
        raise TrustError("Acceptance command must be non-empty")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        try:
            decoded = shlex.split(value, posix=True)
        except ValueError as exc:
            raise TrustError(f"Acceptance command cannot be parsed as argv: {exc}") from exc
    if not isinstance(decoded, list) or not decoded or not all(isinstance(item, str) for item in decoded):
        raise TrustError("Acceptance command must decode to a non-empty string argv array")
    argv = list(decoded)
    if any(not item or "\x00" in item or "\n" in item or "\r" in item for item in argv):
        raise TrustError("Acceptance argv contains an empty, NUL, or newline argument")
    validate_argv_policy(argv)
    return argv


def canonical_argv(argv: Iterable[str]) -> str:
    return json.dumps(list(argv), ensure_ascii=False, separators=(",", ":"))


def argv_sha256(argv: Iterable[str]) -> str:
    return sha256_bytes(canonical_json_bytes(list(argv)))


def validate_argv_policy(argv: list[str]) -> None:
    executable = argv[0]
    if Path(executable).is_absolute():
        raise TrustError("Acceptance command executable must be allowlisted or repository-relative, not absolute")
    if "/" in executable:
        if not executable.startswith("./") or executable.startswith("./../"):
            raise TrustError("Repository acceptance executable must use a ./ path inside the checkout")
    elif executable not in ALLOWED_TOOLS:
        raise TrustError(f"Acceptance executable is not allowlisted: {executable}")
    name = Path(executable).name
    forbidden_inline = INLINE_CODE_OPTIONS.get(name, set())
    if any(argument in forbidden_inline for argument in argv[1:]):
        raise TrustError(f"Inline code execution is forbidden for acceptance tool {name}")
    if len(argv) > 1 and argv[1] in PACKAGE_EXEC_OPTIONS.get(name, set()):
        raise TrustError(f"Dynamic package execution is forbidden for acceptance tool {name}")
    if name == "git" and (len(argv) < 2 or argv[1] not in READ_ONLY_GIT_COMMANDS):
        raise TrustError("Acceptance git commands are limited to read-only subcommands")


def command_spec(value: str) -> dict[str, Any]:
    argv = parse_command(value)
    return {
        "argv": argv,
        "canonical_argv": canonical_argv(argv),
        "argv_sha256": argv_sha256(argv),
    }


def reject_symlink(path: Path, label: str) -> None:
    try:
        if stat.S_ISLNK(path.lstat().st_mode):
            raise TrustError(f"{label} must not be a symbolic link: {path}")
    except FileNotFoundError as exc:
        raise TrustError(f"{label} does not exist: {path}") from exc


def repository_path(
    root: Path,
    value: str,
    label: str,
    *,
    must_exist: bool = True,
    regular_file: bool = False,
) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise TrustError(f"{label} must be a non-empty path")
    root = root.resolve()
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        if candidate.is_symlink():
            raise TrustError(f"{label} contains a symbolic link: {value}")
        # macOS commonly exposes /var as a symlink to /private/var.  Normalize
        # only the caller's absolute prefix, then reconstruct the path below
        # the already trusted repository root so in-repository symlinks are
        # still inspected component by component below.
        canonical_candidate = candidate.resolve(strict=False)
        try:
            relative_candidate = canonical_candidate.relative_to(root)
        except ValueError as exc:
            raise TrustError(f"{label} escapes repository root: {value}") from exc
        lexical = root / relative_candidate
    else:
        lexical = Path(os.path.abspath(root / candidate))
    try:
        lexical.relative_to(root)
    except ValueError as exc:
        raise TrustError(f"{label} escapes repository root: {value}") from exc
    current = root
    parts = lexical.relative_to(root).parts
    for index, part in enumerate(parts):
        current = current / part
        exists = current.exists() or current.is_symlink()
        if exists and current.is_symlink():
            raise TrustError(f"{label} contains a symbolic link: {value}")
        if not exists and (must_exist or index < len(parts) - 1):
            raise TrustError(f"{label} does not exist: {value}")
    if must_exist and not lexical.exists():
        raise TrustError(f"{label} does not exist: {value}")
    if regular_file and (not lexical.is_file() or lexical.is_symlink()):
        raise TrustError(f"{label} must be a regular non-symlink file: {value}")
    return lexical


def ensure_output_directory(root: Path, relative: str) -> Path:
    root = root.resolve()
    current = root
    for part in Path(relative).parts:
        if part in {"", ".", ".."}:
            raise TrustError(f"Unsafe output directory component: {part!r}")
        current = current / part
        if current.exists() or current.is_symlink():
            if current.is_symlink() or not current.is_dir():
                raise TrustError(f"Evidence output directory is not a real directory: {current}")
        else:
            current.mkdir(mode=0o700)
    return current


def atomic_write_bytes(root: Path, relative: str, payload: bytes) -> Path:
    target = repository_path(root, relative, "evidence output", must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    repository_path(root, str(target.parent.relative_to(root)), "evidence output parent", regular_file=False)
    if target.exists() or target.is_symlink():
        raise TrustError(f"Evidence output already exists; refusing stale overwrite: {target}")
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    os.replace(temporary, target)
    return target


def changed_files(repo: Path, base_commit: str, result_commit: str) -> list[dict[str, str]]:
    result = git(repo, "diff", "--name-status", "-z", "--find-renames", base_commit, result_commit)
    if result.returncode != 0:
        raise TrustError(result.stderr.decode("utf-8", errors="replace").strip() or "git diff failed")
    fields = result.stdout.split(b"\x00")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[dict[str, str]] = []
    index = 0
    while index < len(fields):
        status_value = fields[index].decode("utf-8", errors="strict")
        index += 1
        if not status_value:
            raise TrustError("Git diff returned an empty status")
        code = status_value[0]
        if code in {"R", "C"}:
            if index + 1 >= len(fields):
                raise TrustError("Git rename record is truncated")
            old_path = fields[index].decode("utf-8", errors="strict")
            new_path = fields[index + 1].decode("utf-8", errors="strict")
            index += 2
            changes.append({"path": new_path, "old_path": old_path, "change": "renamed"})
            continue
        if index >= len(fields):
            raise TrustError("Git change record is truncated")
        path = fields[index].decode("utf-8", errors="strict")
        index += 1
        mapped = {"A": "added", "M": "modified", "D": "deleted", "T": "modified"}.get(code)
        if mapped is None:
            raise TrustError(f"Unsupported Git diff status: {status_value}")
        changes.append({"path": path, "change": mapped})
    return changes


def commit_file(repo: Path, commit: str, value: str, label: str) -> bytes:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or "\x00" in value:
        raise TrustError(f"{label} must be a repository-relative path")
    normalized = Path(value).as_posix()
    if normalized == "." or normalized.startswith("../") or "/../" in f"/{normalized}":
        raise TrustError(f"{label} escapes repository tree: {value}")
    listing = git(repo, "ls-tree", "-z", commit, "--", normalized)
    if listing.returncode != 0 or not listing.stdout:
        raise TrustError(f"{label} is absent from result commit: {value}")
    metadata, separator, _name = listing.stdout.partition(b"\t")
    if not separator:
        raise TrustError(f"{label} has invalid Git tree metadata: {value}")
    fields = metadata.decode("ascii", errors="strict").split()
    if len(fields) != 3 or fields[0] == "120000" or fields[1] != "blob":
        raise TrustError(f"{label} must be a regular non-symlink file in result commit: {value}")
    content = git(repo, "show", f"{commit}:{normalized}")
    if content.returncode != 0:
        raise TrustError(f"Unable to read {label} from result commit: {value}")
    return content.stdout


def worktree_registration(repo: Path, worktree: Path) -> dict[str, str]:
    reject_symlink(worktree, "worktree")
    target = worktree.resolve()
    output = git_text(repo, "worktree", "list", "--porcelain")
    for paragraph in output.split("\n\n"):
        record: dict[str, str] = {}
        for line in paragraph.splitlines():
            key, _, value = line.partition(" ")
            record[key] = value
        if record.get("worktree") and Path(record["worktree"]).resolve() == target:
            return record
    raise TrustError(f"Path is not a registered Git worktree for repository: {worktree}")


def validate_worktree(
    repo: Path,
    worktree: Path,
    branch: str,
    expected_head: str | None,
    *,
    require_clean: bool,
) -> dict[str, str]:
    registration = worktree_registration(repo, worktree)
    common_from_repo = Path(git_text(repo, "rev-parse", "--git-common-dir"))
    if not common_from_repo.is_absolute():
        common_from_repo = repo / common_from_repo
    common_from_worktree = Path(git_text(worktree, "rev-parse", "--git-common-dir"))
    if not common_from_worktree.is_absolute():
        common_from_worktree = worktree / common_from_worktree
    if common_from_repo.resolve() != common_from_worktree.resolve():
        raise TrustError("Worktree belongs to a different Git common directory")
    actual_branch = git_text(worktree, "symbolic-ref", "--quiet", "HEAD")
    if actual_branch != f"refs/heads/{branch}":
        raise TrustError(f"Worktree branch mismatch: expected {branch}, got {actual_branch}")
    head = resolve_commit(worktree, "HEAD", "worktree HEAD")
    if expected_head is not None and head != expected_head:
        raise TrustError(f"Worktree HEAD mismatch: expected {expected_head}, got {head}")
    status_output = git(worktree, "status", "--porcelain=v1", "--untracked-files=all")
    if status_output.returncode != 0:
        raise TrustError("Unable to inspect worktree status")
    clean = not status_output.stdout
    if require_clean and not clean:
        raise TrustError("Worktree must be clean, including untracked files")
    return {
        "path": str(worktree.resolve()),
        "branch": branch,
        "head": head,
        "clean": str(clean).lower(),
        "registration_head": registration.get("HEAD", ""),
    }


def resolve_executable(argv: list[str], checkout: Path) -> dict[str, Any]:
    validate_argv_policy(argv)
    executable = argv[0]
    if executable.startswith("./"):
        path = repository_path(checkout, executable, "acceptance executable", regular_file=True)
        if not os.access(path, os.X_OK):
            raise TrustError(f"Repository acceptance executable is not executable: {executable}")
        return {
            "kind": "repository",
            "path": executable,
            "resolved_path": str(path),
            "sha256": sha256_file(path),
        }
    located = shutil.which(executable)
    if located is None:
        raise TrustError(f"Allowlisted acceptance executable is unavailable: {executable}")
    resolved = Path(located).resolve()
    if not resolved.is_file():
        raise TrustError(f"Acceptance executable is not a regular file: {resolved}")
    return {
        "kind": "system",
        "path": executable,
        "resolved_path": str(resolved),
        "sha256": sha256_file(resolved),
    }


def clean_environment(root: Path, executable_directories: Iterable[str]) -> dict[str, str]:
    home = root / "home"
    temporary = root / "tmp"
    cache = root / "cache"
    for directory in (home, temporary, cache):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path_entries: list[str] = []
    for value in [*executable_directories, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]:
        if value and value not in path_entries and Path(value).is_dir():
            path_entries.append(value)
    return {
        "CI": "true",
        "COREPACK_HOME": str(cache / "corepack"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": os.pathsep.join(path_entries),
        "TMPDIR": str(temporary),
        "TZ": "UTC",
        "XDG_CACHE_HOME": str(cache / "xdg"),
        "npm_config_cache": str(cache / "npm"),
    }


def _is_hex_sha(value: str) -> bool:
    return len(value) in {40, 64} and all(character in "0123456789abcdef" for character in value)
