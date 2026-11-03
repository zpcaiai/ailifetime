import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {BrokerClient} from '../dist/client-integrations.js';
import {BrokerTimelineSourceReader} from '../dist/seedream-source.js';

test('approved source uses authenticated broker protocol, ignores supplied URL, verifies bytes and expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seedream-source-')),key=join(dir,'token');
 await writeFile(key,'synthetic-source-workload-token-001',{mode:0o600});
 const bytes=Buffer.from([255,216,1,2,3,255,217]);
 const asset={id:'source',mimeType:'image/jpeg',width:1,height:1,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 let mode='ok',gets=0;const errors=[];
 const server=createServer(async(req,res)=>{try{
  assert.equal(req.headers.authorization,'Bearer synthetic-source-workload-token-001');
  if(req.method==='POST'){
   assert.equal(req.url,'/v1/media/assets/source/download-authorizations');
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
   assert.deepEqual(body.principal,{tenantId:'tenant',actorId:'owner',roles:['consumer'],purpose:'age_transformation'});assert.equal(body.audience,'owner');
   res.setHeader('content-type','application/json');res.end(JSON.stringify({token:mode==='token'?'../bad':'claims.signature',downloadUrl:'https://untrusted.invalid/never-follow',expiresAt:new Date(Date.now()+(mode==='expired'?-1000:60000)).toISOString()}));return;
  }
  gets++;assert.equal(req.url,'/v1/media/downloads/claims.signature');assert.equal(req.headers['x-ltm-actor-id'],'owner');
  if(mode==='redirect'){res.writeHead(302,{location:'https://untrusted.invalid'}).end();return;}
  res.writeHead(200,{'content-type':'image/jpeg','x-ltm-media-reference':mode==='owner'?'other':'source','x-ltm-authorization-expires-at':new Date(Date.now()+60000).toISOString()});res.end(mode==='corrupt'?Buffer.from([255,216,9,9,9,255,217]):mode==='large'?Buffer.concat([bytes,bytes]):bytes);
 }catch(e){errors.push(e);res.writeHead(500).end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const reader=new BrokerTimelineSourceReader(new BrokerClient({baseUrl:'http://127.0.0.1:'+server.address().port,workloadTokenFile:key,allowInsecureLoopback:true}));
 try{
  const actor={tenantId:'tenant',actorId:'owner'};
  assert.deepEqual(await reader.read(asset,actor),bytes);
  for(mode of ['corrupt','large','owner','redirect','token','expired'])await assert.rejects(reader.read(asset,actor));
  assert.equal(gets,5);await assert.rejects(reader.read(asset),/owner/);
  assert.deepEqual(errors,[]);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
