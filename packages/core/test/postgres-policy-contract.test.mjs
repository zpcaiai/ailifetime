import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { DomainError, PostgresLifeTimeMachineRuntime } from "../dist/index.js";
import {
  hasExactTenantIsolationPolicySet,
  isExactTenantIsolationExpression,
  POSTGRES_TENANT_TABLES,
} from "../dist/postgres-policy-contract.js";

const TEST_POSTGRES_URL = process.env.LTM_TEST_POSTGRES_URL;
const TEST_POSTGRES_ADMIN_URL = process.env.LTM_TEST_POSTGRES_ADMIN_URL;
const MIGRATION_ROOT = new URL("../../../infra/postgres/migrations/", import.meta.url);

function exactPolicyRow(tablename) {
  return {
    tablename,
    policyname: "tenant_isolation",
    command: "*",
    permissive: true,
    public_only: true,
    using_expression: "(tenant_id = ltm.current_tenant())",
    check_expression: "(tenant_id = ltm.current_tenant())",
  };
}

test("tenant policy contract accepts only the exact closed PostgreSQL catalog shape", () => {
  assert.equal(isExactTenantIsolationExpression(" ( tenant_id\n=\tltm.current_tenant( ) ) "), true);
  for (const expression of [
    "true",
    "(tenant_id = tenant_id)",
    "(true OR (tenant_id = ltm.current_tenant()))",
    "((tenant_id = ltm.current_tenant()) OR false)",
    "(tenant_id IS NOT NULL)",
    "(tenant_id = current_tenant())",
    "(tenant_id <> ltm.current_tenant())",
    null,
  ]) {
    assert.equal(isExactTenantIsolationExpression(expression), false, String(expression));
  }

  const valid = POSTGRES_TENANT_TABLES.map(exactPolicyRow);
  assert.equal(hasExactTenantIsolationPolicySet(valid), true);

  const replacements = [
    { policyname: "tenant_isolation_copy" },
    { command: "r" },
    { permissive: false },
    { public_only: false },
    { using_expression: "(true OR tenant_id = ltm.current_tenant())" },
    { using_expression: "(tenant_id = tenant_id)" },
    { check_expression: null },
    { check_expression: "(tenant_id IS NOT NULL)" },
  ];
  for (const replacement of replacements) {
    const rows = valid.map((row, index) => index === 0 ? { ...row, ...replacement } : row);
    assert.equal(hasExactTenantIsolationPolicySet(rows), false, JSON.stringify(replacement));
  }
  assert.equal(hasExactTenantIsolationPolicySet(valid.slice(1)), false);
  assert.equal(hasExactTenantIsolationPolicySet([...valid, exactPolicyRow("records")]), false);
  assert.equal(hasExactTenantIsolationPolicySet([
    exactPolicyRow("records"),
    ...valid.slice(1).map((row) => row.tablename === "consents" ? exactPolicyRow("records") : row),
  ]), false);
});

