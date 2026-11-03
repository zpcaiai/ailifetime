import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createApiServer,StaticTokenAuthenticator} from '../dist/index.js';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {withPhotoFixture,response} from './photo-score-fixtures.mjs';

const manifest=nodes=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes});
for(const couple of [false,true])test(`real HTTP21 pixel scoring, low-quality publication refusal and original-anchored recovery ${couple?'couple':'single'}`,()=>withPhotoFixture(async f=>{
 const quality=new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
 const auth=new StaticTokenAuthenticator([{token:'synthetic-photo-operator-token-001',actorId:'service',tenantId:'tenant',roles:['platform_admin','service_account'],permissions:['*'],allowedPurposes:['age_transformation']},{token:'synthetic-photo-consumer-token-001',actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}]);
 const server=createApiServer({runtime:f.runtime,authenticator:auth,capabilityRegistry:f.registry,photoQuality:quality,timelineArtifacts:f.store,appEnvironment:'test',staticDirectory:null});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const operator={authorization:'Bearer synthetic-photo-operator-token-001','x-purpose':'age_transformation','content-type':'application/json','idempotency-key':'score-http'},consumer={...operator,authorization:'Bearer synthetic-photo-consumer-token-001'};
 async function score(command,age,asset,headers=operator){return fetch(base+'/v1/timelines/'+command+'/quality',{method:'POST',headers,body:JSON.stringify({targetAge:age,asset})});}
 async function safety(asset,age,qualityResultId) {
  const id='safety-'+age+'-'+asset.sha256.slice(0,8);
  for(const participantId of f.participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.safety-certificates:'+id,actions:['process']},policyVersion:'age-transformation-consent-v1',idempotencyKey:'safety-'+id+'-'+participantId});
  await f.registry.execute(f.runtime,'B17',{actor:f.service,idempotencyKey:id,input:{...f.fixtures.B17,workId:id,participantIds:f.participantIds,artifactBinding:{sourceAssetId:'source',assetId:asset.id,outputSha256:asset.sha256,targetAge:age}}});
  return {nodeId:'age-'+age,targetAge:age,status:'ready',asset,qualityResultId,safetyResultId:id};
 }
 try{
  const firstAsset=await f.asset('first',1);
  assert.equal((await score('root',0,firstAsset,{'content-type':'application/json'})).status,401);
  assert.equal((await score('root',0,firstAsset,consumer)).status,403);assert.equal(f.seen.length,0);
  const extra=await fetch(base+'/v1/timelines/root/quality',{method:'POST',headers:operator,body:JSON.stringify({targetAge:0,asset:firstAsset,scores:{identity:1}})});assert.equal(extra.status,422);
  const forged=await fetch(base+'/v1/capabilities/B15',{method:'POST',headers:operator,body:JSON.stringify({...f.fixtures.B15,artifactBinding:{sourceAssetId:'source',assetId:firstAsset.id,outputSha256:firstAsset.sha256,targetAge:0}})});assert.equal(forged.status,403);
  const nodes=[];let bad;
  for(let age=0;age<=100;age+=5){
   const asset=await f.asset('candidate-'+age,age+2),id=photoQualityId('tenant','root',age,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(id);
   f.setBehavior(r=>{const value=response(r,f.policy);if(age===100)value.imageScores.photorealism=.1;return value;});
   const result=await score('root',age,asset);assert.equal(result.status,200);const report=(await result.json()).data;assert.equal(report.qualityResultId,id);
   const node=await safety(asset,age,id);if(age===100){assert.equal(report.decision,'retry');bad=node;}else{assert.equal(report.decision,'pass');nodes.push(node);}
  }
  assert.throws(()=>f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest([...nodes,bad]))),/quality/);
  f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest([...nodes,{nodeId:'age-100',targetAge:100,status:'failed',errorCode:'QUALITY_REJECTED'}])));
  let view=(await(await fetch(base+'/v1/timelines/root',{headers:consumer})).json()).data;assert.equal(view.readyCount,20);assert.equal(view.nodes[20].downloadPath,null);const siblings=view.nodes.slice(0,20);
  const retryResponse=await fetch(base+'/v1/timelines/root/retry',{method:'POST',headers:{...consumer,'idempotency-key':'score-retry'},body:JSON.stringify({targetAge:100,attempt:1})});assert.equal(retryResponse.status,200);const retry=(await retryResponse.json()).data;
  const asset=await f.asset('recovered',103),id=photoQualityId('tenant',retry.commandId,100,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(id);f.setBehavior(r=>response(r,f.policy));
  const evaluated=await score(retry.commandId,100,asset);assert.equal(evaluated.status,200);assert.equal((await evaluated.json()).data.decision,'pass');
  f.runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',manifest([await safety(asset,100,id)])));
  assert.equal((await(await score(retry.commandId,100,asset)).json()).data.reused,true);assert.equal(f.seen.length,22);
  view=(await(await fetch(base+'/v1/timelines/root',{headers:consumer})).json()).data;assert.equal(view.readyCount,21);assert.deepEqual(view.nodes.slice(0,20),siblings);
  const download=await fetch(base+view.nodes[20].downloadPath,{headers:consumer});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(await f.store.read(asset)));
  assert.ok(f.seen.every(r=>r.reference.asset.sha256===f.sourceAsset.sha256));
 }finally{await new Promise(resolve=>server.close(resolve));}
},{couple,targetAges:Array.from({length:21},(_,i)=>i*5)}));
