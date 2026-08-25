import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { BrowserOidcClient, EphemeralBrowserAuthentication } from "./auth.js";
import { PORTALS, localized, normalizeLocale, portalById, translate } from "./surface.js";

test("browser bundle has the required web platform", () => {
  assert.equal(typeof URL, "function");
  assert.equal(typeof crypto.randomUUID, "function");
});

test("seven localized portal shells are keyed by the server manifest identifiers", () => {
  assert.equal(PORTALS.length, 7);
  assert.equal(new Set(PORTALS.map((portal) => portal.id)).size, 7);
  assert.equal(portalById("operations")?.id, "operations");
  assert.equal(portalById("developer")?.id, "developer");
});

test("browser authentication keeps bearer state ephemeral and overrides caller authorization", () => {
  const authentication = new EphemeralBrowserAuthentication();
  assert.deepEqual(authentication.snapshot(), {
    mode: "unauthenticated", purpose: "product_operation", hasInjectedBearer: false,
  });
  const serverHeaders = authentication.authenticatedHeaders({ authorization: "Bearer caller-controlled" });
  assert.equal(serverHeaders.has("authorization"), false);
  assert.equal(serverHeaders.get("x-purpose"), "product_operation");

  authentication.setBearerToken("oidc-token-without-whitespace", "age_transformation");
  assert.deepEqual(authentication.snapshot(), {
    mode: "injected_bearer", purpose: "age_transformation", hasInjectedBearer: true,
  });
  const oidcHeaders = authentication.authenticatedHeaders();
  assert.equal(oidcHeaders.get("authorization"), "Bearer oidc-token-without-whitespace");
  authentication.clear();
  assert.equal(authentication.authenticatedHeaders().has("authorization"), false);
  assert.throws(() => authentication.setBearerToken("secret with whitespace"), /bounded bearer/);
});

const browserOidcConfiguration = Object.freeze({
  schemaVersion: "ltm.browser-oidc-config.v1" as const,
  issuer: "https://identity.example.test/",
  authorizationEndpoint: "https://identity.example.test/oauth2/authorize",
  tokenEndpoint: "https://identity.example.test/oauth2/token",
  clientId: "ltm-production-spa",
  redirectUri: "https://ltm.example.test/auth/callback",
  scopes: ["openid", "profile", "email"],
  audience: "ltm-api",
});

function oidcHarness(responseFactory: () => Response = () => tokenResponse({
  access_token: "verified-access-token-0001", token_type: "Bearer", expires_in: 900, scope: "openid profile email",
})) {
  const values = new Map<string, string>();
  const replacements: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let now = 1_800_000_000_000;
  let randomCall = 0;
  const client = new BrowserOidcClient({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    async fetch(input, init) {
      requests.push({ url: String(input), init: init ?? {} });
      return responseFactory();
    },
    now: () => now,
    randomBytes(length) {
      randomCall += 1;
      return new Uint8Array(length).fill(randomCall);
    },
    async digestSha256(value) {
      return new Uint8Array(createHash("sha256").update(value).digest());
    },
    replaceUrl: (url) => { replacements.push(url); },
  });
  return { client, values, replacements, requests, advance: (milliseconds: number) => { now += milliseconds; } };
}

function tokenResponse(value: unknown, options: { contentType?: string; redirected?: boolean; status?: number } = {}): Response {
  const response = new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json; charset=utf-8" },
  });
  Object.defineProperty(response, "url", { value: browserOidcConfiguration.tokenEndpoint });
  Object.defineProperty(response, "redirected", { value: options.redirected ?? false });
  return response;
}

async function callbackFor(harness: ReturnType<typeof oidcHarness>, configuration = browserOidcConfiguration): Promise<string> {
  const authorization = new URL(await harness.client.beginAuthorization(configuration, "https://ltm.example.test/?lang=en"));
  return `${configuration.redirectUri}?code=authorization-code-0001&state=${authorization.searchParams.get("state")}`;
}

test("browser OIDC performs high-entropy Authorization Code + PKCE S256 and consumes callback once", async () => {
  const harness = oidcHarness();
  const authorization = new URL(await harness.client.beginAuthorization(browserOidcConfiguration, "https://ltm.example.test/"));
  assert.equal(authorization.origin, "https://identity.example.test");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("client_id"), browserOidcConfiguration.clientId);
  assert.equal(authorization.searchParams.get("redirect_uri"), browserOidcConfiguration.redirectUri);
  assert.equal(authorization.searchParams.get("audience"), browserOidcConfiguration.audience);
  assert.ok((authorization.searchParams.get("state")?.length ?? 0) >= 43);
  assert.ok((authorization.searchParams.get("code_challenge")?.length ?? 0) >= 43);
  const serialized = [...harness.values.values()][0] ?? "";
  assert.equal(serialized.includes("access_token"), false);
  assert.equal(serialized.includes("refresh_token"), false);

  const callback = `${browserOidcConfiguration.redirectUri}?code=authorization-code-0001&state=${authorization.searchParams.get("state")}`;
  assert.equal(await harness.client.completeAuthorization(browserOidcConfiguration, callback), "verified-access-token-0001");
  assert.deepEqual(harness.replacements, [browserOidcConfiguration.redirectUri]);
  assert.equal(harness.values.size, 0);
  assert.equal(harness.requests.length, 1);
  const exchange = harness.requests[0];
  assert.equal(exchange?.url, browserOidcConfiguration.tokenEndpoint);
  assert.equal(exchange?.init.credentials, "omit");
  assert.equal(exchange?.init.redirect, "error");
  assert.equal(exchange?.init.cache, "no-store");
  const form = new URLSearchParams(String(exchange?.init.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "authorization-code-0001");
  assert.ok((form.get("code_verifier")?.length ?? 0) >= 43);
  await assert.rejects(() => harness.client.completeAuthorization(browserOidcConfiguration, callback), /no live transaction/);
});

