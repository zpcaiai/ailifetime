import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,symlink,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {packageVercelApi} from './vercel-photo-package.mjs';
import {packageMaintenance} from './vercel-maintenance-package.mjs';

test('actual deployed API composition preserves baseline catalog/gates and independently protects real maintenance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'maintenance-overlay-'));let a,b;
 try{
  const base=join(dir,'base'),out=join(dir,'overlay');await packageVercelApi(base);
  const digest=createHash('sha256').update(await readFile(join(base,'api/index.mjs'))).digest('hex');
  await assert.rejects(packageMaintenance(base,out,'0'.repeat(64)),/digest mismatch/);
  const built=await packageMaintenance(base,out,digest);assert.equal(built.files.length,3);assert.equal(built.baselineSha256,digest);
  assert.deepEqual((await readdir(out)).sort(),['api','package.json','vercel.json']);
  const config=JSON.parse(await readFile(join(out,'vercel.json'),'utf8'));assert.deepEqual(config.crons,[{path:'/internal/media-cleanup',schedule:'15 11 * * *'}]);
  for(const folder of [base,out])await symlink(fileURLToPath(new URL('../services/api/node_modules',import.meta.url)),join(folder,'node_modules'));
  const first=(await import(pathToFileURL(join(base,'api/index.mjs')).href)).default,second=(await import(pathToFileURL(join(out,'api/index.mjs')).href)).default;
  a=createServer((q,s)=>void first(q,s));b=createServer((q,s)=>void second(q,s));a.listen(0,'127.0.0.1');b.listen(0,'127.0.0.1');await Promise.all([once(a,'listening'),once(b,'listening')]);
  const aa='http://127.0.0.1:'+a.address().port,bb='http://127.0.0.1:'+b.address().port;
  assert.deepEqual(await(await fetch(bb+'/v1/photo-products')).json(),await(await fetch(aa+'/v1/photo-products')).json());
  for(const path of ['/health/ready','/v1/session']){const x=await fetch(aa+path),y=await fetch(bb+path);assert.equal(x.status,503);assert.equal(y.status,x.status);assert.deepEqual(await y.json(),await x.json());}
  assert.equal((await fetch(bb+'/internal/media-cleanup')).status,401);
  await assert.rejects(packageMaintenance(base,out,digest),/EEXIST/);
 }finally{for(const s of [a,b])if(s?.listening)await new Promise(r=>s.close(r));await rm(dir,{recursive:true,force:true});}
});
