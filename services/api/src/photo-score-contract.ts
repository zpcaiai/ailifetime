import { createHash } from "node:crypto";
import { canonicalJson, DomainError, type TimelineImageAsset } from "@ltm/core";

export const PHOTO_DIMENSIONS = ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"] as const;
const IMAGE_DIMENSIONS = ["pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"];
export interface PhotoContext { provider: string; templateId: string; channel: string; subjectMode: "single" | "couple"; operation: "age" | "wardrobe"; }
export interface PhotoPolicy {
  protocolVersion?: 2;
  regression?: { windowSize: number; minimumSamples: number; maximumFailureRate: number };
  id: string; modelVersion: string; modelSha256: string; context: PhotoContext;
  minimumTargetAge: number; maximumTargetAge: number; minimumAgeSpan: number; maximumAgeSpan: number;
  ageToleranceYears: number; minimumAgeConfidence: number; thresholds: Record<string, number>;
}
export interface PhotoPerson { participantId: string; position: "single" | "left" | "right"; }
export interface PhotoScoreRequest {
  schemaVersion: "ltm.photo-score.request.v1" | "ltm.photo-score.request.v2"; requestSha256: string; tenantId: string; commandId: string; sourceAssetId: string;
  targetAge: number; people: PhotoPerson[]; context: PhotoContext; calibrationId: string; modelVersion: string; modelSha256: string;
  reference: { asset: TimelineImageAsset; base64: string }; output: { asset: TimelineImageAsset; base64: string };
  wardrobe?: { asset: TimelineImageAsset; base64: string; selections: Array<{participantId:string;styleId:string;instruction:string}> };
}
export interface PhotoScoreResult {
  scores: Record<string, number>; thresholds: Record<string, number>;
  participantAssessments: Array<{ participantId: string; scores: Record<string, number>; thresholds: Record<string, number> }>;
  ages: Array<{ participantId: string; estimatedAgeYears: number; confidence: number }>;
  decision: "pass" | "retry" | "review"; failedDimensions: string[]; modelVersion: string;
}
function invalid(message: string): never { throw new DomainError("DEPENDENCY_UNAVAILABLE", message); }
export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid(`${label} has unknown or missing fields`);
  return result;
}
export function digest(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
export function photoControlKey(policy: PhotoPolicy): string { return "quality-control-"+digest(canonicalJson({context:policy.context,modelVersion:policy.modelVersion,modelSha256:policy.modelSha256})); }
function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return invalid(`${label} is outside its finite range`);
  return value;
}
export function validatePhotoPolicy(policy: PhotoPolicy): PhotoPolicy {
  if(policy.protocolVersion!==undefined && policy.protocolVersion!==2)return invalid("unknown photo protocol version");
  object(policy, ["id", "modelVersion", "modelSha256", "context", "minimumTargetAge", "maximumTargetAge", "minimumAgeSpan", "maximumAgeSpan", "ageToleranceYears", "minimumAgeConfidence", "thresholds",...(policy.protocolVersion===2?["protocolVersion","regression"]:[])], "photo policy");
  if(policy.protocolVersion===2){
    const rule=object(policy.regression,["windowSize","minimumSamples","maximumFailureRate"],"quality regression policy");
    if(!Number.isInteger(rule.windowSize)||Number(rule.windowSize)<2||Number(rule.windowSize)>100||!Number.isInteger(rule.minimumSamples)||Number(rule.minimumSamples)<2||Number(rule.minimumSamples)>Number(rule.windowSize)||bounded(rule.maximumFailureRate,0,1,"regression failure rate")===0)return invalid("invalid quality regression window");
  }
  for (const value of [policy.id, policy.modelVersion, policy.context?.provider, policy.context?.templateId, policy.context?.channel]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return invalid("photo policy identifier is invalid");
  }
  object(policy.context, ["provider", "templateId", "channel", "subjectMode", "operation"], "photo context");
  if (!/^[a-f0-9]{64}$/.test(policy.modelSha256) || !["single", "couple"].includes(policy.context.subjectMode) || !["age", "wardrobe"].includes(policy.context.operation)) return invalid("photo model/context is invalid");
  for (const pair of [[policy.minimumTargetAge,policy.maximumTargetAge],[policy.minimumAgeSpan,policy.maximumAgeSpan]]) {
    if (pair.some(value => !Number.isInteger(value) || value! < 0 || value! > 100) || pair[0]! > pair[1]!) return invalid("photo policy age interval is invalid");
  }
  if (bounded(policy.ageToleranceYears,0,100,"age tolerance") === 0 || bounded(policy.minimumAgeConfidence,0,1,"age confidence") === 0) return invalid("photo calibration must be positive");
  const dimensions = [...PHOTO_DIMENSIONS,...(policy.protocolVersion===2?["aestheticUsability"]:[]), ...(policy.context.operation === "wardrobe" ? ["garmentMatch","regionPreservation"] : [])];
  object(policy.thresholds, dimensions, "photo thresholds");
  for (const dimension of dimensions) if (bounded(policy.thresholds[dimension],0,1,dimension) === 0) return invalid("photo thresholds must be positive");
  return structuredClone(policy);
}
export function makePhotoScoreRequest(input: Omit<PhotoScoreRequest,"schemaVersion" | "requestSha256" | "reference" | "output" | "calibrationId" | "modelVersion" | "modelSha256" | "wardrobe"> & {
  referenceAsset: TimelineImageAsset; referenceBytes: Uint8Array; outputAsset: TimelineImageAsset; outputBytes: Uint8Array;
  wardrobe?: {asset:TimelineImageAsset;bytes:Uint8Array;selections:NonNullable<PhotoScoreRequest["wardrobe"]>["selections"]};
}, policy: PhotoPolicy): PhotoScoreRequest {
  const wardrobe=input.wardrobe;
  if ((input.context.operation === "wardrobe") !== (wardrobe !== undefined)) return invalid("wardrobe scoring requires its separate edit reference");
  if (wardrobe && (wardrobe.asset.sha256===input.outputAsset.sha256 || wardrobe.selections.length!==input.people.length || wardrobe.selections.some((s,index)=>Object.keys(s).length!==3 || s.participantId!==input.people[index]?.participantId || typeof s.styleId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s.styleId) || typeof s.instruction!=="string" || s.instruction.trim()==="" || s.instruction.length>4096))) return invalid("wardrobe source or selected clothing binding changed");
  const assets: Array<readonly [TimelineImageAsset,Uint8Array]>=[[input.referenceAsset,input.referenceBytes],[input.outputAsset,input.outputBytes],...(wardrobe?[[wardrobe.asset,wardrobe.bytes] as const]:[])];
  for (const [asset, bytes] of assets) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength !== asset.byteLength || digest(bytes) !== asset.sha256) return invalid("photo bytes do not match their immutable asset");
  }
  const data = { schemaVersion: (policy.protocolVersion===2?"ltm.photo-score.request.v2":"ltm.photo-score.request.v1") as PhotoScoreRequest["schemaVersion"], tenantId: input.tenantId, commandId: input.commandId,
    sourceAssetId: input.sourceAssetId, targetAge: input.targetAge, people: structuredClone(input.people), context: structuredClone(input.context),
    calibrationId: policy.id, modelVersion: policy.modelVersion, modelSha256: policy.modelSha256,
    reference: { asset: structuredClone(input.referenceAsset), base64: Buffer.from(input.referenceBytes).toString("base64") },
    output: { asset: structuredClone(input.outputAsset), base64: Buffer.from(input.outputBytes).toString("base64") },
    ...(wardrobe?{wardrobe:{asset:structuredClone(wardrobe.asset),base64:Buffer.from(wardrobe.bytes).toString("base64"),selections:structuredClone(wardrobe.selections)}}:{}) };
  return { ...data, requestSha256: digest(JSON.stringify(data)) };
}
export function assessPhotoResponse(value: unknown, request: PhotoScoreRequest, policy: PhotoPolicy): PhotoScoreResult {
  const response=object(value,["schemaVersion","requestSha256","modelVersion","modelSha256","calibrationId","participants","imageScores"],"photo scorer response");
  const version=policy.protocolVersion===2?"v2":"v1";
  if(request.schemaVersion!==`ltm.photo-score.request.${version}` || response.schemaVersion !== `ltm.photo-score.response.${version}` || response.requestSha256 !== request.requestSha256 || response.modelVersion !== policy.modelVersion || response.modelSha256 !== policy.modelSha256 || response.calibrationId !== policy.id) return invalid("photo scorer model, calibration or request binding changed");
  const wardrobe = request.context.operation === "wardrobe";
  const imageDimensions = [...IMAGE_DIMENSIONS,...(policy.protocolVersion===2?["aestheticUsability"]:[]), ...(wardrobe ? ["garmentMatch","regionPreservation"] : [])];
  const image=object(response.imageScores,imageDimensions,"photo image scores");
  const scores: Record<string,number>={};
  for(const dimension of imageDimensions) scores[dimension]=bounded(image[dimension],0,1,dimension);
  if (!Array.isArray(response.participants) || response.participants.length !== request.people.length) return invalid("photo scorer participant coverage changed");
  const ages: PhotoScoreResult["ages"]=[], participantAssessments: PhotoScoreResult["participantAssessments"]=[];
  let uncertain=false;
  for(let index=0;index<request.people.length;index++) {
    const person=object(response.participants[index],["participantId","position","identity","estimatedAgeYears","ageConfidence","facialDrift",...(wardrobe?["garmentMatch"]:[])],"photo participant");
    const expected=request.people[index]!;
    if(person.participantId!==expected.participantId || person.position!==expected.position) return invalid("photo scorer participant order or position changed");
    const age=bounded(person.estimatedAgeYears,0,120,"estimated age"), confidence=bounded(person.ageConfidence,0,1,"age confidence");
    const reliable=confidence>=policy.minimumAgeConfidence;
    uncertain ||= !reliable;
    const individual: Record<string,number>={identity:bounded(person.identity,0,1,"identity"),ageRange:reliable?Math.max(0,1-Math.abs(age-request.targetAge)/policy.ageToleranceYears):0,facialDrift:bounded(person.facialDrift,0,1,"facial drift"),...(wardrobe?{garmentMatch:bounded(person.garmentMatch,0,1,"garment match")}:{})};
    participantAssessments.push({participantId:expected.participantId,scores:individual,thresholds:Object.fromEntries(Object.keys(individual).map(key=>[key,policy.thresholds[key]!]))});
    ages.push({participantId:expected.participantId,estimatedAgeYears:age,confidence});
  }
  for(const dimension of ["identity","ageRange","facialDrift"]) scores[dimension]=Math.min(...participantAssessments.map(person=>person.scores[dimension]!));
  if(wardrobe) scores.garmentMatch=Math.min(scores.garmentMatch!,...participantAssessments.map(person=>person.scores.garmentMatch!));
  const failedDimensions=Object.keys(scores).filter(key=>scores[key]!<policy.thresholds[key]!);
  const aestheticOnly=failedDimensions.length===1&&failedDimensions[0]==="aestheticUsability";
  return {scores,thresholds:structuredClone(policy.thresholds),participantAssessments,ages,decision:uncertain||aestheticOnly?"review":failedDimensions.length?"retry":"pass",failedDimensions,modelVersion:policy.modelVersion};
}
