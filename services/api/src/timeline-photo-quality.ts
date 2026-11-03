import { isDeepStrictEqual } from "node:util";
import { canonicalJson, DomainError, bindTimelineResultManifest, parseTimelineImageAsset, type ActorContext, type JsonObject, type LifeTimeMachineRuntimePort, type RecordEnvelope, type TimelineImageAsset } from "@ltm/core";
import type { CapabilityRegistry } from "@ltm/capabilities";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";
import type { PhotoScorer } from "./photo-score-client.js";
import { assessPhotoResponse, digest, makePhotoScoreRequest, validatePhotoPolicy, type PhotoContext, type PhotoPolicy, type PhotoScoreRequest } from "./photo-score-contract.js";

const COMMANDS="generation.timeline-commands", REPORTS="media.quality-decisions";
function invalid(message:string):never { throw new DomainError("VALIDATION_FAILED",message); }
function json(value:unknown):JsonObject {
  if(value===null || typeof value!=="object" || Array.isArray(value)) return invalid("photo scoring requires stored object metadata");
  return value as JsonObject;
}
function active(record:RecordEnvelope):void {
  if(record.data._externalDecisionState==="frozen" || record.data._externalReconciliationState==="reconciliation_required" || ["cancelled","compensated"].includes(String(record.data.commandState))) throw new DomainError("VERSION_CONFLICT","photo scoring command is frozen, cancelled or compensated");
}
export function photoQualityId(tenant:string,command:string,age:number,outputSha:string,referenceSha:string,policy:PhotoPolicy):string {
  return "photo-quality-"+digest(canonicalJson([tenant,command,age,outputSha,referenceSha,policy]));
}
/** Reads approved media, calls a real perception boundary, and persists through the existing B15 validator. */
export class TimelinePhotoQualityService {
  private readonly policies:PhotoPolicy[];
  constructor(private readonly runtime:LifeTimeMachineRuntimePort,private readonly registry:CapabilityRegistry,
    private readonly media:TimelineArtifactReader,private readonly scorer:PhotoScorer,policies:PhotoPolicy[],private readonly channel:string) {
    this.policies=policies.map(validatePhotoPolicy);
    if(this.policies.length===0 || this.policies.some(p=>p.context.channel!==channel)) throw new DomainError("CONFIGURATION_INVALID","photo calibration channel is missing or inconsistent");
  }
  private async load(actor:ActorContext,commandId:string,targetAge:number) {
    if(!actor.roles.includes("service_account") || actor.purpose!=="age_transformation") throw new DomainError("AUTH_FORBIDDEN","photo scoring requires an age-transformation service account");
    await this.runtime.authorize(actor,"media.quality.evaluate",{tenantId:actor.tenantId});
    if(!Number.isInteger(targetAge) || targetAge<0 || targetAge>100) return invalid("photo target age is invalid");
    const command=await this.runtime.getRecord(actor,COMMANDS,commandId);active(command);
    if(command.data.batchId!=="B14" || command.data.operation!=="createTimeline" || !Array.isArray(command.data.targetAges) || !command.data.targetAges.includes(targetAge)) return invalid("photo score target is not in the stored B14 plan");
    const plan=json(command.data.generationPlan),people=plan.participantIds;
    if(!Array.isArray(people) || people.length<1 || people.length>2 || people.some(id=>typeof id!=="string") || new Set(people).size!==people.length || !isDeepStrictEqual([...people].sort(),[...command.participantIds].sort())) return invalid("photo participant plan is invalid");
    const participantIds=people as string[],sourceAssetId=command.data.sourceAssetId;
    if(typeof sourceAssetId!=="string")return invalid("photo source asset is missing");
    if(command.data.retryOfCommandId!==undefined) {
      const parent=await this.runtime.getRecord(actor,COMMANDS,String(command.data.retryOfCommandId));active(parent);
      if(parent.ownerActorId!==command.ownerActorId || parent.data.sourceAssetId!==sourceAssetId || !isDeepStrictEqual(parent.participantIds,command.participantIds)) return invalid("photo retry parent binding changed");
    }
    const intake=await this.runtime.getRecord(actor,"media.intake-results",sourceAssetId);
    if(intake.data.batchId!=="B07" || intake.data.executionState!=="persisted" || intake.ownerActorId!==command.ownerActorId || intake.data.assetId!==sourceAssetId ||
       intake.data.mimeType!=="image/jpeg" || intake.data.magicVerified!==true || intake.data.metadataStripped!==true || intake.data.malwareState!=="clean" || intake.data.participantMapComplete!==true ||
       !isDeepStrictEqual(intake.data.participantIds,participantIds) || intake.data.lineageSha256!==digest(`ltm-media-lineage-v1\n${intake.data.sourceSha256}\n${intake.data.canonicalSha256}\n`)) return invalid("photo reference must match the original accepted B07 intake");
    const dimensions=json(intake.data.qualityDimensions);
    const reference=parseTimelineImageAsset({id:sourceAssetId,sha256:intake.data.canonicalSha256,mimeType:intake.data.mimeType,byteLength:intake.data.byteLength,width:dimensions.width,height:dimensions.height});
    await this.runtime.assertConsent(actor,{participantIds,purpose:"quality_assurance",scope:{resource:`media.asset:${sourceAssetId}`,action:"process"}});
    let agePlan=plan,wardrobe: {asset:TimelineImageAsset;selections:NonNullable<PhotoScoreRequest["wardrobe"]>["selections"]}|undefined;
    if(command.data.wardrobeEdit!==undefined) {
      const edit=json(command.data.wardrobeEdit),root=await this.runtime.getRecord(actor,COMMANDS,String(edit.sourceRootCommandId));
      const source=root.id===edit.sourceCommandId?root:await this.runtime.getRecord(actor,COMMANDS,String(edit.sourceCommandId));
      for(const record of [root,source]) {active(record);if(record.ownerActorId!==command.ownerActorId || record.data.sourceAssetId!==sourceAssetId || record.data.wardrobeEdit!==undefined) return invalid("wardrobe scoring source ownership changed");}
      if(root.data.retryOfCommandId!==undefined || (source.id!==root.id && source.data.retryOfCommandId!==root.id) || source.data.commandState!=="succeeded" || source.data.lastProvider!=="generation-engine" || typeof source.data.lastEvidenceId!=="string")return invalid("wardrobe scoring needs the signed original age delivery");
      const manifest=bindTimelineResultManifest(source.data.resultManifest,{sourceAssetId,targetAges:source.data.targetAges,planVersion:json(source.data.generationPlan).schemaVersion});
      const node=manifest.nodes.find(n=>n.targetAge===targetAge);
      if(node?.status!=="ready" || !isDeepStrictEqual(node.asset,edit.sourceImage) || !isDeepStrictEqual(node.asset,plan.editSource) || !isDeepStrictEqual(source.participantIds,command.participantIds))return invalid("wardrobe scoring edit image or people changed");
      await this.runtime.assertConsent(actor,{participantIds,purpose:"age_transformation",scope:{resource:`media.asset:${sourceAssetId}`,action:"wardrobe"}});
      const selections=json(plan.wardrobePolicy).selections;
      if(!Array.isArray(selections)) return invalid("wardrobe scoring styles are missing");
      wardrobe={asset:node.asset!,selections:selections.map(value=>{const s=json(value);if(typeof s.participantId!=="string" || typeof s.styleId!=="string" || typeof s.instruction!=="string")return invalid("wardrobe scoring selection metadata is incomplete");return {participantId:s.participantId,styleId:s.styleId,instruction:s.instruction};})};
      agePlan=json(root.data.generationPlan);
    }
    const sourceAges=Array.isArray(agePlan.participantAges)?agePlan.participantAges:[agePlan.currentAge];
    if(sourceAges.some(age=>typeof age!=="number" || !Number.isInteger(age) || age<0 || age>100)) return invalid("photo quality calibration needs known ordered source ages");
    const ageSpan=Math.max(...(sourceAges as number[]).map(age=>Math.abs(targetAge-age)));
    const context:PhotoContext={provider:"generation-engine",templateId:wardrobe?"wardrobe:"+digest(JSON.stringify(wardrobe.selections.map(s=>s.styleId))):String(plan.templateId),channel:this.channel,subjectMode:participantIds.length===2?"couple":"single",operation:wardrobe?"wardrobe":"age"};
    const matches=this.policies.filter(p=>isDeepStrictEqual(p.context,context) && targetAge>=p.minimumTargetAge && targetAge<=p.maximumTargetAge && ageSpan>=p.minimumAgeSpan && ageSpan<=p.maximumAgeSpan);
    if(matches.length!==1)throw new DomainError("DEPENDENCY_UNAVAILABLE","photo scoring context has no unique calibration");
    return {command,plan,intake,participantIds,reference,context,policy:matches[0]!,wardrobe};
  }
  async evaluate(actor:ActorContext,commandId:string,targetAge:number,assetValue:unknown) {
    const asset=parseTimelineImageAsset(assetValue),loaded=await this.load(actor,commandId,targetAge);
    const {plan,intake,participantIds,reference,context,policy}=loaded;
    const workId=photoQualityId(actor.tenantId,commandId,targetAge,asset.sha256,reference.sha256,policy);
    await this.runtime.assertConsent(actor,{participantIds,purpose:"quality_assurance",scope:{resource:`${REPORTS}:${workId}`,action:"process"}});
    const referenceBytes=await this.media.read(reference),outputBytes=await this.media.read(asset);
    const wardrobe=loaded.wardrobe===undefined?undefined:{...loaded.wardrobe,bytes:await this.media.read(loaded.wardrobe.asset)};
    const request=makePhotoScoreRequest({tenantId:actor.tenantId,commandId,sourceAssetId:reference.id,targetAge,context,
      people:participantIds.map((participantId,index)=>({participantId,position:participantIds.length===1?"single":index===0?"left":"right"})),referenceAsset:reference,referenceBytes,outputAsset:asset,outputBytes,...(wardrobe?{wardrobe}:{})},policy);
    const current=async()=>{
      const fresh=await this.load(actor,commandId,targetAge);
      if(fresh.intake.version!==intake.version || !isDeepStrictEqual(fresh.plan,plan))throw new DomainError("VERSION_CONFLICT","photo authorization/plan changed during evaluation");
      await this.runtime.assertConsent(actor,{participantIds,purpose:"quality_assurance",scope:{resource:`${REPORTS}:${workId}`,action:"process"}});
      return fresh;
    };
    try {
      const cached=await this.runtime.getRecord(actor,REPORTS,workId),binding=json(cached.data.artifactBinding),evidence=json(cached.data.photoScoreEvidence);
      if(cached.data.batchId!=="B15" || cached.data.executionState!=="persisted" || cached.data.modelVersion!==policy.modelVersion || !isDeepStrictEqual(cached.participantIds,[...participantIds].sort()) || !isDeepStrictEqual(cached.data.thresholds,policy.thresholds) ||
          binding.sourceAssetId!==reference.id || binding.assetId!==asset.id || binding.outputSha256!==asset.sha256 || binding.targetAge!==targetAge || evidence.requestSha256!==request.requestSha256 || evidence.sourceSha256!==reference.sha256 || evidence.modelSha256!==policy.modelSha256 || evidence.calibrationId!==policy.id ||
          evidence.calibrationSha256!==digest(canonicalJson(policy)) || !isDeepStrictEqual(evidence.calibration,policy)) throw new DomainError("EVENT_FINGERPRINT_CONFLICT","cached photo quality binding changed");
      await current();
      return {qualityResultId:workId,decision:cached.data.decision,failedDimensions:cached.data.failedDimensions,modelVersion:policy.modelVersion,calibrationId:policy.id,reused:true};
    }catch(error){if(!(error instanceof DomainError && error.code==="RESOURCE_NOT_FOUND"))throw error;}
    const before=await current();
    if(!["requested","dispatched","acknowledged"].includes(String(before.command.data.commandState)))throw new DomainError("VERSION_CONFLICT","photo scoring cannot create new quality after terminal delivery");
    const fingerprint=digest(JSON.stringify(request)),raw=await this.scorer.evaluate(request);
    if(digest(JSON.stringify(request))!==fingerprint)throw new DomainError("DEPENDENCY_UNAVAILABLE","photo scorer mutated the bound request");
    const result=assessPhotoResponse(raw,request,policy);
    const fresh=await current();
    if(!["requested","dispatched","acknowledged"].includes(String(fresh.command.data.commandState)))throw new DomainError("VERSION_CONFLICT","photo authorization/plan changed during evaluation");
    await this.registry.execute(this.runtime,"B15",{actor,idempotencyKey:`photo-score:${workId}`,input:{workId,participantIds,modelVersion:result.modelVersion,
      artifactBinding:{sourceAssetId:reference.id,assetId:asset.id,outputSha256:asset.sha256,targetAge,...(plan.wardrobeBinding===undefined?{}:{wardrobeBinding:plan.wardrobeBinding})},
      scores:result.scores,thresholds:result.thresholds,participantAssessments:result.participantAssessments,decision:result.decision,
      photoScoreEvidence:{schemaVersion:"ltm.photo-score.evidence.v1",requestSha256:request.requestSha256,responseSha256:digest(JSON.stringify(raw)),sourceSha256:reference.sha256,modelSha256:policy.modelSha256,calibrationId:policy.id,calibrationSha256:digest(canonicalJson(policy)),calibration:JSON.parse(canonicalJson(policy)) as JsonObject,ages:result.ages}}});
    return {qualityResultId:workId,decision:result.decision,failedDimensions:result.failedDimensions,modelVersion:policy.modelVersion,calibrationId:policy.id,reused:false};
  }
}
