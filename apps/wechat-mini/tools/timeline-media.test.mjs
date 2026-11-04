import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash,randomFillSync } from 'node:crypto';
import { readFileSync,writeFileSync,mkdtempSync,rmSync,unlinkSync,statSync,copyFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
function load(file,context){const module={exports:{}};runInNewContext(readFileSync(new URL(file,import.meta.url),'utf8'),{module,exports:module.exports,ArrayBuffer,Uint8Array,...context});return module.exports;}
test('actual HTTP/filesystem with cross-realm native buffers verifies original bytes, rejects spoofed buffers and cleans denied saves',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-mini-media-'));let count=0,deny=false,spoof=false,denyUnlink=false,privacyHook=()=>{},randomMode='valid',randomHook=()=>{};const downloads=[];
  const server=createServer((request,response)=>{assert.equal(request.headers.authorization,'Bearer test-memory-session');assert.equal(request.headers['x-purpose'],'age_transformation');response.setHeader('content-type','image/png');response.end(image);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const filesystem={stat({path,success}){success({stats:statSync(path)});},readFile({filePath,position,length,success}){const value=readFileSync(filePath).subarray(position,position+length);const binary=runInNewContext('Uint8Array.from(bytes).buffer',{bytes:[...value]});assert.equal(binary instanceof ArrayBuffer,false);success({data:spoof?{byteLength:length,[Symbol.toStringTag]:'ArrayBuffer'}:binary});},unlink({filePath,success,fail}){try{if(denyUnlink)throw new Error('permission denied');unlinkSync(filePath);success();}catch{fail();}}};
  const wx={env:{USER_DATA_PATH:directory},getRandomValues(options){assert.equal(options.length,16);assert.equal(typeof options.success,'function');queueMicrotask(()=>{randomHook();if(randomMode==='fail')options.fail({errMsg:'getRandomValues:fail'});else{const bytes=randomFillSync(new Uint8Array(randomMode==='short'?15:16));const binary=runInNewContext('Uint8Array.from(bytes).buffer',{bytes:[...bytes]});options.success({randomValues:randomMode==='spoof'?{byteLength:16,[Symbol.toStringTag]:'ArrayBuffer'}:binary});}});},getFileSystemManager:()=>filesystem,
    downloadFile(options){assert.ok(options.filePath.startsWith(directory+'/ltm-timeline-'));fetch(options.url,{headers:options.header}).then(async response=>{const path=options.filePath;count++;downloads.push(path);writeFileSync(path,Buffer.from(await response.arrayBuffer()));options.success({statusCode:response.status,filePath:path});}).catch(options.fail);},
    getImageInfo({success}){success({width:1,height:1});},saveImageToPhotosAlbum({filePath,success,fail}){if(deny)fail({errMsg:'auth deny'});else{copyFileSync(filePath,join(directory,'album.png'));success({});}}};
  const sha=load('../miniprogram/services/sha256.js',{});
  const media=load('../miniprogram/services/timeline-media.js',{wx,require(name){if(name==='./api')return{configuration:()=>({baseUrl})};if(name==='./session')return{requireSession:()=>({accessToken:'test-memory-session'}),clear(){}};if(name==='./privacy')return{requireAuthorization:async()=>{privacyHook();}};if(name==='./sha256')return sha;throw new Error(name);}});
  const node={status:'ready',downloadPath:'/v1/timelines/root/nodes/0/image',asset:{sha256:createHash('sha256').update(image).digest('hex'),byteLength:image.length,width:1,height:1}};
  try{
    const path=await media.download(node);assert.deepEqual(readFileSync(path),image);await media.clearAll();assert.equal(existsSync(path),false);
    await media.save(node);assert.deepEqual(readFileSync(join(directory,'album.png')),image);assert.equal(existsSync(downloads[1]),false);
    await assert.rejects(media.download({...node,asset:{...node.asset,sha256:'a'.repeat(64)}}),/DIGEST_MISMATCH/);assert.equal(existsSync(downloads[2]),false);
    deny=true;await assert.rejects(media.save(node),/ALBUM_PERMISSION_REQUIRED/);assert.equal(existsSync(downloads[3]),false);
    spoof=true;await assert.rejects(media.download(node),/TIMELINE_IMAGE_READ_FAILED/);assert.equal(existsSync(downloads[4]),false);
    spoof=false;const retryCleanup=await media.download(node);denyUnlink=true;
    assert.equal(await media.remove(retryCleanup),false);assert.equal(existsSync(retryCleanup),true);
    denyUnlink=false;await media.clearAll();assert.equal(existsSync(retryCleanup),false);
    assert.equal(count,6);assert.equal(new Set(downloads).size,6);
    await assert.rejects(media.save(node,{cancelled:true}),/MEDIA_REQUEST_CANCELLED/);assert.equal(count,6);
    const cancelled={cancelled:false};privacyHook=()=>{cancelled.cancelled=true;};await assert.rejects(media.save(node,cancelled),/MEDIA_REQUEST_CANCELLED/);assert.equal(count,6);privacyHook=()=>{};
    wx.openSetting=({success})=>success({authSetting:{'scope.writePhotosAlbum':true}});assert.equal(await media.openAlbumSettings(),true);wx.openSetting=({success})=>success({authSetting:{'scope.writePhotosAlbum':false}});assert.equal(await media.openAlbumSettings(),false);assert.equal(count,6);
    await assert.rejects(media.download({...node,downloadPath:'https://other.invalid/image'}),/UNAVAILABLE/);
    for(const mode of ['fail','short','spoof']){randomMode=mode;await assert.rejects(media.download(node),/TIMELINE_RANDOM_UNAVAILABLE/);assert.equal(count,6);}
    randomMode='valid';randomHook=()=>{void media.clearAll();};await assert.rejects(media.download(node),/MEDIA_REQUEST_CANCELLED/);assert.equal(count,6);randomHook=()=>{};
  }finally{await media.clearAll();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
