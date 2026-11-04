import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
import {PhotoQualityReview} from '../dist/photo-quality-review.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {governancePolicy,persistQuality,human} from './photo-quality-v2-fixtures.mjs';
for(const backend of ['sqlite','postgresql'])test(`signed v2 publication rejects missing/forged control and unreviewed aesthetics on ${backend}`,async()=>{
 if(backend==='postgresql')assert.ok(process.env.LTM_TEST_POSTGRES_URL,'native PostgreSQL required');
 await withPhotoFixture(async f=>{
  const p=governancePolicy(f.policy),a=await persistQuality(f,p,'release'),g=new PhotoQualityGovernance(f.runtime),ops=new PhotoQualityReview(f.runtime,f.store);
  const state=await g.observe(f.service,'release',p,a.asset),base=await f.readyNode(a.asset,37),node={...base,qualityResultId:'release',qualityControlKey:state.control.id};
  const manifest=n=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[n]});
  async function apply(n){return f.runtime.applyExternalBusinessEvent(f.service,await f.callbackAsync('root','succeeded',manifest(n)));}
  await assert.rejects(apply(node),/quality and safety/);
  const one=await ops.decide(human(f,'alice'),state.review.id,{action:'propose',decision:'approve',expectedVersion:state.review.version,reason:'framing accepted after review',ticket:'QA-300'},'proposal');
  await ops.decide(human(f,'bob'),state.review.id,{action:'confirm',decision:'approve',expectedVersion:one.version,reason:'second reviewer accepts framing',ticket:'QA-300'},'confirm');
  const missing={...node};delete missing.qualityControlKey;await assert.rejects(apply(missing),/active model control/);
  await assert.rejects(apply({...node,qualityControlKey:'quality-control-'+'b'.repeat(64)}));
  const control=await g.control(f.service,p);
  await f.runtime.updateRecord(f.service,{collection:control.collection,id:control.id,expectedVersion:control.version,data:{...control.data,state:'stopped'},idempotencyKey:'latch-before-publish'});
  await assert.rejects(apply(node),/active model control/);
  let c=await g.control(f.service,p);c=await g.resume(human(f,'alice'),c.id,{action:'propose',expectedVersion:c.version,reason:'regression root cause fixed',ticket:'QA-301'},'resume-propose');
  await g.resume(human(f,'bob'),c.id,{action:'confirm',expectedVersion:c.version,reason:'independent restart confirmation',ticket:'QA-301'},'resume-confirm');
  await apply(node);assert.equal((await f.runtime.getRecord(f.service,'generation.timeline-commands','root')).data.deliveryState,'ready');
 },backend==='postgresql'?{postgresConnectionString:process.env.LTM_TEST_POSTGRES_URL,tenantId:'publication-'+randomUUID()}:{});
});
test('all 21 v2 ages with human aesthetic reviews publish under the unchanged 64-row SQL lock bound',async()=>{
 assert.ok(process.env.LTM_TEST_POSTGRES_URL);
 const ages=Array.from({length:21},(_,i)=>i*5);
 await withPhotoFixture(async f=>{
  const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime),ops=new PhotoQualityReview(f.runtime,f.store),nodes=[];
  for(const age of ages){
   const asset=await f.asset('age-'+age,age+1),id='full-'+age;await persistQuality(f,p,id,'aestheticUsability',asset,age);
   const state=await g.observe(f.service,id,p,asset),base=await f.readyNode(asset,age);
   let r=await ops.decide(human(f,'alice'),state.review.id,{action:'propose',decision:'approve',expectedVersion:state.review.version,reason:'composition checked against source',ticket:'QA-full-'+age},'propose-'+age);
   await ops.decide(human(f,'bob'),r.id,{action:'confirm',decision:'approve',expectedVersion:r.version,reason:'independently reviewed composition',ticket:'QA-full-'+age},'confirm-'+age);
   nodes.push({...base,qualityResultId:id,qualityControlKey:state.control.id});
  }
  let c=await g.control(f.service,p);assert.equal(c.data.state,'stopped');
  c=await g.resume(human(f,'alice'),c.id,{action:'propose',expectedVersion:c.version,reason:'full window investigated',ticket:'QA-full-resume'},'full-resume-1');
  await g.resume(human(f,'bob'),c.id,{action:'confirm',expectedVersion:c.version,reason:'resumption independently confirmed',ticket:'QA-full-resume'},'full-resume-2');
  const manifest={schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes},input=await f.callbackAsync('root','succeeded',manifest);
  assert.equal(input.reducer.locate(input.event).relatedRecords.length,64);
  await f.runtime.applyExternalBusinessEvent(f.service,input);const row=await f.runtime.getRecord(f.service,'generation.timeline-commands','root');assert.equal(row.data.deliveryState,'ready');assert.equal(row.data.resultManifest.nodes.length,21);
 },{postgresConnectionString:process.env.LTM_TEST_POSTGRES_URL,tenantId:'twenty-one-'+randomUUID(),targetAges:ages});
});
