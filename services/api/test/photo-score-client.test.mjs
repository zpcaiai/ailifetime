import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {digest} from '../dist/photo-score-contract.js';
import {request,response} from './photo-score-fixtures.mjs';

async function boundary(run) {
 const dir=mkdtempSync(join(tmpdir(),'ltm-score-client-')),token=join(dir,'token');writeFileSync(token,'synthetic-workload-token-000001',{mode:0o600});
 let behavior='ok',calls=0,received;
 const server=createServer(async(req,res)=>{
  calls++;const parts=[];for await(const chunk of req)parts.push(chunk);received=JSON.parse(Buffer.concat(parts));
  assert.equal(req.url,'/v1/photo-scores');assert.equal(req.headers.authorization,'Bearer synthetic-workload-token-000001');
  assert.equal(req.headers['idempotency-key'],'photo-score:'+received.requestSha256);
  assert.equal(digest(Buffer.from(received.reference.base64,'base64')),received.reference.asset.sha256);
  assert.equal(digest(Buffer.from(received.output.base64,'base64')),received.output.asset.sha256);
  if(behavior==='timeout'){setTimeout(()=>res.end('{}'),700).unref();return;}
  if(behavior==='redirect'){res.writeHead(302,{location:'/redirected'}).end();return;}
  if(behavior==='error'){res.writeHead(503).end('private-scorer-error');return;}
  if(behavior==='invalid'){res.end('not-json');return;}
  if(behavior==='oversize'){res.end('x'.repeat(2*1024*1024));return;}
  const result=response(received);if(behavior==='mismatch')result.requestSha256='b'.repeat(64);
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const options={baseUrl:'http://127.0.0.1:'+server.address().port,workloadTokenFile:token,allowInsecureLoopback:true,timeoutMs:500};
 try{await run(new HttpPhotoScorer(options),b=>behavior=b,()=>calls,()=>received,options);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
}
test('actual authenticated HTTP transmits exact reference/output bytes and stable inference idempotency',()=>boundary(async(client,_set,calls,received)=>{
 const r=request();assert.deepEqual(await client.evaluate(r),response(r));assert.deepEqual(await client.evaluate(r),response(r));assert.equal(calls(),2);
 assert.deepEqual(received().people,r.people);const bad=structuredClone(r);bad.targetAge=0;await assert.rejects(client.evaluate(bad),/binding/);assert.equal(calls(),2);
}));
test('HTTP outage, wrong binding, redirect, malformed/oversize response and timeout never supply fallback scores',()=>boundary(async(client,set,calls)=>{
 for(const mode of ['error','mismatch','redirect','invalid','oversize','timeout']){set(mode);const before=calls();await assert.rejects(client.evaluate(request()),e=>e.code==='DEPENDENCY_UNAVAILABLE'&&!e.message.includes('private-scorer-error'));assert.equal(calls(),before+1);}
}));
test('insecure remote origins and unsafe workload credentials are rejected',()=>boundary(async(_client,_set,calls,_received,options)=>{
 for(const baseUrl of ['http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com?token=x'])assert.throws(()=>new HttpPhotoScorer({...options,baseUrl}),/HTTPS origin/);
 writeFileSync(options.workloadTokenFile,'synthetic-workload-token-000001',{mode:0o600});
 const {chmodSync}=await import('node:fs');chmodSync(options.workloadTokenFile,0o666);
 await assert.rejects(new HttpPhotoScorer(options).evaluate(request()),{code:'DEPENDENCY_UNAVAILABLE',message:'photo scorer is unavailable'});assert.equal(calls(),0);
}));
