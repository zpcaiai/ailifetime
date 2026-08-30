import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateReleaseEvidence } from "./release-gate.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ltm-mobile-release-"));
  mkdirSync(join(root, "store")); mkdirSync(join(root, "evidence"));
  writeFileSync(join(root, "store/release-metadata.json"), '{"version":"2.0.0"}');
  const now = new Date("2026-08-28T00:00:00.000Z");
  const common = { commit: "a".repeat(40), version: "2.0.0", applicationIds: ["com.ailifetime.mobile", "com.ailifetime.mobile.test"], issuedAt: "2026-08-27T23:00:00.000Z", expiresAt: "2026-08-29T00:00:00.000Z" };
  const device = { schemaVersion: "ltm.mobile.device-evidence.v1", ...common, checks: { unit: true, integration: true, device: true, visual: true, accessibility: true, security: true, privacy: true, iap: true, coldStart: true }, metrics: { crashFreeRate: .999, anrRate: .001, coldStartP95Ms: 1200 }, deviceRuns: { android: 2, ios: 2 }, independentAuthority: "device-farm-evidence-reference-00000001" };
  const store = { schemaVersion: "ltm.mobile.store-provider-evidence.v1", ...common, providers: { apple: { provider: "apple", state: "accepted", providerEvidenceId: "apple-store-provider-reference-000001", acceptedAt: common.issuedAt }, google: { provider: "google", state: "accepted", providerEvidenceId: "google-store-provider-reference-00001", acceptedAt: common.issuedAt } } };
  writeFileSync(join(root, "evidence/device.json"), JSON.stringify(device)); writeFileSync(join(root, "evidence/store.json"), JSON.stringify(store));
  return { root, now, common, device, store };
}

test("release gate accepts only commit-bound independent device and store receipts", (context) => {
  const value = fixture(); context.after(() => rmSync(value.root, { recursive: true, force: true }));
  const result = evaluateReleaseEvidence({ root: value.root, now: value.now, commit: value.common.commit, clean: true, devicePath: "evidence/device.json", storePath: "evidence/store.json" });
  assert.equal(result.codeReady, true, JSON.stringify(result)); assert.equal(result.productionRelease, "CANDIDATE_READY"); assert.equal(result.externalCertification, "NOT_CERTIFIED");
});

test("release gate rejects stale, forged-commit, traversing and symlink evidence", (context) => {
  const value = fixture(); context.after(() => rmSync(value.root, { recursive: true, force: true }));
  let result = evaluateReleaseEvidence({ root: value.root, now: value.now, commit: "b".repeat(40), clean: true, devicePath: "evidence/device.json", storePath: "evidence/store.json" });
  assert.equal(result.codeReady, false); assert.ok(result.blockers.includes("DEVICE_EVIDENCE_BINDING_INVALID"), JSON.stringify(result));
  writeFileSync(join(value.root, "evidence/device.json"), `${JSON.stringify(value.device)}\n`);
  result = evaluateReleaseEvidence({ root: value.root, now: value.now, commit: value.common.commit, clean: true, devicePath: "evidence/device.json", storePath: "../evidence/store.json" });
  assert.ok(result.blockers.includes("DEVICE_EVIDENCE_INVALID")); assert.ok(result.blockers.includes("STORE_PROVIDER_EVIDENCE_INVALID"));
  writeFileSync(join(value.root, "outside.json"), readFileSync(join(value.root, "evidence/store.json")));
  symlinkSync(join(value.root, "outside.json"), join(value.root, "evidence/link.json"));
  result = evaluateReleaseEvidence({ root: value.root, now: value.now, commit: value.common.commit, clean: true, devicePath: "evidence/link.json", storePath: "evidence/store.json" });
  assert.ok(result.blockers.includes("DEVICE_EVIDENCE_INVALID"));
});
