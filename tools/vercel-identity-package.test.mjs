import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readdir,readFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {packageWechatIdentity} from './vercel-identity-package.mjs';
test('actual isolated identity bundle serves real HTTP and refuses missing production credentials without private files',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'identity-artifact-'));let server;
 try{
  const output=join(directory,'artifact'),result=await packageWechatIdentity(output);
  assert.equal(result.files.length,3);assert.ok(result.files.every(f=>f.bytes>0&&f.sha256.length===64));
  assert.deepEqual((await readdir(output)).sort(),['api','package.json','vercel.json']);
  const config=JSON.parse(await readFile(join(output,'vercel.json'),'utf8'));assert.equal(config.crons,undefined);assert.deepEqual(config.regions,['sin1']);assert.equal(config.functions['api/index.mjs'].maxDuration,30);
  const pkg=JSON.parse(await readFile(join(output,'package.json'),'utf8'));assert.deepEqual(Object.keys(pkg.dependencies).sort(),['jose','pg']);assert.equal(pkg.engines.node,'26.x');
  await symlink(fileURLToPath(new URL('../services/api/node_modules',import.meta.url)),join(output,'node_modules'));
  const {default:handler}=await import(pathToFileURL(join(output,'api/index.mjs')).href);
  server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/wechat/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'IDENTITY_NOT_CONFIGURED'}});assert.equal(response.headers.get('cache-control'),'private, no-store');
  await t.test('XHS-only preview serves public JWKS and keeps login closed without an RMP access token',async()=>{
   const signingKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});
   const configuration={
    APP_ENV:'test',DATABASE_URL:'postgresql://fixture@127.0.0.1:1/ltm_identity_test',
    LTM_XHS_APP_ID:'1234567890abcdef12345678',LTM_XHS_IDENTITY_CONSENT_VERSION:'xhs-privacy-v1',
    LTM_IDENTITY_ISSUER:'https://identity.preview.example.cn',LTM_IDENTITY_AUDIENCE:'ailifetime-api',
    LTM_IDENTITY_SIGNING_JWK:JSON.stringify(signingKey),
    LTM_IDENTITY_ENCRYPTION_KEY:randomBytes(32).toString('base64url'),
    LTM_IDENTITY_WORKLOAD_TOKEN_SHA256:randomBytes(32).toString('hex'),
    LTM_WECHAT_APP_ID:undefined,LTM_XHS_RMP_ACCESS_TOKEN:undefined,
   };
   const prior=Object.fromEntries(Object.keys(configuration).map(name=>[name,process.env[name]]));
   const apply=entries=>{for(const [name,value] of Object.entries(entries)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
   }};
   apply(configuration);
   try{
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal((await fetch(base+'/health/live')).status,200);
    const keys=await fetch(base+'/.well-known/jwks.json');
    assert.equal(keys.status,200);
    const {keys:[key]}=await keys.json();
    assert.equal(key.alg,'ES256');assert.equal(key.x,signingKey.x);assert.equal(key.y,signingKey.y);
    assert.equal(key.d,undefined);assert.equal(typeof key.kid,'string');
    assert.equal((await fetch(base+'/health/ready')).status,401);
    const denied=await fetch(base+'/v1/mini-program/sessions',{method:'POST',
     headers:{'content-type':'application/json','idempotency-key':'synthetic-idempotency'},
     body:JSON.stringify({platform:'mp-xhs',js_code:'synthetic-code'})});
    assert.equal(denied.status,503);
    assert.deepEqual(await denied.json(),{error:{code:'XHS_APP_ACCESS_TOKEN_UNAVAILABLE'}});
   }finally{apply(prior);}
  });
  await assert.rejects(packageWechatIdentity(output),/EEXIST/);await assert.rejects(packageWechatIdentity(fileURLToPath(new URL('../new-artifact',import.meta.url))),/isolated/);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
