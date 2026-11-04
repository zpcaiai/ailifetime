import assert from 'node:assert/strict';
import test from 'node:test';
import {LifeTimeMachineRuntime,QUALITY_CONTROLS} from '@ltm/core';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
import {assessPhotoResponse,makePhotoScoreRequest,photoControlKey,digest} from '../dist/photo-score-contract.js';
import {canonicalJson} from '@ltm/core';
import {withPhotoFixture,response} from './photo-score-fixtures.mjs';

import {governancePolicy,persistQuality,human} from './photo-quality-v2-fixtures.mjs';
test('SQL observations deduplicate, stop survives restart, and resume requires two humans',async()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime);
 const one=await persistQuality(f,p,'one');const first=await g.observe(f.service,'one',p,one.asset);assert.equal(first.review.data.state,'pending');
 await g.observe(f.service,'one',p,one.asset);assert.equal((await g.control(f.service,p)).data.sampleCount,1);
 await persistQuality(f,p,'two');await g.observe(f.service,'two',p);assert.equal((await g.control(f.service,p)).data.state,'stopped');
 const reopened=new LifeTimeMachineRuntime(f.runtimeOptions);try{await assert.rejects(new PhotoQualityGovernance(reopened).assertActive(f.service,p),{code:'PROCESSING_RESTRICTED'});}finally{reopened.close();}
 let c=await g.control(f.service,p);const input={action:'propose',expectedVersion:c.version,reason:'investigated calibration',ticket:'QA-100'};
 await assert.rejects(g.resume(f.service,c.id,input,'resume-service'),{code:'AUTH_FORBIDDEN'});
 c=await g.resume(human(f,'alice'),c.id,input,'resume-proposal');const confirm={...input,action:'confirm',expectedVersion:c.version};
 await assert.rejects(g.resume(human(f,'alice'),c.id,confirm,'resume-self'),{code:'AUTH_FORBIDDEN'});
 const done=await g.resume(human(f,'bob'),c.id,confirm,'resume-confirm');assert.equal(done.data.state,'active');assert.equal(done.data.epoch,1);
 assert.deepEqual(await g.resume(human(f,'bob'),c.id,confirm,'resume-confirm'),done);
 await g.observe(f.service,'one',p);assert.equal((await g.control(f.service,p)).data.sampleCount,0);
 await assert.rejects(g.resume(human(f,'bob'),c.id,{...confirm,reason:'different content'},'resume-confirm'),{code:'IDEMPOTENCY_CONFLICT'});
 await persistQuality(f,p,'new-one');await g.observe(f.service,'new-one',p);await persistQuality(f,p,'new-two');await g.observe(f.service,'new-two',p);
 assert.equal((await g.control(f.service,p)).data.state,'stopped');
 const oldReplay=await g.resume(human(f,'bob'),c.id,confirm,'resume-confirm');assert.equal(oldReplay.data.state,'stopped','Old confirmation must return current stopped state');
 assert.equal(f.runtime.verifyAuditChain(f.service).valid,true);
}));
test('concurrent observations retain all SQL samples and deny changed control calibration',async()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime);
 for(const id of ['first','second','third'])await persistQuality(f,p,id);
 await Promise.all(['first','second','third'].map(id=>g.observe(f.service,id,p)));
 const c=await g.control(f.service,p);assert.equal(c.data.state,'stopped');assert.equal(c.data.sampleCount,3);assert.equal(c.data.failureCount,3);
 await assert.rejects(g.observe(f.actor,'first',p),{code:'AUTH_FORBIDDEN'});
 await assert.rejects(g.control(f.service,{...p,regression:{...p.regression,maximumFailureRate:.9}}),{code:'DEPENDENCY_UNAVAILABLE'});
 assert.equal(f.runtime.listRecords(f.service,{collection:QUALITY_CONTROLS}).length,1);
}));
test('rescoring identical generated pixels under another calibration is not a new regression sample',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime),a=await persistQuality(f,p,'original-sample');await g.observe(f.service,'original-sample',p,a.asset);
 const changed={...p,id:'recalibrated-age-stratum',thresholds:{...p.thresholds,aestheticUsability:.85}};
 await persistQuality(f,changed,'same-pixels-rescored','aestheticUsability',a.asset);const next=await g.observe(f.service,'same-pixels-rescored',changed,a.asset);
 assert.equal(next.control.data.sampleCount,1);assert.equal(next.control.data.state,'active');assert.ok(next.review);
}));
