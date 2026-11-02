import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { QualityGateService, type QualityScores } from "./media-pipeline.js";

const dimensions = ["identity_similarity", "target_age", "feature_drift", "pose_consistency", "background_consistency", "artifact", "hands_teeth_eyes", "sharpness", "aesthetic_usability", "photorealism"] as const;
const scores = (value: number) => Object.fromEntries(dimensions.map((dimension) => [dimension, value])) as unknown as QualityScores;
const context = { participantMode: "single" as const, ageSpan: "long" as const, provider: "test-evaluator", template: "portrait-v1", channel: "wechat" };
const input = { id: "q1", artifact: Buffer.from("controlled-output-bytes"), referenceArtifact: Buffer.from("controlled-original-bytes"), targetAge: 85, context, attempt: 0, spentMinor: 0 };
// Controlled evaluator responses test the real decision gate, never native image quality.
function harness(result: QualityScores = scores(.9), modelVersion = "quality-test-v1") {
  const gate = new QualityGateService({ evaluate: async () => ({ scores: result, modelVersion }) });
  gate.calibrate({ context, minimums: scores(.8), maxRetries: 2, retryCostCapMinor: 100 });
  return gate;
}

test("quality gate rejects incomplete, nonfinite and out-of-range evaluator output for every dimension", async () => {
  for (const dimension of dimensions) {
    for (const value of [NaN, Infinity, -.01, 1.01, undefined]) {
      const invalid = { ...scores(.9), [dimension]: value } as unknown as QualityScores;
      await assert.rejects(harness(invalid).evaluate(input), /every quality dimension/);
    }
    const missing = { ...scores(.9) } as unknown as Record<string, number>;
    delete missing[dimension];
    await assert.rejects(harness(missing as unknown as QualityScores).evaluate(input), /every quality dimension/);
  }
  await assert.rejects(harness({} as QualityScores).evaluate(input), /every quality dimension/);
  await assert.rejects(harness(scores(.9), "").evaluate(input), /model version/);
});

test("calibration requires a complete score policy and evaluation validates budget/reference/age", async () => {
  const gate = harness();
  assert.throws(() => gate.calibrate({ context, minimums: {} as QualityScores, maxRetries: 1, retryCostCapMinor: 100 }), /every quality dimension/);
  for (const delta of [{ attempt: -1 }, { attempt: NaN }, { spentMinor: -1 }, { targetAge: 101 }, { targetAge: NaN }, { artifact: new Uint8Array() }, { referenceArtifact: new Uint8Array() }]) {
    await assert.rejects(gate.evaluate({ ...input, ...delta }), /quality|cost/);
  }
});

test("original and target age reach evaluator and decision binds actual bytes and dimension values", async () => {
  const gate = new QualityGateService({ evaluate: async (artifact, reference) => {
    assert.deepEqual(Buffer.from(artifact), input.artifact);
    assert.deepEqual(Buffer.from(reference.referenceArtifact), input.referenceArtifact);
    assert.equal(reference.targetAge, 85);
    return { scores: scores(.93), modelVersion: "quality-test-v1" };
  } });
  gate.calibrate({ context, minimums: scores(.8), maxRetries: 2, retryCostCapMinor: 100 });
  const result = await gate.evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.referenceSha256, createHash("sha256").update(input.referenceArtifact).digest("hex"));
  assert.equal(result.outputSha256, createHash("sha256").update(input.artifact).digest("hex"));
  assert.equal(result.scores.photorealism, .93);
  assert.equal(result.minimums.target_age, .8);
  assert.equal(Object.isFrozen(result.scores), true);
});

test("identity, age, anatomy and realism failures cannot be overridden; exhausted budget never auto-routes", async () => {
  for (const dimension of ["identity_similarity", "target_age", "feature_drift", "artifact", "hands_teeth_eyes", "photorealism"]) {
    const gate = harness({ ...scores(.9), [dimension]: .1 });
    const failed = await gate.evaluate({ ...input, attempt: 2, spentMinor: 100 });
    assert.equal(failed.passed, false);
    assert.equal(failed.route, "human_review");
    assert.deepEqual(failed.failedDimensions, [dimension]);
    await assert.rejects(gate.evaluate({ ...input, override: { actorId: "reviewer", reason: "approve" } }), /cannot be overridden/);
  }
});

test("quality regression circuit cannot be forced open for publication by a manual override", async () => {
  const gate = harness({ ...scores(.9), sharpness: .1 });
  for (let i = 0; i < 10; i++) await gate.evaluate({ ...input, id: `q-${i}` });
  await assert.rejects(gate.evaluate({ ...input, override: { actorId: "reviewer", reason: "force pass" } }), /cannot be overridden/);
});

test("asynchronous caller mutation cannot rebind the quality decision age, identity or budget", async () => {
  const mutable = { ...input, context: { ...context }, artifact: Buffer.from(input.artifact), referenceArtifact: Buffer.from(input.referenceArtifact) };
  const gate = new QualityGateService({ evaluate: async (_artifact, reference) => {
    assert.equal(reference.targetAge, 85);
    mutable.targetAge = 5;
    mutable.id = "changed-id";
    mutable.attempt = 100;
    mutable.context.provider = "other-provider";
    mutable.referenceArtifact.fill(0);
    return { scores: { ...scores(.9), sharpness: .1 }, modelVersion: "quality-test-v1" };
  } });
  gate.calibrate({ context, minimums: scores(.8), maxRetries: 2, retryCostCapMinor: 100 });
  const decision = await gate.evaluate(mutable);
  assert.equal(decision.id, "q1");
  assert.equal(decision.targetAge, 85);
  assert.equal(decision.route, "retry");
  assert.equal(decision.referenceSha256, createHash("sha256").update(input.referenceArtifact).digest("hex"));
});

test("evaluator cannot mutate evaluated bytes while returning a score for the original digest", async () => {
  const gate = new QualityGateService({ evaluate: async (artifact) => {
    artifact.fill(0);
    return { scores: scores(.9), modelVersion: "quality-test-v1" };
  } });
  gate.calibrate({ context, minimums: scores(.8), maxRetries: 2, retryCostCapMinor: 100 });
  await assert.rejects(gate.evaluate(input), /mutated the bound input bytes/);
});
