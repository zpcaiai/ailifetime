import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool } from 'pg';
import { SeedreamImageGenerator,SEEDREAM_MODEL } from '../dist/seedream.js';
import { FileTimelineArtifactStore } from '../dist/timeline-artifacts.js';
import { syntheticPng } from './timeline-fixtures.mjs';

// Real HTTP/SQL/filesystem core; only the remote model boundary emits synthetic bytes.
test('pinned Pro2K request persists before POST and reopens once without re-billing or exposing keys',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'a disposable PostgreSQL database is required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:3});
 const directory=await mkdtemp(join(tmpdir(),'seedream-')),files=new FileTimelineArtifactStore(directory);
 let requests=0,mode='success',release;
 const input={tenantId:'test-'+randomUUID(),actorId:'user',idempotencyKey:'image-1',prompt:'同一个人，37岁，真实摄影',source:syntheticPng(1),mimeType:'image/png'};
 const server=createServer(async(req,res)=>{
  requests++;const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
  assert.equal(req.headers.authorization,'Bearer synthetic-provider-key');assert.equal(body.model,SEEDREAM_MODEL);assert.equal(body.size,'2048x2048');assert.equal(body.output_format,'png');assert.equal(body.response_format,'b64_json');assert.equal(body.optimize_prompt_options.mode,'standard');assert.equal(body.watermark,true);assert.equal(body.sequential_image_generation,undefined);
  assert.match(body.image,/^data:image\/png;base64,/);
  assert.equal((await pool.query('SELECT state FROM photo_service.generations WHERE tenant_id=$1 AND idempotency_key=$2',[input.tenantId,mode==='success'?'image-1':mode])).rows[0].state,'executing');
  if(mode==='disconnect'){req.socket.destroy();return;}
  if(mode==='waiting')await new Promise(resolve=>release=resolve);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:mode==='bad-size'?'1024x1024':'2048x2048',b64_json:syntheticPng(3,2048,2048).toString('base64')}]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint={environment:'test',url:'http://127.0.0.1:'+server.address().port+'/images/generations'};
 try{
  await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));
  const make=()=>new SeedreamImageGenerator(pool,{put:i=>files.put(i.id,i.bytes,'image/png')},'synthetic-provider-key',endpoint);
  const first=await make().generate(input);assert.equal(first.asset.width,2048);assert.deepEqual(Buffer.from(await files.read(first.asset)),syntheticPng(3,2048,2048));
  assert.deepEqual(await make().generate(input),first);assert.equal(requests,1);
  await assert.rejects(make().generate({...input,prompt:'different'}),/different request/);assert.equal(requests,1);
  for(mode of ['disconnect','bad-size']){
   const next={...input,idempotencyKey:mode};await assert.rejects(make().generate(next),/RECONCILIATION_REQUIRED/);const count=requests;
   await assert.rejects(make().generate(next),/RECONCILIATION_REQUIRED/);assert.equal(requests,count);
   assert.equal((await pool.query('SELECT state FROM photo_service.generations WHERE tenant_id=$1 AND idempotency_key=$2',[input.tenantId,mode])).rows[0].state,'reconciliation_required');
  }
  mode='waiting';const pending=make().generate({...input,idempotencyKey:mode});while(!release)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(make().generate({...input,idempotencyKey:mode}),/RECONCILIATION_REQUIRED/);release();await pending;assert.equal(requests,4);
  await assert.rejects(make().generate({...input,idempotencyKey:'empty',source:Buffer.alloc(0)}),/invalid/);assert.equal(requests,4);
 }finally{release?.();await new Promise(r=>server.close(r));await pool.query('DELETE FROM photo_service.generations WHERE tenant_id=$1',[input.tenantId]);await pool.end();await rm(directory,{recursive:true,force:true});}
});
test('ordinary1536 andHD2048 bind actual HTTP bytes and durable keys; quality changes never re-bill an old key',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2}),dir=await mkdtemp(join(tmpdir(),'seedream-tiers-')),files=new FileTimelineArtifactStore(dir);
 const input={tenantId:'tiers-'+randomUUID(),actorId:'user',prompt:'同一个人，真实摄影',source:syntheticPng(1),mimeType:'image/png'};let calls=0,wrongBytes=false;
 const server=createServer(async(req,res)=>{calls++;const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.model,SEEDREAM_MODEL);assert.equal(body.optimize_prompt_options.mode,'standard');assert.ok(['1536x1536','2048x2048'].includes(body.size));const d=wrongBytes?1024:Number(body.size.split('x')[0]);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:body.size,b64_json:syntheticPng(2,d,d).toString('base64')}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const make=()=>new SeedreamImageGenerator(pool,{put:i=>files.put(i.id,i.bytes,'image/png')},'synthetic-key',{environment:'test',url:'http://127.0.0.1:'+server.address().port+'/images'});
 try{
  await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));
  for(const imageQuality of ['standard','hd']){
   const request={...input,imageQuality,idempotencyKey:imageQuality};const first=await make().generate(request);assert.equal(first.asset.width,imageQuality==='standard'?1536:2048);assert.deepEqual(await make().generate(request),first);
   await assert.rejects(make().generate({...request,imageQuality:imageQuality==='standard'?'hd':'standard'}),/different request/);
  }
  assert.equal(calls,2);for(const imageQuality of [null,'fast',[],{}])await assert.rejects(make().generate({...input,imageQuality,idempotencyKey:'invalid'}),/quality/);assert.equal(calls,2);
  wrongBytes=true;await assert.rejects(make().generate({...input,imageQuality:'standard',idempotencyKey:'wrong-bytes'}),/RECONCILIATION_REQUIRED/);assert.equal(calls,3);
 }finally{await new Promise(r=>server.close(r));await pool.query('DELETE FROM photo_service.generations WHERE tenant_id=$1',[input.tenantId]);await pool.end();await rm(dir,{recursive:true,force:true});}
});
