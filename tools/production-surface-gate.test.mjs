import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCTION_SURFACE_GROUPS, validateProductionSurfaces } from "./production-surface-gate.mjs";

test("all B00-B127 batches have independent code and test surfaces outside generic capability definitions", async () => {
  const result = await validateProductionSurfaces();
  assert.equal(result.batches, 128);
  assert.equal(result.mandatoryRequirements, 640);
  assert.equal(result.genericCapabilityDefinitionsAcceptedAsIndependentImplementation, false);
  assert.ok(result.independentModules >= 19);
  assert.equal(PRODUCTION_SURFACE_GROUPS[0]?.from, 0);
  assert.equal(PRODUCTION_SURFACE_GROUPS.at(-1)?.to, 127);
});

test("external certification remains fail closed and cannot be converted into a local code claim", async () => {
  const result = await validateProductionSurfaces();
  assert.deepEqual(result.externalCertification.batches, ["B125", "B126", "B127"]);
  assert.equal(result.externalCertification.state, "NOT_CERTIFIED");
  assert.match(result.externalCertification.policy, /fail_closed/u);
});