test("browser OIDC rejects state tampering, expiry, and configuration drift after cleaning callback URL", async () => {
  const tampered = oidcHarness();
  const tamperedCallback = await callbackFor(tampered);
  await assert.rejects(
    () => tampered.client.completeAuthorization(browserOidcConfiguration, tamperedCallback.replace(/state=[^&]+/, `state=${"x".repeat(43)}`)),
    /state mismatch/,
  );
  assert.deepEqual(tampered.replacements, [browserOidcConfiguration.redirectUri]);
  assert.equal(tampered.requests.length, 0);

  const expired = oidcHarness();
  const expiredCallback = await callbackFor(expired);
  expired.advance(5 * 60 * 1_000 + 1);
  await assert.rejects(() => expired.client.completeAuthorization(browserOidcConfiguration, expiredCallback), /expired or configuration changed/);

  const drifted = oidcHarness();
  const driftedCallback = await callbackFor(drifted);
  await assert.rejects(() => drifted.client.completeAuthorization(
    { ...browserOidcConfiguration, clientId: "ltm-production-spa-v2" }, driftedCallback,
  ), /expired or configuration changed/);
});

test("browser OIDC token exchange rejects refresh tokens, wrong token types, redirects, non-JSON, and oversized responses", async () => {
  const cases: Array<{ response: () => Response; expected: RegExp }> = [
    { response: () => tokenResponse({ access_token: "verified-access-token-0001", token_type: "Bearer", expires_in: 900, refresh_token: "forbidden-refresh-token" }), expected: /closed object|refresh token/ },
    { response: () => tokenResponse({ access_token: "verified-access-token-0001", token_type: "DPoP", expires_in: 900 }), expected: /token type/ },
    { response: () => tokenResponse({ access_token: "verified-access-token-0001", token_type: "Bearer", expires_in: 900 }, { redirected: true }), expected: /redirected/ },
    { response: () => tokenResponse({ access_token: "verified-access-token-0001", token_type: "Bearer", expires_in: 900 }, { contentType: "text/html" }), expected: /not JSON/ },
    { response: () => tokenResponse({ access_token: "x".repeat(70_000), token_type: "Bearer", expires_in: 900 }), expected: /too large/ },
  ];
  for (const item of cases) {
    const harness = oidcHarness(item.response);
    const callback = await callbackFor(harness);
    await assert.rejects(() => harness.client.completeAuthorization(browserOidcConfiguration, callback), item.expected);
    assert.equal(harness.values.size, 0);
  }
});

test("web asset build retains only the current immutable browser modules", () => {
  const assets = new URL("../public/assets/", import.meta.url);
  const names = readdirSync(assets).sort();
  const authenticationModules = names.filter((name) => /^auth-[a-f0-9]{12}\.js$/.test(name));
  const surfaceModules = names.filter((name) => /^surface-[a-f0-9]{12}\.js$/.test(name));
  assert.equal(authenticationModules.length, 1);
  assert.equal(surfaceModules.length, 1);
  const app = readFileSync(new URL("app.js", assets), "utf8");
  assert.match(app, new RegExp(`from "\\./${authenticationModules[0]}"`));
  assert.match(app, new RegExp(`from "\\./${surfaceModules[0]}"`));
});

test("production web owns the PKCE callback and exposes no manual bearer injection bridge", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(source, /\/v1\/auth\/browser\/config/);
  assert.match(source, /completeAuthorization/);
  assert.match(source, /\/v1\/session/);
  assert.doesNotMatch(source, /LifeTimeMachineAuth|installAuthenticationBridge/);
  assert.match(html, /id="login-button"/);
  assert.match(html, /id="logout-button"/);
});

test("browser journey never fabricates a production asset or terminal generation result", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /asset-synthetic-portrait|local-synthetic-v1/);
  assert.doesNotMatch(source, /\/v1\/capabilities\/(?:B04|B14)/);
  assert.match(source, /submitted:\s*false/);
  assert.match(source, /B07 safety approval/);
});

test("B04 web entry submits only the closed rights workflow and renders a minimized projection", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="rights-form"/);
  assert.match(html, /value="restrict_processing"/);
  assert.match(html, /value="appeal"/);
  assert.match(source, /command:\s*"rights-request\.submit"/);
  assert.match(source, /query:\s*"rights-request\.list"/);
  assert.match(source, /"X-Purpose":\s*"privacy_rights"/);
  assert.match(source, /subjectReference/);
  assert.doesNotMatch(source, /collection:\s*"privacy\.rights-requests"/);
  assert.doesNotMatch(source, /ownerActorId/);
});

test("locale negotiation and mandatory copy never return an empty legal surface", () => {
  assert.equal(normalizeLocale("zh-Hant"), "zh-TW");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale(undefined), "zh-CN");
  for (const portal of PORTALS) {
    for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
      assert.notEqual(localized(portal.title, locale), "");
      assert.notEqual(localized(portal.description, locale), "");
      assert.notEqual(translate(locale, "disclaimer"), "");
      assert.notEqual(translate(locale, "boundaryConsent"), "");
      assert.notEqual(translate(locale, "productionReleaseDescription"), "");
    }
  }
});
