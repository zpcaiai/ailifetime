import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeAlbumPreview } from './native-album-preview.mjs';
import { validateMiniProgram } from '../apps/wechat-mini/tools/validate-miniprogram.mjs';

test('isolated preview adds only a development entry, keeps source and security gates intact',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ltm-native-preview-'));
  const sourceRoot=fileURLToPath(new URL('../apps/wechat-mini',import.meta.url));
  const original=readFileSync(join(sourceRoot,'miniprogram/app.json'));
  try {
    const output=join(directory,'preview');
    const manifest=prepareNativeAlbumPreview({sourceRoot,output,apiBaseUrl:'http://127.0.0.1:8189',allowLoopbackDevtools:true});
    assert.equal(manifest.nativeAcceptance,'NOT_RUN');assert.equal(manifest.apiOriginKind,'DEVTOOLS_LOOPBACK_ONLY');
    assert.deepEqual(readFileSync(join(sourceRoot,'miniprogram/app.json')),original);
    const app=JSON.parse(readFileSync(join(output,'miniprogram/app.json')));
    assert.equal(app.pages[0],'pages/native-album-test/index');
    assert.equal(app.pages.length,JSON.parse(original).pages.length+1);
    const project=JSON.parse(readFileSync(join(output,'project.config.json')));
    assert.equal(project.setting.urlCheck,true);assert.equal(project.__usePrivacyCheck__,true);
    const ext=JSON.parse(readFileSync(join(output,'miniprogram/ext.json')));
    assert.equal(ext.ext.nativeAlbumTestEnabled,true);
    assert.equal('accessToken' in ext.ext,false);
    assert.doesNotThrow(()=>validateMiniProgram(output));
    assert.throws(()=>prepareNativeAlbumPreview({sourceRoot,output,apiBaseUrl:'https://album-test.product.cn'}),/OUTPUT_MUST_NOT_EXIST/);
    for(const origin of ['http://127.0.0.1:8189','https://user:pass@domain.cn','https://domain.cn?token=secret','https://fake.invalid']) {
      assert.throws(()=>prepareNativeAlbumPreview({sourceRoot,output:join(directory,'rejected'),apiBaseUrl:origin}),/ACTUAL_HTTPS_ORIGIN_REQUIRED/);
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
