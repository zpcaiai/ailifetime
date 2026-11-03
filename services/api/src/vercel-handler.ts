import { timingSafeEqual } from "node:crypto";
import { mkdtemp,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage,ServerResponse,Server } from "node:http";
import { Pool } from "pg";
import { PostgresLifeTimeMachineRuntime } from "@ltm/core";
import { createCapabilityRegistry,externalBusinessEventReducerRegistry } from "@ltm/capabilities";
import { createApiServer } from "./server.js";
import { loadApiConfiguration } from "./config.js";
import { ProductionDomainRuntime } from "./domain-runtime.js";
import { PostgresGeneratedMedia } from "./generated-media.js";
import { PrivateS3Images } from "./private-s3.js";
import { PHOTO_PRICE_VERSION,PHOTO_PRODUCTS } from "./photo-catalog.js";
import { configuredPhotoScoring } from "./photo-score-config.js";
import { TimelinePhotoQualityService } from "./timeline-photo-quality.js";

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
async function secretFiles(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env={...environment};let directory: string|undefined;
  for (const name of ["LTM_WECHAT_IDENTITY_TOKEN","LTM_WECHAT_PLATFORM_BROKER_TOKEN","LTM_UPLOAD_BROKER_TOKEN"]) {
    if (!env[name] || env[`${name}_FILE`]) continue;
    directory ??= await mkdtemp(join(tmpdir(),"ltm-vercel-secrets-"));
    const path=join(directory,name);await writeFile(path,env[name],{mode:0o600,flag:"wx"});env[`${name}_FILE`]=path;
  }
  return env;
}
/** The production API's authentication, consent, evidence and payment gates are
 * reused intact. No listener, SQLite database, local media or background loop.
 */
export function createVercelHandler(environment: NodeJS.ProcessEnv,productRoot: string) {
  const env={...environment,APP_ENV:"production",LTM_DEPLOYMENT_PROFILE:"distributed",LTM_STATIC_DIR:"disabled"};
  let api: Promise<{server: Server;close():Promise<void>}>|undefined;
  let storage: {media:PostgresGeneratedMedia;pool:Pool;objects:PrivateS3Images}|undefined;
  function media() {
    if (storage) return storage;
    const connectionString=required(env,"DATABASE_URL"),url=new URL(connectionString);
    if (url.searchParams.get("sslmode")!=="verify-full") throw new Error("CONFIGURATION_INVALID");
    const objects=new PrivateS3Images({endpoint:required(env,"LTM_PHOTO_S3_ENDPOINT"),region:required(env,"LTM_PHOTO_S3_REGION"),bucket:required(env,"LTM_PHOTO_S3_BUCKET"),accessKeyId:required(env,"LTM_PHOTO_S3_ACCESS_KEY_ID"),secretAccessKey:required(env,"LTM_PHOTO_S3_SECRET_ACCESS_KEY")});
    const pool=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10_000,application_name:"ltm-vercel-media"});
    storage={media:new PostgresGeneratedMedia(pool,objects),pool,objects};return storage;
  }
  async function initialize() {
    const configuration=loadApiConfiguration(await secretFiles(env),productRoot);
    if (!configuration.postgresRuntimeOptions) throw new Error("CONFIGURATION_INVALID");
    const runtime=await PostgresLifeTimeMachineRuntime.connect(configuration.postgresRuntimeOptions);
    let domain: ProductionDomainRuntime|undefined;
    try {
      domain=new ProductionDomainRuntime(configuration.postgresRuntimeOptions.connectionString,{poolMax:2,applicationName:"ltm-vercel-domain"});
      const registry=createCapabilityRegistry(),scoring=configuredPhotoScoring(env,"production");
      const photoQuality=scoring===undefined?undefined:new TimelinePhotoQualityService(runtime,registry,media().media,scoring.scorer,scoring.policies,scoring.channel);
      const server=createApiServer({runtime,authenticator:configuration.authenticator,capabilityRegistry:registry,externalBusinessEventReducerRegistry,
        appEnvironment:"production",clientIntegrations:configuration.clientIntegrations,timelineArtifacts:media().media,domainRuntime:domain,staticDirectory:null,
        ...(photoQuality===undefined?{}:{photoQuality}),
        ...(configuration.metricsTokenSha256?{metricsTokenSha256:configuration.metricsTokenSha256}:{})});
      const activeDomain=domain;
      return {server,close:async()=>{await runtime.close();await activeDomain.close();}};
    }catch(error){await runtime.close();await domain?.close();throw error;}
  }
  async function handler(request: IncomingMessage,response: ServerResponse):Promise<void> {
    const url=new URL(request.url??"/","https://function.invalid");
    if (request.method==="GET" && url.pathname==="/health/live") {json(response,200,{status:"alive",runtime:process.version});return;}
    if (request.method==="GET" && url.pathname==="/v1/photo-products" && !url.search) {json(response,200,{data:{priceVersion:PHOTO_PRICE_VERSION,products:PHOTO_PRODUCTS}});return;}
    if (url.pathname==="/internal/media-cleanup") {
      if (!cronAllowed(request,env)) {json(response,401,{error:{code:"AUTH_REQUIRED"}});return;}
      if (request.method!=="GET" || url.search) {json(response,400,{error:{code:"VALIDATION_FAILED"}});return;}
      try {json(response,200,await media().media.cleanup(5));}
      catch {json(response,503,{error:{code:"MEDIA_CLEANUP_UNAVAILABLE"}});}return;
    }
    try {
      api ??= initialize();
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
  return {handler,close:async()=>{if(api)await api.then(v=>v.close(),()=>undefined);if(storage){storage.objects.close();await storage.pool.end();}}};
}
