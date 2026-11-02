import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeTimeMachineRuntime } from '@ltm/core';
import { createApiServer, StaticTokenAuthenticator } from '../dist/index.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { timelineFixture,syntheticPng } from './timeline-fixtures.mjs';

test('signed partial21 → live HTTP timeline → per-age durable retry → all21 → original bytes → restart → consent withdrawal',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-timeline-http-')), f=await timelineFixture(join(directory,'runtime.sqlite'));
  const store=new FileTimelineArtifactStore(join(directory,'images'));
  const authenticator=new StaticTokenAuthenticator([{token:'timeline-consumer-token-000001',actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}]);
  let runtime=f.runtime,server;
  async function start(){server=createApiServer({runtime,authenticator,capabilityRegistry:f.registry,timelineArtifacts:store,appEnvironment:'test',staticDirectory:null});server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
  const headers={authorization:'Bearer timeline-consumer-token-000001','x-purpose':'age_transformation','content-type':'application/json'};
  const manifest=nodes=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes});
  try{
    const nodes=[];
    for(let i=0;i<21;i++){if(i===20){nodes.push({nodeId:'age-100',targetAge:100,status:'failed',errorCode:'PROVIDER_TRANSIENT'});continue;}
      const asset=await store.put(`synthetic-${i}`,syntheticPng(i,1024,1024),'image/png');nodes.push(await f.readyNode(asset,i*5));}
    runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest(nodes)));
    let base=await start();
    const original=runtime.getRecord(f.actor,'generation.timeline-commands','root');
    await f.registry.execute(runtime,'B14',{actor:f.actor,idempotencyKey:'colon-root',input:{...original.data,jobId:'colon:root'}});
    assert.equal((await fetch(`${base}/v1/timelines/colon%3Aroot`,{headers})).status,200);
    assert.equal((await fetch(`${base}/v1/timelines/root`)).status,401);
    let view=await (await fetch(`${base}/v1/timelines/root`,{headers})).json();
    assert.equal(view.data.readyCount,20);assert.deepEqual(view.data.missingAges,[100]);assert.equal(view.data.nodes[20].canRetry,true);
    assert.equal((await fetch(`${base}/v1/timelines/root/nodes/00/image`,{headers})).status,422);
    const retry=await (await fetch(`${base}/v1/timelines/root/retry`,{method:'POST',headers:{...headers,'idempotency-key':'retry-100-attempt-1'},body:JSON.stringify({targetAge:100,attempt:1})})).json();
    assert.ok(retry.data.commandId);
    const finalAsset=await store.put('synthetic-100',syntheticPng(20,1024,1024),'image/png'), finalNode=await f.readyNode(finalAsset,100);
    runtime.applyExternalBusinessEvent(f.service,f.callback(retry.data.commandId,'succeeded',manifest([finalNode])));
    view=await (await fetch(`${base}/v1/timelines/root`,{headers})).json();assert.equal(view.data.readyCount,21);assert.equal(view.data.state,'ready');
    const image=await fetch(`${base}${view.data.nodes[20].downloadPath}`,{headers});assert.equal(image.status,200);assert.equal(image.headers.get('x-ltm-image-sha256'),finalAsset.sha256);assert.match(image.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),syntheticPng(20,1024,1024));
    await new Promise(resolve=>server.close(resolve));runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);base=await start();
    assert.equal((await (await fetch(`${base}/v1/timelines/root`,{headers})).json()).data.readyCount,21);
    runtime.withdrawConsent(f.actor,{consentId:f.consent.value.id,expectedVersion:f.consent.value.version,reason:'withdraw synthetic test consent',idempotencyKey:'withdraw'});
    const denied=await fetch(`${base}/v1/timelines/root/nodes/100/image`,{headers});
    assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'CONSENT_WITHDRAWN');
  }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));runtime.close();rmSync(directory,{recursive:true,force:true});}
});
