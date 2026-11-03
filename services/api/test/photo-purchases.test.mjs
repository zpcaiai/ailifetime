import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LifeTimeMachineRuntime,canonicalJson } from '@ltm/core';
import { PhotoPurchaseService,PHOTO_PURCHASE_COLLECTION,PHOTO_COMMAND_BINDING_COLLECTION } from '../dist/photo-purchases.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { timelineFixture,syntheticPng } from './timeline-fixtures.mjs';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';

// Only the external payment boundary is synthetic. Actual SQL, consent,
// generation commands and signed image/quality callback reducers execute.
function paymentBoundary() {
  const r={state:'paid',override:{},prepares:0};
  r.preparePhotoCheckout=async(actor,input)=>{
    assert.equal(actor.purpose,'commerce');r.prepares++;r.checkout={schemaVersion:'ltm.photo-checkout.v1',checkoutId:input.purchaseId,orderId:'merchant-'+input.purchaseId,amountMinor:input.amountMinor,currency:input.currency,scopeSha256:input.scopeSha256};return {...r.checkout,...r.override};
  };
  r.getPayment=async(actor,input)=>{assert.equal(actor.purpose,'commerce');assert.equal(input.orderId,r.checkout.orderId);return{schemaVersion:'ltm.wechat.payment-projection.v1',checkoutId:r.checkout.checkoutId,orderId:r.checkout.orderId,amountMinor:r.checkout.amountMinor,currency:'CNY',state:r.state,version:1,updatedAt:new Date().toISOString(),providerTransactionReference:r.state==='paid'?'synthetic-verified-transaction':null,...r.override};};
  return r;
}
function ageInput(couple=false,life=false) {
  return {sku:life?'lifespan-21':'selected-age',generation:{sourceAssetId:'source',participantIds:couple?['user','partner']:['user'],targetAges:life?Array.from({length:21},(_,i)=>i*5):[37],currentAge:30,
    timelineProfile:life?(couple?'lifespan-21-couple-v1':'lifespan-21-v1'):(couple?'single-age-couple-v1':'single-age-v1'),...(couple?{participantAges:[30,29]}:{}),seed:'purchase-seed',promptPolicyVersion:'age-policy-v1',illustrativeLabel:true}};
}
test('persisted historical v1 lifespan quote remains990 on read and merchant checkout after v2 rollout',async()=>{
  const f=await timelineFixture();try{
    const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,undefined,pay),created=await service.create(f.actor,ageInput(false,true),'old-order-fixture');
    const row=f.runtime.getRecord(f.actor,PHOTO_PURCHASE_COLLECTION,created.purchaseId);
    // Model an order already persisted by the old version, using the real SQL store.
    const scope={...row.data.scope,title:'一生相册',priceVersion:'photo-retail-cny.v1',amountMinor:990};
    for(const key of ['imageQuality','imageWidth','imageHeight','retentionDays'])delete scope[key];
    const data={...row.data,scope,scopeSha256:createHash('sha256').update(canonicalJson([scope,row.data.request])).digest('hex')};
    f.runtime.updateRecord(f.actor,{collection:PHOTO_PURCHASE_COLLECTION,id:row.id,expectedVersion:row.version,data,idempotencyKey:'seed-historical-v1'});
    assert.equal((await service.get(f.actor,row.id)).amountMinor,990);
    assert.equal((await service.create(f.actor,ageInput(false,true),'old-order-fixture')).amountMinor,990);
    await assert.rejects(service.create(f.actor,ageInput(),'old-order-fixture'),{code:'IDEMPOTENCY_CONFLICT'});
    const checkout=await service.checkout(f.actor,row.id);assert.equal(checkout.priceVersion,'photo-retail-cny.v1');assert.equal(checkout.checkout.amountMinor,990);assert.equal(checkout.expectedCount,21);
    const current=await service.create(f.actor,ageInput(false,true),'new-order-v2');assert.equal(current.amountMinor,4990);assert.equal(current.priceVersion,'photo-retail-cny.v3');
    assert.equal((await service.get(f.actor,row.id)).amountMinor,990);
  }finally{f.runtime.close();}
});
test('authoritative 590/4990 age purchases bind exact scope and refuse overposted money',async()=>{
  const f=await timelineFixture();try{
    const service=new PhotoPurchaseService(f.runtime,f.registry);
    assert.equal((await service.create(f.actor,ageInput(), 'single-purchase')).amountMinor,590);
    const reordered=ageInput();reordered.generation=Object.fromEntries(Object.entries(reordered.generation).reverse());
    assert.equal((await service.create(f.actor,reordered,'single-purchase')).amountMinor,590);
    const full=await service.create(f.actor,ageInput(false,true),'full-purchase');assert.equal(full.amountMinor,4990);assert.equal(full.priceVersion,'photo-retail-cny.v3');assert.equal(full.expectedCount,21);assert.equal(full.items.length,21);
    await assert.rejects(service.create(f.actor,{...ageInput(),amountMinor:1},'tampered-money'));
    await assert.rejects(service.create(f.actor,{...ageInput(false,true),sku:'selected-age'},'wrong-sku'));
    await assert.rejects(service.create(f.actor,ageInput(false,true),'single-purchase'),/Idempotency|idempotency/);
    await assert.rejects(service.fulfill(f.actor,full.purchaseId),/checkout/);
    await service.authorizeRetry(f.actor,'root');
    await assert.rejects(service.get({...f.actor,actorId:'other'},full.purchaseId));
  }finally{f.runtime.close();}
});
test('equal2990 tiers cannot replace one another andpersist standard quality and21 exact ages across SQLite reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tier-sqlite-')),f=await timelineFixture(join(dir,'runtime.sqlite'));let runtime=f.runtime;
 try{
  const a=ageInput(false,true);a.sku='lifespan-21-standard';a.generation.imageQuality='standard';
  const b=ageInput(false,true);b.sku='lifespan-11-hd';b.generation.imageQuality='hd';b.generation.timelineProfile='lifespan-11-v1';b.generation.targetAges=Array.from({length:11},(_,i)=>i*10);
  let service=new PhotoPurchaseService(runtime,f.registry);const first=await service.create(f.actor,a,'same-price-key');assert.equal(first.amountMinor,2990);assert.equal(first.imageWidth,1536);
  await assert.rejects(service.create(f.actor,b,'same-price-key'),{code:'IDEMPOTENCY_CONFLICT'});
  const stored=runtime.getRecord(f.actor,PHOTO_PURCHASE_COLLECTION,first.purchaseId),rowHash=createHash('sha256').update(JSON.stringify(stored)).digest('hex');runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);
  assert.equal(createHash('sha256').update(JSON.stringify(runtime.getRecord(f.actor,PHOTO_PURCHASE_COLLECTION,first.purchaseId))).digest('hex'),rowHash);
  service=new PhotoPurchaseService(runtime,f.registry);const replay=await service.create(f.actor,a,'same-price-key');assert.equal(replay.purchaseId,first.purchaseId);assert.equal(replay.imageQuality,'standard');assert.equal(replay.imageWidth,1536);assert.equal(replay.expectedCount,21);assert.equal(replay.retentionDays,30);assert.equal(replay.scopeSha256,first.scopeSha256);
  assert.deepEqual(replay.items.map(i=>i.targetAge),Array.from({length:21},(_,i)=>i*5));console.log(JSON.stringify({proof:'V3_TIER_SQLITE_REOPEN_ROW',rowHash}));
 }finally{runtime.close();await rm(dir,{recursive:true,force:true});}
});
test('native acknowledgement or pending/wrong payment cannot create generation; exact paid amount creates once',async()=>{
  const f=await timelineFixture();try{
    const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,undefined,pay);
    const purchase=await service.create(f.actor,ageInput(),'pay-gate');await service.checkout(f.actor,purchase.purchaseId);
    const count=()=>f.runtime.listRecords(f.actor,{collection:'generation.timeline-commands'}).length,before=count();
    pay.state='pending';assert.equal((await service.confirm(f.actor,purchase.purchaseId)).paymentState,'pending');await assert.rejects(service.fulfill(f.actor,purchase.purchaseId),/not been confirmed/);assert.equal(count(),before);
    pay.state='paid';pay.override={amountMinor:1};await assert.rejects(service.fulfill(f.actor,purchase.purchaseId),/does not match/);assert.equal(count(),before);
    pay.override={};assert.equal((await service.confirm(f.actor,purchase.purchaseId)).paymentState,'paid');assert.equal(count(),before);const started=await service.fulfill(f.actor,purchase.purchaseId);assert.equal(started.paymentState,'paid');assert.equal(started.expectedCount,1);assert.equal(started.items[0].targetAge,37);assert.equal(count(),before+1);
    assert.equal((await service.fulfill(f.actor,purchase.purchaseId)).commandId,started.commandId);assert.equal(count(),before+1);
    assert.equal(f.runtime.getRecord(f.actor,PHOTO_COMMAND_BINDING_COLLECTION,started.commandId).data.purchaseId,purchase.purchaseId);
    await service.authorizeRetry(f.actor,started.commandId);
    await assert.rejects(service.assertIntent(f.actor,purchase.purchaseId,{orderId:pay.checkout.orderId,amountMinor:990,currency:'CNY'}),/differs/);
    pay.state='refunded';await assert.rejects(service.fulfill(f.actor,purchase.purchaseId),/not been confirmed/);assert.equal(count(),before+1);
    await assert.rejects(service.authorizeRetry(f.actor,started.commandId),/not been confirmed/);
    assert.equal((await service.get(f.actor,purchase.purchaseId)).paymentState,'refunded');
  }finally{f.runtime.close();}
});
test('checkout binding rejects a merchant-changing amount or purchased scope',async()=>{
  const f=await timelineFixture();try{
    const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,undefined,pay),p=await service.create(f.actor,ageInput(),'checkout-binding');
    for(const override of [{amountMinor:1},{scopeSha256:'0'.repeat(64)},{checkoutId:'wrong-checkout'}]){pay.override=override;await assert.rejects(service.checkout(f.actor,p.purchaseId),/changed/);assert.equal((await service.get(f.actor,p.purchaseId)).checkout,null);}
  }finally{f.runtime.close();}
});
test('purchase and item bindings survive a real SQLite restart without a second generation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'photo-purchase-sql-')),f=await timelineFixture(join(dir,'runtime.sqlite'));let runtime=f.runtime;
  try{
    const pay=paymentBoundary(),first=new PhotoPurchaseService(runtime,f.registry,undefined,pay),p=await first.create(f.actor,ageInput(),'durable-order');await first.checkout(f.actor,p.purchaseId);const started=await first.fulfill(f.actor,p.purchaseId);
    const before=runtime.getRecord(f.actor,PHOTO_PURCHASE_COLLECTION,p.purchaseId),rowHash=createHash('sha256').update(JSON.stringify(before)).digest('hex');runtime.close();runtime=new LifeTimeMachineRuntime(f.runtimeOptions);
    assert.equal(createHash('sha256').update(JSON.stringify(runtime.getRecord(f.actor,PHOTO_PURCHASE_COLLECTION,p.purchaseId))).digest('hex'),rowHash);
    const restarted=new PhotoPurchaseService(runtime,f.registry,undefined,pay);assert.equal((await restarted.fulfill(f.actor,p.purchaseId)).commandId,started.commandId);
    assert.equal((await restarted.checkout(f.actor,p.purchaseId)).checkout.orderId,pay.checkout.orderId);assert.equal(pay.prepares,1);
    console.log(JSON.stringify({proof:'SQLITE_REOPEN_PURCHASE_ROW_SHA256',rowHash}));
  }finally{runtime.close();await rm(dir,{recursive:true,force:true});}
});
test('990 whole-series creates four separate same-age styles and reports partial/complete signed delivery truthfully',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'photo-series-')),store=new FileTimelineArtifactStore(join(dir,'images')),f=await wardrobeFixture({age:37,store});
  try{
    await f.grantWardrobe();const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,store,pay);
    const p=await service.create(f.actor,{sku:'wardrobe-series',sourceRootCommandId:'root',targetAge:37,seriesId:'east'},'whole-east');assert.equal(p.amountMinor,990);assert.equal(p.expectedCount,4);
    await service.checkout(f.actor,p.purchaseId);const started=await service.fulfill(f.actor,p.purchaseId);assert.equal(new Set(started.items.map(i=>i.commandId)).size,4);assert.ok(started.items.every(i=>i.targetAge===37));
    for(const item of started.items)assert.equal(f.runtime.getRecord(f.actor,PHOTO_COMMAND_BINDING_COLLECTION,item.commandId).data.purchaseId,p.purchaseId);
    for(let i=0;i<started.items.length;i++){
      const item=started.items[i],record=f.runtime.getRecord(f.actor,'generation.timeline-commands',item.commandId);assert.equal(record.data.wardrobeEdit.selections[0].styleId,item.itemId);
      const asset=await store.put('series-output-'+i,syntheticPng(i+5),'image/png'),node=await f.readyWardrobe(asset,item.commandId);f.runtime.applyExternalBusinessEvent(f.service,f.callback(item.commandId,'succeeded',f.manifest([node])));
      const current=await service.get(f.actor,p.purchaseId);assert.equal(current.readyCount,i+1);assert.equal(current.state,i===3?'ready':'partial');assert.equal(current.expectedCount,4);
    }
    const final=await service.get(f.actor,p.purchaseId);assert.equal(final.sourceRootCommandId,'root');assert.ok(final.items.every(i=>i.downloadPath && i.asset.sha256));
    assert.deepEqual((await service.fulfill(f.actor,p.purchaseId)).items.map(i=>i.commandId),started.items.map(i=>i.commandId));
  }finally{f.runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('couple single-age costs 590 total and preserves both authorized participants',async()=>{
  const f=await timelineFixture(':memory:',{couple:true});try{
    const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,undefined,pay),p=await service.create(f.actor,ageInput(true),'couple-price');
    assert.equal(p.amountMinor,590);await service.checkout(f.actor,p.purchaseId);const started=await service.fulfill(f.actor,p.purchaseId);
    const command=f.runtime.getRecord(f.actor,'generation.timeline-commands',started.commandId);assert.deepEqual(command.data.participantIds,['user','partner']);assert.deepEqual(command.data.targetAges,[37]);
  }finally{f.runtime.close();}
});
test('failed wardrobe item retries within the same paid series and preserves other item bindings',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'photo-series-retry-')),store=new FileTimelineArtifactStore(join(dir,'images')),f=await wardrobeFixture({age:37,store});
  try{
    await f.grantWardrobe();const pay=paymentBoundary(),service=new PhotoPurchaseService(f.runtime,f.registry,store,pay),p=await service.create(f.actor,{sku:'wardrobe-series',sourceRootCommandId:'root',targetAge:37,seriesId:'east'},'recover-series');
    await service.checkout(f.actor,p.purchaseId);const started=await service.fulfill(f.actor,p.purchaseId),item=started.items[2];
    f.runtime.applyExternalBusinessEvent(f.service,f.callback(item.commandId,'failed'));
    assert.equal((await service.get(f.actor,p.purchaseId)).items[2].canRetry,true);
    const retry=await service.retry(f.actor,p.purchaseId,item.itemId,1);assert.equal((await service.retry(f.actor,p.purchaseId,item.itemId,1)).commandId,retry.commandId);
    const asset=await store.put('recovered-series',syntheticPng(12),'image/png'),node=await f.readyWardrobe(asset,retry.commandId);f.runtime.applyExternalBusinessEvent(f.service,f.callback(retry.commandId,'succeeded',f.manifest([node])));
    const view=await service.get(f.actor,p.purchaseId);assert.equal(view.amountMinor,990);assert.equal(view.expectedCount,4);assert.equal(view.readyCount,1);assert.equal(view.state,'partial');assert.equal(view.items[2].attempts,1);assert.equal(view.items[2].asset.sha256,asset.sha256);assert.equal(pay.prepares,1);
    assert.deepEqual(view.items.map(i=>i.commandId),started.items.map(i=>i.commandId));
    await assert.rejects(service.retry(f.actor,p.purchaseId,'not-purchased-style',1));
  }finally{f.runtime.close();await rm(dir,{recursive:true,force:true});}
});
