import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync}from'node:fs';
import {runInNewContext}from'node:vm';
import {WARDROBE_STYLES}from'../../../packages/capabilities/dist/wardrobe-plan.js';
function context(couple=false,age=37){return{sourceAssetId:'source',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,policyVersion:'wardrobe-edit-consent-v1',catalogVersion:'lifetime-wardrobe.v1',sourceNode:{status:'ready',targetAge:age,asset:{sha256:'a'.repeat(64)},downloadPath:`/v1/timelines/root/nodes/${age}/image`},participants:(couple?['user','partner']:['user']).map((participantId,i)=>({participantId,position:couple?(i?'right':'left'):'single',authorized:false})),styles:WARDROBE_STYLES.map(s=>({...s,seriesId:s.seriesId??'legacy',seriesLabel:s.seriesLabel??'原有基础款',minAge:s.minAge??0,maxAge:100,minPeople:s.minPeople??1,available:age>=(s.minAge??0)&&(couple?2:1)>=(s.minPeople??1),unavailableReason:'适用范围',legacy:!s.seriesId}))};}
function result(age=37,status='ready',couple=false){return{commandId:'outfit',creationKind:'wardrobe',wardrobeSource:{sourceRootCommandId:'root',targetAge:age,selections:(couple?['user','partner']:['user']).map(participantId=>({participantId,styleId:'daily-white-v1'}))},expectedCount:1,nodes:[{targetAge:age,status,canRetry:status==='failed',attempts:0,asset:{sha256:'b'.repeat(64)},downloadPath:`/v1/timelines/outfit/nodes/${age}/image`}]};}
function page(request,mediaOverrides={}){
 let p,n=0;const timers=new Map(),removed=[],saves=[],calls=[];
 const media={download:async node=>'private-'+node.asset.sha256,remove:async path=>removed.push(path),save:async node=>saves.push(node),...mediaOverrides};
 runInNewContext(readFileSync(new URL('../miniprogram/pages/wardrobe/index.js',import.meta.url),'utf8'),{Page:x=>p=x,require:name=>{
  if(name.endsWith('/api'))return{idempotencyKey:prefix=>prefix+'-'+(++n),requestForPurpose:async(path,purpose,options)=>{calls.push({path,purpose,options});return request(path,options,purpose);}};
  if(name.endsWith('/session'))return{get:()=>({actorId:'user'}),requireSession:()=>({actorId:'user'})};
  if(name.endsWith('/timeline-media'))return media;if(name.endsWith('/wardrobe'))return{version:'wardrobe-edit-consent-v1'};throw Error(name);
 },wx:{navigateTo(){},switchTab(){}},setTimeout:fn=>{const id=++n;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console});
 p.setData=x=>Object.assign(p.data,x);return{p,calls,removed,saves,timers};
}
test('wardrobe page handles single/couple and0/37/100, grants only self and uses neutral invite image',async()=>{
 for(const couple of[false,true])for(const age of[0,37,100]){
  const f=page(async(path,options)=>options.method==='GET'?{data:path.endsWith('/wardrobe')?context(couple,age):result(age,'ready',couple)}:{data:path==='/v1/commands'?{}:{commandId:'outfit'}});
  await f.p.onLoad({rootId:'root',age:String(age)});assert.equal(f.p.data.people.length,couple?2:1);
  f.p.chooseStyle({currentTarget:{dataset:{participant:'user',style:'formal'}}});if(couple)f.p.chooseStyle({currentTarget:{dataset:{participant:'partner',style:'traditional'}}});
  f.p.consentChanged({detail:{value:['accepted']}});await f.p.submit();
  const grants=f.calls.filter(c=>c.options.data?.command==='consent.grant');assert.equal(grants.length,1);assert.equal(grants[0].options.data.input.participantId,'user');assert.deepEqual(Array.from(grants[0].options.data.input.scope.actions),['wardrobe']);
  const submit=f.calls.find(c=>c.path.endsWith('/wardrobe')&&c.options.method!=='GET');assert.equal(submit.options.data.selections[0].styleId,'formal');assert.equal(f.p.data.result.status,'ready');assert.ok(f.p.data.sourcePath);assert.ok(f.p.data.resultPath);
  if(couple){const invite=f.p.onShareAppMessage({target:{dataset:{participant:'partner'}}});assert.match(invite.path,/action=wardrobe/);assert.equal(invite.imageUrl,'/assets/wardrobe-invite.png');assert.doesNotMatch(JSON.stringify(invite),/private-|token|download/);}
  f.p.onHide();assert.equal(f.p.data.context,null);assert.equal(f.p.data.resultPath,'');assert.equal(f.timers.size,0);
 }
});
test('uncertain wardrobe request reuses exact body/key, changed choices cannot submit again',async()=>{
 let attempts=0;const f=page(async(path,options)=>{if(options.method==='GET')return{data:path.endsWith('/wardrobe')?context():result()};if(path==='/v1/commands')return{data:{}};if(++attempts===1)throw Error('NETWORK_UNAVAILABLE');return{data:{commandId:'outfit'}};});
 await f.p.onLoad({rootId:'root',age:'37'});f.p.data.accepted=true;await f.p.submit();assert.equal(f.p.intent.uncertain,true);
 f.p.chooseStyle({currentTarget:{dataset:{participant:'user',style:'formal'}}});await f.p.submit();assert.match(f.p.data.error,/原选择/);assert.equal(attempts,1);
 f.p.chooseStyle({currentTarget:{dataset:{participant:'user',style:'daily-white-v1'}}});await f.p.submit();const posts=f.calls.filter(c=>c.path.endsWith('/wardrobe')&&c.options.method!=='GET');assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);assert.deepEqual(posts[0].options.data,posts[1].options.data);assert.equal(f.p.data.commandId,'outfit');
});
test('hidden wardrobe page ignores late context and never starts a job after consent returns late',async()=>{
 let resolveContext;const f=page(()=>new Promise(r=>resolveContext=r));const opening=f.p.onLoad({rootId:'root',age:'37'});f.p.onHide();resolveContext({data:context()});await opening;assert.equal(f.p.data.context,null);
 let resolveGrant;const g=page(async(path,options)=>{if(options.method==='GET')return{data:context()};if(path==='/v1/commands')return new Promise(r=>resolveGrant=r);throw Error('must not submit');});await g.p.onLoad({rootId:'root',age:'37'});g.p.data.accepted=true;const submission=g.p.submit();g.p.onHide();resolveGrant({data:{}});await submission;assert.equal(g.calls.some(c=>c.path.endsWith('/wardrobe')&&c.options.method!=='GET'),false);
});
test('wardrobe rejects other-job results and invalid paths before showing private output',async()=>{
 const f=page(async(path)=>({data:path.endsWith('/wardrobe')?context():{...result(),wardrobeSource:{sourceRootCommandId:'other',targetAge:37}}}));await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});assert.equal(f.p.data.resultPath,'');assert.match(f.p.data.error,/校验/);
 const g=page(()=>{throw Error('must not request');});await g.p.onLoad({rootId:'../bad',age:'37'});assert.equal(g.calls.length,0);
});
test('wardrobe save denial retains view; retry uses same age and bounded next attempt; revoke touches only own wardrobe grants',async()=>{
 let failed=true;const f=page(async(path,options)=>{
  if(path==='/v1/queries')return{data:[{id:'own',version:1,participantId:'user',purpose:'age_transformation',status:'active',scope:{resource:'media.asset:source',actions:['wardrobe']}},{id:'other',version:1,participantId:'partner',purpose:'age_transformation',status:'active',scope:{resource:'media.asset:source',actions:['wardrobe']}},{id:'age',version:1,participantId:'user',purpose:'age_transformation',status:'active',scope:{resource:'media.asset:source',actions:['transform']}}]};
  if(path==='/v1/commands')return{data:{}};if(path.endsWith('/retry')){assert.equal(options.data.targetAge,37);assert.equal(options.data.attempt,1);failed=false;return{data:{}};}
  return{data:path.endsWith('/wardrobe')?context():result(37,failed?'failed':'ready')};
 },{save:async()=>{throw Error('ALBUM_PERMISSION_REQUIRED');}});
 await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});await f.p.retry();assert.equal(f.p.data.result.status,'ready');await f.p.save();assert.match(f.p.data.error,/允许保存/);assert.ok(f.p.data.resultPath);assert.ok(f.p.data.sourcePath);await f.p.revoke();const withdrawals=f.calls.filter(c=>c.options.data?.command==='consent.withdraw');assert.equal(withdrawals.length,1);assert.equal(withdrawals[0].options.data.input.consentId,'own');assert.equal(f.p.data.result,null);
});

