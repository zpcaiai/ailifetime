import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Pool } from "pg";

const SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION_ID = /^\d{3}$/;
const MIGRATION_PATH = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const LOCK_NAME = "ltm:postgres-schema-migrations:v1";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATION_BYTES = 10 * 1024 * 1024;

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS ltm;
CREATE TABLE IF NOT EXISTS ltm.schema_migrations (
  migration_id text PRIMARY KEY CHECK (migration_id ~ '^[0-9]{3}$'),
  path text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by text NOT NULL
);
CREATE OR REPLACE FUNCTION ltm.reject_schema_migration_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'schema migration ledger is append-only';
END;
$$;
DROP TRIGGER IF EXISTS schema_migrations_append_only ON ltm.schema_migrations;
CREATE TRIGGER schema_migrations_append_only
  BEFORE UPDATE OR DELETE ON ltm.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION ltm.reject_schema_migration_change();
DROP TRIGGER IF EXISTS schema_migrations_reject_truncate ON ltm.schema_migrations;
CREATE TRIGGER schema_migrations_reject_truncate
  BEFORE TRUNCATE ON ltm.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION ltm.reject_schema_migration_change();
REVOKE UPDATE, DELETE, TRUNCATE ON ltm.schema_migrations FROM PUBLIC;
`;

export class PostgresMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PostgresMigrationError";
    this.code = code;
  }
}

export function loadMigrationManifest(manifestPathValue) {
  const manifestFile = readStableFile(manifestPathValue, "migration manifest", MAX_MANIFEST_BYTES);
  let value;
  try {
    value = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw migrationError("MIGRATION_MANIFEST_INVALID", "Migration manifest is not valid JSON");
  }
  exactKeys(value, ["schemaVersion", "database", "runtimeSchemaVersion", "migrations"], "migration manifest");
  if (value.schemaVersion !== "ltm.postgres-migration-manifest.v1" || value.database !== "postgresql") {
    throw migrationError("MIGRATION_MANIFEST_INVALID", "Migration manifest version or database is unsupported");
  }
  if (typeof value.runtimeSchemaVersion !== "string" || !/^\d+$/.test(value.runtimeSchemaVersion)) {
    throw migrationError("MIGRATION_MANIFEST_INVALID", "runtimeSchemaVersion must be a decimal string");
  }
  if (!Array.isArray(value.migrations) || value.migrations.length === 0 || value.migrations.length > 999) {
    throw migrationError("MIGRATION_MANIFEST_INVALID", "Migration manifest must contain one to 999 migrations");
  }
  const directory = resolve(manifestFile.path, "..");
  const migrations = value.migrations.map((entry, index) => {
    exactKeys(entry, ["id", "path", "sha256"], `migration ${index}`);
    const expectedId = String(index + 1).padStart(3, "0");
    if (entry.id !== expectedId || !MIGRATION_ID.test(entry.id)) {
      throw migrationError("MIGRATION_MANIFEST_ORDER_INVALID", `Migration ${index} must have contiguous ID ${expectedId}`);
    }
    const match = typeof entry.path === "string" ? MIGRATION_PATH.exec(entry.path) : null;
    if (match === null || match[1] !== entry.id) {
      throw migrationError("MIGRATION_MANIFEST_PATH_INVALID", `Migration ${entry.id} path must be a matching canonical SQL filename`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw migrationError("MIGRATION_MANIFEST_DIGEST_INVALID", `Migration ${entry.id} must have a lowercase SHA-256 digest`);
    }
    const file = readRootFile(directory, entry.path, `migration ${entry.id}`, MAX_MIGRATION_BYTES);
    const actualSha256 = sha256(file.bytes);
    if (actualSha256 !== entry.sha256) {
      throw migrationError("MIGRATION_FILE_DRIFT", `Migration ${entry.id} bytes do not match the immutable manifest`);
    }
    return {
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256,
      sql: unwrapMigrationTransaction(file.bytes.toString("utf8"), entry.id),
    };
  });
  return {
    schemaVersion: value.schemaVersion,
    database: "postgresql",
    runtimeSchemaVersion: value.runtimeSchemaVersion,
    migrations,
    path: manifestFile.path,
    sha256: sha256(manifestFile.bytes),
  };
}

export function validateMigratorDatabaseUrl(value, options = {}) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 8_192) {
    throw migrationError("MIGRATOR_DATABASE_URL_REQUIRED", "A bounded PostgreSQL migrator URL is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw migrationError("MIGRATOR_DATABASE_URL_INVALID", "Migrator URL is invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username === "" || url.hostname === "" || url.pathname.length < 2 ||
    url.hash !== ""
  ) {
    throw migrationError("MIGRATOR_DATABASE_URL_INVALID", "Migrator URL must identify a PostgreSQL role, host, and database without a fragment");
  }
  const parameterNames = [...url.searchParams.keys()];
  if (new Set(parameterNames).size !== parameterNames.length) {
    throw migrationError("MIGRATOR_DATABASE_URL_INVALID", "Migrator URL must not contain duplicate query parameters");
  }
  for (const override of [
    "host", "hostname", "hostaddr", "user", "username", "password", "database", "dbname", "port",
    "options", "role", "service", "ssl", "sslaccept",
  ]) {
    if (url.searchParams.has(override)) {
      throw migrationError("MIGRATOR_DATABASE_URL_INVALID", `Migrator URL query must not override ${override}`);
    }
  }
  const profile = options.profile ?? "production";
  if (!new Set(["production", "test"]).has(profile)) {
    throw migrationError("MIGRATOR_PROFILE_INVALID", "Migrator profile must be production or test");
  }
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
  const insecureTest = profile === "test" && options.allowInsecureLoopback === true && loopback && url.searchParams.get("sslmode") === "disable";
  if (!insecureTest && url.searchParams.get("sslmode") !== "verify-full") {
    throw migrationError("MIGRATOR_TLS_REQUIRED", "Migrator URL must use sslmode=verify-full");
  }
  return { connectionString: url.toString(), profile, tlsVerified: !insecureTest };
}

export async function runPostgresMigrations(options, dependencies = {}) {
  const manifest = loadMigrationManifest(options.manifestPath);
  const database = validateMigratorDatabaseUrl(options.connectionString, {
    profile: options.profile,
    allowInsecureLoopback: options.allowInsecureLoopback,
  });
  const poolFactory = dependencies.poolFactory ?? ((poolOptions) => new Pool(poolOptions));
  const pool = poolFactory({
    connectionString: database.connectionString,
    max: 1,
    connectionTimeoutMillis: boundedInteger(options.connectionTimeoutMillis, 15_000, 1_000, 60_000, "connectionTimeoutMillis"),
    statement_timeout: boundedInteger(options.statementTimeoutMillis, 120_000, 5_000, 900_000, "statementTimeoutMillis"),
    application_name: "ltm-postgres-migrator",
  });
  let client;
  let locked = false;
  const startedAt = new Date();
  try {
    client = await pool.connect();
    const role = await verifyLeastPrivilegeRole(client);
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [LOCK_NAME]);
    if (lock.rows?.[0]?.acquired !== true) {
      throw migrationError("MIGRATION_LOCK_UNAVAILABLE", "Another schema migration session currently holds the migration lock");
    }
    locked = true;
    const initialSchema = await client.query(`
      SELECT to_regclass('ltm.schema_migrations') IS NOT NULL AS ledger_exists,
             EXISTS (
               SELECT 1 FROM pg_class object
               JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
               WHERE namespace.nspname = 'ltm'
             ) OR EXISTS (
               SELECT 1 FROM pg_proc object
               JOIN pg_namespace namespace ON namespace.oid = object.pronamespace
               WHERE namespace.nspname = 'ltm'
             ) OR EXISTS (
               SELECT 1 FROM pg_type object
               JOIN pg_namespace namespace ON namespace.oid = object.typnamespace
               WHERE namespace.nspname = 'ltm'
             ) AS schema_has_objects,
             EXISTS (
               SELECT 1 FROM pg_class object
               JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
               WHERE namespace.nspname = 'ltm' AND object.relkind IN ('r','p','v','m','S','f')
                     AND object.relname <> 'schema_migrations'
             ) OR EXISTS (
               SELECT 1 FROM pg_proc object
               JOIN pg_namespace namespace ON namespace.oid = object.pronamespace
               WHERE namespace.nspname = 'ltm' AND object.proname <> 'reject_schema_migration_change'
             ) OR EXISTS (
               SELECT 1 FROM pg_type object
               JOIN pg_namespace namespace ON namespace.oid = object.typnamespace
               WHERE namespace.nspname = 'ltm' AND object.typname NOT IN ('schema_migrations','_schema_migrations')
             ) AS schema_has_runtime_objects
    `);
    const ledgerExists = initialSchema.rows?.[0]?.ledger_exists === true;
    if (!ledgerExists && initialSchema.rows?.[0]?.schema_has_objects === true) {
      throw migrationError("UNTRACKED_EXISTING_SCHEMA", "An existing runtime schema has no immutable migration ledger; explicit reconciliation is required");
    }
    if (!ledgerExists) {
      await inTransaction(client, async () => {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '2min'");
        await client.query(BOOTSTRAP_SQL);
      });
    }
    await verifyLedgerContract(client);
    const ledger = await client.query(
      "SELECT migration_id, path, sha256, manifest_sha256, applied_at::text, applied_by FROM ltm.schema_migrations ORDER BY migration_id",
    );
    validateAppliedMigrations(ledger.rows, manifest.migrations);
    if (ledger.rows.length === 0 && initialSchema.rows?.[0]?.schema_has_runtime_objects === true) {
      throw migrationError("UNTRACKED_EXISTING_SCHEMA", "Runtime schema objects exist without an applied immutable migration");
    }
    const newlyApplied = [];
    for (const migration of manifest.migrations.slice(ledger.rows.length)) {
      await inTransaction(client, async () => {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '2min'");
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ltm.schema_migrations(migration_id,path,sha256,manifest_sha256,applied_by)
           VALUES ($1,$2,$3,$4,current_user)`,
          [migration.id, migration.path, migration.sha256, manifest.sha256],
        );
      });
      newlyApplied.push(migration.id);
    }
    const postcondition = await client.query(
      "SELECT value FROM ltm.schema_metadata WHERE key='runtime_schema_version'",
    );
    if (postcondition.rows?.length !== 1 || postcondition.rows[0].value !== manifest.runtimeSchemaVersion) {
      throw migrationError("RUNTIME_SCHEMA_VERSION_MISMATCH", "Applied migrations did not produce the manifest runtime schema version");
    }
    const server = await client.query(
      "SELECT current_setting('server_version_num')::integer AS server_version_num, current_database() AS database_name",
    );
    const finishedAt = new Date();
    return {
      schemaVersion: "ltm.postgres-migration-report.v1",
      status: "PASS",
      startedAt: startedAt.toISOString(),
      completedAt: finishedAt.toISOString(),
      profile: database.profile,
      tlsVerified: database.tlsVerified,
      manifest: { path: relative(process.cwd(), manifest.path).split(sep).join("/"), sha256: manifest.sha256 },
      runtimeSchemaVersion: manifest.runtimeSchemaVersion,
      migrations: {
        total: manifest.migrations.length,
        previouslyApplied: ledger.rows.map((row) => row.migration_id),
        newlyApplied,
      },
      role: { name: role.name, leastPrivilegeVerified: true },
      database: {
        serverVersionNumber: Number(server.rows?.[0]?.server_version_num),
        identitySha256: sha256(Buffer.from(String(server.rows?.[0]?.database_name ?? "unknown"), "utf8")),
      },
    };
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error;
    throw migrationError("POSTGRES_MIGRATION_FAILED", `PostgreSQL migration failed (${error instanceof Error ? error.name : "unknown error"})`);
  } finally {
    if (client !== undefined && locked) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [LOCK_NAME]).catch(() => undefined);
    }
    client?.release();
    await pool.end().catch(() => undefined);
  }
}

