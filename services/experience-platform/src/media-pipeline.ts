import { createHash, sign, verify } from "node:crypto";
import { clone, digest, ExperienceError, minor, required, unique } from "./common.js";

export interface GenerationNode {readonly id:string;readonly targetAge:number;readonly qualityTier:"standard"|"premium";readonly templateVariant:string;}
export interface GenerationPlan {readonly id:string;readonly version:number;readonly projectId:string;readonly participantId:string;readonly currentAge:number;readonly sourceAssetId:string;readonly consentId:string;readonly nodes:readonly GenerationNode[];readonly identityPolicyVersion:string;readonly posePolicyVersion:string;readonly backgroundPolicyVersion:string;readonly wardrobePolicyVersion:string;readonly lightingPolicyVersion:string;readonly negativePolicyVersion:string;readonly compositionStrategy:string;readonly creativeBackcastDisclosure:boolean;}
export interface NodeOutput {readonly id:string;readonly planId:string;readonly planVersion?:number;readonly nodeId:string;readonly sourceAssetId:string;readonly consentId:string;readonly modelVersion:string;readonly seed:string;readonly replayParametersSha256:string;readonly promptPolicyVersion:string;readonly costMinor:number;readonly qualityResultId:string;readonly traceId:string;readonly state:"publishable"|"blocked";readonly blockReason?:string;}
export class AgeTimelineService{
  readonly #plans=new Map<string,GenerationPlan>();readonly #outputs=new Map<string,NodeOutput>();
  create(plan:GenerationPlan):GenerationPlan {
    required(plan.id,"plan id");required(plan.participantId,"participantId");required(plan.sourceAssetId,"sourceAssetId");required(plan.consentId,"consentId");required(plan.compositionStrategy,"composition strategy");
    if(!Number.isSafeInteger(plan.version)||plan.version<1||!Number.isInteger(plan.currentAge)||plan.currentAge<0||plan.currentAge>120)throw new ExperienceError("VALIDATION_FAILED","generation plan version or current age is invalid");
    unique(plan.nodes.map((node)=>node.id),"generation nodes");
    if(new Set(plan.nodes.map((node)=>node.targetAge)).size!==plan.nodes.length)throw new ExperienceError("VALIDATION_FAILED","target ages must be unique");
    for(const node of plan.nodes)if(!Number.isInteger(node.targetAge)||node.targetAge<0||node.targetAge>100)throw new ExperienceError("VALIDATION_FAILED","target age is invalid");
    if(plan.nodes.some((node)=>node.targetAge<plan.currentAge)&&!plan.creativeBackcastDisclosure)throw new ExperienceError("POLICY_BLOCKED","creative backcast requires an explicit illustrative disclosure");
    for(const version of [plan.identityPolicyVersion,plan.posePolicyVersion,plan.backgroundPolicyVersion,plan.wardrobePolicyVersion,plan.lightingPolicyVersion,plan.negativePolicyVersion])required(version,"generation policy version");
    const key=`${plan.id}@${plan.version}`;
    if(this.#plans.has(key))throw new ExperienceError("CONFLICT","generation plan version already exists");
    const value=Object.freeze(clone(plan));this.#plans.set(key,value);
    return Object.freeze(clone(value));
  }
  recordOutput(output:NodeOutput):NodeOutput {
    const plan=this.#plan(output.planId,output.planVersion);
    if(!plan.nodes.some((node)=>node.id===output.nodeId))throw new ExperienceError("NOT_FOUND","generation node does not exist");
    if(output.sourceAssetId!==plan.sourceAssetId||output.consentId!==plan.consentId)throw new ExperienceError("CONSENT_REQUIRED","output is not bound to the plan source and authorization");
    for(const value of [output.id,output.modelVersion,output.seed,output.promptPolicyVersion,output.qualityResultId,output.traceId])required(value,"output provenance");
    if(!/^[a-f0-9]{64}$/u.test(output.replayParametersSha256))throw new ExperienceError("VALIDATION_FAILED","replay parameter digest is invalid");
    minor(output.costMinor,"output cost");
    if(output.state!=="publishable"&&output.state!=="blocked")throw new ExperienceError("VALIDATION_FAILED","output state is invalid");
    if(output.state==="blocked")required(output.blockReason??"","blocked output reason");
    if(this.#outputs.has(output.id))throw new ExperienceError("CONFLICT","output id already exists");
    const value=Object.freeze({...clone(output),planVersion:plan.version});
    this.#outputs.set(output.id,value);return value;
  }
  delivery(planId:string,planVersion?:number):Readonly<{ready:readonly string[];missing:readonly {nodeId:string;remedy:"retry"|"refund"}[];state:"ready"|"partial"|"blocked"}> {
    const plan=this.#plan(planId,planVersion);
    const latest=new Map<string,NodeOutput>();
    for(const output of this.#outputs.values())if(output.planId===planId&&output.planVersion===plan.version)latest.set(output.nodeId,output);
    const ready=plan.nodes.filter((node)=>latest.get(node.id)?.state==="publishable").map((node)=>node.id);
    const missing=plan.nodes.filter((node)=>latest.get(node.id)?.state!=="publishable").map((node)=>({nodeId:node.id,remedy:latest.get(node.id)?.state==="blocked"?"refund" as const:"retry" as const}));
    return Object.freeze({ready:Object.freeze(ready),missing:Object.freeze(missing),state:missing.length===0?"ready":ready.length>0?"partial":"blocked"});
  }
  #plan(planId:string,version?:number):GenerationPlan {
    if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new ExperienceError("VALIDATION_FAILED","plan version is invalid");
    const plans=[...this.#plans.values()].filter((plan)=>plan.id===planId&&(version===undefined||plan.version===version));
    if(plans.length===0)throw new ExperienceError("NOT_FOUND","generation plan does not exist");
    if(plans.length!==1)throw new ExperienceError("CONFLICT","planVersion is required when multiple plan versions exist");
    return plans[0] as GenerationPlan;
  }
}

export type QualityDimension="identity_similarity"|"target_age"|"feature_drift"|"pose_consistency"|"background_consistency"|"artifact"|"hands_teeth_eyes"|"sharpness"|"aesthetic_usability"|"photorealism";
export interface QualityScores{readonly identity_similarity:number;readonly target_age:number;readonly feature_drift:number;readonly pose_consistency:number;readonly background_consistency:number;readonly artifact:number;readonly hands_teeth_eyes:number;readonly sharpness:number;readonly aesthetic_usability:number;readonly photorealism:number;}
export interface QualityContext{readonly participantMode:"single"|"multi";readonly ageSpan:"short"|"long";readonly provider:string;readonly template:string;readonly channel:string;}
export interface QualityReference {readonly referenceArtifact:Uint8Array;readonly targetAge:number;}
export interface QualityEvaluator{evaluate(artifact:Uint8Array,reference:QualityReference):Promise<{readonly scores:QualityScores;readonly modelVersion:string}>;}
export interface QualityThreshold{readonly context:QualityContext;readonly minimums:QualityScores;readonly maxRetries:number;readonly retryCostCapMinor:number;}
export interface QualityDecision{readonly id:string;readonly passed:boolean;readonly failedDimensions:readonly QualityDimension[];readonly route:"publish"|"retry"|"alternate_provider"|"local_repair"|"human_review"|"stop_model_template";readonly modelVersion:string;readonly scores:QualityScores;readonly minimums:QualityScores;readonly referenceSha256:string;readonly outputSha256:string;readonly targetAge:number;readonly override?:Readonly<{actorId:string;reason:string}>;}
const QUALITY_DIMENSIONS:readonly QualityDimension[]=["identity_similarity","target_age","feature_drift","pose_consistency","background_consistency","artifact","hands_teeth_eyes","sharpness","aesthetic_usability","photorealism"];
function validateQualityScores(scores:QualityScores):void {
  if(scores===null||typeof scores!=="object"||Object.keys(scores).length!==QUALITY_DIMENSIONS.length||
    QUALITY_DIMENSIONS.some((dimension)=>!Object.hasOwn(scores,dimension)||!Number.isFinite(scores[dimension])||scores[dimension]<0||scores[dimension]>1)) {
    throw new ExperienceError("VALIDATION_FAILED","every quality dimension must be present, finite and between zero and one");
  }
}
export class QualityGateService{
  readonly #thresholds=new Map<string,QualityThreshold>();readonly #regressions=new Map<string,number[]>();constructor(readonly evaluator:QualityEvaluator){}
  calibrate(threshold:QualityThreshold):void {
    validateQualityScores(threshold.minimums);
    const key=contextKey(threshold.context);
    if(!Number.isSafeInteger(threshold.maxRetries)||threshold.maxRetries<0||threshold.maxRetries>5)throw new ExperienceError("VALIDATION_FAILED","quality calibration is invalid");
    minor(threshold.retryCostCapMinor,"quality retry cap");
    this.#thresholds.set(key,Object.freeze(clone(threshold)));
  }
  async evaluate(input:QualityReference & {readonly id:string;readonly artifact:Uint8Array;readonly context:QualityContext;readonly attempt:number;readonly spentMinor:number;readonly override?:{readonly actorId:string;readonly reason:string}}):Promise<QualityDecision> {
    required(input.id,"quality decision id");
    if(!Number.isSafeInteger(input.attempt)||input.attempt<0||!Number.isInteger(input.targetAge)||input.targetAge<0||input.targetAge>100||
       !(input.artifact instanceof Uint8Array)||input.artifact.byteLength===0||!(input.referenceArtifact instanceof Uint8Array)||input.referenceArtifact.byteLength===0) {
      throw new ExperienceError("VALIDATION_FAILED","quality evaluation requires output, original reference, target age and non-negative attempt");
    }
    minor(input.spentMinor,"quality spent cost");
    const {id,targetAge,attempt,spentMinor}=input;
    const context=clone(input.context);
    const override=input.override===undefined?undefined:clone(input.override);
    const threshold=this.#thresholds.get(contextKey(context));
    if(threshold===undefined)throw new ExperienceError("POLICY_BLOCKED","quality context is not calibrated");
    // Snapshot bytes before asynchronous inference so caller/evaluator mutation cannot rebind evidence.
    const artifact=Uint8Array.from(input.artifact), referenceArtifact=Uint8Array.from(input.referenceArtifact);
    const referenceSha256=createHash("sha256").update(referenceArtifact).digest("hex");
    const outputSha256=createHash("sha256").update(artifact).digest("hex");
    const result=await this.evaluator.evaluate(artifact,{referenceArtifact,targetAge});
    if(createHash("sha256").update(referenceArtifact).digest("hex")!==referenceSha256||
       createHash("sha256").update(artifact).digest("hex")!==outputSha256) {
      throw new ExperienceError("VALIDATION_FAILED","quality evaluator mutated the bound input bytes");
    }
    validateQualityScores(result.scores);
    if(typeof result.modelVersion!=="string")throw new ExperienceError("VALIDATION_FAILED","quality model version is missing");
    required(result.modelVersion,"quality model version");
    const failed=QUALITY_DIMENSIONS.filter((dimension)=>result.scores[dimension]<threshold.minimums[dimension]);
    const retryAvailable=attempt<threshold.maxRetries&&spentMinor<threshold.retryCostCapMinor;
    let route:QualityDecision["route"]=failed.length===0?"publish":retryAvailable?"retry":"human_review";
    const regressionKey=contextKey(context);
    const history=this.#regressions.get(regressionKey)??[];
    history.push(failed.length===0?1:0);if(history.length>20)history.shift();this.#regressions.set(regressionKey,history);
    if(history.length>=10&&history.reduce((sum,value)=>sum+value,0)/history.length<.7)route="stop_model_template";
    if(override!==undefined) {
      required(override.actorId,"quality override actor");required(override.reason,"quality override reason");
      if(route==="stop_model_template"||failed.some((dimension)=>["identity_similarity","target_age","feature_drift","artifact","hands_teeth_eyes","photorealism"].includes(dimension))) {
        throw new ExperienceError("POLICY_BLOCKED","critical quality failures or an open quality circuit cannot be overridden");
      }
      route="publish";
    }
    return Object.freeze({id,passed:route==="publish",failedDimensions:Object.freeze(failed),route,modelVersion:result.modelVersion,
      scores:Object.freeze(clone(result.scores)),minimums:Object.freeze(clone(threshold.minimums)),referenceSha256,outputSha256,targetAge,
      ...(override===undefined?{}:{override:Object.freeze(override)})});
  }
}

export interface VideoRenderGraph{readonly id:string;readonly keyframeIds:readonly string[];readonly transition:"interpolate"|"fade";readonly cameraMotion:"none"|"pan"|"zoom";readonly durationSeconds:number;readonly coverAssetId:string;readonly endingCard:string;readonly brandId:string;readonly aiLabel:string;readonly narration?:Readonly<{voiceId:string;voiceClone:boolean;consentId?:string}>;readonly musicAssetId?:string;readonly captionTrackIds:readonly string[];readonly locales:readonly string[];readonly outputs:readonly("mobile_share"|"hd_download"|"studio_screen"|"print_qr")[];readonly masterAssetId:string;readonly licenses:readonly {assetId:string;licenseId:string;regions:readonly string[]}[];}
export interface VideoRenderer{render(graph:VideoRenderGraph,idempotencyKey:string):Promise<{readonly artifactId:string;readonly identityScore:number;readonly flicker:number;readonly opticalFlow:number;readonly cutShock:number}>;}
export class VideoPipelineService{
  readonly #renders=new Map<string,{fingerprint:string;artifactId:string;graph:VideoRenderGraph}>();constructor(readonly renderer:VideoRenderer){}
  async render(graph:VideoRenderGraph,idempotencyKey:string,region:string):Promise<Readonly<{artifactId:string;transition:VideoRenderGraph["transition"];masterAssetId:string}>>{required(graph.id,"video graph id");required(idempotencyKey,"video idempotencyKey");unique(graph.keyframeIds,"video keyframes");unique(graph.captionTrackIds,"caption tracks");unique(graph.locales,"video locales");unique(graph.outputs,"video outputs");if(!/AI|人工智能/iu.test(graph.aiLabel))throw new ExperienceError("POLICY_BLOCKED","video requires a visible AI label");if(graph.narration?.voiceClone===true&&graph.narration.consentId===undefined)throw new ExperienceError("CONSENT_REQUIRED","voice cloning requires separate consent");if(graph.licenses.some((license)=>!license.regions.includes(region)))throw new ExperienceError("POLICY_BLOCKED","video asset license does not cover the target region");const key=idempotencyKey;const fingerprint=digest(graph);const prior=this.#renders.get(key);if(prior!==undefined){if(prior.fingerprint!==fingerprint)throw new ExperienceError("CONFLICT","video idempotency key was reused");return Object.freeze({artifactId:prior.artifactId,transition:prior.graph.transition,masterAssetId:prior.graph.masterAssetId});}let rendered=await this.renderer.render(graph,key);let appliedGraph=graph;if(rendered.identityScore<.75||rendered.flicker>.2||rendered.opticalFlow>.3||rendered.cutShock>.3){appliedGraph=Object.freeze({...clone(graph),transition:"fade" as const,cameraMotion:"none" as const});rendered=await this.renderer.render(appliedGraph,`${key}:safe-fade`);if(rendered.identityScore<.75||rendered.flicker>.2)throw new ExperienceError("POLICY_BLOCKED","safe fade rendering still failed identity or flicker gates");}this.#renders.set(key,{fingerprint,artifactId:rendered.artifactId,graph:appliedGraph});return Object.freeze({artifactId:rendered.artifactId,transition:appliedGraph.transition,masterAssetId:graph.masterAssetId});}
}

export type SafetyCategory="nonconsensual_intimate"|"sexualized_minor"|"violence"|"hate"|"fraud"|"public_figure_impersonation"|"rights_dispute";
export interface SafetyModerator{moderate(input:Uint8Array,stage:"input"|"output"):Promise<{readonly blocked:readonly SafetyCategory[];readonly riskScore:number;readonly modelVersion:string}>;}
export interface ProvenanceManifest{readonly artifactId:string;readonly traceId:string;readonly aiGenerated:true;readonly provider:string;readonly inputSha256:string;readonly outputSha256:string;readonly policyVersion:string;readonly issuedAt:string;readonly signature:string;}
export class SafetyProvenanceService{
  readonly #risks=new Map<string,number[]>();readonly #takedowns=new Map<string,{state:"temporarily_removed"|"restored"|"permanently_deleted";policyVersion:string;reason:string}>();constructor(readonly moderator:SafetyModerator,readonly privateKeyPem:string,readonly publicKeyPem:string,readonly now:()=>Date=()=>new Date()){}
  async certify(input:{readonly artifactId:string;readonly input:Uint8Array;readonly output:Uint8Array;readonly traceId:string;readonly policyVersion:string;readonly model:string;readonly template:string;readonly channel:string;readonly sourceKind:"self_photo"|"public_figure"|"stranger"|"screenshot"|"media_asset";readonly enhancedAuthorization:boolean}):Promise<ProvenanceManifest>{if(input.sourceKind!=="self_photo"&&!input.enhancedAuthorization)throw new ExperienceError("CONSENT_REQUIRED","high-risk source requires enhanced authorization");const [before,after]=await Promise.all([this.moderator.moderate(input.input,"input"),this.moderator.moderate(input.output,"output")]);if(before.blocked.length>0||after.blocked.length>0)throw new ExperienceError("POLICY_BLOCKED",`safety moderation blocked ${[...before.blocked,...after.blocked].join(",")}`);const riskKey=`${input.model}:${input.template}:${input.channel}`;const history=this.#risks.get(riskKey)??[];history.push(Math.max(before.riskScore,after.riskScore));if(history.length>20)history.shift();this.#risks.set(riskKey,history);if(history.length>=5&&history.reduce((sum,value)=>sum+value,0)/history.length>.6)throw new ExperienceError("POLICY_BLOCKED","model/template/channel safety circuit breaker is open");const unsigned={artifactId:input.artifactId,traceId:input.traceId,aiGenerated:true as const,provider:"Life Time Machine",inputSha256:digest(Buffer.from(input.input).toString("base64")),outputSha256:digest(Buffer.from(input.output).toString("base64")),policyVersion:input.policyVersion,issuedAt:this.now().toISOString()};return Object.freeze({...unsigned,signature:sign(null,Buffer.from(JSON.stringify(unsigned),"utf8"),this.privateKeyPem).toString("base64")});}
  verify(manifest:ProvenanceManifest):boolean{const {signature,...unsigned}=manifest;return manifest.aiGenerated&&verify(null,Buffer.from(JSON.stringify(unsigned),"utf8"),this.publicKeyPem,Buffer.from(signature,"base64"));}
  takedown(artifactId:string,input:{readonly action:"report"|"restore"|"delete";readonly policyVersion:string;readonly reason:string;readonly reviewerId:string}):void{required(input.reason,"takedown reason");required(input.reviewerId,"takedown reviewer");const state=input.action==="report"?"temporarily_removed":input.action==="restore"?"restored":"permanently_deleted";const prior=this.#takedowns.get(artifactId);if(prior?.state==="permanently_deleted"&&state!=="permanently_deleted")throw new ExperienceError("POLICY_BLOCKED","permanently deleted artifact cannot be restored");this.#takedowns.set(artifactId,{state,policyVersion:input.policyVersion,reason:input.reason});}
}

export interface GenerationCostInput{readonly nodes:number;readonly megapixels:number;readonly videoSeconds:number;readonly provider:string;readonly retryBudget:number;readonly revenueShareBasisPoints:number;}
export interface QuotaKey{readonly tenantId:string;readonly userId:string;readonly campaignId:string;readonly provider:string;readonly model:string;}
export class GenerationEconomicsService{
  readonly #budgets=new Map<string,{dailyMinor:number;concurrency:number;usedMinor:number;active:number;day:string}>();readonly #cache=new Map<string,string>();readonly #actualCosts=new Map<string,Readonly<Record<string,number>>>();readonly #latencies=new Map<string,number[]>();constructor(readonly now:()=>Date=()=>new Date()){}
  estimate(input:GenerationCostInput):number{if(!Number.isInteger(input.nodes)||input.nodes<1||!Number.isFinite(input.megapixels)||input.megapixels<=0||!Number.isInteger(input.videoSeconds)||input.videoSeconds<0||!Number.isInteger(input.retryBudget)||input.retryBudget<0||input.revenueShareBasisPoints<0||input.revenueShareBasisPoints>10000)throw new ExperienceError("VALIDATION_FAILED","generation cost dimensions are invalid");return Math.ceil(input.nodes*30+input.megapixels*12+input.videoSeconds*4+input.retryBudget*20+(input.nodes*30*input.revenueShareBasisPoints)/10000);}
  configure(key:QuotaKey,dailyMinor:number,concurrency:number):void{minor(dailyMinor,"daily generation budget");if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new ExperienceError("VALIDATION_FAILED","generation concurrency is invalid");this.#budgets.set(quotaKey(key),{dailyMinor,concurrency,usedMinor:0,active:0,day:this.now().toISOString().slice(0,10)});}
  reserve(key:QuotaKey,estimatedMinor:number):"reserved"|"queued"{minor(estimatedMinor,"generation estimate");const budget=this.#budget(key);this.#rollDay(budget);if(budget.usedMinor+estimatedMinor>budget.dailyMinor)return "queued";if(budget.active>=budget.concurrency)return "queued";budget.usedMinor+=estimatedMinor;budget.active+=1;return "reserved";}
  complete(key:QuotaKey,operationId:string,costs:Readonly<Record<"tokens"|"images"|"video"|"storage"|"bandwidth"|"human_review",number>>,latencyMs:number):void{const budget=this.#budget(key);if(budget.active<1)throw new ExperienceError("CONFLICT","generation operation was not reserved");for(const value of Object.values(costs))minor(value,"actual generation cost");if(!Number.isFinite(latencyMs)||latencyMs<0)throw new ExperienceError("VALIDATION_FAILED","latency is invalid");budget.active-=1;this.#actualCosts.set(operationId,Object.freeze(clone(costs)));const history=this.#latencies.get(key.provider)??[];history.push(latencyMs);if(history.length>1000)history.shift();this.#latencies.set(key.provider,history);}
  cacheKey(input:{readonly participantId:string;readonly consentId:string;readonly policySha256:string;readonly parameters:unknown}):string{required(input.participantId,"cache participant");required(input.consentId,"cache consent");if(!/^[a-f0-9]{64}$/u.test(input.policySha256))throw new ExperienceError("VALIDATION_FAILED","cache policy digest is invalid");return digest(input);}
  putCache(key:string,artifactId:string):void{this.#cache.set(key,artifactId);}getCache(key:string):string|undefined{return this.#cache.get(key);}
  latency(provider:string):Readonly<{p50:number;p95:number;p99:number}>{const values=[...(this.#latencies.get(provider)??[])].sort((a,b)=>a-b);if(values.length===0)throw new ExperienceError("NOT_FOUND","provider has no latency observations");const at=(p:number)=>values[Math.min(values.length-1,Math.floor(values.length*p))] as number;return Object.freeze({p50:at(.5),p95:at(.95),p99:at(.99)});}
  #budget(key:QuotaKey){const value=this.#budgets.get(quotaKey(key));if(value===undefined)throw new ExperienceError("POLICY_BLOCKED","generation quota is not configured for the exact tenant/user/campaign/provider/model tuple");return value;}#rollDay(budget:{day:string;usedMinor:number}){const day=this.now().toISOString().slice(0,10);if(budget.day!==day){budget.day=day;budget.usedMinor=0;}}
}
function contextKey(context:QualityContext):string{return `${context.participantMode}:${context.ageSpan}:${context.provider}:${context.template}:${context.channel}`;}
function quotaKey(key:QuotaKey):string{return `${key.tenantId}:${key.userId}:${key.campaignId}:${key.provider}:${key.model}`;}
