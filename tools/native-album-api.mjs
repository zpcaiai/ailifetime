import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DomainError } from '../packages/core/dist/index.js';
import { createApiServer, StaticTokenAuthenticator } from '../services/api/dist/index.js';
import { FileTimelineArtifactStore } from '../services/api/dist/timeline-artifacts.js';
import { timelineFixture, syntheticPng } from '../services/api/test/timeline-fixtures.mjs';

// An explicitly synthetic transport/permission test dataset. No model is called,
// and sandbox fixture quality records are not production or image-quality proof.
export async function createNativeAlbumService({directory, syntheticTestImages, lifetimeSeconds = 1800} = {}) {
  if (syntheticTestImages !== true) throw Error('EXPLICIT_SYNTHETIC_TEST_IMAGES_REQUIRED');
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw Error('ABSOLUTE_OUTPUT_REQUIRED');
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 3600) throw Error('LIFETIME_MUST_BE_1_TO_3600_SECONDS');
  try { mkdirSync(directory, {mode:0o700}); } catch (error) { if (error.code === 'EEXIST') throw Error('OUTPUT_MUST_NOT_EXIST'); throw error; }
  let fixture, core, server;
  try {
    fixture = await timelineFixture(join(directory, 'runtime.sqlite'), {verifiedConsent:true});
    const store = new FileTimelineArtifactStore(join(directory, 'images'));
    const batch = [];
    for (let age = 0; age <= 100; age += 5) batch.push(await fixture.readyNode(await store.put(`native-test-${age}`, syntheticPng(age, 512, 512), 'image/png'), age));
    const manifest = nodes => ({schemaVersion:'ltm.timeline-results.v1', sourceAssetId:'source', planVersion:'age-portrait-plan.v1', aiLabel:true, nodes});
    fixture.runtime.applyExternalBusinessEvent(fixture.service, fixture.callback('root', 'succeeded', manifest(batch)));
    await fixture.registry.execute(fixture.runtime, 'B14', {actor:fixture.actor, idempotencyKey:'single-root', input:{
      jobId:'single-root', sourceAssetId:'source', participantIds:['user'], targetAges:[37], currentAge:35,
      timelineProfile:'single-age-v1', seed:'native-album-test-only', promptPolicyVersion:'age-policy-v1', illustrativeLabel:true,
    }});
    const single = await fixture.readyNode(await store.put('native-test-single', syntheticPng(37, 512, 512), 'image/png'), 37);
    fixture.runtime.applyExternalBusinessEvent(fixture.service, fixture.callback('single-root', 'succeeded', manifest([single])));
    const identity = {accessToken:randomBytes(32).toString('hex'), expiresAt:new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
      actorId:fixture.actor.actorId, tenantId:fixture.actor.tenantId, roles:['consumer'], purpose:'age_transformation'};
    const delegate = new StaticTokenAuthenticator([{tokenSha256:createHash('sha256').update(identity.accessToken).digest('hex'),
      actorId:identity.actorId, tenantId:identity.tenantId, roles:identity.roles, allowedPurposes:[identity.purpose]}]);
    const authenticator = { authenticate(request) {
      if (Date.now() >= Date.parse(identity.expiresAt)) throw new DomainError('AUTH_UNAUTHENTICATED', 'Test identity expired');
      return delegate.authenticate(request);
    }};
    writeFileSync(join(directory, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', {flag:'wx',mode:0o600});
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({schemaVersion:'ltm.native-album-test.v1',fixtureKind:'synthetic-album-transport-only',
      single:{commandId:'single-root',count:1},batch:{commandId:'root',count:21},expiresAt:identity.expiresAt,
      nativeAcceptance:'NOT_RUN',modelQuality:'NOT_CERTIFIED',paidModelCalls:0}, null, 2) + '\n', {flag:'wx',mode:0o600});
    core = createApiServer({runtime:fixture.runtime, authenticator, capabilityRegistry:fixture.registry,
      timelineArtifacts:store, appEnvironment:'test',staticDirectory:null});
    const [dispatch] = core.listeners('request');
    core.removeListener('request', dispatch);
    server = core;
    server.on('request', (request,response) => {
      // This dedicated test listener is read-only and never exposes generation,
      // purchases, administration or the normal WeChat code-exchange endpoint.
      const path = request.url || '';
      if (request.headers.origin || request.headers.cookie) { response.writeHead(403); response.end(); return; }
      if (request.method !== 'GET' || !/^\/(?:native-album\/config|v1\/session|v1\/capabilities\/visible|v1\/timelines\/(?:root|single-root)(?:\/nodes\/(?:0|[1-9][0-9]?|100)\/image)?)$/.test(path)) {
        response.writeHead(404); response.end(); return;
      }
      if (path !== '/native-album/config') { dispatch(request, response); return; }
      try {
        const actor = authenticator.authenticate({authorization:request.headers.authorization,
          purpose:request.headers['x-purpose'],requestId:randomUUID()});
        response.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
        response.end(JSON.stringify({fixtureKind:'synthetic-album-transport-only',expiresAt:identity.expiresAt,
          commands:{single:'single-root',batch:'root'},actor:{actorId:actor.actorId,tenantId:actor.tenantId,roles:actor.roles,purpose:actor.purpose}}));
      } catch (error) {
        response.writeHead(error.code === 'AUTH_FORBIDDEN' ? 403 : 401, {'cache-control':'no-store'}); response.end();
      }
    });
    return {identity, directory,
      listen(port = 8189) {
        if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(Error('PORT_INVALID'));
        return new Promise((resolve,reject) => { const fail = error => reject(error); server.once('error',fail);
          server.listen(port, '127.0.0.1', () => {server.removeListener('error',fail);resolve(server.address());}); });
      },
      async close() {
        server.closeIdleConnections();
        if (server.listening) await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
        core.closeAllConnections(); fixture.runtime.close();
      },
    };
  } catch (error) { if (server?.listening) server.close(); core?.closeAllConnections(); fixture?.runtime.close(); throw error; }
}

async function main() {
  const {values} = parseArgs({options:{output:{type:'string'},'synthetic-test-images':{type:'boolean'},port:{type:'string',default:'8189'},'lifetime-seconds':{type:'string',default:'1800'}}});
  const service = await createNativeAlbumService({directory:values.output,syntheticTestImages:values['synthetic-test-images'],lifetimeSeconds:Number(values['lifetime-seconds'])});
  const address = await service.listen(Number(values.port));
  console.log(JSON.stringify({event:'native-album-test-listening',pid:process.pid,host:'127.0.0.1',port:address.port,
    expiresAt:service.identity.expiresAt,identityFile:join(service.directory,'identity.json'),nativeAcceptance:'NOT_RUN',modelQuality:'NOT_CERTIFIED'}));
  let closing = false;
  const close = async () => {if (closing) return; closing = true; await service.close();};
  process.once('SIGINT',close); process.once('SIGTERM',close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(error instanceof Error ? error.message : 'NATIVE_ALBUM_START_FAILED');process.exitCode=1;});
