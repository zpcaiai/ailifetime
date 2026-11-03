import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PHOTO_PRODUCTS } from '../../../services/api/dist/photo-catalog.js';
const id='photo-'+'a'.repeat(64),scope='b'.repeat(64);
function purchase(overrides={}){return{schemaVersion:'ltm.photo-purchase.v1',purchaseId:id,sku:'selected-age',title:'停在某一岁',priceVersion:'photo-retail-cny.v1',amountMinor:590,currency:'CNY',expectedCount:1,seriesId:null,seriesTitle:null,scopeSha256:scope,checkout:null,paymentState:'pending',commandId:null,state:'awaiting_payment',readyCount:0,items:[{itemId:'age-37',targetAge:37,status:'awaiting_payment',attempts:0,canRetry:false,commandId:null,downloadPath:null}],...overrides};}
function client({confirmStates=['paid'],modal=true,intentAmount=590,afterRequest=()=>{},active=()=>true,orderPage=null}={}){
 const calls=[];let native=0,sequence=0,current={actorId:'user',tenantId:'tenant'},confirmed=0;
 const wx={showModal:input=>input.success({confirm:modal}),requestPayment:input=>{native++;input.success();}};
 const checkout={schemaVersion:'ltm.photo-checkout.v1',checkoutId:id,orderId:'merchant-order-12345678',amountMinor:590,currency:'CNY',scopeSha256:scope};
 const api={idempotencyKey:prefix=>prefix+'-'+(++sequence),requestForPurpose:async(path,purpose,options)=>{
   calls.push({path,purpose,options});afterRequest(path,current);
   if(orderPage && path.startsWith('/v1/photo-purchases') && options.method==='GET')return{data:orderPage};
   if(path==='/v1/wechat/payments')return{data:{schemaVersion:'ltm.wechat.payment-intent.v1',checkoutId:id,orderId:checkout.orderId,amountMinor:intentAmount,currency:'CNY',expiresAt:new Date(Date.now()+60000).toISOString(),parameters:{timeStamp:String(Math.floor(Date.now()/1000)),nonceStr:'nonce-synthetic-payment',package:'prepay_id=synthetic_photo_order',signType:'RSA',paySign:'A'.repeat(96)}}};
   if(path.endsWith('/confirm')){const state=confirmStates[Math.min(confirmed++,confirmStates.length-1)];return{data:purchase({checkout,paymentState:state})};}
   if(path.endsWith('/fulfill'))return{data:purchase({checkout,paymentState:'paid',state:'processing',commandId:'generation-1',items:[{itemId:'age-37',targetAge:37,status:'pending',commandId:'generation-1'}]})};
   return{data:purchase({checkout})};
 }};
 const session={get:()=>current,requireSession:()=>current};
 function load(name){const module={exports:{}};runInNewContext(readFileSync(new URL('../miniprogram/services/'+name+'.js',import.meta.url),'utf8'),{module,require:n=>n==='./api'?api:n==='./session'?session:n==='./commerce'?commerce:null,wx,setTimeout,clearTimeout,console});return module.exports;}
 const commerce=load('commerce'),p=load('photo-purchases');
 return{p,calls,get native(){return native;},options:{attempts:2,intervalMs:0,isCurrent:active},current};
}
test('client advertises the exact authoritative totals and rejects mutated quote scope',()=>{
 const f=client();for(const product of PHOTO_PRODUCTS)assert.equal(f.p.PRICES[product.sku],product.amountMinor);
 assert.equal(f.p.money(990),'¥9.90');assert.equal(f.p.validate(purchase()).expectedCount,1);
 for(const change of [{amountMinor:1},{expectedCount:21},{scopeSha256:'invalid'},{currency:'USD'},{readyCount:1},{items:[]}])assert.throws(()=>f.p.validate(purchase(change)));
 assert.throws(()=>f.p.validate(purchase({scopeSha256:'c'.repeat(64)}),purchase()),/SCOPE_CHANGED/);
});
test('new 49.90 lifespan quotes and immutable old 9.90 quotes use exact version-price pairs',async()=>{
 const f=client(),life=purchase({sku:'lifespan-21',expectedCount:21,items:Array.from({length:21},(_,i)=>({itemId:'age-'+i*5,targetAge:i*5,status:'awaiting_payment'}))});
 assert.equal(f.p.validate({...life,priceVersion:'photo-retail-cny.v1',amountMinor:990}).amountMinor,990);
 assert.equal(f.p.validate({...life,priceVersion:'photo-retail-cny.v2',amountMinor:4990}).amountMinor,4990);
 assert.equal(f.p.money(f.p.PRICES['lifespan-21']),'¥49.90');
 for(const change of [{priceVersion:'photo-retail-cny.v2',amountMinor:990},{priceVersion:'photo-retail-cny.v1',amountMinor:4990},{priceVersion:'photo-retail-cny.v3',amountMinor:4990},{priceVersion:'toString',amountMinor:4990}]){
   assert.throws(()=>f.p.validate({...life,...change}),/INVALID/);
   const g=client({orderPage:{items:[{...life,...change}],nextCursor:null}});await assert.rejects(g.p.listPage(),/INVALID/);
 }
 const g=client({orderPage:{items:[{...life,amountMinor:990},{...life,priceVersion:'photo-retail-cny.v2',amountMinor:4990}],nextCursor:null}});
 assert.deepEqual(Array.from((await g.p.list()).map(i=>i.amountText)),['¥9.90','¥49.90']);
});
test('an already-paid merchant order resumes without another native payment',async()=>{
 const f=client();const result=await f.p.execute(purchase(),f.options);assert.equal(result.commandId,'generation-1');assert.equal(f.native,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/fulfill')).length,1);
});
test('all four v3 mini quotes bind price/count/resolution and reject changed tier or30day retention',async()=>{
 const f=client();
 for(const count of [11,21])for(const quality of ['standard','hd']){
  const tier=f.p.album(count,quality),quote=purchase({sku:tier.sku,priceVersion:'photo-retail-cny.v3',amountMinor:tier.amountMinor,expectedCount:count,imageQuality:quality,imageWidth:tier.size,imageHeight:tier.size,retentionDays:30,items:Array.from({length:count},(_,i)=>({itemId:'age-'+i*(count===11?10:5),targetAge:i*(count===11?10:5),status:'awaiting_payment'}))});
  assert.equal(f.p.validate(quote).expectedCount,count);
  for(const change of [{imageQuality:quality==='hd'?'standard':'hd'},{imageWidth:1024},{imageHeight:1024},{retentionDays:31},{expectedCount:count===11?21:11},{priceVersion:'photo-retail-cny.v2'},{amountMinor:1}])assert.throws(()=>f.p.validate({...quote,...change}));
  assert.throws(()=>f.p.validate({...quote,items:[...quote.items].reverse()}),/SCOPE_CHANGED/);
  const g=client({orderPage:{items:[quote],nextCursor:null}});assert.equal((await g.p.list())[0].amountText,f.p.money(tier.amountMinor));
 }
 for(const args of [[10,'hd'],[11,'fast'],['11','standard']])assert.throws(()=>f.p.album(...args));
 await assert.rejects(f.p.create({sku:'lifespan-11-standard',generation:{imageQuality:'standard'}}),/SCOPE_CHANGED/);assert.equal(f.native,0);
});
test('native payment success cannot generate until the server confirms paid',async()=>{
 const f=client({confirmStates:['pending','pending','pending']});await assert.rejects(f.p.execute(purchase(),f.options),/CONFIRMATION_PENDING/);assert.equal(f.native,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/fulfill')).length,0);
 const g=client({confirmStates:['pending','pending','paid']});assert.equal((await g.p.execute(purchase(),g.options)).commandId,'generation-1');assert.equal(g.native,1);assert.equal(g.calls.filter(c=>c.path.endsWith('/fulfill')).length,1);
});
test('actual commerce adapter checks the quote amount immediately before opening native payment',async()=>{
 const f=client({confirmStates:['pending'],intentAmount:990});await assert.rejects(f.p.execute(purchase(),f.options),/AMOUNT_CHANGED/);assert.equal(f.native,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/fulfill')).length,0);
});
test('account switch, page hide, cancellation and refunded state cannot charge or generate',async()=>{
 const a=client({afterRequest:(path,current)=>{if(path.endsWith('/checkout'))current.actorId='other';}});await assert.rejects(a.p.execute(purchase(),a.options),/ACCOUNT_CHANGED/);assert.equal(a.native,0);
 let active=true;const b=client({afterRequest:path=>{if(path.endsWith('/confirm'))active=false;},active:()=>active});await assert.rejects(b.p.execute(purchase(),b.options),/BACKGROUND_RECOVERY/);assert.equal(b.native,0);
 const c=client({modal:false});await assert.rejects(c.p.execute(purchase(),c.options),/CANCELLED/);assert.equal(c.calls.length,0);assert.equal(c.native,0);
 const d=client({confirmStates:['refunded']});await assert.rejects(d.p.execute(purchase(),d.options),/NOT_PAID/);assert.equal(d.native,0);
});
test('order page validates cursor and retrieves later orders without payment',async()=>{
 const f=client({orderPage:{items:[purchase()],nextCursor:id}});const first=await f.p.listPage();assert.equal(first.items[0].amountText,'¥5.90');assert.equal(first.nextCursor,id);assert.equal(f.native,0);
 await assert.rejects(f.p.listPage(id),/ORDERS_INVALID/);await assert.rejects(f.p.listPage('bad'),/ORDERS_INVALID/);
 const g=client({orderPage:{items:[purchase()],nextCursor:null}});assert.equal((await g.p.listPage(id)).nextCursor,null);assert.equal(g.calls[0].path,'/v1/photo-purchases?cursor='+id);assert.equal((await g.p.list()).length,1);
 for(const nextCursor of ['bad',undefined]){const h=client({orderPage:{items:[purchase()],nextCursor}});await assert.rejects(h.p.listPage(),/ORDERS_INVALID/);}
});
