import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityRegistry } from "./index.js";
import { createCapabilityValidInputFixtures } from "./valid-fixtures.js";
import type { CapabilityInvocation, JsonObject } from "./registry.js";

const dimensions = ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"];
const values = (value: number) => Object.fromEntries(dimensions.map(key => [key, value]));
function input(): JsonObject {
  return { workId: "quality", participantIds: ["person"], modelVersion: "test-contract-only-v1",
    scores: values(0.9), thresholds: values(0.8), decision: "pass",
    artifactBinding: { sourceAssetId: "original", assetId: "output", targetAge: 100, outputSha256: "a".repeat(64) } };
}
function parse(data: JsonObject) {
  const invocation: CapabilityInvocation = { actor: { actorId: "evaluator", tenantId: "tenant", roles: ["service_account"], purpose: "quality_assurance", requestId: "quality-contract" }, idempotencyKey: "quality-contract", input: data };
  return createCapabilityRegistry().get("B15")!.parseInput(invocation);
}

test("artifact-bound quality requires positive thresholds for every publication dimension", () => {
  for (const dimension of dimensions) {
    assert.throws(() => parse({ ...input(), thresholds: { ...values(0.8), [dimension]: 0 } }), /threshold/);
    assert.throws(() => parse({ ...input(), scores: { ...values(0.9), [dimension]: 0 }, thresholds: { ...values(0.8), [dimension]: 0 } }), /threshold/);
  }
});

test("bound score and threshold inventories reject silent misspellings and extra dimensions", () => {
  for (const field of ["scores", "thresholds"]) {
    assert.throws(() => parse({ ...input(), [field]: { ...values(0.9), photorealizm: 1 } }), /dimension/);
    const missing = values(0.9); delete missing.photorealism;
    assert.throws(() => parse({ ...input(), [field]: missing }), /dimension|threshold/);
  }
});

test("a bound pass cannot override any failed publication dimension", () => {
  for (const dimension of dimensions) {
    assert.throws(() => parse({ ...input(), scores: { ...values(0.9), [dimension]: 0.1 }, overrideReason: "operator review" }), /cannot be overridden/);
    const rejected = parse({ ...input(), scores: { ...values(0.9), [dimension]: 0.1 }, decision: "retry" });
    assert.deepEqual(rejected.failedDimensions, [dimension]);
    assert.equal(rejected.decision, "retry");
  }
});

test("valid bound age endpoints retain exact identity binding and legacy audited decisions remain valid", () => {
  for (const targetAge of [0, 37, 100]) {
    const data = input(); const binding = { ...(data.artifactBinding as JsonObject), targetAge };
    const result = parse({ ...data, artifactBinding: binding });
    assert.deepEqual(result.artifactBinding, binding);
    assert.deepEqual(result.scores, values(0.9));
    assert.deepEqual(result.failedDimensions, []);
  }
  const legacy = createCapabilityValidInputFixtures().B15!;
  assert.equal(parse(legacy).decision, "pass");
  const reviewed = parse({ ...legacy, scores: { ...(legacy.scores as JsonObject), pose: 0 }, overrideReason: "legacy composition review" });
  assert.equal(reviewed.decision, "pass");
  assert.deepEqual(reviewed.failedDimensions, ["pose"]);
});
