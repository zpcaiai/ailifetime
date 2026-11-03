import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HttpPhotoScorer} from '../dist/photo-score-client.js';
import {request} from './photo-score-fixtures.mjs';
test('oversized chunked model response is cancelled before the server finishes sending',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'score-stream-')),token=join(directory,'token');writeFileSync(token,'synthetic-stream-workload-token-00001',{mode:0o600});
 let sent=0,closedResolve;const closed=new Promise(resolve=>closedResolve=resolve);
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req){} // Consume the real request before streaming the adversarial model reply.
  res.setHeader('content-type','application/json');
  const timer=setInterval(()=>{sent++;res.write(Buffer.alloc(16384,120));if(sent===128){clearInterval(timer);res.end();}},4);
  res.on('close',()=>{clearInterval(timer);closedResolve();});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const scorer=new HttpPhotoScorer({baseUrl:'http://127.0.0.1:'+server.address().port,allowInsecureLoopback:true,timeoutMs:30000,workloadTokenFile:token});
  await assert.rejects(scorer.evaluate(request()),{code:'DEPENDENCY_UNAVAILABLE'});await closed;
  assert.ok(sent<128,`response was fully buffered: server sent all ${sent} chunks`);
  assert.ok(sent>=32,'server should reach the real512KiB response boundary');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
