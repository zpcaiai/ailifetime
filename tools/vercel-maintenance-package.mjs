import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join,isAbsolute} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function packageMaintenance(baseline,output,expectedSha256){
 if(!isAbsolute(baseline)||!isAbsolute(output)||baseline===output||output===root||!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error('explicit isolated paths and baseline SHA256 required');
 const entry=join(baseline,'api/index.mjs'),bytes=await readFile(entry);
 if(bytes.length>10*1024*1024||sha(bytes)!==expectedSha256)throw Error('baseline source digest mismatch');
 const manifest=JSON.parse(await readFile(join(baseline,'package.json'),'utf8'));
 if(Object.keys(manifest.dependencies??{}).sort().join(',')!=='@aws-sdk/client-s3,jose,pg'||Object.values(manifest.dependencies).some(v=>!/^\d+\.\d+\.\d+$/.test(v)))throw Error('baseline dependencies must be exact reviewed versions');
 await mkdir(output,{mode:0o700});await mkdir(join(output,'api'));
 const require=createRequire(import.meta.url),tsx=createRequire(require.resolve('tsx/package.json')),{build}=await import(pathToFileURL(tsx.resolve('esbuild')).href);
 await build({entryPoints:[join(root,'deploy/vercel/maintenance-entry.mjs')],outfile:join(output,'api/index.mjs'),bundle:true,platform:'node',target:'node26',format:'esm',minify:true,keepNames:true,external:['pg','jose','@aws-sdk/client-s3'],
  plugins:[{name:'exact-deployed-baseline',setup(b){b.onResolve({filter:/^@ltm-deployment-baseline$/},()=>({path:entry}));}}],banner:{js:"import {createRequire as _ltmRequire} from 'node:module';const require=_ltmRequire(import.meta.url);"},logLevel:'warning'});
 await writeFile(join(output,'package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 const config=JSON.parse(await readFile(join(root,'deploy/vercel/vercel.json'),'utf8'));
 await writeFile(join(output,'vercel.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
 const files=[];for(const file of ['api/index.mjs','package.json','vercel.json']){const content=await readFile(join(output,file));files.push({file,bytes:content.length,sha256:sha(content)});}
 return {baselineSha256:expectedSha256,files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==5)throw Error('usage: node tools/vercel-maintenance-package.mjs ABSOLUTE_BASE ABSOLUTE_OUTPUT BASE_API_SHA256');
 console.log(JSON.stringify(await packageMaintenance(...process.argv.slice(2)),null,2));
}
