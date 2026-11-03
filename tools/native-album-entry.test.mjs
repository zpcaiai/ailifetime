import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createNativeAlbumService } from './native-album-api.mjs';

function page(base,{version='develop',enabled=true,platform='devtools'}={}) {
  let p; const application={globalData:{}},navigation=[],calls=[];
  const wx={getAccountInfoSync:()=>({miniProgram:{envVersion:version}}),getSystemInfoSync:()=>({platform}),
    getExtConfigSync:()=>({apiBaseUrl:base,nativeAlbumTestEnabled:enabled}),removeStorageSync(){},
    navigateTo:input=>navigation.push(input.url),request:async input=>{
      calls.push(input.url);
      try {const response=await fetch(input.url,{method:input.method,headers:input.header});const body=await response.text();input.success({statusCode:response.status,data:body?JSON.parse(body):null});}
      catch {input.fail({errMsg:'request:fail'});}
    }};
  function load(file,require){const module={exports:{}};runInNewContext(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{module,exports:module.exports,require,wx,getApp:()=>application,URL,Error});return module.exports;}
  const session=load('apps/wechat-mini/miniprogram/services/session.js');
  const api=load('apps/wechat-mini/miniprogram/services/api.js',()=>session);
  runInNewContext(readFileSync(new URL('../apps/wechat-mini/native-test-entry/index.js',import.meta.url),'utf8'),{
    Page:value=>p=value,require:name=>name.endsWith('/api')?api:session,wx,getApp:()=>application,Error,
  });
  p.setData=value=>Object.assign(p.data,value);p.onLoad();return{p,session,navigation,calls};
}
test('development entry uses actual HTTP test principal/session verification and actual job routes', {timeout:10000},async()=>{
  const parent=mkdtempSync(join(tmpdir(),'ltm-native-entry-'));let server;
  try {
    server=await createNativeAlbumService({directory:join(parent,'state'),syntheticTestImages:true});
    const address=await server.listen(0),base=`http://127.0.0.1:${address.port}`,f=page(base);
    f.p.tokenChanged({detail:{value:server.identity.accessToken}});
    await Promise.all([f.p.connect(),f.p.connect()]);
    assert.equal(f.p.data.connected,true);assert.equal(f.calls.length,2);
    assert.equal(f.session.requireSession().accessToken,server.identity.accessToken);
    assert.equal(JSON.stringify(f.p.data).includes(server.identity.accessToken),false);
    f.p.openSingle();f.p.openBatch();assert.deepEqual(f.navigation,['/pages/job/index?commandId=single-root','/pages/job/index?commandId=root']);
    assert.ok(f.navigation.every(path=>!path.includes(server.identity.accessToken)));
    const invalid=page(base);invalid.p.tokenChanged({detail:{value:'f'.repeat(64)}});await invalid.p.connect();
    assert.equal(invalid.p.data.connected,false);assert.equal(invalid.session.get(),null);
    for(const mode of [{version:'release'},{enabled:false},{platform:'ios'}]) {
      const blocked=page(base,mode);blocked.p.tokenChanged({detail:{value:server.identity.accessToken}});await blocked.p.connect();
      assert.equal(blocked.p.data.enabled,false);assert.equal(blocked.calls.length,0);assert.equal(blocked.session.get(),null);
    }
  } finally {if(server)await server.close();rmSync(parent,{recursive:true,force:true});}
});
