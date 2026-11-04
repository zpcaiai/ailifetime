import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {LifeTimeMachineRuntime} from "./runtime.js";
import {assertQualityTrafficAllowed,QUALITY_CONTROLS,qualityTemplate} from "./quality-traffic.js";
test("SQL persisted quality latch survives restart and isolates template, operation and tenant",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"quality-traffic-")),options={databasePath:join(dir,"state.sqlite"),allowLegacyConsentPolicy:true};
 let runtime=new LifeTimeMachineRuntime(options);
 const actor={tenantId:"tenant",actorId:"worker",roles:["platform_admin" as const],purpose:"age_transformation",requestId:"quality"};
 const plan={templateId:"template",participantIds:["user"]};
 try{
  await assertQualityTrafficAllowed(runtime,actor,plan);
  runtime.createRecord(actor,{collection:QUALITY_CONTROLS,id:"control",ownerActorId:null,idempotencyKey:"control",data:{state:"stopped",context:{provider:"generation-engine",templateId:"template",subjectMode:"single",operation:"age"}}});
  await assert.rejects(assertQualityTrafficAllowed(runtime,actor,plan),{code:"PROCESSING_RESTRICTED"});
  await assertQualityTrafficAllowed(runtime,actor,{...plan,templateId:"other"});await assertQualityTrafficAllowed(runtime,{...actor,tenantId:"other"},plan);
  runtime.close();runtime=new LifeTimeMachineRuntime(options);await assert.rejects(assertQualityTrafficAllowed(runtime,actor,plan),{code:"PROCESSING_RESTRICTED"});
  const old=runtime.getRecord(actor,QUALITY_CONTROLS,"control");runtime.updateRecord(actor,{collection:QUALITY_CONTROLS,id:"control",expectedVersion:old.version,idempotencyKey:"unknown",data:{...old.data,state:"unknown"}});
  await assert.rejects(assertQualityTrafficAllowed(runtime,actor,plan),{code:"DEPENDENCY_UNAVAILABLE"});
  assert.notEqual(qualityTemplate({wardrobePolicy:{selections:[{styleId:"a"}]}}),qualityTemplate({wardrobePolicy:{selections:[{styleId:"b"}]}}));
 }finally{runtime.close();rmSync(dir,{recursive:true,force:true});}
});
