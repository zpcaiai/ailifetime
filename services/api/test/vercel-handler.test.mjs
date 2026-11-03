import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createVercelHandler } from '../dist/vercel-handler.js';

test('Vercel HTTP entry exposes actual liveness/catalog while missing production auth stays503 and cron is protected',async()=>{
 const secret='synthetic-cron-secret-'.repeat(3),app=createVercelHandler({CRON_SECRET:secret},process.cwd());
 const server=createServer((req,res)=>void app.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  const live=await fetch(base+'/health/live');assert.equal(live.status,200);assert.equal((await live.json()).runtime,process.version);
  const catalog=await fetch(base+'/v1/photo-products');assert.equal(catalog.status,200);assert.deepEqual((await catalog.json()).data.products.map(p=>p.amountMinor),[1990,2990,2990,4990,590,990]);
  for(const path of ['/health/ready','/v1/session','/v1/auth/wechat/session']){
   const r=await fetch(base+path);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'BACKEND_NOT_CONFIGURED');
  }
  for(const headers of [{},{authorization:'Bearer wrong'},{authorization:'Bearer '+secret.slice(1)}])assert.equal((await fetch(base+'/internal/media-cleanup',{headers})).status,401);
  assert.equal((await fetch(base+'/internal/media-cleanup?limit=100',{headers:{authorization:'Bearer '+secret}})).status,400);
  assert.equal((await fetch(base+'/internal/media-cleanup',{headers:{authorization:'Bearer '+secret}})).status,503);
 }finally{await new Promise(r=>server.close(r));await app.close();}
});
