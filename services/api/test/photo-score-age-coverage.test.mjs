import assert from 'node:assert/strict';
import test from 'node:test';
import { LifeTimeMachineRuntime } from '@ltm/core';
import { TimelinePhotoQualityService, photoQualityId } from '../dist/timeline-photo-quality.js';
import { HttpPhotoScorer } from '../dist/photo-score-client.js';
import { withPhotoFixture, response } from './photo-score-fixtures.mjs';

// Synthetic non-person pixels and external-model measurements exercise the real
// HTTP/SQL contract. They cannot measure a perception model's actual accuracy.
const ages=Array.from({length:21},(_,index)=>index*5);
for(const couple of [false,true]) test(`21-age scoring failures and restart recovery: ${couple?'couple':'single'}`,async t=>{
  await withPhotoFixture(async f=>{
    const create=runtime=>new TimelinePhotoQualityService(runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
    const service=create(f.runtime),passed=[];
    for(const age of ages) await t.test(`age ${age}`,async()=>{
      const changes={
        identity:raw=>raw.participants.at(-1).identity=.1,
        ageRange:raw=>raw.participants.at(-1).estimatedAgeYears=age<50?100:0,
        photorealism:raw=>raw.imageScores.photorealism=.1,
        uncertainAge:raw=>raw.participants.at(-1).ageConfidence=.1,
      };
      for(const [dimension,change] of Object.entries(changes)) {
        const asset=await f.asset(`age-${age}-${dimension}`,age+Object.keys(changes).indexOf(dimension)+1);
        const id=photoQualityId('tenant','root',age,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(id);
        f.setBehavior(request=>{const raw=response(request,f.policy);change(raw);return raw;});
        const evaluated=await service.evaluate(f.service,'root',age,asset);
        assert.equal(evaluated.decision,dimension==='uncertainAge'?'review':'retry');
        const report=f.runtime.getRecord(f.service,'media.quality-decisions',id);
        assert.equal(report.data.artifactBinding.targetAge,age);assert.equal(report.data.artifactBinding.outputSha256,asset.sha256);
        assert.equal(report.data.photoScoreEvidence.ages.length,couple?2:1);
        assert.ok(report.data.failedDimensions.includes(dimension==='uncertainAge'?'ageRange':dimension));
        if(couple&&dimension==='identity')assert.equal(report.data.participantAssessments[1].scores.identity,.1);
      }
      const asset=await f.asset(`recovery-${age}`,age+99),id=photoQualityId('tenant','root',age,asset.sha256,f.sourceAsset.sha256,f.policy);
      await f.grantQuality(id);const first=f.seen.length;
      for(const behavior of [()=>({httpStatus:503}),request=>({...response(request,f.policy),modelSha256:'b'.repeat(64)})]) {
        f.setBehavior(behavior);await assert.rejects(service.evaluate(f.service,'root',age,asset),{code:'DEPENDENCY_UNAVAILABLE'});
        assert.throws(()=>f.runtime.getRecord(f.service,'media.quality-decisions',id),/not found/i);
      }
      f.setBehavior(request=>response(request,f.policy));
      assert.equal((await service.evaluate(f.service,'root',age,asset)).decision,'pass');
      assert.equal(new Set(f.seen.slice(first).map(request=>request.requestSha256)).size,1);
      const evidence=f.runtime.getRecord(f.service,'media.quality-decisions',id).data.photoScoreEvidence;
      assert.equal(evidence.ages.at(-1).estimatedAgeYears,age);assert.equal(evidence.modelSha256,f.policy.modelSha256);
      passed.push({age,asset,id});
    });
    assert.deepEqual(passed.map(item=>item.age),ages);
    const reopened=new LifeTimeMachineRuntime(f.runtimeOptions),calls=f.seen.length;
    try {
      for(const {age,asset,id} of passed) {
        const result=await create(reopened).evaluate(f.service,'root',age,asset);
        assert.equal(result.reused,true);assert.equal(result.decision,'pass');assert.equal(result.qualityResultId,id);
      }
      assert.equal(f.seen.length,calls,'Restart reuses persisted reports without inference');
    } finally {reopened.close();}
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','cancelled'));
    for(const {age,asset} of passed)await assert.rejects(service.evaluate(f.service,'root',age,asset),/cancelled/);
    assert.equal(f.seen.length,calls,'Cancellation cannot reuse a cached pass or cause inference');
  },{couple,targetAges:ages});
});
