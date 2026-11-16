import { timingSafeEqual } from "node:crypto";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage,ServerResponse,Server } from "node:http";
import { Pool } from "pg";
import { PostgresLifeTimeMachineRuntime } from "@ltm/core";
import { createCapabilityRegistry,externalBusinessEventReducerRegistry } from "@ltm/capabilities";
import { createApiServer } from "./server.js";
import { B127_PRODUCTION_RELEASE_AUTHORITY_ROLE, loadApiConfiguration } from "./config.js";
import { ProductionDomainRuntime } from "./domain-runtime.js";
import { PostgresGeneratedMedia } from "./generated-media.js";
import { PrivateS3Images } from "./private-s3.js";
import { PHOTO_PRICE_VERSION,PHOTO_PRODUCTS } from "./photo-catalog.js";
import { configuredPhotoScoring } from "./photo-score-config.js";
import { TimelinePhotoQualityService } from "./timeline-photo-quality.js";
import { configuredSeedream } from "./seedream-config.js";
import { drainExpiredMedia } from "./media-cleanup.js";

function json(response: ServerResponse,status: number,body: unknown): void {
  response.statusCode=status;response.setHeader("content-type","application/json; charset=utf-8");response.setHeader("cache-control","private, no-store");response.end(JSON.stringify(body));
}
function required(env: NodeJS.ProcessEnv,key: string): string {
  const value=env[key];if (!value?.trim()) throw new Error("CONFIGURATION_INVALID");return value;
}
function cronAllowed(request: IncomingMessage,env: NodeJS.ProcessEnv): boolean {
  const secret=env.CRON_SECRET,actual=request.headers.authorization;
  if (!secret || secret.length<32 || !actual) return false;
  const expected=Buffer.from(`Bearer ${secret}`),provided=Buffer.from(actual);
  return provided.length===expected.length && timingSafeEqual(provided,expected);
}
/** Vercel environment values become bounded private files. The existing loaders
 * still validate signatures, trust, policy calibration and credential format. */
export async function materializeVercelConfiguration(environment: NodeJS.ProcessEnv) {
  const env={...environment};let directory: string|undefined;
  const mappings: readonly (readonly [string,string,number,boolean])[] = [
    ...["LTM_WECHAT_IDENTITY_TOKEN","LTM_WECHAT_PLATFORM_BROKER_TOKEN","LTM_UPLOAD_BROKER_TOKEN","LTM_PHOTO_SCORER_TOKEN"].map(name=>[name,`${name}_FILE`,8192,false] as const),
    ["LTM_PHOTO_SCORER_POLICIES_JSON","LTM_PHOTO_SCORER_POLICY_FILE",512*1024,true],
    ["LTM_CONSENT_POLICY_CATALOG_JSON","LTM_CONSENT_POLICY_CATALOG_FILE",2*1024*1024,true],
  ];
  async function close() { if(directory) {await rm(directory,{recursive:true,force:true});directory=undefined;} }
  try {
    for (const [name,target,limit,jsonDocument] of mappings) {
      const value=env[name];if(value===undefined)continue;
      if(env[target]!==undefined || !value.trim() || Buffer.byteLength(value)>limit) throw new Error("CONFIGURATION_INVALID");
      if(jsonDocument) {try{JSON.parse(value);}catch{throw new Error("CONFIGURATION_INVALID");}}
      directory ??= await mkdtemp(join(tmpdir(),"ltm-vercel-secrets-"));
      const path=join(directory,target);await writeFile(path,value,{mode:0o600,flag:"wx"});env[target]=path;
      delete env[name];
    }
    return {environment:env,close};
  } catch(error) {await close();throw error;}
}
const photoStorageFields = ["ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"] as const;

export function vercelRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environment, APP_ENV: "production",
    LTM_DEPLOYMENT_PROFILE: "distributed", LTM_STATIC_DIR: "disabled" };
  if (environment.VERCEL_ENV === "preview" && environment.LTM_VERCEL_PREVIEW_PROFILE === "staging") {
    env.APP_ENV = "staging";
    env.DATABASE_URL = environment.LTM_MINIAPP_PREVIEW_DATABASE_URL;
    for (const field of photoStorageFields) {
      env[`LTM_PHOTO_S3_${field}`] = environment[`LTM_MINIAPP_PREVIEW_PHOTO_S3_${field}`];
    }
  }
  return env;
}

