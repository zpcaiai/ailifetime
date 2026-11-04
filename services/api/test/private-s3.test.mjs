import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {createServer as createHttpsServer,Agent} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

test('TOS addressing uses actual SDK signing over verified TLS virtual hosts while rejecting ambiguous region/bucket',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tos-sdk-tls-')),host='private-photos.tos-s3-cn-beijing.volces.com';
 let server,store,agent,fixtureError;const objects=new Map(),calls=[];
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-sha256','-days','1','-subj','/CN='+host,'-addext','subjectAltName=DNS:'+host,'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
  const cert=await readFile(join(dir,'cert.pem'));
  // The remote object service alone is synthetic. Real SDK endpoint resolution,
  // signing, Node HTTP transport, TLS trust and hostname validation all execute.
  server=createHttpsServer({key:await readFile(join(dir,'key.pem')),cert},async(req,res)=>{
   try{
    assert.equal(req.headers.host,host+':'+server.address().port);
    assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 Credential=synthetic-key\/\d{8}\/cn-beijing\/s3\/aws4_request,/);
    assert.match(req.headers.authorization,/SignedHeaders=[^,]*host/);
    assert.equal(req.headers['x-amz-acl'],undefined);
    const u=new URL(req.url,'https://'+host);assert.equal(u.pathname.startsWith('/private-photos'),false);calls.push(req.method);
    if(req.method==='HEAD'&&u.pathname==='/'){res.end();return;}
    if(req.method==='GET'&&u.searchParams.has('versioning')){res.setHeader('content-type','application/xml');res.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');return;}
    if(req.method==='PUT'){
     assert.equal(req.headers['if-none-match'],'*');assert.equal(req.headers['cache-control'],'private, no-store');
     const chunks=[];for await(const chunk of req)chunks.push(chunk);objects.set(u.pathname,Buffer.concat(chunks));res.end();return;
    }
    if(req.method==='DELETE'){objects.delete(u.pathname);res.statusCode=204;res.end();return;}
    if(!objects.has(u.pathname)){res.statusCode=404;res.end();return;}
    const bytes=objects.get(u.pathname);res.setHeader('content-length',bytes.length);res.end(req.method==='HEAD'?undefined:bytes);
   }catch(error){fixtureError=error;res.statusCode=500;res.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const config={endpoint:'https://tos-s3-cn-beijing.volces.com:'+server.address().port,region:'cn-beijing',bucket:'private-photos',accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret'};
  assert.throws(()=>new PrivateS3Images({...config,region:'cn-shanghai'}),/TOS S3/);
  assert.throws(()=>new PrivateS3Images({...config,bucket:'private.photos'}),/TOS S3/);
  store=new PrivateS3Images(config);
  agent=new Agent({ca:cert,rejectUnauthorized:true,lookup:(name,options,callback)=>{
   if(name!==host){callback(new Error('unexpected TLS fixture hostname'));return;}
   if(options?.all)callback(null,[{address:'127.0.0.1',family:4}]);else callback(null,'127.0.0.1',4);
  }});
  // SDK's supported transport setting maps only this test host to the real
  // loopback TLS server; production DNS, CA trust and request generation stay intact.
  store.client.config.requestHandler.updateHttpClientConfig('httpsAgent',agent);
  const key='generated/'+'b'.repeat(64)+'.png',bytes=Buffer.from('actual-sdk-tos-bytes');
  await store.readiness();await store.put(key,bytes);assert.equal(await store.exists(key),true);
  assert.deepEqual(Buffer.from(await store.get(key,bytes.length)),bytes);
  await store.remove(key);assert.equal(await store.exists(key),false);
  assert.equal(fixtureError,undefined);assert.ok(calls.includes('PUT')&&calls.includes('GET')&&calls.includes('DELETE'));
 }finally{
  store?.close();agent?.destroy();if(server?.listening)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
 }
});
