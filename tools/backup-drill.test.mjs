import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("SQLite backup drill restores data without requiring unrelated external runtime authorities", () => {
  const result = spawnSync(process.execPath, ["tools/backup-drill.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.check, "sqlite-online-backup-restore-drill");
  assert.equal(evidence.integrity, "ok");
  assert.equal(evidence.auditChainsValid, true);
  assert.equal(evidence.restoredDatabase, "ok");
  assert.equal(evidence.restoredAuditChain, "ok");
  assert.equal(evidence.restoredAuditEntriesChecked > 0, true);
  assert.equal(evidence.onlineAndIndependentHashMatch, true);
  assert.equal(evidence.scope, "local-single-node-sqlite");
  assert.equal(evidence.productionCertification, false);
});
