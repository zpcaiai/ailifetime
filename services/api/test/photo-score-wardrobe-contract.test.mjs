import assert from 'node:assert/strict';
import test from 'node:test';
import {makePhotoScoreRequest,validatePhotoPolicy,digest,assessPhotoResponse} from '../dist/photo-score-contract.js';
import {policy,request,response,withPhotoFixture} from './photo-score-fixtures.mjs';
import {TimelinePhotoQualityService,photoQualityId} from '../dist/timeline-photo-quality.js';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
test('wardrobe scoring requires separate unchanged-age edit pixels and selected per-person clothes',()=>{
 const p=policy();p.context.operation='wardrobe';p.thresholds.garmentMatch=.8;p.thresholds.regionPreservation=.8;validatePhotoPolicy(p);
 const old=request(),source=Buffer.from('synthetic-age-photo-to-dress');
 const input={...old,context:p.context,referenceAsset:old.reference.asset,referenceBytes:Buffer.from(old.reference.base64,'base64'),outputAsset:old.output.asset,outputBytes:Buffer.from(old.output.base64,'base64')};
 assert.throws(()=>makePhotoScoreRequest(input,p),/separate edit reference/);
 const wardrobe={asset:{...old.output.asset,id:'edit-source',sha256:digest(source),byteLength:source.length},bytes:source,selections:[{participantId:'user',styleId:'style',instruction:'Synthetic contract garment selection'}]};
 const r=makePhotoScoreRequest({...input,wardrobe},p);assert.equal(digest(Buffer.from(r.wardrobe.base64,'base64')),wardrobe.asset.sha256);
 const value=response(r,p);value.imageScores.garmentMatch=.9;value.imageScores.regionPreservation=.9;value.participants[0].garmentMatch=.9;
 assert.equal(assessPhotoResponse(value,r,p).decision,'pass');value.participants[0].garmentMatch=.1;assert.equal(assessPhotoResponse(value,r,p).decision,'retry');
 assert.throws(()=>makePhotoScoreRequest({...input,wardrobe:{...wardrobe,asset:old.output.asset}},p),/binding changed/);
});
for(const couple of [false,true])test(`actual wardrobe scoring reads original identity plus edit image and selected clothes ${couple?'couple':'single'}`,()=>withPhotoFixture(async f=>{
 const age=37,source=await f.asset('age-source',1),node=await f.readyNode(source,age),editBytes=await f.store.read(source);
 f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',{schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[node]}));
 const selections=f.participantIds.map((participantId,i)=>({participantId,styleId:i?'traditional':'formal'}));
 for(const participantId of f.participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:'wardrobe-edit-consent-v1',idempotencyKey:'wardrobe-'+participantId});
 await f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe',input:{jobId:'wardrobe',sourceAssetId:'source',participantIds:f.participantIds,targetAges:[age],seed:'wardrobe',promptPolicyVersion:'wardrobe-only.v1',timelineProfile:'wardrobe-edit-v1',illustrativeLabel:true,wardrobeEdit:{schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,sourceImage:source,selections}}});
 const p=structuredClone(f.policy);p.id+=':wardrobe';p.context.operation='wardrobe';p.context.templateId='wardrobe:'+digest(JSON.stringify(selections.map(s=>s.styleId)));p.thresholds.garmentMatch=.8;p.thresholds.regionPreservation=.8;
 const scorer=new TimelinePhotoQualityService(f.runtime,f.registry,f.store,new HttpPhotoScorer(f.scorerOptions),[p],'wechat');
 for(const low of [false,true]){
  const output=await f.asset('clothes-'+low,low?3:2),id=photoQualityId('tenant','wardrobe',age,output.sha256,f.sourceAsset.sha256,p);await f.grantQuality(id);
  f.setBehavior(r=>{
   assert.equal(r.wardrobe.asset.sha256,source.sha256);
   assert.deepEqual(Buffer.from(r.wardrobe.base64,'base64'),Buffer.from(editBytes));
   assert.deepEqual(r.wardrobe.selections.map(s=>s.styleId),selections.map(s=>s.styleId));
   assert.ok(r.wardrobe.selections.every(s=>s.instruction.trim().length>0));
   const value=response(r,p);value.imageScores.garmentMatch=.95;value.imageScores.regionPreservation=low?.1:.95;
   for(const person of value.participants)person.garmentMatch=.95;
   return value;
  });
  const result=await scorer.evaluate(f.service,'wardrobe',age,output);assert.equal(result.decision,low?'retry':'pass');
  assert.equal(f.runtime.getRecord(f.service,'media.quality-decisions',id).data.artifactBinding.wardrobeBinding.sourceImageSha256,source.sha256);
 }
},{couple}));
