import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'native-album-public');
if (Number(process.versions.node.split('.')[0]) !== 26) throw Error('NATIVE_ALBUM_BUILD_REQUIRES_NODE26');
const landing = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>相册保存开发测试</title><main><h1>相册保存开发测试</h1><p>仅使用明确标注的测试图片。请从微信开发预览进入。</p><p>真机验证尚待执行。</p></main></html>\n';
function verifyPublicOutput(allowEmpty) {
  const files = existsSync(output) ? readdirSync(output) : [];
  if (allowEmpty && files.length === 0) return;
  if (files.length !== 1 || files[0] !== 'index.html' || readFileSync(join(output, 'index.html'), 'utf8') !== landing) {
    throw Error('NATIVE_ALBUM_PUBLIC_OUTPUT_NOT_ALLOWLISTED');
  }
}
verifyPublicOutput(true);
mkdirSync(output, {recursive:true});
writeFileSync(join(output, 'index.html'), landing, {flag:'w'});
const build = spawnSync('pnpm', ['--workspace-concurrency=1', '--filter', '@ltm/api...', 'build'], {cwd:root, stdio:'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
verifyPublicOutput(false);
console.log(JSON.stringify({event:'native-album-api-built',node:process.version,publicFiles:1,nativeAcceptance:'NOT_RUN',paidModelCalls:0}));