test("PostgreSQL 17 runtime rejects broadened, duplicated, restrictive, scoped-role, and partial RLS policies", {
  skip: TEST_POSTGRES_URL === undefined || TEST_POSTGRES_ADMIN_URL === undefined
    ? "set LTM_TEST_POSTGRES_URL and LTM_TEST_POSTGRES_ADMIN_URL for the isolated PG17 policy test"
    : false,
  timeout: 120_000,
}, async () => {
  assert.ok(TEST_POSTGRES_URL);
  assert.ok(TEST_POSTGRES_ADMIN_URL);
  const databaseName = `ltm_rls_contract_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const runtimeRole = decodeURIComponent(new URL(TEST_POSTGRES_URL).username);
  const control = new Pool({ connectionString: TEST_POSTGRES_ADMIN_URL, max: 1 });
  let databaseAdmin;
  try {
    await control.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0 ENCODING 'UTF8'`);
    const adminUrl = databaseUrl(TEST_POSTGRES_ADMIN_URL, databaseName);
    const runtimeUrl = databaseUrl(TEST_POSTGRES_URL, databaseName);
    databaseAdmin = new Pool({ connectionString: adminUrl, max: 1 });
    const server = await databaseAdmin.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.ok(server.rows[0].version >= 170000, "the negative catalog test requires PostgreSQL 17+");

    await applyChecksumBoundMigrations(databaseAdmin);
    await databaseAdmin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(runtimeRole)}`);
    await databaseAdmin.query(`GRANT USAGE ON SCHEMA ltm TO ${quoteIdentifier(runtimeRole)}`);
    await databaseAdmin.query(`GRANT SELECT ON ltm.schema_metadata TO ${quoteIdentifier(runtimeRole)}`);

    const forceRls = await databaseAdmin.query(
      `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='ltm' AND c.relname=ANY($1::text[])
         AND c.relrowsecurity AND c.relforcerowsecurity`,
      [POSTGRES_TENANT_TABLES],
    );
    assert.deepEqual(forceRls.rows.map((row) => row.relname).sort(), [...POSTGRES_TENANT_TABLES].sort());

    await assertRuntimeStarts(runtimeUrl);
    const cases = [
      {
        name: "true OR tenant equality",
        apply: () => databaseAdmin.query(
          `ALTER POLICY tenant_isolation ON ltm.records
             USING (true OR tenant_id = ltm.current_tenant())
             WITH CHECK (tenant_id = ltm.current_tenant())`,
        ),
      },
      {
        name: "self equality",
        apply: () => databaseAdmin.query(
          `ALTER POLICY tenant_isolation ON ltm.records
             USING (tenant_id = tenant_id)
             WITH CHECK (tenant_id = ltm.current_tenant())`,
        ),
      },
      {
        name: "different WITH CHECK",
        apply: () => databaseAdmin.query(
          `ALTER POLICY tenant_isolation ON ltm.records
             USING (tenant_id = ltm.current_tenant())
             WITH CHECK (tenant_id IS NOT NULL)`,
        ),
      },
      {
        name: "extra permissive policy",
        apply: () => databaseAdmin.query(
          `CREATE POLICY tenant_isolation_extra ON ltm.records
             AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
        ),
      },
      {
        name: "restrictive policy",
        apply: async () => {
          await databaseAdmin.query("DROP POLICY tenant_isolation ON ltm.records");
          await databaseAdmin.query(
            `CREATE POLICY tenant_isolation ON ltm.records
               AS RESTRICTIVE FOR ALL TO PUBLIC
               USING (tenant_id = ltm.current_tenant())
               WITH CHECK (tenant_id = ltm.current_tenant())`,
          );
        },
      },
      {
        name: "role-specific policy",
        apply: () => databaseAdmin.query(
          `ALTER POLICY tenant_isolation ON ltm.records TO ${quoteIdentifier(runtimeRole)}`,
        ),
      },
      {
        name: "SELECT-only policy",
        apply: async () => {
          await databaseAdmin.query("DROP POLICY tenant_isolation ON ltm.records");
          await databaseAdmin.query(
            `CREATE POLICY tenant_isolation ON ltm.records
               AS PERMISSIVE FOR SELECT TO PUBLIC USING (tenant_id = ltm.current_tenant())`,
          );
        },
      },
    ];

    for (const policyCase of cases) {
      try {
        await policyCase.apply();
        await assert.rejects(
          PostgresLifeTimeMachineRuntime.connect({
            connectionString: runtimeUrl,
            applicationName: `ltm-rls-negative-${policyCase.name.replaceAll(/[^a-z]+/gu, "-")}`.slice(0, 63),
            evidencePolicy: "disabled",
          }),
          (error) => error instanceof DomainError && error.code === "DEPENDENCY_UNAVAILABLE",
          policyCase.name,
        );
      } finally {
        await restoreExactRecordsPolicy(databaseAdmin);
      }
    }

    await assertRuntimeStarts(runtimeUrl);
    // pg_get_expr output depends on the caller search_path. Pin the catalog
    // view exactly as production runtime connections do so an administrator's
    // role/database default cannot make a qualified policy look unqualified.
    await databaseAdmin.query("SET search_path = pg_catalog");
    const policies = await databaseAdmin.query(
      `SELECT c.relname AS tablename,p.polname AS policyname,p.polcmd AS command,
              p.polpermissive AS permissive,p.polroles=ARRAY[0::oid] AS public_only,
              pg_get_expr(p.polqual,p.polrelid) AS using_expression,
              pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
       FROM pg_policy p
       JOIN pg_class c ON c.oid=p.polrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='ltm' AND c.relname=ANY($1::text[])`,
      [POSTGRES_TENANT_TABLES],
    );
    assert.equal(hasExactTenantIsolationPolicySet(policies.rows), true);
  } finally {
    if (databaseAdmin !== undefined) await databaseAdmin.end();
    await control.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await control.end();
  }
});

async function assertRuntimeStarts(connectionString) {
  const runtime = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    applicationName: "ltm-rls-contract-valid",
    evidencePolicy: "disabled",
  });
  await runtime.close();
}

async function restoreExactRecordsPolicy(admin) {
  await admin.query("DROP POLICY IF EXISTS tenant_isolation_extra ON ltm.records");
  await admin.query("DROP POLICY IF EXISTS tenant_isolation ON ltm.records");
  await admin.query(
    `CREATE POLICY tenant_isolation ON ltm.records
       AS PERMISSIVE FOR ALL TO PUBLIC
       USING (tenant_id = ltm.current_tenant())
       WITH CHECK (tenant_id = ltm.current_tenant())`,
  );
}

async function applyChecksumBoundMigrations(admin) {
  const manifestBytes = readFileSync(new URL("manifest.json", MIGRATION_ROOT));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.runtimeSchemaVersion, "7");
  assert.equal(manifest.migrations.length, 7);
  for (const migration of manifest.migrations) {
    const bytes = readFileSync(new URL(migration.path, MIGRATION_ROOT));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), migration.sha256, migration.path);
    await admin.query(bytes.toString("utf8"));
  }
}

function databaseUrl(value, databaseName) {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}
