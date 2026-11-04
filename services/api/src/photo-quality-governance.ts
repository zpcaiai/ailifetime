import {DomainError,QUALITY_CONTROLS,QUALITY_INDEX,QUALITY_REVIEWS,QUALITY_SAMPLES,listQualityRecords,qualityDigest,qualityMeasurementFingerprint,qualityReviewId,type ActorContext,type JsonObject,type LifeTimeMachineRuntimePort,type RecordEnvelope,type TimelineImageAsset} from "@ltm/core";
import {photoControlKey,validatePhotoPolicy,type PhotoPolicy} from "./photo-score-contract.js";

export const QUALITY_ACTIONS="media.quality-actions";
export const json=(value:unknown):JsonObject=>{
 if(value===null||typeof value!=="object"||Array.isArray(value))throw new DomainError("VALIDATION_FAILED","quality object is missing");
 return value as JsonObject;
};
export async function qualityRecord(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,collection:string,id:string):Promise<RecordEnvelope|undefined>{
 try{return await runtime.getRecord(actor,collection,id);}catch(error){if(error instanceof DomainError&&error.code==="RESOURCE_NOT_FOUND")return;throw error;}
}
async function createOnce(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,collection:string,id:string,data:JsonObject):Promise<RecordEnvelope>{
 const existing=await qualityRecord(runtime,actor,collection,id);if(existing)return existing;
 try{return (await runtime.createRecord(actor,{collection,id,data,ownerActorId:null,participantIds:[],idempotencyKey:"quality-create:"+qualityDigest([collection,id])})).value;}
 catch(error){if(error instanceof DomainError&&["VERSION_CONFLICT","IDEMPOTENCY_CONFLICT"].includes(error.code)){const found=await qualityRecord(runtime,actor,collection,id);if(found)return found;}throw error;}
}
export function qualityHuman(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,permission="media.quality.review"):void{
 if(actor.roles.includes("consumer")||actor.roles.includes("service_account")||!actor.roles.some(r=>r==="moderator"||r==="platform_admin"))throw new DomainError("AUTH_FORBIDDEN","quality decisions require a human reviewer");
 runtime.authorize(actor,permission,{tenantId:actor.tenantId,sensitive:true});
}
export function qualityReason(value:unknown):string{
 if(typeof value!=="string"||value.trim().length<3||value.length>1000||/[\x00-\x1f]/.test(value))throw new DomainError("VALIDATION_FAILED","review requires a bounded reason or ticket");return value.trim();
}
/** Persist the exact CAS intent first. Retries replay the native SQL idempotency result,
 * rather than recomputing a new action against a later stop/review version. */
