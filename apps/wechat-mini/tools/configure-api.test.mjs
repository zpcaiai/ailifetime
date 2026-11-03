import assert from'node:assert/strict';import test from'node:test';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,symlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{configureApi}from'./configure-api.mjs';
function fixture(t){const project=mkdtempSync(join(tmpdir(),'mini-api-config-'));t.after(()=>rmSync(project,{recursive:true,force:true}));mkdirSync(join(project,'miniprogram'));writeFileSync(join(project,'project.config.json'),JSON.stringify({appid:'wx0123456789abcdef',compileType:'miniprogram',miniprogramRoot:'miniprogram/',setting:{urlCheck:true},__usePrivacyCheck__:true}));return project;}
test('explicit HTTPS configuration produces only non-secret ext fields and repeats without rewriting',t=>{
 const project=fixture(t),first=configureApi({project,apiBaseUrl:'https://api.product.cn/'}),bytes=readFileSync(first.path);
 assert.equal(first.created,true);assert.equal(first.domainEnrollment,'NOT_VERIFIED');assert.equal(first.nativeLogin,'NOT_RUN');assert.equal(statSync(first.path).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(bytes),{extEnable:true,extAppid:'wx0123456789abcdef',ext:{apiBaseUrl:'https://api.product.cn'}});
 assert.equal(configureApi({project,apiBaseUrl:'https://api.product.cn'}).created,false);assert.deepEqual(readFileSync(first.path),bytes);
 assert.throws(()=>configureApi({project,apiBaseUrl:'https://other.product.cn'}),/EXT_CONFIGURATION_EXISTS/);assert.deepEqual(readFileSync(first.path),bytes);
});
test('unsafe origins and changed project gates cannot create development configuration',t=>{
 const project=fixture(t);
 for(const apiBaseUrl of [undefined,'http://api.product.cn','https://127.0.0.1','https://localhost','https://private.local','https://api.invalid','https://u:p@api.product.cn','https://api.product.cn/path','https://api.product.cn?token=private','https://api.product.cn#fragment','https://api.product.cn:444',' https://api.product.cn'])assert.throws(()=>configureApi({project,apiBaseUrl}),/API_ORIGIN_INVALID/);
 const path=join(project,'project.config.json'),config=JSON.parse(readFileSync(path));
 for(const patch of [{appid:'touristappid'},{setting:{urlCheck:false}},{__usePrivacyCheck__:false}]){writeFileSync(path,JSON.stringify({...config,...patch}));assert.throws(()=>configureApi({project,apiBaseUrl:'https://api.product.cn'}),/PROJECT_CONFIGURATION_INVALID/);}
});
test('symlink root escape and existing foreign ext are preserved',t=>{
 const project=fixture(t),outside=fixture(t),path=join(project,'project.config.json'),config=JSON.parse(readFileSync(path));symlinkSync(join(outside,'miniprogram'),join(project,'outside'));writeFileSync(path,JSON.stringify({...config,miniprogramRoot:'outside'}));
 assert.throws(()=>configureApi({project,apiBaseUrl:'https://api.product.cn'}),/OUTSIDE_PROJECT/);
 writeFileSync(path,JSON.stringify(config));const extPath=join(project,'miniprogram/ext.json'),original=JSON.stringify({extEnable:true,extAppid:'wx1111111111111111',ext:{apiBaseUrl:'https://api.product.cn'}});writeFileSync(extPath,original);
 assert.throws(()=>configureApi({project,apiBaseUrl:'https://api.product.cn'}),/EXT_CONFIGURATION_EXISTS/);assert.equal(readFileSync(extPath,'utf8'),original);
});
