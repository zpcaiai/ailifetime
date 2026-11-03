import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer,StaticTokenAuthenticator } from '../dist/index.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { timelineFixture } from './timeline-fixtures.mjs';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';

// External merchant projection only is synthetic. Actual public HTTP, auth,
// durable SQLite, capability authorization and generation outbox execute.
async function serverFor(f,store) {
  let checkout;const payment={state:'pending',wrongIntent:false};
  const platform={
    preparePhotoCheckout:async(_actor,input)=>(checkout={schemaVersion:'ltm.photo-checkout.v1',checkoutId:input.purchaseId,orderId:'merchant-'+input.purchaseId,amountMinor:input.amountMinor,currency:'CNY',scopeSha256:input.scopeSha256}),
    getPayment:async()=>({...checkout,schemaVersion:'ltm.wechat.payment-projection.v1',state:payment.state,version:1,updatedAt:new Date().toISOString(),providerTransactionReference:payment.state==='paid'?'synthetic-merchant-transaction':null}),
    createPayment:async()=>({schemaVersion:'ltm.wechat.payment-intent.v1',checkoutId:checkout.checkoutId,orderId:checkout.orderId,amountMinor:payment.wrongIntent?1:checkout.amountMinor,currency:'CNY',expiresAt:new Date(Date.now()+60000).toISOString(),parameters:{timeStamp:String(Math.floor(Date.now()/1000)),nonceStr:'synthetic-payment-nonce',package:'prepay_id=synthetic_photo_order',signType:'RSA',paySign:'A'.repeat(96)}}),
  };
  const server=createApiServer({runtime:f.runtime,capabilityRegistry:f.registry,timelineArtifacts:store,appEnvironment:'test',staticDirectory:null,clientIntegrations:{wechatPlatform:platform},
    authenticator:new StaticTokenAuthenticator([{token:'photo-owner-token',actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation','commerce']},{token:'photo-attacker-token',actorId:'other',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation','commerce']}])});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;let sequence=0;
  async function request(path,body,token='photo-owner-token',purpose='age_transformation'){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'x-purpose':purpose,'content-type':'application/json','Idempotency-Key':'photo-http-'+(++sequence)},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};
  }
  return{payment,request,close:()=>new Promise(resolve=>server.close(resolve))};
}
const single={sku:'selected-age',generation:{sourceAssetId:'source',participantIds:['user'],targetAges:[37],currentAge:30,timelineProfile:'single-age-v1',seed:'http-photo-seed',promptPolicyVersion:'age-policy-v1',illustrativeLabel:true}};

for(const couple of [false,true])for(const lifespan of [false,true])test(`paid consumer purchase ${couple?'couple':'single'} ${lifespan?'21 ages':'selected age'}`,async()=>{
  const ages=lifespan?Array.from({length:21},(_,i)=>i*5):[37],f=await timelineFixture(':memory:',{couple,targetAges:ages,verifiedConsent:true}),s=await serverFor(f);
  try{
    const input={sku:lifespan?'lifespan-21':'selected-age',generation:{...single.generation,participantIds:f.participantIds,targetAges:ages,currentAge:35,timelineProfile:`${lifespan?'lifespan-21':'single-age'}${couple?'-couple':''}-v1`,...(couple?{participantAges:[35,32]}:{})}};
    const response=await s.request('/v1/photo-purchases',input);assert.equal(response.status,201,JSON.stringify(response.body));const p=response.body.data,prefix='/v1/photo-purchases/'+p.purchaseId;
    assert.equal(p.amountMinor,lifespan?990:590);assert.equal(p.expectedCount,ages.length);assert.deepEqual(p.items.map(item=>item.targetAge),ages);
    await s.request(prefix+'/checkout',{});assert.equal((await s.request(prefix+'/fulfill',{})).status,409);
    s.payment.state='paid';const fulfilled=await s.request(prefix+'/fulfill',{});assert.equal(fulfilled.status,200,JSON.stringify(fulfilled.body));
    const command=f.runtime.getRecord(f.actor,'generation.timeline-commands',fulfilled.body.data.commandId);assert.deepEqual(command.data.participantIds,f.participantIds);assert.deepEqual(command.data.targetAges,ages);assert.equal(command.data.timelineProfile,input.generation.timelineProfile);
    assert.equal((await s.request(prefix+'/fulfill',{})).body.data.commandId,fulfilled.body.data.commandId);
  }finally{await s.close();f.runtime.close();}
});

