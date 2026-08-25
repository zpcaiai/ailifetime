import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadMigrationManifest,
  PostgresMigrationError,
  runPostgresMigrations,
  validateMigratorDatabaseUrl,
} from "../services/migrator/src/runner.mjs";

const MANIFEST = resolve("infra/postgres/migrations/manifest.json");
const TEST_URL = "postgresql://ltm_migrator@127.0.0.1:5432/ltm_test?sslmode=disable";

test("migration manifest binds five ordered SQL files to immutable SHA-256 digests", () => {
  const manifest = loadMigrationManifest(MANIFEST);
  assert.equal(manifest.runtimeSchemaVersion, "5");
  assert.deepEqual(manifest.migrations.map((item) => item.id), ["001", "002", "003", "004", "005"]);
  assert.equal(new Set(manifest.migrations.map((item) => item.sha256)).size, 5);
  assert.equal(manifest.migrations.every((item) => !/^\s*(?:BEGIN|COMMIT);\s*$/m.test(item.sql)), true);
});

test("manifest loader rejects changed migration bytes before opening PostgreSQL", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-migration-drift-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(resolve("infra/postgres/migrations"), directory, { recursive: true });
  writeFileSync(join(directory, "002_external_evidence.sql"), `${readFileSync(join(directory, "002_external_evidence.sql"), "utf8")}\n-- changed\n`);
  assert.throws(
    () => loadMigrationManifest(join(directory, "manifest.json")),
    (error) => error instanceof PostgresMigrationError && error.code === "MIGRATION_FILE_DRIFT",
  );
});

test("production migrator requires verify-full while test exception is loopback-only", () => {
  assert.equal(
    validateMigratorDatabaseUrl("postgresql://migrator@db.example.test/ltm?sslmode=verify-full").tlsVerified,
    true,
  );
  assert.throws(
    () => validateMigratorDatabaseUrl(TEST_URL),
    (error) => error.code === "MIGRATOR_TLS_REQUIRED",
  );
  assert.equal(validateMigratorDatabaseUrl(TEST_URL, { profile: "test", allowInsecureLoopback: true }).tlsVerified, false);
  assert.throws(
    () => validateMigratorDatabaseUrl("postgresql://migrator@db.example.test/ltm?sslmode=disable", { profile: "test", allowInsecureLoopback: true }),
    (error) => error.code === "MIGRATOR_TLS_REQUIRED",
  );
  assert.throws(
    () => validateMigratorDatabaseUrl("postgresql://migrator@db.example.test/ltm?sslmode=verify-full&host=attacker.example.test"),
    (error) => error.code === "MIGRATOR_DATABASE_URL_INVALID",
  );
  assert.throws(
    () => validateMigratorDatabaseUrl("postgresql://migrator@db.example.test/ltm?sslmode=verify-full&sslmode=disable"),
    (error) => error.code === "MIGRATOR_DATABASE_URL_INVALID",
  );
  assert.throws(
    () => validateMigratorDatabaseUrl("postgresql://migrator@db.example.test/ltm?sslmode=verify-full&options=-c%20role%3Downer"),
    (error) => error.code === "MIGRATOR_DATABASE_URL_INVALID",
  );
});

test("runner acquires an advisory lock, appends every migration, and is idempotent", async () => {
  const database = new FakeDatabase();
  const first = await execute(database);
  assert.equal(first.status, "PASS");
  assert.deepEqual(first.migrations.newlyApplied, ["001", "002", "003", "004", "005"]);
  assert.equal(first.role.leastPrivilegeVerified, true);
  assert.equal(first.runtimeSchemaVersion, "5");
  assert.equal(database.ledger.length, 5);
  assert.equal(database.queries.some((item) => item.text.includes("pg_try_advisory_lock")), true);
  assert.equal(database.queries.some((item) => item.text.includes("pg_advisory_unlock")), true);
  assert.equal(database.queries.some((item) => item.text.includes("pg_get_constraintdef")), true);
  assert.equal(database.queries.some((item) => item.text.includes("pg_get_triggerdef")), true);
  assert.equal(database.queries.filter((item) => item.text === "COMMIT").length, 6);

  const second = await execute(database);
  assert.deepEqual(second.migrations.previouslyApplied, ["001", "002", "003", "004", "005"]);
  assert.deepEqual(second.migrations.newlyApplied, []);
  assert.equal(database.ledger.length, 5);
});

