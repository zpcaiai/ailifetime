import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADDITIONS = ['tools/native-album-api.mjs','tools/native-album-api.test.mjs','tools/native-album-deployment.mjs',
  'tools/native-album-deployment.test.mjs','docs/NATIVE_ALBUM_TEST_SERVICE.md','tools/native-album-entry.test.mjs',
  'tools/native-album-preview.mjs','tools/native-album-preview.test.mjs',
  'apps/wechat-mini/native-test-entry/index.js','apps/wechat-mini/native-test-entry/index.wxml'];
const sha = value => createHash('sha256').update(value).digest('hex');

export function nginxConfiguration({hostname = '__NATIVE_TEST_HOST__',backendPort = 8189} = {}) {
  if (hostname !== '__NATIVE_TEST_HOST__' && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) || /(?:^|\.)(?:invalid|example|test|localhost)$/.test(hostname))) throw Error('ACTUAL_DNS_HOSTNAME_REQUIRED');
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw Error('BACKEND_PORT_INVALID');
  return `worker_processes 1;
pid nginx.pid;
error_log stderr warn;
events { worker_connections 128; }
http {
  access_log off;
  server {
    listen 443 ssl;
    server_name ${hostname};
    ssl_certificate "__TLS_FULLCHAIN__";
    ssl_certificate_key "__TLS_PRIVATE_KEY__";
    ssl_protocols TLSv1.2 TLSv1.3;
    if ($host != "${hostname}") { return 421; }
    if ($http_origin != "") { return 403; }
    if ($http_cookie != "") { return 403; }
    location ~ "^/(native-album/config|v1/session|v1/capabilities/visible|v1/timelines/(root|single-root)(/nodes/(0|[1-9][0-9]?|100)/image)?)$" {
      limit_except GET { deny all; }
      proxy_pass http://127.0.0.1:${backendPort};
      proxy_set_header Host 127.0.0.1;
      proxy_set_header Authorization $http_authorization;
      proxy_set_header X-Purpose $http_x_purpose;
      proxy_set_header Cookie "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Real-IP "";
      proxy_next_upstream off;
      proxy_read_timeout 35s;
      add_header Cache-Control "no-store" always;
    }
    location / { return 404; }
  }
}
`;
}

export function prepareNativeAlbumDeployment({repository,ref='origin/main',output,hostname,backendPort=8189} = {}) {
  if (!isAbsolute(repository || '') || !isAbsolute(output || '')) throw Error('ABSOLUTE_REPOSITORY_AND_OUTPUT_REQUIRED');
  const nginx = nginxConfiguration({hostname,backendPort});
  const commit = execFileSync('git',['-C',repository,'rev-parse','--verify','--end-of-options',`${ref}^{commit}`],{encoding:'utf8'}).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('SOURCE_COMMIT_INVALID');
  try { mkdirSync(output,{mode:0o700}); } catch (error) {if(error.code==='EEXIST') throw Error('OUTPUT_MUST_NOT_EXIST');throw error;}
  const additions = ADDITIONS.filter(path => existsSync(join(ROOT,path)));
  const archive = join(output,'source.tar');
  execFileSync('git',['-C',repository,'archive','--format=tar',`--output=${archive}`,commit]);
  execFileSync('tar',['-rf',archive,'-C',ROOT,...additions]);
  execFileSync('gzip',['-n',archive]);
  const host = hostname || '__NATIVE_TEST_HOST__';
  const files = {
    'nginx.conf.template':nginx,
    'mini-ext.fragment.json':JSON.stringify({extEnable:true,extAppid:'wx51db2dc9c38f9956',ext:{apiBaseUrl:`https://${host}`,
      apiAllowedOrigins:[`https://${host}`],nativeAlbumTestEnabled:true}},null,2)+'\n',
    'ltm-native-album@.service.template':`[Unit]\nDescription=Isolated native album test API\nAfter=network.target\n[Service]\nUser=ltm-album-test\nGroup=ltm-album-test\nWorkingDirectory=__INSTALL_ROOT__\nExecStart=__NODE26_BIN__ __INSTALL_ROOT__/tools/native-album-api.mjs --synthetic-test-images --output __STATE_ROOT__/run-%i --port ${backendPort} --lifetime-seconds 1800\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nRestart=no\n[Install]\nWantedBy=multi-user.target\n`,
    'README.md':`# Native album test deployment package\n\nSource commit: ${commit}\nStatus: PREPARED_LOCAL; public deployment and phone scenarios NOT_RUN.\n\n1. Use an authorized persistent Linux host with Node26+, pnpm10.12.4 and Nginx. Extract source.tar.gz to a new install directory, install locked dependencies and build: pnpm install --frozen-lockfile; pnpm --filter @ltm/api... build.\n2. Prepare a private state parent owned by a dedicated unprivileged service account. Start tools/native-album-api.mjs with --synthetic-test-images and a NEW --output directory. Do not reuse production databases or credentials. The private identity.json is never included in this package; credentials expire server-side after30min.\n3. Replace every __...__ placeholder in the templates, using the actual registered HTTPS hostname and a valid public certificate/full chain. Review before installing; this tool changes no host service, DNS, permission or security setting. Run nginx -t on the target host, then start only this new service and proxy using that host's change procedure.\n4. Register the real HTTPS request/download domain in the WeChat console for this AppID, complete privacy declarations, and retain domain/TLS/privacy checks. Merge ext fields into an isolated development preview; never put identity.json or the test token in ext.json, QR, URL, source or logs.\n5. Before phone tests, prove HTTPS session and1+21 downloads with the private test identity; no credential must yield401, wrong purpose403, foreign Origin403, unknown/mutation route rejected. Do not use curl -k or a certificate bypass.\n6. On the phone use the separate development-only test entry and enter the temporary test credential. Open single/batch results and exercise the actual existing album-save buttons. Observe actual Photos/Gallery contents and counts, first grant, denial, settings and explicit retry. Test images are labelled transport fixtures; there are0 paid model calls and no quality certification.\n\nRollback: preserve old configs and data before installation; restore only unchanged task-owned configs. Revoke/expire the test identity, then gracefully stop this service instance when testing ends. Never stop unrelated services, overwrite concurrent edits, expose admin/write APIs or substitute local tests for real-phone acceptance.\n`,
  };
  for(const [name,contents] of Object.entries(files))writeFileSync(join(output,name),contents,{flag:'wx',mode:0o600});
  const digests = Object.fromEntries(['source.tar.gz',...Object.keys(files)].map(name=>[name,sha(readFileSync(join(output,name)))]));
  const manifest = {schemaVersion:'ltm.native-album-deployment.v1',sourceCommit:commit,sourceAdditions:additions,
    addonSha256:Object.fromEntries(additions.map(path=>[path,sha(readFileSync(join(ROOT,path)))])),digests,
    hostnameConfigured:Boolean(hostname),publicDeployment:'NOT_RUN',nativeAcceptance:'NOT_RUN',modelQuality:'NOT_CERTIFIED',containsCredentials:false};
  writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{repository:{type:'string'},ref:{type:'string',default:'origin/main'},output:{type:'string'},hostname:{type:'string'},'backend-port':{type:'string',default:'8189'}}});
  try {const manifest=prepareNativeAlbumDeployment({...values,backendPort:Number(values['backend-port'])});console.log(JSON.stringify({event:'native-album-deployment-prepared',output:values.output,...manifest}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
