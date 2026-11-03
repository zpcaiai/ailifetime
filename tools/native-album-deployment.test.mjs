import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { nginxConfiguration,prepareNativeAlbumDeployment } from './native-album-deployment.mjs';
import { createNativeAlbumService } from './native-album-api.mjs';

test('deployment archive contains pinned source and public tools, no test identity or database',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-native-bundle-'));
  try {
    const repository=process.env.LTM_NATIVE_TEST_SOURCE_REPOSITORY || execFileSync('git',['rev-parse','--show-toplevel'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8'}).trim();
    const out=join(directory,'bundle'), manifest=prepareNativeAlbumDeployment({repository,ref:'HEAD',output:out});
    assert.equal(manifest.hostnameConfigured,false);assert.equal(manifest.publicDeployment,'NOT_RUN');
    assert.equal(manifest.containsCredentials,false);
    const list=execFileSync('tar',['-tzf',join(out,'source.tar.gz')],{encoding:'utf8'}).split('\n');
    assert.ok(list.includes('tools/native-album-api.mjs'));
    assert.ok(!list.some(name=>/identity\.json|runtime\.sqlite|node_modules\//.test(name)));
    assert.equal(createHash('sha256').update(readFileSync(join(out,'source.tar.gz'))).digest('hex'),manifest.digests['source.tar.gz']);
    assert.throws(()=>prepareNativeAlbumDeployment({repository,ref:'HEAD',output:out}),/OUTPUT_MUST_NOT_EXIST/);
    assert.throws(()=>nginxConfiguration({hostname:'localhost'}),/ACTUAL_DNS/);
    assert.throws(()=>nginxConfiguration({hostname:'x.invalid'}),/ACTUAL_DNS/);
    assert.throws(()=>nginxConfiguration({hostname:'bad.cn; return 200;'}),/ACTUAL_DNS/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('real Nginx/TLS forwards protected original downloads and rejects unsafe routes/contexts', {timeout:20000}, async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-native-tls-'));let service,proxy;
  try {
    service=await createNativeAlbumService({directory:join(directory,'state'),syntheticTestImages:true,lifetimeSeconds:30});
    const backend=await service.listen(0);
    const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
    const cert=join(directory,'ca.pem'),key=join(directory,'key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
    const configuration=nginxConfiguration({backendPort:backend.port}).replaceAll('__NATIVE_TEST_HOST__','localhost').replace('listen 443 ssl;',`listen 127.0.0.1:${port} ssl;`).replaceAll('__TLS_FULLCHAIN__',cert).replaceAll('__TLS_PRIVATE_KEY__',key);
    const config=join(directory,'nginx.conf');writeFileSync(config,configuration);
    execFileSync('nginx',['-t','-p',directory+'/','-c',config],{stdio:'ignore'});
    proxy=spawn('nginx',['-p',directory+'/','-c',config,'-g','daemon off; master_process off;'],{stdio:['ignore','ignore','ignore']});
    const ca=readFileSync(cert),headers={authorization:`Bearer ${service.identity.accessToken}`,'x-purpose':'age_transformation',host:'localhost'};
    const request=(path,extra={})=>new Promise((resolve,reject)=>{
      const req=https.request({hostname:'127.0.0.1',port,servername:'localhost',ca,path,method:extra.method||'GET',headers:{...headers,...extra.headers}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end();
    });
    let session;
    for(let attempt=0;attempt<40;attempt++) {
      try{session=await request('/v1/session');break;}catch(error){if(error.code!=='ECONNREFUSED')throw error;await new Promise(r=>setTimeout(r,25));}
    }
    assert.equal(session?.status,200);
    const timeline=JSON.parse((await request('/v1/timelines/single-root')).body).data;
    const image=await request(timeline.nodes[0].downloadPath);assert.equal(image.status,200);
    assert.equal(createHash('sha256').update(image.body).digest('hex'),timeline.nodes[0].asset.sha256);
    assert.equal((await request('/v1/session',{headers:{authorization:''}})).status,401);
    assert.equal((await request('/v1/session',{headers:{'x-purpose':'commerce'}})).status,403);
    assert.equal((await request('/v1/session',{headers:{origin:'https://other.cn'}})).status,403);
    assert.equal((await request('/v1/session',{headers:{host:'other.cn'}})).status,421);
    assert.equal((await request('/v1/commands',{method:'POST'})).status,404);
    assert.equal((await request('/v1/timelines/root/retry',{method:'POST'})).status,404);
    assert.equal((await request('/v1/session',{method:'POST'})).status,403);
  } finally {
    if(proxy&&proxy.exitCode===null){proxy.kill('SIGQUIT');await once(proxy,'exit');}
    if(service)await service.close();rmSync(directory,{recursive:true,force:true});
  }
});
