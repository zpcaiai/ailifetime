import assert from "node:assert/strict";
import test from "node:test";
import {
  MobileApplication,
  MobileApplicationError,
  MobileHttpApiClient,
  type MobileApplicationApiPort,
  type MobileIdentityPort,
  type MobileProductionConfiguration,
  type MobileTelemetryEvent,
} from "./application.js";

const configuration: MobileProductionConfiguration = {
  environment: "production",
  platform: "ios",
  applicationId: "com.example.ltm.mobile",
  applicationVersion: "2.0.0",
  apiBaseUrl: "https://api.product.com",
  allowedApiOrigins: ["https://api.product.com"],
  purpose: "product_operation",
  allowedDeepLinkHosts: ["app.product.com"],
};

const grant = { accessToken: "ephemeral-native-access-token", expiresAt: "2027-01-01T00:00:00Z" } as const;

const sessionResponse = {
  session: {
    actorId: "actor-1",
    tenantId: "tenant-1",
    roles: ["consumer"],
    purpose: "product_operation",
    stepUp: false,
    guardianVerified: false,
    authenticationState: "server_verified",
  },
  requestId: "req-session-1",
} as const;

const capability = {
  batchId: "B14",
  skill: "building-age-media-pipeline",
  operation: "createTimeline",
  permission: "record:create",
  portalId: "consumer",
  mode: "external-command",
  requirements: ["B14-R01", "B14-R02", "B14-R03", "B14-R04", "B14-R05"],
  requiresExternalEvidence: false,
} as const;

const visibleManifest = {
  schemaVersion: "ltm.visible-capability-manifest.v1",
  capabilities: [capability],
  portals: [{ id: "consumer", skills: ["building-age-media-pipeline"], capabilityCount: 1 }],
  count: 1,
  requestId: "req-visible-1",
} as const;

class Identity implements MobileIdentityPort {
  restoreGrant: typeof grant | null = grant;
  signOutCalls = 0;
  async restore() { return this.restoreGrant; }
  async signIn() { return grant; }
  async refresh() { return grant; }
  async signOut() { this.signOutCalls += 1; }
}

function harness(api: MobileApplicationApiPort, identity = new Identity()) {
  let purgeCalls = 0;
  const activations: Array<{ tenantId: string; actorId: string }> = [];
  const events: MobileTelemetryEvent[] = [];
  const application = new MobileApplication({
    configuration,
    identity,
    api,
    offline: {
      activate: async (binding) => { activations.push({ ...binding }); },
      purge: async () => { purgeCalls += 1; },
    },
    telemetry: { record: (event) => { events.push(event); } },
    now: () => new Date("2026-08-24T00:00:00Z"),
  });
  return { application, identity, events, activations, purgeCalls: () => purgeCalls };
}

function authorizedApi(overrides: Partial<MobileApplicationApiPort> = {}): MobileApplicationApiPort {
  return {
    getSession: async () => structuredClone(sessionResponse),
    getVisibleCapabilityManifest: async () => structuredClone(visibleManifest),
    executeCapability: async () => ({ id: "timeline-1" }),
    ...overrides,
  };
}

test("production configuration requires HTTPS, native ports, and normalized deep-link hosts", () => {
  const options = {
    identity: new Identity(),
    api: authorizedApi(),
    offline: { activate: async () => undefined, purge: async () => undefined },
    telemetry: { record: () => undefined },
  } as const;
  assert.throws(() => new MobileApplication({
    ...options,
    configuration: { ...configuration, apiBaseUrl: "http://api.product.com" },
  }), (error: unknown) => error instanceof MobileApplicationError && error.code === "INVALID_CONFIGURATION");
  assert.throws(() => new MobileApplication({
    ...options,
    configuration: { ...configuration, allowedDeepLinkHosts: ["APP.product.com"] },
  }), /normalized DNS/);
  assert.throws(() => new MobileApplication({
    ...options,
    identity: {} as never,
    configuration,
  }), /identity port/);
  assert.doesNotThrow(() => new MobileApplication({
    ...options,
    configuration: {
      ...configuration,
      environment: "development",
      apiBaseUrl: "http://127.0.0.1:8080",
      allowedApiOrigins: ["http://127.0.0.1:8080"],
    },
  }));
  for (const apiBaseUrl of [
    "https://api.product.com/",
    "https://api.product.test",
    "https://127.0.0.1",
    "https://localhost",
    "https://user:password@api.product.com",
    "https://api.product.com/path",
  ]) assert.throws(() => new MobileApplication({
    ...options,
    configuration: { ...configuration, apiBaseUrl, allowedApiOrigins: [apiBaseUrl] },
  }), (error: unknown) => error instanceof MobileApplicationError && error.code === "INVALID_CONFIGURATION");
  assert.throws(() => new MobileApplication({
    ...options,
    configuration: { ...configuration, apiBaseUrl: "https://api2.product.com" },
  }), /enrolled/);
});

