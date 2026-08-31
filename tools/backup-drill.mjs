import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeTimeMachineRuntime, verifyDatabaseBackup } from "../packages/core/dist/index.js";

const drillId = randomUUID();
const directory = mkdtempSync(join(tmpdir(), "ltm-backup-drill-"));
const databasePath = join(directory, "source.sqlite");
const backupPath = join(directory, "backup.sqlite");
const actor = {
  actorId: "backup-drill-service",
  tenantId: "tenant-backup-drill",
  roles: ["platform_admin"],
  purpose: "disaster_recovery_test",
  requestId: `backup-drill-${drillId}`,
  stepUp: true,
};

let source;
let restored;
try {
  source = new LifeTimeMachineRuntime({ databasePath });
  source.createRecord(actor, {
    collection: "dr.backup-probes",
    id: drillId,
    data: { drillId, expectedState: "restorable" },
    idempotencyKey: `backup-probe-${drillId}`,
  });
  const onlineVerification = await source.createVerifiedBackup(backupPath);
  source.close();
  source = undefined;

  const independentVerification = await verifyDatabaseBackup(backupPath);
  restored = new LifeTimeMachineRuntime({ databasePath: backupPath });
  const restoredRecord = restored.getRecord(actor, "dr.backup-probes", drillId);
  const ready = restored.readiness();
  const restoredAuditChain = restored.verifyAuditChain(actor);
  if (
    restoredRecord.data.expectedState !== "restorable" ||
    ready.database !== "ok" ||
    ready.auditChain !== "ok" ||
    !restoredAuditChain.valid
  ) {
    throw new Error("Restored database failed the semantic recovery probe");
  }
  restored.close();
  restored = undefined;
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    check: "sqlite-online-backup-restore-drill",
    drillId,
    integrity: independentVerification.integrity,
    auditChainsValid: independentVerification.auditChainsValid,
    sha256: independentVerification.sha256,
    sizeBytes: independentVerification.sizeBytes,
    recordCount: independentVerification.recordCount,
    auditEntryCount: independentVerification.auditEntryCount,
    restoredDatabase: ready.database,
    restoredAuditChain: ready.auditChain,
    restoredAuditEntriesChecked: restoredAuditChain.entriesChecked,
    onlineAndIndependentHashMatch: onlineVerification.sha256 === independentVerification.sha256,
    scope: "local-single-node-sqlite",
    productionCertification: false,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    check: "sqlite-online-backup-restore-drill",
    drillId,
    error: error instanceof Error ? error.name : "UnknownError",
    code: error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined,
    message: error instanceof Error ? error.message : "Backup drill failed with an unknown error",
  })}\n`);
  process.exitCode = 1;
} finally {
  source?.close();
  restored?.close();
  if (process.env.LTM_DRILL_KEEP_ARTIFACTS !== "true") {
    rmSync(directory, { recursive: true, force: true });
  } else {
    process.stderr.write(`Backup drill artifacts retained at ${directory}\n`);
  }
}
