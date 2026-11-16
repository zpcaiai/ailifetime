import{readFileSync,writeFileSync,realpathSync,lstatSync}from'node:fs';
import { createHash } from "node:crypto";
import{resolve,relative,isAbsolute,sep}from'node:path';
import{fileURLToPath}from'node:url';
import{parseArgs}from'node:util';
const DEFAULT_PROJECT=fileURLToPath(new URL('..',import.meta.url));
function origin(value){
 if(typeof value!=='string'||value!==value.trim()||value.length>1024)throw Error('API_ORIGIN_INVALID');
 let u;try{u=new URL(value);}catch{throw Error('API_ORIGIN_INVALID');}
 const h=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||
  !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)||/(?:^|\.)(?:localhost|local|test|invalid|example)$/.test(h))throw Error('API_ORIGIN_INVALID');
 return u.origin;
}
function projectConfig(project) {
 const root=realpathSync(project),config=JSON.parse(readFileSync(resolve(root,'project.config.json'),'utf8'));
 if(config.compileType!=='miniprogram'||!/^wx[a-f0-9]{16}$/.test(config.appid)||config.setting?.urlCheck!==true||config.__usePrivacyCheck__!==true)throw Error('PROJECT_CONFIGURATION_INVALID');
 const program=realpathSync(resolve(root,config.miniprogramRoot)),inside=relative(root,program);
 if(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw Error('MINIPROGRAM_ROOT_OUTSIDE_PROJECT');
 return { appId: config.appid, path: resolve(program, "ext.json") };
}

function readConfiguration({ path, appId }, expectedOrigin) {
 const existingFile = lstatSync(path, { throwIfNoEntry: false });
 if (!existingFile) return null;
 if (!existingFile.isFile() || existingFile.size > 16_384) throw Error("EXT_CONFIGURATION_UNSAFE");
 const bytes = readFileSync(path);
 let existing;
 try { existing = JSON.parse(bytes); } catch { throw Error("EXT_CONFIGURATION_INVALID"); }
 const api = existing?.ext?.apiBaseUrl;
 if (existing?.extEnable !== true || existing.extAppid !== appId ||
     (expectedOrigin !== undefined && expectedOrigin !== api)) {
   throw Error("EXT_CONFIGURATION_EXISTS");
 }
 const allowedOrigins = existing.ext?.apiAllowedOrigins;
 if (!isCanonicalOrigin(api) || !Array.isArray(allowedOrigins) ||
     allowedOrigins.length < 1 || allowedOrigins.length > 16 ||
     !allowedOrigins.includes(api) || !allowedOrigins.every(isCanonicalOrigin)) {
   throw Error("EXT_CONFIGURATION_ALLOWLIST_INVALID");
 }
 return { existing, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function isCanonicalOrigin(value) {
 try { return origin(value) === value; } catch { return false; }
}

export function readVerifiedApiConfiguration(project, expectedAppId) {
 const config = projectConfig(project);
 if (config.appId !== expectedAppId) throw Error("RELEASE_PROJECT_APP_ID_MISMATCH");
 const result = readConfiguration(config);
 if (!result) throw Error("RELEASE_API_CONFIGURATION_REQUIRED");
 if (Object.keys(result.existing).some(key => !["extEnable", "extAppid", "ext"].includes(key)) ||
     Object.keys(result.existing.ext).some(key => !["apiBaseUrl", "apiAllowedOrigins"].includes(key))) {
   throw Error("RELEASE_API_CONFIGURATION_UNEXPECTED_FIELDS");
 }
 return { apiOrigin: result.existing.ext.apiBaseUrl, sha256: result.sha256 };
}

export async function probeApiReadiness(apiOrigin, fetcher = globalThis.fetch) {
 const endpoint = new URL("/health/ready", origin(apiOrigin));
 const maxBytes = 16_384;
 let body;
 try {
   const response = await fetcher(endpoint, {
     method: "GET",
     headers: { accept: "application/json", "cache-control": "no-cache" },
     cache: "no-store",
     redirect: "error",
     signal: AbortSignal.timeout(5_000),
   });
   body = response.body?.getReader();
   if (response.status !== 200 || !body ||
       !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
     throw Error("API_NOT_READY");
   }
   const chunks = [];
   let bytes = 0;
   for (let result = await body.read(); !result.done; result = await body.read()) {
     bytes += result.value.byteLength;
     if (bytes > maxBytes) throw Error("API_NOT_READY");
     chunks.push(result.value);
   }
   const readiness = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
   if (readiness?.ready !== true) throw Error("API_NOT_READY");
   return Object.freeze({ apiOrigin: endpoint.origin, httpStatus: response.status, checkedAt: new Date().toISOString() });
 } catch {
   throw Error("EXPERIENCE_API_NOT_READY");
 } finally {
   if (body) void body.cancel().catch(() => {});
 }
}

export function configureApi({project=DEFAULT_PROJECT,apiBaseUrl}={}){
 const api = origin(apiBaseUrl);
 const config = projectConfig(project);
 const { path, appId } = config;
 const created = readConfiguration(config, api) === null;
 if (created) {
   const payload = { extEnable: true, extAppid: appId, ext: { apiBaseUrl: api, apiAllowedOrigins: [api] } };
   writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { flag: "wx", mode: 0o600 });
 }
 return{path,created,apiBaseUrl:api,domainEnrollment:'NOT_VERIFIED',nativeLogin:'NOT_RUN'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const{values}=parseArgs({options:{project:{type:'string'},'api-base-url':{type:'string'}}});
 console.log(JSON.stringify(configureApi({project:values.project,apiBaseUrl:values['api-base-url']})));
}
