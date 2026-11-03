import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeTimeMachineRuntime } from '@ltm/core';
import { createApiServer, StaticTokenAuthenticator } from '../dist/index.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { timelineFixture, syntheticPng } from './timeline-fixtures.mjs';

// Reports and PNGs are synthetic boundary inputs, not image-model quality evidence.
for (const couple of [false,true]) for (const dimension of ['identity','ageRange','photorealism']) test(`HTTP quality rejection/recovery ${couple?'couple':'single'} ${dimension}`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-quality-http-'));
  const f=await timelineFixture(join(directory,'runtime.sqlite'),{couple,verifiedConsent:true});
  const store=new FileTimelineArtifactStore(join(directory,'images'));
  const token='quality-consumer-token-000001';
  const authenticator=new StaticTokenAuthenticator([{token,actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}]);
  const headers={authorization:'Bearer '+token,'x-purpose':'age_transformation','content-type':'application/json'};
  const manifest=nodes=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes});
  let runtime=f.runtime,server;
  async function start(){server=createApiServer({runtime,authenticator,capabilityRegistry:f.registry,timelineArtifacts:store,appEnvironment:'test',staticDirectory:null});server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
  try {
    const good=[];
    for(let age=0;age<100;age+=5) good.push(await f.readyNode(await store.put('age-'+age,syntheticPng(age),'image/png'),age));
    const candidate=await f.readyNode(await store.put('candidate',syntheticPng(100),'image/png'),100);
    const qualityId='rejected-'+dimension,invalidId='zero-threshold-'+dimension;
    for(const id of [qualityId,invalidId]) for(const participantId of f.participantIds) for(const purpose of ['quality_assurance','age_transformation']) {
      runtime.grantConsent({...f.actor,actorId:participantId,purpose},{participantId,grantorCapacity:'self',purpose,scope:{resource:'media.quality-decisions:'+id,actions:['process']},policyVersion:purpose==='quality_assurance'?'test-quality-v1':'age-transformation-consent-v1',idempotencyKey:`consent-${id}-${participantId}-${purpose}`});
    }
    const passed=runtime.getRecord(f.service,'media.quality-decisions',candidate.qualityResultId).data;
    const low={...passed,workId:qualityId,modelVersion:'synthetic-contract-input-v1',decision:'retry',scores:{...passed.scores,[dimension]:0.1}};
    if(couple && dimension!=='photorealism') low.participantAssessments=passed.participantAssessments.map((person,index)=>index===1?{...person,scores:{...person.scores,[dimension]:0.1}}:person);
    await assert.rejects(f.registry.execute(runtime,'B15',{actor:f.service,idempotencyKey:invalidId,input:{...passed,workId:invalidId,thresholds:{...passed.thresholds,[dimension]:0}}}),/threshold/);
    assert.throws(()=>runtime.getRecord(f.service,'media.quality-decisions',invalidId),/not found/i);
    await f.registry.execute(runtime,'B15',{actor:f.service,idempotencyKey:qualityId,input:low});
    const rejected=runtime.getRecord(f.service,'media.quality-decisions',qualityId);
    assert.equal(rejected.data.decision,'retry');
    assert.ok(rejected.data.failedDimensions.includes(dimension));
    // A signed provider cannot turn a genuine stored retry decision into a ready photo.
    assert.throws(()=>runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest([...good,{...candidate,qualityResultId:qualityId}]))),/quality|participant/);
    assert.equal(runtime.getExternalCommand(f.service,'root').state,'acknowledged');
    for(const altered of [
      {...candidate,qualityResultId:good[0].qualityResultId},
      {...candidate,asset:{...candidate.asset,sha256:'f'.repeat(64)}},
    ]) assert.throws(()=>runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest([...good,altered]))),/another image\/person\/age/);
    const failed={nodeId:'age-100',targetAge:100,status:'failed',errorCode:'QUALITY_REJECTED'};
    runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest([...good,failed])));
    let base=await start();
    let view=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;
    assert.equal(view.readyCount,20);assert.equal(view.state,'partial');assert.deepEqual(view.missingAges,[100]);
    assert.equal(view.nodes[20].canRetry,true);assert.equal(view.nodes[20].errorCode,'QUALITY_REJECTED');
    const unavailable=await fetch(base+'/v1/timelines/root/nodes/100/image',{headers});
    assert.equal(unavailable.status,404);assert.equal((await unavailable.json()).error.code,'RESOURCE_NOT_FOUND');
    const siblings=view.nodes.slice(0,20);
    const body=JSON.stringify({targetAge:100,attempt:1}),retryHeaders={...headers,'idempotency-key':'quality-recovery-1'};
    let response=await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:retryHeaders,body});assert.equal(response.status,200);
    const retry=(await response.json()).data;
    const recovered=await f.readyNode(await store.put('recovered',syntheticPng(101),'image/png'),100);
    runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',manifest([recovered])));
    response=await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:retryHeaders,body});assert.equal(response.status,200);assert.equal((await response.json()).data.commandId,retry.commandId);
    view=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;
    assert.equal(view.readyCount,21);assert.equal(view.state,'ready');assert.deepEqual(view.nodes.slice(0,20),siblings);
    const download=await fetch(base+view.nodes[20].downloadPath,{headers});assert.equal(download.status,200);
    assert.equal(download.headers.get('x-ltm-image-sha256'),recovered.asset.sha256);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),syntheticPng(101));
    await new Promise(resolve=>server.close(resolve));runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);base=await start();
    view=(await(await fetch(base+'/v1/timelines/root',{headers})).json()).data;
    assert.equal(view.readyCount,21);assert.equal(view.nodes[20].attempts,1);
    const actor={...f.actor,actorId:couple?'partner':'user'};
    for(const grant of runtime.listConsents(actor).filter(grant=>grant.status==='active'&&grant.scope.resource==='media.asset:source')) runtime.withdrawConsent(actor,{consentId:grant.id,expectedVersion:grant.version,reason:'test withdrawal',idempotencyKey:'withdraw-'+grant.id});
    assert.equal((await fetch(base+view.nodes[20].downloadPath,{headers})).status,409);
    assert.equal((await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:{...headers,'idempotency-key':'revoked-retry'},body:JSON.stringify({targetAge:100,attempt:2})})).status,409);
  } finally { if(server?.listening)await new Promise(resolve=>server.close(resolve));runtime.close();rmSync(directory,{recursive:true,force:true}); }
});
