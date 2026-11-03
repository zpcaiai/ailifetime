import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Pool } from 'pg';
import { readFile,writeFile,mkdtemp,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer,StaticTokenAuthenticator } from '../dist/index.js';
import { PostgresGeneratedMedia } from '../dist/generated-media.js';
import { timelineFixture,syntheticPng } from './timeline-fixtures.mjs';

test('signed accepted image streams exact private bytes through HTTP and becomes404 at database expiry before cleanup',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL is required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2}),dir=await mkdtemp(join(tmpdir(),'media-http-'));
 const f=await timelineFixture(':memory:',{targetAges:[37]});let server;
 const path=k=>join(dir,k.replaceAll('/','_'));
 const objects={put:(k,b)=>writeFile(path(k),b),get:k=>readFile(path(k)),remove:k=>rm(path(k),{force:true}),exists:async k=>{try{await access(path(k));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}};
 const media=new PostgresGeneratedMedia(pool,objects);
 const lock=await pool.connect();await lock.query("SELECT pg_advisory_lock(hashtextextended('ltm-photo-test:retention',0))");
 try{
  for(const file of ['001_media.sql','002_retention.sql'])await pool.query(await readFile(new URL('../../../infra/photo-service/'+file,import.meta.url),'utf8'));
  const bytes=syntheticPng(10,2048,2048),asset=await media.put({tenantId:'tenant',actorId:'user',id:'http-photo-'+Date.now(),bytes,generatedAt:new Date().toISOString()});
  const node=await f.readyNode(asset,37);f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',{schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[node]}));
  server=createApiServer({runtime:f.runtime,capabilityRegistry:f.registry,timelineArtifacts:media,appEnvironment:'test',staticDirectory:null,authenticator:new StaticTokenAuthenticator([{token:'private-photo-owner-token',actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}])});
  server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port+'/v1/timelines/root/nodes/37/image',headers={authorization:'Bearer private-photo-owner-token','x-purpose':'age_transformation'};
  assert.equal((await fetch(url)).status,401);
  let response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('transfer-encoding'),'chunked');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await pool.query("UPDATE photo_service.media SET generated_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE tenant_id='tenant' AND actor_id='user' AND asset_id=$1",[asset.id]);
  response=await fetch(url,{headers});assert.equal(response.status,404);assert.equal((await response.json()).error.code,'RESOURCE_NOT_FOUND');
  assert.deepEqual(await media.cleanup(),{claimed:1,deleted:1,retrying:0});
 }finally{if(server)await new Promise(r=>server.close(r));f.runtime.close();await pool.query("DELETE FROM photo_service.media WHERE tenant_id='tenant' AND actor_id='user'");await lock.query("SELECT pg_advisory_unlock(hashtextextended('ltm-photo-test:retention',0))");lock.release();await pool.end();await rm(dir,{recursive:true,force:true});}
});
