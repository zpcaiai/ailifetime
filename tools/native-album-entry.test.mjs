import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync,mkdtempSync,rmSync,renameSync,mkdirSync,writeFileSync,unlinkSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createNativeAlbumService } from './native-album-api.mjs';
import { prepareNativeAlbumPreview } from './native-album-preview.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

function page(previewRoot,{version='develop',compiled=true,platform='devtools'}={}) {
  let p; const application={globalData:{}},navigation=[],calls=[],downloads=[],requestHeaders=[];
  const privateDirectory=join(previewRoot,'probe-private');mkdirSync(privateDirectory,{recursive:true});
  const wx={getAccountInfoSync:()=>({miniProgram:{envVersion:version}}),getSystemInfoSync:()=>({platform}),
    getExtConfigSync:()=>({}),removeStorageSync(){},
    env:{USER_DATA_PATH:privateDirectory},
    getFileSystemManager:()=>({readFileSync(){throw Error('CODE_PACKAGE_TEXT_READ_UNAVAILABLE');},unlink:input=>{
      try {unlinkSync(input.filePath);input.success();}catch(error){input.fail({errMsg:error.message});}
    }}),
    downloadFile:async input=>{
      downloads.push(input);assert.equal(input.header,undefined);
      try {const response=await fetch(input.url);writeFileSync(input.filePath,new Uint8Array(await response.arrayBuffer()));input.success({statusCode:response.status,filePath:input.filePath});}
      catch {input.fail({errMsg:'downloadFile:fail'});}
    },
    navigateTo:input=>navigation.push(input.url),request:async input=>{
      calls.push(input.url);
      requestHeaders.push(input.header||{});
      try {const response=await fetch(input.url,{method:input.method,headers:input.header});const body=await response.text();input.success({statusCode:response.status,data:body?JSON.parse(body):null});}
      catch {input.fail({errMsg:'request:fail'});}
    }};
  function load(file,require){const module={exports:{}};runInNewContext(readFileSync(file,'utf8'),{module,exports:module.exports,require,wx,getApp:()=>application,URL,Error});return module.exports;}
  const session=load(join(previewRoot,'miniprogram/services/session.js'));
  const nativeRequire=createRequire(join(previewRoot,'miniprogram/services/api.js'));
  const api=load(compiled?join(previewRoot,'miniprogram/services/api.js'):new URL('../apps/wechat-mini/miniprogram/services/api.js',import.meta.url),name=>{
    if(name==='./session')return session;
    assert.equal(name,'./native-album-ext.js');return nativeRequire(name);
  });
  runInNewContext(readFileSync(new URL('../apps/wechat-mini/native-test-entry/index.js',import.meta.url),'utf8'),{
    Page:value=>p=value,require:name=>name.endsWith('/api')?api:session,wx,getApp:()=>application,Error,
  });
  p.setData=value=>Object.assign(p.data,value);p.onLoad();return{p,session,navigation,calls,downloads,requestHeaders,privateDirectory};
}
test('development entry uses actual HTTP test principal/session verification and actual job routes', {timeout:10000},async()=>{
  const parent=mkdtempSync(join(tmpdir(),'ltm-native-entry-'));let server;
  try {
    server=await createNativeAlbumService({directory:join(parent,'state'),syntheticTestImages:true});
    const address=await server.listen(0),base=`http://127.0.0.1:${address.port}`;
    const previewRoot=join(parent,'preview');
    prepareNativeAlbumPreview({sourceRoot:fileURLToPath(new URL('../apps/wechat-mini',import.meta.url)),output:previewRoot,apiBaseUrl:base,allowLoopbackDevtools:true});
    const diagnosis=page(previewRoot);
    await Promise.all([diagnosis.p.checkConnection(),diagnosis.p.checkConnection()]);
    assert.equal(diagnosis.calls.length,1);assert.equal(diagnosis.downloads.length,1);
    assert.deepEqual(Object.keys(diagnosis.requestHeaders[0]),[]);
    assert.match(diagnosis.p.data.connectionMessage,/request：HTTP_401；downloadFile：HTTP_401/);
    assert.equal(diagnosis.session.get(),null);assert.equal(diagnosis.p.data.checking,false);
    assert.deepEqual(readdirSync(diagnosis.privateDirectory),[]);
    const hidden=page(previewRoot),pending=hidden.p.checkConnection();hidden.p.onHide();await pending;
    assert.equal(hidden.p.data.checking,false);assert.doesNotMatch(hidden.p.data.connectionMessage,/HTTP_/);
    assert.deepEqual(readdirSync(hidden.privateDirectory),[]);
    const f=page(previewRoot);
    f.p.tokenChanged({detail:{value:server.identity.accessToken}});
    await Promise.all([f.p.connect(),f.p.connect()]);
    assert.equal(f.p.data.connected,true);assert.equal(f.calls.length,2);
    assert.equal(f.session.requireSession().accessToken,server.identity.accessToken);
    assert.equal(JSON.stringify(f.p.data).includes(server.identity.accessToken),false);
    f.p.openSingle();f.p.openBatch();assert.deepEqual(f.navigation,['/pages/job/index?commandId=single-root','/pages/job/index?commandId=root']);
    assert.ok(f.navigation.every(path=>!path.includes(server.identity.accessToken)));
    const invalid=page(previewRoot);invalid.p.tokenChanged({detail:{value:'f'.repeat(64)}});await invalid.p.connect();
    assert.equal(invalid.p.data.connected,false);assert.equal(invalid.session.get(),null);
    for(const mode of [{version:'release'},{version:'trial'},{compiled:false},{platform:'ios'}]) {
      const blocked=page(previewRoot,mode);blocked.p.tokenChanged({detail:{value:server.identity.accessToken}});await blocked.p.connect();
      await blocked.p.checkConnection();assert.equal(blocked.downloads.length,0);
      assert.equal(blocked.p.data.enabled,false);assert.equal(blocked.calls.length,0);assert.equal(blocked.session.get(),null);
    }
    const httpsPreview=join(parent,'https-preview');
    prepareNativeAlbumPreview({sourceRoot:fileURLToPath(new URL('../apps/wechat-mini',import.meta.url)),output:httpsPreview,apiBaseUrl:'https://album-test.holiness.uk'});
    assert.deepEqual(JSON.parse(JSON.stringify(createRequire(join(httpsPreview,'miniprogram/services/api.js'))('./native-album-ext.js'))),JSON.parse(readFileSync(join(httpsPreview,'miniprogram/ext.json'))));
    const phone=page(httpsPreview,{platform:'ios'});assert.equal(phone.p.data.enabled,true);assert.equal(phone.calls.length,0);
    const missingPreview=join(parent,'missing-preview');
    prepareNativeAlbumPreview({sourceRoot:fileURLToPath(new URL('../apps/wechat-mini',import.meta.url)),output:missingPreview,apiBaseUrl:'https://album-test.holiness.uk'});
    const config=join(missingPreview,'miniprogram/services/native-album-ext.js');
    renameSync(config,config+'.unavailable');
    try {
      const missing=page(missingPreview,{platform:'ios'});assert.equal(missing.p.data.enabled,false);assert.equal(missing.calls.length,0);
    } finally {renameSync(config+'.unavailable',config);}
  } finally {if(server)await server.close();rmSync(parent,{recursive:true,force:true});}
});
