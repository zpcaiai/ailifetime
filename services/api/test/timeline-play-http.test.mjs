import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeTimeMachineRuntime } from '@ltm/core';
import { createApiServer,StaticTokenAuthenticator } from '../dist/index.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { timelineFixture,syntheticPng } from './timeline-fixtures.mjs';

for(const couple of [false,true])for(const lifespan of [false,true])test(`actual HTTP original bytes, full delivery and restart ${couple?'couple':'single'} ${lifespan?'21':'age37'}`,async()=>{
  const ages=lifespan?Array.from({length:21},(_,i)=>i*5):[37],last=ages.at(-1);
  const directory=mkdtempSync(join(tmpdir(),'ltm-play-http-')),f=await timelineFixture(join(directory,'runtime.sqlite'),{couple,targetAges:ages,verifiedConsent:true});
  let runtime=f.runtime,server;
  const store=new FileTimelineArtifactStore(join(directory,'images')),token='mode-consumer-token-0000001',partnerToken='mode-partner-token-0000002';
  const authenticator=new StaticTokenAuthenticator([{token,actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']},...(couple?[{token:partnerToken,actorId:'partner',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}]:[])]);
  const headers={authorization:'Bearer '+token,'x-purpose':'age_transformation','content-type':'application/json'};
  const manifest=nodes=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes});
  async function start(){server=createApiServer({runtime,authenticator,capabilityRegistry:f.registry,timelineArtifacts:store,appEnvironment:'test',staticDirectory:null});server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
  try{
    const nodes=[];for(const age of ages.slice(0,-1)){const asset=await store.put('synthetic-'+age,syntheticPng(age),'image/png');nodes.push(await f.readyNode(asset,age));}
    nodes.push({nodeId:'age-'+last,targetAge:last,status:'failed',errorCode:'PROVIDER_TRANSIENT'});
    runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest(nodes)));let base=await start();
    if(couple){
      const input={id:'partner-http-consent',participantId:'partner',grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['ingest','transform']},policyVersion:'age-transformation-consent-v1'};
      const wrong=await fetch(base+'/v1/commands',{method:'POST',headers:{...headers,'idempotency-key':'wrong-partner'},body:JSON.stringify({command:'consent.grant',input})});assert.equal(wrong.status,403);
      const own=await fetch(base+'/v1/commands',{method:'POST',headers:{...headers,authorization:'Bearer '+partnerToken,'idempotency-key':'partner-self'},body:JSON.stringify({command:'consent.grant',input})});const ownBody=await own.json();assert.equal(own.status,200,JSON.stringify(ownBody));
    }
    let response=await fetch(base+'/v1/timelines/root',{headers});assert.equal(response.status,200);let view=(await response.json()).data;assert.deepEqual(view.missingAges,[last]);assert.equal(view.expectedCount,ages.length);
    const body=JSON.stringify({targetAge:last,attempt:1}),retryHeaders={...headers,'idempotency-key':'mode-retry'};
    response=await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:retryHeaders,body});assert.equal(response.status,200);const retry=(await response.json()).data;
    const asset=await store.put('synthetic-last',syntheticPng(last),'image/png');const ready=await f.readyNode(asset,last);runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',manifest([ready])));
    const replay=await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:retryHeaders,body});assert.equal((await replay.json()).data.commandId,retry.commandId);
    view=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;assert.equal(view.readyCount,ages.length);assert.equal(view.state,'ready');assert.deepEqual(view.nodes.map(n=>n.targetAge),ages);
    for(const node of view.nodes){const image=await fetch(base+node.downloadPath,{headers});assert.equal(image.status,200);assert.equal(image.headers.get('x-ltm-image-sha256'),node.asset.sha256);assert.deepEqual(Buffer.from(await image.arrayBuffer()),syntheticPng(node.targetAge));}
    await new Promise(r=>server.close(r));runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);base=await start();view=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;assert.equal(view.readyCount,ages.length);assert.equal(view.nodes.at(-1).attempts,1);
    const withdrawingActor={...f.actor,actorId:couple?'partner':'user'};
    const grants=runtime.listConsents(withdrawingActor).filter(grant=>grant.participantId===withdrawingActor.actorId&&grant.status==='active'&&grant.scope.resource==='media.asset:source');assert.ok(grants.length>0);
    for(const grant of grants)runtime.withdrawConsent(withdrawingActor,{consentId:grant.id,expectedVersion:grant.version,reason:'withdraw source',idempotencyKey:'withdraw-'+grant.id});
    const denied=await fetch(base+'/v1/timelines/root/nodes/'+last+'/image',{headers});assert.equal(denied.status,409);
  }finally{if(server?.listening)await new Promise(r=>server.close(r));runtime.close();rmSync(directory,{recursive:true,force:true});}
});
