import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isAbsolute,resolve,join,dirname,basename} from 'node:path';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
export async function packageWechatIdentity(output){
 if(!isAbsolute(output))throw new Error('an isolated absolute new output directory is required');
 output=join(await realpath(dirname(resolve(output))),basename(resolve(output)));
 if(output===root||output.startsWith(root+'/'))throw new Error('an isolated absolute new output directory is required');
 await mkdir(output,{mode:0o700});await mkdir(join(output,'api'));
 const require=createRequire(import.meta.url),tsx=createRequire(require.resolve('tsx/package.json'));
 const {build}=await import(pathToFileURL(tsx.resolve('esbuild')).href);
 await build({entryPoints:[join(root,'deploy/wechat-identity/index.mjs')],outfile:join(output,'api/index.mjs'),bundle:true,platform:'node',target:'node26',format:'esm',minify:true,keepNames:true,external:['pg','jose'],logLevel:'warning',banner:{js:"import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);"}});
 const source=JSON.parse(await readFile(join(root,'services/api/package.json'),'utf8'));
 await writeFile(join(output,'package.json'),JSON.stringify({name:'ailifetime-wechat-identity',private:true,type:'module',engines:{node:'26.x'},dependencies:{pg:source.dependencies.pg,jose:source.dependencies.jose}},null,2)+'\n',{flag:'wx'});
 await writeFile(join(output,'vercel.json'),JSON.stringify({version:2,regions:['sin1'],functions:{'api/index.mjs':{maxDuration:30}},rewrites:[{source:'/(.*)',destination:'/api/index'}]},null,2)+'\n',{flag:'wx'});
 const files=[];for(const name of ['api/index.mjs','package.json','vercel.json']){const bytes=await readFile(join(output,name));files.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}return {output,files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==1)throw new Error('usage: node tools/vercel-identity-package.mjs ABSOLUTE_NEW_DIRECTORY');
 console.log(JSON.stringify(await packageWechatIdentity(args[0]),null,2));
}
