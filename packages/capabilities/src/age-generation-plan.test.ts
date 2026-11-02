import assert from "node:assert/strict";
import test from "node:test";
import { buildAgeGenerationPlan, LIFESPAN_AGES } from "./age-generation-plan.js";
import { createCapabilityRegistry } from "./index.js";
import { createCapabilityValidInputFixtures } from "./valid-fixtures.js";
import type { CapabilityInvocation, JsonObject } from "./registry.js";
import { LifeTimeMachineRuntime } from "@ltm/core";

const base = {
  sourceAssetId: "source-1", participantIds: ["person-1"], targetAges: [...LIFESPAN_AGES],
  seed: "seed-1", promptPolicyVersion: "prompt-v1", currentAge: 35, timelineProfile: "lifespan-21-v1",
};

test("single-age and couple profiles preserve exact targets and two independent original references", () => {
  for (const age of [0, 37, 100]) {
    const single = buildAgeGenerationPlan({ ...base, timelineProfile: "single-age-v1", targetAges: [age] });
    assert.equal(single.expectedImageCount, 1);
    assert.deepEqual((single.nodes as JsonObject[]).map(n => n.targetAge), [age]);
    const pair = buildAgeGenerationPlan({ ...base, participantIds: ["left-person", "right-person"], participantAges: [35, 32], timelineProfile: "single-age-couple-v1", targetAges: [age] });
    assert.equal(pair.subjectMode, "couple");
    assert.match(String((pair.identityPolicy as JsonObject).instruction), /BOTH.*separately/);
    assert.match(String((pair.compositionPolicy as JsonObject).interaction), /no romantic or sexualized/);
    assert.deepEqual(((pair.nodes as JsonObject[])[0]!.participantTargets as JsonObject[]).map(p => [p.participantId, p.position, p.targetAge, p.sourceAge]), [["left-person","left",age,35],["right-person","right",age,32]]);
  }
  const pair21 = buildAgeGenerationPlan({ ...base, participantIds: ["left-person", "right-person"], participantAges: [35,32], timelineProfile: "lifespan-21-couple-v1" });
  assert.equal(pair21.expectedImageCount,21);
  for (const invalid of [
    {...base,timelineProfile:"single-age-v1"},
    {...base,timelineProfile:"single-age-v1",targetAges:[]},
    {...base,timelineProfile:"single-age-couple-v1",targetAges:[37],participantIds:["a","b"]},
    {...base,timelineProfile:"lifespan-21-couple-v1",participantIds:["a","a"],participantAges:[35,32]},
    {...base,timelineProfile:"lifespan-21-couple-v1",participantIds:["a","b"],participantAges:[35,101]},
  ]) assert.throws(()=>buildAgeGenerationPlan(invalid),/profile|target ages/);
});

test("B14 accepts a real single-age request and rejects empty or invalid targets", () => {
  const b14=createCapabilityRegistry().get("B14")!;
  const parsed=b14.parseInput(invocation({...base,jobId:"one-age",timelineProfile:"single-age-v1",targetAges:[0],illustrativeLabel:true}));
  assert.deepEqual(parsed.targetAges,[0]);assert.equal((parsed.generationPlan as JsonObject).expectedImageCount,1);
  for(const targetAges of [[],[NaN],[-1],[101],[35,35]])assert.throws(()=>b14.parseInput(invocation({...base,jobId:"invalid",timelineProfile:"single-age-v1",targetAges,illustrativeLabel:true})));
});
function invocation(input: JsonObject): CapabilityInvocation {
  return { actor: { actorId: "person-1", tenantId: "tenant-1", roles: ["consumer"], purpose: "age_transformation", requestId: "plan-test" }, idempotencyKey: "plan-test", input };
}

