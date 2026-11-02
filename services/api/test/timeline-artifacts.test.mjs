import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTimelineArtifactStore,configuredTimelineArtifacts } from '../dist/timeline-artifacts.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
test('file-store configuration is opt-in and cannot silently replace production storage',()=>{
  assert.equal(configuredTimelineArtifacts({},'local'),undefined);
  for(const app of ['production','staging']) assert.throws(()=>configuredTimelineArtifacts({LTM_TIMELINE_MEDIA_DIRECTORY:'/tmp/not-created-by-this-test'},app),/local\/test/);
  assert.throws(()=>configuredTimelineArtifacts({LTM_TIMELINE_MEDIA_DIRECTORY:'relative'},'local'),/absolute/);
});
test('real immutable file bytes roundtrip and tamper/symlink/length/MIME mismatches fail', async () => {
  const directory = mkdtempSync(join(tmpdir(),'ltm-timeline-files-'));
  try {
    const store = new FileTimelineArtifactStore(directory), asset = await store.put('synthetic-pixel',png,'image/png');
    assert.deepEqual(Buffer.from(await store.read(asset)),png);
    assert.deepEqual(await store.put('same-image',png,'image/png'),{...asset,id:'same-image'});
    await assert.rejects(store.read({...asset,byteLength:asset.byteLength-1}),/length/);
    await assert.rejects(store.read({...asset,width:1024}),/dimensions/);
    await assert.rejects(store.put('bad',Buffer.from('not an image'),'image/png'),/header/);
    writeFileSync(join(directory,`${asset.sha256}.png`),Buffer.alloc(png.length));
    await assert.rejects(store.read(asset),/digest/);
    rmSync(join(directory,`${asset.sha256}.png`)); symlinkSync('/etc/hosts',join(directory,`${asset.sha256}.png`));
    await assert.rejects(store.read(asset),/unavailable/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
