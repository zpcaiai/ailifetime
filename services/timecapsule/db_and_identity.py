"""
TimeCapsule Domain Package — P00 & P01:
- P00: Repository & Spec Package Integrity Verifier, JSON Schema Validator, and ACID SQL Database Engine.
- P01: User Session, Draft Preservation on Expiry (A01), Purpose Consent & Guardian Verification,
       Consent Revocation (A07), Cross-User ACL Isolation (A10), and Verifiable Deletion Lifecycle.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path
import re
import sqlite3
from typing import Any, Iterator
import uuid


SPEC_ROOT = Path(__file__).resolve().parents[2] / "spec" / "timecapsule"


class TimeCapsuleError(Exception):
    """Structured domain exception mapping directly to HTTP status codes and error codes."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}

    def to_dict(self, request_id: str = "req_local") -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "request_id": request_id,
            "details": self.details,
        }


def utc_now_iso(now: datetime | None = None) -> str:
    dt = now or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso_datetime(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def sha256_hex(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


class SpecContractValidator:
    """P00: Verifies MANIFEST.sha256.json and validates payloads against contracts/schemas/*.json."""

    def __init__(self, spec_root: Path = SPEC_ROOT) -> None:
        self.spec_root = spec_root
        self._schemas: dict[str, dict[str, Any]] = {}
        self._load_schemas()

    def _load_schemas(self) -> None:
        schema_dir = self.spec_root / "contracts" / "schemas"
        for path in sorted(schema_dir.glob("*.schema.json")):
            key = path.name.replace(".schema.json", "")
            self._schemas[key] = json.loads(path.read_text(encoding="utf-8"))

    def verify_package_manifest(self) -> dict[str, Any]:
        manifest_path = self.spec_root / "MANIFEST.sha256.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files: dict[str, str] = manifest.get("files", {})
        mismatches: list[str] = []
        for rel_path, expected_hash in sorted(files.items()):
            target = self.spec_root / rel_path
            if not target.is_file():
                mismatches.append(f"missing:{rel_path}")
                continue
            actual_hash = sha256_hex(target.read_bytes())
            if actual_hash != expected_hash:
                mismatches.append(f"mismatch:{rel_path}")
        if mismatches:
            raise TimeCapsuleError(
                "SPEC_MANIFEST_CORRUPTED",
                f"Spec package manifest verification failed: {', '.join(mismatches)}",
                500,
            )
        return {
            "package_name": manifest["name"],
            "version": manifest["version"],
            "verified_file_count": len(files),
            "manifest_sha256": sha256_hex(manifest_path.read_bytes()),
        }

    def validate(self, schema_name: str, payload: dict[str, Any]) -> None:
        if schema_name not in self._schemas:
            raise TimeCapsuleError("UNKNOWN_SCHEMA", f"Schema '{schema_name}' is not registered", 500)
        schema = self._schemas[schema_name]
        self._validate_object(schema, payload, path=schema_name)

    def _validate_object(self, schema: dict[str, Any], instance: Any, path: str) -> None:
        if not isinstance(instance, dict):
            raise TimeCapsuleError("SCHEMA_VALIDATION_FAILED", f"{path} must be an object", 400)
        required = schema.get("required", [])
        for req in required:
            if req not in instance:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} missing required field '{req}'",
                    400,
                )
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = set(instance.keys()) - set(props.keys())
            if extra:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} contains unsupported fields: {sorted(extra)}",
                    400,
                )
        for key, value in instance.items():
            if key in props:
                self._validate_property(props[key], value, path=f"{path}.{key}")

    def _validate_property(self, prop_schema: dict[str, Any], value: Any, path: str) -> None:
        allowed_types = prop_schema.get("type")
        if allowed_types is not None:
            type_list = allowed_types if isinstance(allowed_types, list) else [allowed_types]
            if not any(self._matches_type(t, value) for t in type_list):
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} has invalid type for value {value!r}; expected {type_list}",
                    400,
                )
        if value is None:
            return
        if "enum" in prop_schema and value not in prop_schema["enum"]:
            raise TimeCapsuleError(
                "SCHEMA_VALIDATION_FAILED",
                f"{path} value {value!r} not in allowed enum {prop_schema['enum']}",
                400,
            )
        if isinstance(value, str):
            min_len = prop_schema.get("minLength")
            if min_len is not None and len(value) < int(min_len):
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} length {len(value)} < minLength {min_len}",
                    400,
                )
            pattern = prop_schema.get("pattern")
            if pattern is not None and re.fullmatch(pattern, value) is None:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} value {value!r} does not match pattern {pattern}",
                    400,
                )
            fmt = prop_schema.get("format")
            if fmt == "date-time":
                try:
                    parse_iso_datetime(value)
                except ValueError as exc:
                    raise TimeCapsuleError(
                        "SCHEMA_VALIDATION_FAILED",
                        f"{path} must be a valid ISO-8601 date-time",
                        400,
                    ) from exc
            elif fmt == "uuid":
                try:
                    uuid.UUID(value)
                except ValueError as exc:
                    raise TimeCapsuleError(
                        "SCHEMA_VALIDATION_FAILED",
                        f"{path} must be a valid UUID",
                        400,
                    ) from exc
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in prop_schema and value < prop_schema["minimum"]:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} value {value} < minimum {prop_schema['minimum']}",
                    400,
                )
            if "exclusiveMinimum" in prop_schema and value <= prop_schema["exclusiveMinimum"]:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} value {value} <= exclusiveMinimum {prop_schema['exclusiveMinimum']}",
                    400,
                )
            if "maximum" in prop_schema and value > prop_schema["maximum"]:
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} value {value} > maximum {prop_schema['maximum']}",
                    400,
                )
        if isinstance(value, list):
            if "minItems" in prop_schema and len(value) < int(prop_schema["minItems"]):
                raise TimeCapsuleError(
                    "SCHEMA_VALIDATION_FAILED",
                    f"{path} requires at least {prop_schema['minItems']} items",
                    400,
                )
            if prop_schema.get("uniqueItems") and len(value) != len(set(json.dumps(v, sort_keys=True) for v in value)):
                raise TimeCapsuleError("SCHEMA_VALIDATION_FAILED", f"{path} items must be unique", 400)
            item_schema = prop_schema.get("items")
            if isinstance(item_schema, dict):
                for idx, item in enumerate(value):
                    if item_schema.get("type") == "object":
                        self._validate_object(item_schema, item, path=f"{path}[{idx}]")
                    else:
                        self._validate_property(item_schema, item, path=f"{path}[{idx}]")

    @staticmethod
    def _matches_type(expected: str, value: Any) -> bool:
        if expected == "null":
            return value is None
        if expected == "boolean":
            return isinstance(value, bool)
        if expected == "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        if expected == "number":
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        if expected == "string":
            return isinstance(value, str)
        if expected == "array":
            return isinstance(value, list)
        if expected == "object":
            return isinstance(value, dict)
        return False