test("full lifespan has exactly 21 distinct original-anchored replayable age nodes", () => {
  const plan = buildAgeGenerationPlan(base);
  assert.equal(plan.expectedImageCount, 21);
  const nodes = plan.nodes as JsonObject[];
  assert.deepEqual(nodes.map((node) => node.targetAge), Array.from({ length: 21 }, (_, index) => index * 5));
  assert.equal(new Set(nodes.map((node) => node.seed)).size, 21);
  assert.ok(nodes.every((node) => node.sourceAssetId === base.sourceAssetId));
  assert.ok(nodes.every((node) => (node.requiredQualityDimensions as string[]).includes("photorealism")));
  assert.equal(nodes[0]?.creativeBackcast, true);
  assert.equal(nodes[7]?.creativeBackcast, false);
  assert.match(String(nodes[0]?.ageInstruction), /Newborn/);
  assert.match(String(nodes[20]?.ageInstruction), /advanced aging/);
  assert.deepEqual(buildAgeGenerationPlan(base), plan);
  const differentSource = buildAgeGenerationPlan({ ...base, sourceAssetId: "another-person" });
  assert.notEqual((differentSource.nodes as JsonObject[])[0]?.seed, nodes[0]?.seed);
});

test("full profile rejects missing age, missing/extra/reordered ages, multiple people and unknown profile", () => {
  const { currentAge: _currentAge, ...withoutCurrentAge } = base;
  for (const input of [
    withoutCurrentAge, { ...base, currentAge: Number.NaN }, { ...base, currentAge: 101 },
    { ...base, targetAges: LIFESPAN_AGES.slice(1) }, { ...base, targetAges: [...LIFESPAN_AGES, 105] },
    { ...base, targetAges: [...LIFESPAN_AGES].reverse() }, { ...base, participantIds: ["person-1", "person-2"] },
    { ...base, timelineProfile: "unknown" },
  ]) assert.throws(() => buildAgeGenerationPlan(input), /currentAge|lifespan|profile/);
});

test("B14 parser emits server-owned plan while preserving custom/legacy inputs", () => {
  const capability = createCapabilityRegistry().get("B14");
  assert.ok(capability);
  const parsed = capability.parseInput(invocation({ ...base, jobId: "job-1", illustrativeLabel: true,
    generationPlan: { identityPolicy: "attacker-replacement" } }));
  assert.equal((parsed.generationPlan as JsonObject).expectedImageCount, 21);
  assert.equal(((parsed.generationPlan as JsonObject).identityPolicy as JsonObject).anchor, "original_source_for_every_node");
  const legacy = capability.parseInput(invocation({ jobId: "legacy", sourceAssetId: "source-1", participantIds: ["person-1"], targetAges: [18, 60], seed: "seed", promptPolicyVersion: "v1", illustrativeLabel: true }));
  assert.equal((legacy.generationPlan as JsonObject).currentAge, null);
  assert.equal((legacy.generationPlan as JsonObject).expectedImageCount, 2);
});

test("the original canonical B14 fixture stays parseable", () => {
  const fixture = createCapabilityValidInputFixtures().B14;
  assert.ok(fixture);
  const parsed = createCapabilityRegistry().get("B14")?.parseInput(invocation(fixture));
  assert.ok(parsed?.generationPlan);
});

test("selected template is retained in B14 and changes per-node replay seed", () => {
  const selected = createCapabilityRegistry().get("B14")?.parseInput(invocation({ ...base,
    jobId: "selected-template-job", illustrativeLabel: true, templateId: "portrait-selected-v2" }));
  assert.equal(selected?.templateId, "portrait-selected-v2");
  const plan = selected?.generationPlan as JsonObject;
  assert.equal(plan.templateId, "portrait-selected-v2");
  const classic = buildAgeGenerationPlan(base);
  assert.equal(classic.templateId, "timeline-classic-v1");
  assert.notEqual((plan.nodes as JsonObject[])[0]?.seed, (classic.nodes as JsonObject[])[0]?.seed);
});

test("B15 fails closed on non-finite dimensions and critical pass overrides", () => {
  const quality = createCapabilityRegistry().get("B15");
  assert.ok(quality);
  const original = createCapabilityValidInputFixtures().B15;
  assert.ok(original);
  for (const dimension of ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity"]) {
    for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1]) {
      assert.throws(() => quality.parseInput(invocation({ ...original, scores: { ...(original.scores as JsonObject), [dimension]: value } })), /between zero and one/);
      assert.throws(() => quality.parseInput(invocation({ ...original, thresholds: { ...(original.thresholds as JsonObject), [dimension]: value } })), /between zero and one/);
    }
  }
  for (const dimension of ["identity", "ageRange", "facialDrift", "artifacts"]) {
    assert.throws(() => quality.parseInput(invocation({ ...original,
      scores: { ...(original.scores as JsonObject), [dimension]: 0.1 }, overrideReason: "paid customer requested approval",
    })), /cannot be overridden/);
  }
  assert.throws(() => quality.parseInput(invocation({ ...original, overrideReason: "   " })), /overrideReason/);
  assert.equal(quality.parseInput(invocation(original)).decision, "pass");
});

