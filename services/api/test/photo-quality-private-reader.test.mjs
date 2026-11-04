import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PostgresGeneratedMedia} from '../dist/generated-media.js';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';

test('private PostgreSQL media scoring uses the trusted B14 owner, not the service caller; fresh service instances preserve bindings',()=>withPhotoFixture(async f=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL is required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:3});
 const directory=await mkdtemp(join(tmpdir(),'quality-private-reader-'));
 const file=k=>join(directory,encodeURIComponent(k));
 const objects={put:(k,b)=>writeFile(file(k),b,{flag:'wx'}),get:async(k,max)=>{const b=await readFile(file(k));assert.ok(b.length<=max);return b;},remove:k=>rm(file(k),{force:true}),exists:async k=>{try{await access(file(k));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}};
 const owner={tenantId:f.actor.tenantId,actorId:f.actor.actorId},id='private-candidate-'+randomUUID();
 assert.notEqual(f.service.actorId,owner.actorId);
 const key='canonical-'+randomUUID();
 try {
  for(const name of ['001_media.sql','002_retention.sql'])await pool.query(await readFile(new URL('../../../infra/photo-service/'+name,import.meta.url),'utf8'));
  // The trusted B07 fixture has accepted this canonical JPEG. Register its private
  // object in the actual SQL journal; this does not claim a production upload adapter.
  await objects.put(key,f.sourceBytes);
  const at=new Date().toISOString();
  await pool.query("INSERT INTO photo_service.media (tenant_id,actor_id,asset_id,asset,object_key,generated_at,expires_at,state) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz,$6::timestamptz+interval '720 hours','ready')",[owner.tenantId,owner.actorId,f.sourceAsset.id,JSON.stringify(f.sourceAsset),key,at]);
  const local=await f.asset(id,23),bytes=await f.store.read(local);
  const media=new PostgresGeneratedMedia(pool,objects),asset=await media.put({...owner,id,bytes,generatedAt:at});
  for(const actor of [undefined,f.service,{...owner,tenantId:'other-tenant'},{...owner,actorId:'other-owner'}])await assert.rejects(media.read(asset,actor));
  const qualityId=photoQualityId(owner.tenantId,'root',37,asset.sha256,f.sourceAsset.sha256,f.policy);await f.grantQuality(qualityId);
  const service=()=>new TimelinePhotoQualityService(f.runtime,f.registry,new PostgresGeneratedMedia(pool,objects),new HttpPhotoScorer(f.scorerOptions),[f.policy],'wechat');
  await assert.rejects(service().evaluate(f.actor,'root',37,asset),/service account/);assert.equal(f.seen.length,0);
  const result=await service().evaluate(f.service,'root',37,asset);assert.equal(result.decision,'pass');assert.equal(f.seen.length,1);
  assert.equal((await service().evaluate(f.service,'root',37,asset)).reused,true);assert.equal(f.seen.length,1);
  const record=f.runtime.getRecord(f.service,'media.quality-decisions',qualityId);
  assert.equal(record.data.artifactBinding.outputSha256,asset.sha256);assert.equal(record.data.photoScoreEvidence.sourceSha256,f.sourceAsset.sha256);
  assert.deepEqual(Buffer.from(await media.read(asset,owner)),Buffer.from(bytes));
 } finally {
  await pool.query('DELETE FROM photo_service.media WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=ANY($3::text[])',[owner.tenantId,owner.actorId,[f.sourceAsset.id,id]]);
  await pool.end();await rm(directory,{recursive:true,force:true});
 }
}));
