import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync}from'node:fs';
import {runInNewContext}from'node:vm';
const discoveryModule = { exports: {} };
runInNewContext(readFileSync(new URL('../miniprogram/services/wardrobe-catalog.js', import.meta.url), 'utf8'), { module: discoveryModule });
import {WARDROBE_STYLES,WARDROBE_SERIES,wardrobeStylesForCatalog,wardrobeSeriesForCatalog}from'../../../packages/capabilities/dist/wardrobe-plan.js';
function context(couple=false,age=37,legacy=false){return{sourceAssetId:'source',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,policyVersion:'wardrobe-edit-consent-v1',catalogVersion:legacy?'lifetime-wardrobe.v1':'lifetime-wardrobe.v3',series:legacy?undefined:WARDROBE_SERIES,sourceNode:{status:'ready',targetAge:age,asset:{sha256:'a'.repeat(64)},downloadPath:`/v1/timelines/root/nodes/${age}/image`},participants:(couple?['user','partner']:['user']).map((participantId,i)=>({participantId,position:couple?(i?'right':'left'):'single',authorized:false})),styles:(legacy?WARDROBE_STYLES.slice(0,34):WARDROBE_STYLES).map(s=>({...s,description:s.description??s.label,seriesId:s.seriesId??'legacy',seriesLabel:s.seriesLabel??'原有基础款',minAge:s.minAge??0,maxAge:s.maxAge??100,minPeople:s.minPeople??1,available:age>=(s.minAge??0)&&age<=(s.maxAge??100)&&(couple?2:1)>=(s.minPeople??1),unavailableReason:'适用范围',legacy:!s.seriesId}))};}
function result(age=37,status='ready',couple=false){return{commandId:'outfit',creationKind:'wardrobe',wardrobeSource:{sourceRootCommandId:'root',targetAge:age,selections:(couple?['user','partner']:['user']).map(participantId=>({participantId,styleId:'daily-white-v1'}))},expectedCount:1,nodes:[{targetAge:age,status,canRetry:status==='failed',attempts:0,asset:{sha256:'b'.repeat(64)},downloadPath:`/v1/timelines/outfit/nodes/${age}/image`}]};}
function seriesResult(age=37,seriesId='daily',statuses=[]) {
 const styles=WARDROBE_STYLES.filter(style=>style.seriesId===seriesId && age>=(style.minAge??0) && age<=(style.maxAge??100) && (style.minPeople??1)<=1);
 const items=styles.map((style,i)=>({itemId:style.id,title:style.label,targetAge:age,commandId:'series-job-'+i,status:statuses[i]||'ready',attempts:0,canRetry:statuses[i]==='failed',asset:{sha256:String(i+2).padStart(64,'0')},downloadPath:`/v1/timelines/series-job-${i}/nodes/${age}/image`}));
 return{purchaseId:'photo-suite',sku:'wardrobe-series',catalogVersion:'lifetime-wardrobe.v3',sourceRootCommandId:'root',seriesId,seriesTitle:styles[0]?.seriesLabel,expectedCount:styles.length,amountMinor:990,currency:'CNY',readyCount:items.filter(item=>item.status==='ready').length,paymentState:'paid',items};
}
function page(request,mediaOverrides={},version){
 let n=0;const timers=new Map(),removed=[],saves=[],calls=[],scrolls=[],redirects=[],mod={exports:{}};
 const media={download:async node=>'private-'+node.asset.sha256,remove:async path=>removed.push(path),save:async node=>saves.push(node),...mediaOverrides};
 runInNewContext(readFileSync(new URL('../miniprogram/services/wardrobe-page.js',import.meta.url),'utf8'),{module:mod,require:name=>{
  if(name.endsWith('/api'))return{idempotencyKey:prefix=>prefix+'-'+(++n),requestForPurpose:async(path,purpose,options)=>{calls.push({path,purpose,options});return request(path.split('?')[0],options,purpose);}};
  if(name.endsWith('/session'))return{get:()=>({actorId:'user'}),requireSession:()=>({actorId:'user'})};
  if(name.endsWith('/photo-purchases')) {
    const call=async(path,options)=>{calls.push({path,purpose:'age_transformation',options});return(await request(path,options,'age_transformation')).data;};
    return{PRICES:{'wardrobe-series':1990},money:minor=>`¥${(minor/100).toFixed(2)}`,errorText:error=>error.message,
      create:(input,key)=>call('/v1/photo-purchases',{data:input,headers:{'Idempotency-Key':key}}),get:id=>call('/v1/photo-purchases/'+id,{method:'GET'}),
      execute:quote=>call('/v1/photo-purchases/'+quote.purchaseId+'/fulfill',{data:{}}),retry:(id,item,attempt)=>call(`/v1/photo-purchases/${id}/items/${item}/retry`,{data:{attempt}})};
  }
  if(name.endsWith('/wardrobe-catalog'))return discoveryModule.exports;
  if(name.endsWith('/timeline-media'))return media;if(name.endsWith('/wardrobe'))return{version:'wardrobe-edit-consent-v1'};throw Error(name);
 },wx:{navigateTo(){},redirectTo:options=>redirects.push(options.url),switchTab(){},pageScrollTo:options=>scrolls.push(options.selector)},setTimeout:fn=>{const id=++n;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console});
 const p=mod.exports(version);
 p.setData=(data, rendered)=>{Object.assign(p.data,data);rendered?.();};return{p,calls,removed,saves,timers,scrolls,redirects};
}
for (const [version, packagePath, styleCount, seriesCount, defaultCategory, otherCategory] of [
 ['lifetime-wardrobe.v4','pages/wardrobe',234,26,'princess','prince'],
 ['lifetime-wardrobe.v5','pages/wardrobe-cinema',108,12,'women','men'],
]) test(`${version} renders nine exact templates, detail and a version-bound quote`,async()=>{
 const styles=wardrobeStylesForCatalog(version), series=wardrobeSeriesForCatalog(version);
 const ctx={...context(),catalogVersion:version,series,styles:styles.map(s=>({...s,description:s.description??s.label,seriesId:s.seriesId??'legacy',
  seriesLabel:s.seriesLabel??'原有基础款',minAge:s.minAge??0,maxAge:s.maxAge??100,minPeople:s.minPeople??1,available:true,unavailableReason:'',legacy:!s.seriesId}))};
 const group=series.find(s=>s.category===otherCategory);
 const items=styles.filter(s=>s.seriesId===group.id).map(s=>({itemId:s.id,targetAge:37,status:'awaiting_payment'}));
 const quote={purchaseId:'photo-royal-test',catalogVersion:version,sku:'wardrobe-series',seriesId:group.id,sourceRootCommandId:'root',amountMinor:1990,expectedCount:9,items};
 const requestQuote=async path=>({data:path.endsWith('/wardrobe')?ctx:quote});
 const f=page(requestQuote,{},version);
 await f.p.onLoad({rootId:'root',age:'37'});
 assert.ok(f.calls[0].path.endsWith('/wardrobe?catalogVersion='+version));
 assert.equal(f.p.data.series.length,seriesCount);assert.equal(f.p.data.styleCount,styleCount);
 assert.equal(f.p.data.bundleCount,9);assert.equal(f.p.data.priceSeries,'¥19.90');
 assert.ok(f.p.data.selectedSeries.id.endsWith('-'+defaultCategory));
 f.p.filterCategory({currentTarget:{dataset:{category:otherCategory}}});
 assert.equal(f.p.data.visibleSeries.length,seriesCount/2);
 await f.p.selectBundle({currentTarget:{dataset:{series:group.id}}});
 assert.deepEqual(Array.from(f.p.data.templateStyles,s=>s.id),items.map(s=>s.itemId));
 f.p.previewOutfit({currentTarget:{dataset:{style:items[8].itemId}}});
 assert.equal(f.p.data.focusedTemplate.previewSrc,'/'+packagePath+'/assets/'+items[8].itemId+'.webp');
 assert.equal(f.p.data.templatePosition,9);assert.equal(f.scrolls.at(-1),'#wardrobe-template-detail');
 f.p.data.accepted=true;
 await f.p.submit();
 const body=f.calls.find(call=>call.path==='/v1/photo-purchases').options.data;
 assert.equal(body.catalogVersion,version);assert.equal(body.seriesId,group.id);assert.equal(f.p.data.seriesItems.length,9);
 const reopened=page(requestQuote,{},version);
 await reopened.p.onLoad({purchaseId:quote.purchaseId});
 assert.equal(reopened.p.data.seriesPurchase.catalogVersion,version);
 assert.equal(reopened.p.data.templateStyles.length,9);
 const view=result();view.wardrobeSource.selections[0].styleId=items[8].itemId;
 const requestResult=async path=>({data:path.endsWith('/wardrobe')?ctx:view});
 const reopenedResult=page(requestResult,{},version);
 await reopenedResult.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});
 assert.ok(reopenedResult.p.data.resultPath);
 assert.equal(reopenedResult.p.data.people[0].styleId,items[8].itemId);
 if (version==='lifetime-wardrobe.v5') {
  const fromOrders=page(requestQuote);
  await fromOrders.p.onLoad({purchaseId:quote.purchaseId});
  assert.deepEqual(fromOrders.redirects,['/pages/wardrobe-cinema/index?purchaseId='+quote.purchaseId]);
  const fromLibrary=page(requestResult);
  await fromLibrary.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});
  assert.deepEqual(fromLibrary.redirects,['/pages/wardrobe-cinema/index?rootId=root&age=37&commandId=outfit']);
 }
});
test('collection switch uses the same source photo and blocks unresolved purchases',async()=>{
 const f=page(async()=>({data:context()}));
 await f.p.onLoad({rootId:'root',age:'37'});
 f.p.switchCollection();
 assert.deepEqual(f.redirects,['/pages/wardrobe-cinema/index?rootId=root&age=37']);
 f.p.intent={uncertain:true};
 f.p.switchCollection();
 assert.equal(f.redirects.length,1);
});
test('reopened9.90 wardrobe quote displays its stored price while new series remain19.90',async()=>{
 const current=seriesResult(),quote={...current,amountMinor:990,catalogVersion:'lifetime-wardrobe.v2',expectedCount:4,readyCount:4,items:current.items.slice(0,4)};const f=page(async path=>({data:path.endsWith('/wardrobe')?context():quote}));
 await f.p.onLoad({purchaseId:'photo-suite'});assert.equal(f.p.data.priceSeries,'¥9.90');assert.equal(f.p.data.retailPriceSeries,'¥19.90');assert.equal(f.p.data.templateStyles.length,4);assert.equal(f.p.data.bundleCount,4);
 f.p.searchSeries({detail:{value:'法式'}});assert.equal(f.p.data.priceSeries,'¥9.90');assert.equal(f.p.data.seriesPurchase.amountMinor,990);
 f.p.searchSeries({detail:{value:'雾蓝牛津棉'}});
 await f.p.selectBundle({currentTarget:{dataset:{series:'daily'}}});
 assert.equal(f.p.data.templateStyles.length,4);assert.equal(f.p.data.priceSeries,'¥9.90');
 assert.equal(f.p.data.focusedTemplate.id,'daily-white-v1');
 assert.equal(f.scrolls.at(-1),'#wardrobe-template-grid');
 for(let i=0;i<5;i++)f.p.stepTemplate({currentTarget:{dataset:{step:'next'}}});
 assert.equal(f.p.data.templatePosition,4);
 assert.equal(f.p.data.focusedTemplate.id,'daily-suit-v1');
 assert.equal(f.p.data.priceSeries,'¥9.90');
 assert.equal(f.calls.some(call=>call.path==='/v1/photo-purchases'),false);
 await f.p.selectBundle({currentTarget:{dataset:{series:'french'}}});assert.equal(f.p.data.priceSeries,'¥19.90');assert.equal(f.p.data.purchaseId,'');assert.equal(f.p.data.seriesPurchase,null);
});
test('nine-grid focus shows distinct style details without changing the bundle, payment or age gates',async()=>{
 const f=page(async()=>({data:context(false,6)}));await f.p.onLoad({rootId:'root',age:'6'});assert.equal(f.p.data.templateStyles.length,9);
 assert.deepEqual(f.scrolls, []);
 const last=f.p.data.templateStyles[8];f.p.previewOutfit({currentTarget:{dataset:{style:last.id}}});assert.equal(f.p.data.focusedTemplate.id,last.id);assert.equal(f.p.data.bundleCount,9);assert.equal(f.calls.filter(c=>c.path==='/v1/photo-purchases').length,0);
 assert.equal(f.p.data.templatePosition,9);
 f.p.showTemplateGrid();
 assert.deepEqual(f.scrolls, ['#wardrobe-template-detail', '#wardrobe-template-grid']);
 await f.p.selectBundle({currentTarget:{dataset:{series:'milestone'}}});assert.equal(f.p.data.templateStyles.length,9);assert.equal(f.p.data.bundleCount,4);
 const unavailable=f.p.data.templateStyles.find(s=>!s.available),before=f.p.data.focusedTemplate.id;f.p.previewOutfit({currentTarget:{dataset:{style:unavailable.id}}});assert.equal(f.p.data.focusedTemplate.id,before);
 assert.deepEqual(f.scrolls, ['#wardrobe-template-detail', '#wardrobe-template-grid', '#wardrobe-template-grid']);
 f.p.onHide();assert.equal(f.p.data.templateStyles.length,0);assert.equal(f.p.data.focusedTemplate,null);
});
test('large preview steps through eligible styles in order, respects boundaries and never submits', async () => {
 const f = page(async () => ({data: context(false, 6)}));
 await f.p.onLoad({rootId:'root', age:'6'});
 await f.p.selectBundle({currentTarget:{dataset:{series:'milestone'}}});
 const expected = Array.from(f.p.data.templateStyles.filter(style => style.available), style => style.id);
 assert.equal(expected.length, 4);
 const step = direction => f.p.stepTemplate({currentTarget:{dataset:{step:direction}}});
 step('previous');
 assert.equal(f.p.data.templatePosition, 1);
 const visited = [f.p.data.focusedTemplate.id];
 for(let i=1;i<expected.length;i++){
  step('next');
  assert.equal(f.p.data.templatePosition, i+1);
  visited.push(f.p.data.focusedTemplate.id);
 }
 step('next');
 assert.equal(f.p.data.templatePosition, 4);
 assert.deepEqual(visited, expected);
 f.p.setData({busy:true});
 step('previous');
 assert.equal(f.p.data.templatePosition, 4);
 f.p.setData({busy:false});
 step('previous');
 assert.equal(f.p.data.focusedTemplate.id, expected[2]);
 assert.equal(f.p.data.templatePosition, 3);
 assert.deepEqual(f.scrolls, ['#wardrobe-template-grid']);
 assert.equal(f.calls.some(call => call.path==='/v1/photo-purchases'), false);
 await f.p.onHide();
 step('next');
 assert.equal(f.p.data.templatePosition, 0);
 const entry = new URL('../miniprogram/pages/wardrobe/index.wxml', import.meta.url);
 const pageSource = readFileSync(entry,'utf8');
 const shared = /^<include src="([^"]+)"/.exec(pageSource);
 const view = shared ? readFileSync(new URL(shared[1],entry),'utf8') : pageSource;
 assert.match(view, /data-step="previous" bindtap="stepTemplate"/u);
 assert.match(view, /data-step="next" bindtap="stepTemplate"/u);
});
test('stale template render callbacks do not move the visible viewport', async () => {
 const f = page(async () => ({data: context()}));
 await f.p.onLoad({rootId: 'root', age: '37'});
 const callbacks = [];
 f.p.setData = (data, rendered) => {
  Object.assign(f.p.data, data);
  if (rendered) callbacks.push(rendered);
 };
 for (const style of f.p.data.templateStyles.slice(-2)) {
  f.p.previewOutfit({currentTarget: {dataset: {style: style.id}}});
 }
 assert.equal(callbacks.length, 2);
 callbacks.shift()();
 assert.deepEqual(f.scrolls, []);
 callbacks.shift()();
 assert.deepEqual(f.scrolls, ['#wardrobe-template-detail']);
 await f.p.selectBundle({currentTarget: {dataset: {series: 'french'}}});
 assert.equal(callbacks.length, 1);
 f.p.onHide();
 callbacks.shift()();
 assert.deepEqual(f.scrolls, ['#wardrobe-template-detail']);
});
test('discovery filters and style search preserve the selected quote, previews and uncertain intent',async()=>{
 const f=page(async()=>({data:context(false,6)}));await f.p.onLoad({rootId:'root',age:'6'});
 assert.equal(f.p.data.visibleSeries.length,24);assert.equal(f.p.data.styleCount,216);assert.equal(f.p.data.selectedSeries.id,'daily');
 f.p.searchSeries({detail:{value:'奶油软呢'}});assert.deepEqual(Array.from(f.p.data.visibleSeries.map(s=>s.id)),['french']);
 await f.p.selectBundle({currentTarget:{dataset:{series:'french'}}});assert.equal(f.p.data.bundleCount,9);assert.match(f.p.data.bundleStyles[1].description,/软呢/);
 assert.equal(f.p.data.focusedTemplate.id,'french-tweed-v1');
 assert.equal(f.scrolls.at(-1),'#wardrobe-template-detail');
 assert.equal(f.calls.some(call=>call.path==='/v1/photo-purchases'),false);
 f.p.searchSeries({detail:{value:'毕业纪念'}});
 await f.p.selectBundle({currentTarget:{dataset:{series:'milestone'}}});
 assert.equal(f.p.data.focusedTemplate.id,'milestone-birthday-v1');
 assert.equal(f.scrolls.at(-1),'#wardrobe-template-grid');
 f.p.searchSeries({detail:{value:'奶油软呢'}});
 await f.p.selectBundle({currentTarget:{dataset:{series:'french'}}});
 f.p.intent={uncertain:true,fingerprint:'keep'};const original=f.p.data.sourcePath;
 f.p.searchSeries({detail:{value:''}});f.p.filterCategory({currentTarget:{dataset:{category:'family'}}});f.p.filterAvailable({detail:{value:true}});
 assert.deepEqual(Array.from(f.p.data.visibleSeries.map(s=>s.id)),['storybook','baby']);assert.equal(f.p.data.selectedSeriesId,'french');assert.equal(f.p.intent.fingerprint,'keep');assert.equal(f.p.data.sourcePath,original);
 await f.p.selectBundle({currentTarget:{dataset:{series:'baby'}}});assert.equal(f.p.data.selectedSeriesId,'french');assert.match(f.p.data.error,/原选择/);
 f.p.searchSeries({detail:{value:'找不到'}});assert.equal(f.p.data.visibleSeries.length,0);f.p.clearDiscovery();assert.equal(f.p.data.visibleSeries.length,24);
 await f.p.onHide();assert.equal(f.p.data.visibleSeries.length,0);assert.equal(f.p.data.selectedSeries,null);assert.equal(f.p.data.styleCount,0);
});
test('wardrobe page handles single/couple and0/37/100, grants only self and uses neutral invite image',async()=>{
 for(const couple of[false,true])for(const age of[0,37,100]){
  const f=page(async(path,options)=>options.method==='GET'?{data:path.endsWith('/wardrobe')?context(couple,age):seriesResult(age,'east')}:{data:path==='/v1/commands'?{}:{purchaseId:'photo-suite'}});
  await f.p.onLoad({rootId:'root',age:String(age)});assert.equal(f.p.data.people.length,couple?2:1);
  await f.p.selectBundle({currentTarget:{dataset:{series:'east'}}});
  f.p.consentChanged({detail:{value:['accepted']}});await f.p.submit();
  const grants=f.calls.filter(c=>c.options.data?.command==='consent.grant');assert.equal(grants.length,1);assert.equal(grants[0].options.data.input.participantId,'user');assert.deepEqual(Array.from(grants[0].options.data.input.scope.actions),['wardrobe']);
  const submit=f.calls.find(c=>c.path==='/v1/photo-purchases');assert.equal(submit.options.data.sku,'wardrobe-series');assert.equal(submit.options.data.seriesId,'east');assert.equal(f.p.data.seriesPurchase.expectedCount,9);assert.equal(f.p.data.priceSeries,'¥9.90');assert.equal(f.p.data.seriesItems.length,9);assert.ok(f.p.data.sourcePath);assert.ok(f.p.data.seriesItems.every(item=>item.localPath));
  if(couple){const invite=f.p.onShareAppMessage({target:{dataset:{participant:'partner'}}});assert.match(invite.path,/action=wardrobe/);assert.equal(invite.imageUrl,'/assets/wardrobe-invite.png');assert.doesNotMatch(JSON.stringify(invite),/private-|token|download/);}
  f.p.onHide();assert.equal(f.p.data.context,null);assert.equal(f.p.data.resultPath,'');assert.equal(f.timers.size,0);
 }
});
test('uncertain wardrobe request reuses exact body/key, changed choices cannot submit again',async()=>{
 let attempts=0;const f=page(async(path,options)=>{if(options.method==='GET')return{data:path.endsWith('/wardrobe')?context():seriesResult()};if(path==='/v1/commands')return{data:{}};if(path==='/v1/photo-purchases'&&++attempts===1)throw Error('NETWORK_UNAVAILABLE');return{data:{purchaseId:'photo-suite'}};});
 await f.p.onLoad({rootId:'root',age:'37'});f.p.data.accepted=true;await f.p.submit();assert.equal(f.p.intent.uncertain,true);
 f.p.setData({selectedSeriesId:'east'});f.p.updateBundle();await f.p.submit();assert.match(f.p.data.error,/原选择/);assert.equal(attempts,1);
 f.p.setData({selectedSeriesId:'daily'});f.p.updateBundle();await f.p.submit();const posts=f.calls.filter(c=>c.path==='/v1/photo-purchases');assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);assert.deepEqual(posts[0].options.data,posts[1].options.data);assert.equal(f.p.data.purchaseId,'photo-suite');
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
test('a successful wardrobe purchase receipt arriving after hide is restored without resubmitting on foreground',async()=>{
 let release;const f=page(async(path,options)=>{if(options.method==='GET')return{data:path.endsWith('/wardrobe')?context():seriesResult()};if(path==='/v1/commands')return{data:{}};return new Promise(r=>release=r);});
 await f.p.onLoad({rootId:'root',age:'37'});f.p.data.accepted=true;const submitting=f.p.submit();for(let i=0;i<4&&!release;i++)await Promise.resolve();assert.ok(release);f.p.onHide();release({data:{purchaseId:'photo-suite'}});await submitting;assert.equal(f.p.data.purchaseId,'');f.p.onShow();for(let i=0;i<60&&!f.p.data.seriesPurchase;i++)await Promise.resolve();assert.equal(f.p.data.purchaseId,'photo-suite');assert.equal(f.p.data.seriesItems.length,9);assert.equal(f.calls.filter(c=>c.path==='/v1/photo-purchases').length,1);
});
test('eight series expose all 31 looks; unavailable age/count choices cannot replace a selection',async()=>{
 for(const couple of[false,true])for(const age of[0,17,18,49,50,100]){
  const f=page(async()=>({data:context(couple,age,true)}));await f.p.onLoad({rootId:'root',age:String(age)});assert.equal(f.p.data.series.length,8);assert.equal(f.p.data.styles.filter(s=>!s.legacy).length,31);
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
test('wardrobe offers explicit album settings after denial, never auto saves and ignores settings after hide',async()=>{
 let settings=0,release;const f=page(async path=>({data:path.endsWith('/wardrobe')?context():result()}),{save:async()=>{throw Error('ALBUM_PERMISSION_REQUIRED');},openAlbumSettings:async()=>{settings++;return true;}});
 await f.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});await f.p.save();assert.equal(f.p.data.albumPermissionDenied,true);await f.p.albumSettings();assert.equal(settings,1);assert.equal(f.p.data.albumPermissionDenied,false);assert.match(f.p.data.message,/再次点击/);assert.equal(f.saves.length,0);
 const g=page(async path=>({data:path.endsWith('/wardrobe')?context():result()}),{openAlbumSettings:()=>new Promise(r=>release=r)});await g.p.onLoad({rootId:'root',age:'37',commandId:'outfit'});const pending=g.p.albumSettings();g.p.onHide();release(true);await pending;assert.equal(g.p.data.context,null);assert.equal(g.p.data.resultPath,'');assert.equal(g.p.data.message,'');
});

test('late purchase lookup cannot reopen a hidden wardrobe page or download portraits',async()=>{
 let release,first=true,downloads=0;
 const f=page(async(path)=>{if(path.endsWith('/wardrobe'))return{data:context()};if(first){first=false;return new Promise(resolve=>release=resolve);}return{data:seriesResult()};},{download:async()=>{downloads++;return'private-photo';}});
 const opening=f.p.onLoad({purchaseId:'photo-suite'});f.p.onHide();release({data:seriesResult()});await opening;
 assert.equal(f.p.active,false);assert.equal(f.p.data.context,null);assert.equal(downloads,0);
});
test('whole-series save resumes remaining originals after denial and item recovery keeps one purchase',async()=>{
 const statuses=['ready','ready','failed','pending','pending','pending','pending','pending','pending'];let allowed=false,saving=0;
 const f=page(async(path,options)=>{
  if(path.endsWith('/wardrobe'))return{data:context()};
  if(path.endsWith('/retry')){assert.equal(options.data.attempt,1);statuses[2]='ready';return{data:{}};}
  return{data:seriesResult(37,'daily',statuses)};
 },{save:async()=>{saving++;if(!allowed&&saving===2)throw Error('ALBUM_PERMISSION_REQUIRED');},openAlbumSettings:async()=>true});
 await f.p.onLoad({purchaseId:'photo-suite'});assert.equal(f.p.data.seriesItems.length,9);assert.equal(f.p.data.seriesPurchase.readyCount,2);
 await f.p.saveSeries();assert.equal(f.p.data.albumPermissionDenied,true);assert.equal(f.p.data.seriesSaved,1);
 await f.p.albumSettings();allowed=true;await f.p.saveSeries();assert.equal(saving,3);assert.equal(f.p.data.seriesSaved,2);
 await f.p.retrySeries({currentTarget:{dataset:{item:'daily-linen-v1'}}});assert.equal(f.p.data.seriesPurchase.readyCount,3);assert.equal(f.p.data.purchaseId,'photo-suite');assert.equal(f.calls.filter(c=>c.path==='/v1/photo-purchases').length,0);
 const paths=[f.p.data.sourcePath,...f.p.data.seriesItems.map(i=>i.localPath).filter(Boolean)];f.p.onHide();assert.equal(f.p.data.seriesItems.length,0);assert.equal(f.p.data.seriesPurchase,null);assert.ok(paths.every(path=>f.removed.includes(path)));assert.equal(f.timers.size,0);
});
test('a mismatched purchased series cannot leave original or generated private previews visible',async()=>{
 const bad={...seriesResult(),sourceRootCommandId:'other-root'};
 const f=page(async path=>({data:path.endsWith('/wardrobe')?context():bad}));await f.p.onLoad({rootId:'root',age:'37'});assert.ok(f.p.data.sourcePath);f.p.setData({purchaseId:'photo-suite'});await f.p.refresh();
 assert.equal(f.p.data.context,null);assert.equal(f.p.data.sourcePath,'');assert.equal(f.p.data.seriesItems.length,0);
});
test('late series thumbnail after hide is removed and cannot restore the private view',async()=>{
 let release;const f=page(async path=>({data:path.endsWith('/wardrobe')?context():seriesResult()}),{download:async node=>node.itemId?new Promise(resolve=>release=resolve):'private-source'});
 const opening=f.p.onLoad({purchaseId:'photo-suite'});for(let i=0;i<30&&!release;i++)await Promise.resolve();assert.ok(release);
 f.p.onHide();release('late-series-thumbnail');await opening;assert.equal(f.p.data.seriesItems.length,0);assert.equal(f.p.data.context,null);assert.ok(f.removed.includes('late-series-thumbnail'));
});
