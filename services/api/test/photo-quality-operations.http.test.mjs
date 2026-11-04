import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {LifeTimeMachineRuntime,PostgresLifeTimeMachineRuntime} from '@ltm/core';
import {createApiServer,StaticTokenAuthenticator} from '../dist/index.js';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {governancePolicy,persistQuality} from './photo-quality-v2-fixtures.mjs';
for(const backend of ['sqlite','postgresql'])test(`real HTTP review, preview, CAS retry, two-human resume, restart and authorization on ${backend}`,async()=>{
 if(backend==='postgresql')assert.ok(process.env.LTM_TEST_POSTGRES_URL);
 await withPhotoFixture(async f=>{
  const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime),a=await persistQuality(f,p,'http-review'),state=await g.observe(f.service,'http-review',p,a.asset);
  const b=await persistQuality(f,p,'http-regression');await g.observe(f.service,'http-regression',p,b.asset);
  const token=id=>'synthetic-quality-ops-token-'+id;
  const principals=['alice','bob','weak','service','consumer','other'].map(id=>({token:token(id),actorId:id,tenantId:id==='other'?'other-tenant':f.actor.tenantId,roles:id==='service'?['platform_admin','service_account']:id==='consumer'?['consumer']:['platform_admin'],permissions:['*'],allowedPurposes:['age_transformation','quality_assurance'],stepUp:id!=='weak'}));
  const authenticator=new StaticTokenAuthenticator(principals);let runtime=f.runtime,server,base;
  const headers=id=>({authorization:'Bearer '+token(id),'x-purpose':'quality_assurance','content-type':'application/json'});
  async function start(){server=createApiServer({runtime,authenticator,capabilityRegistry:f.registry,timelineArtifacts:f.store,appEnvironment:'test',staticDirectory:null});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}
  const get=(path,id='alice')=>fetch(base+path,{headers:headers(id)});
  const post=(path,body,key,id='alice')=>fetch(base+path,{method:'POST',headers:{...headers(id),'idempotency-key':key},body:JSON.stringify(body)});
  async function success(response){assert.equal(response.status,200,await response.clone().text());return (await response.json()).data;}
  try{
   await start();const queue='/v1/quality/reviews',path=queue+'/'+state.review.id+'/decisions',preview=queue+'/'+state.review.id+'/preview/output';
   assert.equal((await fetch(base+queue)).status,401);for(const id of ['weak','service','consumer'])assert.equal((await get(queue,id)).status,403);
   assert.equal((await get(preview,'other')).status,404);
   const rows=await success(await get(queue));assert.equal(rows.length,2);assert.equal('outputAsset' in rows[0],false);
   const image=await get(preview);assert.equal(image.status,200);assert.match(image.headers.get('cache-control'),/no-store/);assert.equal(image.headers.get('content-disposition'),'inline');assert.equal(image.headers.get('x-ltm-image-sha256'),a.asset.sha256);assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(await f.store.read(a.asset)));
   const input={action:'propose',decision:'approve',expectedVersion:state.review.version,reason:'manual composition review',ticket:'QA-400'};
   assert.equal((await post(path,{...input,scores:{identity:1}},'forge-score')).status,422);
   assert.equal((await post('/v1/commands',{command:'record.create',input:{collection:'media.quality-controls',id:'forged',data:{state:'active'}}},'forge-control')).status,403);
   assert.equal((await post('/v1/queries',{query:'record.list',input:{collection:'media.quality-reviews'}},'raw-query')).status,403);
   const proposal=await success(await post(path,input,'propose'));
   const confirm={...input,action:'confirm',expectedVersion:proposal.version};assert.equal((await post(path,confirm,'same-human')).status,403);
   const accepted=await success(await post(path,confirm,'confirm','bob'));assert.equal(accepted.state,'approved');assert.deepEqual(await success(await post(path,confirm,'confirm','bob')),accepted);
   assert.equal((await post(path,{...confirm,reason:'changed evidence'},'confirm','bob')).status,409);
   await new Promise(r=>server.close(r));await runtime.close();
   runtime=backend==='postgresql'?await PostgresLifeTimeMachineRuntime.connect({...f.runtimeOptions,connectionString:process.env.LTM_TEST_POSTGRES_URL}):new LifeTimeMachineRuntime(f.runtimeOptions);await start();
   const control=(await success(await get('/v1/quality/controls')))[0];assert.equal(control.state,'stopped');
   const resume='/v1/quality/controls/'+control.id+'/resume',resumeInput={action:'propose',expectedVersion:control.version,reason:'quality regression investigated',ticket:'QA-401'};
   assert.equal((await post(resume,resumeInput,'service-resume','service')).status,403);
   const proposed=await success(await post(resume,resumeInput,'resume-propose'));
   const resumed=await success(await post(resume,{...resumeInput,action:'confirm',expectedVersion:proposed.version},'resume-confirm','bob'));assert.equal(resumed.state,'active');assert.equal(resumed.epoch,1);
   const grant=(await runtime.listConsents({...f.actor,purpose:'quality_assurance'},'user')).find(c=>c.purpose==='quality_assurance'&&c.scope.resource==='media.asset:source');
   await runtime.withdrawConsent({...f.actor,purpose:'quality_assurance'},{consentId:grant.id,expectedVersion:grant.version,reason:'withdraw review access',idempotencyKey:'withdraw-ops'});
   assert.equal((await get(preview)).status,409);assert.deepEqual(await success(await get(queue)),[]);
  }finally{server?.closeAllConnections();if(server?.listening)await new Promise(r=>server.close(r));await runtime.close();}
 },backend==='postgresql'?{postgresConnectionString:process.env.LTM_TEST_POSTGRES_URL,tenantId:'http-ops-'+randomUUID()}:{});
});
