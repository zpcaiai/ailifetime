import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { DATA_DICTIONARY, POSTGRES_DATA_TENANT_TABLES, validateDataDictionary } from "../dist/index.js";

test("B02 data dictionary covers the exact schema-v7 table surface", async () => {
  const result = validateDataDictionary();
  assert.equal(result.tableCount, POSTGRES_DATA_TENANT_TABLES.length + 1);
  assert.ok(result.fieldCount >= 60);
  const migrationRoot = new URL("../../../infra/postgres/migrations/", import.meta.url);
  const migrationFiles = (await readdir(migrationRoot)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = (await Promise.all(migrationFiles.map((name) => readFile(new URL(name, migrationRoot), "utf8")))).join("\n");
  const createdTables = new Set([...migrations.matchAll(/CREATE TABLE IF NOT EXISTS ltm\.([a-z_]+)/g)].map((match) => match[1]));
  assert.deepEqual(createdTables, new Set(DATA_DICTIONARY.map((table) => table.table)));
  assert.deepEqual(
    new Set(DATA_DICTIONARY.filter((table) => table.tenantScoped).map((table) => table.table)),
    new Set(POSTGRES_DATA_TENANT_TABLES),
  );
});

test("every classified field declares retention, encryption, and access purposes", () => {
  for (const table of DATA_DICTIONARY) {
    for (const field of table.fields) {
      assert.ok(field.retentionPolicy.length > 0);
      assert.match(field.encryptionControl, /encryption|at_rest/);
      assert.ok(field.allowedPurposes.length > 0);
      assert.equal(new Set(field.allowedPurposes).size, field.allowedPurposes.length);
    }
  }
});
