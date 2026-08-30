import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedLocalDatabase } from "./local-seed.mjs";

test("B02 local seed is durable and idempotent without production credentials", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ltm-local-seed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "seed.sqlite");
  const first = await seedLocalDatabase(database);
  const second = await seedLocalDatabase(database);
  assert.equal(first.schemaVersion, "ltm.local-seed-result.v1");
  assert.equal(first.records.length, 2);
  assert.deepEqual(first.records.map(({ replayed: _replayed, ...record }) => record),
    second.records.map(({ replayed: _replayed, ...record }) => record));
  assert.deepEqual(first.records.map((record) => record.replayed), [false, false]);
  assert.deepEqual(second.records.map((record) => record.replayed), [true, true]);
  assert.equal(first.readiness.ready, true);
  assert.equal(second.readiness.ready, true);
});
