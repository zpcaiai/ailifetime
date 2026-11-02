import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineDeliveryService } from '../dist/timeline-delivery.js';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';

for(const couple of [false,true])test(`wardrobe recovery preserves source binding and each ${couple?'couple':'single'} consent on real SQL`,async()=>{
  const f=await wardrobeFixture({couple,age:40,sourceAges:Array.from({length:21},(_,i)=>i*5)});
  try{
    await f.grantWardrobe();await f.createWardrobe();const delivery=new TimelineDeliveryService(f.runtime);
    assert.equal((await delivery.get(f.actor,'wardrobe-job')).expectedCount,1);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('wardrobe-job','failed'));
    const first=await delivery.retry(f.actor,'wardrobe-job',40,1);assert.equal((await delivery.retry(f.actor,'wardrobe-job',40,1)).commandId,first.commandId);
    const retry=f.runtime.getRecord(f.actor,'generation.timeline-commands',first.commandId);
    assert.deepEqual(retry.data.wardrobeEdit,f.edit);assert.deepEqual(retry.data.participantIds,f.participantIds);
    const asset={id:'recovered-outfit',sha256:'c'.repeat(64),mimeType:'image/png',width:64,height:64,byteLength:140};
    const ready=await f.readyWardrobe(asset,first.commandId);f.runtime.applyExternalBusinessEvent(f.service,f.callback(first.commandId,'succeeded',f.manifest([ready])));
    const view=await delivery.get(f.actor,'wardrobe-job');assert.equal(view.readyCount,1);assert.equal(view.nodes[0].asset.sha256,asset.sha256);assert.equal(view.nodes[0].attempts,1);assert.equal((await delivery.get(f.actor,'root')).expectedCount,21);
    const participantId=f.participantIds.at(-1),actor={...f.actor,actorId:participantId};
    const grant=f.runtime.listConsents(actor).find(c=>c.scope.actions.includes('wardrobe'));
    f.runtime.withdrawConsent(actor,{consentId:grant.id,expectedVersion:grant.version,reason:'wardrobe withdrawn',idempotencyKey:'withdraw-wardrobe'});
    await assert.rejects(delivery.get(f.actor,'wardrobe-job'),/consent/i);await assert.rejects(delivery.retry(f.actor,'wardrobe-job',40,1),/consent/i);
    assert.equal((await delivery.get(f.actor,'root')).readyCount,1);
  }finally{f.runtime.close();}
});
