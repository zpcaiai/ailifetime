import { createHash } from 'node:crypto';
import { cpSync,existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,isAbsolute,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateMiniProgram } from '../apps/wechat-mini/tools/validate-miniprogram.mjs';

const DEFAULT_SOURCE=resolve(dirname(fileURLToPath(import.meta.url)),'../apps/wechat-mini');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function prepareNativeAlbumPreview({sourceRoot=DEFAULT_SOURCE,output,apiBaseUrl,allowLoopbackDevtools=false}={}) {
  if(!isAbsolute(sourceRoot)||!isAbsolute(output||''))throw Error('ABSOLUTE_SOURCE_AND_OUTPUT_REQUIRED');
  const base=typeof apiBaseUrl==='string'?apiBaseUrl.replace(/\/$/,''):'';
  const https=/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(base)&&!/\.(?:invalid|example|test)$/.test(base);
  const loopback=allowLoopbackDevtools===true&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)&&Number(base.split(':').pop())<=65535;
  if(!https&&!loopback)throw Error('ACTUAL_HTTPS_ORIGIN_REQUIRED');
  const within=relative(sourceRoot,output);if(!within||!within.startsWith('..'))throw Error('OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  const projectBytes=readFileSync(join(sourceRoot,'project.config.json'));
  const appBytes=readFileSync(join(sourceRoot,'miniprogram/app.json'));
  const project=JSON.parse(projectBytes),app=JSON.parse(appBytes);
  if(project.setting?.urlCheck!==true||project.__usePrivacyCheck__!==true||!['miniprogram/','miniprogram'].includes(project.miniprogramRoot))throw Error('SOURCE_SECURITY_GATES_REQUIRED');
  if(existsSync(join(sourceRoot,'miniprogram/pages/native-album-test')))throw Error('SOURCE_TEST_ENTRY_COLLISION');
  try{mkdirSync(output,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('OUTPUT_MUST_NOT_EXIST');throw error;}
  cpSync(join(sourceRoot,'miniprogram'),join(output,'miniprogram'),{recursive:true,filter:path=>!path.endsWith('/ext.json')});
  mkdirSync(join(output,'release'));
  for(const name of ['package.json','metadata.json','upload.mjs'])cpSync(join(sourceRoot,'release',name),join(output,'release',name));
  const entry=join(output,'miniprogram/pages/native-album-test');mkdirSync(entry);
  const entryHashes={};
  for(const suffix of ['js','wxml']) {
    const bytes=readFileSync(join(sourceRoot,'native-test-entry',`index.${suffix}`));entryHashes[suffix]=sha(bytes);writeFileSync(join(entry,`index.${suffix}`),bytes,{flag:'wx'});
  }
  writeFileSync(join(entry,'index.json'),JSON.stringify({navigationBarTitleText:'手机相册保存联调'})+'\n',{flag:'wx'});
  writeFileSync(join(entry,'index.wxss'),'.test-credential { margin: 24rpx 0; padding: 20rpx; background: #fff; border: 1rpx solid #777; min-height: 88rpx; }\n',{flag:'wx'});
  app.pages=['pages/native-album-test/index',...app.pages];
  writeFileSync(join(output,'miniprogram/app.json'),JSON.stringify(app,null,2)+'\n');
  project.projectname='native-album-test-preview';
  writeFileSync(join(output,'project.config.json'),JSON.stringify(project,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(output,'miniprogram/ext.json'),JSON.stringify({extEnable:true,extAppid:project.appid,
    ext:{apiBaseUrl:base,apiAllowedOrigins:https?[base]:[],nativeAlbumTestEnabled:true}},null,2)+'\n',{flag:'wx'});
  validateMiniProgram(output);
  const manifest={schemaVersion:'ltm.native-album-preview.v1',sourceAppSha256:sha(appBytes),sourceProjectSha256:sha(projectBytes),
    entrySha256:entryHashes,apiOriginKind:https?'HTTPS_DOMAIN_NOT_YET_VERIFIED':'DEVTOOLS_LOOPBACK_ONLY',
    containsCredentials:false,sourceChanged:false,nativeAcceptance:'NOT_RUN',paidModelCalls:0};
  writeFileSync(join(output,'native-preview-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{'source-root':{type:'string'},output:{type:'string'},'api-base-url':{type:'string'},'allow-loopback-devtools':{type:'boolean',default:false}}});
  try{console.log(JSON.stringify({output:values.output,...prepareNativeAlbumPreview({sourceRoot:values['source-root'],output:values.output,apiBaseUrl:values['api-base-url'],allowLoopbackDevtools:values['allow-loopback-devtools']})}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
