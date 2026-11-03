import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, LifeTimeMachineRuntime } from '@ltm/core';
import { TimelinePhotoQualityService, photoQualityId } from '../dist/timeline-photo-quality.js';
import { HttpPhotoScorer } from '../dist/photo-score-client.js';
import { makePhotoScoreRequest, assessPhotoResponse, digest } from '../dist/photo-score-contract.js';
import { withPhotoFixture, response } from './photo-score-fixtures.mjs';

test('algorithm revision preserves legacy SQL pass but never reuses it, and reopens current rejected report',()=>withPhotoFixture(async f=>{
  const asset=await f.asset('legacy-candidate',7),age=37;
  const legacy='photo-quality-'+digest(canonicalJson(['tenant','root',age,asset.sha256,f.sourceAsset.sha256,f.policy]));
  const id=photoQualityId('tenant','root',age,asset.sha256,f.sourceAsset.sha256,f.policy);
  await f.grantQuality(legacy);await f.grantQuality(id);
  const request=makePhotoScoreRequest({tenantId:'tenant',commandId:'root',sourceAssetId:'source',targetAge:age,context:f.policy.context,
    people:[{participantId:'user',position:'single'}],referenceAsset:f.sourceAsset,referenceBytes:f.sourceBytes,outputAsset:asset,outputBytes:await f.store.read(asset)},f.policy);
  const raw=response(request,f.policy),result=assessPhotoResponse(raw,request,f.policy);
  await f.registry.execute(f.runtime,'B15',{actor:f.service,idempotencyKey:'legacy-assessment',input:{workId:legacy,participantIds:f.participantIds,modelVersion:result.modelVersion,
    artifactBinding:{sourceAssetId:'source',assetId:asset.id,outputSha256:asset.sha256,targetAge:age},scores:result.scores,thresholds:result.thresholds,
    participantAssessments:result.participantAssessments,decision:result.decision,
    photoScoreEvidence:{schemaVersion:'ltm.photo-score.evidence.v1',requestSha256:request.requestSha256,responseSha256:digest(JSON.stringify(raw)),sourceSha256:f.sourceAsset.sha256,
      modelSha256:f.policy.modelSha256,calibrationId:f.policy.id,calibrationSha256:digest(canonicalJson(f.policy)),calibration:JSON.parse(canonicalJson(f.policy)),ages:result.ages}}});
  f.setBehavior(request=>{const changed=response(request,f.policy);changed.imageScores.photorealism=.1;return changed;});
  const create=runtime=>new TimelinePhotoQualityService(runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
  const evaluated=await create(f.runtime).evaluate(f.service,'root',age,asset);
  assert.equal(evaluated.decision,'retry');assert.equal(evaluated.reused,false);
  assert.notEqual(id,legacy);assert.equal(f.seen.length,1);
  assert.equal(f.runtime.getRecord(f.service,'media.quality-decisions',legacy).data.decision,'pass','Historical report remains unchanged');
  const reopened=new LifeTimeMachineRuntime(f.runtimeOptions);
  try {
    const cached=await create(reopened).evaluate(f.service,'root',age,asset);
    assert.equal(cached.decision,'retry');assert.equal(cached.reused,true);assert.equal(f.seen.length,1);
  } finally {reopened.close();}
}));
