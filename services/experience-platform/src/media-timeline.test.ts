import assert from "node:assert/strict";
import test from "node:test";
import { AgeTimelineService, type GenerationPlan, type NodeOutput } from "./media-pipeline.js";

function plan(version = 1): GenerationPlan {
  return { id: "full21", version, projectId: "project", participantId: "person", currentAge: 35,
    sourceAssetId: `source-${version}`, consentId: "consent", nodes: Array.from({ length: 21 }, (_, i) => ({ id: `age-${i * 5}`, targetAge: i * 5, qualityTier: "premium", templateVariant: "classic" })),
    identityPolicyVersion: "identity-v1", posePolicyVersion: "pose-v1", backgroundPolicyVersion: "bg-v1", wardrobePolicyVersion: "wardrobe-v1", lightingPolicyVersion: "lighting-v1", negativePolicyVersion: "negative-v1", compositionStrategy: "portrait-v1", creativeBackcastDisclosure: true };
}
function output(id: string, nodeId: string, version = 1): NodeOutput {
  return { id, planId: "full21", planVersion: version, nodeId, sourceAssetId: `source-${version}`, consentId: "consent", modelVersion: "model-test-v1", seed: `seed-${nodeId}`, replayParametersSha256: "a".repeat(64), promptPolicyVersion: "prompt-v1", costMinor: 1, qualityResultId: `quality-${id}`, traceId: `trace-${id}`, state: "publishable" };
}

test("21 output rows with one duplicated age cannot hide a missing age; latest failure removes that node", () => {
  const timeline = new AgeTimelineService();
  timeline.create(plan());
  for (let i = 0; i < 20; i++) timeline.recordOutput(output(`out-${i}`, `age-${i * 5}`));
  timeline.recordOutput(output("duplicate-age-zero", "age-0"));
  assert.equal(timeline.delivery("full21").state, "partial");
  assert.equal(timeline.delivery("full21").ready.length, 20);
  assert.deepEqual(timeline.delivery("full21").missing, [{ nodeId: "age-100", remedy: "retry" }]);
  timeline.recordOutput(output("out-100", "age-100"));
  assert.equal(timeline.delivery("full21").state, "ready");
  timeline.recordOutput({ ...output("failed-redo-100", "age-100"), state: "blocked", blockReason: "identity gate rejected" });
  assert.equal(timeline.delivery("full21").state, "partial");
  assert.deepEqual(timeline.delivery("full21").missing, [{ nodeId: "age-100", remedy: "refund" }]);
});

test("multiple plan versions require an explicit version and never reuse old source outputs", () => {
  const timeline = new AgeTimelineService();
  timeline.create(plan(1));
  const { planVersion: _version, ...legacyOutput } = output("legacy-out", "age-0");
  assert.equal(timeline.recordOutput(legacyOutput).planVersion, 1);
  timeline.create(plan(2));
  assert.throws(() => timeline.delivery("full21"), /planVersion/);
  assert.throws(() => timeline.recordOutput({ ...legacyOutput, id: "ambiguous" }), /planVersion/);
  assert.equal(timeline.delivery("full21", 2).ready.length, 0);
  assert.equal(timeline.delivery("full21", 1).ready.length, 1);
  assert.throws(() => timeline.recordOutput({ ...output("wrong-source", "age-0", 2), sourceAssetId: "source-1" }), /source and authorization/);
});

test("distinct node IDs cannot mask duplicate ages or mutate stored coverage through a returned plan", () => {
  const timeline = new AgeTimelineService();
  const original = plan();
  assert.throws(() => timeline.create({ ...original, nodes: original.nodes.map((node) => ({ ...node, targetAge: 0 })) }), /ages must be unique/);
  assert.throws(() => timeline.create({ ...original, nodes: [{ ...original.nodes[0]!, targetAge: 105 }] }), /target age/);
  const returned = timeline.create(original);
  (returned.nodes[0] as { id: string }).id = "changed-node";
  assert.doesNotThrow(() => timeline.recordOutput(output("out-zero", "age-0")));
  assert.equal(timeline.delivery("full21").ready[0], "age-0");
});
