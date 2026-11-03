import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('configured Vercel build produces actual API code and only a non-sensitive public landing',()=>{
  const config=JSON.parse(readFileSync(join(root,'vercel.json')));
  assert.equal(config.buildCommand,'node tools/native-album-build.mjs');
  assert.equal(config.installCommand,'pnpm install --frozen-lockfile');
  assert.equal(config.outputDirectory,'native-album-public');
  assert.deepEqual(config.rewrites,[{source:'/(.*)',destination:'/api/native-album'}]);
  const includes=config.functions['api/native-album.mjs'].includeFiles;
  for(const file of ['tools/native-album-api.mjs','tools/native-album-serverless.mjs','services/api/dist/**','services/api/test/timeline-fixtures.mjs','packages/*/dist/**']) assert.ok(includes.includes(file));
  assert.ok(!includes.includes('identity.json')&&!includes.includes('.env'));
  const result=spawnSync(process.execPath,['tools/native-album-build.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(result.stdout.includes('native-album-api-built'));
  assert.ok(readFileSync(join(root,'services/api/dist/index.js')).length>0);
  assert.deepEqual(readdirSync(join(root,config.outputDirectory)),['index.html']);
  const landing=readFileSync(join(root,config.outputDirectory,'index.html'),'utf8');
  assert.ok(landing.includes('真机验证尚待执行'));
  assert.ok(!landing.includes('Bearer')&&!landing.includes('accessToken'));
});

test('build rejects an unexpected public file before executing package build and preserves that file',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-album-build-reject-'));
  try {
    mkdirSync(join(directory,'tools'));cpSync(join(root,'tools/native-album-build.mjs'),join(directory,'tools/native-album-build.mjs'));
    mkdirSync(join(directory,'native-album-public'));
    const file=join(directory,'native-album-public/private-state.json');writeFileSync(file,'synthetic-secret-must-never-ship');
    const result=spawnSync(process.execPath,['tools/native-album-build.mjs'],{cwd:directory,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/NATIVE_ALBUM_PUBLIC_OUTPUT_NOT_ALLOWLISTED/);
    assert.equal(readFileSync(file,'utf8'),'synthetic-secret-must-never-ship');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
