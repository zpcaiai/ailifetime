import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import test from 'node:test';
import {createNativeAlbumNodeEntry} from '../api/native-album.mjs';

const run = promisify(execFile);
test('portable verifier crosses actual TLS/Node/SQLite1+21 and preserves secret and certificate boundaries', {timeout:30000}, async()=>{
  const directory=mkdtempSync(join(tmpdir(),'album-public-check-'));
  const token=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+120000).toISOString();
  const entry=createNativeAlbumNodeEntry({tokenSha256:createHash('sha256').update(token).digest('hex'),expiresAt});
  const cert=join(directory,'ca.pem'),key=join(directory,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
  let redirect=false,trapHits=0;
  const server=https.createServer({cert:readFileSync(cert),key:readFileSync(key)},(req,res)=>{
    if(req.url==='/redirect-trap'){trapHits++;res.end();return;}
    if(redirect){res.writeHead(302,{location:'/redirect-trap'});res.end();return;}
    entry.handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`https://localhost:${server.address().port}`;
  const current=join(directory,'current.json'),old=join(directory,'previous.json');
  writeFileSync(current,JSON.stringify({accessToken:token,expiresAt}),{mode:0o600});
  const oldToken=randomBytes(32).toString('hex');writeFileSync(old,JSON.stringify({accessToken:oldToken,expiresAt}),{mode:0o600});
  const args=['tools/native-album-public-check.py','--origin',origin,'--identity',current,'--previous-identity',old,'--ca-file',cert];
  try {
    const {stdout}=await run('python3',args);const result=JSON.parse(stdout);
    assert.equal(result.tlsValidation,true);assert.equal(result.verified['single-root'].downloaded,1);
    assert.equal(result.verified.root.downloaded,21);assert.equal(new Set(result.verified.root.unique_sha256).size,21);
    assert.equal(result.rejected_previous_identities,1);assert.equal(result.nativePhone,'NOT_RUN');
    assert.equal(stdout.includes(token),false);assert.equal(stdout.includes(oldToken),false);
    await assert.rejects(run('python3',args.slice(0,-2)),error=>/CERTIFICATE_VERIFY_FAILED/.test(error.stderr));
    chmodSync(current,0o644);
    await assert.rejects(run('python3',args),error=>/PRIVATE_IDENTITY_REQUIRED/.test(error.stderr));
    chmodSync(current,0o600);
    const bad=args.map(value=>value===origin?origin+'/unexpected':value);
    await assert.rejects(run('python3',bad),error=>/HTTPS_ORIGIN_REQUIRED/.test(error.stderr));
    writeFileSync(current,JSON.stringify({accessToken:randomBytes(32).toString('hex'),expiresAt}));
    await assert.rejects(run('python3',args),error=>/AUTHENTICATED_RESPONSE_INVALID/.test(error.stderr));
    writeFileSync(current,JSON.stringify({accessToken:token,expiresAt}));redirect=true;
    await assert.rejects(run('python3',args),error=>/REDIRECT_FORBIDDEN/.test(error.stderr));
    assert.equal(trapHits,0);
  } finally {server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await entry.close();rmSync(directory,{recursive:true,force:true});}
});
