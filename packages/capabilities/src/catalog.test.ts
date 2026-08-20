import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCapabilityRegistry } from "./index.js";

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
  }
  assert.equal(new Set(definitions.map((item) => item.skill)).size, 22);
});

test("production launch capabilities retain explicit external evidence gates", () => {
  const definitions = createCapabilityRegistry().list();
  for (const batchId of ["B48", "B49", "B69", "B72", "B123", "B124", "B125", "B126", "B127"]) {
    assert.equal(definitions.find((item) => item.batchId === batchId)?.requiresExternalEvidence, true, `${batchId} must remain externally gated`);
  }
});