async function verifyLeastPrivilegeRole(client) {
  const result = await client.query(`
    SELECT role.rolname AS role_name,
           session_user AS session_role,
           role.rolsuper AS has_superuser,
           role.rolbypassrls AS has_bypassrls,
           role.rolcreaterole AS has_createrole,
           role.rolcreatedb AS has_createdb,
           role.rolreplication AS has_replication,
           EXISTS (
             SELECT 1 FROM pg_auth_members membership
              WHERE membership.member = role.oid
           ) AS has_role_memberships,
           EXISTS (
             SELECT 1 FROM pg_database database
              WHERE database.datname = current_database() AND database.datdba = role.oid
           ) AS owns_database
      FROM pg_roles role
     WHERE role.rolname = current_user
  `);
  const row = result.rows?.[0];
  if (
    row === undefined || typeof row.role_name !== "string" || row.session_role !== row.role_name ||
    row.has_superuser === true || row.has_bypassrls === true || row.has_createrole === true ||
    row.has_createdb === true || row.has_replication === true ||
    row.has_role_memberships === true || row.owns_database === true
  ) {
    throw migrationError(
      "MIGRATOR_ROLE_TOO_PRIVILEGED",
      "Migration role must be standalone, must not own the database, and must not have superuser, BYPASSRLS, role/database creation, or replication privileges",
    );
  }
  return { name: row.role_name };
}

