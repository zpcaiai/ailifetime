import { createHash } from 'node:crypto';
import { timelineFixture,syntheticPng } from './timeline-fixtures.mjs';
import { wardrobeBinding } from '../../../packages/capabilities/dist/wardrobe-plan.js';

// Synthetic portraits/reports; actual runtime, consent, SQL and signed callbacks execute.
export async function wardrobeFixture({couple=false,age=37,sourceAges=[age],databasePath=':memory:',store,verifiedConsent=false}={}) {
  const f=await timelineFixture(databasePath,{couple,targetAges:sourceAges,verifiedConsent});
  const baseBytes=syntheticPng(1),sourceImage=store?await store.put('age-source',baseBytes,'image/png'):{id:'age-source',sha256:createHash('sha256').update(baseBytes).digest('hex'),mimeType:'image/png',width:64,height:64,byteLength:baseBytes.length};
  const manifest=nodes=>({schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes});
  const sourceNodes=[];for(const targetAge of sourceAges)sourceNodes.push(targetAge===age?await f.readyNode(sourceImage,age):{nodeId:'age-'+targetAge,targetAge,status:'failed',errorCode:'PROVIDER_TRANSIENT'});
  f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',manifest(sourceNodes)));
  const edit={schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,sourceImage,selections:f.participantIds.map((participantId,i)=>({participantId,styleId:i===0?'formal':'traditional'}))};
  async function grantWardrobe(participantIds=f.participantIds) {
    for(const participantId of participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:verifiedConsent?'wardrobe-edit-consent-v1':'wardrobe-test-v1',...(verifiedConsent?{}:{evidenceHash:'e'.repeat(64)}),idempotencyKey:'wardrobe-'+participantId});
  }
  async function createWardrobe(jobId='wardrobe-job') {
    return f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:jobId,input:{jobId,sourceAssetId:'source',participantIds:f.participantIds,targetAges:[age],seed:'wardrobe-seed',promptPolicyVersion:'wardrobe-only.v1',timelineProfile:'wardrobe-edit-v1',illustrativeLabel:true,wardrobeEdit:edit}});
  }
  async function readyWardrobe(asset,commandId='wardrobe-job',bindingOverride) {
    const record=f.runtime.getRecord(f.actor,'generation.timeline-commands',commandId),binding=bindingOverride??wardrobeBinding(record.data.wardrobeEdit);
    const q='wq-'+commandId,s='ws-'+commandId;
    for(const [id,collection,purposes]of [[q,'media.quality-decisions',['age_transformation','quality_assurance']],[s,'media.safety-certificates',['age_transformation']]])for(const participantId of f.participantIds)for(const purpose of purposes){
      f.runtime.grantConsent({...f.actor,actorId:participantId,purpose},{participantId,grantorCapacity:'self',purpose,scope:{resource:collection+':'+id,actions:['process']},policyVersion:verifiedConsent?(purpose==='quality_assurance'?'test-quality-v1':'age-transformation-consent-v1'):'privacy-v1',...(verifiedConsent?{}:{evidenceHash:'c'.repeat(64)}),idempotencyKey:'consent-'+id+'-'+purpose+'-'+participantId});
    }
    const artifactBinding={sourceAssetId:'source',assetId:asset.id,outputSha256:asset.sha256,targetAge:age,wardrobeBinding:binding};
    const dimensions=['identity','ageRange','facialDrift','pose','artifacts','clarity','background','handsTeethEyes','photorealism','garmentMatch','regionPreservation'];
    await f.registry.execute(f.runtime,'B15',{actor:f.service,idempotencyKey:q,input:{...f.fixtures.B15,workId:q,participantIds:f.participantIds,artifactBinding,scores:Object.fromEntries(dimensions.map(d=>[d,.9])),thresholds:Object.fromEntries(dimensions.map(d=>[d,.8])),participantAssessments:f.participantIds.map(participantId=>({participantId,scores:{identity:.9,ageRange:.9,facialDrift:.9,garmentMatch:.9},thresholds:{identity:.8,ageRange:.8,facialDrift:.8,garmentMatch:.8}}))}});
    await f.registry.execute(f.runtime,'B17',{actor:f.service,idempotencyKey:s,input:{...f.fixtures.B17,workId:s,participantIds:f.participantIds,artifactBinding}});
    return{nodeId:'age-'+age,targetAge:age,status:'ready',asset,qualityResultId:q,safetyResultId:s};
  }
  return{...f,edit,sourceImage,manifest,grantWardrobe,createWardrobe,readyWardrobe};
}
