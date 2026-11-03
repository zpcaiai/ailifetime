import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,jwtVerify} from 'jose';
import {Pool} from 'pg';
import {WechatIdentityAuthority} from '../dist/wechat-identity.js';
import {HttpWechatIdentityBroker} from '../dist/client-integrations.js';
import {OidcAuthenticator} from '../dist/oidc-auth.js';

const hash=v=>createHash('sha256').update(v).digest('hex');
let admin,privateJwk,dir;
before(async()=>{
 const url=process.env.LTM_IDENTITY_TEST_POSTGRES_ADMIN_URL;assert.ok(url,'a dedicated real PostgreSQL test database is required');
 const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/ltm_identity_test');
 admin=new Pool({connectionString:url,max:2});
 await admin.query('DROP SCHEMA IF EXISTS wechat_identity CASCADE');
 await admin.query(await readFile(new URL('../../../infra/wechat-identity/001_identity.sql',import.meta.url),'utf8'));
 await admin.query('GRANT USAGE ON SCHEMA wechat_identity TO ltm_identity_test_runtime');
 await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA wechat_identity TO ltm_identity_test_runtime');
 privateJwk=await exportJWK((await generateKeyPair('ES256',{extractable:true})).privateKey);
 dir=await mkdtemp(join(tmpdir(),'identity-wire-'));
});
after(async()=>{await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});});

