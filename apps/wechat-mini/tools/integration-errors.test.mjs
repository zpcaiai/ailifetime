import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomFillSync} from 'node:crypto';

function client({ext={},version='develop',request,login}={}) {
 let page,logins=0,navigations=0;const removed=[],app={globalData:{session:null}},cache=new Map();
 const wx={getExtConfigSync:()=>ext,getAccountInfoSync:()=>({miniProgram:{envVersion:version,appId:'wx0123456789abcdef'}}),request,getRandomValues:values=>randomFillSync(values),
  login:options=>{logins++;login?login(options):options.success({code:'test-boundary-code'});},removeStorageSync:key=>removed.push(key),navigateBack:()=>navigations++};
 function load(url){if(cache.has(url.href))return cache.get(url.href).exports;const module={exports:{}};cache.set(url.href,module);
  runInNewContext(readFileSync(url,'utf8'),{module,exports:module.exports,wx,URL,Error,getApp:()=>app,Page:value=>page=value,require:name=>load(new URL(name+'.js',url))},{filename:url.pathname});return module.exports;}
 const api=load(new URL('../miniprogram/services/api.js',import.meta.url));
 load(new URL('../miniprogram/pages/auth/index.js',import.meta.url));page.setData=data=>Object.assign(page.data,data);
 return{api,page,app,removed,get logins(){return logins;},get navigations(){return navigations;}};
}

test('network errors preserve actionable closed codes without exposing raw URL or credential text',async()=>{
 for(const[errMsg,code]of[
  ['request:fail url not in domain list','NETWORK_DOMAIN_NOT_ENROLLED'],
  ['request:fail ssl hand shake error','NETWORK_TLS_FAILED'],
  ['request:fail certificate expired','NETWORK_TLS_FAILED'],
  ['request:fail timeout','NETWORK_TIMEOUT'],
  ['request:fail timed out','NETWORK_TIMEOUT'],
  ['request:fail unexpected https://private.host/path?secret=do-not-expose','NETWORK_UNAVAILABLE'],
  [undefined,'NETWORK_UNAVAILABLE'],
 ]){const c=client({ext:{apiBaseUrl:'https://api.product.cn'},request:o=>o.fail({errMsg})});
  await assert.rejects(c.api.publicRequest('/v1/session',{method:'GET'}),e=>e.message===code);}
});

test('original login page and API use real HTTP503, keep session cleared and expose no false successful login',async()=>{
 const received=[];const server=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({url:req.url,body:JSON.parse(body)});res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'BACKEND_NOT_CONFIGURED'}}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const c=client({ext:{apiBaseUrl:'http://127.0.0.1:'+server.address().port},request:o=>{void fetch(o.url,{method:o.method,headers:o.header,body:JSON.stringify(o.data)}).then(async r=>o.success({statusCode:r.status,data:await r.json()})).catch(o.fail);}});
  // Exact native privacy choice is still required before wx.login or HTTP.
  await c.page.login();assert.equal(c.logins,0);assert.equal(received.length,0);
  c.page.consentChanged({detail:{value:['accepted']}});await c.page.login();
  assert.equal(received.length,1);assert.equal(received[0].url,'/v1/auth/wechat/session');assert.equal(received[0].body.consentVersion,'wechat-privacy-v1');
  assert.equal(c.page.data.errorCode,'BACKEND_NOT_CONFIGURED');assert.equal(c.page.data.error,'登录服务尚未就绪，请稍后再试。');assert.equal(c.page.data.busy,false);
  assert.equal(c.app.globalData.session,null);assert.equal(c.navigations,0);assert.deepEqual(c.removed,['ltm-session','ltm-token']);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('missing development and unenrolled release configuration remain fail-closed and get truthful login messages',async()=>{
 for(const[version,ext,code]of[['develop',{},'DEVELOPMENT_API_CONFIGURATION_INVALID'],['release',{apiBaseUrl:'https://api.product.cn'},'PRODUCTION_API_ORIGIN_NOT_ENROLLED']]){
  let requests=0;const c=client({version,ext,request:()=>requests++});c.page.setData({accepted:true});await c.page.login();
  assert.equal(requests,0);assert.equal(c.page.data.errorCode,code);assert.equal(c.page.data.busy,false);assert.equal(c.navigations,0);
  assert.equal(c.page.data.error,'当前版本暂时无法连接服务，请稍后再试。');
 }
 const c=client({ext:{apiBaseUrl:'https://api.product.cn'},login:o=>o.fail({errMsg:'private-native-details'})});c.page.setData({accepted:true});await c.page.login();
 assert.equal(c.page.data.errorCode,'LOGIN_FAILED');assert.equal(c.page.data.error,'登录暂未成功，请稍后重试。');
});
