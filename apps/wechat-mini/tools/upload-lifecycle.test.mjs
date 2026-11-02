import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
function load(file,env){const module={exports:{}};runInNewContext(readFileSync(new URL('../miniprogram/services/'+file,import.meta.url),'utf8'),{module,ArrayBuffer,Uint8Array,...env});return module.exports;}
test('actual HTTP/file upload accepts native-realm bytes and cancels after final chunk without completion',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-upload-lifecycle-'));const path=join(dir,'image.jpg'),bytes=Buffer.from([1,2,3,4]);writeFileSync(path,bytes);
 let signal={cancelled:false},cancelAfterChunk=false,spoof=false;const calls=[],received=[];
 const server=createServer(async(req,res)=>{calls.push(req.url);const chunks=[];for await(const b of req)chunks.push(b);if(req.url.endsWith('/chunks'))received.push(Buffer.concat(chunks));res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/v1/uploads'?{uploadId:'upload',nextOffset:0}:req.url.endsWith('/chunks')?{nextOffset:bytes.length}:req.url.endsWith('/complete')?{assetId:'asset'}:{state:'cancelled'}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const api={idempotencyKey:prefix=>prefix,async requestForPurpose(route,purpose,options){assert.equal(purpose,'age_transformation');const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:options.headers,body:typeof options.data==='string'?Buffer.from(options.data,'base64'):JSON.stringify(options.data)});const data=await response.json();if(cancelAfterChunk&&route.endsWith('/chunks'))signal.cancelled=true;return data;}};
 const sha=load('sha256.js',{});const wx={getImageInfo:({success})=>success({type:'jpeg',width:512,height:512}),arrayBufferToBase64:value=>Buffer.from(value).toString('base64'),getFileSystemManager:()=>({stat:({path,success})=>success({stats:statSync(path)}),readFile({filePath,position,length,success}){const part=readFileSync(filePath).subarray(position,position+length);success({data:spoof?{byteLength:length,[Symbol.toStringTag]:'ArrayBuffer'}:runInNewContext('Uint8Array.from(bytes).buffer',{bytes:[...part]})});}})};
 const upload=load('upload.js',{wx,require:n=>n==='./api'?api:sha});
 try{
  const file=await upload.preflight(path);assert.equal(file.digest,createHash('sha256').update(bytes).digest('hex'));
  signal.cancelled=true;await assert.rejects(upload.resumableUpload(file,()=>{},signal),/UPLOAD_CANCELLED/);assert.equal(calls.length,0);
  signal={cancelled:false};cancelAfterChunk=true;await assert.rejects(upload.resumableUpload(file,()=>{},signal),/UPLOAD_CANCELLED/);assert.deepEqual(calls,['/v1/uploads','/v1/uploads/upload/chunks','/v1/uploads/upload/cancel']);assert.deepEqual(received[0],bytes);
  calls.length=0;signal={cancelled:false};cancelAfterChunk=false;assert.equal((await upload.resumableUpload(file,()=>{},signal)).assetId,'asset');assert.ok(calls.includes('/v1/uploads/upload/complete'));
  spoof=true;await assert.rejects(upload.preflight(path),/MEDIA_READ_LENGTH_MISMATCH/);
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
