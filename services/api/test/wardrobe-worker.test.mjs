import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ProductionExternalCommandPublisher } from '../../workers/dist/index.js';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';

for(const revoked of ['wardrobe','source'])test('wardrobe worker rechecks '+revoked+' grant immediately before real HTTP egress',async()=>{
  const f=await wardrobeFixture({couple:true});let sends=0;const payloads=[];
  const server=createServer(async(req,res)=>{sends++;const chunks=[];for await(const chunk of req)chunks.push(chunk);payloads.push(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','application/json');res.end(JSON.stringify({provider:'generation-engine',providerRequestId:'synthetic-provider-op',state:'acknowledged',receivedAt:new Date().toISOString()}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const publisher=new ProductionExternalCommandPublisher(f.runtime,f.service,{B14:{async send(input){const r=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify(input)});const body=await r.text();return{...JSON.parse(body),artifactSha256:createHash('sha256').update(body).digest('hex')};}}});
  try{
    await f.grantWardrobe();await f.createWardrobe('allowed-outfit');
    const event=f.runtime.listOutbox(f.service).find(e=>e.eventType==='external_command.requested'&&e.aggregateId==='allowed-outfit');assert.ok(event);
    await publisher.publish(event);assert.equal(sends,1);assert.equal(payloads[0].payload.generationPlan.operation,'wardrobe-edit');
    await f.createWardrobe('queued-outfit');const queued=f.runtime.listOutbox(f.service).find(e=>e.eventType==='external_command.requested'&&e.aggregateId==='queued-outfit');
    const actor={...f.actor,actorId:'partner'},grant=f.runtime.listConsents(actor).find(c=>c.scope.actions.includes(revoked==='source'?'transform':'wardrobe'));
    f.runtime.withdrawConsent(actor,{consentId:grant.id,expectedVersion:grant.version,reason:'withdraw while queued',idempotencyKey:'queued-withdraw'});
    await assert.rejects(publisher.publish(queued),/consent/i);assert.equal(sends,1);assert.equal(f.runtime.getExternalCommand(f.service,'queued-outfit').state,'dispatched');
  }finally{await new Promise(r=>server.close(r));f.runtime.close();}
});
