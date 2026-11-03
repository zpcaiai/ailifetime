import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {SeedreamImageGenerator,SEEDREAM_MODEL} from '../dist/seedream.js';
import {TimelineSeedreamService} from '../dist/timeline-seedream.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {syntheticPng} from './timeline-fixtures.mjs';

// Real application/consent/SQLite + PostgreSQL + HTTP + file bytes. Only Ark is a synthetic remote boundary.
export async function withSeedreamFixture(run,options={}) {
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL required');
 return withPhotoFixture(async f=>{
  const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2});
  await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));
  const ownRows="tenant_id='tenant' AND actor_id='user' AND (idempotency_key LIKE 'timeline:root:age:%' OR idempotency_key LIKE 'timeline:wardrobe:age:%')";
  await pool.query('DELETE FROM photo_service.generations WHERE '+ownRows);
  const seen=[],errors=[];let behavior;
  const server=createServer(async(req,res)=>{try{
   const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));seen.push(body);
   assert.equal(req.headers.authorization,'Bearer synthetic-seedream-test-key');assert.equal(body.model,SEEDREAM_MODEL);
   if(behavior){await behavior(req,res,body);return;}
   const dim=Number(body.size.split('x')[0]);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:body.size,b64_json:syntheticPng(42,dim,dim).toString('base64')}]}));
  }catch(e){errors.push(e);res.writeHead(500).end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const generator=new SeedreamImageGenerator(pool,{put:i=>f.store.put(i.id,i.bytes,'image/png')},'synthetic-seedream-test-key',{environment:'test',url:'http://127.0.0.1:'+server.address().port+'/images'});
  const service=new TimelineSeedreamService(f.runtime,f.store,f.store,generator);
  try{await run({...f,pool,generator,generation:service,providerRequests:seen,setProviderBehavior:v=>behavior=v});assert.deepEqual(errors,[]);}
  finally{await new Promise(r=>server.close(r));await pool.query('DELETE FROM photo_service.generations WHERE '+ownRows);await pool.end();}
 },options);
}

for(const couple of [false,true])test(`stored ${couple?'couple':'single'} plan→original JPEG→Pro→SQL replay→private PNG; no fabricated quality`,()=>withSeedreamFixture(async f=>{
 const result=await f.generation.generate(f.service,'root',37);assert.equal(result.status,'candidate');assert.equal(result.publishable,false);assert.equal(result.seedMode,'plan-provenance-only');
 assert.deepEqual(Buffer.from(f.providerRequests[0].image.split(',')[1],'base64'),f.sourceBytes);
 const policy=JSON.parse(f.providerRequests[0].prompt);assert.equal(policy.targetAge,37);assert.match(policy.identity.instruction,couple?/BOTH/:/distinctive/);
 assert.deepEqual(await f.generation.generate({...f.service,actorId:'another-service'},'root',37),result);assert.equal(f.providerRequests.length,1);
 assert.equal(f.runtime.getRecord(f.service,'generation.timeline-commands','root').data.resultManifest,undefined);
 assert.equal((await f.pool.query("SELECT state FROM photo_service.generations WHERE tenant_id=$1 AND idempotency_key='timeline:root:age:37'",['tenant'])).rows[0].state,'succeeded');
 await assert.rejects(f.generation.generate(f.actor,'root',37),/service account/);await assert.rejects(f.generation.generate(f.service,'root',100),/stored B14 plan/);
 assert.equal(f.providerRequests.length,1);
},{couple}));

test('all 21 nodes anchor the original rather than a previously generated face',()=>withSeedreamFixture(async f=>{
 for(let age=0;age<=100;age+=5){const r=await f.generation.generate(f.service,'root',age);assert.equal(r.targetAge,age);}
 assert.equal(f.providerRequests.length,21);assert.equal(new Set(f.providerRequests.map(r=>r.image)).size,1);
 assert.deepEqual(f.providerRequests.map(r=>JSON.parse(r.prompt).targetAge),Array.from({length:21},(_,i)=>i*5));
},{targetAges:Array.from({length:21},(_,i)=>i*5)}));

