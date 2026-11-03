import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpWechatPlatformBroker } from '../dist/wechat-platform.js';

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
