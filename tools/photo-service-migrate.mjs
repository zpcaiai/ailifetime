import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
const files=['001_media.sql','002_retention.sql'];
export async function migratePhotoService(connectionString,{testLoopback=false}={}) {
 const url=new URL(connectionString);
 if(!['postgres:','postgresql:'].includes(url.protocol) || !url.username || url.hash || url.searchParams.getAll('sslmode').length!==1)throw new Error('invalid photo migration database URL');
 const test=testLoopback && process.env.APP_ENV==='test' && url.hostname==='127.0.0.1' && url.searchParams.get('sslmode')==='disable';
 if(!test && url.searchParams.get('sslmode')!=='verify-full')throw new Error('photo migrations require verified TLS');
 const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,application_name:'ltm-photo-migrator'}),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ltm-photo-service:migrate:v1',0))");
  await client.query('CREATE SCHEMA IF NOT EXISTS photo_service');
  await client.query('CREATE TABLE IF NOT EXISTS photo_service.migrations (id text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  const applied=[],verified=[];
  for(const file of files){
   const sql=await readFile(new URL('../infra/photo-service/'+file,import.meta.url),'utf8'),digest=createHash('sha256').update(sql).digest('hex');
   const prior=(await client.query('SELECT sha256 FROM photo_service.migrations WHERE id=$1',[file])).rows[0];
   if(prior){if(prior.sha256!==digest)throw new Error('applied photo migration checksum changed: '+file);verified.push(file);continue;}
   await client.query(sql);await client.query('INSERT INTO photo_service.migrations (id,sha256) VALUES ($1,$2)',[file,digest]);applied.push(file);
  }
  await client.query('COMMIT');return {applied,verified};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url){
 migratePhotoService(process.env.LTM_MIGRATOR_DATABASE_URL,{testLoopback:process.argv.includes('--test-loopback')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({status:'FAIL',error:error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]')}));process.exitCode=1;});
}
