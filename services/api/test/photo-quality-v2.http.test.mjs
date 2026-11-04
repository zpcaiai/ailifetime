import test from 'node:test';
import assert from 'node:assert/strict';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {withPhotoFixture,response} from './photo-score-fixtures.mjs';
import {governancePolicy,persistQuality} from './photo-quality-v2-fixtures.mjs';
test('actual HTTP v2 scores original pixels, creates review once and stops subsequent inference',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy);f.setBehavior(r=>({...response(r,p),schemaVersion:'ltm.photo-score.response.v2',imageScores:{...response(r,p).imageScores,aestheticUsability:.1}}));
 const service=()=>new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[p],'wechat');
 for(const i of [1,2]){
  const asset=await f.asset('v2-'+i,i),id=photoQualityId(f.actor.tenantId,'root',37,asset.sha256,f.sourceAsset.sha256,p);await f.grantQuality(id);
  const result=await service().evaluate(f.service,'root',37,asset);assert.equal(result.decision,'review');assert.ok(result.reviewCaseId);assert.ok(result.qualityControlKey);
  assert.equal(result.trafficState,i===1?'active':'stopped');
  const replay=await service().evaluate(f.service,'root',37,asset);assert.equal(replay.reused,true);assert.equal(replay.reviewCaseId,result.reviewCaseId);
 }
 assert.equal(f.seen.length,2);const asset=await f.asset('after-stop',3),id=photoQualityId(f.actor.tenantId,'root',37,asset.sha256,f.sourceAsset.sha256,p);await f.grantQuality(id);
 await assert.rejects(service().evaluate(f.service,'root',37,asset),{code:'PROCESSING_RESTRICTED'});assert.equal(f.seen.length,2);
 assert.equal((await new PhotoQualityGovernance(f.runtime).control(f.service,p)).data.sampleCount,2);
}));
test('cache recovery registers a report persisted before a process loss without another model call',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),asset=await f.asset('candidate-cache',5),id=photoQualityId(f.actor.tenantId,'root',37,asset.sha256,f.sourceAsset.sha256,p);
 // Same real B15 validator and immutable bytes; only the post-persist governance step is absent.
 const saved=await persistQuality(f,p,id,'aestheticUsability',asset);
 const service=new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[p],'wechat');
 const result=await service.evaluate(f.service,'root',37,saved.asset);assert.equal(result.reused,true);assert.ok(result.reviewCaseId);assert.equal(f.seen.length,0);
}));
