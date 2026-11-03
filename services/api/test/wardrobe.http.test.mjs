import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeTimeMachineRuntime } from '@ltm/core';
import { createApiServer,StaticTokenAuthenticator } from '../dist/index.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { syntheticPng } from './timeline-fixtures.mjs';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';

// Supported operator workflow; retail payment gating is tested separately.
for(const couple of [false,true])test(`actual operator wardrobe HTTP ${couple?'couple':'single'} creates independent copy, recovers, saves exact bytes and rejects revoked access`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-wardrobe-')),store=new FileTimelineArtifactStore(join(directory,'images'));
  const f=await wardrobeFixture({couple,databasePath:join(directory,'runtime.sqlite'),store,verifiedConsent:true});let runtime=f.runtime,server;
  const headers={authorization:'Bearer wardrobe-consumer-token-000001','x-purpose':'age_transformation','content-type':'application/json'},path='/v1/timelines/root/nodes/37/wardrobe';
  async function start(){server=createApiServer({runtime,capabilityRegistry:f.registry,authenticator:new StaticTokenAuthenticator(f.participantIds.map(participantId=>({token:participantId==='user'?'wardrobe-consumer-token-000001':'wardrobe-partner-token-000002',actorId:participantId,tenantId:'tenant',roles:participantId==='user'?['consumer','studio_operator']:['consumer'],allowedPurposes:['age_transformation']}))),timelineArtifacts:store,appEnvironment:'test',staticDirectory:null});server.listen(0,'127.0.0.1');await once(server,'listening');return'http://127.0.0.1:'+server.address().port;}
  const request=(base,body,key='wardrobe-intent')=>fetch(base+path,{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
  try{
    let base=await start();assert.equal((await fetch(base+path)).status,401);
    const context=(await(await fetch(base+path,{headers})).json()).data;assert.equal(context.participants.length,couple?2:1);assert.equal(context.targetAge,37);assert.equal(context.participants.every(p=>!p.authorized),true);
    assert.equal(context.catalogVersion,'lifetime-wardrobe.v1');assert.equal(context.styles.length,34);
    assert.equal(context.styles.filter(s=>!s.legacy).length,31);assert.equal(new Set(context.styles.filter(s=>!s.legacy).map(s=>s.seriesId)).size,8);
    for(const s of context.styles)assert.equal(s.available,37>=s.minAge&&37<=s.maxAge&&(couple?2:1)>=s.minPeople);
    assert.equal((await request(base,{selections:f.edit.selections})).status,409);
    for(const participantId of f.participantIds){
      const data={command:'consent.grant',input:{id:'wardrobe-self-'+participantId,participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:'wardrobe-edit-consent-v1'}};
      if(participantId==='partner')assert.equal((await fetch(base+'/v1/commands',{method:'POST',headers:{...headers,'idempotency-key':'wrong-wardrobe-grant'},body:JSON.stringify(data)})).status,403);
      const grant=await fetch(base+'/v1/commands',{method:'POST',headers:{...headers,authorization:'Bearer '+(participantId==='user'?'wardrobe-consumer-token-000001':'wardrobe-partner-token-000002'),'idempotency-key':'self-wardrobe-'+participantId},body:JSON.stringify(data)});assert.equal(grant.status,200);
      const stored=f.runtime.listConsents({...f.actor,actorId:participantId}).find(c=>c.scope.actions.includes('wardrobe'));assert.match(stored.policyCatalogSha256,/^[a-f0-9]{64}$/);assert.equal(stored.policyVersion,'wardrobe-edit-consent-v1');
    }
    for(const [index,body] of [{selections:f.edit.selections,sourceAssetId:'attacker'},{selections:f.edit.selections.map(s=>({...s,styleId:'unknown'}))},{selections:[]},{selections:[{participantId:'stranger',styleId:'formal'}]}].entries())assert.equal((await request(base,body,'invalid-'+index)).status,422);
    for(const id of ['wedding-anniversary-v1','milestone-retirement-v1',...(!couple?['together-knit-v1','newyear-pair-v1']:[])])assert.equal((await request(base,{selections:f.edit.selections.map(s=>({...s,styleId:id}))},'ineligible-'+id)).status,422);
    const selections=couple?f.edit.selections:f.edit.selections.map(s=>({...s,styleId:'east-pankou-v1'}));
    let response=await request(base,{selections});assert.equal(response.status,200);const job=(await response.json()).data.commandId;
    assert.equal((await(await request(base,{selections})).json()).data.commandId,job);
    assert.equal((await request(base,{selections:f.edit.selections.map(s=>({...s,styleId:'casual'}))})).status,409);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback(job,'failed'));
    response=await fetch(base+'/v1/timelines/'+job+'/retry',{method:'POST',headers:{...headers,'idempotency-key':'wardrobe-retry'},body:JSON.stringify({targetAge:37,attempt:1})});assert.equal(response.status,200);const child=(await response.json()).data.commandId;
    const bytes=syntheticPng(9),asset=await store.put('wardrobe-image',bytes,'image/png');f.runtime.applyExternalBusinessEvent(f.service,f.callback(child,'succeeded',f.manifest([await f.readyWardrobe(asset,child)])));
    let view=(await(await fetch(base+'/v1/timelines/'+job,{headers})).json()).data;assert.equal(view.state,'ready');assert.equal(view.expectedCount,1);assert.equal(view.nodes[0].targetAge,37);assert.equal(view.nodes[0].attempts,1);assert.deepEqual(view.wardrobeSource.selections,selections);
    response=await fetch(base+view.nodes[0].downloadPath,{headers});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    const original=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;assert.equal(original.nodes[0].asset.sha256,f.sourceImage.sha256);assert.notEqual(original.nodes[0].asset.sha256,view.nodes[0].asset.sha256);
    await new Promise(r=>server.close(r));runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);base=await start();view=(await(await fetch(base+'/v1/timelines/'+job,{headers})).json()).data;assert.equal(view.readyCount,1);assert.deepEqual(view.wardrobeSource.selections,selections);
    const actor={...f.actor,actorId:couple?'partner':'user'},grant=runtime.listConsents(actor).find(c=>c.scope.actions.includes('wardrobe'));
    runtime.withdrawConsent(actor,{consentId:grant.id,expectedVersion:grant.version,reason:'withdraw wardrobe',idempotencyKey:'http-wardrobe-withdraw'});
    assert.equal((await fetch(base+'/v1/timelines/'+job+'/nodes/37/image',{headers})).status,409);assert.equal((await fetch(base+'/v1/timelines/root/nodes/37/image',{headers})).status,200);
  }finally{if(server?.listening)await new Promise(r=>server.close(r));runtime.close();rmSync(directory,{recursive:true,force:true});}
});
