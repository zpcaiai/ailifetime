import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createVercelHandler} from '../dist/vercel-handler.js';

test('ordinary API boot rejects an incomplete Pro deployment before opening a listener or logging secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seedream-boot-'));
 const child=spawn(process.execPath,[new URL('../dist/main.js',import.meta.url).pathname],{env:{PATH:process.env.PATH,APP_ENV:'local',LTM_DEPLOYMENT_PROFILE:'single-node',LTM_DATABASE_PATH:join(dir,'runtime.sqlite'),LTM_AUTH_MODE:'local-synthetic-only',LTM_ALLOW_LEGACY_CONSENT_POLICY:'true',LTM_SEEDREAM_ENABLED:'true',ARK_API_KEY:'synthetic-secret-must-not-appear',LTM_STATIC_DIR:'disabled'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 try{const [code]=await once(child,'close');assert.equal(code,1);assert.match(output,/server.start_failed/);assert.match(output,/CONFIGURATION_INVALID/);assert.doesNotMatch(output,/synthetic-secret-must-not-appear|server.started/);}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('Vercel does not expose generation through catalog/liveness or bypass production configuration',async()=>{
 const app=createVercelHandler({LTM_SEEDREAM_ENABLED:'true',ARK_API_KEY:'synthetic-vercel-key'},process.cwd());
 const server=createServer((req,res)=>void app.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/health/live')).status,200);assert.equal((await fetch(base+'/v1/photo-products')).status,200);
  const r=await fetch(base+'/v1/timelines/root/generate',{method:'POST',headers:{'content-type':'application/json'},body:'{"targetAge":37}'});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/synthetic-vercel-key/);
 }finally{await new Promise(r=>server.close(r));await app.close();}
});
