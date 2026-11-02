import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityRegistry } from "./index.js";
import { createCapabilityValidInputFixtures } from "./valid-fixtures.js";
import type { CapabilityInvocation, JsonObject } from "./registry.js";
import { wardrobeBinding } from "./wardrobe-plan.js";

test("wardrobe quality requires each person's garment match plus unedited-region preservation", () => {
  for (const participantIds of [["left"], ["left","right"]]) {
    const dimensions = ["identity","ageRange","facialDrift","pose","artifacts","clarity","background","handsTeethEyes","photorealism","garmentMatch","regionPreservation"];
    const binding = wardrobeBinding({ schemaVersion: "ltm.wardrobe-edit.v1", sourceRootCommandId: "root", sourceCommandId: "root", targetAge: 5,
      sourceImage: { id: "source-image", sha256: "a".repeat(64), mimeType: "image/png", width: 64, height: 64, byteLength: 100 }, selections: participantIds.map(participantId => ({participantId,styleId:"formal"})) });
    const input: JsonObject = { ...createCapabilityValidInputFixtures().B15!, participantIds,
      artifactBinding: { sourceAssetId: "source", assetId: "new-image", outputSha256: "b".repeat(64), targetAge: 5, wardrobeBinding: binding },
      scores: Object.fromEntries(dimensions.map(d => [d,.9])), thresholds: Object.fromEntries(dimensions.map(d => [d,.8])),
      participantAssessments: participantIds.map(participantId => ({ participantId, scores: { identity:.9,ageRange:.9,facialDrift:.9,garmentMatch:.9 }, thresholds: { identity:.8,ageRange:.8,facialDrift:.8,garmentMatch:.8 } })) };
    const invocation = (data: JsonObject): CapabilityInvocation => ({ actor: { actorId: "service", tenantId: "tenant", roles: ["service_account"], purpose: "quality_assurance", requestId: "wardrobe-quality" }, idempotencyKey: "quality", input: data });
    const b15 = createCapabilityRegistry().get("B15")!;
    assert.equal(b15.parseInput(invocation(input)).decision,"pass");
    for (const dimension of ["garmentMatch","regionPreservation","identity","ageRange"]) {
      assert.throws(() => b15.parseInput(invocation({ ...input, scores: { ...input.scores as JsonObject, [dimension]: .1 }, overrideReason: "paid user requested override" })),/cannot be overridden/);
      const missing = { ...input.scores as JsonObject }; delete missing[dimension];
      assert.throws(() => b15.parseInput(invocation({ ...input, scores: missing })));
    }
    assert.throws(() => b15.parseInput(invocation({ ...input, participantAssessments: [] })),/participant/);
    const assessments = structuredClone(input.participantAssessments) as JsonObject[];
    (assessments[0]!.scores as JsonObject).garmentMatch = .1;
    assert.throws(() => b15.parseInput(invocation({ ...input, participantAssessments: assessments, overrideReason: "image average passed" })),/cannot be overridden/);
    const b17 = createCapabilityRegistry().get("B17")!;
    assert.throws(() => b17.parseInput(invocation({ ...createCapabilityValidInputFixtures().B17!, artifactBinding: { ...input.artifactBinding as JsonObject, assetId: "source-image" } })),/new image/);
  }
});
