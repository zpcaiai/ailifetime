import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson,parseTimelineResultManifest } from "@ltm/core";
import { createCapabilityRegistry } from "./index.js";
import { createCapabilityValidInputFixtures } from "./valid-fixtures.js";
test("v2 aesthetic and closed calibration are required; legacy B15 still validates",()=>{
 const registry=createCapabilityRegistry(),base=createCapabilityValidInputFixtures().B15!;
 const definition=registry.get("B15");assert.ok(definition);
 const asset={sourceAssetId:"source",assetId:"output",outputSha256:"a".repeat(64),targetAge:37};
 const thresholds={identity:.8,ageRange:.8,facialDrift:.8,pose:.8,artifacts:.8,clarity:.8,background:.8,handsTeethEyes:.8,photorealism:.8,aestheticUsability:.8};
 const calibration={protocolVersion:2,id:"p2",modelVersion:"m",modelSha256:"b".repeat(64),context:{provider:"generation-engine",templateId:"t",channel:"wechat",subjectMode:"single",operation:"age"},minimumTargetAge:0,maximumTargetAge:100,minimumAgeSpan:0,maximumAgeSpan:100,ageToleranceYears:10,minimumAgeConfidence:.8,thresholds,regression:{windowSize:4,minimumSamples:2,maximumFailureRate:.5}};
 const sha=createHash("sha256").update(canonicalJson(calibration)).digest("hex");
 const controlKey="quality-control-"+createHash("sha256").update(canonicalJson({context:calibration.context,modelVersion:calibration.modelVersion,modelSha256:calibration.modelSha256})).digest("hex");
 const input={...base,participantIds:["user"],modelVersion:"m",artifactBinding:asset,thresholds,scores:Object.fromEntries(Object.keys(thresholds).map(k=>[k,.95])),decision:"pass",photoScoreEvidence:{schemaVersion:"ltm.photo-score.evidence.v2",requestSha256:"a".repeat(64),responseSha256:"c".repeat(64),sourceSha256:"d".repeat(64),modelSha256:calibration.modelSha256,calibrationId:"p2",calibrationSha256:sha,calibration,controlKey,commandId:"root",ages:[{participantId:"user",estimatedAgeYears:37,confidence:.95}]}};
 const parse=(v:unknown)=>definition.parseInput({actor:{actorId:"quality",tenantId:"tenant",roles:["platform_admin"],purpose:"quality_assurance",requestId:"v2"},idempotencyKey:"v2",input:v as import("./registry.js").JsonObject});
 assert.deepEqual(parse(input).scores,input.scores);
 for(const bad of [{...input,scores:{...input.scores,aestheticUsability:undefined}},{...input,scores:{...input.scores,aestheticUsability:0},overrideReason:"operator"},{...input,reviewEvidence:{caseId:"forged"}},{...input,photoScoreEvidence:{...input.photoScoreEvidence,controlKey:"other"}}])assert.throws(()=>parse(bad));
 assert.ok(parse(base));
});
test("additive ready-node control key never leaks onto failed nodes",()=>{
 const manifest={schemaVersion:"ltm.timeline-results.v1",sourceAssetId:"source",planVersion:"age-portrait-plan.v1",aiLabel:true,nodes:[{nodeId:"age-37",targetAge:37,status:"ready",asset:{id:"output",sha256:"a".repeat(64),mimeType:"image/png",byteLength:50,width:1,height:1},qualityResultId:"q",safetyResultId:"s",qualityControlKey:"control"}]};
 assert.equal(parseTimelineResultManifest(manifest).nodes[0]?.qualityControlKey,"control");
 assert.throws(()=>parseTimelineResultManifest({...manifest,nodes:[{nodeId:"age-37",targetAge:37,status:"failed",errorCode:"QUALITY_REJECTED",qualityControlKey:"control"}]}));
});
