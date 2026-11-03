import assert from 'node:assert/strict';
import test from 'node:test';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {makePhotoScoreRequest,assessPhotoResponse} from '../dist/photo-score-contract.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
for(const couple of [false,true])test(`actual JPEG B07 canonical lineage and HTTP model boundary ${couple?'couple':'single'}`,()=>withPhotoFixture(async f=>{
 const intake=f.runtime.getRecord(f.service,'media.intake-results','source');assert.equal(intake.data.canonicalSha256,f.sourceAsset.sha256);
 assert.deepEqual(Buffer.from(await f.store.read(f.sourceAsset)),Buffer.from(f.sourceBytes));
 const asset=await f.asset('candidate',10),bytes=await f.store.read(asset);
 const r=makePhotoScoreRequest({tenantId:'tenant',commandId:'root',sourceAssetId:'source',targetAge:37,people:f.participantIds.map((participantId,index)=>({participantId,position:couple?index===0?'left':'right':'single'})),context:f.policy.context,referenceAsset:f.sourceAsset,referenceBytes:f.sourceBytes,outputAsset:asset,outputBytes:bytes},f.policy);
 const result=assessPhotoResponse(await new HttpPhotoScorer(f.scorerOptions).evaluate(r),r,f.policy);
 assert.equal(result.decision,'pass');assert.equal(result.participantAssessments.length,f.participantIds.length);assert.equal(f.seen.length,1);
},{couple}));
