import assert from 'node:assert/strict';
import test from 'node:test';
import {validatePhotoPolicy,assessPhotoResponse,photoControlKey} from '../dist/photo-score-contract.js';
import {policy,request,response} from './photo-score-fixtures.mjs';
export function v2policy(){const p=policy();return {...p,protocolVersion:2,regression:{windowSize:4,minimumSamples:2,maximumFailureRate:.5},thresholds:{...p.thresholds,aestheticUsability:.8}};}
export function v2response(r,p){return {...response(r,p),schemaVersion:'ltm.photo-score.response.v2',imageScores:{...response(r,p).imageScores,aestheticUsability:.95}};}
test('v2 is explicit, closed and calibrated while v1 remains byte-compatible',()=>{
 const p=validatePhotoPolicy(v2policy()),r=request(p);assert.equal(r.schemaVersion,'ltm.photo-score.request.v2');
 assert.equal(assessPhotoResponse(v2response(r,p),r,p).decision,'pass');
 assert.equal(request(policy()).schemaVersion,'ltm.photo-score.request.v1');
 assert.equal(assessPhotoResponse(response(request()),request(),policy()).decision,'pass');
 const changed=structuredClone(p);changed.thresholds.aestheticUsability=.9;changed.minimumTargetAge=50;assert.equal(photoControlKey(p),photoControlKey(changed),'Age calibration changes cannot escape a stopped model/template');changed.modelSha256='b'.repeat(64);assert.notEqual(photoControlKey(p),photoControlKey(changed));
 for(const mutate of [p=>delete p.thresholds.aestheticUsability,p=>p.thresholds.aestheticUsability=0,p=>p.regression.minimumSamples=0,p=>p.regression.windowSize=101,p=>p.regression.maximumFailureRate=NaN,p=>p.protocolVersion=3,p=>delete p.protocolVersion]){const bad=v2policy();mutate(bad);assert.throws(()=>validatePhotoPolicy(bad));}
});
test('aesthetic deficit requires review; critical failure cannot hide behind it or be averaged away',()=>{
 const p=v2policy(),r=request(p),raw=v2response(r,p);raw.imageScores.aestheticUsability=.1;
 assert.equal(assessPhotoResponse(raw,r,p).decision,'review');assert.deepEqual(assessPhotoResponse(raw,r,p).failedDimensions,['aestheticUsability']);
 raw.participants[0].identity=.1;assert.equal(assessPhotoResponse(raw,r,p).decision,'retry');
 for(const mutate of [v=>v.schemaVersion='ltm.photo-score.response.v1',v=>delete v.imageScores.aestheticUsability,v=>v.imageScores.aestheticUsability=NaN,v=>v.imageScores.aestheticUsability=2]){const bad=v2response(r,p);mutate(bad);assert.throws(()=>assessPhotoResponse(bad,r,p));}
});
