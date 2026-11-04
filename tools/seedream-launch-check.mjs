import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = {
 runtime:[['DATABASE_URL'],['LTM_AUTH_MODE'],['LTM_OIDC_ISSUER'],['LTM_OIDC_AUDIENCE'],['LTM_OIDC_JWKS_URL'],['LTM_EVIDENCE_TRUST_KEYS_JSON'],['LTM_METRICS_TOKEN_SHA256']],
 consent:[['LTM_CONSENT_POLICY_CATALOG_JSON','LTM_CONSENT_POLICY_CATALOG_FILE'],['LTM_CONSENT_POLICY_TRUST_KEYS_JSON'],['LTM_CONSENT_POLICY_JURISDICTION'],['LTM_CONSENT_POLICY_LOCALE']],
 brokers:[['LTM_WECHAT_IDENTITY_BROKER_URL'],['LTM_WECHAT_IDENTITY_TOKEN','LTM_WECHAT_IDENTITY_TOKEN_FILE'],['LTM_WECHAT_PLATFORM_BROKER_URL'],['LTM_WECHAT_PLATFORM_BROKER_TOKEN','LTM_WECHAT_PLATFORM_BROKER_TOKEN_FILE'],['LTM_WECHAT_CUSTOMER_SERVICE_ALLOWED_ORIGINS'],['LTM_UPLOAD_BROKER_URL'],['LTM_UPLOAD_BROKER_TOKEN','LTM_UPLOAD_BROKER_TOKEN_FILE']],
 storage:[['LTM_PHOTO_S3_ENDPOINT'],['LTM_PHOTO_S3_REGION'],['LTM_PHOTO_S3_BUCKET'],['LTM_PHOTO_S3_ACCESS_KEY_ID'],['LTM_PHOTO_S3_SECRET_ACCESS_KEY'],['CRON_SECRET']],
 generation:[['LTM_SEEDREAM_ENABLED'],['ARK_API_KEY','LTM_SEEDREAM_API_KEY_FILE']],
 quality:[['LTM_PHOTO_SCORER_URL'],['LTM_PHOTO_SCORER_TOKEN','LTM_PHOTO_SCORER_TOKEN_FILE'],['LTM_PHOTO_SCORER_POLICIES_JSON','LTM_PHOTO_SCORER_POLICY_FILE'],['LTM_PHOTO_SCORER_CHANNEL']],
};

/** Presence is an inventory, never proof of live credentials or service readiness.
 * No value, caller-provided name, request body or secret is returned. */
export function inspectSeedreamLaunch({environment,names}={}) {
 if((environment===undefined)===(names===undefined))throw Error('Provide environment or variable names');
 if(names!==undefined&&(!Array.isArray(names)||names.length>512||names.some(n=>typeof n!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(n))))throw Error('Invalid variable name inventory');
 const has=name=>names!==undefined?names.includes(name):typeof environment[name]==='string'&&environment[name].trim().length>0;
 const missing=[],conflicts=[];
 for(const [group,requirements] of Object.entries(groups))for(const alternatives of requirements){
  const present=alternatives.filter(has);
  if(!present.length)missing.push({group,oneOf:alternatives});
  if(present.length>1)conflicts.push({group,oneOf:alternatives});
 }
 const invalid=[];
 if(environment!==undefined){
  if(has('LTM_AUTH_MODE')&&environment.LTM_AUTH_MODE!=='oidc')invalid.push('LTM_AUTH_MODE');
  if(has('LTM_SEEDREAM_ENABLED')&&environment.LTM_SEEDREAM_ENABLED!=='true')invalid.push('LTM_SEEDREAM_ENABLED');
  if(has('CRON_SECRET')&&environment.CRON_SECRET.length<32)invalid.push('CRON_SECRET');
  if(has('DATABASE_URL')){try{const u=new URL(environment.DATABASE_URL);if(!['postgres:','postgresql:'].includes(u.protocol)||u.searchParams.get('sslmode')!=='verify-full'||!u.username||!u.hostname||u.pathname.length<2||u.hash)invalid.push('DATABASE_URL');}catch{invalid.push('DATABASE_URL');}}
  for(const name of ['LTM_OIDC_JWKS_URL','LTM_WECHAT_IDENTITY_BROKER_URL','LTM_WECHAT_PLATFORM_BROKER_URL','LTM_UPLOAD_BROKER_URL','LTM_PHOTO_S3_ENDPOINT','LTM_PHOTO_SCORER_URL']){
   if(!has(name))continue;
   try{const u=new URL(environment[name]);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)invalid.push(name);}catch{invalid.push(name);}
  }
 }
 const blocked=missing.length+conflicts.length+invalid.length>0;
 return {status:blocked?'BLOCKED_INCOMPLETE':names!==undefined?'NAMES_PRESENT_RUNTIME_UNVERIFIED':'STATIC_CONFIGURATION_PRESENT_RUNTIME_UNVERIFIED',mode:names!==undefined?'names-only':'environment',missing,conflicts,invalid,
  runtimeVerification:'NOT_RUN',realGeneration:'NOT_RUN',publishable:false,
  remainingVerification:['restricted SQL role and migrations','signed consent/catalog and trusted evidence','approved live brokers and owner-authorized original','private unversioned object store and deletion schedule','calibrated scorer and B15/B17 publication','Ark model access and bounded real one-image response/readback','provider controller dispatch and WeChat device/domain acceptance']};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);let input;
  if(args.length===0)input={environment:process.env};
  else if(args.length===2&&args[0]==='--names-json'){
   const bytes=await readFile(args[1]);if(bytes.length>256*1024)throw Error('Inventory too large');input={names:JSON.parse(bytes.toString('utf8'))};
  }else throw Error('Invalid arguments');
  const report=inspectSeedreamLaunch(input);console.log(JSON.stringify(report,null,2));if(report.status==='BLOCKED_INCOMPLETE')process.exitCode=1;
 }catch{console.error('Launch inventory invalid; use no arguments or --names-json PATH containing variable names only.');process.exitCode=2;}
}
