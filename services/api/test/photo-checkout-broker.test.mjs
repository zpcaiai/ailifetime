import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpWechatPlatformBroker } from '../dist/wechat-platform.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('authenticated checkout transport sends the authoritative whole-series total and rejects changed price/scope',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'photo-checkout-broker-')),file=join(dir,'workload-token');await writeFile(file,'test-only-workload-token',{mode:0o600});
  const input={purchaseId:'photo-'+'a'.repeat(64),sku:'wardrobe-series',amountMinor:990,currency:'CNY',priceVersion:'photo-retail-cny.v1',scopeSha256:'b'.repeat(64),imageCount:4,idempotencyKey:'photo-checkout-test-key'},actor={actorId:'consumer-12345678',tenantId:'tenant-12345678',roles:['consumer'],purpose:'commerce',requestId:'request-12345678'};
  const calls=[];let override={};
  const broker=new HttpWechatPlatformBroker({baseUrl:'http://127.0.0.1:8082',workloadTokenFile:file,allowInsecureLoopback:true,customerServiceAllowedOrigins:['https://service.product.cn'],fetch:async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body),headers:init.headers});
    return new Response(JSON.stringify({schemaVersion:'ltm.photo-checkout.v1',checkoutId:input.purchaseId,orderId:'merchant-order-12345678',amountMinor:990,currency:'CNY',scopeSha256:input.scopeSha256,...override}),{status:200,headers:{'content-type':'application/json'}});
  }});
  try{
    assert.equal((await broker.preparePhotoCheckout(actor,input)).amountMinor,990);
    assert.equal(calls[0].url,'http://127.0.0.1:8082/v1/wechat/photo-checkouts');assert.equal(calls[0].body.product.imageCount,4);assert.equal(calls[0].body.product.amountMinor,990);assert.equal(calls[0].body.principal.actorId,actor.actorId);
    for(const change of [{amountMinor:1},{scopeSha256:'c'.repeat(64)},{checkoutId:'changed-order'},{unexpected:'field'}]){override=change;await assert.rejects(broker.preparePhotoCheckout(actor,input));}
    const count=calls.length;
    for(const change of [{amountMinor:3960},{imageCount:0},{imageCount:5},{priceVersion:'client-version'}])await assert.rejects(broker.preparePhotoCheckout(actor,{...input,...change}));
    assert.equal(calls.length,count);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual checkout HTTP preserves old990 and new4990 lifespan quotes and blocks crossed price versions before egress',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'photo-version-broker-')),file=join(dir,'token');await writeFile(file,'test-only-workload-token',{mode:0o600});const calls=[];
 const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks));calls.push(data.product);assert.equal(req.headers.authorization,'Bearer test-only-workload-token');res.setHeader('content-type','application/json');res.end(JSON.stringify({schemaVersion:'ltm.photo-checkout.v1',checkoutId:data.purchaseId,orderId:'merchant-versioned-order',amountMinor:data.product.amountMinor,currency:'CNY',scopeSha256:data.product.scopeSha256}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const broker=new HttpWechatPlatformBroker({baseUrl:'http://127.0.0.1:'+server.address().port,workloadTokenFile:file,allowInsecureLoopback:true,customerServiceAllowedOrigins:['https://service.product.cn']});
  const actor={actorId:'consumer-12345678',tenantId:'tenant-12345678',roles:['consumer'],purpose:'commerce',requestId:'request-12345678'},input={purchaseId:'photo-'+'c'.repeat(64),sku:'lifespan-21',currency:'CNY',scopeSha256:'d'.repeat(64),imageCount:21,idempotencyKey:'versioned-checkout'};
  for(const [priceVersion,amountMinor] of [['photo-retail-cny.v1',990],['photo-retail-cny.v2',4990]])assert.equal((await broker.preparePhotoCheckout(actor,{...input,priceVersion,amountMinor})).amountMinor,amountMinor);
  assert.deepEqual(calls.map(p=>[p.priceVersion,p.amountMinor,p.imageCount]),[['photo-retail-cny.v1',990,21],['photo-retail-cny.v2',4990,21]]);
  for(const [priceVersion,amountMinor] of [['photo-retail-cny.v1',4990],['photo-retail-cny.v2',990],['photo-retail-cny.v4',4990]])await assert.rejects(broker.preparePhotoCheckout(actor,{...input,priceVersion,amountMinor}));assert.equal(calls.length,2);
  for(const [sku,imageCount,amountMinor] of [['lifespan-11-standard',11,1990],['lifespan-21-standard',21,2990],['lifespan-11-hd',11,2990],['lifespan-21',21,4990]]){
   const current={...input,sku,imageCount,amountMinor,priceVersion:'photo-retail-cny.v3'};assert.equal((await broker.preparePhotoCheckout(actor,current)).amountMinor,amountMinor);
   await assert.rejects(broker.preparePhotoCheckout(actor,{...current,amountMinor:1}));await assert.rejects(broker.preparePhotoCheckout(actor,{...current,imageCount:imageCount===11?21:11}));
  }
  assert.equal(calls.length,6);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
