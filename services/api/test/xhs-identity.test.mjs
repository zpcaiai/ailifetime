import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';
const { WechatIdentityAuthority } = await import(
  process.env.LTM_IDENTITY_TEST_SOURCE === '1' ? '../src/wechat-identity.ts' : '../dist/wechat-identity.js'
);

const digest = value => createHash('sha256').update(value).digest('hex');

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('XHS and WeChat share PostgreSQL identity authority with isolated app subjects and one-use codes', async t => {
  const database = process.env.LTM_IDENTITY_TEST_POSTGRES_URL;
  const adminUrl = process.env.LTM_IDENTITY_TEST_POSTGRES_ADMIN_URL;
  assert.equal(new URL(database).hostname, '127.0.0.1');
  assert.equal(new URL(adminUrl).pathname, '/ltm_identity_test');
  const sql = new Pool({ connectionString: adminUrl });
  t.after(() => sql.end());
  if (!(await sql.query("SELECT to_regclass('wechat_identity.users') AS relation")).rows[0].relation) {
    await sql.query(await readFile(new URL('../../../infra/wechat-identity/001_identity.sql', import.meta.url), 'utf8'));
    await sql.query('GRANT USAGE ON SCHEMA wechat_identity TO ltm_identity_test_runtime');
    await sql.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA wechat_identity TO ltm_identity_test_runtime');
  }
  const workload = randomBytes(24).toString('hex');
  const xhsAppId = randomBytes(12).toString('hex');
  const wechatAppId = 'wx' + randomBytes(8).toString('hex');
  const xhsToken = randomBytes(24).toString('hex');
  const sessionKey = Buffer.alloc(16, 9).toString('base64');
  const sameOpenId = 'shared-provider-identity';
  const issuer = 'https://identity.example.test';
  const audience = 'ailifetime-api';
  const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey);
  const env = {
    APP_ENV: 'test', DATABASE_URL: database, LTM_XHS_APP_ID: xhsAppId,
    LTM_XHS_RMP_ACCESS_TOKEN: xhsToken, LTM_XHS_IDENTITY_CONSENT_VERSION: 'xhs-privacy-v1',
    LTM_WECHAT_APP_ID: wechatAppId, LTM_WECHAT_APP_SECRET: 'synthetic-wechat-app-secret',
    LTM_IDENTITY_WORKLOAD_TOKEN_SHA256: digest(workload), LTM_IDENTITY_ISSUER: issuer,
    LTM_IDENTITY_AUDIENCE: audience, LTM_IDENTITY_CONSENT_VERSION: 'wechat-privacy-v1',
    LTM_IDENTITY_SIGNING_JWK: JSON.stringify(key), LTM_IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  };
  const observed = [];
  const upstream = await listen(t, createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const xhs = url.pathname === '/api/rmp/session';
    const code = url.searchParams.get(xhs ? 'code' : 'js_code');
    const appId = url.searchParams.get('appid');
    const row = await sql.query('SELECT state FROM wechat_identity.requests WHERE app_id=$1 AND code_hash=$2',
      [appId, digest(code ?? '')]);
    observed.push({ method: request.method, path: url.pathname, appId, claimed: row.rows[0]?.state,
      credentialMatches: url.searchParams.get(xhs ? 'access_token' : 'secret') === (xhs ? xhsToken : env.LTM_WECHAT_APP_SECRET) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(xhs
      ? code === 'rejected-code' ? { success: false, code: 1, msg: 'provider details' }
        : { success: true, code: 0, data: { open_id: sameOpenId, session_key: sessionKey } }
      : { openid: sameOpenId, session_key: sessionKey }));
  }));
  const xhs = new WechatIdentityAuthority(env, upstream, 'xhs');
  const wechat = new WechatIdentityAuthority(env, upstream);
  t.after(async () => { await xhs.close(); await wechat.close(); });
  const base = await listen(t, createServer((req, res) => void (req.url === '/v1/mini-program/sessions' ? xhs : wechat).handle(req, res)));
  const xhsRoute = '/v1/mini-program/sessions';
  const send = async (path, body, requestKey, authorization) => {
    const result = await fetch(base + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': requestKey, ...(authorization ? { authorization } : {}),
    }, body: JSON.stringify(body) });
    return { status: result.status, headers: result.headers, body: await result.json() };
  };

  const input = { platform: 'mp-xhs', js_code: 'short-lived-native-code' };
  assert.equal((await send(xhsRoute, { ...input, actorId: 'override' }, 'invalid')).status, 400);
  assert.equal(observed.length, 0);
  const accepted = await send(xhsRoute, input, 'xhs-code-exchange-1');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'private, no-store');
  assert.equal(accepted.body.platform, 'mp-xhs');
  assert.equal(JSON.stringify(accepted.body).includes(sameOpenId), false);
  assert.equal(JSON.stringify(accepted.body).includes(sessionKey), false);
  const jwks = createLocalJWKSet(await wechat.jwks());
  const jwt = await jwtVerify(accepted.body.access_token, jwks, { issuer, audience, algorithms: ['ES256'] });
  assert.equal(jwt.payload.sub, accepted.body.actor_pseudonym);
  assert.deepEqual(jwt.payload.roles, ['consumer']);
  assert.deepEqual((await send(xhsRoute, input, 'xhs-code-exchange-1')).body, accepted.body);
  assert.equal((await send(xhsRoute, input, 'xhs-code-exchange-2')).status, 409);

  const previous = await send('/v1/wechat/sessions', {
    code: input.js_code, consentVersion: 'wechat-privacy-v1', clientRequestId: 'wechat-request',
  }, 'wechat-code-exchange-1', 'Bearer ' + workload);
  assert.equal(previous.status, 200);
  assert.notEqual(previous.body.session.actorId, accepted.body.actor_pseudonym);
  const rejected = await send(xhsRoute, { ...input, js_code: 'rejected-code' }, 'xhs-rejected');
  assert.deepEqual(rejected.body, { error: { code: 'XHS_LOGIN_REJECTED' } });
  assert.equal((await send(xhsRoute, { ...input, js_code: 'rejected-code' }, 'xhs-rejected')).status, 409);
  assert.deepEqual(observed.map(({ path, appId, claimed, method, credentialMatches }) =>
    [path, appId, claimed, method, credentialMatches]), [
    ['/api/rmp/session', xhsAppId, 'executing', 'GET', true],
    ['/sns/jscode2session', wechatAppId, 'executing', 'GET', true],
    ['/api/rmp/session', xhsAppId, 'executing', 'GET', true],
  ]);
  const stored = await sql.query('SELECT provider_cipher FROM wechat_identity.sessions WHERE app_id=$1', [xhsAppId]);
  assert.deepEqual(stored.rows, [{ provider_cipher: null }]);
});