test("runner fails closed for ledger drift and always releases the advisory lock", async () => {
  const manifest = loadMigrationManifest(MANIFEST);
  const database = new FakeDatabase({
    ledger: [{
      migration_id: "001",
      path: "001_tampered.sql",
      sha256: manifest.migrations[0].sha256,
      manifest_sha256: manifest.sha256,
      applied_at: "2026-08-24T00:00:00.000Z",
      applied_by: "ltm_migrator",
    }],
  });
  await assert.rejects(
    execute(database),
    (error) => error instanceof PostgresMigrationError && error.code === "MIGRATION_LEDGER_DRIFT",
  );
  assert.equal(database.queries.at(-1).text.includes("pg_advisory_unlock"), true);
  assert.equal(database.ended, true);

  const triggerDatabase = new FakeDatabase({
    ledger: [{
      migration_id: "001",
      path: manifest.migrations[0].path,
      sha256: manifest.migrations[0].sha256,
      manifest_sha256: manifest.sha256,
      applied_at: "2026-08-24T00:00:00.000Z",
      applied_by: "ltm_migrator",
    }],
    triggerDrift: true,
  });
  await assert.rejects(execute(triggerDatabase), (error) => error.code === "MIGRATION_LEDGER_DRIFT");
  assert.equal(triggerDatabase.queries.some((item) => item.text.includes("CREATE TABLE IF NOT EXISTS ltm.schema_migrations")), false);
});

test("runner refuses privileged roles, competing migrators, and untracked schemas", async () => {
  await assert.rejects(
    execute(new FakeDatabase({ role: { has_superuser: true } })),
    (error) => error.code === "MIGRATOR_ROLE_TOO_PRIVILEGED",
  );
  await assert.rejects(
    execute(new FakeDatabase({ role: { has_role_memberships: true } })),
    (error) => error.code === "MIGRATOR_ROLE_TOO_PRIVILEGED",
  );
  await assert.rejects(
    execute(new FakeDatabase({ role: { owns_database: true } })),
    (error) => error.code === "MIGRATOR_ROLE_TOO_PRIVILEGED",
  );
  await assert.rejects(
    execute(new FakeDatabase({ role: { session_role: "privileged_login" } })),
    (error) => error.code === "MIGRATOR_ROLE_TOO_PRIVILEGED",
  );
  await assert.rejects(
    execute(new FakeDatabase({ lockAcquired: false })),
    (error) => error.code === "MIGRATION_LOCK_UNAVAILABLE",
  );
  await assert.rejects(
    execute(new FakeDatabase({ schemaHasObjects: true })),
    (error) => error.code === "UNTRACKED_EXISTING_SCHEMA",
  );
});

test("a migration failure rolls back without writing its ledger entry", async () => {
  const database = new FakeDatabase({ failMigration: "002" });
  await assert.rejects(
    execute(database),
    (error) => error.code === "POSTGRES_MIGRATION_FAILED",
  );
  assert.deepEqual(database.ledger.map((row) => row.migration_id), ["001"]);
  assert.equal(database.queries.some((item) => item.text === "ROLLBACK"), true);
  assert.equal(database.queries.at(-1).text.includes("pg_advisory_unlock"), true);
});

function execute(database) {
  return runPostgresMigrations({
    connectionString: TEST_URL,
    manifestPath: MANIFEST,
    profile: "test",
    allowInsecureLoopback: true,
  }, {
    poolFactory: () => ({
      connect: async () => database,
      end: async () => { database.ended = true; },
    }),
  });
}

class FakeDatabase {
  constructor(options = {}) {
    this.ledger = [...(options.ledger ?? [])];
    this.lockAcquired = options.lockAcquired ?? true;
    this.schemaHasObjects = options.schemaHasObjects ?? false;
    this.failMigration = options.failMigration;
    this.triggerDrift = options.triggerDrift ?? false;
    this.role = {
      role_name: "ltm_migrator",
      session_role: "ltm_migrator",
      has_superuser: false,
      has_bypassrls: false,
      has_createrole: false,
      has_createdb: false,
      has_replication: false,
      has_role_memberships: false,
      owns_database: false,
      ...options.role,
    };
    this.queries = [];
    this.ended = false;
  }