function verifyPreviewIsolation(env: NodeJS.ProcessEnv, configured: NodeJS.ProcessEnv): void {
  if (env.APP_ENV !== "staging") return;
  const database = new URL(required(env, "DATABASE_URL"));
  const storage = new URL(required(env, "LTM_PHOTO_S3_ENDPOINT"));
  for (const field of photoStorageFields) required(env, `LTM_PHOTO_S3_${field}`);
  const originalDatabase = configured.DATABASE_URL ? new URL(configured.DATABASE_URL) : undefined;
  const originalStorage = configured.LTM_PHOTO_S3_ENDPOINT ? new URL(configured.LTM_PHOTO_S3_ENDPOINT) : undefined;
  if (database.protocol !== "postgresql:" || !database.hostname || !database.username || database.pathname.length < 2 ||
      !database.password || database.hash || (database.port && database.port !== "5432") ||
      database.searchParams.getAll("sslmode").join(",") !== "verify-full" ||
      [...database.searchParams].some(([key, value]) => key !== "sslmode" &&
        !(key === "channel_binding" && value === "require")) ||
      (originalDatabase?.hostname === database.hostname && originalDatabase.pathname === database.pathname) ||
      storage.protocol !== "https:" || !storage.hostname || storage.username || storage.password ||
      storage.search || storage.hash || storage.pathname !== "/" ||
      (originalStorage?.origin === storage.origin && configured.LTM_PHOTO_S3_BUCKET === env.LTM_PHOTO_S3_BUCKET)) {
    throw new Error("STAGING_PREVIEW_CONFIGURATION_INVALID");
  }
}

export function loadVercelStartupConfiguration(
  env: NodeJS.ProcessEnv, productRoot: string, configured: NodeJS.ProcessEnv,
) {
  verifyPreviewIsolation(env, configured);
  if (env.APP_ENV !== "staging") return loadApiConfiguration(env, productRoot);
  if (env.VERCEL_ENV !== "preview" || env.LTM_VERCEL_PREVIEW_PROFILE !== "staging" ||
      env.LTM_AUTH_MODE !== "oidc") {
    throw new Error("STAGING_PREVIEW_CONFIGURATION_INVALID");
  }
  for (const name of ["LTM_WECHAT_IDENTITY_BROKER_URL", "LTM_WECHAT_PLATFORM_BROKER_URL", "LTM_UPLOAD_BROKER_URL"]) {
    const origin = new URL(required(env, name));
    if (origin.protocol !== "https:" || origin.username || origin.password ||
        origin.search || origin.hash || origin.pathname !== "/" || !origin.hostname.includes(".")) {
      throw new Error("STAGING_PREVIEW_BROKER_ORIGIN_INVALID");
    }
  }
  const configuration = loadApiConfiguration(env, productRoot);
  const runtime = configuration.postgresRuntimeOptions;
  const integrations = configuration.clientIntegrations;
  if (!runtime?.consentPolicyCatalog || runtime.evidenceEnvironment !== "staging" ||
      !runtime.trustedEvidenceKeys?.length || !configuration.metricsTokenSha256 ||
      !integrations.wechatIdentity || !integrations.wechatPlatform || !integrations.resumableUploads) {
    throw new Error("STAGING_PREVIEW_REQUIRED_DEPENDENCY_MISSING");
  }
  if (runtime.trustedEvidenceKeys.some((key) => key.allowedEnvironments.length !== 1 ||
      key.allowedEnvironments[0] !== "staging" || key.allowedScopes.some((scope) => scope.includes("*")) ||
      key.authorityRoles?.includes(B127_PRODUCTION_RELEASE_AUTHORITY_ROLE)) ||
      runtime.trustedConsentPolicyKeys?.some((key) => key.allowedEnvironments.length !== 1 ||
        key.allowedEnvironments[0] !== "staging")) {
    throw new Error("STAGING_PREVIEW_TRUST_SCOPE_INVALID");
  }
  return configuration;
}