class TimeCapsuleDatabase:
    """
    ACID SQLite relational persistence engine mirroring spec/timecapsule/database/001_init.sql
    with explicit BEGIN IMMEDIATE / COMMIT / ROLLBACK transactions, foreign key enforcement,
    and optimistic concurrency control (`WHERE id = ? AND version = ?`).
    """

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self.db_path = str(db_path)
        self._conn = sqlite3.connect(self.db_path, isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self.migrate()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Executes an atomic ACID SQL transaction using BEGIN IMMEDIATE / COMMIT / ROLLBACK."""
        if self._conn.in_transaction:
            yield self._conn
            return
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield self._conn
            if self._conn.in_transaction:
                self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

    def query_one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        cur = self._conn.execute(sql, params)
        return cur.fetchone()

    def query_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        cur = self._conn.execute(sql, params)
        return cur.fetchall()

    def close(self) -> None:
        self._conn.close()

    def migrate(self) -> None:
        with self.transaction() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS app_user (
                    id TEXT PRIMARY KEY,
                    pseudonym TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DELETING','DELETED')),
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS user_session (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS editor_draft (
                    user_id TEXT PRIMARY KEY REFERENCES app_user(id),
                    template_id TEXT NOT NULL,
                    style_id TEXT NOT NULL,
                    fields_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS consent_record (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    subject_id TEXT NOT NULL,
                    purpose TEXT NOT NULL CHECK(purpose IN ('portrait_generation','third_party_processing','share_public','minor_guardian')),
                    policy_revision TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
                    evidence_ref TEXT NOT NULL,
                    guardian_evidence_ref TEXT,
                    granted_at TEXT NOT NULL,
                    revoked_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS template_revision (
                    template_id TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    manifest TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','RETIRED')),
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY(template_id, revision)
                );

                CREATE TABLE IF NOT EXISTS media_asset (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    storage_key TEXT NOT NULL UNIQUE,
                    sha256 TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    byte_size INTEGER NOT NULL DEFAULT 0,
                    width_px INTEGER NOT NULL DEFAULT 0,
                    height_px INTEGER NOT NULL DEFAULT 0,
                    exif_stripped INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL CHECK(state IN ('UPLOADING','QUARANTINED','READY','DELETING','DELETED')),
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_media_owner ON media_asset(user_id);

                CREATE TABLE IF NOT EXISTS generation_job (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    template_id TEXT NOT NULL,
                    template_revision TEXT NOT NULL,
                    style_id TEXT NOT NULL DEFAULT 'minimal',
                    export_size TEXT NOT NULL DEFAULT '3:4',
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    asset_ids_json TEXT NOT NULL DEFAULT '[]',
                    consent_id TEXT NOT NULL REFERENCES consent_record(id),
                    state TEXT NOT NULL CHECK(state IN ('CREATED','VALIDATED','QUEUED','RUNNING','MODERATION','RENDERING','READY','FAILED','CANCEL_REQUESTED','CANCELLED','EXPIRED')),
                    idempotency_key TEXT NOT NULL,
                    request_sha256 TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    provider TEXT,
                    quoted_cost_fen INTEGER NOT NULL DEFAULT 0,
                    actual_cost_fen INTEGER NOT NULL DEFAULT 0,
                    result_asset_id TEXT REFERENCES media_asset(id),
                    error_code TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(user_id, idempotency_key),
                    FOREIGN KEY(template_id, template_revision) REFERENCES template_revision(template_id, revision)
                );
                CREATE INDEX IF NOT EXISTS idx_job_dispatch ON generation_job(state, created_at);

                CREATE TABLE IF NOT EXISTS product_price (
                    id TEXT PRIMARY KEY,
                    currency TEXT NOT NULL DEFAULT 'CNY',
                    amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0),
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS customer_order (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    product_id TEXT NOT NULL REFERENCES product_price(id),
                    amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0),
                    currency TEXT NOT NULL,
                    price_version INTEGER NOT NULL,
                    merchant_order_no TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL CHECK(state IN ('CREATED','PENDING','PAID','FULFILLED','REFUNDING','REFUND_FAILED','REFUNDED','CLOSED')),
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS payment_event (
                    provider_event_id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL REFERENCES customer_order(id),
                    event_type TEXT NOT NULL DEFAULT 'PAID',
                    verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
                    received_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS entitlement_grant (
                    id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL UNIQUE REFERENCES customer_order(id),
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    feature TEXT NOT NULL,
                    remaining_uses INTEGER NOT NULL DEFAULT 1,
                    granted_at TEXT NOT NULL,
                    revoked_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS ledger_entry (
                    id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL REFERENCES customer_order(id),
                    event_id TEXT NOT NULL,
                    debit_account TEXT NOT NULL,
                    credit_account TEXT NOT NULL,
                    amount_fen INTEGER NOT NULL,
                    currency TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS work (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    job_id TEXT UNIQUE NOT NULL REFERENCES generation_job(id),
                    template_id TEXT NOT NULL,
                    template_revision TEXT NOT NULL,
                    style_id TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    manifest_sha256 TEXT NOT NULL,
                    export_asset_id TEXT REFERENCES media_asset(id),
                    contains_minor INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS timeline_entry (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    work_id TEXT NOT NULL REFERENCES work(id),
                    age_milestone INTEGER NOT NULL CHECK(age_milestone BETWEEN 0 AND 120),
                    event_date TEXT NOT NULL,
                    narrative TEXT NOT NULL,
                    illustrative_disclosure TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS share_grant (
                    token TEXT PRIMARY KEY,
                    work_id TEXT NOT NULL REFERENCES work(id),
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    consent_id TEXT NOT NULL REFERENCES consent_record(id),
                    status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS moderation_case (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    decision TEXT NOT NULL CHECK(decision IN ('PASS','REVIEW','BLOCK')),
                    reason_code TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS appeal_ticket (
                    id TEXT PRIMARY KEY,
                    moderation_case_id TEXT NOT NULL REFERENCES moderation_case(id),
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('OPEN','APPROVED','REJECTED')),
                    sla_due_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS memorial_album_job (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    entitlement_id TEXT NOT NULL REFERENCES entitlement_grant(id),
                    work_ids_json TEXT NOT NULL,
                    subtitle_tracks_json TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('QUEUED','COMPOSING','READY','FAILED')),
                    manifest_sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS transactional_outbox (
                    event_id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    aggregate_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    dispatched_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_pending ON transactional_outbox(created_at) WHERE dispatched_at IS NULL;

                CREATE TABLE IF NOT EXISTS privacy_deletion_request (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id),
                    state TEXT NOT NULL CHECK(state IN ('ACCEPTED','COMPLETED')),
                    requested_at TEXT NOT NULL,
                    finished_at TEXT,
                    evidence_ref TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )


@dataclass(frozen=True)
class AuthenticatedSession:
    token: str
    user_id: str
    pseudonym: str
    expires_at: str
    restored_draft: dict[str, Any] | None = None


class IdentityConsentService:
    """P01: Login/Session, Draft Recovery (A01), Consent Verification, Revocation (A07), ACL (A10), and Deletion."""

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        validator: SpecContractValidator | None = None,
        pepper: str = "timecapsule-hmac-pepper-v1",
    ) -> None:
        self.db = db
        self.validator = validator or SpecContractValidator()
        self._pepper = pepper.encode("utf-8")

    def login_or_refresh_session(
        self,
        *,
        wechat_code: str,
        previous_token: str | None = None,
        draft: dict[str, Any] | None = None,
        ttl_seconds: int = 7200,
        now: datetime | None = None,
    ) -> AuthenticatedSession:
        """
        P01 & A01: Exchanges WeChat code for a pseudonymous user session.
        When an expired session token is refreshed, preserves and restores the user's editor draft.
        """
        if not wechat_code or len(wechat_code.strip()) < 4:
            raise TimeCapsuleError("INVALID_WECHAT_CODE", "WeChat login code must be at least 4 characters", 400)
        current_dt = now or datetime.now(timezone.utc)
        now_str = utc_now_iso(current_dt)
        expires_str = utc_now_iso(current_dt + timedelta(seconds=ttl_seconds))

        pseudonym_hash = hmac.new(
            self._pepper, wechat_code.strip().encode("utf-8"), hashlib.sha256
        ).hexdigest()[:24]
        pseudonym = f"usr_wx_{pseudonym_hash}"

        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT id, status, version FROM app_user WHERE pseudonym = ?",
                (pseudonym,),
            ).fetchone()
            if row is None:
                user_id = str(uuid.uuid5(uuid.NAMESPACE_OID, pseudonym))
                conn.execute(
                    "INSERT INTO app_user (id, pseudonym, created_at, status, version) VALUES (?, ?, ?, 'ACTIVE', 1)",
                    (user_id, pseudonym, now_str),
                )
            else:
                user_id = str(row["id"])
                if row["status"] != "ACTIVE":
                    raise TimeCapsuleError("USER_NOT_ACTIVE", "User account is undergoing deletion", 403)

            if previous_token:
                prev_row = conn.execute(
                    "SELECT user_id, version FROM user_session WHERE token = ?",
                    (previous_token,),
                ).fetchone()
                if prev_row and str(prev_row["user_id"]) == user_id:
                    conn.execute(
                        "UPDATE user_session SET revoked = 1, version = version + 1 WHERE token = ? AND version = ?",
                        (previous_token, int(prev_row["version"])),
                    )

            if draft is not None:
                self._upsert_draft_in_tx(conn, user_id=user_id, draft=draft, now_str=now_str)

            draft_row = conn.execute(
                "SELECT template_id, style_id, fields_json, updated_at FROM editor_draft WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            restored_draft = None
            if draft_row is not None:
                restored_draft = {
                    "template_id": str(draft_row["template_id"]),
                    "style_id": str(draft_row["style_id"]),
                    "fields": json.loads(str(draft_row["fields_json"])),
                    "updated_at": str(draft_row["updated_at"]),
                }

            token = f"tcs_{sha256_hex(f'{user_id}:{now_str}:{uuid.uuid4()}')[:40]}"
            conn.execute(
                "INSERT INTO user_session (token, user_id, expires_at, created_at, revoked, version) VALUES (?, ?, ?, ?, 0, 1)",
                (token, user_id, expires_str, now_str),
            )

        return AuthenticatedSession(
            token=token,
            user_id=user_id,
            pseudonym=pseudonym,
            expires_at=expires_str,
            restored_draft=restored_draft,
        )

    def save_draft(
        self,
        *,
        actor_user_id: str,
        template_id: str,
        style_id: str,
        fields: dict[str, Any],
        now: datetime | None = None,
    ) -> dict[str, Any]:
        now_str = utc_now_iso(now)
        draft = {"template_id": template_id, "style_id": style_id, "fields": fields}
        with self.db.transaction() as conn:
            self._upsert_draft_in_tx(conn, user_id=actor_user_id, draft=draft, now_str=now_str)
        return {**draft, "updated_at": now_str}

    @staticmethod
    def _upsert_draft_in_tx(
        conn: sqlite3.Connection,
        *,
        user_id: str,
        draft: dict[str, Any],
        now_str: str,
    ) -> None:
        existing = conn.execute(
            "SELECT version FROM editor_draft WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        fields_json = json.dumps(draft.get("fields", {}), ensure_ascii=False, sort_keys=True)
        if existing is None:
            conn.execute(
                "INSERT INTO editor_draft (user_id, template_id, style_id, fields_json, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)",
                (
                    user_id,
                    str(draft.get("template_id", "personal_intro")),
                    str(draft.get("style_id", "minimal")),
                    fields_json,
                    now_str,
                ),
            )
        else:
            cur = conn.execute(
                "UPDATE editor_draft SET template_id = ?, style_id = ?, fields_json = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND version = ?",
                (
                    str(draft.get("template_id", "personal_intro")),
                    str(draft.get("style_id", "minimal")),
                    fields_json,
                    now_str,
                    user_id,
                    int(existing["version"]),
                ),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Draft optimistic lock conflict", 409)

    def authenticate(self, bearer_token: str, now: datetime | None = None) -> AuthenticatedSession:
        clean = bearer_token.strip()
        if clean.lower().startswith("bearer "):
            clean = clean[7:].strip()
        if not clean:
            raise TimeCapsuleError("UNAUTHORIZED", "Missing bearer token", 401)
        row = self.db.query_one(
            """
            SELECT s.token, s.user_id, s.expires_at, s.revoked, u.pseudonym, u.status
            FROM user_session s
            JOIN app_user u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (clean,),
        )
        if row is None or int(row["revoked"]) == 1 or str(row["status"]) != "ACTIVE":
            raise TimeCapsuleError("UNAUTHORIZED", "Session is invalid or revoked", 401)
        current_dt = now or datetime.now(timezone.utc)
        if parse_iso_datetime(str(row["expires_at"])) <= current_dt:
            raise TimeCapsuleError("SESSION_EXPIRED", "Session has expired; refresh required", 401)
        return AuthenticatedSession(
            token=str(row["token"]),
            user_id=str(row["user_id"]),
            pseudonym=str(row["pseudonym"]),
            expires_at=str(row["expires_at"]),
        )

    def assert_owner_access(
        self,
        *,
        actor_user_id: str,
        owner_user_id: str,
        resource_type: str,
        resource_id: str,
        is_admin: bool = False,
        admin_audit_reason: str | None = None,
        now: datetime | None = None,
    ) -> None:
        """
        A10: Enforces strict user-scoped ACL isolation (User A requesting User B's photo/share/order -> 403).
        Admin break-glass access requires an explicit audit reason and writes an immutable audit_log row.
        """
        if actor_user_id == owner_user_id:
            return
        if is_admin and admin_audit_reason and len(admin_audit_reason.strip()) >= 8:
            with self.db.transaction() as conn:
                conn.execute(
                    "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid.uuid4()),
                        actor_user_id,
                        f"ADMIN_BREAK_GLASS_{resource_type.upper()}",
                        resource_id,
                        json.dumps({"owner_user_id": owner_user_id, "reason": admin_audit_reason.strip()}),
                        utc_now_iso(now),
                    ),
                )
            return
        raise TimeCapsuleError(
            "FORBIDDEN_CROSS_USER_ACCESS",
            f"Actor {actor_user_id} is not authorized to access {resource_type} {resource_id}",
            403,
        )

    def record_consent(
        self,
        *,
        actor_user_id: str,
        subject_id: str,
        purpose: str,
        policy_revision: str,
        evidence_ref: str,
        guardian_evidence_ref: str | None = None,
        is_minor: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """P01: Validates and persists a ConsentRecord against contracts/schemas/consent.schema.json."""
        if (purpose == "minor_guardian" or is_minor) and not (
            guardian_evidence_ref and guardian_evidence_ref.strip()
        ):
            raise TimeCapsuleError(
                "GUARDIAN_CONSENT_REQUIRED",
                "Processing minor portraits requires explicit guardian_evidence_ref",
                400,
            )
        granted_at = utc_now_iso(now)
        schema_payload: dict[str, Any] = {
            "subject_id": subject_id,
            "purpose": purpose,
            "policy_revision": policy_revision,
            "granted_at": granted_at,
            "status": "GRANTED",
            "evidence_ref": evidence_ref,
        }
        if guardian_evidence_ref is not None:
            schema_payload["guardian_evidence_ref"] = guardian_evidence_ref

        self.validator.validate("consent", schema_payload)

        consent_id = str(uuid.uuid4())
        with self.db.transaction() as conn:
            user_row = conn.execute(
                "SELECT status FROM app_user WHERE id = ?",
                (actor_user_id,),
            ).fetchone()
            if user_row is None or str(user_row["status"]) != "ACTIVE":
                raise TimeCapsuleError("USER_NOT_ACTIVE", "Active user required to grant consent", 403)
            conn.execute(
                """
                INSERT INTO consent_record (
                    id, user_id, subject_id, purpose, policy_revision,
                    status, evidence_ref, guardian_evidence_ref, granted_at, revoked_at, version
                ) VALUES (?, ?, ?, ?, ?, 'GRANTED', ?, ?, ?, NULL, 1)
                """,
                (
                    consent_id,
                    actor_user_id,
                    subject_id,
                    purpose,
                    policy_revision,
                    evidence_ref,
                    guardian_evidence_ref,
                    granted_at,
                ),
            )
        return {"id": consent_id, "user_id": actor_user_id, **schema_payload}

    def require_active_consent(
        self,
        *,
        actor_user_id: str,
        consent_id: str,
        required_purpose: str = "portrait_generation",
    ) -> dict[str, Any]:
        row = self.db.query_one(
            """
            SELECT id, user_id, subject_id, purpose, policy_revision, status, evidence_ref, guardian_evidence_ref, granted_at
            FROM consent_record
            WHERE id = ?
            """,
            (consent_id,),
        )
        if row is None:
            raise TimeCapsuleError("CONSENT_NOT_FOUND", f"Consent {consent_id} does not exist", 403)
        self.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="consent",
            resource_id=consent_id,
        )
        if str(row["status"]) != "GRANTED":
            raise TimeCapsuleError("CONSENT_REVOKED", f"Consent {consent_id} has been revoked", 403)
        if str(row["purpose"]) != required_purpose:
            raise TimeCapsuleError(
                "CONSENT_PURPOSE_MISMATCH",
                f"Consent purpose '{row['purpose']}' does not satisfy '{required_purpose}'",
                403,
            )
        return dict(row)

    def revoke_consent(
        self,
        *,
        actor_user_id: str,
        consent_id: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P01 & A07: Atomically revokes consent, cancels in-flight generation jobs before READY,
        and revokes any active share grants backed by this consent.
        """
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT id, user_id, status, version FROM consent_record WHERE id = ?",
                (consent_id,),
            ).fetchone()
            if row is None:
                raise TimeCapsuleError("CONSENT_NOT_FOUND", f"Consent {consent_id} not found", 404)
            self.assert_owner_access(
                actor_user_id=actor_user_id,
                owner_user_id=str(row["user_id"]),
                resource_type="consent",
                resource_id=consent_id,
            )
            if str(row["status"]) != "REVOKED":
                cur = conn.execute(
                    "UPDATE consent_record SET status = 'REVOKED', revoked_at = ?, version = version + 1 WHERE id = ? AND version = ?",
                    (now_str, consent_id, int(row["version"])),
                )
                if cur.rowcount != 1:
                    raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Consent optimistic lock conflict", 409)

            inflight_jobs = conn.execute(
                """
                SELECT id, state, result_asset_id, version
                FROM generation_job
                WHERE user_id = ? AND consent_id = ?
                  AND state IN ('CREATED','VALIDATED','QUEUED','RUNNING','MODERATION','RENDERING','CANCEL_REQUESTED')
                """,
                (actor_user_id, consent_id),
            ).fetchall()
            cancelled_jobs: list[str] = []
            for job in inflight_jobs:
                conn.execute(
                    """
                    UPDATE generation_job
                    SET state = 'CANCELLED', error_code = 'CONSENT_REVOKED_ABORT', updated_at = ?, version = version + 1
                    WHERE id = ? AND version = ?
                    """,
                    (now_str, str(job["id"]), int(job["version"])),
                )
                if job["result_asset_id"]:
                    conn.execute(
                        "UPDATE media_asset SET state = 'QUARANTINED', version = version + 1 WHERE id = ?",
                        (str(job["result_asset_id"]),),
                    )
                cancelled_jobs.append(str(job["id"]))

            conn.execute(
                "UPDATE share_grant SET status = 'REVOKED', version = version + 1 WHERE consent_id = ? AND status = 'ACTIVE'",
                (consent_id,),
            )

        return {
            "consent_id": consent_id,
            "status": "REVOKED",
            "revoked_at": now_str,
            "cancelled_job_ids": cancelled_jobs,
        }

    def request_deletion(
        self,
        *,
        actor_user_id: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P01: Executes privacy deletion cascade:
        1. Revokes all user consents and active share links
        2. Cancels in-flight jobs
        3. Marks all user media assets DELETING -> DELETED
        4. Enqueues transactional outbox event for storage/provider tombstone cleanup
        5. Produces a cryptographic deletion proof receipt
        """
        now_str = utc_now_iso(now)
        deletion_id = str(uuid.uuid4())
        with self.db.transaction() as conn:
            user_row = conn.execute(
                "SELECT id, version FROM app_user WHERE id = ?",
                (actor_user_id,),
            ).fetchone()
            if user_row is None:
                raise TimeCapsuleError("USER_NOT_FOUND", "User does not exist", 404)

            conn.execute(
                "UPDATE consent_record SET status = 'REVOKED', revoked_at = ?, version = version + 1 WHERE user_id = ? AND status = 'GRANTED'",
                (now_str, actor_user_id),
            )
            conn.execute(
                "UPDATE share_grant SET status = 'REVOKED', version = version + 1 WHERE user_id = ? AND status = 'ACTIVE'",
                (actor_user_id,),
            )
            conn.execute(
                """
                UPDATE generation_job
                SET state = 'CANCELLED', error_code = 'USER_DELETION_REQUESTED', updated_at = ?, version = version + 1
                WHERE user_id = ? AND state IN ('CREATED','VALIDATED','QUEUED','RUNNING','MODERATION','RENDERING','CANCEL_REQUESTED')
                """,
                (now_str, actor_user_id),
            )
            assets = conn.execute(
                "SELECT id, storage_key FROM media_asset WHERE user_id = ? AND state != 'DELETED'",
                (actor_user_id,),
            ).fetchall()
            deleted_asset_ids = [str(a["id"]) for a in assets]
            conn.execute(
                "UPDATE media_asset SET state = 'DELETED', version = version + 1 WHERE user_id = ? AND state != 'DELETED'",
                (actor_user_id,),
            )
            conn.execute("DELETE FROM editor_draft WHERE user_id = ?", (actor_user_id,))
            conn.execute(
                "UPDATE user_session SET revoked = 1, version = version + 1 WHERE user_id = ?",
                (actor_user_id,),
            )

            evidence_digest = sha256_hex(
                f"{deletion_id}:{actor_user_id}:{now_str}:{','.join(sorted(deleted_asset_ids))}"
            )
            evidence_ref = f"del_proof_{evidence_digest[:32]}"
            conn.execute(
                """
                INSERT INTO privacy_deletion_request (id, user_id, state, requested_at, finished_at, evidence_ref, version)
                VALUES (?, ?, 'COMPLETED', ?, ?, ?, 1)
                """,
                (deletion_id, actor_user_id, now_str, now_str, evidence_ref),
            )
            conn.execute(
                """
                INSERT INTO transactional_outbox (event_id, event_type, aggregate_id, payload, created_at, dispatched_at)
                VALUES (?, 'PRIVACY_DELETION_COMPLETED', ?, ?, ?, NULL)
                """,
                (
                    str(uuid.uuid4()),
                    deletion_id,
                    json.dumps(
                        {
                            "deletion_id": deletion_id,
                            "user_id": actor_user_id,
                            "deleted_asset_ids": deleted_asset_ids,
                            "evidence_ref": evidence_ref,
                        },
                        sort_keys=True,
                    ),
                    now_str,
                ),
            )
        return {
            "deletion_id": deletion_id,
            "user_id": actor_user_id,
            "state": "COMPLETED",
            "deleted_asset_count": len(deleted_asset_ids),
            "evidence_ref": evidence_ref,
            "requested_at": now_str,
            "finished_at": now_str,
        }
