import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readdir,readFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {packageWechatIdentity} from './vercel-identity-package.mjs';
test('actual isolated identity bundle serves real HTTP and refuses missing production credentials without private files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'identity-artifact-'));let server;
 try{
  const output=join(directory,'artifact'),result=await packageWechatIdentity(output);
  assert.equal(result.files.length,3);assert.ok(result.files.every(f=>f.bytes>0&&f.sha256.length===64));
  assert.deepEqual((await readdir(output)).sort(),['api','package.json','vercel.json']);
  const config=JSON.parse(await readFile(join(output,'vercel.json'),'utf8'));assert.equal(config.crons,undefined);assert.deepEqual(config.regions,['sin1']);assert.equal(config.functions['api/index.mjs'].maxDuration,30);
  const pkg=JSON.parse(await readFile(join(output,'package.json'),'utf8'));assert.deepEqual(Object.keys(pkg.dependencies).sort(),['jose','pg']);assert.equal(pkg.engines.node,'26.x');
  await symlink(fileURLToPath(new URL('../services/api/node_modules',import.meta.url)),join(output,'node_modules'));
  const {default:handler}=await import(pathToFileURL(join(output,'api/index.mjs')).href);
  server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/wechat/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'IDENTITY_NOT_CONFIGURED'}});assert.equal(response.headers.get('cache-control'),'private, no-store');
  await assert.rejects(packageWechatIdentity(output),/EEXIST/);await assert.rejects(packageWechatIdentity(fileURLToPath(new URL('../new-artifact',import.meta.url))),/isolated/);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
