import { createHash } from 'node:crypto';
import { cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { dirname,isAbsolute,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { validateMiniProgram } from '../apps/wechat-mini/tools/validate-miniprogram.mjs';

const DEFAULT_SOURCE=resolve(dirname(fileURLToPath(import.meta.url)),'../apps/wechat-mini');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const configModule = bytes => 'module.exports = '+JSON.stringify(JSON.parse(bytes),null,2)+';\n';
export function verifyNativeAlbumPreviewConfiguration(output) {
  const root=join(output,'miniprogram');
  const bytes=readFileSync(join(root,'ext.json'),'utf8');
  const manifest=JSON.parse(readFileSync(join(output,'native-preview-manifest.json'),'utf8'));
  if(sha(bytes)!==manifest.configurationSha256)throw Error('PREVIEW_CONFIG_SOURCE_DIGEST_MISMATCH');
  const modulePath=join(root,'services/native-album-ext.js');
  if(readFileSync(modulePath,'utf8')!==configModule(bytes))throw Error('PREVIEW_CONFIG_MODULE_PROVENANCE_MISMATCH');
  function scan(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink())throw Error('PREVIEW_SYMLINK_FORBIDDEN');
      if(entry.isDirectory()){scan(path);continue;}
      if(!entry.name.endsWith('.js')||path===modulePath)continue;
      const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      function visit(node) {
        if(ts.isStringLiteralLike(node)&&/^https?:\/\//.test(node.text)&&!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(node.text))throw Error('PREVIEW_BUSINESS_ORIGIN_LITERAL_FORBIDDEN');
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
  }
  scan(root);
  return {configurationSha256:sha(bytes),moduleSha256:sha(configModule(bytes))};
}
function compilePreviewConfiguration(path) {
  const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const f=ts.factory;
  const development=()=>f.createBinaryExpression(
    f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('wx'),'getAccountInfoSync'),undefined,[]),'miniProgram'),'envVersion'),
    f.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),f.createStringLiteral('develop'));
  let functions=0,initializers=0,returns=0;
  const result=ts.transform(source,[context=>root=>ts.visitEachChild(root,node=>{
    if(!ts.isFunctionDeclaration(node)||node.name?.text!=='configuration')return node;
    functions++;
    function visit(child) {
      if(ts.isVariableDeclaration(child)&&ts.isIdentifier(child.name)&&child.name.text==='ext') {
        if(!child.initializer||!ts.isConditionalExpression(child.initializer))throw Error('PREVIEW_API_EXT_AST_MISMATCH');
        initializers++;
        const config=f.createPropertyAccessExpression(f.createCallExpression(f.createIdentifier('require'),undefined,
          [f.createStringLiteral('./native-album-ext.js')]),'ext');
        return f.updateVariableDeclaration(child,child.name,child.exclamationToken,child.type,
          f.createConditionalExpression(development(),f.createToken(ts.SyntaxKind.QuestionToken),config,f.createToken(ts.SyntaxKind.ColonToken),child.initializer));
      }
      if(ts.isReturnStatement(child)) {
        if(!child.expression||!ts.isObjectLiteralExpression(child.expression))throw Error('PREVIEW_API_RETURN_AST_MISMATCH');
        returns++;
        return f.updateReturnStatement(child,f.updateObjectLiteralExpression(child.expression,[...child.expression.properties,
          f.createPropertyAssignment('nativeAlbumTestEnabled',f.createBinaryExpression(development(),f.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
            f.createBinaryExpression(f.createPropertyAccessExpression(f.createIdentifier('ext'),'nativeAlbumTestEnabled'),f.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),f.createTrue()))),
        ]));
      }
      return ts.visitEachChild(child,visit,context);
    }
    return ts.visitEachChild(node,visit,context);
  },context)]);
  try {
    if(functions!==1||initializers!==1||returns!==1)throw Error('PREVIEW_API_CONFIGURATION_AST_MISMATCH');
    writeFileSync(path,ts.createPrinter().printFile(result.transformed[0]));
  } finally {result.dispose();}
}
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
  if(existsSync(join(output,'miniprogram/services/native-album-ext.js')))throw Error('SOURCE_CONFIG_MODULE_COLLISION');
  compilePreviewConfiguration(join(output,'miniprogram/services/api.js'));
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
  const extBytes=JSON.stringify({extEnable:true,extAppid:project.appid,
    ext:{apiBaseUrl:base,apiAllowedOrigins:https?[base]:[],nativeAlbumTestEnabled:true}},null,2)+'\n';
  writeFileSync(join(output,'miniprogram/ext.json'),extBytes,{flag:'wx'});
  writeFileSync(join(output,'miniprogram/services/native-album-ext.js'),configModule(extBytes),{flag:'wx'});
  validateMiniProgram(output);
  const manifest={schemaVersion:'ltm.native-album-preview.v1',sourceAppSha256:sha(appBytes),sourceProjectSha256:sha(projectBytes),
    entrySha256:entryHashes,apiOriginKind:https?'HTTPS_DOMAIN_NOT_YET_VERIFIED':'DEVTOOLS_LOOPBACK_ONLY',
    containsCredentials:false,sourceChanged:false,configurationDelivery:'BUNDLED_EXT_JSON_DATA_MODULE_DEVELOP_ONLY',configurationSha256:sha(extBytes),configurationModuleSha256:sha(configModule(extBytes)),nativeAcceptance:'NOT_RUN',paidModelCalls:0};
  writeFileSync(join(output,'native-preview-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  verifyNativeAlbumPreviewConfiguration(output);
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{'source-root':{type:'string'},output:{type:'string'},'api-base-url':{type:'string'},'allow-loopback-devtools':{type:'boolean',default:false}}});
  try{console.log(JSON.stringify({output:values.output,...prepareNativeAlbumPreview({sourceRoot:values['source-root'],output:values.output,apiBaseUrl:values['api-base-url'],allowLoopbackDevtools:values['allow-loopback-devtools']})}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
