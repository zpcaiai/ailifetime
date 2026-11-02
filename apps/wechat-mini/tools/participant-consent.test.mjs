import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
function page(actorId, request) {
  let result; const decisions=[]; const nav=[];
  runInNewContext(readFileSync(new URL('../miniprogram/pages/privacy/index.js',import.meta.url),'utf8'),{Page:p=>result=p,getApp:()=>({globalData:{privacyRequest:null}}),wx:{navigateBack:x=>nav.push(x),navigateTo:x=>nav.push(x),switchTab:x=>nav.push(x)},require:name=>{
    if(name.endsWith('/privacy'))return{decide:x=>decisions.push(x)};
    if(name.endsWith('/session'))return{get:()=>actorId?{actorId}:null};
    if(name.endsWith('/api'))return{idempotencyKey:()=> 'pair-consent-key',requestForPurpose:request};
    if(name.endsWith('/age-transformation'))return{version:'privacy-v1'};
    if(name.endsWith('/wardrobe'))return{version:'wardrobe-edit-consent-v1'};
    throw Error(name);
  }});result.setData=update=>Object.assign(result.data,update);return{result,decisions,nav};
}
test('couple invitation grants only authenticated recipient self consent and reuses uncertain ID',async()=>{
  const calls=[];let fail=true;
  const f=page('partner',async(...args)=>{calls.push(args);if(fail){fail=false;throw Error('network');}});
  f.result.onLoad({assetId:'source',participantId:'partner'});await f.result.agree();await f.result.agree();await f.result.agree();
  assert.equal(calls.length,2);assert.equal(calls[0][2].headers['Idempotency-Key'],calls[1][2].headers['Idempotency-Key']);
  const input=calls[1][2].data.input;assert.equal(input.participantId,'partner');assert.equal(input.grantorCapacity,'self');assert.equal(input.scope.resource,'media.asset:source');assert.equal(f.result.data.agreed,true);assert.deepEqual(f.decisions,[]);
});
test('wrong account, invalid invite and no session cannot grant partner consent',async()=>{
  for(const [actorId,options]of [['owner',{assetId:'source',participantId:'partner'}],['partner',{assetId:'../../bad',participantId:'partner'}],[null,{assetId:'source',participantId:'partner'}]]){
    let count=0;const f=page(actorId,async()=>count++);f.result.onLoad(options);await f.result.agree();assert.equal(count,0);
  }
});

test('invitation opened as entry can return home when there is no prior page',()=>{
  const f=page('partner',async()=>{});f.result.onLoad({assetId:'source',participantId:'partner'});f.result.disagree();f.nav[0].fail();assert.equal(f.nav[1].url,'/pages/home/index');assert.deepEqual(f.decisions,[]);
});

test('wardrobe invitation grants only separate wardrobe action and rejects unknown invitation purposes',async()=>{
  const calls=[];const f=page('partner',async(...args)=>calls.push(args));f.result.onLoad({assetId:'source',participantId:'partner',action:'wardrobe'});await f.result.agree();
  assert.equal(calls.length,1);const input=calls[0][2].data.input;assert.equal(input.policyVersion,'wardrobe-edit-consent-v1');assert.deepEqual(Array.from(input.scope.actions),['wardrobe']);assert.equal(input.participantId,'partner');assert.equal('evidenceHash'in input,false);assert.equal(f.result.data.inviteKind,'wardrobe');
  const wrong=page('owner',async()=>calls.push('wrong'));wrong.result.onLoad({assetId:'source',participantId:'partner',action:'wardrobe'});await wrong.result.agree();assert.match(wrong.result.data.error,/本人/);assert.equal(calls.length,1);
  const invalid=page('partner',async()=>calls.push('invalid'));invalid.result.onLoad({assetId:'source',participantId:'partner',action:'arbitrary'});await invalid.result.agree();assert.equal(invalid.result.data.inviteValid,false);assert.equal(calls.length,1);
});
