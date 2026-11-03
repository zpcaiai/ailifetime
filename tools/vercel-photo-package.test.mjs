import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,readFile,symlink,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { packageVercelApi } from './vercel-photo-package.mjs';

test('isolated bundled API imports and serves real HTTP without shipping private files or enabling preview cron',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vercel-package-'));let server;
 try{
  const output=join(dir,'artifact'),receipt=await packageVercelApi(output);
  assert.equal(receipt.files.length,3);assert.equal(receipt.preview,true);assert.ok(receipt.files.every(f=>f.sha256.length===64&&f.size>0));
  assert.deepEqual((await readdir(output)).sort(),['api','package.json','vercel.json']);
  const config=JSON.parse(await readFile(join(output,'vercel.json'),'utf8'));assert.equal(config.crons,undefined);assert.deepEqual(config.regions,['sin1']);
  const manifest=JSON.parse(await readFile(join(output,'package.json'),'utf8'));assert.equal(manifest.engines.node,'26.x');assert.deepEqual(Object.keys(manifest.dependencies).sort(),['@aws-sdk/client-s3','jose','pg']);
  // Reuse exact already-installed dependencies for the local artifact test.
  await symlink(fileURLToPath(new URL('../services/api/node_modules',import.meta.url)),join(output,'node_modules'));
  const {default:handler}=await import(pathToFileURL(join(output,'api/index.mjs')).href);
  server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/health/live')).status,200);const catalog=await(await fetch(base+'/v1/photo-products')).json();assert.equal(catalog.data.priceVersion,'photo-retail-cny.v3');assert.deepEqual(catalog.data.products.map(p=>p.amountMinor),[1990,2990,2990,4990,590,990]);
  assert.equal((await fetch(base+'/health/ready')).status,503);assert.equal((await fetch(base+'/internal/media-cleanup')).status,401);
  await assert.rejects(packageVercelApi(output),/EEXIST/);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
