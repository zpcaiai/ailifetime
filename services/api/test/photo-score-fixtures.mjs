import {PHOTO_DIMENSIONS,makePhotoScoreRequest,digest} from '../dist/photo-score-contract.js';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileTimelineArtifactStore} from '../dist/timeline-artifacts.js';
import {timelineFixture,syntheticPng} from './timeline-fixtures.mjs';
// Synthetic external-model boundary only; never real model or photo-quality acceptance.
export const policy=()=>({id:'test-calibration-v1',modelVersion:'test-external-boundary-v1',modelSha256:'a'.repeat(64),context:{provider:'generation-engine',templateId:'timeline-classic-v1',channel:'wechat',subjectMode:'single',operation:'age'},minimumTargetAge:0,maximumTargetAge:100,minimumAgeSpan:0,maximumAgeSpan:100,ageToleranceYears:10,minimumAgeConfidence:.8,thresholds:Object.fromEntries(PHOTO_DIMENSIONS.map(d=>[d,.8]))});
export function request(p=policy(),people=[{participantId:'user',position:'single'}]) {
 const bytes=Buffer.from('synthetic-byte-binding-contract');const asset={id:'output',sha256:digest(bytes),mimeType:'image/png',byteLength:bytes.length,width:1,height:1};
 return makePhotoScoreRequest({tenantId:'tenant',commandId:'root',sourceAssetId:'source',targetAge:37,context:p.context,people,referenceAsset:{...asset,id:'source'},referenceBytes:bytes,outputAsset:asset,outputBytes:bytes},p);
}
export const response=(r,p=policy())=>({schemaVersion:'ltm.photo-score.response.v1',requestSha256:r.requestSha256,modelVersion:p.modelVersion,modelSha256:p.modelSha256,calibrationId:p.id,participants:r.people.map(person=>({...person,identity:.95,estimatedAgeYears:r.targetAge,ageConfidence:.95,facialDrift:.95})),imageScores:Object.fromEntries(['pose','artifacts','clarity','background','handsTeethEyes','photorealism'].map(d=>[d,.95]))});

export async function withPhotoFixture(run,{couple=false,targetAges=[37]}={}) {
 const directory=mkdtempSync(join(tmpdir(),'ltm-photo-scoring-')),store=new FileTimelineArtifactStore(join(directory,'images'));
 // Reuse the repository's JPEG codec to create non-person pixel data, not customer media.
 const jpeg=createRequire(new URL('../../client-integration-broker/package.json',import.meta.url))('jpeg-js');
 const sourceBytes=jpeg.encode({data:Buffer.alloc(64*48*4,128),width:64,height:48},82).data;
 const sourceAsset=await store.put('source',sourceBytes,'image/jpeg');
 const f=await timelineFixture(join(directory,'runtime.sqlite'),{couple,targetAges,verifiedConsent:true,sourceAsset});
 const p=policy();if(couple)p.context.subjectMode='couple';
 let behavior=r=>response(r,p);const seen=[],errors=[];
 const server=createServer(async(req,res)=>{
  try {
   const parts=[];for await(const chunk of req)parts.push(chunk);const r=JSON.parse(Buffer.concat(parts));seen.push(r);
   assert.equal(req.url,'/v1/photo-scores');assert.equal(req.headers.authorization,'Bearer synthetic-photo-workload-token-00001');
   assert.equal(req.headers['idempotency-key'],'photo-score:'+r.requestSha256);
   assert.deepEqual(Buffer.from(r.reference.base64,'base64'),Buffer.from(sourceBytes));
   assert.equal(digest(Buffer.from(r.output.base64,'base64')),r.output.asset.sha256);
   const result=await behavior(r);
   if(result.httpStatus){res.writeHead(result.httpStatus).end();return;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  }catch(error){errors.push(error);res.writeHead(500).end();}
 });
 const token=join(directory,'score-token');writeFileSync(token,'synthetic-photo-workload-token-00001',{mode:0o600});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 async function grantQuality(id) {
  for(const participantId of f.participantIds) {
   f.runtime.grantConsent({...f.actor,actorId:participantId,purpose:'quality_assurance'},{participantId,grantorCapacity:'self',purpose:'quality_assurance',scope:{resource:'media.asset:source',actions:['process']},policyVersion:'test-quality-v1',idempotencyKey:'source-quality-'+participantId});
   for(const purpose of ['quality_assurance','age_transformation'])f.runtime.grantConsent({...f.actor,actorId:participantId,purpose},{participantId,grantorCapacity:'self',purpose,scope:{resource:'media.quality-decisions:'+id,actions:['process']},policyVersion:purpose==='quality_assurance'?'test-quality-v1':'age-transformation-consent-v1',idempotencyKey:`report-${id}-${participantId}-${purpose}`});
  }
 }
 try{await run({...f,directory,store,sourceAsset,sourceBytes,policy:p,seen,setBehavior:b=>behavior=b,grantQuality,
  scorerOptions:{baseUrl:'http://127.0.0.1:'+server.address().port,workloadTokenFile:token,allowInsecureLoopback:true,timeoutMs:500},
  asset:(id,index)=>store.put(id,syntheticPng(index),'image/png')});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.runtime.close();rmSync(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);}
}
