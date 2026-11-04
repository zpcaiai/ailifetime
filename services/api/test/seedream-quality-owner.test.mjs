import assert from 'node:assert/strict';
import test from 'node:test';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';

test('B15 passes the approved owner to original and generated private readers',()=>withPhotoFixture(async f=>{
 const asset=await f.asset('owned-output',1),id=photoQualityId('tenant','root',37,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(id);
 const seen=[];
 const reader={read:async(a,owner)=>{assert.deepEqual(owner,{tenantId:'tenant',actorId:'user'});seen.push(a.id);return f.store.read(a);}};
 const service=new TimelinePhotoQualityService(f.runtime,f.registry,reader,new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
 assert.equal((await service.evaluate(f.service,'root',37,asset)).decision,'pass');assert.deepEqual(seen,['source','owned-output']);
 assert.equal(f.runtime.getRecord(f.service,'media.quality-decisions',id).data.artifactBinding.outputSha256,asset.sha256);
}));
