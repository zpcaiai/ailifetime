import { createRequire } from 'node:module';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { resolve,join,isAbsolute } from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
/** Produce an isolated API artifact; never upload the shared dirty checkout,
 * local secrets, photos, demo pages, tests or temporary evidence. */
export async function packageVercelApi(output,{preview=true}={}) {
 if(!isAbsolute(output) || output===root || output.startsWith(root+'/node_modules/'))throw new Error('absolute isolated output directory required');
 await mkdir(output,{recursive:false,mode:0o700});await mkdir(join(output,'api'));
 const require=createRequire(import.meta.url),tsxRequire=createRequire(require.resolve('tsx/package.json'));
 const {build}=await import(pathToFileURL(tsxRequire.resolve('esbuild')).href);
 await build({entryPoints:[join(root,'deploy/vercel/api/index.mjs')],outfile:join(output,'api/index.mjs'),bundle:true,platform:'node',target:'node26',format:'esm',minify:true,keepNames:true,
   external:['pg','jose','@aws-sdk/client-s3'],banner:{js:"import { createRequire as _ltmCreateRequire } from 'node:module'; const require = _ltmCreateRequire(import.meta.url);"},logLevel:'warning'});
 const source=JSON.parse(await readFile(join(root,'services/api/package.json'),'utf8'));
 const dependencies=Object.fromEntries(['pg','jose','@aws-sdk/client-s3'].map(k=>[k,source.dependencies[k]]));
 await writeFile(join(output,'package.json'),JSON.stringify({name:'ailifetime-private-api',private:true,type:'module',engines:{node:'26.x'},dependencies},null,2)+'\n',{flag:'wx'});
 const config=JSON.parse(await readFile(join(root,'deploy/vercel/vercel.json'),'utf8'));
 if(preview)delete config.crons; // Preview is an access probe; only production runs scheduled cleanup.
 await writeFile(join(output,'vercel.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
 const files=[];
 for(const file of ['api/index.mjs','package.json','vercel.json']){const bytes=await readFile(join(output,file));files.push({file,sha:createHash('sha1').update(bytes).digest('hex'),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});}
 return {output,preview,files};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),production=args[0]==='--production';
 if((production&&args.length!==2)||(!production&&args.length!==1))throw new Error('usage: node tools/vercel-photo-package.mjs [--production] ABSOLUTE_OUTPUT_DIRECTORY');
 console.log(JSON.stringify(await packageVercelApi(args[production?1:0],{preview:!production}),null,2));
}
