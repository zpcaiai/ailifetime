import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
function fixture(overrides={}) {
 let p,actor={actorId:'user',tenantId:'tenant'},payments=0;const navigation=[],calls=[];
 const quote={purchaseId:'photo-order',sku:'selected-age',title:'停在某一岁',amountMinor:590,paymentState:'pending',expectedCount:1,readyCount:0,commandId:null,state:'awaiting_payment'};
 const purchases={listPage:async()=>({items:[{...quote,amountText:'¥5.90'}],nextCursor:null}),get:async id=>{calls.push(id);return{...quote};},execute:async(value,options)=>{payments++;assert.equal(options.isCurrent(),true);return{...value,paymentState:'paid',commandId:'age-job',state:'processing'};},money:value=>`¥${(value/100).toFixed(2)}`,errorText:error=>error.message,...overrides};
 runInNewContext(readFileSync(new URL('../miniprogram/pages/commerce/index.js',import.meta.url),'utf8'),{Page:value=>p=value,require:name=>name.endsWith('/session')?{get:()=>actor}:purchases,wx:{navigateTo:value=>navigation.push(value.url)}});
 p.setData=value=>Object.assign(p.data,value);p.owner={...actor};p.active=true;
 return{p,quote,navigation,calls,get payments(){return payments;},account:value=>actor=value};
}
test('order load and refresh only read; explicit resume shows exact total and opens age job',async()=>{
 const f=fixture();f.p.onLoad({purchaseId:'photo-order'});await f.p.refresh();assert.equal(f.payments,0);assert.equal(f.p.data.orders[0].amountText,'¥5.90');assert.equal(f.p.data.selected.amountText,'¥5.90');
 await f.p.resume();assert.equal(f.payments,1);assert.equal(f.p.data.selected.paymentState,'paid');f.p.open();assert.deepEqual(f.navigation,['/pages/job/index?commandId=age-job']);
});
test('whole series order opens all-style wardrobe and refunded order cannot resume',async()=>{
 const f=fixture();f.p.showOrder({...f.quote,sku:'wardrobe-series',purchaseId:'series-order',expectedCount:4,amountMinor:990,paymentState:'refunded'});assert.equal(f.p.data.selected.amountText,'¥9.90');await f.p.resume();assert.equal(f.payments,0);f.p.open();assert.equal(f.navigation[0],'/pages/wardrobe/index?purchaseId=series-order');
});
test('hidden or changed account ignores late order lookup and clears private metadata',async()=>{
 for(const change of ['hide','account']){
  let release;const f=fixture({get:()=>new Promise(resolve=>release=resolve)});const pending=f.p.select({currentTarget:{dataset:{id:'photo-order'}}});
  if(change==='hide')f.p.onHide();else f.account({actorId:'other',tenantId:'tenant'});
  release(f.quote);await pending;assert.equal(f.p.data.selected,null);assert.equal(f.payments,0);assert.equal(f.navigation.length,0);
 }
});
test('pending payment errors retain selected order and rapid resume cannot duplicate payment',async()=>{
 let reject;const f=fixture({execute:()=>new Promise((_,r)=>reject=r)});f.p.showOrder(f.quote);const pending=f.p.resume();await f.p.resume();assert.equal(f.p.data.busy,true);reject(Error('PHOTO_PAYMENT_CONFIRMATION_PENDING'));await pending;assert.equal(f.p.data.selected.purchaseId,'photo-order');assert.equal(f.p.data.busy,false);assert.match(f.p.data.error,/PENDING/);
});
test('late fulfillment after hide cannot navigate or restore private order',async()=>{
 let release;const f=fixture({execute:()=>new Promise(resolve=>release=resolve)});f.p.showOrder(f.quote);const pending=f.p.resume();f.p.onHide();release({...f.quote,commandId:'age-job'});await pending;assert.equal(f.p.data.selected,null);assert.equal(f.navigation.length,0);
});
test('more orders appends unique purchases, keeps recovery selection and ignores hidden response',async()=>{
 const calls=[];const f=fixture({listPage:async cursor=>{calls.push(cursor);return cursor?{items:[{purchaseId:'first'},{purchaseId:'second'}],nextCursor:null}:{items:[{purchaseId:'first'}],nextCursor:'first'};}});
 await f.p.refresh();f.p.showOrder(f.quote);await f.p.more();assert.deepEqual(Array.from(f.p.data.orders,i=>i.purchaseId),['first','second']);assert.equal(f.p.data.selected.purchaseId,f.quote.purchaseId);assert.equal(f.payments,0);assert.deepEqual(calls,[undefined,'first']);
 let release;const g=fixture({listPage:()=>new Promise(resolve=>release=resolve)});g.p.setData({nextCursor:'cursor'});const pending=g.p.more();g.p.onHide();release({items:[{purchaseId:'late'}],nextCursor:null});await pending;assert.equal(g.p.data.orders.length,0);
});