  async query(value, parameters = []) {
    const text = typeof value === "string" ? value : value.text;
    this.queries.push({ text, parameters });
    if (text.includes("FROM pg_roles role")) return { rows: [this.role] };
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: this.lockAcquired }] };
    if (text.includes("AS schema_has_objects")) {
      return { rows: [{
        ledger_exists: this.ledger.length > 0,
        schema_has_objects: this.schemaHasObjects,
        schema_has_runtime_objects: this.schemaHasObjects,
      }] };
    }
    if (text.includes("relation.oid = 'ltm.schema_migrations'::regclass")) {
      return { rows: [{ relkind: "r", relpersistence: "p", owner_name: "ltm_migrator", current_role: "ltm_migrator" }] };
    }
    if (text.includes("information_schema.columns")) return { rows: ledgerColumns() };
    if (text.includes("pg_get_constraintdef")) return { rows: ledgerConstraints() };
    if (text.includes("pg_get_triggerdef")) return { rows: this.triggerDrift ? ledgerTriggers().slice(0, 1) : ledgerTriggers() };
    if (text.includes("function.proname = 'reject_schema_migration_change'")) {
      return { rows: [{
        lanname: "plpgsql",
        provolatile: "v",
        prosecdef: false,
        prosrc: "BEGIN\n  RAISE EXCEPTION 'schema migration ledger is append-only';\nEND;",
        owner_name: "ltm_migrator",
        current_role: "ltm_migrator",
      }] };
    }
    if (text.includes("SELECT migration_id, path, sha256")) return { rows: [...this.ledger] };
    if (text.includes("INSERT INTO ltm.schema_migrations")) {
      this.ledger.push({
        migration_id: parameters[0],
        path: parameters[1],
        sha256: parameters[2],
        manifest_sha256: parameters[3],
        applied_at: "2026-08-24T00:00:00.000Z",
        applied_by: "ltm_migrator",
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("CREATE TABLE IF NOT EXISTS ltm.external_evidence") && this.failMigration === "002") {
      throw new Error("synthetic migration failure");
    }
    if (text.includes("SELECT value FROM ltm.schema_metadata")) return { rows: [{ value: "5" }] };
    if (text.includes("server_version_num")) return { rows: [{ server_version_num: 170_005, database_name: "ltm_test" }] };
    return { rows: [] };
  }

  release() {}
}

function ledgerColumns() {
  return [
    ["migration_id", "text", "NO"],
    ["path", "text", "NO"],
    ["sha256", "text", "NO"],
    ["manifest_sha256", "text", "NO"],
    ["applied_at", "timestamp with time zone", "NO"],
    ["applied_by", "text", "NO"],
  ].map(([column_name, data_type, is_nullable]) => ({ column_name, data_type, is_nullable }));
}

function ledgerConstraints() {
  return [
    ["schema_migrations_manifest_sha256_check", "c", "CHECK ((manifest_sha256 ~ '^[a-f0-9]{64}$'::text))"],
    ["schema_migrations_migration_id_check", "c", "CHECK ((migration_id ~ '^[0-9]{3}$'::text))"],
    ["schema_migrations_path_key", "u", "UNIQUE (path)"],
    ["schema_migrations_pkey", "p", "PRIMARY KEY (migration_id)"],
    ["schema_migrations_sha256_check", "c", "CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text))"],
  ].map(([conname, contype, definition]) => ({ conname, contype, definition }));
}

function ledgerTriggers() {
  return [
    [
      "schema_migrations_append_only",
      "O",
      "CREATE TRIGGER schema_migrations_append_only BEFORE DELETE OR UPDATE ON ltm.schema_migrations FOR EACH ROW EXECUTE FUNCTION ltm.reject_schema_migration_change()",
    ],
    [
      "schema_migrations_reject_truncate",
      "O",
      "CREATE TRIGGER schema_migrations_reject_truncate BEFORE TRUNCATE ON ltm.schema_migrations FOR EACH STATEMENT EXECUTE FUNCTION ltm.reject_schema_migration_change()",
    ],
  ].map(([tgname, tgenabled, definition]) => ({ tgname, tgenabled, definition }));
}
