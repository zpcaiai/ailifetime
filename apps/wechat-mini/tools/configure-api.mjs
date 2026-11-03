import{readFileSync,writeFileSync,realpathSync,existsSync}from'node:fs';
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
export function configureApi({project=DEFAULT_PROJECT,apiBaseUrl}={}){
 const api=origin(apiBaseUrl),root=realpathSync(project),config=JSON.parse(readFileSync(resolve(root,'project.config.json'),'utf8'));
 if(config.compileType!=='miniprogram'||!/^wx[a-f0-9]{16}$/.test(config.appid)||config.setting?.urlCheck!==true||config.__usePrivacyCheck__!==true)throw Error('PROJECT_CONFIGURATION_INVALID');
 const program=realpathSync(resolve(root,config.miniprogramRoot)),inside=relative(root,program);
 if(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw Error('MINIPROGRAM_ROOT_OUTSIDE_PROJECT');
 const path=resolve(program,'ext.json');let created=false;
 if(existsSync(path)){
  const existing=JSON.parse(readFileSync(path,'utf8'));
  if(existing.extEnable!==true||existing.extAppid!==config.appid||existing.ext?.apiBaseUrl!==api)throw Error('EXT_CONFIGURATION_EXISTS');
 }else{
  writeFileSync(path,JSON.stringify({extEnable:true,extAppid:config.appid,ext:{apiBaseUrl:api}},null,2)+'\n',{flag:'wx',mode:0o600});created=true;
 }
 return{path,created,apiBaseUrl:api,domainEnrollment:'NOT_VERIFIED',nativeLogin:'NOT_RUN'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const{values}=parseArgs({options:{project:{type:'string'},'api-base-url':{type:'string'}}});
 console.log(JSON.stringify(configureApi({project:values.project,apiBaseUrl:values['api-base-url']})));
}
