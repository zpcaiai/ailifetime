import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PostgresGeneratedMedia} from '../dist/generated-media.js';
import {drainExpiredMedia} from '../dist/media-cleanup.js';
import {syntheticPng} from './timeline-fixtures.mjs';

test('real SQL cleanup drains21 photos, preserves failed deletion for retry and honors object/time budgets',async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:3}),directory=await mkdtemp(join(tmpdir(),'cleanup-drain-'));
 const owner={tenantId:'cleanup-'+randomUUID(),actorId:'owner'},path=key=>join(directory,key.replaceAll('/','_'));
 let fail=false,delay=0;
 const objects={put:(key,bytes)=>writeFile(path(key),bytes,{flag:'wx'}),get:key=>readFile(path(key)),exists:async key=>{try{await access(path(key));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}},remove:async key=>{if(fail)throw Error('object boundary unavailable');if(delay)await new Promise(r=>setTimeout(r,delay));await rm(path(key),{force:true});}};
 const media=new PostgresGeneratedMedia(pool,objects),lock=await pool.connect();
 await lock.query("SELECT pg_advisory_lock(hashtextextended('ltm-photo-test:retention',0))");
 try{
  for(const name of ['001_media.sql','002_retention.sql'])await pool.query(await readFile(new URL('../../../infra/photo-service/'+name,import.meta.url),'utf8'));
  async function create(count,prefix){
   for(let i=0;i<count;i++)await media.put({...owner,id:prefix+i,bytes:syntheticPng(i+1),generatedAt:new Date().toISOString()});
   await pool.query("UPDATE photo_service.media SET generated_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE tenant_id=$1 AND state='ready'",[owner.tenantId]);
  }
  await create(21,'set-');
  assert.deepEqual(await drainExpiredMedia(media),{claimed:21,deleted:21,retrying:0,stopped:'empty'});
  const first=(await pool.query('SELECT object_key,state FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId])).rows;
  assert.equal(first.length,21);for(const row of first){assert.equal(row.state,'deleted');assert.equal(await objects.exists(row.object_key),false);}
  await create(1,'retry-');fail=true;
  assert.deepEqual(await drainExpiredMedia(media),{claimed:1,deleted:0,retrying:1,stopped:'empty'});
  const failed=(await pool.query("SELECT state,attempts,next_attempt_at>clock_timestamp() AS delayed FROM photo_service.media WHERE tenant_id=$1 AND asset_id='retry-0'",[owner.tenantId])).rows[0];
  assert.deepEqual(failed,{state:'deleting',attempts:1,delayed:true});fail=false;
  await pool.query('UPDATE photo_service.media SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1',[owner.tenantId]);
  assert.deepEqual(await drainExpiredMedia(media),{claimed:1,deleted:1,retrying:0,stopped:'empty'});
  await create(3,'budget-');
  assert.deepEqual(await drainExpiredMedia(media,{maximumObjects:1}),{claimed:1,deleted:1,retrying:0,stopped:'object_limit'});
  delay=20;assert.deepEqual(await drainExpiredMedia(media,{timeBudgetMs:1}),{claimed:1,deleted:1,retrying:0,stopped:'time_budget'});delay=0;
  assert.deepEqual(await drainExpiredMedia(media),{claimed:1,deleted:1,retrying:0,stopped:'empty'});
  for(const limits of [{maximumObjects:0},{maximumObjects:1001},{timeBudgetMs:0},{timeBudgetMs:150001}])await assert.rejects(drainExpiredMedia(media,limits),{code:'VALIDATION_FAILED'});
 }finally{
  await pool.query('DELETE FROM photo_service.media WHERE tenant_id=$1',[owner.tenantId]);await lock.query("SELECT pg_advisory_unlock(hashtextextended('ltm-photo-test:retention',0))");lock.release();await pool.end();await rm(directory,{recursive:true,force:true});
 }
});
