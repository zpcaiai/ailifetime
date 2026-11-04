import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {QUALITY_CONTROLS} from '@ltm/core';
import {SeedreamImageGenerator,SEEDREAM_MODEL} from '../dist/seedream.js';
import {TimelineSeedreamService} from '../dist/timeline-seedream.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {syntheticPng} from './timeline-fixtures.mjs';
import {governancePolicy} from './photo-quality-v2-fixtures.mjs';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
for(const phase of ['before-read','before-submit','response'])test(`quality latch prevents model egress or candidate return at ${phase}`,async()=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL);
 await withPhotoFixture(async f=>{
  const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2});await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));
  const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime),control=await g.control(f.service,p);let calls=0,reads=0;
  const latch=()=>f.runtime.updateRecord(f.service,{collection:QUALITY_CONTROLS,id:control.id,expectedVersion:control.version,data:{...control.data,state:'stopped'},idempotencyKey:'latch-'+phase});
  const provider=createServer(async(req,res)=>{for await(const part of req){}calls++;if(phase==='response')await latch();res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:'2048x2048',b64_json:syntheticPng(17,2048,2048).toString('base64')}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const generator=new SeedreamImageGenerator(pool,{put:i=>f.store.put(i.id,i.bytes,'image/png')},'synthetic-local-latch-boundary',{environment:'test',url:'http://127.0.0.1:'+provider.address().port+'/images'});
  if(phase==='before-submit'){
   // Instrument only the existing hook, preserving real SQL claim, adapter and HTTP transport.
   const generate=generator.generate.bind(generator);generator.generate=input=>generate({...input,beforeSubmit:async()=>{await latch();await input.beforeSubmit();}});
  }
  const source={read:async(...args)=>{reads++;return f.store.read(...args);}},service=new TimelineSeedreamService(f.runtime,source,f.store,generator);
  try{
   if(phase==='before-read')await latch();await assert.rejects(service.generate(f.service,'root',37));assert.equal(calls,phase==='response'?1:0);if(phase==='before-read')assert.equal(reads,0);
   assert.equal(f.runtime.getRecord(f.service,'generation.timeline-commands','root').data.resultManifest,undefined);
   const rows=(await pool.query("SELECT state FROM photo_service.generations WHERE tenant_id=$1 AND actor_id='user' AND idempotency_key='timeline:root:age:37'",[f.actor.tenantId])).rows;
   assert.deepEqual(rows.map(r=>r.state),phase==='before-read'?[]:[{state:phase==='response'?'succeeded':'reconciliation_required'}].map(r=>r.state));
   await assert.rejects(service.generate(f.service,'root',37),{code:'PROCESSING_RESTRICTED'});assert.equal(calls,phase==='response'?1:0);
  }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));await pool.query('DELETE FROM photo_service.generations WHERE tenant_id=$1',[f.actor.tenantId]);await pool.end();}
 },{tenantId:'generation-latch-'+randomUUID()});
});
