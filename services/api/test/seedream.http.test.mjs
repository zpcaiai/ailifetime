import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApiServer,StaticTokenAuthenticator} from '../dist/index.js';
import {SeedreamImageGenerator,SEEDREAM_MODEL} from '../dist/seedream.js';
import {TimelineSeedreamService} from '../dist/timeline-seedream.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {syntheticPng} from './timeline-fixtures.mjs';

test('HTTP operator generates a plan-bound candidate with durable replay; consumers and forged controls cannot bill',()=>withPhotoFixture(async f=>{
 assert.ok(process.env.LTM_PHOTO_TEST_POSTGRES_URL,'disposable PostgreSQL required');
 const pool=new Pool({connectionString:process.env.LTM_PHOTO_TEST_POSTGRES_URL,max:2}),id='http-'+randomUUID();let calls=0;
 await pool.query(await readFile(new URL('../../../infra/photo-service/001_media.sql',import.meta.url),'utf8'));
 await f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:id,input:{jobId:id,sourceAssetId:'source',participantIds:['user'],targetAges:[37],currentAge:35,timelineProfile:'single-age-v1',seed:'synthetic-http',promptPolicyVersion:'age-policy-v1',illustrativeLabel:true}});
 const provider=createServer(async(req,res)=>{calls++;for await(const ignored of req){}res.end(JSON.stringify({model:SEEDREAM_MODEL,data:[{size:'2048x2048',b64_json:syntheticPng(7,2048,2048).toString('base64')}]}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const generator=new SeedreamImageGenerator(pool,{put:i=>f.store.put(i.id,i.bytes,'image/png')},'synthetic-key',{environment:'test',url:'http://127.0.0.1:'+provider.address().port+'/images'});
 const seedream=new TimelineSeedreamService(f.runtime,f.store,f.store,generator);
 const authenticator=new StaticTokenAuthenticator([{token:'synthetic-generation-service-token',actorId:'service',tenantId:'tenant',roles:['platform_admin','service_account'],permissions:['*'],allowedPurposes:['age_transformation']},{token:'synthetic-generation-consumer-token',actorId:'user',tenantId:'tenant',roles:['consumer'],allowedPurposes:['age_transformation']}]);
 const server=createApiServer({runtime:f.runtime,authenticator,capabilityRegistry:f.registry,seedream,timelineArtifacts:f.store,appEnvironment:'test',staticDirectory:null});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const headers={authorization:'Bearer synthetic-generation-service-token','x-purpose':'age_transformation','content-type':'application/json','idempotency-key':'http-generation'};
 const send=(body,h=headers)=>fetch(base+'/v1/timelines/'+id+'/generate',{method:'POST',headers:h,body:JSON.stringify(body)});
 try{
  assert.equal((await send({targetAge:37},{})).status,401);
  assert.equal((await send({targetAge:37},{...headers,authorization:'Bearer synthetic-generation-consumer-token'})).status,403);
  for(const body of [{targetAge:37,prompt:'bypass'},{targetAge:37,sourceUrl:'https://attacker.invalid'},{targetAge:37,model:'other'},{targetAge:'37'},{targetAge:100},{targetAge:37.5}])assert.equal((await send(body)).status,422);
  assert.equal(calls,0);
  const first=await send({targetAge:37});assert.equal(first.status,200);const candidate=(await first.json()).data;assert.equal(candidate.publishable,false);assert.equal(candidate.status,'candidate');assert.equal(candidate.model,SEEDREAM_MODEL);
  assert.equal((await send({targetAge:37},{...headers,'idempotency-key':'another-http-key'})).status,200);assert.equal(calls,1);
  const download=await fetch(base+'/v1/timelines/'+id+'/nodes/37/image',{headers:{...headers,authorization:'Bearer synthetic-generation-consumer-token'}});assert.equal(download.status,404);
  assert.equal(f.runtime.getRecord(f.service,'generation.timeline-commands',id).data.resultManifest,undefined);
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>provider.close(r));await pool.query('DELETE FROM photo_service.generations WHERE idempotency_key=$1',['timeline:'+id+':age:37']);await pool.end();}
}));

test('disabled provider and failed readiness stay closed',()=>withPhotoFixture(async f=>{
 const authenticator=new StaticTokenAuthenticator([{token:'synthetic-disabled-service-token',actorId:'service',tenantId:'tenant',roles:['service_account'],permissions:['media.generation.generate'],allowedPurposes:['age_transformation']}]);
 const server=createApiServer({runtime:f.runtime,authenticator,capabilityRegistry:f.registry,appEnvironment:'test',staticDirectory:null,seedreamReadiness:async()=>false});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/v1/timelines/root/generate',{method:'POST',headers:{authorization:'Bearer synthetic-disabled-service-token','x-purpose':'age_transformation','content-type':'application/json','idempotency-key':'disabled'},body:'{"targetAge":37}'})).status,503);
  const ready=await fetch(base+'/health/ready');assert.equal(ready.status,503);assert.equal((await ready.json()).generationReady,false);
 }finally{await new Promise(r=>server.close(r));}
}));
