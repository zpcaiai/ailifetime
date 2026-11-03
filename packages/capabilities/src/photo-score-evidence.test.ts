import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@ltm/core";
import { createCapabilityRegistry } from "./index.js";
import type { CapabilityInvocation, JsonObject } from "./registry.js";

function input(): JsonObject {
  const dimensions=["identity","ageRange","facialDrift","pose","artifacts","clarity","background","handsTeethEyes","photorealism"];
  const data: JsonObject = {workId:"score",participantIds:["person"],modelVersion:"test-model",decision:"pass",scores:Object.fromEntries(dimensions.map(d=>[d,.9])),thresholds:Object.fromEntries(dimensions.map(d=>[d,.8])),
    artifactBinding:{sourceAssetId:"source",assetId:"output",outputSha256:"a".repeat(64),targetAge:37},
    photoScoreEvidence:{schemaVersion:"ltm.photo-score.evidence.v1",requestSha256:"b".repeat(64),responseSha256:"c".repeat(64),sourceSha256:"d".repeat(64),modelSha256:"e".repeat(64),calibrationId:"test-calibration",ages:[{participantId:"person",estimatedAgeYears:37.1,confidence:.9}]}};
  const calibration:JsonObject={id:"test-calibration",modelVersion:"test-model",modelSha256:"e".repeat(64),context:{provider:"generation-engine",templateId:"timeline-classic-v1",channel:"wechat",subjectMode:"single",operation:"age"},minimumTargetAge:0,maximumTargetAge:100,minimumAgeSpan:0,maximumAgeSpan:100,ageToleranceYears:10,minimumAgeConfidence:.8,thresholds:{...(data.thresholds as JsonObject)}};
  Object.assign(data.photoScoreEvidence as JsonObject,{calibration,calibrationSha256:createHash("sha256").update(canonicalJson(calibration)).digest("hex")});
  return data;
}
function parse(data: JsonObject) {
  const invocation: CapabilityInvocation={actor:{actorId:"evaluator",tenantId:"tenant",roles:["service_account"],purpose:"age_transformation",requestId:"scoring-evidence"},idempotencyKey:"scoring-evidence",input:data};
  return createCapabilityRegistry().get("B15")!.parseInput(invocation);
}
test("B15 retains versioned pixel-scorer provenance and per-person age confidence",()=>{
  const data=input();assert.deepEqual(parse(data).photoScoreEvidence,data.photoScoreEvidence);
  delete data.photoScoreEvidence;assert.equal(parse(data).decision,"pass");
});
test("photo calibration digest remains valid after SQL canonical JSON normalization",()=>{
  const data=input(),normalized=JSON.parse(canonicalJson(data)) as JsonObject;
  const evidence=parse(normalized).photoScoreEvidence as JsonObject;
  assert.equal(evidence.calibrationSha256,createHash("sha256").update(canonicalJson(evidence.calibration)).digest("hex"));
  const changed=structuredClone(normalized);(changed.photoScoreEvidence as JsonObject).calibrationSha256="f".repeat(64);
  assert.throws(()=>parse(changed),/calibration snapshot/);
});
test("unknown evidence, broken model/source digest and swapped/nonfinite age estimates cannot be persisted",()=>{
  for(const mutation of [(e:JsonObject)=>e.modelSha256="bad",(e:JsonObject)=>e.schemaVersion="unknown",(e:JsonObject)=>e.extra=true,
    (e:JsonObject)=>e.ages=[],(e:JsonObject)=>e.calibrationSha256="f".repeat(64),(e:JsonObject)=>(e.calibration as JsonObject).ageToleranceYears=20,(e:JsonObject)=>(e.ages as JsonObject[])[0]!.participantId="stranger",
    (e:JsonObject)=>(e.ages as JsonObject[])[0]!.confidence=NaN,(e:JsonObject)=>(e.ages as JsonObject[])[0]!.estimatedAgeYears=Infinity]) {
    const data=input();mutation(data.photoScoreEvidence as JsonObject);assert.throws(()=>parse(data),/photo scoring/);
  }
  const unbound=input();delete unbound.artifactBinding;assert.throws(()=>parse(unbound),/artifact binding/);
});
