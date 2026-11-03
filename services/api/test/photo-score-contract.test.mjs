import assert from 'node:assert/strict';
import test from 'node:test';
import {validatePhotoPolicy,makePhotoScoreRequest,assessPhotoResponse,digest} from '../dist/photo-score-contract.js';
import {policy,request,response} from './photo-score-fixtures.mjs';
test('explicit calibrated policy and actual byte bindings are mandatory',()=>{
 const p=validatePhotoPolicy(policy()),r=request(p);assert.equal(Buffer.from(r.reference.base64,'base64').length,r.reference.asset.byteLength);
 assert.equal(digest(Buffer.from(r.output.base64,'base64')),r.output.asset.sha256);
 for(const change of [p=>p.thresholds.identity=0,p=>p.modelSha256='bad',p=>p.minimumAgeConfidence=NaN,p=>p.thresholds.extra=1,p=>p.maximumTargetAge=-1]){const bad=policy();change(bad);assert.throws(()=>validatePhotoPolicy(bad));}
 assert.throws(()=>makePhotoScoreRequest({...r,referenceAsset:r.reference.asset,referenceBytes:Buffer.from('wrong'),outputAsset:r.output.asset,outputBytes:Buffer.from(r.output.base64,'base64')},p),/bytes/);
});
test('per-person identity and calibrated age error cannot be averaged away; uncertain ages require review',()=>{
 const p=policy();p.context.subjectMode='couple';const r=request(p,[{participantId:'a',position:'left'},{participantId:'b',position:'right'}]);
 let raw=response(r,p);raw.participants[1].identity=.1;assert.equal(assessPhotoResponse(raw,r,p).scores.identity,.1);assert.equal(assessPhotoResponse(raw,r,p).decision,'retry');
 raw=response(r,p);raw.participants[1].estimatedAgeYears=60;assert.equal(assessPhotoResponse(raw,r,p).scores.ageRange,0);
 raw=response(r,p);raw.participants[1].ageConfidence=.1;assert.equal(assessPhotoResponse(raw,r,p).decision,'review');
 assert.equal(assessPhotoResponse(response(r,p),r,p).decision,'pass');
});
test('unknown/missing/NaN scores, model/age/person/request substitution fail closed',()=>{
 const p=policy(),r=request(p);
 for(const change of [v=>v.modelVersion='other',v=>v.modelSha256='b'.repeat(64),v=>v.requestSha256='c'.repeat(64),v=>v.calibrationId='other',v=>v.participants[0].participantId='stranger',v=>v.participants[0].position='right',v=>v.participants[0].estimatedAgeYears=Infinity,v=>v.imageScores.photorealism=NaN,v=>delete v.imageScores.clarity,v=>v.imageScores.extra=1]){const raw=response(r,p);change(raw);assert.throws(()=>assessPhotoResponse(raw,r,p));}
 const low=response(r,p);low.imageScores.photorealism=.1;assert.deepEqual(assessPhotoResponse(low,r,p).failedDimensions,['photorealism']);
});