test("missing native identity restores a signed-out shell without calling protected APIs", async () => {
  const identity = new Identity();
  identity.restoreGrant = null;
  let apiCalls = 0;
  const { application } = harness(authorizedApi({
    getSession: async () => { apiCalls += 1; return sessionResponse; },
  }), identity);
  assert.deepEqual(await application.start(), { state: "signed_out", route: { name: "sign_in" } });
  assert.equal(apiCalls, 0);
  assert.throws(() => application.openCapability("B14"), (error: unknown) => (
    error instanceof MobileApplicationError && error.code === "AUTHENTICATION_REQUIRED"
  ));
});

test("application authorizes from server projections, drives routes, and keeps bearer out of observable state", async () => {
  const contexts: Array<{ accessToken: string; purpose: string }> = [];
  const api = authorizedApi({
    getSession: async (context) => { contexts.push({ ...context }); return structuredClone(sessionResponse); },
    getVisibleCapabilityManifest: async (context) => { contexts.push({ ...context }); return structuredClone(visibleManifest); },
    executeCapability: async (context, batchId, input, idempotencyKey) => {
      contexts.push({ ...context });
      assert.equal(batchId, "B14");
      assert.deepEqual(input, { targetAges: [25, 50] });
      assert.equal(idempotencyKey, "idem-mobile-1");
      return { id: "timeline-1" };
    },
  });
  const { application, events, activations } = harness(api);
  const observed: string[] = [];
  application.subscribe((snapshot) => observed.push(JSON.stringify(snapshot)));
  const started = await application.start();
  assert.equal(started.state, "ready");
  assert.deepEqual(started.route, { name: "workspace", portalId: "consumer" });
  assert.equal(started.manifest?.capabilities[0]?.operation, "createTimeline");
  assert.deepEqual(application.openDeepLink("https://app.product.com/capabilities/B14").route, {
    name: "capability", portalId: "consumer", batchId: "B14",
  });
  assert.deepEqual(await application.executeCapability("B14", { targetAges: [25, 50] }, "idem-mobile-1"), { id: "timeline-1" });
  assert.throws(() => application.openCapability("B127"), /server-visible projection/);
  assert.throws(() => application.openDeepLink("https://app.product.com/capabilities/B14?role=platform_admin"), /cannot assert role/);
  assert.ok(observed.every((value) => !value.includes(grant.accessToken)), "snapshots must never expose bearer tokens");
  assert.ok(!JSON.stringify(events).includes(grant.accessToken), "telemetry must never contain bearer tokens");
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every((context) => context.accessToken === grant.accessToken && context.purpose === "product_operation"));
  assert.deepEqual(activations, [{ tenantId: "tenant-1", actorId: "actor-1" }]);
});

test("malformed visible projection fails closed and clears every authorized surface", async () => {
  const invalid = { ...visibleManifest, portals: [{ ...visibleManifest.portals[0], capabilityCount: 2 }] };
  const { application, events } = harness(authorizedApi({ getVisibleCapabilityManifest: async () => invalid }));
  await assert.rejects(application.start(), (error: unknown) => (
    error instanceof MobileApplicationError && error.code === "INVALID_SERVER_PROJECTION"
  ));
  assert.deepEqual(application.snapshot(), {
    state: "failed",
    route: { name: "sign_in" },
    error: { code: "INVALID_SERVER_PROJECTION", retryable: false },
  });
  assert.throws(() => application.openPortal("consumer"), /server-verified/);
  assert.equal(events.at(-1)?.name, "authentication_failed");
});

test("sign-out revokes the application view and purges offline work even when adapters are independent", async () => {
  const result = harness(authorizedApi());
  await result.application.start();
  assert.equal((await result.application.signOut()).state, "signed_out");
  assert.equal(result.identity.signOutCalls, 1);
  assert.equal(result.purgeCalls(), 1);
  assert.deepEqual(result.application.snapshot(), { state: "signed_out", route: { name: "sign_in" } });
});

test("built-in HTTP adapter sends ephemeral identity headers and validates dispatch binding", async () => {
  const requests: Array<{ path: string; headers: Headers; body?: unknown }> = [];
  const client = new MobileHttpApiClient({
    baseUrl: "https://api.product.com",
    allowedOrigins: ["https://api.product.com"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({ path, headers: new Headers(init?.headers), ...(body === undefined ? {} : { body }) });
      if (path === "/v1/session") return Response.json(sessionResponse);
      if (path === "/v1/capabilities/visible") return Response.json(visibleManifest);
      return Response.json({ data: { id: "timeline-1" }, meta: { requestId: "req-execute-1", batchId: "B14" } });
    },
  });
  const context = { accessToken: grant.accessToken, purpose: "product_operation" } as const;
  await client.getSession(context);
  await client.getVisibleCapabilityManifest(context);
  assert.deepEqual(await client.executeCapability(context, "B14", { targetAges: [25] }, "idem-http-1"), { id: "timeline-1" });
  assert.deepEqual(requests.map((request) => request.path), ["/v1/session", "/v1/capabilities/visible", "/v1/capabilities/B14"]);
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), `Bearer ${grant.accessToken}`);
    assert.equal(request.headers.get("x-purpose"), "product_operation");
  }
  assert.equal(requests[2]?.headers.get("idempotency-key"), "idem-http-1");
  assert.deepEqual(requests[2]?.body, { targetAges: [25] });
});
