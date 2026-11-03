import assert from 'node:assert/strict';
import test from 'node:test';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalJson,LifeTimeMachineRuntime} from '@ltm/core';
import {digest} from '../dist/photo-score-contract.js';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {withPhotoFixture,response} from './photo-score-fixtures.mjs';

const service=f=>new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
async function consent(f,asset,command='root',age=37){const id=photoQualityId('tenant',command,age,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(id);return id;}
test('SQL-reopened calibration hashes reproduce and reordered equivalent policies reuse the same report without inference',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('canonical-candidate',7),id=await consent(f,asset);
 await service(f).evaluate(f.service,'root',37,asset);
 const reordered=JSON.parse(canonicalJson(f.policy));
 assert.equal(photoQualityId('tenant','root',37,asset.sha256,f.sourceAsset.sha256,reordered),id);
 const runtime=new LifeTimeMachineRuntime(f.runtimeOptions);
 try {
  const evidence=runtime.getRecord(f.service,'media.quality-decisions',id).data.photoScoreEvidence;
  assert.equal(evidence.calibrationSha256,digest(canonicalJson(evidence.calibration)));
  assert.deepEqual(evidence.calibration,reordered);
  const scorer=new TimelinePhotoQualityService(runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[reordered],'wechat');
  assert.equal((await scorer.evaluate(f.service,'root',37,asset)).reused,true);
  assert.equal(f.seen.length,1);
 } finally {runtime.close();}
}));
for(const couple of [false,true])test(`actual JPEG/PNG→HTTP scorer→SQL B15 provenance and cache ${couple?'couple':'single'}`,()=>withPhotoFixture(async f=>{
 const asset=await f.asset('candidate',1),id=await consent(f,asset),s=service(f);
 const result=await s.evaluate(f.service,'root',37,asset);assert.equal(result.decision,'pass');assert.equal(result.qualityResultId,id);
 const record=f.runtime.getRecord(f.service,'media.quality-decisions',id);assert.equal(record.data.photoScoreEvidence.sourceSha256,f.sourceAsset.sha256);
 assert.equal(record.data.photoScoreEvidence.requestSha256,f.seen[0].requestSha256);assert.equal(record.data.photoScoreEvidence.ages.length,f.participantIds.length);
 assert.equal(record.data.scores.ageRange,1);assert.equal(record.data.scores.photorealism,.95);
 assert.equal((await service(f).evaluate(f.service,'root',37,asset)).reused,true);assert.equal(f.seen.length,1);
},{couple}));

test('each person identity/age and photographic realism fail independently; uncertain age goes to review',()=>withPhotoFixture(async f=>{
 const changes=[r=>r.participants[1].identity=.1,r=>r.participants[1].estimatedAgeYears=80,r=>r.imageScores.photorealism=.1,r=>r.participants[1].ageConfidence=.1];
 for(let i=0;i<changes.length;i++){
  const asset=await f.asset('candidate-'+i,i+1);const id=await consent(f,asset);
  f.setBehavior(r=>{const value=response(r,f.policy);changes[i](value);return value;});
  const result=await service(f).evaluate(f.service,'root',37,asset);assert.equal(result.decision,i===3?'review':'retry');
  const q=f.runtime.getRecord(f.service,'media.quality-decisions',id);assert.ok(q.data.failedDimensions.length>0);
  assert.equal(f.runtime.getRecord(f.service,'generation.timeline-commands','root').data.resultManifest,undefined);
 }
},{couple:true}));

test('malformed/temporarily unavailable scorer leaves no pass record and recovers with identical inference key',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('candidate',9),id=await consent(f,asset),s=service(f);
 for(const behavior of [()=>({httpStatus:503}),r=>({...response(r,f.policy),modelSha256:'b'.repeat(64)})]){
  f.setBehavior(behavior);await assert.rejects(s.evaluate(f.service,'root',37,asset),{code:'DEPENDENCY_UNAVAILABLE'});
  assert.throws(()=>f.runtime.getRecord(f.service,'media.quality-decisions',id),/not found/i);
 }
 f.setBehavior(r=>response(r,f.policy));assert.equal((await s.evaluate(f.service,'root',37,asset)).decision,'pass');
 assert.equal(new Set(f.seen.map(r=>r.requestSha256)).size,1);
}));

test('consumer, unknown calibration and wrong age cannot cause image egress',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('candidate',1);await consent(f,asset);const s=service(f);
 await assert.rejects(s.evaluate(f.actor,'root',37,asset),/service account/);
 await assert.rejects(s.evaluate(f.service,'root',100,asset),/stored B14 plan/);
 const other={...f.policy,context:{...f.policy.context,templateId:'other-template'}};
 await assert.rejects(new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[other],'wechat').evaluate(f.service,'root',37,asset),/unique calibration/);
 assert.equal(f.seen.length,0);
}));

test('damaged immutable bytes and cancelled jobs cannot produce a quality report',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('candidate',2);const id=await consent(f,asset);
 appendFileSync(join(f.directory,'images',asset.sha256+'.png'),Buffer.from([0]));
 await assert.rejects(service(f).evaluate(f.service,'root',37,asset),/length/);assert.equal(f.seen.length,0);
 assert.throws(()=>f.runtime.getRecord(f.service,'media.quality-decisions',id),/not found/i);
 f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','cancelled'));
 await assert.rejects(service(f).evaluate(f.service,'root',37,asset),/cancelled/);assert.equal(f.seen.length,0);
}));

test('withdrawing source quality consent during real HTTP inference blocks persistence',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('candidate',3),id=await consent(f,asset);
 f.setBehavior(r=>{
  const grant=f.runtime.listConsents(f.service).find(g=>g.participantId==='user'&&g.purpose==='quality_assurance'&&g.scope.resource==='media.asset:source');assert.ok(grant);
  f.runtime.withdrawConsent({...f.actor,purpose:'quality_assurance'},{consentId:grant.id,expectedVersion:grant.version,reason:'withdraw during evaluation',idempotencyKey:'withdraw-source-quality'});
  return response(r,f.policy);
 });
 await assert.rejects(service(f).evaluate(f.service,'root',37,asset),/consent/i);
 assert.throws(()=>f.runtime.getRecord(f.service,'media.quality-decisions',id),/not found/i);assert.equal(f.seen.length,1);
}));