test('HTTP retail pricing cannot be changed, forged, or bypassed by a free B14 call',async()=>{
  const f=await timelineFixture(),s=await serverFor(f);try{
    const catalog=await s.request('/v1/photo-products');assert.deepEqual(catalog.body.data.products.map(p=>p.amountMinor),[990,590,990]);
    assert.equal((await s.request('/v1/photo-purchases',{...single,amountMinor:1})).status,422);
    const created=await s.request('/v1/photo-purchases',single);assert.equal(created.status,201);const p=created.body.data,prefix='/v1/photo-purchases/'+p.purchaseId;assert.equal(p.amountMinor,590);
    assert.equal((await s.request(prefix,undefined,'photo-attacker-token')).status,403);
    assert.equal((await s.request('/v1/commands',{command:'record.create',input:{collection:'commerce.photo-purchases',id:p.purchaseId,data:{paymentState:'paid'}}})).status,403);
    assert.equal((await s.request('/v1/capabilities/B14',{...single.generation,jobId:'free-generation'})).status,403);
    assert.equal((await s.request('/v1/capabilities',{batchId:'B14',input:{...single.generation,jobId:'free-generation-2'}})).status,403);
    const prepared=await s.request(prefix+'/checkout',{});assert.equal(prepared.status,200);assert.equal(prepared.body.data.checkout.amountMinor,590);
    assert.equal((await s.request(prefix+'/confirm',{})).body.data.paymentState,'pending');
    assert.equal((await s.request(prefix+'/fulfill',{paid:true})).status,422);assert.equal((await s.request(prefix+'/fulfill',{})).status,409);
    s.payment.wrongIntent=true;assert.equal((await s.request('/v1/wechat/payments',{checkoutId:p.purchaseId},'photo-owner-token','commerce')).status,503);
    s.payment.wrongIntent=false;assert.equal((await s.request('/v1/wechat/payments',{checkoutId:p.purchaseId},'photo-owner-token','commerce')).status,201);
    assert.equal((await s.request(prefix+'/fulfill',{})).status,409);
    s.payment.state='paid';assert.equal((await s.request(prefix+'/confirm',{})).body.data.paymentState,'paid');
    const fulfilled=await s.request(prefix+'/fulfill',{});assert.equal(fulfilled.status,200);assert.equal(fulfilled.body.data.expectedCount,1);assert.equal(fulfilled.body.data.items[0].targetAge,37);
    assert.equal((await s.request(prefix+'/fulfill',{})).body.data.commandId,fulfilled.body.data.commandId);
    const orders=await s.request('/v1/photo-purchases');assert.equal(orders.body.data.items.length,1);assert.equal(orders.body.data.items[0].purchaseId,p.purchaseId);assert.equal(orders.body.data.items[0].request,undefined);
  }finally{await s.close();f.runtime.close();}
});
test('HTTP whole wardrobe series submits every eligible style for one 990 total and rejects the old single-style paid bypass',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'photo-http-series-')),store=new FileTimelineArtifactStore(join(dir,'images')),f=await wardrobeFixture({age:37,store});await f.grantWardrobe();const s=await serverFor(f,store);
  try{
    const input={sku:'wardrobe-series',sourceRootCommandId:'root',targetAge:37,seriesId:'east'};
    assert.equal((await s.request('/v1/photo-purchases',{...input,styleIds:['east-pankou-v1']})).status,422);
    const p=(await s.request('/v1/photo-purchases',input)).body.data,prefix='/v1/photo-purchases/'+p.purchaseId;assert.equal(p.amountMinor,990);assert.equal(p.expectedCount,4);assert.equal(p.sourceRootCommandId,'root');
    assert.equal((await s.request('/v1/timelines/root/nodes/37/wardrobe',{selections:[{participantId:'user',styleId:'east-pankou-v1'}]})).status,403);
    await s.request(prefix+'/checkout',{});s.payment.state='paid';const result=await s.request(prefix+'/fulfill',{});assert.equal(result.status,200);assert.equal(result.body.data.items.length,4);assert.equal(new Set(result.body.data.items.map(i=>i.commandId)).size,4);assert.equal(result.body.data.amountMinor,990);
  }finally{await s.close();f.runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('generic timeline retry checks fresh purchase payment but preserves historical jobs',async()=>{
  const f=await timelineFixture(),s=await serverFor(f);try{
    const p=(await s.request('/v1/photo-purchases',single)).body.data,prefix='/v1/photo-purchases/'+p.purchaseId;
    await s.request(prefix+'/checkout',{});s.payment.state='paid';
    const result=(await s.request(prefix+'/fulfill',{})).body.data,root=result.commandId;
    f.runtime.applyExternalBusinessEvent(f.service,f.callback(root,'failed'));
    const first=await s.request('/v1/timelines/'+encodeURIComponent(root)+'/retry',{targetAge:37,attempt:1});assert.equal(first.status,200);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback(first.body.data.commandId,'failed'));
    s.payment.state='refunded';
    assert.equal((await s.request('/v1/timelines/'+encodeURIComponent(root)+'/retry',{targetAge:37,attempt:2})).status,409);
    assert.equal((await s.request('/v1/commands',{command:'record.create',input:{collection:'commerce.photo-command-bindings',id:'forged',data:{purchaseId:p.purchaseId}}})).status,403);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','failed'));
    assert.equal((await s.request('/v1/timelines/root/retry',{targetAge:0,attempt:1})).status,200);
  }finally{await s.close();f.runtime.close();}
});

test('personal order cursor makes all26 durable purchases discoverable without payment',async()=>{
  const f=await timelineFixture(),s=await serverFor(f);try{
    const ids=[];for(let i=0;i<26;i++){const result=await s.request('/v1/photo-purchases',single);assert.equal(result.status,201);ids.push(result.body.data.purchaseId);}
    const first=(await s.request('/v1/photo-purchases')).body.data;assert.equal(first.items.length,25);assert.match(first.nextCursor,/^photo-[a-f0-9]{64}$/);
    const second=(await s.request('/v1/photo-purchases?cursor='+first.nextCursor)).body.data;assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);
    assert.deepEqual([...first.items,...second.items].map(i=>i.purchaseId).sort(),ids.sort());assert.ok([...first.items,...second.items].every(i=>i.paymentState==='pending'));
    for(const query of ['cursor=bad','cursor='+first.nextCursor+'&cursor='+first.nextCursor,'amountMinor=1'])assert.equal((await s.request('/v1/photo-purchases?'+query)).status,422);
  }finally{await s.close();f.runtime.close();}
});
