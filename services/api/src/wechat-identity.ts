import { createHash,randomUUID,randomBytes,createCipheriv,createDecipheriv,timingSafeEqual } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { Pool,type PoolClient } from 'pg';
import { importJWK,SignJWT,jwtVerify,calculateJwkThumbprint,type JWK } from 'jose';

const PURPOSES=['age_transformation','sharing','privacy_rights','commerce','notifications','customer_support'];
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const identifier=(v:unknown,max=200):v is string=>typeof v==='string'&&v.length<=max&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
class IdentityError extends Error { constructor(readonly code:string,readonly status:number){super(code);} }
function reject(code:string,status=400):never{throw new IdentityError(code,status);}
function exact(v:unknown,keys:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))reject('VALIDATION_FAILED');
 return v as Record<string,unknown>;
}
function required(env:NodeJS.ProcessEnv,key:string):string{const v=env[key];if(!v||v!==v.trim())reject('IDENTITY_NOT_CONFIGURED',503);return v;}
function origin(v:string){const u=new URL(v);if(u.protocol!=='https:'||u.origin!==v||u.username||u.password)reject('IDENTITY_NOT_CONFIGURED',503);return v;}
interface Settings {appId:string;issuer:string;audience:string;consent:string;workloadDigest:string;key:Uint8Array;privateJwk:JWK;database:string;}
function settings(env:NodeJS.ProcessEnv):Settings{
 const appId=required(env,'LTM_WECHAT_APP_ID');if(!/^wx[a-f0-9]{16}$/.test(appId))reject('IDENTITY_NOT_CONFIGURED',503);
 const keyValue=required(env,'LTM_IDENTITY_ENCRYPTION_KEY'),key=Buffer.from(keyValue,'base64url');
 const workloadDigest=required(env,'LTM_IDENTITY_WORKLOAD_TOKEN_SHA256');
 const privateJwk=JSON.parse(required(env,'LTM_IDENTITY_SIGNING_JWK')) as JWK;
 const database=required(env,'DATABASE_URL'),u=new URL(database);
 const local=env.APP_ENV==='test'&&u.hostname==='127.0.0.1';
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.username||u.hash||(!local&&u.searchParams.get('sslmode')!=='verify-full')||
    key.length!==32||key.toString('base64url')!==keyValue||!/^[a-f0-9]{64}$/.test(workloadDigest)||
    privateJwk.kty!=='EC'||privateJwk.crv!=='P-256'||!privateJwk.d||!privateJwk.x||!privateJwk.y)reject('IDENTITY_NOT_CONFIGURED',503);
 const audience=required(env,'LTM_IDENTITY_AUDIENCE'),consent=required(env,'LTM_IDENTITY_CONSENT_VERSION');
 if(!identifier(audience)||!identifier(consent))reject('IDENTITY_NOT_CONFIGURED',503);
 return {appId,issuer:origin(required(env,'LTM_IDENTITY_ISSUER')),audience,consent,workloadDigest,key,privateJwk,database};
}
/** Separate WeChat identity authority. It never accepts caller-selected identities,
 * roles, tenants or purposes. Access JWTs expire in five minutes; the existing
 * API verifies them offline, so logout prevents refresh immediately and bounds
 * remaining access at the API by that expiry (not instantaneous revocation).
 */
