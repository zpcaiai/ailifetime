import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CAPABILITY_PORTAL_MANIFEST, capabilityPortalForSkill, createCapabilityRegistry } from "./index.js";

interface ManifestBatch {
  id: string;
  skill: string;
  requirement_ids: string[];
}

test("registry exactly covers the full-commercial B00 through B127 manifest", () => {
  const registry = createCapabilityRegistry();
  const definitions = registry.list();
  const manifestPath = new URL("../../../.ai-life-time-machine/skill-package/manifests/batches.json", import.meta.url);
  const batches = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestBatch[];
  assert.equal(definitions.length, 128);
  assert.deepEqual(definitions.map((item) => item.batchId), batches.map((item) => item.id));
  for (const [index, definition] of definitions.entries()) {
    const manifest = batches[index];
    assert.ok(manifest);
    assert.equal(definition.skill, manifest.skill, `${definition.batchId} skill mismatch`);
    assert.deepEqual([...definition.requirements], manifest.requirement_ids, `${definition.batchId} requirement mismatch`);
    assert.match(definition.operation, /^[a-z][A-Za-z0-9]+$/);
    assert.match(definition.permission, /^(?:\*|[a-z][a-z0-9._:-]*\*?)$/);
    assert.notEqual(capabilityPortalForSkill(definition.skill), undefined, `${definition.batchId} portal mismatch`);
  }
  assert.equal(new Set(definitions.map((item) => item.skill)).size, 22);
});

test("server portal manifest covers all 22 domains exactly once", () => {
  const skills = CAPABILITY_PORTAL_MANIFEST.flatMap((portal) => portal.skills);
  assert.equal(CAPABILITY_PORTAL_MANIFEST.length, 7);
  assert.equal(skills.length, 22);
  assert.equal(new Set(skills).size, 22);
  assert.equal(new Set(CAPABILITY_PORTAL_MANIFEST.flatMap((portal) => portal.roles)).has("platform_admin"), true);
});

test("production launch capabilities retain explicit external evidence gates", () => {
  const definitions = createCapabilityRegistry().list();
  for (const batchId of ["B48", "B49", "B69", "B72", "B123", "B124", "B125", "B126", "B127"]) {
    assert.equal(definitions.find((item) => item.batchId === batchId)?.requiresExternalEvidence, true, `${batchId} must remain externally gated`);
  }
});

test("platform bootstrap controls use dedicated permissions", () => {
  const registry = createCapabilityRegistry();
  assert.equal(registry.get("B01")?.permission, "platform.architecture.manage");
  assert.equal(registry.get("B02")?.permission, "platform.contract.publish");
});

test("all capability execution modes and external gates remain explicit", () => {
  const definitions = createCapabilityRegistry().list();
  const modeCounts = Object.fromEntries(
    [...new Set(definitions.map((item) => item.mode))].map((mode) => [
      mode,
      definitions.filter((item) => item.mode === mode).length,
    ]),
  );
  assert.deepEqual(modeCounts, {
    resource: 68,
    "consent-write": 1,
    "external-command": 18,
    "state-transition": 4,
    "partner-settlement-ledger": 1,
    attestation: 34,
    "inbox-event": 1,
    "ledger-post": 1,
  });
  assert.deepEqual(definitions.filter((item) => item.requiresExternalEvidence).map((item) => item.batchId), [
    "B37", "B44", "B46", "B47", "B48", "B49", "B56", "B58", "B62", "B66", "B68", "B69", "B71",
    "B72", "B77", "B91", "B92", "B94", "B96", "B97", "B99", "B100", "B102", "B107",
    "B108", "B109", "B118", "B119", "B120", "B121", "B122", "B123", "B124", "B125", "B126", "B127",
  ]);
});
