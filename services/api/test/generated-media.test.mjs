import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile,writeFile,mkdtemp,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresGeneratedMedia } from '../dist/generated-media.js';
import { syntheticPng } from './timeline-fixtures.mjs';
import { PHOTO_PRODUCTS } from '../dist/photo-catalog.js';

test('real PostgreSQL journal: immutable30day expiry, owner isolation, failed deletion recovery and fenced concurrent cleanup',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL is required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:4}),dir=await mkdtemp(join(tmpdir(),'private-media-'));
 // Real files are the object-store boundary; deletion/absence are verified on disk.
 let deleteFailure=false,retain=false,reads=0,release,paused=false;
 const path=k=>join(dir,k.replaceAll('/','_'));
 const objects={put:(k,b)=>writeFile(path(k),b,{flag:'wx'}),get:async k=>{reads++;return readFile(path(k));},exists:async k=>{try{await access(path(k));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}},remove:async k=>{if(deleteFailure)throw new Error('object service offline');if(paused)await new Promise(r=>release=r);if(!retain)await rm(path(k),{force:true});}};
 const media=()=>new PostgresGeneratedMedia(pool,objects),owner={tenantId:'media-'+randomUUID(),actorId:'owner'};
 const input={...owner,id:'photo-original',bytes:syntheticPng(1),generatedAt:new Date().toISOString()};
 const lock=await pool.connect();await lock.query("SELECT pg_advisory_lock(hashtextextended('ltm-photo-test:retention',0))");
 try{
  await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../../../infra/photo-service/002_retention.sql',import.meta.url),'utf8'));
  const asset=await media().put(input);assert.deepEqual(Buffer.from(await media().read(asset,owner)),input.bytes);
  const row=(await pool.query('SELECT * FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId])).rows[0];
  assert.equal(new Date(row.expires_at)-new Date(row.generated_at),30*24*60*60*1000);
  assert.deepEqual(await media().put(input),asset);
  await assert.rejects(media().put({...input,generatedAt:new Date(Date.now()+1000).toISOString()}),/reused/);
  const before=reads;for(const actor of [undefined,{...owner,actorId:'attacker'},{...owner,tenantId:'other'}])await assert.rejects(media().read(asset,actor));assert.equal(reads,before);
  assert.deepEqual(await media().cleanup(),{claimed:0,deleted:0,retrying:0});
  const expired=(await pool.query("UPDATE photo_service.media SET generated_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE tenant_id=$1 RETURNING generated_at",[owner.tenantId])).rows[0];
  await assert.rejects(media().read(asset,owner),/expired/);assert.equal(reads,before);
  deleteFailure=true;assert.deepEqual(await media().cleanup(),{claimed:1,deleted:0,retrying:1});assert.equal(await objects.exists(row.object_key),true);
  assert.equal((await pool.query('SELECT state FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId])).rows[0].state,'deleting');
  assert.deepEqual(await media().cleanup(),{claimed:0,deleted:0,retrying:0});
  deleteFailure=false;retain=true;await pool.query('UPDATE photo_service.media SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1',[owner.tenantId]);
  assert.deepEqual(await media().cleanup(),{claimed:1,deleted:0,retrying:1});
  retain=false;paused=true;await pool.query('UPDATE photo_service.media SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1',[owner.tenantId]);
  const first=media().cleanup();while(!release)await new Promise(r=>setTimeout(r,5));assert.deepEqual(await media().cleanup(),{claimed:0,deleted:0,retrying:0});
  release();assert.deepEqual(await first,{claimed:1,deleted:1,retrying:0});assert.equal(await objects.exists(row.object_key),false);
  await assert.rejects(media().put(input),{code:'VERSION_CONFLICT'});
  await assert.rejects(media().put({...input,generatedAt:new Date(expired.generated_at).toISOString()}),/expired|deleted/);await assert.rejects(media().read(asset,owner));
  const final=(await pool.query('SELECT * FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId])).rows[0];assert.equal(final.state,'deleted');assert.ok(final.deleted_at);assert.equal(final.attempts,3);
  // A restarted worker reclaims a dead lease and removes every derivative,
  // even when a small batch leaves part of the expired set for the next cycle.
  paused=false;
  const derivatives=[];for(const id of ['thumbnail','preview'])derivatives.push(await media().put({...input,id,bytes:syntheticPng(id==='thumbnail'?2:3)}));
  await pool.query("UPDATE photo_service.media SET generated_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour',state='deleting',lease_until=statement_timestamp()-interval '1 minute',fence=$2,attempts=1 WHERE tenant_id=$1 AND state='ready'",[owner.tenantId,randomUUID()]);
  assert.deepEqual(await media().cleanup(1),{claimed:1,deleted:1,retrying:0});assert.deepEqual(await media().cleanup(1),{claimed:1,deleted:1,retrying:0});
  for(const derived of derivatives){const row=(await pool.query('SELECT object_key,state,attempts FROM photo_service.media WHERE tenant_id=$1 AND asset_id=$2',[owner.tenantId,derived.id])).rows[0];assert.equal(row.state,'deleted');assert.equal(row.attempts,2);assert.equal(await objects.exists(row.object_key),false);}
 }finally{release?.();await pool.query('DELETE FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId]);await lock.query("SELECT pg_advisory_unlock(hashtextextended('ltm-photo-test:retention',0))");lock.release();await pool.end();await rm(dir,{recursive:true,force:true});}
});
test('all four actual catalog tiers expire after720hours and delete exact private objects without changing quote retention',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL);const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2}),dir=await mkdtemp(join(tmpdir(),'tier-retention-')),owner={tenantId:'four-retention-'+randomUUID(),actorId:'owner'};
 const lock=await pool.connect();await lock.query("SELECT pg_advisory_lock(hashtextextended('ltm-photo-test:retention',0))");
 const path=k=>join(dir,k.replaceAll('/','_')),objects={put:(k,b)=>writeFile(path(k),b),get:k=>readFile(path(k)),remove:k=>rm(path(k),{force:true}),exists:async k=>{try{await access(path(k));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}};
 const media=new PostgresGeneratedMedia(pool,objects);
 try{
  for(const name of ['001_media.sql','002_retention.sql'])await pool.query(await readFile(new URL('../../../infra/photo-service/'+name,import.meta.url),'utf8'));
  const assets=[];
  for(const product of PHOTO_PRODUCTS.filter(p=>p.sku.startsWith('lifespan-'))){
   assert.equal(product.retentionDays,30);const asset=await media.put({...owner,id:product.sku,generatedAt:new Date().toISOString(),bytes:syntheticPng(assets.length+1,product.imageWidth,product.imageHeight)});assets.push(asset);
   const row=(await pool.query('SELECT generated_at,expires_at FROM photo_service.media WHERE tenant_id=$1 AND asset_id=$2',[owner.tenantId,asset.id])).rows[0];assert.equal(new Date(row.expires_at)-new Date(row.generated_at),720*60*60*1000);assert.equal((await media.read(asset,owner)).byteLength,asset.byteLength);
  }
  assert.equal(assets.length,4);await pool.query("UPDATE photo_service.media SET generated_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE tenant_id=$1",[owner.tenantId]);
  for(const asset of assets)await assert.rejects(media.read(asset,owner),/expired/);
  assert.deepEqual(await media.cleanup(),{claimed:4,deleted:4,retrying:0});for(const row of (await pool.query('SELECT * FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId])).rows){assert.equal(row.state,'deleted');assert.equal(await objects.exists(row.object_key),false);}
 }finally{await pool.query('DELETE FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId]);await lock.query("SELECT pg_advisory_unlock(hashtextextended('ltm-photo-test:retention',0))");lock.release();await pool.end();await rm(dir,{recursive:true,force:true});}
});