test("ordinary consumers cannot persist their own quality scores or thresholds", async () => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:", allowLegacyConsentPolicy: true });
  try {
    const fixture = createCapabilityValidInputFixtures().B15;
    assert.ok(fixture);
    await assert.rejects(createCapabilityRegistry().execute(runtime, "B15", invocation(fixture)),
      (error: unknown) => error instanceof Error && /media.quality.evaluate/.test(error.message));
  } finally { runtime.close(); }
});

test("couple output quality cannot pass by averaging away either person's identity or age failure", () => {
  const b15=createCapabilityRegistry().get("B15")!;
  const dimensions=["identity","ageRange","facialDrift","pose","artifacts","clarity","background","handsTeethEyes","photorealism"];
  const assessment=(participantId:string)=>({participantId,scores:{identity:.9,ageRange:.9,facialDrift:.9},thresholds:{identity:.8,ageRange:.8,facialDrift:.8}});
  const input={...createCapabilityValidInputFixtures().B15,participantIds:["left","right"],
    artifactBinding:{sourceAssetId:"source",assetId:"pair-37",outputSha256:"a".repeat(64),targetAge:37},
    scores:Object.fromEntries(dimensions.map(d=>[d,.9])),thresholds:Object.fromEntries(dimensions.map(d=>[d,.8])),
    participantAssessments:[assessment("left"),assessment("right")]};
  assert.deepEqual(b15.parseInput(invocation(input)).participantAssessments,input.participantAssessments);
  for(const people of [undefined,[assessment("left")],[assessment("left"),assessment("left")],[assessment("left"),assessment("stranger")]])assert.throws(()=>b15.parseInput(invocation({...input,participantAssessments:people as unknown as JsonObject[]})),/participant quality/);
  for(const dimension of ["identity","ageRange","facialDrift"]){
    const right=assessment("right");right.scores[dimension as keyof typeof right.scores]=.1;
    assert.throws(()=>b15.parseInput(invocation({...input,participantAssessments:[assessment("left"),right],overrideReason:"aggregate average passes"})),/cannot be overridden/);
  }
});

test("ordinary consumers cannot certify their own safety or provenance", async () => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:", allowLegacyConsentPolicy: true });
  try {
    const fixture = createCapabilityValidInputFixtures().B17;
    assert.ok(fixture);
    await assert.rejects(createCapabilityRegistry().execute(runtime, "B17", invocation(fixture)),
      (error: unknown) => error instanceof Error && /media.safety.certify/.test(error.message));
  } finally { runtime.close(); }
});

test("artifact-bound quality and safety decisions retain exact source, age and output digest", () => {
  const registry = createCapabilityRegistry();
  const fixtures = createCapabilityValidInputFixtures();
  const binding = { sourceAssetId: "source-1", assetId: "image-5", outputSha256: "a".repeat(64), targetAge: 5 };
  const quality = fixtures.B15!;
  const full = { ...quality, artifactBinding: binding, scores: { ...(quality.scores as JsonObject), background: .9, handsTeethEyes: .9, photorealism: .9 }, thresholds: { ...(quality.thresholds as JsonObject), background: .8, handsTeethEyes: .8, photorealism: .8 } };
  assert.deepEqual(registry.get("B15")!.parseInput(invocation(full)).artifactBinding, binding);
  assert.throws(() => registry.get("B15")!.parseInput(invocation({ ...quality, artifactBinding: binding })), /between zero and one/);
  assert.throws(() => registry.get("B15")!.parseInput(invocation({ ...full, scores: { ...full.scores, photorealism: .1 }, overrideReason: "force pass" })), /cannot be overridden/);
  assert.deepEqual(registry.get("B17")!.parseInput(invocation({ ...fixtures.B17!, artifactBinding: binding })).artifactBinding, binding);
});
