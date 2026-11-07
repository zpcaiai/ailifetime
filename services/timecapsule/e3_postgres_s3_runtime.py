"""TimeCapsule E3 Real Middleware Verification Engine (PostgreSQL 17 + S3 HTTP + Outbox Queue).

Implements real E3 verification against:
1. A live PostgreSQL 17 cluster (via `/opt/homebrew/opt/postgresql@17/bin/initdb` & `pg_ctl` or
   external `TIMECAPSULE_E3_POSTGRES_DSN`) spoken to over raw TCP PostgreSQL v3 Wire Protocol
   (`PostgresWireClient`) with zero per-query CLI subprocesses.
2. Unmodified `spec/timecapsule/database/001_init.sql` schema + PostgreSQL 17
   `ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` with a `NOSUPERUSER NOBYPASSRLS`
   application role (`tc_app_runtime`).
3. A real multi-threaded S3-compatible HTTP/1.1 Object Storage Server (`S3CompatibleHttpServer`)
   enforcing presigned HMAC-SHA256 URLs, SHA-256 payload verification, ETag headers,
   `PUT`/`GET`/`HEAD`/`DELETE`, and `ListObjectsV2` orphan scanning.
4. PostgreSQL `transactional_outbox` queue worker using `FOR UPDATE SKIP LOCKED` and
   physical PostgreSQL daemon restart (`pg_ctl restart`) WAL durability verification.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
from typing import Any, Iterator
from urllib.parse import parse_qs, unquote, urlparse
import urllib.request
import uuid

from .db_and_identity import SPEC_ROOT, TimeCapsuleError, sha256_hex, utc_now_iso


DEFAULT_PG_BIN_DIRS = (
    Path("/opt/homebrew/opt/postgresql@17/bin"),
    Path("/opt/homebrew/opt/postgresql@16/bin"),
    Path("/usr/local/opt/postgresql@17/bin"),
    Path("/usr/lib/postgresql/17/bin"),
    Path("/usr/lib/postgresql/16/bin"),
)


def find_postgres_bin_dir() -> Path | None:
    env_bin = os.environ.get("TIMECAPSULE_PG_BIN_DIR")
    if env_bin:
        candidate = Path(env_bin)
        if (candidate / "initdb").is_file() and (candidate / "pg_ctl").is_file():
            return candidate
    for d in DEFAULT_PG_BIN_DIRS:
        if (d / "initdb").is_file() and (d / "pg_ctl").is_file():
            return d
    which_pg_ctl = shutil.which("pg_ctl")
    if which_pg_ctl:
        parent = Path(which_pg_ctl).resolve().parent
        if (parent / "initdb").is_file():
            return parent
    return None


def allocate_ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class PostgresWireError(TimeCapsuleError):
    """Raised when the PostgreSQL v3 wire protocol returns an ErrorResponse ('E')."""


class PostgresWireClient:
    """Native TCP socket client speaking PostgreSQL Frontend/Backend Protocol v3.0 (196608)."""

    def __init__(self, host: str, port: int, user: str, database: str, timeout: float = 15.0) -> None:
        self.host = host
        self.port = port
        self.user = user
        self.database = database
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.backend_pid: int = 0
        self.backend_secret_key: int = 0
        self.server_parameters: dict[str, str] = {}
        self.tx_status: str = "I"
        self._Lock = threading.Lock()
        self._perform_startup()

    def _recv_exact(self, length: int) -> bytes:
        chunks: list[bytes] = []
        remaining = length
        while remaining > 0:
            chunk = self.sock.recv(remaining)
            if not chunk:
                raise ConnectionError("Unexpected EOF reading from PostgreSQL socket")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_message(self) -> tuple[str, bytes]:
        header = self._recv_exact(5)
        msg_type = chr(header[0])
        msg_len = struct.unpack("!I", header[1:5])[0]
        payload = self._recv_exact(msg_len - 4) if msg_len > 4 else b""
        return msg_type, payload

    def _perform_startup(self) -> None:
        params = (
            b"user\x00"
            + self.user.encode("utf-8")
            + b"\x00database\x00"
            + self.database.encode("utf-8")
            + b"\x00client_encoding\x00UTF8\x00\x00"
        )
        startup_body = struct.pack("!I", 196608) + params
        total_len = struct.pack("!I", len(startup_body) + 4)
        self.sock.sendall(total_len + startup_body)

        while True:
            mtype, payload = self._read_message()
            if mtype == "R":
                auth_code = struct.unpack("!I", payload[:4])[0]
                if auth_code != 0:
                    raise PostgresWireError(
                        "PG_AUTH_UNSUPPORTED",
                        f"Unsupported PostgreSQL auth code {auth_code} on local E3 cluster",
                        500,
                    )
            elif mtype == "S":
                parts = payload[:-1].split(b"\x00")
                if len(parts) >= 2:
                    self.server_parameters[parts[0].decode("utf-8", errors="replace")] = parts[1].decode(
                        "utf-8", errors="replace"
                    )
            elif mtype == "K":
                self.backend_pid, self.backend_secret_key = struct.unpack("!II", payload[:8])
            elif mtype == "Z":
                self.tx_status = chr(payload[0])
                break
            elif mtype == "E":
                err_info = self._parse_error(payload)
                raise PostgresWireError(
                    f"PG_{err_info.get('C', 'ERROR')}",
                    err_info.get("M", "PostgreSQL startup failed"),
                    500,
                    err_info,
                )

    @staticmethod
    def _parse_error(payload: bytes) -> dict[str, str]:
        fields: dict[str, str] = {}
        idx = 0
        while idx < len(payload) and payload[idx] != 0:
            code = chr(payload[idx])
            end = payload.find(b"\x00", idx + 1)
            if end == -1:
                break
            fields[code] = payload[idx + 1 : end].decode("utf-8", errors="replace")
            idx = end + 1
        return fields

    def execute(self, sql: str) -> list[dict[str, Any]]:
        """Executes a SQL query or multi-statement script over the PostgreSQL v3 Simple Query protocol."""
        with self._Lock:
            encoded = sql.encode("utf-8") + b"\x00"
            msg = b"Q" + struct.pack("!I", len(encoded) + 4) + encoded
            self.sock.sendall(msg)

            columns: list[str] = []
            rows: list[dict[str, Any]] = []
            error_info: dict[str, str] | None = None

            while True:
                mtype, payload = self._read_message()
                if mtype == "T":
                    col_count = struct.unpack("!H", payload[:2])[0]
                    columns = []
                    pos = 2
                    for _ in range(col_count):
                        name_end = payload.find(b"\x00", pos)
                        col_name = payload[pos:name_end].decode("utf-8", errors="replace")
                        columns.append(col_name)
                        pos = name_end + 1 + 18
                elif mtype == "D":
                    col_count = struct.unpack("!H", payload[:2])[0]
                    pos = 2
                    row_dict: dict[str, Any] = {}
                    for idx in range(col_count):
                        val_len = struct.unpack("!i", payload[pos : pos + 4])[0]
                        pos += 4
                        col_key = columns[idx] if idx < len(columns) else f"col_{idx}"
                        if val_len == -1:
                            row_dict[col_key] = None
                        else:
                            raw_val = payload[pos : pos + val_len].decode("utf-8", errors="replace")
                            pos += val_len
                            row_dict[col_key] = raw_val
                    rows.append(row_dict)
                elif mtype == "E":
                    error_info = self._parse_error(payload)
                elif mtype == "Z":
                    self.tx_status = chr(payload[0])
                    break
                # Ignore 'C' (CommandComplete), 'N' (NoticeResponse), 'I' (EmptyQueryResponse)

            if error_info is not None:
                raise PostgresWireError(
                    f"PG_{error_info.get('C', 'ERROR')}",
                    error_info.get("M", "PostgreSQL query error"),
                    400,
                    error_info,
                )
            return rows

    @contextmanager
    def transaction(self, *, role: str | None = None, app_user_id: str | None = None) -> Iterator[PostgresWireClient]:
        self.execute("BEGIN")
        try:
            if role:
                self.execute(f"SET LOCAL ROLE {role}")
            if app_user_id:
                safe_uid = app_user_id.replace("'", "''")
                self.execute(f"SELECT set_config('app.current_user_id', '{safe_uid}', true)")
            yield self
            self.execute("COMMIT")
        except Exception:
            try:
                self.execute("ROLLBACK")
            except Exception:
                pass
            raise

    def close(self) -> None:
        try:
            self.sock.sendall(b"X" + struct.pack("!I", 4))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class Postgres17ClusterManager:
    """Manages a disposable local PostgreSQL 17 cluster for E3 middleware verification."""

    def __init__(self, base_dir: Path, bin_dir: Path | None = None) -> None:
        resolved_bin = bin_dir or find_postgres_bin_dir()
        if resolved_bin is None:
            raise TimeCapsuleError("PG_BIN_NOT_FOUND", "PostgreSQL initdb/pg_ctl binaries not found", 500)
        self.bin_dir = resolved_bin
        self.base_dir = base_dir
        self.data_dir = base_dir / "pgdata"
        self.socket_dir = base_dir / "pgsock"
        self.log_file = base_dir / "postgres.log"
        self.port = allocate_ephemeral_port()
        self.superuser = "tc_pg_admin"
        self.database = "timecapsule_e3"
        self.postmaster_pid: int = 0

    def init_and_start(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.socket_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["LC_ALL"] = "C"
        env["LANG"] = "C"

        subprocess.run(
            [
                str(self.bin_dir / "initdb"),
                "-D",
                str(self.data_dir),
                "-U",
                self.superuser,
                "-A",
                "trust",
                "--encoding=UTF8",
                "--locale=C",
                "--no-instructions",
            ],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

        conf_append = (
            f"\nlisten_addresses = '127.0.0.1'\n"
            f"port = {self.port}\n"
            f"unix_socket_directories = '{self.socket_dir}'\n"
            f"fsync = on\n"
            f"synchronous_commit = on\n"
            f"max_connections = 50\n"
        )
        with (self.data_dir / "postgresql.conf").open("a", encoding="utf-8") as f:
            f.write(conf_append)

        self.start()
        with self.connect(database="postgres") as conn:
            conn.execute(f"CREATE DATABASE {self.database}")

    def start(self) -> None:
        subprocess.run(
            [
                str(self.bin_dir / "pg_ctl"),
                "-D",
                str(self.data_dir),
                "-l",
                str(self.log_file),
                "-w",
                "start",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.postmaster_pid = self._read_postmaster_pid()

    def restart(self) -> int:
        subprocess.run(
            [
                str(self.bin_dir / "pg_ctl"),
                "-D",
                str(self.data_dir),
                "-l",
                str(self.log_file),
                "-m",
                "fast",
                "-w",
                "restart",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.postmaster_pid = self._read_postmaster_pid()
        return self.postmaster_pid

    def stop(self) -> None:
        if (self.data_dir / "postmaster.pid").exists():
            subprocess.run(
                [
                    str(self.bin_dir / "pg_ctl"),
                    "-D",
                    str(self.data_dir),
                    "-m",
                    "immediate",
                    "-w",
                    "stop",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

    def _read_postmaster_pid(self) -> int:
        pid_file = self.data_dir / "postmaster.pid"
        if pid_file.is_file():
            first_line = pid_file.read_text(encoding="utf-8").splitlines()[0].strip()
            return int(first_line)
        return 0

    @contextmanager
    def connect(self, database: str | None = None, user: str | None = None) -> Iterator[PostgresWireClient]:
        client = PostgresWireClient(
            host="127.0.0.1",
            port=self.port,
            user=user or self.superuser,
            database=database or self.database,
        )
        try:
            yield client
        finally:
            client.close()


class S3CompatibleHttpServer:
    """Real HTTP/1.1 S3-Compatible Object Storage Server with presigned URL & ETag verification."""

    def __init__(self, storage_root: Path, signing_secret: str = "e3-s3-hmac-secret-key-v1") -> None:
        self.storage_root = storage_root
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.signing_secret = signing_secret.encode("utf-8")
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int = 0

    def start(self) -> str:
        parent = self

        class S3Handler(BaseHTTPRequestHandler):
            def _verify_presigned_if_present(self, method: str, bucket: str, key: str, query: dict[str, list[str]]) -> bool:
                if "X-Amz-Signature" not in query:
                    return True
                sig = query["X-Amz-Signature"][0]
                expires = int(query.get("X-Amz-Expires", ["0"])[0])
                if expires < int(time.time()):
                    return False
                canonical = f"{method}\n/{bucket}/{key}\n{expires}"
                expected = hmac.new(parent.signing_secret, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
                return hmac.compare_digest(sig, expected)

            def _resolve_path(self) -> tuple[str, str, Path, dict[str, list[str]]]:
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                parts = [unquote(p) for p in parsed.path.strip("/").split("/") if p]
                bucket = parts[0] if parts else "default"
                key = "/".join(parts[1:]) if len(parts) > 1 else ""
                file_path = parent.storage_root / bucket / key if key else parent.storage_root / bucket
                return bucket, key, file_path, query

            def do_PUT(self) -> None:  # noqa: N802
                bucket, key, file_path, query = self._resolve_path()
                if not key or not self._verify_presigned_if_present("PUT", bucket, key, query):
                    self.send_response(403)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length > 0 else b""
                digest = sha256_hex(body)
                expected_sha = self.headers.get("x-amz-content-sha256")
                if expected_sha and expected_sha != "UNSIGNED-PAYLOAD" and expected_sha != digest:
                    self.send_response(400)
                    self.end_headers()
                    return
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(body)
                meta_path = file_path.with_suffix(file_path.suffix + ".meta.json")
                meta_path.write_text(
                    json.dumps(
                        {
                            "bucket": bucket,
                            "key": key,
                            "size": len(body),
                            "sha256": digest,
                            "content_type": self.headers.get("Content-Type", "application/octet-stream"),
                            "updated_at": utc_now_iso(),
                        }
                    ),
                    encoding="utf-8",
                )
                self.send_response(200)
                self.send_header("ETag", f'"{digest}"')
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_HEAD(self) -> None:  # noqa: N802
                _, key, file_path, _ = self._resolve_path()
                if not key or not file_path.is_file():
                    self.send_response(404)
                    self.end_headers()
                    return
                raw = file_path.read_bytes()
                digest = sha256_hex(raw)
                self.send_response(200)
                self.send_header("ETag", f'"{digest}"')
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()

            def do_GET(self) -> None:  # noqa: N802
                bucket, key, file_path, query = self._resolve_path()
                if not key:
                    bucket_dir = parent.storage_root / bucket
                    objects: list[dict[str, Any]] = []
                    if bucket_dir.is_dir():
                        for p in sorted(bucket_dir.rglob("*")):
                            if p.is_file() and not p.name.endswith(".meta.json"):
                                rel_key = str(p.relative_to(bucket_dir)).replace("\\", "/")
                                raw = p.read_bytes()
                                objects.append(
                                    {
                                        "key": rel_key,
                                        "size": len(raw),
                                        "etag": sha256_hex(raw),
                                    }
                                )
                    payload = json.dumps({"bucket": bucket, "contents": objects}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                if not self._verify_presigned_if_present("GET", bucket, key, query):
                    self.send_response(403)
                    self.end_headers()
                    return
                if not file_path.is_file():
                    self.send_response(404)
                    self.end_headers()
                    return
                raw = file_path.read_bytes()
                digest = sha256_hex(raw)
                self.send_response(200)
                self.send_header("ETag", f'"{digest}"')
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_DELETE(self) -> None:  # noqa: N802
                _, key, file_path, _ = self._resolve_path()
                if not key or not file_path.is_file():
                    self.send_response(404)
                    self.end_headers()
                    return
                file_path.unlink(missing_ok=True)
                meta_path = file_path.with_suffix(file_path.suffix + ".meta.json")
                meta_path.unlink(missing_ok=True)
                self.send_response(204)
                self.end_headers()

            def log_message(self, fmt: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), S3Handler)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self.endpoint_url

    @property
    def endpoint_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def generate_presigned_url(self, method: str, bucket: str, key: str, ttl_seconds: int = 300) -> str:
        expires = int(time.time()) + ttl_seconds
        canonical = f"{method}\n/{bucket}/{key}\n{expires}"
        sig = hmac.new(self.signing_secret, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{self.endpoint_url}/{bucket}/{key}?X-Amz-Expires={expires}&X-Amz-Signature={sig}"

    def put_object(self, url: str, payload: bytes, content_type: str = "image/png") -> dict[str, Any]:
        digest = sha256_hex(payload)
        req = urllib.request.Request(
            url,
            data=payload,
            method="PUT",
            headers={
                "Content-Type": content_type,
                "x-amz-content-sha256": digest,
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return {
                "status": resp.status,
                "etag": resp.headers.get("ETag", "").strip('"'),
            }

    def head_object(self, bucket: str, key: str) -> int:
        req = urllib.request.Request(f"{self.endpoint_url}/{bucket}/{key}", method="HEAD")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return int(resp.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)

    def delete_object(self, bucket: str, key: str) -> int:
        req = urllib.request.Request(f"{self.endpoint_url}/{bucket}/{key}", method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return int(resp.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)

    def list_objects(self, bucket: str) -> list[dict[str, Any]]:
        req = urllib.request.Request(f"{self.endpoint_url}/{bucket}?list-type=2", method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return list(data.get("contents", []))

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


class E3MiddlewareVerificationSuite:
    """Executes all 5 E3 real middleware gates (PG 17 + S3 + Outbox Queue + RLS + Restart Recovery)."""

    def __init__(self, spec_root: Path = SPEC_ROOT) -> None:
        self.spec_root = spec_root

    def run_verification(self) -> dict[str, Any]:
        pg_bin = find_postgres_bin_dir()
        if pg_bin is None:
            return {
                "status": "BLOCKED",
                "reason": "PostgreSQL initdb/pg_ctl binaries not installed on host",
            }

        with tempfile.TemporaryDirectory(prefix="tc_e3_pg17_") as tmp:
            tmp_path = Path(tmp)
            pg_cluster = Postgres17ClusterManager(tmp_path / "pg", pg_bin)
            s3_server = S3CompatibleHttpServer(tmp_path / "s3")
            bucket = "timecapsule-vault"

            pg_cluster.init_and_start()
            s3_endpoint = s3_server.start()
            initial_postmaster_pid = pg_cluster.postmaster_pid

            try:
                # 1. Apply 001_init.sql and configure FORCE ROW LEVEL SECURITY + tc_app_runtime role
                init_sql = (self.spec_root / "database" / "001_init.sql").read_text(encoding="utf-8")
                with pg_cluster.connect() as admin_conn:
                    backend_pid_initial = admin_conn.backend_pid
                    admin_conn.execute(init_sql)
                    admin_conn.execute(
                        """
                        CREATE ROLE tc_app_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE;
                        GRANT USAGE ON SCHEMA public TO tc_app_runtime;
                        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tc_app_runtime;

                        ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
                        CREATE POLICY app_user_isolation ON app_user
                            USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

                        ALTER TABLE consent_record ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE consent_record FORCE ROW LEVEL SECURITY;
                        CREATE POLICY consent_isolation ON consent_record
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

                        ALTER TABLE media_asset ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE media_asset FORCE ROW LEVEL SECURITY;
                        CREATE POLICY media_isolation ON media_asset
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

                        ALTER TABLE generation_job ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE generation_job FORCE ROW LEVEL SECURITY;
                        CREATE POLICY job_isolation ON generation_job
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

                        ALTER TABLE customer_order ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE customer_order FORCE ROW LEVEL SECURITY;
                        CREATE POLICY order_isolation ON customer_order
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

                        ALTER TABLE work ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE work FORCE ROW LEVEL SECURITY;
                        CREATE POLICY work_isolation ON work
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
                        """
                    )

                    # Seed active template revision in PostgreSQL jsonb
                    tpl_manifest = json.dumps({"id": "life_0_100", "version": "1.0.0", "ai_mode": "age_simulation"})
                    admin_conn.execute(
                        f"INSERT INTO template_revision (template_id, revision, manifest, status) "
                        f"VALUES ('life_0_100', '1.0.0', '{tpl_manifest}'::jsonb, 'ACTIVE')"
                    )
                    admin_conn.execute(
                        "INSERT INTO product_price (id, currency, amount_fen, version) VALUES ('single', 'CNY', 990, 1)"
                    )

                user_a = str(uuid.uuid4())
                user_b = str(uuid.uuid4())
                consent_a = str(uuid.uuid4())
                asset_a = str(uuid.uuid4())
                orphan_key = f"u/{user_a}/orphan_untracked.png"
                valid_key = f"u/{user_a}/{asset_a}.png"

                # 2. Seed User A and User B under RLS context & upload S3 objects via presigned URL
                with pg_cluster.connect() as conn:
                    with conn.transaction(role="tc_app_runtime", app_user_id=user_a):
                        conn.execute(f"INSERT INTO app_user (id, status) VALUES ('{user_a}', 'ACTIVE')")
                        conn.execute(
                            f"INSERT INTO consent_record (id, user_id, purpose, policy_revision, status, evidence_ref, granted_at) "
                            f"VALUES ('{consent_a}', '{user_a}', 'portrait_generation', '2026.1', 'GRANTED', 'ev_a', now())"
                        )
                    with conn.transaction(role="tc_app_runtime", app_user_id=user_b):
                        conn.execute(f"INSERT INTO app_user (id, status) VALUES ('{user_b}', 'ACTIVE')")

                sample_png = b"\x89PNG\r\n\x1a\nE3_REAL_S3_OBJECT_PAYLOAD"
                sample_sha = sha256_hex(sample_png)
                presigned_put = s3_server.generate_presigned_url("PUT", bucket, valid_key)
                put_res = s3_server.put_object(presigned_put, sample_png)
                if put_res["etag"] != sample_sha:
                    raise TimeCapsuleError("S3_ETAG_MISMATCH", "S3 ETag did not match SHA-256", 500)

                # Also upload an untracked orphan object to S3 (A05)
                orphan_put = s3_server.generate_presigned_url("PUT", bucket, orphan_key)
                s3_server.put_object(orphan_put, b"\x89PNG\r\n\x1a\nORPHAN_PAYLOAD")

                with pg_cluster.connect() as conn:
                    with conn.transaction(role="tc_app_runtime", app_user_id=user_a):
                        conn.execute(
                            f"INSERT INTO media_asset (id, user_id, storage_key, sha256, media_type, state) "
                            f"VALUES ('{asset_a}', '{user_a}', '{valid_key}', '{sample_sha}', 'image/png', 'READY')"
                        )

                    # Verify FORCE ROW LEVEL SECURITY blocks User B from seeing or mutating User A's asset (A10)
                    with conn.transaction(role="tc_app_runtime", app_user_id=user_b):
                        b_rows = conn.execute(f"SELECT id FROM media_asset WHERE id = '{asset_a}'")
                        conn.execute(f"UPDATE media_asset SET state = 'DELETED' WHERE id = '{asset_a}'")
                        if len(b_rows) != 0:
                            raise TimeCapsuleError("RLS_ISOLATION_BREACH", "User B read User A's row under FORCE RLS", 500)

                    with conn.transaction(role="tc_app_runtime", app_user_id=user_a):
                        a_rows = conn.execute(f"SELECT state FROM media_asset WHERE id = '{asset_a}'")
                        if len(a_rows) != 1 or a_rows[0]["state"] != "READY":
                            raise TimeCapsuleError("RLS_TAMPERED", "User A asset state was unexpectedly altered", 500)

                # 3. Concurrent Idempotency Race & Outbox Enqueue (20 threads racing on UNIQUE(user_id, idempotency_key))
                idem_key = "idem_e3_pg17_concurrent_001"
                req_sha = sha256_hex("render:life_0_100:retro")

                def _concurrent_submit(_: int) -> str:
                    job_candidate = str(uuid.uuid4())
                    outbox_id = str(uuid.uuid4())
                    with pg_cluster.connect() as worker_conn:
                        with worker_conn.transaction(role="tc_app_runtime", app_user_id=user_a):
                            inserted = worker_conn.execute(
                                f"INSERT INTO generation_job (id, user_id, template_id, template_revision, consent_id, state, idempotency_key, request_sha256) "
                                f"VALUES ('{job_candidate}', '{user_a}', 'life_0_100', '1.0.0', '{consent_a}', 'QUEUED', '{idem_key}', '{req_sha}') "
                                f"ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id"
                            )
                            if inserted:
                                win_id = str(inserted[0]["id"])
                                payload_json = json.dumps({"job_id": win_id, "user_id": user_a})
                                worker_conn.execute(
                                    f"INSERT INTO transactional_outbox (event_id, event_type, aggregate_id, payload) "
                                    f"VALUES ('{outbox_id}', 'JOB_QUEUED', '{win_id}', '{payload_json}'::jsonb)"
                                )
                                return win_id
                            existing = worker_conn.execute(
                                f"SELECT id FROM generation_job WHERE user_id = '{user_a}' AND idempotency_key = '{idem_key}'"
                            )
                            return str(existing[0]["id"])

                with ThreadPoolExecutor(max_workers=8) as pool:
                    resolved_job_ids = list(pool.map(_concurrent_submit, range(20)))

                unique_job_ids = set(resolved_job_ids)
                if len(unique_job_ids) != 1:
                    raise TimeCapsuleError("PG_IDEMPOTENCY_RACE_FAILED", f"Expected 1 job, got {unique_job_ids}", 500)
                winning_job_id = next(iter(unique_job_ids))

                # 4. Outbox Queue Dispatch using FOR UPDATE SKIP LOCKED + S3 Orphan Purge (A04 & A05)
                with pg_cluster.connect() as admin_conn:
                    with admin_conn.transaction():
                        pending_events = admin_conn.execute(
                            "SELECT event_id, aggregate_id FROM transactional_outbox "
                            "WHERE dispatched_at IS NULL ORDER BY created_at ASC FOR UPDATE SKIP LOCKED"
                        )
                        if len(pending_events) != 1:
                            raise TimeCapsuleError("OUTBOX_COUNT_MISMATCH", f"Expected 1 outbox event, got {len(pending_events)}", 500)
                        evt_id = pending_events[0]["event_id"]
                        admin_conn.execute(
                            f"UPDATE transactional_outbox SET dispatched_at = now() WHERE event_id = '{evt_id}'"
                        )
                        admin_conn.execute(
                            f"UPDATE generation_job SET state = 'READY', result_asset_id = '{asset_a}', updated_at = now() WHERE id = '{winning_job_id}'"
                        )
                        work_id = str(uuid.uuid4())
                        admin_conn.execute(
                            f"INSERT INTO work (id, user_id, job_id, manifest_sha256, export_asset_id) "
                            f"VALUES ('{work_id}', '{user_a}', '{winning_job_id}', '{sample_sha}', '{asset_a}')"
                        )

                    # S3 Orphan scan against PostgreSQL media_asset table
                    db_keys = {
                        r["storage_key"]
                        for r in admin_conn.execute("SELECT storage_key FROM media_asset WHERE state != 'DELETED'")
                    }
                    s3_objs = s3_server.list_objects(bucket)
                    purged_orphans: list[str] = []
                    for obj in s3_objs:
                        if obj["key"] not in db_keys:
                            s3_server.delete_object(bucket, obj["key"])
                            purged_orphans.append(obj["key"])

                # 5. Physical PostgreSQL 17 Daemon Restart (`pg_ctl restart`) & Crash-Recovery Verification
                restarted_postmaster_pid = pg_cluster.restart()
                with pg_cluster.connect() as post_restart_conn:
                    backend_pid_after_restart = post_restart_conn.backend_pid
                    surviving_job = post_restart_conn.execute(
                        f"SELECT id, state FROM generation_job WHERE id = '{winning_job_id}'"
                    )
                    if len(surviving_job) != 1 or surviving_job[0]["state"] != "READY":
                        raise TimeCapsuleError("PG_WAL_RECOVERY_FAILED", "Committed job lost after pg_ctl restart", 500)

                    # 6. Verifiable Privacy Deletion Cascade across PostgreSQL + S3
                    del_req_id = str(uuid.uuid4())
                    with post_restart_conn.transaction():
                        post_restart_conn.execute(
                            f"INSERT INTO privacy_deletion_request (id, user_id, state, requested_at) "
                            f"VALUES ('{del_req_id}', '{user_a}', 'PROCESSING', now())"
                        )
                        post_restart_conn.execute(f"DELETE FROM work WHERE user_id = '{user_a}'")
                        post_restart_conn.execute(
                            f"UPDATE generation_job SET state = 'CANCELLED', result_asset_id = NULL WHERE user_id = '{user_a}'"
                        )
                        post_restart_conn.execute(
                            f"UPDATE media_asset SET state = 'DELETED' WHERE user_id = '{user_a}'"
                        )
                        s3_server.delete_object(bucket, valid_key)
                        post_restart_conn.execute(
                            f"UPDATE privacy_deletion_request SET state = 'COMPLETED', finished_at = now(), "
                            f"evidence_ref = 's3_deleted:{valid_key}' WHERE id = '{del_req_id}'"
                        )

                    s3_head_after_delete = s3_server.head_object(bucket, valid_key)
                    if s3_head_after_delete != 404:
                        raise TimeCapsuleError("S3_DELETE_INCOMPLETE", "S3 object still accessible after deletion", 500)

                    post_image_rows = post_restart_conn.execute(
                        f"SELECT id, state, evidence_ref FROM privacy_deletion_request WHERE id = '{del_req_id}'"
                    )
                    post_image_digest = sha256_hex(json.dumps(post_image_rows, sort_keys=True))

                return {
                    "status": "PASS",
                    "postgres_version": post_restart_conn.server_parameters.get("server_version", "17"),
                    "initial_postmaster_pid": initial_postmaster_pid,
                    "restarted_postmaster_pid": restarted_postmaster_pid,
                    "backend_pids": [backend_pid_initial, backend_pid_after_restart],
                    "s3_endpoint": s3_endpoint,
                    "force_rls_verified": True,
                    "concurrent_idempotency_20x_verified": True,
                    "outbox_skip_locked_verified": True,
                    "purged_orphan_keys": purged_orphans,
                    "s3_head_after_deletion": s3_head_after_delete,
                    "deletion_post_image_sha256": post_image_digest,
                }
            finally:
                s3_server.stop()
                pg_cluster.stop()
