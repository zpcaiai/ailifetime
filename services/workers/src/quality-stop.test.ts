import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {LifeTimeMachineRuntime,QUALITY_CONTROLS,type ActorContext} from "@ltm/core";
import {DurableOutboxWorker,ProductionExternalCommandPublisher,ProductionRoutePublisher} from "./index.js";
test("persistent stop prevents the actual queued HTTP POST; retry after recovery retains provider key",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"quality-worker-")),path=join(directory,"runtime.sqlite");
 const actor:ActorContext={tenantId:"quality-worker",actorId:"service",roles:["service_account"],permissions:["*"],purpose:"age_transformation",stepUp:true,requestId:"quality-worker"};
 let runtime=new LifeTimeMachineRuntime({databasePath:path});let calls=0;const received:string[]=[];
 const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;received.push(String(req.headers["idempotency-key"]));res.setHeader("content-type","application/json");res.end(JSON.stringify({providerRequestId:"owned-http-boundary",artifactSha256:"a".repeat(64)}));});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const sender={send:async(input:{idempotencyKey:string})=>{
  const response=await fetch(`http://127.0.0.1:${address.port}/owned-boundary`,{method:"POST",headers:{"idempotency-key":input.idempotencyKey},body:JSON.stringify(input)});
  assert.equal(response.status,200);const artifact=Buffer.from(await response.arrayBuffer()),value=JSON.parse(artifact.toString()) as {providerRequestId:string};return {providerRequestId:value.providerRequestId,state:"accepted" as const,artifact,artifactSha256:createHash("sha256").update(artifact).digest("hex")};
 }};
 try{
  runtime.createExternalCommand(actor,{record:{collection:"generation.timeline-commands",id:"root",data:{batchId:"B14",operation:"createTimeline",operationMode:"external-command",sourceAssetId:"source",generationPlan:{templateId:"timeline-classic-v1",participantIds:["person"]}}},commandId:"root",batchId:"B14",operation:"createTimeline",idempotencyKey:"queued-intent"});
  const control=runtime.createRecord(actor,{collection:QUALITY_CONTROLS,id:"stop",ownerActorId:null,participantIds:[],data:{state:"stopped",context:{provider:"generation-engine",templateId:"timeline-classic-v1",channel:"wechat",subjectMode:"single",operation:"age"}},idempotencyKey:"stopped-control"}).value;
  const event=runtime.listOutbox(actor,{limit:200}).find(e=>e.eventType==="external_command.requested");assert.ok(event);
  await assert.rejects(new ProductionExternalCommandPublisher(runtime,actor,{B14:sender}).publish(event),{code:"PROCESSING_RESTRICTED"});assert.equal(calls,0);
  runtime.close();runtime=new LifeTimeMachineRuntime({databasePath:path});
  await assert.rejects(new ProductionExternalCommandPublisher(runtime,actor,{B14:sender}).publish(event),{code:"PROCESSING_RESTRICTED"});assert.equal(calls,0);
  // The separate operations suite verifies human resume authority; this worker receives its committed SQL postimage.
  runtime.updateRecord(actor,{collection:control.collection,id:control.id,expectedVersion:control.version,data:{...control.data,state:"active"},idempotencyKey:"committed-resume"});
  await new ProductionExternalCommandPublisher(runtime,actor,{B14:sender}).publish(event);assert.equal(calls,1);assert.deepEqual(received,[event.id]);
  await new ProductionExternalCommandPublisher(runtime,actor,{B14:sender}).publish(event);assert.equal(calls,1);assert.equal(runtime.getExternalCommand(actor,"root").state,"acknowledged");
 }finally{runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
test("internal quality projections are consumed locally without provider POST or poisoned retries",async()=>{
 const runtime=new LifeTimeMachineRuntime({databasePath:":memory:"});
 const actor:ActorContext={tenantId:"quality-internal",actorId:"service",roles:["service_account"],permissions:["*"],purpose:"age_transformation",stepUp:true,requestId:"quality-internal"};
 let calls=0;const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.end('{}');});server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");
 const sender={send:async()=>{await fetch(`http://127.0.0.1:${address.port}/must-not-receive`,{method:"POST"});throw new Error("Internal quality metadata must not leave the service");}};
 try{
  for(const [i,collection] of ["media.quality-controls","media.quality-reviews","media.quality-sample-index","media.quality-actions","media.qsample.owned"].entries())runtime.createRecord(actor,{collection,id:"internal-"+i,ownerActorId:null,participantIds:[],data:{state:"pending"},idempotencyKey:"internal-"+i});
  const publisher=new ProductionRoutePublisher(runtime,actor,{},sender),worker=new DurableOutboxWorker(runtime,actor,{media:publisher},{workerId:"internal-quality-worker"});
  assert.deepEqual(await worker.runOnce(),{published:5,failed:0});assert.equal(calls,0);assert.equal(runtime.listOutbox(actor,{status:"published"}).length,5);assert.equal(runtime.listOutbox(actor,{status:"pending"}).length,0);
  assert.deepEqual(await worker.runOnce(),{published:0,failed:0});assert.equal(runtime.verifyAuditChain(actor).valid,true);
  const event=runtime.listOutbox(actor,{status:"published"})[0]!;await assert.rejects(publisher.publish({...event,tenantId:"foreign"}),{code:"TENANT_SCOPE_MISMATCH"});
 }finally{runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
