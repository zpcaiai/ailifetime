import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePhotoService } from './photo-service-migrate.mjs';
test('real PostgreSQL photo migrations commit atomically, replay verified checksums, and reject altered history',async()=>{
 const base=process.env.LTM_PHOTO_TEST_POSTGRES_URL;assert.ok(base,'a disposable PostgreSQL database is required');
 const url=new URL(base);url.searchParams.set('sslmode','disable');const connectionString=url.href;
 const first=await migratePhotoService(connectionString,{testLoopback:true});assert.deepEqual(first.applied,['001_media.sql','002_retention.sql']);
 assert.deepEqual(await migratePhotoService(connectionString,{testLoopback:true}),{applied:[],verified:['001_media.sql','002_retention.sql']});
 const pool=new Pool({connectionString,max:1});let original;
 try{
  original=(await pool.query("SELECT sha256 FROM photo_service.migrations WHERE id='001_media.sql'")).rows[0].sha256;
  await pool.query("UPDATE photo_service.migrations SET sha256=$1 WHERE id='001_media.sql'",['0'.repeat(64)]);
  await assert.rejects(migratePhotoService(connectionString,{testLoopback:true}),/checksum changed/);
 }finally{if(original)await pool.query("UPDATE photo_service.migrations SET sha256=$1 WHERE id='001_media.sql'",[original]);await pool.query('DELETE FROM photo_service.migrations');await pool.end();}
 await assert.rejects(migratePhotoService(connectionString),/verified TLS/);
});
