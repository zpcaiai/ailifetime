import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,readFileSync,writeFileSync,unlinkSync,statSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createNativeAlbumService } from '../../../tools/native-album-api.mjs';

function load(file,context){const module={exports:{}};runInNewContext(readFileSync(new URL(file,import.meta.url),'utf8'),{module,exports:module.exports,ArrayBuffer,Uint8Array,...context});return module.exports;}
async function fixture(t,config={envVersion:'develop',nativeAlbumTestEnabled:true},hold){
  const directory=mkdtempSync(join(tmpdir(),'ltm-library-native-'));
  const service=await createNativeAlbumService({directory:join(directory,'service'),syntheticTestImages:true,lifetimeSeconds:120});
  const address=await service.listen(0),baseUrl=`http://127.0.0.1:${address.port}`;
  let actor=service.identity,page;const calls=[];
  const session={get:()=>actor,requireSession:()=>{if(!actor)throw Error('AUTHENTICATION_REQUIRED');return actor;},clearPrivateUrls(){}};
  const api={configuration:()=>({baseUrl,...config}),requestForPurpose:async(path,purpose,options={})=>{
    calls.push({path,purpose,method:options.method||'POST'});
    const response=await fetch(baseUrl+path,{method:options.method||'POST',headers:{authorization:`Bearer ${service.identity.accessToken}`,'x-purpose':purpose,'content-type':'application/json'},body:options.data===undefined?undefined:JSON.stringify(options.data)});
    if(!response.ok)throw Error(`HTTP_${response.status}`);
    const body=await response.json();if(hold)await hold(path);return body;
  }};
  const wx={env:{USER_DATA_PATH:directory},getRandomValues({success}){success({randomValues:Uint8Array.from(randomBytes(16)).buffer});},
    downloadFile(options){fetch(options.url,{headers:options.header}).then(async response=>{writeFileSync(options.filePath,Buffer.from(await response.arrayBuffer()));options.success({filePath:options.filePath,statusCode:response.status});}).catch(options.fail);},
    getImageInfo({src,success}){const png=readFileSync(src);success({width:png.readUInt32BE(16),height:png.readUInt32BE(20)});},
    getFileSystemManager(){return{stat({path,success}){success({stats:statSync(path)});},readFile({filePath,position,length,success}){success({data:Uint8Array.from(readFileSync(filePath).subarray(position,position+length)).buffer});},unlink({filePath,success,fail}){try{unlinkSync(filePath);success();}catch(error){fail(error);}}};},navigateTo(){}};
  const sha=load('../miniprogram/services/sha256.js',{});
  const media=load('../miniprogram/services/timeline-media.js',{wx,require:name=>name==='./api'?api:name==='./session'?session:name==='./sha256'?sha:{requireAuthorization:async()=>{}}});
  runInNewContext(readFileSync(new URL('../miniprogram/pages/library/index.js',import.meta.url),'utf8'),{Page:value=>page=value,
    require:name=>name.endsWith('/api')?api:name.endsWith('/session')?session:name.endsWith('/timeline-media')?media:{},wx,Error,setTimeout:()=>1,clearTimeout(){}});
  page.setData=value=>Object.assign(page.data,value);
  t.after(async()=>{await media.clearAll();await service.close();rmSync(directory,{recursive:true,force:true});});
  return{page,calls,service,setActor:value=>actor=value};
}

test('develop test album uses real SQLite config/timelines and opens actual integrity-verified images without business queries',async t=>{
  const f=await fixture(t);await f.page.load();
  assert.equal(f.page.data.error,'');assert.equal(f.page.data.nativeAlbumTest,true);assert.equal(f.page.data.items.length,2);
  assert.deepEqual(Array.from(f.page.data.items,item=>item.testExpectedCount),[1,21]);
  assert.ok(f.page.data.items.every(item=>item.testLabel.includes('测试')));
  assert.ok(f.calls.every(call=>call.method==='GET'&&call.purpose==='age_transformation'&&call.path!=='/v1/queries'));
  const item=f.page.data.items.find(item=>item.testExpectedCount===21);
  await f.page.openTimeline({currentTarget:{dataset:{id:item.id}}});
  assert.equal(f.page.data.delivery.readyCount,21);assert.ok(f.page.data.previewPath);
  assert.equal(createHash('sha256').update(readFileSync(f.page.data.previewPath)).digest('hex'),f.page.data.selectedNode.asset.sha256);
  const before=f.calls.length;await f.page.prepareShare({currentTarget:{dataset:{id:item.id}}});await f.page.retryAge();f.page.changeClothes();
  assert.equal(f.calls.length,before);
});
test('release, trial and non-test development retain business query path',async t=>{
  for(const config of [{envVersion:'release',nativeAlbumTestEnabled:true},{envVersion:'trial',nativeAlbumTestEnabled:true},{envVersion:'develop',nativeAlbumTestEnabled:false}]){
    const f=await fixture(t,config);await f.page.load();assert.equal(f.page.data.items.length,0);
    assert.ok(f.calls.some(call=>call.path==='/v1/queries'&&call.method==='POST'));
    assert.ok(!f.calls.some(call=>call.path==='/native-album/config'));
  }
});
test('late real test timeline responses after hide do not restore private album items',async t=>{
  let release;const waiting=new Promise(resolve=>release=resolve);
  const f=await fixture(t,undefined,path=>path.includes('/v1/timelines/')?waiting:Promise.resolve());
  const pending=f.page.load();for(let i=0;i<200&&!f.calls.some(call=>call.path.includes('/v1/timelines/'));i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(f.calls.some(call=>call.path.includes('/v1/timelines/')),'test album must request real timelines');
  f.page.onHide();release();await pending;assert.equal(f.page.data.items.length,0);assert.equal(f.page.data.previewPath,'');
});
