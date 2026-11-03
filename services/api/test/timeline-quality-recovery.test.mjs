import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineDeliveryService } from '../dist/timeline-delivery.js';
import { timelineFixture } from './timeline-fixtures.mjs';

const manifest = (errorCode) => ({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[{nodeId:'age-37',targetAge:37,status:'failed',errorCode}]});

for (const cancellation of ['command', 'CANCELLED', 'POLICY_BLOCKED']) test(`actual SQL ${cancellation} stays terminal without a new generation intent`, async () => {
  const f = await timelineFixture(':memory:',{targetAges:[37]});
  try {
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root',cancellation === 'command' ? 'cancelled' : 'succeeded',cancellation === 'command' ? undefined : manifest(cancellation)));
    const service = new TimelineDeliveryService(f.runtime), view = await service.get(f.actor,'root');
    assert.equal(view.nodes[0].errorCode,cancellation === 'command' ? 'CANCELLED' : cancellation);
    assert.equal(view.nodes[0].canRetry,false);
    await assert.rejects(service.retry(f.actor,'root',37,1),/disallowed/);
    assert.equal(f.runtime.listRecords(f.service,{collection:'generation.timeline-commands'}).length,1);
  } finally { f.runtime.close(); }
});

test('a quality-rejected age preserves original references through all three bounded attempts', async () => {
  const f = await timelineFixture(':memory:',{targetAges:[37],couple:true});
  try {
    const service = new TimelineDeliveryService(f.runtime);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest('QUALITY_REJECTED')));
    const root = f.runtime.getRecord(f.service,'generation.timeline-commands','root');
    for(let attempt=1;attempt<=3;attempt++) {
      assert.equal((await service.get(f.actor,'root')).nodes[0].canRetry,true);
      const retry=await service.retry(f.actor,'root',37,attempt);
      const record=f.runtime.getRecord(f.service,'generation.timeline-commands',retry.commandId);
      assert.deepEqual(record.participantIds,root.participantIds);
      assert.equal(record.data.sourceAssetId,'source');
      assert.deepEqual(record.data.generationPlan.identityPolicy,root.data.generationPlan.identityPolicy);
      assert.deepEqual(record.data.generationPlan.nodes[0].participantTargets,root.data.generationPlan.nodes[0].participantTargets);
      assert.equal(record.data.generationPlan.participantReferences.length,2);
      assert.deepEqual(record.data.generationPlan.participantReferences,root.data.generationPlan.participantReferences);
      assert.equal((await service.retry(f.actor,'root',37,attempt)).reused,true);
      f.runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',manifest('QUALITY_REJECTED')));
    }
    assert.equal((await service.get(f.actor,'root')).nodes[0].canRetry,false);
    assert.equal(f.runtime.listRecords(f.service,{collection:'generation.timeline-commands'}).length,4);
    await assert.rejects(service.retry(f.actor,'root',37,4),/invalid/);
  } finally { f.runtime.close(); }
});

test('actual dead-lettered child uncertainty is aggregated and never creates a second retry', async () => {
  const f = await timelineFixture(':memory:',{targetAges:[37]});
  try {
    const service=new TimelineDeliveryService(f.runtime);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','failed'));
    const retry=await service.retry(f.actor,'root',37,1),worker='quality-recovery-worker';
    const request=f.runtime.listOutbox(f.service,{limit:200}).find(event=>event.eventType==='external_command.requested'&&event.aggregateId===retry.commandId);
    assert.ok(request);
    for(let attempt=1;attempt<=10;attempt++) {
      const leased=f.runtime.claimOutbox(f.service,worker,200,30000);
      assert.ok(leased.some(event=>event.id===request.id));
      for(const event of leased) {
        if(event.id!==request.id) f.runtime.markOutboxPublished(f.service,event.id,worker);
        else if(attempt<10) f.runtime.markOutboxFailed(f.service,event.id,worker,'unknown provider delivery',{retryAt:new Date(Date.now()-1000).toISOString()});
      }
      if(attempt===10) f.runtime.deadLetterExternalCommand(f.service,{eventId:request.id,workerId:worker,error:'unknown delivery after ten attempts'});
    }
    const view=await service.get(f.actor,'root');
    assert.equal(view.nodes[0].status,'reconciliation_required');
    assert.equal(view.reconciliationState,'reconciliation_required');
    assert.equal(view.nodes[0].canRetry,false);
    await assert.rejects(service.retry(f.actor,'root',37,2),/uncertain/);
    assert.equal(f.runtime.listRecords(f.service,{collection:'generation.timeline-commands'}).length,2);
  } finally { f.runtime.close(); }
});
