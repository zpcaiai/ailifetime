import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSeedreamLaunch } from './seedream-launch-check.mjs';

const requirements=inspectSeedreamLaunch({names:[]}).missing;
const names=requirements.map(r=>r.oneOf[0]);
test('launch inventory enumerates missing dependency groups without pretending names establish readiness',()=>{
 const report=inspectSeedreamLaunch({names:['DATABASE_URL','ARK_API_KEY']});assert.equal(report.status,'BLOCKED_INCOMPLETE');
 assert.deepEqual([...new Set(report.missing.map(r=>r.group))].sort(),['brokers','consent','generation','quality','runtime','storage']);
 assert.equal(report.missing.some(r=>r.oneOf.includes('ARK_API_KEY')),false);
 const complete=inspectSeedreamLaunch({names});assert.equal(complete.status,'NAMES_PRESENT_RUNTIME_UNVERIFIED');assert.equal(complete.runtimeVerification,'NOT_RUN');assert.equal(complete.realGeneration,'NOT_RUN');assert.equal(complete.publishable,false);
 const conflict=inspectSeedreamLaunch({names:[...names,'LTM_SEEDREAM_API_KEY_FILE']});assert.equal(conflict.status,'BLOCKED_INCOMPLETE');assert.deepEqual(conflict.conflicts,[{group:'generation',oneOf:['ARK_API_KEY','LTM_SEEDREAM_API_KEY_FILE']}]);
});
test('environment checks enforce production flags/TLS/HTTPS and never return secrets or foreign names',()=>{
 const secret='synthetic-private-marker';const env=Object.fromEntries(names.map(n=>[n,secret]));
 Object.assign(env,{DATABASE_URL:'postgres://synthetic@db.invalid/app?sslmode=verify-full',LTM_AUTH_MODE:'oidc',LTM_SEEDREAM_ENABLED:'true',CRON_SECRET:secret.repeat(3)});
 for(const n of names.filter(n=>n.endsWith('_URL')||n==='LTM_PHOTO_S3_ENDPOINT'))if(n!=='DATABASE_URL')env[n]='https://approved.invalid';
 assert.equal(inspectSeedreamLaunch({environment:env}).status,'STATIC_CONFIGURATION_PRESENT_RUNTIME_UNVERIFIED');
 Object.assign(env,{DATABASE_URL:'postgres://synthetic@db.invalid/app?sslmode=require',LTM_UPLOAD_BROKER_URL:'http://127.0.0.1',LTM_SEEDREAM_ENABLED:'false',LTM_AUTH_MODE:'configured-tokens',CRON_SECRET:'short',FOREIGN_SECRET:secret});
 const report=inspectSeedreamLaunch({environment:env});assert.deepEqual(report.invalid.sort(),['CRON_SECRET','DATABASE_URL','LTM_AUTH_MODE','LTM_SEEDREAM_ENABLED','LTM_UPLOAD_BROKER_URL']);
 const text=JSON.stringify(report);assert.equal(text.includes(secret),false);assert.equal(text.includes('FOREIGN_SECRET'),false);
});
test('actual CLI validates names-only files, returns nonzero for blockers and hides malformed input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seedream-inventory-'));const path=join(dir,'names.json');
 try{
  await writeFile(path,JSON.stringify(names));let p=spawnSync(process.execPath,['tools/seedream-launch-check.mjs','--names-json',path],{encoding:'utf8'});
  assert.equal(p.status,0);assert.equal(JSON.parse(p.stdout).realGeneration,'NOT_RUN');
  await writeFile(path,'[]');p=spawnSync(process.execPath,['tools/seedream-launch-check.mjs','--names-json',path],{encoding:'utf8'});assert.equal(p.status,1);assert.equal(JSON.parse(p.stdout).status,'BLOCKED_INCOMPLETE');
  await writeFile(path,'["synthetic-private-value"]');p=spawnSync(process.execPath,['tools/seedream-launch-check.mjs','--names-json',path],{encoding:'utf8'});assert.equal(p.status,2);assert.equal((p.stdout+p.stderr).includes('synthetic-private-value'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