async function fixture(){
 const appId='wx'+randomBytes(8).toString('hex'),workload='synthetic-workload-'+randomBytes(24).toString('hex');
 const env={APP_ENV:'test',DATABASE_URL:process.env.LTM_IDENTITY_TEST_POSTGRES_URL,LTM_WECHAT_APP_ID:appId,
  LTM_WECHAT_APP_SECRET:'synthetic-wechat-app-secret',LTM_IDENTITY_WORKLOAD_TOKEN_SHA256:hash(workload),
  LTM_IDENTITY_ISSUER:'https://identity.example.test',LTM_IDENTITY_AUDIENCE:'ailifetime-api',LTM_IDENTITY_CONSENT_VERSION:'wechat-privacy-v1',
  LTM_IDENTITY_SIGNING_JWK:JSON.stringify(privateJwk),LTM_IDENTITY_ENCRYPTION_KEY:randomBytes(32).toString('base64url')};
 let calls=0,mode='valid',hold;
 const provider=createServer(async(req,res)=>{
  calls++;const u=new URL(req.url,'http://127.0.0.1');assert.equal(u.pathname,'/sns/jscode2session');
  assert.equal(u.searchParams.get('appid'),appId);assert.equal(u.searchParams.get('secret'),'synthetic-wechat-app-secret');assert.equal(u.searchParams.get('grant_type'),'authorization_code');
  const claimed=await admin.query('SELECT state FROM wechat_identity.requests WHERE app_id=$1 AND code_hash=$2',[appId,hash(u.searchParams.get('js_code'))]);
  assert.equal(claimed.rows[0].state,'executing','real SQL intent must commit before external exchange');
  if(mode==='hold')await new Promise(r=>hold=r);
  if(mode==='disconnect'){req.socket.destroy();return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(mode==='invalid'?{errcode:40029,errmsg:'synthetic invalid code'}:mode==='huge'?{padding:'x'.repeat(20000)}:
   {openid:'synthetic-openid-user-A',session_key:Buffer.alloc(16,9).toString('base64')}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const endpoint='http://127.0.0.1:'+provider.address().port;
 let authority=new WechatIdentityAuthority(env,endpoint);
 const server=createServer((req,res)=>void authority.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,body,key='key-'+randomBytes(8).toString('hex'),extra={})=>{
  const r=await fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+workload,'content-type':'application/json','idempotency-key':key,...extra},body:JSON.stringify(body)});
  const text=await r.text();return {status:r.status,headers:r.headers,body:text?JSON.parse(text):null};
 };
 const login=(code='code-'+randomBytes(8).toString('hex'))=>({code,consentVersion:'wechat-privacy-v1',clientRequestId:'client-request-0001'});
 return {env,base,request,login,workload,appId,get authority(){return authority;},get calls(){return calls;},setMode:v=>mode=v,
  release:()=>hold?.(),reopen:async()=>{await authority.close();authority=new WechatIdentityAuthority(env,endpoint);},
  close:async()=>{hold?.();await new Promise(r=>server.close(r));await authority.close();await new Promise(r=>provider.close(r));}
 };
}

// Core is real Node HTTP + SQL + JOSE + AES. Only the remote WeChat boundary is
// synthetic; these tests never establish actual WeChat or real-phone acceptance.
test('actual HTTP/SQL issuer recovers immutable session, verifies API JWT, rotates refresh and revokes family',async()=>{
 const f=await fixture();try{
  f.env.LTM_WECHAT_APP_SECRET=' \nsynthetic-wechat-app-secret\n ';
  const body=f.login(),first=await f.request('/v1/wechat/sessions',body,'create-key');assert.equal(first.status,200);
  assert.equal(first.headers.get('cache-control'),'private, no-store');assert.deepEqual(first.body.session.roles,['consumer']);
  const {accessToken:token,actorId,tenantId}=first.body.session;assert.notEqual(actorId,tenantId);
  assert.ok(Date.parse(first.body.session.expiresAt)>Date.now());assert.ok(Date.parse(first.body.session.expiresAt)<=Date.now()+300000);
  const jwks=await(await fetch(f.base+'/.well-known/jwks.json')).json();assert.equal(jwks.keys.length,1);assert.equal(jwks.keys[0].d,undefined);
  const verified=await jwtVerify(token,createLocalJWKSet(jwks),{issuer:f.env.LTM_IDENTITY_ISSUER,audience:'ailifetime-api',typ:'at+jwt',algorithms:['ES256']});
  assert.equal(verified.payload.sub,actorId);assert.equal(verified.payload.tenant_id,tenantId);assert.deepEqual(verified.payload.roles,['consumer']);
  assert.equal(JSON.stringify(verified.payload).includes('openid'),false);assert.equal(JSON.stringify(verified.payload).includes('session_key'),false);
  const authenticator=new OidcAuthenticator({issuer:f.env.LTM_IDENTITY_ISSUER,audience:'ailifetime-api',jwksUrl:new URL(f.env.LTM_IDENTITY_ISSUER+'/.well-known/jwks.json'),algorithms:['ES256']},createLocalJWKSet(jwks));
  assert.equal((await authenticator.authenticate({authorization:'Bearer '+token,purpose:'commerce',requestId:'actual-oidc-test'})).actorId,actorId);
  await assert.rejects(authenticator.authenticate({authorization:'Bearer '+token,purpose:'platform_architecture',requestId:'actual-oidc-test'}),/purpose/);
  await f.reopen();assert.deepEqual((await f.request('/v1/wechat/sessions',body,'create-key')).body,first.body);assert.equal(f.calls,1);
  assert.equal((await f.request('/v1/wechat/sessions',{...body,clientRequestId:'another-client'},'create-key')).status,409);
  assert.equal((await f.request('/v1/wechat/sessions',body,'new-key-same-code')).status,409);assert.equal(f.calls,1);
  const stored=(await admin.query('SELECT * FROM wechat_identity.sessions WHERE app_id=$1',[f.appId])).rows[0];
  assert.equal(stored.token_hash,hash(token));assert.ok(stored.provider_cipher);assert.equal(stored.provider_cipher.includes('synthetic-openid'),false);
  assert.equal(JSON.stringify((await admin.query('SELECT * FROM wechat_identity.requests WHERE app_id=$1',[f.appId])).rows).includes(token),false);
  const headers={'x-ltm-subject-token':token};
  const [r1,r2]=await Promise.all([f.request('/v1/wechat/sessions/refresh',{},'refresh-key',headers),f.request('/v1/wechat/sessions/refresh',{},'refresh-key',headers)]);
  assert.equal(r1.status,200);assert.deepEqual(r1.body,r2.body);const refreshed=r1.body.session.accessToken;assert.notEqual(refreshed,token);
  assert.equal((await f.request('/v1/wechat/sessions/refresh',{},'other-refresh',headers)).status,401);
  assert.equal((await f.request('/v1/wechat/sessions/revoke',{},'logout-key',{'x-ltm-subject-token':refreshed})).status,204);
  assert.equal((await f.request('/v1/wechat/sessions/revoke',{},'logout-key',{'x-ltm-subject-token':refreshed})).status,204);
  assert.equal((await f.request('/v1/wechat/sessions/refresh',{},'after-logout',{'x-ltm-subject-token':refreshed})).status,401);
  assert.equal((await f.request('/v1/wechat/sessions',body,'create-key')).status,409);
  assert.equal((await f.request('/v1/wechat/sessions/refresh',{},'refresh-key',headers)).status,409);
  const rows=(await admin.query('SELECT state,provider_cipher FROM wechat_identity.sessions WHERE app_id=$1',[f.appId])).rows;
  assert.ok(rows.every(r=>r.state==='revoked'&&r.provider_cipher===null));
 }finally{await f.close();}
});
test('real API broker wire format and app-scoped FORCE RLS isolate identity data',async()=>{
 const f=await fixture();try{
  const file=join(dir,f.appId);await writeFile(file,f.workload,{mode:0o600});
  const broker=new HttpWechatIdentityBroker({baseUrl:f.base,workloadTokenFile:file,allowInsecureLoopback:true});
  const a=await broker.createSession({...f.login(),idempotencyKey:'wire-create',requestId:'wire-request'});
  assert.equal((await broker.readiness()).ready,true);assert.equal(a.session.purpose,'age_transformation');
  const b=await broker.refreshSession({accessToken:a.session.accessToken,idempotencyKey:'wire-refresh',requestId:'wire-request'});assert.equal(a.session.actorId,b.session.actorId);
  await broker.revokeSession({accessToken:b.session.accessToken,idempotencyKey:'wire-revoke',requestId:'wire-request'});
  const runtime=new Pool({connectionString:f.env.DATABASE_URL,max:1});try{
   assert.equal((await runtime.query('SELECT * FROM wechat_identity.users')).rowCount,0);
   await assert.rejects(runtime.query("INSERT INTO wechat_identity.users VALUES($1,$2,$3,$4,clock_timestamp())",[f.appId,'0'.repeat(64),a.session.actorId,a.session.tenantId]),/row-level security/);
   await runtime.query('BEGIN');await runtime.query("SELECT set_config('ltm_identity.app_id',$1,true)",['wx0000000000000000']);
   assert.equal((await runtime.query('SELECT * FROM wechat_identity.users')).rowCount,0);await runtime.query('ROLLBACK');
  }finally{await runtime.end();}
 }finally{await f.close();}
});
test('untrusted HTTP inputs cannot choose principals or cause external exchange; missing secret stays503',async()=>{
 const f=await fixture();try{
  for(const [body,status,extra] of [[{...f.login(),actorId:'administrator'},400,{}],[{...f.login(),consentVersion:'unknown'},403,{}],[f.login(),401,{authorization:'Bearer wrong'}],[{...f.login(),code:'x'.repeat(9000)},413,{}]]){
   assert.equal((await f.request('/v1/wechat/sessions',body,undefined,extra)).status,status);
  }assert.equal(f.calls,0);
  assert.equal((await fetch(f.base+'/.well-known/jwks.json?leak=1')).status,400);
  delete f.env.LTM_WECHAT_APP_SECRET;
  assert.equal((await fetch(f.base+'/health/ready',{headers:{authorization:'Bearer '+f.workload}})).status,503);
  assert.equal((await f.request('/v1/wechat/sessions',f.login())).body.error.code,'WECHAT_APP_SECRET_MISSING');assert.equal(f.calls,0);
  f.env.LTM_WECHAT_APP_SECRET='synthetic invalid secret';
  assert.equal((await f.request('/v1/wechat/sessions',f.login())).body.error.code,'WECHAT_APP_SECRET_FORMAT_INVALID');assert.equal(f.calls,0);
  assert.throws(()=>new WechatIdentityAuthority({...f.env,APP_ENV:'production'},'http://127.0.0.1:1234'),/IDENTITY_NOT_CONFIGURED/);
 }finally{await f.close();}
});
test('invalid, oversized and uncertain WeChat responses never create sessions or re-exchange a claimed code',async()=>{
 const f=await fixture();try{
  for(const mode of ['invalid','huge','disconnect']){
   f.setMode(mode);const body=f.login(),key='request-'+mode,calls=f.calls;
   const result=await f.request('/v1/wechat/sessions',body,key);assert.ok([401,502,503].includes(result.status));
   assert.equal((await f.request('/v1/wechat/sessions',body,key)).status,409);assert.equal(f.calls,calls+1);
   assert.equal(JSON.stringify(result).includes(f.env.LTM_WECHAT_APP_SECRET),false);
  }assert.equal((await admin.query('SELECT * FROM wechat_identity.sessions WHERE app_id=$1',[f.appId])).rowCount,0);
 }finally{await f.close();}
});
test('concurrent requests exchange a one-time code once and preserve durable uncertain execution',async()=>{
 const f=await fixture();try{
  f.setMode('hold');const body=f.login(),pending=f.request('/v1/wechat/sessions',body,'concurrent-key');
  for(let i=0;i<100&&f.calls===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.calls,1);
  assert.equal((await f.request('/v1/wechat/sessions',body,'concurrent-key')).status,409);
  f.release();assert.equal((await pending).status,200);assert.equal(f.calls,1);
 }finally{await f.close();}
});
