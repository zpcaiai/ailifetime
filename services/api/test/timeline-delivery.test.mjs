import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineDeliveryService } from '../dist/timeline-delivery.js';
import { timelineFixture } from './timeline-fixtures.mjs';
test('actual SQLite timeline projects all21 and durable retry intents reuse a single bounded attempt', async () => {
  const f = await timelineFixture();
  try {
    const service = new TimelineDeliveryService(f.runtime);
    const initial = await service.get(f.actor,'root');
    assert.equal(initial.nodes.length,21); assert.equal(initial.readyCount,0);
    await assert.rejects(service.retry(f.actor,'root',0,1),/active, uncertain/);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','failed'));
    assert.equal((await service.get(f.actor,'root')).state,'blocked');
    for (let attempt=1;attempt<=3;attempt++) {
      const first = await service.retry(f.actor,'root',0,attempt);
      const same = await new TimelineDeliveryService(f.runtime).retry(f.actor,'root',0,attempt);
      assert.equal(same.commandId,first.commandId); assert.equal(same.reused,true);
      assert.equal((await service.get(f.actor,'root')).nodes[0].status,'retrying');
      f.runtime.applyExternalBusinessEvent(f.service,f.callback(first.commandId,'failed'));
    }
    assert.equal((await service.get(f.actor,'root')).nodes[0].canRetry,false);
    await assert.rejects(service.retry(f.actor,'root',0,4),/invalid/);
    await assert.rejects(service.get({...f.actor,actorId:'another'},'root'),/own|permission|access/i);
    f.runtime.withdrawConsent(f.actor,{consentId:f.consent.value.id,expectedVersion:f.consent.value.version,reason:'test withdrawal',idempotencyKey:'withdraw'});
    await assert.rejects(service.get(f.actor,'root'),/consent/i);
  } finally { f.runtime.close(); }
});
