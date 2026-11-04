import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAlbumService } from './native-album-api.mjs';

// Development-only synthetic transport fixture. Every accepted request still
// traverses the real SQLite-backed API. Environment identity is stateless and
// expires at an absolute deadline; cold starts never renew it.
export function createNativeAlbumServerless({ tokenSha256, expiresAt } = {}) {
  if (!/^[a-f0-9]{64}$/.test(tokenSha256 || '')) throw Error('SERVERLESS_TEST_HASH_REQUIRED');
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline) || deadline > Date.now() + 3600000) throw Error('SERVERLESS_TEST_DEADLINE_INVALID');
  const digest = Buffer.from(tokenSha256, 'hex');
  let boot;
  let parent;
  async function origin() {
    if (!boot) {
      boot = (async () => {
        parent = mkdtempSync(join(tmpdir(), 'ltm-album-edge-'));
        const service = await createNativeAlbumService({directory:join(parent, 'state'), syntheticTestImages:true,
          lifetimeSeconds:Math.max(1, Math.min(3600, Math.ceil((deadline - Date.now()) / 1000)))});
        const address = await service.listen(0);
        return {service, base:`http://127.0.0.1:${address.port}`};
      })();
    }
    return boot;
  }
  function result(status, body = null, headers = {}) {
    return new Response(body, {status, headers:{'cache-control':'no-store', 'x-content-type-options':'nosniff', ...headers}});
  }
  return {
    async handle(request) {
      const url = new URL(request.url);
      if (request.headers.has('origin') || request.headers.has('cookie')) return result(403);
      if (request.method !== 'GET' || url.search || !/^\/(?:native-album\/config|v1\/session|v1\/capabilities\/visible|v1\/timelines\/(?:root|single-root)(?:\/nodes\/(?:0|[1-9][0-9]?|100)\/image)?)$/.test(url.pathname)) return result(404);
      const authorization = request.headers.get('authorization') || '';
      if (Date.now() >= deadline || !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
          !timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), digest)) return result(401);
      if (request.headers.get('x-purpose') !== 'age_transformation') return result(403);
      try {
        const {service, base} = await origin();
        if (Date.now() >= deadline) return result(401);
        const response = await fetch(base + url.pathname, {headers:{authorization:`Bearer ${service.identity.accessToken}`, 'x-purpose':'age_transformation'},
          redirect:'error', signal:request.signal});
        let bytes = Buffer.from(await response.arrayBuffer());
        if (response.ok && url.pathname === '/native-album/config') {
          const config = JSON.parse(bytes.toString());
          config.expiresAt = new Date(deadline).toISOString();
          bytes = Buffer.from(JSON.stringify(config));
        }
        if (bytes.length > 4 * 1024 * 1024) return result(502);
        return result(response.status, bytes, {'content-type':response.headers.get('content-type') || 'application/octet-stream', 'content-length':String(bytes.length)});
      } catch {
        console.error('Native album test upstream unavailable');
        return result(503);
      }
    },
    async close() {
      if (boot) await (await boot).service.close();
      if (parent) rmSync(parent, {recursive:true, force:true});
    },
  };
}