export function createVercelHandler(environment: NodeJS.ProcessEnv,productRoot: string) {
  const env=vercelRuntimeEnvironment(environment);
  let api: Promise<{server: Server;close():Promise<void>}>|undefined;
  let materialized: Awaited<ReturnType<typeof materializeVercelConfiguration>>|undefined;
  let storage: {media:PostgresGeneratedMedia;pool:Pool;objects:PrivateS3Images}|undefined;
  function media() {
    if (storage) return storage;
    verifyPreviewIsolation(env, environment);
    const connectionString=required(env,"DATABASE_URL"),url=new URL(connectionString);
    if (url.searchParams.get("sslmode")!=="verify-full") throw new Error("CONFIGURATION_INVALID");
    const objects=new PrivateS3Images({endpoint:required(env,"LTM_PHOTO_S3_ENDPOINT"),region:required(env,"LTM_PHOTO_S3_REGION"),bucket:required(env,"LTM_PHOTO_S3_BUCKET"),accessKeyId:required(env,"LTM_PHOTO_S3_ACCESS_KEY_ID"),secretAccessKey:required(env,"LTM_PHOTO_S3_SECRET_ACCESS_KEY")});
    const pool=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10_000,statement_timeout:15_000,query_timeout:20_000,application_name:"ltm-vercel-media"});
    storage={media:new PostgresGeneratedMedia(pool,objects),pool,objects};return storage;
  }
  async function initialize() {
    materialized=await materializeVercelConfiguration(env);
    const effectiveEnv=materialized.environment;
    const configuration=loadVercelStartupConfiguration(effectiveEnv,productRoot,environment);
    if (!configuration.postgresRuntimeOptions) throw new Error("CONFIGURATION_INVALID");
    const runtime=await PostgresLifeTimeMachineRuntime.connect(configuration.postgresRuntimeOptions);
    let domain: ProductionDomainRuntime|undefined;
    let seedream: ReturnType<typeof configuredSeedream>;
    try {
      domain=new ProductionDomainRuntime(configuration.postgresRuntimeOptions.connectionString,{poolMax:2,applicationName:"ltm-vercel-domain"});
      seedream=configuredSeedream(effectiveEnv,configuration.appEnvironment,runtime);
      const artifacts=seedream?.media ?? media().media;
      const registry=createCapabilityRegistry(),scoring=configuredPhotoScoring(effectiveEnv,configuration.appEnvironment);
      const photoQuality=scoring===undefined?undefined:new TimelinePhotoQualityService(runtime,registry,artifacts,scoring.scorer,scoring.policies,scoring.channel);
      const server=createApiServer({runtime,authenticator:configuration.authenticator,capabilityRegistry:registry,externalBusinessEventReducerRegistry,
        appEnvironment:configuration.appEnvironment,clientIntegrations:configuration.clientIntegrations,timelineArtifacts:artifacts,domainRuntime:domain,staticDirectory:null,
        ...(photoQuality===undefined?{}:{photoQuality}),
        ...(seedream===undefined?{}:{seedream:seedream.generation,seedreamReadiness:seedream.readiness}),
        ...(configuration.metricsTokenSha256?{metricsTokenSha256:configuration.metricsTokenSha256}:{})});
      const activeDomain=domain;
      return {server,close:async()=>{await seedream?.close();await runtime.close();await activeDomain.close();}};
    }catch(error){await seedream?.close();await runtime.close();await domain?.close();throw error;}
  }
  async function handler(request: IncomingMessage,response: ServerResponse):Promise<void> {
    const url=new URL(request.url??"/","https://function.invalid");
    if (request.method==="GET" && url.pathname==="/health/live") {json(response,200,{status:"alive",runtime:process.version});return;}
    if (request.method==="GET" && url.pathname==="/v1/photo-products" && !url.search) {json(response,200,{data:{priceVersion:PHOTO_PRICE_VERSION,products:PHOTO_PRODUCTS}});return;}
    if (url.pathname==="/internal/media-cleanup") {
      if (!cronAllowed(request,env)) {json(response,401,{error:{code:"AUTH_REQUIRED"}});return;}
      if (request.method!=="GET" || url.search) {json(response,400,{error:{code:"VALIDATION_FAILED"}});return;}
      try {
        const result=await drainExpiredMedia(media().media);
        console.info(JSON.stringify({event:"media_cleanup",...result}));
        json(response,200,result);
      }
      catch {json(response,503,{error:{code:"MEDIA_CLEANUP_UNAVAILABLE"}});}return;
    }
    try {
      api ??= initialize().catch(async error=>{await materialized?.close();throw error;});
      const {server}=await api;
      if (request.method==="GET" && url.pathname==="/health/ready") {
        const photo=media();
        await photo.pool.query("SELECT asset_id FROM photo_service.media LIMIT 1");
        await photo.pool.query("SELECT idempotency_key FROM photo_service.generations LIMIT 1");
        await photo.objects.readiness();
      }
      server.emit("request",request,response);
      if (!response.writableFinished) await new Promise<void>(resolve=>{response.once("finish",resolve);response.once("close",resolve);});
    }catch {
      // Preserve a failed cold start. Do not reconnect, regenerate or report ready
      // repeatedly while the same deployment is missing its production config.
      json(response,503,{error:{code:"BACKEND_NOT_CONFIGURED"},status:"not_ready"});
    }
  }
  return {handler,close:async()=>{try{if(api)await api.then(v=>v.close(),()=>undefined);if(storage){storage.objects.close();await storage.pool.end();}}finally{await materialized?.close();}}};
}