export async function qualityHumanMutation(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,collection:string,id:string,input:JsonObject,key:string,build:(record:RecordEnvelope)=>JsonObject):Promise<RecordEnvelope>{
 if(typeof key!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)||!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1)throw new DomainError("VALIDATION_FAILED","quality action requires version and idempotency key");
 const actionId="action-"+qualityDigest([actor.actorId,collection,id,key]),fingerprint=qualityDigest(input);
 let intent=await qualityRecord(runtime,actor,QUALITY_ACTIONS,actionId);
 if(!intent){
  const current=await runtime.getRecord(actor,collection,id);
  if(current.version!==input.expectedVersion)throw new DomainError("VERSION_CONFLICT","quality action version changed");
  intent=await createOnce(runtime,actor,QUALITY_ACTIONS,actionId,{fingerprint,beforeVersion:current.version,postimage:build(current)});
 }
 if(intent.data.fingerprint!==fingerprint)throw new DomainError("IDEMPOTENCY_CONFLICT","quality action key was reused with different input");
 return (await runtime.updateRecord(actor,{collection,id,expectedVersion:Number(intent.data.beforeVersion),data:json(intent.data.postimage),idempotencyKey:actionId})).value;
}
export class PhotoQualityGovernance{
 constructor(readonly runtime:LifeTimeMachineRuntimePort){}
 async control(actor:ActorContext,policy:PhotoPolicy):Promise<RecordEnvelope>{
  const p=validatePhotoPolicy(policy);if(p.protocolVersion!==2)throw new DomainError("VALIDATION_FAILED","regression control requires protocol v2");
  const row=await createOnce(this.runtime,actor,QUALITY_CONTROLS,photoControlKey(p),{state:"active",epoch:0,context:json(p.context),modelVersion:p.modelVersion,modelSha256:p.modelSha256,rule:json(p.regression),sampleCount:0,failureCount:0,windowDigest:qualityDigest([])});
  if(qualityDigest(row.data.rule)!==qualityDigest(p.regression)||!Number.isInteger(row.data.epoch)||Number(row.data.epoch)<0||!["active","stopped"].includes(String(row.data.state)))throw new DomainError("DEPENDENCY_UNAVAILABLE","quality control configuration changed or is invalid");
  return row;
 }
 async assertActive(actor:ActorContext,p:PhotoPolicy):Promise<void>{if((await this.control(actor,p)).data.state!=="active")throw new DomainError("PROCESSING_RESTRICTED","quality regression has stopped this stream");}
 async observe(actor:ActorContext,qualityId:string,p:PhotoPolicy,asset?:TimelineImageAsset){
  if(!actor.roles.includes("service_account")||actor.purpose!=="age_transformation")throw new DomainError("AUTH_FORBIDDEN","quality observations require the scoring service");
  this.runtime.authorize(actor,"media.quality.evaluate",{tenantId:actor.tenantId});
  let control=await this.control(actor,p);
  const report=await this.runtime.getRecord(actor,"media.quality-decisions",qualityId),e=json(report.data.photoScoreEvidence),scores=json(report.data.scores),thresholds=json(report.data.thresholds);
  if(report.data.batchId!=="B15"||report.data.executionState!=="persisted"||e.schemaVersion!=="ltm.photo-score.evidence.v2"||e.controlKey!==control.id||qualityDigest(e.calibration)!==qualityDigest(p)||report.data.modelVersion!==p.modelVersion)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","quality observation is not bound to this control");
  const dimensions=Object.keys(p.thresholds);
  if(qualityDigest(thresholds)!==qualityDigest(p.thresholds)||qualityDigest(Object.keys(scores).sort())!==qualityDigest(dimensions.sort())||dimensions.some(k=>typeof scores[k]!=="number"||!Number.isFinite(scores[k])||Number(scores[k])<0||Number(scores[k])>1))throw new DomainError("VALIDATION_FAILED","quality observation dimensions changed");
  const fingerprint=qualityMeasurementFingerprint(report),failed=dimensions.some(k=>Number(scores[k])<Number(thresholds[k]));
  const binding=json(report.data.artifactBinding);
  const index=await createOnce(this.runtime,actor,QUALITY_INDEX,"sample-"+qualityDigest([control.id,e.commandId,binding.targetAge,binding.outputSha256,e.sourceSha256]),{qualityId,controlKey:control.id,epoch:control.data.epoch!,fingerprint,failed,observedAt:report.createdAt});
  if(index.data.qualityId===qualityId&&index.data.fingerprint!==fingerprint)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","quality observation measurements changed");
  if(index.data.epoch===control.data.epoch){
   const collection=QUALITY_SAMPLES+qualityDigest([control.id,index.data.epoch]).slice(0,40);
   await createOnce(this.runtime,actor,collection,index.id,index.data);
   for(let attempt=0;attempt<3;attempt++){
    control=await this.runtime.getRecord(actor,QUALITY_CONTROLS,control.id);
    if(control.data.epoch!==index.data.epoch)break;
    let rows:RecordEnvelope[]=[],overflow=false;
    try{rows=await listQualityRecords(this.runtime,actor,collection);}catch(error){if(error instanceof DomainError&&error.code==="DEPENDENCY_UNAVAILABLE")overflow=true;else throw error;}
    const window=rows.sort((a,b)=>String(a.data.observedAt).localeCompare(String(b.data.observedAt))||a.id.localeCompare(b.id)).slice(-p.regression!.windowSize);
    const failures=window.filter(r=>r.data.failed===true).length,trip=overflow||(window.length>=p.regression!.minimumSamples&&failures/window.length>=p.regression!.maximumFailureRate);
    const data={...control.data,state:control.data.state==="stopped"||trip?"stopped":"active",sampleCount:window.length,failureCount:failures,windowDigest:qualityDigest(window.map(r=>[r.id,r.data.fingerprint])),...(trip?{stopReason:overflow?"history-capacity":"quality-regression"}:{})};
    if(qualityDigest(data)===qualityDigest(control.data))break;
    try{control=(await this.runtime.updateRecord(actor,{collection:QUALITY_CONTROLS,id:control.id,expectedVersion:control.version,data,idempotencyKey:"window-"+qualityDigest([control.id,control.version,data])})).value;break;}
    catch(error){if(!(error instanceof DomainError&&error.code==="VERSION_CONFLICT")||attempt===2)throw error;}
   }
  }
  let review:RecordEnvelope|undefined;
  if(report.data.decision!=="pass"){
   if(asset){const b=json(report.data.artifactBinding);if(asset.id!==b.assetId||asset.sha256!==b.outputSha256)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review candidate does not match scored pixels");}
   review=await createOnce(this.runtime,actor,QUALITY_REVIEWS,qualityReviewId(qualityId),{qualityId,controlKey:control.id,fingerprint,reportVersion:report.version,state:"pending",...(asset?{outputAsset:json(asset)}:{})});
   if(review.data.fingerprint!==fingerprint)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review measurements changed");
  }
  return {control,review};
 }
 async resume(actor:ActorContext,id:string,input:JsonObject,key:string):Promise<RecordEnvelope>{
  qualityHuman(this.runtime,actor,"media.quality.control");const reason=qualityReason(input.reason),ticket=qualityReason(input.ticket);
  if(!["propose","confirm"].includes(String(input.action)))throw new DomainError("VALIDATION_FAILED","unknown quality resume action");
  await qualityHumanMutation(this.runtime,actor,QUALITY_CONTROLS,id,input,key,current=>{
   if(current.data.state!=="stopped")throw new DomainError("VERSION_CONFLICT","quality stream is not stopped");
   if(input.action==="propose")return {...current.data,resumeProposal:{actorId:actor.actorId,reason,ticket,windowDigest:current.data.windowDigest??null}};
   const proposal=json(current.data.resumeProposal);
   if(proposal.actorId===actor.actorId||proposal.ticket!==ticket||proposal.windowDigest!==current.data.windowDigest)throw new DomainError("AUTH_FORBIDDEN","resume requires another human and the unchanged quality window");
   return {...current.data,state:"active",epoch:Number(current.data.epoch)+1,sampleCount:0,failureCount:0,windowDigest:qualityDigest([]),resumeProposal:null,lastResume:{proposer:proposal.actorId!,confirmer:actor.actorId,reason,ticket},stopReason:null};
  });
  return this.runtime.getRecord(actor,QUALITY_CONTROLS,id);
 }
}