for(const phase of ['read','pre-submit','response'])test(`revocation or cancellation at ${phase} blocks egress or candidate return`,()=>withSeedreamFixture(async f=>{
 let changed=false;
 const cancel=()=>{if(!changed){changed=true;f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','cancelled'));}};
 const reader={read:async(...a)=>{const bytes=await f.store.read(...a);if(phase==='read')cancel();return bytes;}};
 if(phase==='pre-submit'){
  // Real SQL intent is visible before cancellation; no network POST has occurred.
  const original=f.generator.generate.bind(f.generator);
  f.generator.generate=async input=>original({...input,beforeSubmit:async()=>{cancel();await input.beforeSubmit();}});
 }
 if(phase==='response')f.setProviderBehavior((req,res,body)=>{cancel();res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:body.size,b64_json:syntheticPng(9,2048,2048).toString('base64')}]}));});
 const service=new TimelineSeedreamService(f.runtime,reader,f.store,f.generator);
 await assert.rejects(service.generate(f.service,'root',37));assert.equal(f.providerRequests.length,phase==='response'?1:0);
 assert.equal(f.runtime.getRecord(f.service,'generation.timeline-commands','root').data.resultManifest,undefined);
}));

test('withdrawn transform consent prevents generation, including after source read',()=>withSeedreamFixture(async f=>{
 const reader={read:async(...a)=>{
  const bytes=await f.store.read(...a);
  const consent=f.runtime.listConsents(f.service).find(c=>c.participantId==='user'&&c.purpose==='age_transformation'&&c.scope.actions.includes('transform'));assert.ok(consent);
  f.runtime.withdrawConsent(f.actor,{consentId:consent.id,expectedVersion:consent.version,reason:'withdraw before model egress',idempotencyKey:'withdraw-transform'});
  return bytes;
 }};
 await assert.rejects(new TimelineSeedreamService(f.runtime,reader,f.store,f.generator).generate(f.service,'root',37),/consent/i);
 assert.equal(f.providerRequests.length,0);
}));

test('uncertain remote response remains journaled and never re-posts on another HTTP attempt',()=>withSeedreamFixture(async f=>{
 f.setProviderBehavior(req=>req.socket.destroy());
 await assert.rejects(f.generation.generate(f.service,'root',37),/RECONCILIATION_REQUIRED/);
 await assert.rejects(f.generation.generate(f.service,'root',37),/RECONCILIATION_REQUIRED/);
 assert.equal(f.providerRequests.length,1);
 const rows=(await f.pool.query("SELECT state FROM photo_service.generations WHERE tenant_id='tenant' AND idempotency_key='timeline:root:age:37'")).rows;
 assert.deepEqual(rows.map(r=>r.state),['reconciliation_required']);
}));

for(const couple of [false,true])test(`wardrobe preserves original identity and a separate accepted edit reference ${couple?'couple':'single'}`,()=>withSeedreamFixture(async f=>{
 const age=37,source=await f.asset('age-source',1),node=await f.readyNode(source,age),editBytes=await f.store.read(source);
 f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',{schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[node]}));
 const selections=f.participantIds.map((participantId,i)=>({participantId,styleId:i?'traditional':'formal'}));
 for(const participantId of f.participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:'wardrobe-edit-consent-v1',idempotencyKey:'wardrobe-'+participantId});
 await f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe',input:{jobId:'wardrobe',sourceAssetId:'source',participantIds:f.participantIds,targetAges:[age],seed:'wardrobe',promptPolicyVersion:'wardrobe-only.v1',timelineProfile:'wardrobe-edit-v1',illustrativeLabel:true,wardrobeEdit:{schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,sourceImage:source,selections}}});
 const result=await f.generation.generate(f.service,'wardrobe',age);assert.equal(result.publishable,false);
 const body=f.providerRequests[0];assert.equal(body.image.length,2);
 assert.deepEqual(Buffer.from(body.image[0].split(',')[1],'base64'),f.sourceBytes);assert.deepEqual(Buffer.from(body.image[1].split(',')[1],'base64'),Buffer.from(editBytes));
 assert.match(JSON.parse(body.prompt).instruction,/Change clothing only/);
},{couple}));
