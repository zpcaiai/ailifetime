import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile,stat,access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createVercelHandler,materializeVercelConfiguration } from '../dist/vercel-handler.js';

test('Vercel materializes exact bounded documents and credentials into owner-only files and removes them on close',async()=>{
 const env={LTM_UPLOAD_BROKER_TOKEN:'synthetic-broker',LTM_PHOTO_SCORER_TOKEN:'synthetic-scorer',
  LTM_PHOTO_SCORER_POLICIES_JSON:'[{"id":"synthetic-policy"}]',LTM_CONSENT_POLICY_CATALOG_JSON:'{"syntheticUnsignedTest":true}',ARK_API_KEY:'synthetic-ark'};
 const app=await materializeVercelConfiguration(env);let directory;
 try{
  for(const [name,target] of [['LTM_UPLOAD_BROKER_TOKEN','LTM_UPLOAD_BROKER_TOKEN_FILE'],['LTM_PHOTO_SCORER_TOKEN','LTM_PHOTO_SCORER_TOKEN_FILE'],['LTM_PHOTO_SCORER_POLICIES_JSON','LTM_PHOTO_SCORER_POLICY_FILE'],['LTM_CONSENT_POLICY_CATALOG_JSON','LTM_CONSENT_POLICY_CATALOG_FILE']]){
   const path=app.environment[target];assert.equal(await readFile(path,'utf8'),env[name]);assert.equal((await stat(path)).mode&0o777,0o600);
   directory??=dirname(path);assert.equal(dirname(path),directory);assert.equal(app.environment[name],undefined);assert.equal(env[name].startsWith('synthetic')||env[name].startsWith('[')||env[name].startsWith('{'),true);
  }
  assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal(app.environment.ARK_API_KEY,env.ARK_API_KEY);
  assert.equal(env.LTM_UPLOAD_BROKER_TOKEN_FILE,undefined);
 }finally{await app.close();await app.close();}
 await assert.rejects(access(directory),{code:'ENOENT'});
});

test('Vercel refuses ambiguous, empty, malformed and oversized configuration without reflecting values',async()=>{
 for(const env of [
  {LTM_UPLOAD_BROKER_TOKEN:'synthetic',LTM_UPLOAD_BROKER_TOKEN_FILE:'/private/existing'},
  {LTM_PHOTO_SCORER_TOKEN:''},{LTM_PHOTO_SCORER_TOKEN:'x'.repeat(8193)},
  {LTM_PHOTO_SCORER_POLICIES_JSON:'not-json'},
  {LTM_CONSENT_POLICY_CATALOG_JSON:'{"invalid":'},
  {LTM_CONSENT_POLICY_CATALOG_JSON:'"'+'界'.repeat(700000)+'"'},
 ])await assert.rejects(materializeVercelConfiguration(env),{message:'CONFIGURATION_INVALID'});
 const existing=await materializeVercelConfiguration({LTM_UPLOAD_BROKER_TOKEN_FILE:'/private/operator-managed'});
 assert.equal(existing.environment.LTM_UPLOAD_BROKER_TOKEN_FILE,'/private/operator-managed');await existing.close();
});

test('Vercel HTTP entry exposes actual liveness/catalog while missing production auth stays503 and cron is protected',async()=>{
 const secret='synthetic-cron-secret-'.repeat(3),app=createVercelHandler({CRON_SECRET:secret},process.cwd());
 const server=createServer((req,res)=>void app.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  const live=await fetch(base+'/health/live');assert.equal(live.status,200);assert.equal((await live.json()).runtime,process.version);
  const catalog=await fetch(base+'/v1/photo-products');assert.equal(catalog.status,200);assert.deepEqual((await catalog.json()).data.products.map(p=>p.amountMinor),[1990,2990,2990,4990,590,990]);
  for(const path of ['/health/ready','/v1/session','/v1/auth/wechat/session']){
   const r=await fetch(base+path);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'BACKEND_NOT_CONFIGURED');
  }
  for(const headers of [{},{authorization:'Bearer wrong'},{authorization:'Bearer '+secret.slice(1)}])assert.equal((await fetch(base+'/internal/media-cleanup',{headers})).status,401);
  assert.equal((await fetch(base+'/internal/media-cleanup?limit=100',{headers:{authorization:'Bearer '+secret}})).status,400);
  assert.equal((await fetch(base+'/internal/media-cleanup',{headers:{authorization:'Bearer '+secret}})).status,503);
 }finally{await new Promise(r=>server.close(r));await app.close();}
});