test('native privacy refusal clears both wardrobe and original private preview metadata',async()=>{
 const f=page(async path=>({data:path.endsWith('/wardrobe')?context():result()}),{save:async()=>{throw Error('PRIVACY_AUTHORIZATION_DENIED');}});
 await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});const paths=[f.p.data.sourcePath,f.p.data.resultPath];assert.ok(paths.every(Boolean));await f.p.save();assert.equal(f.p.data.context,null);assert.equal(f.p.data.result,null);assert.equal(f.p.data.sourcePath,'');assert.equal(f.p.data.resultPath,'');assert.ok(paths.every(path=>f.removed.includes(path)));
});
test('a successful wardrobe receipt arriving after hide is restored without resubmitting on foreground',async()=>{
 let release;const f=page(async(path,options)=>{if(options.method==='GET')return{data:path.endsWith('/wardrobe')?context():result()};if(path==='/v1/commands')return{data:{}};return new Promise(r=>release=r);});
 await f.p.onLoad({rootId:'root',age:'37'});f.p.data.accepted=true;const submitting=f.p.submit();for(let i=0;i<4&&!release;i++)await Promise.resolve();assert.ok(release);f.p.onHide();release({data:{commandId:'outfit'}});await submitting;assert.equal(f.p.data.commandId,'');f.p.onShow();for(let i=0;i<12&&!f.p.data.result;i++)await Promise.resolve();assert.equal(f.p.data.commandId,'outfit');assert.equal(f.calls.filter(c=>c.path.endsWith('/wardrobe')&&c.options.method!=='GET').length,1);
});
test('eight series expose all 31 looks; unavailable age/count choices cannot replace a selection',async()=>{
 for(const couple of[false,true])for(const age of[0,17,18,49,50,100]){
  const f=page(async()=>({data:context(couple,age)}));await f.p.onLoad({rootId:'root',age:String(age)});assert.equal(f.p.data.series.length,8);assert.equal(f.p.data.styles.filter(s=>!s.legacy).length,31);
  const seen=new Set();for(const group of f.p.data.series){f.p.chooseSeries({currentTarget:{dataset:{participant:'user',series:group.id}}});for(const s of f.p.data.people[0].options){seen.add(s.id);const before=f.p.data.people[0].styleId;f.p.chooseStyle({currentTarget:{dataset:{participant:'user',style:s.id}}});assert.equal(f.p.data.people[0].styleId,s.available?s.id:before);}}
  assert.equal(seen.size,31);if(couple)assert.equal(f.p.data.people[1].styleId,'daily-white-v1');
 }
});
test('reopened modern and legacy jobs restore exact per-person choices; invalid selections clear output',async()=>{
 for(const styleId of['formal','east-song-v1','together-trench-v1']){
  const view=result(37,'ready',true);view.wardrobeSource.selections=[{participantId:'user',styleId},{participantId:'partner',styleId:'newyear-red-v1'}];
  const f=page(async path=>({data:path.endsWith('/wardrobe')?context(true):view}));await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});assert.equal(f.p.data.people[0].styleId,styleId);assert.equal(f.p.data.people[1].styleId,'newyear-red-v1');assert.ok(f.p.data.people[0].options.some(s=>s.id===styleId));assert.ok(f.p.data.resultPath);
  f.p.onHide();f.p.active=true;await f.p.refresh();assert.equal(f.p.data.people[0].styleId,styleId);assert.equal(f.p.data.people[1].styleId,'newyear-red-v1');
 }
 const view=result();view.wardrobeSource.selections[0].styleId='wedding-anniversary-v1';const f=page(async path=>({data:path.endsWith('/wardrobe')?context():view}));await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});assert.equal(f.p.data.resultPath,'');assert.match(f.p.data.error,/校验/);
 const g=page(async()=>({data:{...context(),catalogVersion:'unknown'}}));await g.p.onLoad({rootId:'root',age:'37'});assert.equal(g.p.data.context,null);
});