async function verifyLedgerContract(client) {
  const relation = await client.query(`
    SELECT relation.relkind, relation.relpersistence,
           pg_get_userbyid(relation.relowner) AS owner_name, current_user AS current_role
      FROM pg_class relation
     WHERE relation.oid = 'ltm.schema_migrations'::regclass
  `);
  if (
    relation.rows?.length !== 1 || relation.rows[0].relkind !== "r" ||
    relation.rows[0].relpersistence !== "p" || relation.rows[0].owner_name !== relation.rows[0].current_role
  ) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger must be a permanent table owned by the migrator role");
  }
  const result = await client.query(`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema='ltm' AND table_name='schema_migrations'
     ORDER BY ordinal_position
  `);
  const expected = [
    "migration_id:text:NO", "path:text:NO", "sha256:text:NO", "manifest_sha256:text:NO",
    "applied_at:timestamp with time zone:NO", "applied_by:text:NO",
  ];
  const actual = result.rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger schema differs from the required append-only contract");
  }
  const constraints = await client.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'ltm.schema_migrations'::regclass
     ORDER BY conname
  `);
  const expectedConstraints = [
    "schema_migrations_manifest_sha256_check:c:CHECK ((manifest_sha256 ~ '^[a-f0-9]{64}$'::text))",
    "schema_migrations_migration_id_check:c:CHECK ((migration_id ~ '^[0-9]{3}$'::text))",
    "schema_migrations_path_key:u:UNIQUE (path)",
    "schema_migrations_pkey:p:PRIMARY KEY (migration_id)",
    "schema_migrations_sha256_check:c:CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text))",
  ];
  const actualConstraints = constraints.rows.map((row) => `${row.conname}:${row.contype}:${row.definition}`);
  if (
    actualConstraints.length !== expectedConstraints.length ||
    actualConstraints.some((value, index) => value !== expectedConstraints[index])
  ) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger constraints differ from the immutable contract");
  }
  const triggers = await client.query(`
    SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger
     WHERE tgrelid = 'ltm.schema_migrations'::regclass AND NOT tgisinternal
     ORDER BY tgname
  `);
  const expectedTriggers = [
    "schema_migrations_append_only:O:CREATE TRIGGER schema_migrations_append_only BEFORE DELETE OR UPDATE ON ltm.schema_migrations FOR EACH ROW EXECUTE FUNCTION ltm.reject_schema_migration_change()",
    "schema_migrations_reject_truncate:O:CREATE TRIGGER schema_migrations_reject_truncate BEFORE TRUNCATE ON ltm.schema_migrations FOR EACH STATEMENT EXECUTE FUNCTION ltm.reject_schema_migration_change()",
  ];
  const actualTriggers = triggers.rows.map((row) => `${row.tgname}:${row.tgenabled}:${row.definition}`);
  if (actualTriggers.length !== expectedTriggers.length || actualTriggers.some((value, index) => value !== expectedTriggers[index])) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger append-only triggers differ from the immutable contract");
  }
  const functions = await client.query(`
    SELECT language.lanname, function.provolatile, function.prosecdef,
           function.prosrc, pg_get_userbyid(function.proowner) AS owner_name,
           current_user AS current_role
      FROM pg_proc function
      JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
      JOIN pg_language language ON language.oid = function.prolang
     WHERE namespace.nspname = 'ltm' AND function.proname = 'reject_schema_migration_change'
           AND function.pronargs = 0
  `);
  const functionRow = functions.rows?.[0];
  const expectedBody = "BEGIN\n  RAISE EXCEPTION 'schema migration ledger is append-only';\nEND;";
  if (
    functions.rows?.length !== 1 || functionRow.lanname !== "plpgsql" || functionRow.provolatile !== "v" ||
    functionRow.prosecdef !== false || functionRow.owner_name !== functionRow.current_role ||
    String(functionRow.prosrc ?? "").trim() !== expectedBody
  ) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger trigger function differs from the immutable contract");
  }
}

function validateAppliedMigrations(rows, migrations) {
  if (!Array.isArray(rows) || rows.length > migrations.length) {
    throw migrationError("MIGRATION_LEDGER_DRIFT", "Migration ledger has an invalid number of entries");
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const migration = migrations[index];
    if (row?.migration_id !== migration.id || row.path !== migration.path || row.sha256 !== migration.sha256 || !SHA256.test(row.manifest_sha256 ?? "")) {
      throw migrationError("MIGRATION_LEDGER_DRIFT", `Applied migration ledger diverges at ${migration.id}`);
    }
  }
}

async function inTransaction(client, callback) {
  await client.query("BEGIN");
  try {
    await callback();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function unwrapMigrationTransaction(sql, id) {
  const match = /^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/.exec(sql);
  if (match === null || match[1].trim() === "" || /^\s*(?:BEGIN|COMMIT);\s*$/m.test(match[1])) {
    throw migrationError("MIGRATION_TRANSACTION_CONTRACT_INVALID", `Migration ${id} must contain one outer BEGIN/COMMIT pair only`);
  }
  return match[1];
}

function readRootFile(root, relativePath, label, maximumBytes) {
  const absolute = resolve(root, relativePath);
  const relation = relative(root, absolute);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw migrationError("MIGRATION_PATH_OUTSIDE_ROOT", `${label} resolves outside the migration directory`);
  }
  const file = readStableFile(absolute, label, maximumBytes);
  const realRelation = relative(realpathSync(root), file.path);
  if (realRelation === "" || realRelation.startsWith("..") || isAbsolute(realRelation)) {
    throw migrationError("MIGRATION_PATH_OUTSIDE_ROOT", `${label} resolves outside the migration directory`);
  }
  return file;
}

function readStableFile(pathValue, label, maximumBytes) {
  const path = resolve(pathValue);
  if (!existsSync(path)) throw migrationError("MIGRATION_FILE_NOT_FOUND", `${label} was not found`);
  const pathStat = lstatSync(path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw migrationError("MIGRATION_FILE_TYPE_INVALID", `${label} must be a regular non-symlink file`);
  }
  if ((pathStat.mode & 0o022) !== 0) {
    throw migrationError("MIGRATION_FILE_PERMISSIONS_INVALID", `${label} must not be group- or world-writable`);
  }
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw migrationError("MIGRATION_FILE_CHANGED", `${label} changed before it was opened`);
    }
    if (before.size <= 0 || before.size > maximumBytes) throw migrationError("MIGRATION_FILE_SIZE_INVALID", `${label} size is invalid`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw migrationError("MIGRATION_FILE_CHANGED", `${label} changed while being read`);
    }
    return { path: realpathSync(path), bytes };
  } finally {
    closeSync(descriptor);
  }
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("MIGRATION_MANIFEST_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw migrationError("MIGRATION_MANIFEST_INVALID", `${label} has unexpected or missing fields`);
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw migrationError("MIGRATOR_CONFIGURATION_INVALID", `${label} is outside its allowed range`);
  }
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function migrationError(code, message) {
  return new PostgresMigrationError(code, message);
}
