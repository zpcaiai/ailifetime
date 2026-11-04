import {DomainError,QUALITY_REVIEWS,listQualityRecords,parseTimelineImageAsset,qualityDigest,qualityMeasurementFingerprint,type ActorContext,type JsonObject,type LifeTimeMachineRuntimePort,type RecordEnvelope} from "@ltm/core";
import {json,qualityHuman,qualityHumanMutation,qualityReason} from "./photo-quality-governance.js";
import type {TimelineArtifactReader} from "./timeline-artifacts.js";
import {digest} from "./photo-score-contract.js";

/** Human judgements remain separate from the immutable external measurements. */
export class PhotoQualityReview{
 constructor(private readonly runtime:LifeTimeMachineRuntimePort,private readonly media?:TimelineArtifactReader){}
 private async load(actor:ActorContext,id:string){
  qualityHuman(this.runtime,actor);
  const review=await this.runtime.getRecord(actor,QUALITY_REVIEWS,id),report=await this.runtime.getRecord(actor,"media.quality-decisions",String(review.data.qualityId));
  const evidence=json(report.data.photoScoreEvidence),binding=json(report.data.artifactBinding);
  if(evidence.schemaVersion!=="ltm.photo-score.evidence.v2"||review.data.fingerprint!==qualityMeasurementFingerprint(report)||review.data.controlKey!==evidence.controlKey)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review report measurements changed");
  const command=await this.runtime.getRecord(actor,"generation.timeline-commands",String(evidence.commandId));
  if(command.data.batchId!=="B14"||command.data.operation!=="createTimeline"||!command.ownerActorId||command.data.sourceAssetId!==binding.sourceAssetId||qualityDigest([...command.participantIds].sort())!==qualityDigest([...report.participantIds].sort()))throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review command ownership changed");
  if(command.data._externalDecisionState==="frozen"||command.data._externalReconciliationState==="reconciliation_required"||["cancelled","compensated"].includes(String(command.data.commandState)))throw new DomainError("VERSION_CONFLICT","review command is frozen or cancelled");
  for(const resource of [`media.asset:${binding.sourceAssetId}`,`media.quality-decisions:${report.id}`])await this.runtime.assertConsent(actor,{participantIds:report.participantIds,purpose:"quality_assurance",scope:{resource,action:"process"}});
  return {review,report,evidence,binding,command};
 }
 private eligible(report:RecordEnvelope):void{
  const scores=json(report.data.scores),thresholds=json(report.data.thresholds),calibration=json(json(report.data.photoScoreEvidence).calibration),ages=json(report.data.photoScoreEvidence).ages;
  const keys=Object.keys(thresholds);
  if(!keys.includes("aestheticUsability")||keys.some(k=>typeof scores[k]!=="number"||!Number.isFinite(scores[k])||typeof thresholds[k]!=="number"||Number(thresholds[k])<=0||Number(thresholds[k])>1||Number(scores[k])<0||Number(scores[k])>1||k!=="aestheticUsability"&&Number(scores[k])<Number(thresholds[k]))||Number(scores.aestheticUsability)>=Number(thresholds.aestheticUsability))throw new DomainError("VALIDATION_FAILED","only an aesthetic-only deficit can be approved by humans");
  if(!Array.isArray(ages)||ages.length!==report.participantIds.length||ages.some(a=>Number(json(a).confidence)<Number(calibration.minimumAgeConfidence)))throw new DomainError("VALIDATION_FAILED","uncertain age cannot be approved");
 }
 async list(actor:ActorContext){
  qualityHuman(this.runtime,actor);
  const result:JsonObject[]=[];
  for(const row of await listQualityRecords(this.runtime,actor,QUALITY_REVIEWS)){
   try{const loaded=await this.load(actor,row.id);result.push({id:row.id,version:row.version,qualityResultId:loaded.report.id,state:row.data.state!,controlKey:row.data.controlKey!,scores:loaded.report.data.scores!,thresholds:loaded.report.data.thresholds!,targetAge:loaded.binding.targetAge!,proposal:row.data.proposal??null});}
   catch(error){if(error instanceof DomainError&&["CONSENT_REQUIRED","CONSENT_WITHDRAWN","RESOURCE_NOT_FOUND","PROCESSING_RESTRICTED","VERSION_CONFLICT"].includes(error.code))continue;throw error;}
  }
  return result;
 }
 async preview(actor:ActorContext,id:string,kind:"output"|"reference"){
  const loaded=await this.load(actor,id);
  if(!this.media)throw new DomainError("DEPENDENCY_UNAVAILABLE","private review media reader is unavailable");
  let asset;
  if(kind==="output")asset=parseTimelineImageAsset(loaded.review.data.outputAsset);
  else{
   const intake=await this.runtime.getRecord(actor,"media.intake-results",String(loaded.binding.sourceAssetId)),dimensions=json(intake.data.qualityDimensions);
   if(intake.ownerActorId!==loaded.command.ownerActorId||intake.data.canonicalSha256!==loaded.evidence.sourceSha256)throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review reference changed");
   asset=parseTimelineImageAsset({id:intake.id,sha256:intake.data.canonicalSha256,mimeType:intake.data.mimeType,byteLength:intake.data.byteLength,width:dimensions.width,height:dimensions.height});
  }
  if(kind==="output"&&(asset.id!==loaded.binding.assetId||asset.sha256!==loaded.binding.outputSha256))throw new DomainError("EVENT_FINGERPRINT_CONFLICT","review candidate changed");
  const bytes=await this.media.read(asset,{tenantId:actor.tenantId,actorId:loaded.command.ownerActorId!});
  if(bytes.byteLength!==asset.byteLength||digest(bytes)!==asset.sha256)throw new DomainError("DEPENDENCY_UNAVAILABLE","review image storage binding failed");
  const fresh=await this.load(actor,id);if(fresh.review.version!==loaded.review.version||fresh.command.version!==loaded.command.version)throw new DomainError("VERSION_CONFLICT","review changed during private preview");
  return {bytes,asset};
 }
 async decide(actor:ActorContext,id:string,input:JsonObject,key:string){
  const loaded=await this.load(actor,id),reason=qualityReason(input.reason),ticket=qualityReason(input.ticket);
  if(!["propose","confirm"].includes(String(input.action))||!["approve","reject","retry"].includes(String(input.decision)))throw new DomainError("VALIDATION_FAILED","unknown review action");
  if(input.decision==="approve")this.eligible(loaded.report);
  const review=await qualityHumanMutation(this.runtime,actor,QUALITY_REVIEWS,id,input,key,current=>{
   if(current.data.fingerprint!==qualityMeasurementFingerprint(loaded.report)||!["pending","proposed"].includes(String(current.data.state)))throw new DomainError("VERSION_CONFLICT","review is no longer pending");
   if(input.action==="propose")return {...current.data,state:"proposed",proposal:{actorId:actor.actorId,decision:input.decision!,reason,ticket}};
   const proposal=json(current.data.proposal);
   if(current.data.state!=="proposed"||proposal.actorId===actor.actorId||proposal.ticket!==ticket||proposal.decision!==input.decision)throw new DomainError("AUTH_FORBIDDEN","review confirmation requires a different human and matching proposal");
   return {...current.data,state:input.decision==="approve"?"approved":input.decision==="reject"?"rejected":"retry",approval:{proposer:proposal.actorId!,confirmer:actor.actorId,decision:input.decision!,reason,ticket}};
  });
  if(review.data.state==="approved"){
   const fresh=await this.load(actor,id);this.eligible(fresh.report);
   const reviewEvidence={caseId:review.id,caseVersion:review.version,fingerprint:review.data.fingerprint!};
   if(fresh.report.data.decision==="pass"){
    if(qualityDigest(fresh.report.data.reviewEvidence)!==qualityDigest(reviewEvidence))throw new DomainError("VERSION_CONFLICT","another decision changed the quality report");
   }else{
    await this.runtime.updateRecord(actor,{collection:loaded.report.collection,id:loaded.report.id,expectedVersion:Number(review.data.reportVersion),data:{...fresh.report.data,decision:"pass",overrideReason:reason,reviewEvidence},idempotencyKey:"review-apply-"+qualityDigest([review.id,review.version])});
   }
   await this.load(actor,id);
  }
  return {id:review.id,version:review.version,state:review.data.state,qualityResultId:review.data.qualityId};
 }
}
