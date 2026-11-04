import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityMeasurementFingerprint} from '@ltm/core';
import {PhotoQualityGovernance,qualityHumanMutation} from '../dist/photo-quality-governance.js';
import {PhotoQualityReview} from '../dist/photo-quality-review.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {governancePolicy,persistQuality,human} from './photo-quality-v2-fixtures.mjs';

test('two human review preserves original scores, private previews and idempotent crash recovery',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),a=await persistQuality(f,p,'aesthetic'),g=new PhotoQualityGovernance(f.runtime),ops=new PhotoQualityReview(f.runtime,f.store);
 const {review}=await g.observe(f.service,'aesthetic',p,a.asset),alice=human(f,'alice'),bob=human(f,'bob');
 const before=f.runtime.getRecord(f.service,'media.quality-decisions','aesthetic'),fingerprint=qualityMeasurementFingerprint(before);
 await assert.rejects(ops.list(f.actor),{code:'AUTH_FORBIDDEN'});await assert.rejects(ops.preview(f.service,review.id,'output'),{code:'AUTH_FORBIDDEN'});
 await assert.rejects(ops.list({...alice,stepUp:false}),{code:'AUTH_FORBIDDEN'});
 assert.deepEqual(Buffer.from((await ops.preview(alice,review.id,'output')).bytes),Buffer.from(await f.store.read(a.asset)));
 assert.deepEqual(Buffer.from((await ops.preview(alice,review.id,'reference')).bytes),Buffer.from(f.sourceBytes));
 await assert.rejects(new PhotoQualityReview(f.runtime,{read:async()=>Buffer.from('corrupted stored pixels')}).preview(alice,review.id,'output'),{code:'DEPENDENCY_UNAVAILABLE'});
 assert.equal((await ops.list(alice)).length,1);assert.equal('outputAsset' in (await ops.list(alice))[0],false);
 const proposal={action:'propose',decision:'approve',expectedVersion:review.version,reason:'composition acceptable after review',ticket:'QA-200'};
 const proposed=await ops.decide(alice,review.id,proposal,'propose');const confirm={...proposal,action:'confirm',expectedVersion:proposed.version};
 await assert.rejects(ops.decide(alice,review.id,confirm,'self'),{code:'AUTH_FORBIDDEN'});
 const done=await ops.decide(bob,review.id,confirm,'confirm');assert.equal(done.state,'approved');
 assert.deepEqual(await new PhotoQualityReview(f.runtime,f.store).decide(bob,review.id,confirm,'confirm'),done);
 const after=f.runtime.getRecord(f.service,'media.quality-decisions','aesthetic');assert.equal(after.data.decision,'pass');assert.equal(qualityMeasurementFingerprint(after),fingerprint);assert.equal(after.data.scores.aestheticUsability,.1);
 // Durable review can be committed before the report update (process loss). Replay finishes it.
 const b=await persistQuality(f,p,'interrupted');const c=(await g.observe(f.service,'interrupted',p,b.asset)).review;
 const pre=await ops.decide(alice,c.id,{...proposal,expectedVersion:c.version},'pre');
 const input={...proposal,action:'confirm',expectedVersion:pre.version};
 await qualityHumanMutation(f.runtime,bob,'media.quality-reviews',c.id,input,'after-crash',row=>({...row.data,state:'approved',approval:{proposer:'alice',confirmer:'bob',decision:'approve',reason:input.reason,ticket:input.ticket}}));
 assert.equal(f.runtime.getRecord(f.service,'media.quality-decisions','interrupted').data.decision,'review');
 assert.equal((await new PhotoQualityReview(f.runtime,f.store).decide(bob,c.id,input,'after-crash')).state,'approved');
 assert.equal(f.runtime.getRecord(f.service,'media.quality-decisions','interrupted').data.decision,'pass');
}));
test('critical deficits, consent withdrawal and cancelled command cannot be approved or previewed',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),a=await persistQuality(f,p,'identity','identity'),g=new PhotoQualityGovernance(f.runtime),ops=new PhotoQualityReview(f.runtime,f.store),h=human(f,'alice');
 const {review}=await g.observe(f.service,'identity',p,a.asset),action={action:'propose',decision:'approve',expectedVersion:review.version,reason:'please approve this',ticket:'QA-201'};
 await assert.rejects(ops.decide(h,review.id,action,'critical'),{code:'VALIDATION_FAILED'});
 const source=f.runtime.listConsents({...f.actor,purpose:'quality_assurance'},'user').find(c=>c.purpose==='quality_assurance'&&c.scope.resource==='media.asset:source');
 f.runtime.withdrawConsent({...f.actor,purpose:'quality_assurance'},{consentId:source.id,expectedVersion:source.version,reason:'withdraw quality use',idempotencyKey:'withdraw-quality'});
 await assert.rejects(ops.preview(h,review.id,'output'),e=>['CONSENT_REQUIRED','CONSENT_WITHDRAWN','PROCESSING_RESTRICTED'].includes(e.code));
 assert.deepEqual(await ops.list(h),[]);
}));
test('cancelled timeline cannot be previewed or decided even with current report consent',()=>withPhotoFixture(async f=>{
 const p=governancePolicy(f.policy),a=await persistQuality(f,p,'cancelled'),ops=new PhotoQualityReview(f.runtime,f.store);
 const {review}=await new PhotoQualityGovernance(f.runtime).observe(f.service,'cancelled',p,a.asset);
 await f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','cancelled'));
 await assert.rejects(ops.preview(human(f,'alice'),review.id,'output'),{code:'VERSION_CONFLICT'});
 await assert.rejects(ops.decide(human(f,'alice'),review.id,{action:'propose',decision:'approve',expectedVersion:review.version,reason:'review candidate',ticket:'QA-202'},'cancel-review'),{code:'VERSION_CONFLICT'});
}));
