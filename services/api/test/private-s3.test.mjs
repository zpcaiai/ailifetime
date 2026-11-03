import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrivateS3Images } from '../dist/private-s3.js';

test('real S3 SDK signs HTTP, keeps objects private, bounds downloads and does not equate403 with absence',async()=>{
 const objects=new Map(),calls=[];let forbidden=false,versioning='';
 // Only the external S3 service is synthetic; the actual SDK signer/HTTP/parser execute.
 const server=createServer(async(req,res)=>{
  calls.push(req.method);assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 /);assert.equal(req.headers['x-amz-acl'],undefined);
  const path=new URL(req.url,'http://localhost').pathname;
  if(forbidden){res.statusCode=403;res.end('<Error><Code>AccessDenied</Code></Error>');return;}
  if(req.method==='GET' && new URL(req.url,'http://localhost').searchParams.has('versioning')){res.setHeader('content-type','application/xml');res.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'+(versioning?'<Status>'+versioning+'</Status>':'')+'</VersioningConfiguration>');return;}
  if(req.method==='HEAD' && ['/private-photos','/private-photos/'].includes(path)){res.end();return;}
  if(req.method==='PUT'){
   assert.equal(req.headers['cache-control'],'private, no-store');assert.equal(req.headers['if-none-match'],'*');assert.equal(req.headers['content-type'],'image/png');
   if(objects.has(path)){res.statusCode=412;res.end();return;}
   const chunks=[];for await(const c of req)chunks.push(c);objects.set(path,Buffer.concat(chunks));res.end();return;
  }
  if(req.method==='DELETE'){objects.delete(path);res.statusCode=204;res.end();return;}
  if(!objects.has(path)){res.statusCode=404;res.end();return;}
  res.setHeader('content-length',objects.get(path).length);res.end(req.method==='HEAD'?undefined:objects.get(path));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const config={endpoint:'http://127.0.0.1:'+server.address().port,region:'us-east-1',bucket:'private-photos',accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret',testLoopback:true};
 const store=new PrivateS3Images(config),key='generated/'+'a'.repeat(64)+'.png',bytes=Buffer.from('synthetic-object-bytes');
 try{
  await store.readiness();
  await store.put(key,bytes);assert.equal(await store.exists(key),true);assert.deepEqual(Buffer.from(await store.get(key,bytes.length)),bytes);
  await store.put(key,Buffer.from('different'));assert.deepEqual(Buffer.from(await store.get(key,bytes.length)),bytes);
  await assert.rejects(store.get(key,1),/immutable size/);
  forbidden=true;await assert.rejects(store.exists(key));await assert.rejects(store.readiness());forbidden=false;
  for(versioning of ['Enabled','Suspended']){await assert.rejects(store.readiness(),/unversioned/);await assert.rejects(store.remove(key),/unversioned/);assert.equal(await store.exists(key),true);await assert.rejects(store.put(key,bytes),/unversioned/);}versioning='';
  await store.remove(key);assert.equal(await store.exists(key),false);
  await assert.rejects(store.remove('../other'));assert.ok(calls.includes('DELETE'));
  assert.throws(()=>new PrivateS3Images({...config,testLoopback:undefined}),/configuration/);
 }finally{store.close();await new Promise(r=>server.close(r));}
});