export class WechatIdentityAuthority {
 private readonly pool:Pool;
 private readonly config:Settings;
 private readonly endpoint:URL;
 private readonly signing:Promise<Awaited<ReturnType<typeof importJWK>>>;
 private readonly publicJwk:JWK;
 private readonly kid:Promise<string>;
 private appSecret():string{
  const value=this.env.LTM_WECHAT_APP_SECRET;
  if(typeof value!=='string'||!value.trim())reject('WECHAT_APP_SECRET_MISSING',503);
  const secret=value.trim();
  if(secret.length<16||secret.length>512||/\s/.test(secret))reject('WECHAT_APP_SECRET_FORMAT_INVALID',503);
  return secret;
 }
 constructor(private readonly env:NodeJS.ProcessEnv,testEndpoint?:string){
  this.config=settings(env);this.endpoint=new URL('https://api.weixin.qq.com/sns/jscode2session');
  if(testEndpoint){const u=new URL(testEndpoint);if(env.APP_ENV!=='test'||u.origin!==testEndpoint||u.hostname!=='127.0.0.1'||u.protocol!=='http:')reject('IDENTITY_NOT_CONFIGURED',503);this.endpoint=new URL('/sns/jscode2session',u);}
  const {x,y}=this.config.privateJwk;this.publicJwk={kty:'EC',crv:'P-256',x:x!,y:y!,alg:'ES256',use:'sig'};
  this.kid=calculateJwkThumbprint(this.publicJwk);this.signing=importJWK(this.config.privateJwk,'ES256');
  this.pool=new Pool({connectionString:this.config.database,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,application_name:'ltm-wechat-identity'});
 }
 private seal(value:unknown,aad:string){
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.config.key,iv);c.setAAD(Buffer.from(this.config.appId+':'+aad));
  const bytes=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
  return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64url');
 }
 private open(value:string,aad:string):unknown{
  const bytes=Buffer.from(value,'base64url');if(bytes.length<29)reject('IDENTITY_UNAVAILABLE',503);
  const c=createDecipheriv('aes-256-gcm',this.config.key,bytes.subarray(0,12));c.setAAD(Buffer.from(this.config.appId+':'+aad));c.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString('utf8'));
 }
 private async transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL search_path=pg_catalog');await c.query("SELECT set_config('ltm_identity.app_id',$1,true)",[this.config.appId]);await c.query("SET LOCAL statement_timeout='10s'");await c.query("SET LOCAL lock_timeout='5s'");
   const role=(await c.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
   if(!role||Object.values(role).some(Boolean))reject('IDENTITY_DATABASE_ROLE_INVALID',503);
   const result=await work(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 private async cached(c:PoolClient,op:string,key:string,fingerprint:string){
  const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS live FROM wechat_identity.requests WHERE app_id=$1 AND operation=$2 AND request_key=$3 FOR UPDATE',[this.config.appId,op,key])).rows[0];
  if(!row)return undefined;if(row.fingerprint!==fingerprint)reject('IDEMPOTENCY_CONFLICT',409);
  if(row.state!=='succeeded'||!row.live)reject('LOGIN_RESTART_REQUIRED',409);
  const result=this.open(row.response_cipher,op+':'+key);
  if(op!=='revoke'){
   const session=(result as {session?:{accessToken?:string}})?.session;
   if(typeof session?.accessToken!=='string')reject('IDENTITY_UNAVAILABLE',503);
   const active=await c.query("SELECT 1 FROM wechat_identity.sessions WHERE app_id=$1 AND token_hash=$2 AND state='active' AND expires_at>clock_timestamp()",[this.config.appId,digest(session.accessToken)]);
   if(!active.rowCount)reject('LOGIN_RESTART_REQUIRED',409);
  }
  return result;
 }
 private async issue(c:PoolClient,user:{actor_id:string;tenant_id:string},family:string,provider?:{openid:string;session_key:string},familyExpiry?:number){
  const sid=randomUUID(),now=Number((await c.query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now')).rows[0].now),until=familyExpiry??now+86400,exp=Math.min(now+300,until);
  if(exp<=now)reject('AUTH_REQUIRED',401);
  const token=await new SignJWT({tenant_id:user.tenant_id,roles:['consumer'],purposes:PURPOSES,sid})
   .setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:await this.kid}).setIssuer(this.config.issuer).setAudience(this.config.audience).setSubject(user.actor_id).setJti(sid).setIssuedAt(now).setExpirationTime(exp).sign(await this.signing);
  await c.query("INSERT INTO wechat_identity.sessions(app_id,session_id,family_id,actor_id,token_hash,provider_cipher,expires_at,family_expires_at,state) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),'active')",[this.config.appId,sid,family,user.actor_id,digest(token),provider?this.seal(provider,'wechat:'+sid+':'+user.actor_id):null,exp,until]);
  return {session:{accessToken:token,expiresAt:new Date(exp*1000).toISOString(),tenantId:user.tenant_id,actorId:user.actor_id,roles:['consumer'],purpose:'age_transformation'}};
 }
 private async save(c:PoolClient,op:string,key:string,result:unknown,expiry:string){
  await c.query("UPDATE wechat_identity.requests SET state='succeeded',response_cipher=$4,expires_at=$5 WHERE app_id=$1 AND operation=$2 AND request_key=$3",[this.config.appId,op,key,this.seal(result,op+':'+key),expiry]);
 }
 async create(body:unknown,key:string){
  const input=exact(body,['code','consentVersion','clientRequestId']);
  if(!identifier(key)||!identifier(input.clientRequestId)||typeof input.code!=='string'||input.code.length<1||input.code.length>512||/\s/.test(input.code))reject('VALIDATION_FAILED');
  if(input.consentVersion!==this.config.consent)reject('CONSENT_REQUIRED',403);
  const secret=this.appSecret();
  const fingerprint=digest(JSON.stringify([input.code,input.consentVersion,input.clientRequestId]));
  const prior=await this.transaction(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.config.appId]);
   const old=await this.cached(c,'create',key,fingerprint);if(old)return old;
   const count=Number((await c.query("SELECT count(*) AS count FROM wechat_identity.requests WHERE app_id=$1 AND created_at>clock_timestamp()-interval '1 minute'",[this.config.appId])).rows[0].count);if(count>=120)reject('RATE_LIMITED',429);
   const reused=await c.query('SELECT 1 FROM wechat_identity.requests WHERE app_id=$1 AND code_hash=$2',[this.config.appId,digest(input.code as string)]);if(reused.rowCount)reject('LOGIN_RESTART_REQUIRED',409);
   await c.query("INSERT INTO wechat_identity.requests(app_id,operation,request_key,fingerprint,code_hash,state) VALUES($1,'create',$2,$3,$4,'executing')",[this.config.appId,key,fingerprint,digest(input.code as string)]);return undefined;
  });if(prior)return prior;
  let identity:{openid:string;session_key:string};
  try{
   const url=new URL(this.endpoint);url.search=new URLSearchParams({appid:this.config.appId,secret,js_code:input.code as string,grant_type:'authorization_code'}).toString();
   const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!response.ok){await response.body?.cancel();reject('WECHAT_LOGIN_REJECTED',502);}
   const chunks:Uint8Array[]=[];let size=0;
   if(!response.body)reject('WECHAT_LOGIN_REJECTED',502);
   for await(const chunk of response.body!){size+=chunk.byteLength;if(size>16384){reject('WECHAT_LOGIN_REJECTED',502);}chunks.push(chunk);}
   const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if((result.errcode!==undefined&&result.errcode!==0)||typeof result.openid!=='string'||!/^[-_A-Za-z0-9]{10,128}$/.test(result.openid)||typeof result.session_key!=='string'||Buffer.from(result.session_key,'base64').length!==16||Buffer.from(result.session_key,'base64').toString('base64')!==result.session_key)reject('WECHAT_LOGIN_REJECTED',401);
   identity=result;
  }catch(error){await this.transaction(c=>c.query("UPDATE wechat_identity.requests SET state='uncertain' WHERE app_id=$1 AND operation='create' AND request_key=$2",[this.config.appId,key]));if(error instanceof IdentityError)throw error;reject('WECHAT_LOGIN_UNAVAILABLE',503);}
  return this.transaction(async c=>{
   const hash=digest(this.config.appId+':'+identity.openid);
   await c.query('INSERT INTO wechat_identity.users(app_id,subject_hash,actor_id,tenant_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.config.appId,hash,randomUUID(),randomUUID()]);
   const user=(await c.query('SELECT actor_id,tenant_id FROM wechat_identity.users WHERE app_id=$1 AND subject_hash=$2',[this.config.appId,hash])).rows[0];
   const result=await this.issue(c,user,randomUUID(),identity);
   await this.save(c,'create',key,result,result.session.expiresAt);
   await c.query('UPDATE wechat_identity.sessions SET provider_cipher=NULL WHERE app_id=$1 AND expires_at<=clock_timestamp()',[this.config.appId]);
   return result;
  });
 }
 async sessionOperation(op:'refresh'|'revoke',body:unknown,key:string,token:string){
  exact(body,[]);if(!identifier(key)||token.length>8192)reject('VALIDATION_FAILED');
  let sid:string;try{const pub=await importJWK(this.publicJwk,'ES256');const verified=await jwtVerify(token,pub,{algorithms:['ES256'],issuer:this.config.issuer,audience:this.config.audience,typ:'at+jwt',maxTokenAge:300,requiredClaims:['sid','sub','iat','exp']});if(typeof verified.payload.sid!=='string')reject('AUTH_REQUIRED',401);sid=verified.payload.sid as string;}
  catch{reject('AUTH_REQUIRED',401);}
  const fingerprint=digest(token);
  return this.transaction(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.config.appId]);
   const old=await this.cached(c,op,key,fingerprint);if(old)return old;
   const s=(await c.query('SELECT s.*,u.tenant_id,s.expires_at>clock_timestamp() AS live FROM wechat_identity.sessions s JOIN wechat_identity.users u USING(app_id,actor_id) WHERE s.app_id=$1 AND s.session_id=$2 FOR UPDATE OF s',[this.config.appId,sid])).rows[0];
   if(!s||!s.live||s.token_hash!==fingerprint||s.state!=='active')reject('AUTH_REQUIRED',401);
   await c.query("INSERT INTO wechat_identity.requests(app_id,operation,request_key,fingerprint,state) VALUES($1,$2,$3,$4,'executing')",[this.config.appId,op,key,fingerprint]);
   if(op==='revoke'){
    await c.query("UPDATE wechat_identity.sessions SET state='revoked',provider_cipher=NULL WHERE app_id=$1 AND family_id=$2",[this.config.appId,s.family_id]);
    const result={revoked:true};await this.save(c,op,key,result,new Date(Date.now()+300000).toISOString());return result;
   }
   await c.query("UPDATE wechat_identity.sessions SET state='rotated',provider_cipher=NULL WHERE app_id=$1 AND session_id=$2",[this.config.appId,sid]);
   // Refresh does not extend WeChat session-key availability. A future virtual-
   // payment signature must obtain a fresh wx.login verification separately.
   const result=await this.issue(c,s,s.family_id,undefined,Math.floor(new Date(s.family_expires_at).getTime()/1000));await this.save(c,op,key,result,result.session.expiresAt);return result;
  });
 }
 async jwks(){return {keys:[{...this.publicJwk,kid:await this.kid}]};}
 async ready(){this.appSecret();await this.signing;await this.transaction(async c=>{
  await c.query('SELECT session_id FROM wechat_identity.sessions LIMIT 1');await c.query('SELECT actor_id FROM wechat_identity.users LIMIT 1');await c.query('SELECT request_key FROM wechat_identity.requests LIMIT 1');
  const tables=(await c.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='wechat_identity'::regnamespace AND relkind='r'")).rows;
  if(tables.length!==3||tables.some(t=>!t.relrowsecurity||!t.relforcerowsecurity))reject('IDENTITY_UNAVAILABLE',503);
 });}
 private allowed(value:string|undefined){if(!value?.startsWith('Bearer '))return false;const hash=digest(value.slice(7));return timingSafeEqual(Buffer.from(hash),Buffer.from(this.config.workloadDigest));}
 async handle(req:IncomingMessage,res:ServerResponse){
  const send=(status:number,value:unknown)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','private, no-store');res.setHeader('x-content-type-options','nosniff');res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url??'/','https://identity.invalid');if(url.search)reject('VALIDATION_FAILED');
   if(req.method==='GET'&&url.pathname==='/health/live'){send(200,{status:'alive'});return;}
   if(req.method==='GET'&&url.pathname==='/.well-known/jwks.json'){send(200,await this.jwks());return;}
   if(!this.allowed(req.headers.authorization))reject('AUTH_REQUIRED',401);
   if(req.method==='GET'&&url.pathname==='/health/ready'){await this.ready();send(200,{ready:true});return;}
   if(req.method!=='POST'||!['/v1/wechat/sessions','/v1/wechat/sessions/refresh','/v1/wechat/sessions/revoke'].includes(url.pathname))reject('RESOURCE_NOT_FOUND',404);
   if(req.headers['content-type']?.split(';')[0]!=='application/json')reject('VALIDATION_FAILED');
   if(Number(req.headers['content-length']??0)>8192)reject('BODY_TOO_LARGE',413);
   const parsed=(req as IncomingMessage&{body?:unknown}).body;let body:unknown;
   if(parsed!==undefined){const text=typeof parsed==='string'?parsed:Buffer.isBuffer(parsed)?parsed.toString('utf8'):JSON.stringify(parsed);if(Buffer.byteLength(text)>8192)reject('BODY_TOO_LARGE',413);try{body=JSON.parse(text);}catch{reject('VALIDATION_FAILED');}}
   else{let bytes=Buffer.alloc(0);for await(const chunk of req){bytes=Buffer.concat([bytes,Buffer.from(chunk)]);if(bytes.length>8192)reject('BODY_TOO_LARGE',413);}try{body=JSON.parse(bytes.toString('utf8'));}catch{reject('VALIDATION_FAILED');}}
   const key=req.headers['idempotency-key'];if(typeof key!=='string')reject('VALIDATION_FAILED');
   if(url.pathname==='/v1/wechat/sessions'){send(200,await this.create(body,key));return;}
   const token=req.headers['x-ltm-subject-token'];if(typeof token!=='string')reject('AUTH_REQUIRED',401);
   const op=url.pathname.endsWith('/refresh')?'refresh':'revoke';const result=await this.sessionOperation(op,body,key,token);
   if(op==='revoke'){res.statusCode=204;res.setHeader('cache-control','private, no-store');res.end();}else send(200,result);
  }catch(error){if(error instanceof IdentityError)send(error.status,{error:{code:error.code}});else send(503,{error:{code:'IDENTITY_UNAVAILABLE'}});}
 }
 async close(){await this.pool.end();}
}
