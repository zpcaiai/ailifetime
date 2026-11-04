import {createHash} from "node:crypto";
import {canonicalJson} from "./canonical.js";
import {DomainError} from "./errors.js";
import type {ActorContext,JsonObject,LifeTimeMachineRuntimePort,RecordEnvelope} from "./types.js";
export const QUALITY_CONTROLS="media.quality-controls",QUALITY_REVIEWS="media.quality-reviews",QUALITY_INDEX="media.quality-sample-index",QUALITY_SAMPLES="media.qsample.";
export const qualityDigest=(v:unknown)=>createHash("sha256").update(canonicalJson(v)).digest("hex");
export const qualityReviewId=(id:string)=>"review-"+qualityDigest(id);
export const qualityControlId=(policy:JsonObject)=>"quality-control-"+qualityDigest({context:policy.context,modelVersion:policy.modelVersion,modelSha256:policy.modelSha256});
export function qualityMeasurementFingerprint(report:RecordEnvelope):string {
 return qualityDigest({participants:report.participantIds,modelVersion:report.data.modelVersion,scores:report.data.scores,thresholds:report.data.thresholds,artifactBinding:report.data.artifactBinding,photoScoreEvidence:report.data.photoScoreEvidence,participantAssessments:report.data.participantAssessments??null});
}
export function qualityTemplate(plan:JsonObject):string {
 if(plan.wardrobePolicy!==undefined){
  const policy=plan.wardrobePolicy as JsonObject,selections=policy.selections;
  if(!Array.isArray(selections)||selections.length<1)throw new DomainError("VALIDATION_FAILED","wardrobe quality selection is missing");
  return "wardrobe:"+createHash("sha256").update(JSON.stringify(selections.map(s=>(s as JsonObject).styleId))).digest("hex");
 }
 if(typeof plan.templateId!=="string")throw new DomainError("VALIDATION_FAILED","quality template is missing");
 return plan.templateId;
}
export async function listQualityRecords(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,collection:string):Promise<RecordEnvelope[]> {
 const rows:RecordEnvelope[]=[];let cursor:string|undefined;
 for(let page=0;page<6;page++){
  const next=await runtime.listRecords(actor,{collection,limit:200,...(cursor?{cursor}:{})});rows.push(...next);
  if(rows.length>1000)throw new DomainError("DEPENDENCY_UNAVAILABLE","quality history exceeds bounded page limit");
  if(next.length<200)return rows;
  cursor=next.at(-1)!.id;
 }
 throw new DomainError("DEPENDENCY_UNAVAILABLE","quality history cannot be truncated");
}
/** The persisted latch is checked before a provider side effect; no in-memory fallback. */
export async function assertQualityTrafficAllowed(runtime:LifeTimeMachineRuntimePort,actor:ActorContext,plan:JsonObject):Promise<void> {
 const template=qualityTemplate(plan),people=plan.participantIds;
 if(!Array.isArray(people)||people.length<1||people.length>2)throw new DomainError("VALIDATION_FAILED","quality traffic participant plan is invalid");
 for(const record of await listQualityRecords(runtime,actor,QUALITY_CONTROLS)){
  const context=record.data.context as JsonObject|undefined;
  if(!context||context.provider!=="generation-engine"||context.templateId!==template||context.subjectMode!==(people.length===2?"couple":"single")||context.operation!==(plan.wardrobePolicy?"wardrobe":"age"))continue;
  if(record.data.state==="stopped")throw new DomainError("PROCESSING_RESTRICTED","quality regression stopped this model/template traffic");
  if(record.data.state!=="active")throw new DomainError("DEPENDENCY_UNAVAILABLE","unknown quality traffic state");
 }
}
