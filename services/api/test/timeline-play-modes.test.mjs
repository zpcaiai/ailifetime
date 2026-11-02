import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { TimelineDeliveryService } from '../dist/timeline-delivery.js';
import { timelineFixture, syntheticPng } from './timeline-fixtures.mjs';

for (const couple of [false,true]) for (const targetAges of [[0],[37],[100],Array.from({length:21},(_,i)=>i*5)]) {
  test(`real SQLite signed delivery and retry: ${couple?'couple':'single'} ${targetAges.length===1?targetAges[0]:'21 ages'}`, async () => {
    const f = await timelineFixture(':memory:',{couple,targetAges});
    try {
      const service = new TimelineDeliveryService(f.runtime);
      assert.deepEqual((await service.get(f.actor,'root')).nodes.map(n=>n.targetAge),targetAges);
      const original=f.runtime.getRecord(f.actor,'generation.timeline-commands','root');
      assert.equal(original.participantIds.length,couple?2:1);
      f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','failed'));
      const retry=await service.retry(f.actor,'root',targetAges[0],1);
      const retryRecord=f.runtime.getRecord(f.actor,'generation.timeline-commands',retry.commandId);
      assert.deepEqual(retryRecord.participantIds,original.participantIds);
      assert.deepEqual(retryRecord.data.generationPlan.participantReferences,original.data.generationPlan.participantReferences);
      assert.deepEqual(retryRecord.data.generationPlan.nodes[0].participantTargets,original.data.generationPlan.nodes[0].participantTargets);
      assert.equal((await service.retry(f.actor,'root',targetAges[0],1)).reused,true);
      const bytes=syntheticPng(7), asset={id:'synthetic-output',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,width:64,height:64,mimeType:'image/png'};
      const ready=await f.readyNode(asset,targetAges[0]);
      f.runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',{schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[ready]}));
      const view=await service.get(f.actor,'root');
      assert.equal(view.readyCount,1);assert.equal(view.expectedCount,targetAges.length);assert.equal(view.nodes[0].asset.sha256,asset.sha256);
      if(couple) {
        const consent=f.consents[1].value;
        f.runtime.withdrawConsent({...f.actor,actorId:'partner'},{consentId:consent.id,expectedVersion:consent.version,reason:'partner withdrawal',idempotencyKey:'partner-withdraw'});
        await assert.rejects(service.get(f.actor,'root'),/consent/i);
        await assert.rejects(service.retry(f.actor,'root',targetAges[0],1),/consent/i);
      }
    } finally {f.runtime.close();}
  });
}

test('couple source order remains bound and neither missing consent nor caller impersonation can start generation',async()=>{
  const f=await timelineFixture(':memory:',{couple:true,targetAges:[37]});
  try{
    const original=f.runtime.getRecord(f.actor,'generation.timeline-commands','root');
    await assert.rejects(f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wrong-map',input:{...original.data,jobId:'wrong-map',participantIds:['partner','user'],participantAges:[35,32]}}),/intake binding/i);
    assert.throws(()=>f.runtime.grantConsent(f.actor,{participantId:'partner',grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['ingest','transform']},policyVersion:'privacy-v1',evidenceHash:'d'.repeat(64),idempotencyKey:'impersonate-partner'}),/owner|self|authority|participant/i);
    const c=f.consents[1].value;f.runtime.withdrawConsent({...f.actor,actorId:'partner'},{consentId:c.id,expectedVersion:c.version,reason:'deny pair',idempotencyKey:'deny-pair'});
    await assert.rejects(f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'missing-pair-grant',input:{...original.data,jobId:'missing-pair-grant'}}),/consent/i);
  }finally{f.runtime.close();}
});
