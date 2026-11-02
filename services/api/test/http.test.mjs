import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createCapabilityRegistry, externalBusinessEventReducerRegistry } from "@ltm/capabilities";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DomainError,
  LifeTimeMachineRuntime,
  participantEvidenceScope,
  signExternalEvidence,
} from "@ltm/core";
import { HttpResumableUploadBroker, StaticTokenAuthenticator, createApiServer } from "../dist/index.js";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ltm-api-test-"));
  const runtime = new LifeTimeMachineRuntime({
    allowLegacyConsentPolicy: true,
    ...(options.runtimeOptions ?? {}),
    databasePath: join(directory, "api.sqlite"),
  });
  const staticDirectory = join(directory, "public");
  mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>LTM</title><main>ui-shell</main>");
  writeFileSync(join(staticDirectory, "app.js"), "globalThis.LTM_APP = true;");
  writeFileSync(join(staticDirectory, "app-abcdef123456.js"), "globalThis.LTM_HASHED_APP = true;");
  writeFileSync(join(staticDirectory, "application-mainbundle.js"), "globalThis.LTM_NAMED_APP = true;");
  const authenticator = options.authenticator ?? new StaticTokenAuthenticator([
    {
      token: "test-platform-token-0001",
      actorId: "admin-1",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      allowedPurposes: ["product_operation", "accounting"],
      stepUp: true,
    },
    {
      token: "test-consumer-token-0001",
      actorId: "consumer-1",
      tenantId: "tenant-a",
      roles: ["consumer"],
      allowedPurposes: ["product_operation", "age_transformation", "sharing"],
    },
    {
      token: "test-consumer-token-0002",
      actorId: "consumer-2",
      tenantId: "tenant-a",
      roles: ["consumer"],
      allowedPurposes: ["product_operation", "age_transformation", "sharing"],
    },
  ]);
  const server = createApiServer({
    runtime: options.runtimeAdapter === undefined ? runtime : options.runtimeAdapter(runtime),
    authenticator,
    capabilityRegistry: createCapabilityRegistry(),
    staticDirectory,
    bodyLimitBytes: options.bodyLimitBytes ?? 256 * 1024,
    ...(options.allowSandboxStepUpHeader === undefined
      ? {}
      : { allowSandboxStepUpHeader: options.allowSandboxStepUpHeader }),
    ...(options.appEnvironment === undefined ? {} : { appEnvironment: options.appEnvironment }),
    ...(options.metricsTokenSha256 === undefined ? {} : { metricsTokenSha256: options.metricsTokenSha256 }),
    ...(options.clientIntegrations === undefined ? {} : { clientIntegrations: options.clientIntegrations }),
    ...(options.browserOidcConfiguration === undefined ? {} : { browserOidcConfiguration: options.browserOidcConfiguration }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  cleanups.push(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, runtime };
}

function authHeaders(overrides = {}) {
  return {
    authorization: "Bearer test-platform-token-0001",
    "content-type": "application/json",
    "x-purpose": "product_operation",
    ...overrides,
  };
}

function consumerAuthHeaders(overrides = {}) {
  return authHeaders({ authorization: "Bearer test-consumer-token-0001", ...overrides });
}

function otherConsumerAuthHeaders(overrides = {}) {
  return authHeaders({ authorization: "Bearer test-consumer-token-0002", ...overrides });
}

async function json(response) {
  return response.json();
}

test("evidence sink preflight proves both permissions on the same authenticated service principal", async () => {
  const authenticator = new StaticTokenAuthenticator([{
    token: "evidence-sink-ready-token-0001",
    actorId: "integration-gateway-ready",
    tenantId: "tenant-a",
    roles: ["service_account"],
    permissions: ["evidence:register", "external-event:apply"],
    allowedPurposes: ["external_business_event_projection"],
  }, {
    token: "evidence-sink-partial-token-0001",
    actorId: "integration-gateway-partial",
    tenantId: "tenant-a",
    roles: ["service_account"],
    permissions: ["evidence:register"],
    allowedPurposes: ["external_business_event_projection"],
  }, {
    token: "evidence-sink-admin-token-0001",
    actorId: "interactive-admin",
    tenantId: "tenant-a",
    roles: ["platform_admin"],
    allowedPurposes: ["external_business_event_projection"],
  }]);
  const { baseUrl } = await fixture({ authenticator });
  const request = (token) => fetch(`${baseUrl}/v1/integrations/evidence-sink/preflight`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-purpose": "external_business_event_projection",
    },
    body: "{}",
  });
  const ready = await request("evidence-sink-ready-token-0001");
  assert.equal(ready.status, 200);
  const receipt = await json(ready);
  assert.equal(receipt.schemaVersion, "ltm.evidence-sink-preflight.v1");
  assert.deepEqual(receipt.permissions, ["evidence:register", "external-event:apply"]);
  assert.deepEqual(receipt.principal, { actorId: "integration-gateway-ready", tenantId: "tenant-a" });
  assert.equal((await request("evidence-sink-partial-token-0001")).status, 403);
  assert.equal((await request("evidence-sink-admin-token-0001")).status, 403);
});

function secureMediaProjection(assetId = "media-1", participantIds = ["consumer-1"]) {
  const sourceSha256 = "b".repeat(64);
  const canonicalSha256 = "c".repeat(64);
  return {
    assetId,
    sourceSha256,
    canonicalSha256,
    lineageSha256: createHash("sha256")
      .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
      .digest("hex"),
    byteLength: 12_345,
    width: 640,
    height: 480,
    faceCount: participantIds.length,
    scanEvidenceId: "scan-evidence-1",
    scannerProvider: "trusted-media-scanner",
    scanAssessedAt: new Date(Date.now() - 60_000).toISOString(),
    participantIds: [...participantIds],
    participantMappingEvidenceId: "participant-map-evidence-1",
    participantMappingProvider: "trusted-participant-mapper",
    participantMappingAssessedAt: new Date(Date.now() - 30_000).toISOString(),
    participantMapComplete: true,
    mimeType: "image/jpeg",
    metadataStripped: true,
  };
}

function secureDeletionProjection(assetId, tenantId = "tenant-a", serial = 1) {
  const completedAt = new Date(Date.now() - 1_000).toISOString();
  const deletionRequestId = `delete-b05-wire-${serial}`;
  const policySha256 = "d".repeat(64);
  const targetIds = ["s3-primary", "s3-derived"];
  const targetReceipts = targetIds.map((targetId, index) => ({
    schemaVersion: "ltm.media-deletion-target-receipt.v1",
    targetId,
    targetKind: index === 0 ? "s3-object" : "s3-prefix",
    deletionRequestId,
    tenantId,
    mediaReference: assetId,
    canonicalSha256: "c".repeat(64),
    policySha256,
    state: "deleted",
    completedAt,
    evidenceSha256: String(index + 1).repeat(64),
    deletedVersions: index === 0 ? 1 : 0,
    deletedMarkers: 0,
    verifiedAbsent: true,
  }));
  return {
    mediaReference: assetId,
    state: "deleted",
    auditId: `audit-b05-wire-${serial}`,
    deletionRequestId,
    requestedAt: completedAt,
    deletedAt: completedAt,
    policyId: "raw-media-production-v1",
    policySha256,
    classification: "raw",
    retentionDays: 365,
    retentionExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    encrypted: true,
    deletionTargets: targetIds,
    targetReceipts,
  };
}

test("B04 HTTP dispatch exposes only minimized rights commands and queries", async () => {
  const calls = [];
  const projection = {
    requestId: "rights-http-1",
    requestType: "access",
    subjectReference: "subject_0123456789abcdef",
    requestedProcessingPurpose: "all",
    status: "propagation_pending",
    policyVersion: "ltm.product-rights-sla.v1",
    submittedAt: "2026-08-24T08:00:00.000Z",
    dueAt: "2026-09-23T08:00:00.000Z",
    overdue: false,
    completedAt: null,
    parentRequestId: null,
    progress: { total: 8, succeeded: 0, pending: 8, blocked: 0, failed: 0 },
    tasks: [],
    review: { approvals: 0, denials: 0, requiredDistinctReviewers: 2 },
    explanationCode: "PROPAGATION_PENDING",
  };
  const authenticator = new StaticTokenAuthenticator([{
    token: "test-rights-token-0001",
    actorId: "rights-owner-1",
    tenantId: "tenant-a",
    roles: ["consumer"],
    allowedPurposes: ["privacy_rights"],
  }]);
  const { baseUrl } = await fixture({
    authenticator,
    runtimeAdapter: (target) => new Proxy(target, {
      get(object, property) {
        if (property === "submitRightsRequest") {
          return (context, input) => {
            calls.push({ operation: property, context, input });
            return { value: projection, replayed: false };
          };
        }
        if (property === "getRightsRequest") {
          return (context, requestId) => {
            calls.push({ operation: property, context, requestId });
            return projection;
          };
        }
        if (property === "listRightsRequests") return async () => [projection];
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    }),
  });
  const headers = {
    authorization: "Bearer test-rights-token-0001",
    "content-type": "application/json",
    "x-purpose": "privacy_rights",
  };
  const created = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "rights-http-submit-1" },
    body: JSON.stringify({
      command: "rights-request.submit",
      input: {
        requestId: "rights-http-1",
        participantId: "participant-http-1",
        requestType: "access",
        requestedProcessingPurpose: "all",
      },
    }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual((await json(created)).data, { value: projection, replayed: false });
  assert.equal(typeof calls[0].context.operationId, "string");
  assert.deepEqual(Object.keys(calls[0].input).sort(), [
    "idempotencyKey", "participantId", "requestId", "requestType", "requestedProcessingPurpose",
  ]);

  const injected = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "rights-http-injected-1" },
    body: JSON.stringify({
      command: "rights-request.submit",
      input: {
        participantId: "participant-http-1",
        requestType: "delete",
        requestedProcessingPurpose: "all",
        ownerActorId: "attacker",
      },
    }),
  });
  assert.equal(injected.status, 422);
  assert.equal((await json(injected)).error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 1);

  const viewed = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "rights-request.get", input: { requestId: "rights-http-1" } }),
  });
  assert.equal(viewed.status, 200);
  assert.deepEqual((await json(viewed)).data, projection);
  assert.equal(calls[1].requestId, "rights-http-1");

  const raw = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "record.get",
      input: { collection: "privacy.rights-requests", id: "rights-http-1" },
    }),
  });
  assert.equal(raw.status, 403);
  assert.equal((await json(raw)).error.code, "AUTH_FORBIDDEN");
});

test("health, capability catalog, security headers, and static SPA are runnable", async () => {
  const { baseUrl } = await fixture();
  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await json(live)).status, "ok");

  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await json(ready)).ready, true);

  const catalog = await fetch(`${baseUrl}/v1/catalog`);
  assert.equal(catalog.status, 200);
  const catalogBody = await json(catalog);
  assert.equal(catalogBody.capabilities.length, 128);
  assert.ok(catalogBody.commands.includes("record.create"));

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /ui-shell/);
  const fallback = await fetch(`${baseUrl}/consumer/project/1`, { headers: { accept: "text/html" } });
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /ui-shell/);
  const oidcCallbackFallback = await fetch(`${baseUrl}/auth/callback?code=opaque&state=opaque`, { headers: { accept: "text/html" } });
  assert.equal(oidcCallbackFallback.status, 200);
  assert.match(await oidcCallbackFallback.text(), /ui-shell/);
  const unhashedAsset = await fetch(`${baseUrl}/app.js`);
  assert.equal(unhashedAsset.headers.get("cache-control"), "no-cache");
  const hashedAsset = await fetch(`${baseUrl}/app-abcdef123456.js`);
  assert.equal(hashedAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const namedAsset = await fetch(`${baseUrl}/application-mainbundle.js`);
  assert.equal(namedAsset.headers.get("cache-control"), "no-cache");
});

test("authenticated session and visible capability projection fail closed and apply role plus permission filters", async () => {
  const { baseUrl } = await fixture();

  const anonymousSession = await fetch(`${baseUrl}/v1/session`, {
    headers: { "x-purpose": "product_operation" },
  });
  assert.equal(anonymousSession.status, 401);
  assert.equal((await json(anonymousSession)).error.code, "AUTH_UNAUTHENTICATED");

  const session = await fetch(`${baseUrl}/v1/session`, { headers: consumerAuthHeaders() });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
  const sessionBody = await json(session);
  assert.deepEqual(sessionBody.session.roles, ["consumer"]);
  assert.equal(sessionBody.session.actorId, "consumer-1");
  assert.equal(sessionBody.session.tenantId, "tenant-a");
  assert.equal(sessionBody.session.authenticationState, "server_verified");
  assert.equal(JSON.stringify(sessionBody).includes("test-consumer-token"), false);

  const visible = await fetch(`${baseUrl}/v1/capabilities/visible`, { headers: consumerAuthHeaders() });
  assert.equal(visible.status, 200);
  const visibleBody = await json(visible);
  assert.equal(visibleBody.schemaVersion, "ltm.visible-capability-manifest.v1");
  assert.ok(visibleBody.count > 0 && visibleBody.count < 128);
  assert.deepEqual(visibleBody.portals.map((portal) => portal.id), ["consumer", "family", "support"]);
  assert.equal(visibleBody.capabilities.every((capability) => ["consumer", "family", "support"].includes(capability.portalId)), true);
  assert.deepEqual(visibleBody.capabilities.filter((capability) => capability.portalId === "support").map((capability) => capability.batchId), ["B80"]);
  assert.equal(visibleBody.capabilities.every((capability) => ["record:create", "support.ticket.create"].includes(capability.permission)), true);

  const consumerTicketInput = {
    ticketId: "consumer-support-ticket-1",
    channel: "in_app",
    severity: "P2",
    queue: "consumer-support",
    dueAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    privacySensitive: false,
    dedupeKey: "consumer-support-ticket-1",
    assignedRole: "support_agent",
  };
  const consumerTicket = await fetch(`${baseUrl}/v1/capabilities/B80`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "consumer-support-ticket-1" }),
    body: JSON.stringify({ input: consumerTicketInput }),
  });
  assert.equal(consumerTicket.status, 200);
  assert.equal((await json(consumerTicket)).data.batchId, "B80");

  const consumerPriorityEscalation = await fetch(`${baseUrl}/v1/capabilities/B80`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "consumer-support-ticket-priority-override-1" }),
    body: JSON.stringify({ input: { ...consumerTicketInput, ticketId: "consumer-support-ticket-2", severity: "P0" } }),
  });
  assert.equal(consumerPriorityEscalation.status, 403);
  assert.equal((await json(consumerPriorityEscalation)).error.code, "AUTH_FORBIDDEN");

  const hiddenPartnerCapability = await fetch(`${baseUrl}/v1/capabilities/B33`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "hidden-partner-capability" }),
    body: JSON.stringify({ input: {} }),
  });
  assert.equal(hiddenPartnerCapability.status, 403);
  assert.equal((await json(hiddenPartnerCapability)).error.code, "AUTH_FORBIDDEN");

  const platformVisible = await fetch(`${baseUrl}/v1/capabilities/visible`, { headers: authHeaders() });
  assert.equal(platformVisible.status, 200);
  const platformBody = await json(platformVisible);
  assert.equal(platformBody.schemaVersion, "ltm.visible-capability-manifest.v1");
  assert.equal(platformBody.count, 128);
  assert.equal(platformBody.portals.length, 7);
  assert.equal(new Set(platformBody.capabilities.map((capability) => capability.skill)).size, 22);
});

test("native telemetry is minimized, pseudonymized, durable, idempotent, and rejects unsafe fields", async () => {
  const { baseUrl } = await fixture();
  const event = {
    eventId: "mobile-event-12345678",
    name: "mobile.startup",
    occurredAt: new Date().toISOString(),
    fields: { platform: "ios", appVersion: "2.0.0", status: "ready", durationMs: 120 },
  };
  const send = (body, key = "mobile-telemetry-12345678") => fetch(`${baseUrl}/v1/mobile/telemetry`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": key }),
    body: JSON.stringify(body),
  });
  const first = await send(event);
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.data.batchId, "B41");
  assert.equal(firstBody.data.state, "received");
  assert.equal(firstBody.data.replayed, false);
  const replay = await send(event);
  assert.equal(replay.status, 200);
  const replayBody = await json(replay);
  assert.equal(replayBody.data.eventId, firstBody.data.eventId);
  assert.equal(replayBody.data.replayed, true);

  const unsafe = await send({ ...event, eventId: "mobile-event-unsafe-1234", fields: { token: "Bearer secret-value" } }, "mobile-telemetry-unsafe-1234");
  assert.equal(unsafe.status, 422);
  assert.equal((await json(unsafe)).error.code, "VALIDATION_FAILED");
});

test("public browser OIDC configuration is closed, read-only, no-store, and CSP-bound to the trusted token origin", async () => {
  const browserOidcConfiguration = {
    schemaVersion: "ltm.browser-oidc-config.v1",
    issuer: "https://identity.example.test/",
    authorizationEndpoint: "https://identity.example.test/oauth2/authorize",
    tokenEndpoint: "https://identity.example.test/oauth2/token",
    clientId: "ltm-production-spa",
    redirectUri: "https://ltm.example.test/auth/callback",
    scopes: ["openid", "profile", "email"],
    audience: "ltm-api",
  };
  const { baseUrl } = await fixture({ browserOidcConfiguration });
  const response = await fetch(`${baseUrl}/v1/auth/browser/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self' https:\/\/identity\.example\.test/);
  const body = await json(response);
  assert.deepEqual(body, browserOidcConfiguration);
  assert.deepEqual(Object.keys(body).sort(), [
    "audience", "authorizationEndpoint", "clientId", "issuer", "redirectUri", "schemaVersion", "scopes", "tokenEndpoint",
  ]);
  assert.equal(JSON.stringify(body).includes("secret"), false);

  const absent = await fixture();
  const absentResponse = await fetch(`${absent.baseUrl}/v1/auth/browser/config`);
  assert.equal(absentResponse.status, 503);
  assert.equal((await json(absentResponse)).error.code, "DEPENDENCY_UNAVAILABLE");
});

test("consent policy authority endpoint returns only authenticated server metadata", async () => {
  const metadata = {
    schemaVersion: "ltm.consent-policy-catalog-metadata.v1",
    catalogId: "production-consent-catalog-v1",
    issuer: "production-consent-authority",
    environment: "production",
    catalogSha256: "a".repeat(64),
    issuedAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    jurisdiction: "CN",
    locale: "zh-CN",
    policyVersions: ["consent-production-v1"],
  };
  const { baseUrl } = await fixture({
    runtimeAdapter: (target) => new Proxy(target, {
      get(object, property) {
        if (property === "getConsentPolicyCatalogMetadata") return (context) => {
          object.authorize(context, "consent-policy:publish", { tenantId: context.tenantId });
          return metadata;
        };
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    }),
  });
  const anonymous = await fetch(`${baseUrl}/v1/consent-policy/authority`, { headers: { "x-purpose": "product_operation" } });
  assert.equal(anonymous.status, 401);
  const forbidden = await fetch(`${baseUrl}/v1/consent-policy/authority`, { headers: consumerAuthHeaders() });
  assert.equal(forbidden.status, 403);
  const response = await fetch(`${baseUrl}/v1/consent-policy/authority`, { headers: authHeaders() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await json(response);
  assert.deepEqual(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId")), metadata);
  assert.equal("signature" in body, false);
  assert.equal("policies" in body, false);
});

test("share grant API persists provider revocation and never treats record deletion as revoke", async () => {
  const now = new Date("2026-08-24T03:00:00.000Z");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "share-http-gateway",
    provider: "export-publisher",
    keyId: "share-http-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B10:*"],
    allowedEnvironments: ["sandbox"],
  };
  const { baseUrl, runtime } = await fixture({
    runtimeOptions: {
      clock: { now: () => now },
      trustedEvidenceKeys: [trustedKey],
      evidencePolicy: "development",
      evidenceEnvironment: "sandbox",
    },
  });
  const service = {
    actorId: "share-callback-service",
    tenantId: "tenant-a",
    roles: ["platform_admin", "service_account"],
    purpose: "sharing",
    requestId: "share-http-callback",
    stepUp: true,
  };
  const exportCommandId = "B10:share-http-export-1";
  runtime.createExternalCommand(service, {
    record: {
      id: exportCommandId,
      collection: "sharing.export-commands",
      ownerActorId: "consumer-1",
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId: "share-http-work-1",
        participantIds: [],
        format: "single_image",
        visibility: "link",
        expiresAt: "2026-08-25T04:00:00.000Z",
        aiLabel: true,
        provenanceId: "share-http-provenance-1",
        revocable: true,
        containsMinor: false,
        purpose: "sharing",
      },
    },
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    details: { requestedBy: "consumer-1" },
    idempotencyKey: "share-http-create-export",
  });
  runtime.transitionExternalCommand(service, {
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    aggregateCollection: "sharing.export-commands",
    aggregateId: exportCommandId,
    toState: "dispatched",
    idempotencyKey: "share-http-dispatch-export",
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const applyCallback = (input) => {
    const claims = {
      providerOperationId: input.providerOperationId,
      ...(input.targetProviderOperationId === undefined
        ? {}
        : { targetProviderOperationId: input.targetProviderOperationId }),
    };
    const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
    const unsigned = {
      version: "ltm.external-business-event.v1",
      eventId: input.eventId,
      tenantId: "tenant-a",
      batchId: "B10",
      operation: input.operation,
      provider: "export-publisher",
      subjectType: input.operation === "publishExport" ? "export" : "export-revocation",
      subjectId: input.commandId,
      eventType: "external-command.succeeded",
      providerOccurredAt: new Date(now.getTime() - 1_000 + input.sequence).toISOString(),
      sequence: input.sequence,
      correlationId: input.commandId,
      artifactSha256: input.sequence === 1 ? "a".repeat(64) : "b".repeat(64),
      evidenceId: input.evidenceId,
      evidenceScope: `B10:${input.operation}:${input.commandId}`,
      canonicalClaims: claims,
      canonicalClaimsSha256,
    };
    const event = { ...unsigned, businessEventSha256: canonicalBusinessEventSha256(unsigned) };
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: event.evidenceId,
      tenantId: event.tenantId,
      issuer: trustedKey.issuer,
      provider: trustedKey.provider,
      environment: "sandbox",
      scope: event.evidenceScope,
      artifactSha256: event.artifactSha256,
      canonicalClaimsSha256,
      businessEventSha256: event.businessEventSha256,
      issuedAt: new Date(now.getTime() - 5_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      nonce: `nonce-${input.evidenceId}-0123456789`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedKey.keyId,
    }, privateKeyPem);
    const reducer = externalBusinessEventReducerRegistry.resolve(event);
    assert.ok(reducer);
    return runtime.applyExternalBusinessEvent(service, {
      event,
      evidence,
      reducer,
      idempotencyKey: `share-http-apply-${input.eventId}`,
    });
  };
  applyCallback({
    operation: "publishExport",
    commandId: exportCommandId,
    providerOperationId: "provider-share-http-1",
    eventId: "share-http-published-1",
    evidenceId: "share-http-published-evidence-1",
    sequence: 1,
  });

  const activeResponse = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.get", input: { exportCommandId } }),
  });
  assert.equal(activeResponse.status, 200);
  assert.equal((await json(activeResponse)).data.state, "active");
  const ownerList = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.list", input: { limit: 50 } }),
  });
  assert.equal(ownerList.status, 200);
  assert.equal((await json(ownerList)).data[0].providerOperationId, "provider-share-http-1");
  const crossActorGet = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: otherConsumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.get", input: { exportCommandId } }),
  });
  assert.equal(crossActorGet.status, 403);
  assert.equal((await json(crossActorGet)).error.code, "AUTH_FORBIDDEN");
  const crossActorList = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: otherConsumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.list", input: { limit: 50 } }),
  });
  assert.equal(crossActorList.status, 200);
  assert.deepEqual((await json(crossActorList)).data, []);
  const crossActorRevoke = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: otherConsumerAuthHeaders({ "x-purpose": "sharing", "idempotency-key": "share-http-cross-actor-revoke" }),
    body: JSON.stringify({ command: "share-grant.revoke", input: { exportCommandId, reason: "not_my_grant" } }),
  });
  assert.equal(crossActorRevoke.status, 403);
  assert.equal((await json(crossActorRevoke)).error.code, "AUTH_FORBIDDEN");
  const localDelete = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "share-http-local-delete" }),
    body: JSON.stringify({
      command: "record.delete",
      input: { collection: "sharing.export-commands", id: exportCommandId, expectedVersion: 4 },
    }),
  });
  assert.equal(localDelete.status, 403);
  assert.equal((await json(localDelete)).error.code, "AUTH_FORBIDDEN");

  const revokeResponse = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "sharing", "idempotency-key": "share-http-revoke-request" }),
    body: JSON.stringify({ command: "share-grant.revoke", input: { exportCommandId, reason: "user_requested" } }),
  });
  assert.equal(revokeResponse.status, 200);
  const revokeBody = await json(revokeResponse);
  assert.equal(revokeBody.data.value.grant.state, "revocation_requested");
  assert.equal(revokeBody.data.value.record.data.targetProviderOperationId, "provider-share-http-1");
  const revokeCommandId = revokeBody.data.value.command.commandId;
  runtime.transitionExternalCommand(service, {
    commandId: revokeCommandId,
    batchId: "B10",
    operation: "revokeExport",
    aggregateCollection: "sharing.export-revoke-commands",
    aggregateId: revokeCommandId,
    toState: "dispatched",
    idempotencyKey: "share-http-dispatch-revoke",
  });
  applyCallback({
    operation: "revokeExport",
    commandId: revokeCommandId,
    providerOperationId: "provider-share-http-revoke-1",
    targetProviderOperationId: "provider-share-http-1",
    eventId: "share-http-revoked-1",
    evidenceId: "share-http-revoked-evidence-1",
    sequence: 2,
  });
  const revokedResponse = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.get", input: { exportCommandId } }),
  });
  assert.equal(revokedResponse.status, 200);
  assert.equal((await json(revokedResponse)).data.state, "revoked");
  const expiredCommandId = "B10:share-http-expired-1";
  runtime.createExternalCommand(service, {
    record: {
      id: expiredCommandId,
      collection: "sharing.export-commands",
      ownerActorId: "consumer-1",
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId: "share-http-expired-work-1",
        expiresAt: "2020-01-01T00:00:00.000Z",
        revocable: true,
      },
    },
    commandId: expiredCommandId,
    batchId: "B10",
    operation: "publishExport",
    details: { requestedBy: "consumer-1" },
    idempotencyKey: "share-http-create-expired-export",
  });
  runtime.transitionExternalCommand(service, {
    commandId: expiredCommandId,
    batchId: "B10",
    operation: "publishExport",
    aggregateCollection: "sharing.export-commands",
    aggregateId: expiredCommandId,
    toState: "dispatched",
    idempotencyKey: "share-http-dispatch-expired-export",
  });
  applyCallback({
    operation: "publishExport",
    commandId: expiredCommandId,
    providerOperationId: "provider-share-http-expired-1",
    eventId: "share-http-expired-event-1",
    evidenceId: "share-http-expired-evidence-1",
    sequence: 3,
  });
  const expiredResponse = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({ query: "share-grant.get", input: { exportCommandId: expiredCommandId } }),
  });
  assert.equal(expiredResponse.status, 200);
  const expiredBody = await json(expiredResponse);
  assert.equal(expiredBody.data.state, "expired");
  assert.equal(expiredBody.data.providerOperationId, null);
  const adminCommand = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query: "external-command.get", input: { commandId: exportCommandId } }),
  });
  assert.equal(adminCommand.status, 200);
  assert.equal((await json(adminCommand)).data.commandId, exportCommandId);
  for (const collection of ["sharing.export-commands", "\u00a0sharing.export-revoke-commands\u2003"]) {
    for (const [query, input] of [
      ["record.get", { collection, id: exportCommandId }],
      ["record.list", { collection, limit: 50 }],
    ]) {
      const genericRead = await fetch(`${baseUrl}/v1/queries`, {
        method: "POST",
        headers: consumerAuthHeaders(),
        body: JSON.stringify({ query, input }),
      });
      assert.equal(genericRead.status, 403);
      const body = await json(genericRead);
      assert.equal(body.error.code, "AUTH_FORBIDDEN");
      assert.equal(JSON.stringify(body).includes("provider-share-http-1"), false);
      assert.equal(JSON.stringify(body).includes("provider-share-http-expired-1"), false);
    }
  }
  const expiredGenericGet = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({
      query: "record.get",
      input: { collection: "\u00a0sharing.export-commands\u2003", id: expiredCommandId },
    }),
  });
  assert.equal(expiredGenericGet.status, 403);
  assert.equal(JSON.stringify(await json(expiredGenericGet)).includes("provider-share-http-expired-1"), false);
});

test("generic record mutations cannot alter server-managed provider aggregates", async () => {
  const { baseUrl } = await fixture();
  const protectedCollections = [
    "media.intake-results",
    "media.quality-decisions",
    "media.safety-certificates",
    "sharing.export-commands",
    "generation.timeline-commands",
    "notification.delivery-commands",
    "commerce.store-entitlements",
    "commerce.wechat-payments",
    "supply.shipments",
    "supply.inventory-balances",
    "supply.vendor-scorecards",
  ];
  const mutations = [
    ["record.create", (collection) => ({ collection, id: "caller-command", data: {} })],
    ["record.update", (collection) => ({ collection, id: "caller-command", expectedVersion: 1, data: {} })],
    ["record.delete", (collection) => ({ collection, id: "caller-command", expectedVersion: 1 })],
  ];
  let request = 0;
  for (const canonicalCollection of protectedCollections) {
    for (const collection of [` ${canonicalCollection} `, `\u00a0${canonicalCollection}\u2003`]) {
      for (const [command, input] of mutations) {
        request += 1;
        const response = await fetch(`${baseUrl}/v1/commands`, {
          method: "POST",
          headers: authHeaders({ "idempotency-key": `protected-collection-${request}` }),
          body: JSON.stringify({ command, input: input(collection) }),
        });
        assert.equal(response.status, 403, `${command} must not mutate ${canonicalCollection}`);
        assert.equal((await json(response)).error.code, "AUTH_FORBIDDEN");
      }
    }
  }
  const safeBusinessProjection = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerAuthHeaders(),
    body: JSON.stringify({ query: "record.list", input: { collection: " generation.timeline-commands ", limit: 50 } }),
  });
  assert.equal(safeBusinessProjection.status, 200);
  assert.deepEqual((await json(safeBusinessProjection)).data, []);
});

test("consumers cannot submit authoritative quality or safety claims through capabilities", async () => {
  const { baseUrl } = await fixture();
  for (const batchId of ["B15", "B17"]) {
    const response = await fetch(`${baseUrl}/v1/capabilities/${batchId}`, {
      method: "POST",
      headers: consumerAuthHeaders({ "idempotency-key": `consumer-forged-${batchId}` }),
      body: JSON.stringify({ workId: "forged-work", decision: "pass" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await json(response)).error.code, "AUTH_FORBIDDEN");
  }
});

test("WeChat identity and resumable upload routes bind broker work to the verified principal", async () => {
  const calls = [];
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const { publicKey: identityPublicKey, privateKey: identityPrivateKey } = generateKeyPairSync("ed25519");
  const identityPrivateKeyPem = identityPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const session = {
    accessToken: "broker-issued-access-token-0001",
    expiresAt: future,
    tenantId: "tenant-a",
    actorId: "consumer-1",
    roles: ["consumer"],
    purpose: "product_operation",
  };
  const clientIntegrations = {
    wechatIdentity: {
      async createSession(input) { calls.push(["identity.create", input]); return { session }; },
      async refreshSession(input) { calls.push(["identity.refresh", input]); return { session }; },
      async revokeSession(input) { calls.push(["identity.revoke", input]); },
      async readiness() { return { ready: true, dependency: "wechat-identity" }; },
    },
    resumableUploads: {
      async create(context, input) { calls.push(["upload.create", context, input]); return { uploadId: "upload-1", nextOffset: 0, expiresAt: future }; },
      async append(context, input) { calls.push(["upload.append", context, input]); return { nextOffset: input.end + 1 }; },
      async complete(context, input) { calls.push(["upload.complete", context, input]); return { uploadId: input.uploadId, assetId: "media-1", state: "available" }; },
      async cancel(context, input) { calls.push(["upload.cancel", context, input]); },
      async resolveIntake(context, input) {
        calls.push(["upload.resolve-intake", context, input]);
        return secureMediaProjection(input.assetId, input.participantIds);
      },
      async deleteAsset(context, input) {
        calls.push(["upload.delete-asset", context, input]);
        return { ...secureDeletionProjection(input.assetId), auditId: "audit-api-mock-delete-1" };
      },
      async readiness() { return { ready: true, dependency: "resumable-upload" }; },
    },
  };
  const { baseUrl, runtime } = await fixture({
    clientIntegrations,
    runtimeOptions: {
      evidencePolicy: "development",
      evidenceEnvironment: "sandbox",
      trustedEvidenceKeys: [{
        issuer: "identity-verifier",
        provider: "identity-registry",
        keyId: "identity-key-1",
        algorithm: "Ed25519",
        publicKeyPem: identityPublicKey.export({ type: "spki", format: "pem" }).toString(),
        allowedScopes: ["identity.*"],
        allowedEnvironments: ["sandbox"],
      }],
    },
  });
  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual((await json(ready)).integrations.map((item) => item.dependency), ["wechat-identity", "resumable-upload"]);

  const login = await fetch(`${baseUrl}/v1/auth/wechat/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "wechat-login-1" },
    body: JSON.stringify({ code: "wx-code-once", consentVersion: "wechat-privacy-v1", clientRequestId: "client-login-1" }),
  });
  assert.equal(login.status, 200);
  assert.equal((await json(login)).session.accessToken, session.accessToken);

  const refresh = await fetch(`${baseUrl}/v1/auth/session/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", "idempotency-key": "refresh-1" },
    body: "{}",
  });
  assert.equal(refresh.status, 200);
  const logout = await fetch(`${baseUrl}/v1/auth/session/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", "idempotency-key": "logout-1" },
    body: "{}",
  });
  assert.equal(logout.status, 200);

  const weakUploadDigest = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "upload-create-weak-digest" }),
    body: JSON.stringify({
      fileSize: 3,
      fileDigest: "a".repeat(64),
      digestAlgorithm: "sha1",
      contentType: "image/jpeg",
      clientRequestId: "client-upload-weak-digest",
    }),
  });
  assert.equal(weakUploadDigest.status, 422);
  assert.equal((await json(weakUploadDigest)).error.code, "VALIDATION_FAILED");

  const truncatedUploadDigest = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "upload-create-truncated-digest" }),
    body: JSON.stringify({
      fileSize: 3,
      fileDigest: "a".repeat(40),
      digestAlgorithm: "sha256",
      contentType: "image/jpeg",
      clientRequestId: "client-upload-truncated-digest",
    }),
  });
  assert.equal(truncatedUploadDigest.status, 422);
  assert.equal((await json(truncatedUploadDigest)).error.code, "VALIDATION_FAILED");
  assert.equal(calls.some(([name]) => name === "upload.create"), false);

  const uploadCreate = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "upload-create-1" }),
    body: JSON.stringify({
      fileSize: 3,
      fileDigest: "a".repeat(64),
      digestAlgorithm: "sha256",
      contentType: "image/jpeg",
      clientRequestId: "client-upload-1",
    }),
  });
  assert.equal(uploadCreate.status, 201);
  const uploadCreateBody = await json(uploadCreate);
  assert.equal(uploadCreateBody.uploadId, "upload-1");
  assert.equal(uploadCreateBody.chunkBytes, 5 * 1024 * 1024);
  const chunkBytes = Buffer.from("abc");
  const chunk = await fetch(`${baseUrl}/v1/uploads/upload-1/chunks`, {
    method: "POST",
    headers: consumerAuthHeaders({
      "content-type": "application/octet-stream",
      "content-range": "bytes 0-2/3",
      "x-chunk-sha256": createHash("sha256").update(chunkBytes).digest("hex"),
      "idempotency-key": "upload-1-0",
    }),
    body: chunkBytes,
  });
  assert.equal(chunk.status, 200);
  assert.equal((await json(chunk)).nextOffset, 3);
  const mismatchedChunk = await fetch(`${baseUrl}/v1/uploads/upload-1/chunks`, {
    method: "POST",
    headers: consumerAuthHeaders({
      "content-type": "application/octet-stream",
      "content-range": "bytes 0-2/3",
      "x-chunk-sha256": "0".repeat(64),
      "idempotency-key": "upload-1-invalid-checksum",
    }),
    body: chunkBytes,
  });
  assert.equal(mismatchedChunk.status, 422);
  assert.equal((await json(mismatchedChunk)).error.code, "VALIDATION_FAILED");
  const complete = await fetch(`${baseUrl}/v1/uploads/upload-1/complete`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "upload-1-complete" }),
    body: JSON.stringify({ fileDigest: "a".repeat(64), digestAlgorithm: "sha256" }),
  });
  assert.equal(complete.status, 200);
  assert.equal((await json(complete)).assetId, "media-1");
  const cancel = await fetch(`${baseUrl}/v1/uploads/upload-1/cancel`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "upload-1-cancel" }),
    body: "{}",
  });
  assert.equal(cancel.status, 200);

  const createCall = calls.find(([name]) => name === "upload.create");
  assert.equal(createCall[1].tenantId, "tenant-a");
  assert.equal(createCall[1].actorId, "consumer-1");
  assert.equal(createCall[2].idempotencyKey, "upload-create-1");
  const appendCall = calls.find(([name]) => name === "upload.append");
  assert.equal(Buffer.from(appendCall[2].bytes).toString("utf8"), "abc");

  const mediaActor = {
    actorId: "consumer-1",
    tenantId: "tenant-a",
    roles: ["consumer"],
    purpose: "age_transformation",
    requestId: "media-intake-consent",
  };
  const missingConsent = await fetch(`${baseUrl}/v1/capabilities/B07`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "age_transformation", "idempotency-key": "media-intake-no-consent-1" }),
    body: JSON.stringify({ input: { assetId: "media-1", participantIds: [mediaActor.actorId] } }),
  });
  assert.equal(missingConsent.status, 409);
  assert.equal((await json(missingConsent)).error.code, "CONSENT_REQUIRED");
  assert.equal(calls.some(([name]) => name === "upload.resolve-intake"), false);

  const identityService = {
    actorId: "identity-service",
    tenantId: mediaActor.tenantId,
    roles: ["service_account", "platform_admin"],
    purpose: mediaActor.purpose,
    requestId: "media-participant-registration",
    operationId: "media-participant-registration",
  };
  const participantMutation = {
    operation: "participant.register",
    tenantId: mediaActor.tenantId,
    participantId: mediaActor.actorId,
    ownerActorId: mediaActor.actorId,
    minorStatus: "adult",
    expiresAt: future,
    expectedVersion: null,
  };
  const participantEvidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId: "media-participant-evidence-1",
    tenantId: mediaActor.tenantId,
    issuer: "identity-verifier",
    provider: "identity-registry",
    environment: "sandbox",
    scope: participantEvidenceScope(participantMutation),
    artifactSha256: "f".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: future,
    nonce: "nonce-media-participant-evidence-1",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "identity-key-1",
  }, identityPrivateKeyPem);
  runtime.registerExternalEvidence(identityService, {
    evidence: participantEvidence,
    idempotencyKey: "media-participant-evidence-register-1",
  });
  runtime.registerParticipant(identityService, {
    participantId: mediaActor.actorId,
    ownerActorId: mediaActor.actorId,
    minorStatus: "adult",
    expiresAt: future,
    expectedVersion: null,
    evidenceId: participantEvidence.evidenceId,
    idempotencyKey: "media-participant-register-1",
  });
  runtime.grantConsent(mediaActor, {
    participantId: mediaActor.actorId,
    grantorCapacity: "self",
    purpose: mediaActor.purpose,
    scope: { resource: "media.asset:media-1", actions: ["ingest", "transform"] },
    policyVersion: "privacy-v1",
    evidenceHash: "d".repeat(64),
    idempotencyKey: "media-intake-consent-1",
  });

  const injected = await fetch(`${baseUrl}/v1/capabilities/B07`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "age_transformation", "idempotency-key": "media-intake-injection-1" }),
    body: JSON.stringify({
      input: {
        assetId: "media-1",
        participantIds: [mediaActor.actorId],
        canonicalSha256: "0".repeat(64),
      },
    }),
  });
  assert.equal(injected.status, 422);
  assert.equal((await json(injected)).error.code, "VALIDATION_FAILED");
  assert.equal(calls.some(([name]) => name === "upload.resolve-intake"), false);

  const asciiWhitespaceInjection = await fetch(`${baseUrl}/v1/capabilities`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "age_transformation", "idempotency-key": "media-intake-ascii-space-1" }),
    body: JSON.stringify({
      batchId: " B07 ",
      input: {
        assetId: "media-ascii-space",
        participantIds: [mediaActor.actorId],
        canonicalSha256: "0".repeat(64),
      },
    }),
  });
  assert.equal(asciiWhitespaceInjection.status, 422);
  assert.equal((await json(asciiWhitespaceInjection)).error.code, "VALIDATION_FAILED");
  assert.equal(calls.some(([name, , input]) => name === "upload.resolve-intake" && input.assetId === "media-ascii-space"), false);

  const accepted = await fetch(`${baseUrl}/v1/capabilities/B07`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "age_transformation", "idempotency-key": "media-intake-accept-1" }),
    body: JSON.stringify({ input: { assetId: "media-1", participantIds: [mediaActor.actorId] } }),
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await json(accepted);
  assert.equal(acceptedBody.data.state, "persisted");
  const resolveCall = calls.find(([name]) => name === "upload.resolve-intake");
  assert.equal(resolveCall[1].tenantId, "tenant-a");
  assert.equal(resolveCall[1].actorId, "consumer-1");
  assert.deepEqual(resolveCall[2].participantIds, ["consumer-1"]);
  const intakeRecord = runtime.getRecord(mediaActor, "media.intake-results", "media-1");
  assert.equal(intakeRecord.ownerActorId, "consumer-1");
  assert.equal(intakeRecord.data.batchId, "B07");
  assert.equal(intakeRecord.data.canonicalSha256, "c".repeat(64));
  assert.equal(intakeRecord.data.participantMapComplete, true);

  runtime.grantConsent(mediaActor, {
    participantId: mediaActor.actorId,
    grantorCapacity: "self",
    purpose: mediaActor.purpose,
    scope: { resource: "media.asset:media-unicode-space", actions: ["ingest"] },
    policyVersion: "privacy-v1",
    evidenceHash: "e".repeat(64),
    idempotencyKey: "media-unicode-consent-1",
  });
  const unicodeWhitespace = await fetch(`${baseUrl}/v1/capabilities`, {
    method: "POST",
    headers: consumerAuthHeaders({ "x-purpose": "age_transformation", "idempotency-key": "media-intake-unicode-space-1" }),
    body: JSON.stringify({
      batchId: "\u2003B07\u00a0",
      input: { assetId: "media-unicode-space", participantIds: [mediaActor.actorId] },
    }),
  });
  assert.equal(unicodeWhitespace.status, 200);
  assert.equal((await json(unicodeWhitespace)).data.state, "persisted");
  assert.equal(
    calls.filter(([name, , input]) => name === "upload.resolve-intake" && input.assetId === "media-unicode-space").length,
    1,
  );
});

test("B05 immediate retention traverses the authenticated API-to-broker delete contract and fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-b05-broker-wire-"));
  const token = "b05-broker-workload-token-value-123456789";
  const tokenFile = join(directory, "workload-token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o400 });
  let failDeletion = false;
  let providerDeleteCount = 0;
  const brokerCalls = [];
  const brokerTombstones = new Map();
  const brokerServer = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    brokerCalls.push({
      path: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      requestId: request.headers["x-request-id"],
      body,
    });
    response.setHeader("content-type", "application/json");
    if (failDeletion) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true } }));
      return;
    }
    let tombstone = brokerTombstones.get(request.headers["idempotency-key"]);
    if (tombstone === undefined) {
      providerDeleteCount += 1;
      tombstone = secureDeletionProjection(
        decodeURIComponent((request.url ?? "").split("/")[4] ?? ""),
        "tenant-a",
        providerDeleteCount,
      );
      brokerTombstones.set(request.headers["idempotency-key"], tombstone);
    }
    response.statusCode = 200;
    response.end(JSON.stringify(tombstone));
  });
  brokerServer.listen(0, "127.0.0.1");
  await once(brokerServer, "listening");
  const address = brokerServer.address();
  assert.ok(address && typeof address !== "string");
  cleanups.push(async () => {
    await new Promise((resolvePromise) => brokerServer.close(resolvePromise));
    rmSync(directory, { recursive: true, force: true });
  });
  const resumableUploads = new HttpResumableUploadBroker({
    baseUrl: `http://127.0.0.1:${address.port}`,
    workloadTokenFile: tokenFile,
    allowInsecureLoopback: true,
  });
  const recoveryAssetId = "media-b05-db-write-recovery";
  let failRecoveryCommandWrite = true;
  const { baseUrl, runtime } = await fixture({
    clientIntegrations: { resumableUploads },
    runtimeAdapter: (target) => new Proxy(target, {
      get(object, property) {
        if (property === "createExternalCommand") {
          return (context, command) => {
            if (command.record.id === recoveryAssetId && failRecoveryCommandWrite) {
              failRecoveryCommandWrite = false;
              throw new DomainError("DEPENDENCY_UNAVAILABLE", "simulated database write failure");
            }
            return object.createExternalCommand(context, command);
          };
        }
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    }),
  });
  const input = {
    assetId: "media-b05-delete-1",
    reason: "verified data-subject deletion request",
  };
  const deleted = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "b05-api-broker-delete-1" }),
    body: JSON.stringify({ input }),
  });
  assert.equal(deleted.status, 200);
  const deletedBody = await json(deleted);
  assert.deepEqual(Object.keys(deletedBody.data.mediaDeletion).sort(), [
    "auditId", "classification", "deletedAt", "deletionRequestId", "deletionTargets", "encrypted", "mediaReference",
    "policyId", "policySha256", "requestedAt", "retentionDays", "retentionExpiresAt", "state", "targetReceipts",
  ]);
  assert.equal(deletedBody.data.mediaDeletion.mediaReference, input.assetId);
  assert.equal(deletedBody.data.mediaDeletion.state, "deleted");
  assert.equal(deletedBody.data.mediaDeletion.auditId, "audit-b05-wire-1");
  assert.ok(Number.isFinite(Date.parse(deletedBody.data.mediaDeletion.deletedAt)));
  assert.equal(deletedBody.data.batchId, "B05");
  assert.equal(deletedBody.data.commandState, "requested");
  assert.equal(brokerCalls.length, 1);
  assert.equal(brokerCalls[0].path, `/v1/media/assets/${input.assetId}/delete`);
  assert.equal(brokerCalls[0].authorization, `Bearer ${token}`);
  assert.equal(brokerCalls[0].idempotencyKey, "b05-api-broker-delete-1");
  assert.deepEqual(brokerCalls[0].body.principal, {
    actorId: "admin-1",
    tenantId: "tenant-a",
    roles: ["platform_admin"],
    purpose: "product_operation",
  });
  assert.equal(brokerCalls[0].body.reason, input.reason);
  assert.deepEqual(deletedBody.data.mediaDeletion.deletionTargets, ["s3-primary", "s3-derived"]);
  assert.equal(deletedBody.data.mediaDeletion.retentionDays, 365);

  failDeletion = true;
  const failedAssetId = "media-b05-delete-failure";
  const failed = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "b05-api-broker-delete-failure" }),
    body: JSON.stringify({ input: { ...input, assetId: failedAssetId } }),
  });
  assert.equal(failed.status, 503);
  assert.equal((await json(failed)).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
  assert.throws(
    () => runtime.getRecord({
      actorId: "admin-1",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      purpose: "product_operation",
      requestId: "b05-failed-record-check",
      stepUp: true,
    }, "media.lifecycle-commands", failedAssetId),
    (error) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );

  failDeletion = false;
  const recoveryKey = "b05-api-db-write-recovery";
  const recoveryRequest = {
    input: { ...input, assetId: recoveryAssetId },
  };
  const databaseFailed = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": recoveryKey }),
    body: JSON.stringify(recoveryRequest),
  });
  assert.equal(databaseFailed.status, 503);
  assert.equal((await json(databaseFailed)).error.code, "DEPENDENCY_UNAVAILABLE");
  const durableTombstone = brokerTombstones.get(recoveryKey);
  assert.ok(durableTombstone);
  const deletesBeforeRetry = providerDeleteCount;
  assert.throws(
    () => runtime.getRecord({
      actorId: "admin-1",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      purpose: "product_operation",
      requestId: "b05-recovery-before-retry",
      stepUp: true,
    }, "media.lifecycle-commands", recoveryAssetId),
    (error) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
  const recovered = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": recoveryKey }),
    body: JSON.stringify(recoveryRequest),
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await json(recovered)).data.mediaDeletion, durableTombstone);
  assert.equal(providerDeleteCount, deletesBeforeRetry, "broker tombstone replay must not execute a second provider deletion");
  assert.equal(
    runtime.getRecord({
      actorId: "admin-1",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      purpose: "product_operation",
      requestId: "b05-recovery-after-retry",
      stepUp: true,
    }, "media.lifecycle-commands", recoveryAssetId).data.batchId,
    "B05",
  );
});

test("B05 accepts step-up data-subject and privacy authority but rejects every caller-supplied policy field", async () => {
  const calls = [];
  const authenticator = new StaticTokenAuthenticator([
    {
      token: "test-data-subject-token-0001",
      actorId: "consumer-1",
      tenantId: "tenant-a",
      roles: ["consumer"],
      allowedPurposes: ["data_deletion"],
      stepUp: true,
    },
    {
      token: "test-privacy-officer-token-0001",
      actorId: "privacy-1",
      tenantId: "tenant-a",
      roles: ["privacy_officer"],
      allowedPurposes: ["privacy_compliance"],
      stepUp: true,
    },
  ]);
  const clientIntegrations = {
    resumableUploads: {
      async create() { throw new Error("not used"); },
      async append() { throw new Error("not used"); },
      async complete() { throw new Error("not used"); },
      async cancel() { throw new Error("not used"); },
      async resolveIntake() { throw new Error("not used"); },
      async deleteAsset(context, input) {
        calls.push({ context, input });
        return secureDeletionProjection(input.assetId);
      },
      async readiness() { return { ready: true, dependency: "resumable-upload" }; },
    },
  };
  const { baseUrl } = await fixture({ authenticator, clientIntegrations });
  const subject = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-data-subject-token-0001",
      "content-type": "application/json",
      "x-purpose": "data_deletion",
      "idempotency-key": "b05-data-subject-1",
    },
    body: JSON.stringify({ input: { assetId: "media-subject-1", reason: "data subject erasure request" } }),
  });
  assert.equal(subject.status, 200);
  assert.deepEqual(calls[0].context.roles, ["consumer"]);
  assert.equal(calls[0].input.reason, "data subject erasure request");

  const injected = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-data-subject-token-0001",
      "content-type": "application/json",
      "x-purpose": "data_deletion",
      "idempotency-key": "b05-data-subject-injected-policy-1",
    },
    body: JSON.stringify({
      input: {
        assetId: "media-subject-2",
        reason: "attempted target override",
        retentionDays: 0,
        deletionTargets: ["attacker-target"],
      },
    }),
  });
  assert.equal(injected.status, 422);
  assert.equal((await json(injected)).error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 1);

  const privacy = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-privacy-officer-token-0001",
      "content-type": "application/json",
      "x-purpose": "privacy_compliance",
      "idempotency-key": "b05-privacy-officer-1",
    },
    body: JSON.stringify({ input: { assetId: "media-privacy-1", reason: "privacy officer approved erasure" } }),
  });
  assert.equal(privacy.status, 200);
  assert.deepEqual(calls[1].context.roles, ["privacy_officer"]);
});

test("client integration routes fail closed when their production adapters are absent", async () => {
  const { baseUrl } = await fixture();
  const login = await fetch(`${baseUrl}/v1/auth/wechat/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "missing-broker-1" },
    body: JSON.stringify({ code: "code", consentVersion: "v1", clientRequestId: "request-1" }),
  });
  assert.equal(login.status, 503);
  assert.equal((await json(login)).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
  const upload = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "missing-upload-1" }),
    body: JSON.stringify({ fileSize: 1, fileDigest: "a".repeat(64), digestAlgorithm: "sha256", contentType: "image/jpeg", clientRequestId: "upload-1" }),
  });
  assert.equal(upload.status, 503);
  assert.equal((await json(upload)).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
  const deletion = await fetch(`${baseUrl}/v1/capabilities/B05`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "missing-b05-delete-broker-1" }),
    body: JSON.stringify({
      input: {
        assetId: "media-missing-broker-1",
        reason: "privacy request",
      },
    }),
  });
  assert.equal(deletion.status, 503);
  assert.equal((await json(deletion)).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
});

test("authenticated command/query flow enforces tenant context and idempotency fingerprints", async () => {
  const { baseUrl } = await fixture();
  const createBody = {
    command: "record.create",
    input: { collection: "projects", processingPurpose: "product_operation", data: { name: "First project" } },
  };
  const create = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-create-project-1", "x-request-id": "request-http-0001" }),
    body: JSON.stringify(createBody),
  });
  assert.equal(create.status, 200);
  assert.equal(create.headers.get("x-request-id"), "request-http-0001");
  const created = await json(create);
  assert.equal(created.data.replayed, false);
  assert.equal(created.data.value.tenantId, "tenant-a");

  const replay = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-create-project-1" }),
    body: JSON.stringify(createBody),
  });
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).data.replayed, true);

  const conflict = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-create-project-1" }),
    body: JSON.stringify({
      ...createBody,
      input: { collection: "projects", processingPurpose: "product_operation", data: { name: "Changed" } },
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).error.code, "IDEMPOTENCY_CONFLICT");

  const query = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      query: "record.get",
      input: { collection: "projects", id: created.data.value.id },
    }),
  });
  assert.equal(query.status, 200);
  assert.equal((await json(query)).data.data.name, "First project");

  const injectedTenant = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders({ "x-tenant-id": "tenant-b" }),
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(injectedTenant.status, 403);
  assert.equal((await json(injectedTenant)).error.code, "AUTH_FORBIDDEN");
});

test("authentication and request parsing fail closed", async () => {
  const { baseUrl } = await fixture({ bodyLimitBytes: 1024 });
  const missing = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-purpose": "product_operation" },
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");

  const wrongPurpose = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders({ "x-purpose": "insurance_underwriting" }),
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(wrongPurpose.status, 403);

  const noIdempotency = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ command: "record.create", input: { collection: "projects", data: {} } }),
  });
  assert.equal(noIdempotency.status, 422);

  const tooLarge = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "oversized-body-1" }),
    body: JSON.stringify({ command: "record.create", input: { collection: "projects", data: { blob: "x".repeat(2_000) } } }),
  });
  assert.equal(tooLarge.status, 413);

  const stepUpInjection = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders({ "x-ltm-step-up": "true" }),
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(stepUpInjection.status, 403);
});

test("capability dispatch executes real handlers and persists their output", async () => {
  const { baseUrl } = await fixture();
  const unauthorized = await fetch(`${baseUrl}/v1/capabilities/B01`, {
    method: "POST",
    headers: consumerAuthHeaders({ "idempotency-key": "capability-b01-consumer-denied" }),
    body: JSON.stringify({
      input: {
        repositoryId: "consumer-cannot-control-platform",
        stackProfile: "all-typescript",
        boundedContexts: ["identity", "generation"],
        healthChecks: ["liveness", "readiness"],
        ownershipRules: ["tenant-scoped"],
      },
    }),
  });
  assert.equal(unauthorized.status, 403);

  const response = await fetch(`${baseUrl}/v1/capabilities/B01`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "capability-b01-http-1" }),
    body: JSON.stringify({
      input: {
        repositoryId: "lifetime-machine",
        stackProfile: "all-typescript",
        boundedContexts: ["identity", "generation"],
        healthChecks: ["liveness", "readiness"],
        ownershipRules: ["tenant-scoped"],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.batchId, "B01");
  assert.equal(body.data.state, "persisted");

  const list = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query: "record.list", input: { collection: "platform.architectures" } }),
  });
  assert.equal(list.status, 200);
  assert.equal((await json(list)).data.length, 1);
});

test("production launch capabilities fail closed without scoped external evidence verification", async () => {
  const { baseUrl } = await fixture();
  const response = await fetch(`${baseUrl}/v1/capabilities/B127`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "capability-b127-unverified-1" }),
    body: JSON.stringify({
      input: {
        launchId: "launch-1",
        releaseControlProviderId: "release-control-1",
        providerEnvironment: "production",
        releaseManifestDigest: "a".repeat(64),
        repositoryCommit: "commit-1",
        artifactCommit: "commit-1",
        sbomDigest: "b".repeat(64),
        wave: "internal",
        rolloutPercent: 1,
        waveStartedAt: "2026-08-20T00:00:00.000Z",
        releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
        monitoringDomains: ["quality", "payment", "refund", "message", "support", "ledger", "supply", "privacy", "security", "cost", "slo"],
        approvalIds: ["approval-1", "approval-2"],
        rollbackExerciseId: "rollback-exercise-1",
        automaticPausePolicyVersion: "pause-policy-v1",
        guardrailPolicySha256: "c".repeat(64),
        waveObservationSetSha256: "d".repeat(64),
        rollbackForwardDrillSha256: "e".repeat(64),
        changeApproverEvidenceIds: ["change-risk-evidence", "change-operations-evidence"],
        activeGuardrailBreaches: 0,
        externalEvidenceIds: ["evidence-1", "evidence-2", "evidence-3", "evidence-4", "evidence-5"],
      },
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await json(response)).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
});

test("local synthetic auth is explicit and impossible in production", async () => {
  assert.throws(
    () => StaticTokenAuthenticator.localSynthetic("production"),
    (error) => error instanceof DomainError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
  assert.throws(
    () => StaticTokenAuthenticator.fromEnvironment(undefined),
    (error) => error instanceof DomainError && error.code === "DEPENDENCY_UNAVAILABLE",
  );

  const authenticator = StaticTokenAuthenticator.localSynthetic("development");
  const { baseUrl } = await fixture({
    authenticator,
    allowSandboxStepUpHeader: true,
    appEnvironment: "development",
  });
  const response = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-consumer",
      "content-type": "application/json",
      "x-purpose": "product_experience",
      "x-ltm-step-up": "true",
      "idempotency-key": "local-consumer-create-1",
    },
    body: JSON.stringify({
      command: "record.create",
      input: { collection: "projects", processingPurpose: "product_experience", data: { local: true } },
    }),
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.value.tenantId, "tenant-local");
  assert.equal(body.data.value.ownerActorId, "user-synthetic");
});

test("configured authentication accepts a server-side bearer digest", async () => {
  const secret = "digest-backed-test-token-0001";
  const tokenSha256 = createHash("sha256").update(secret).digest("hex");
  const authenticator = StaticTokenAuthenticator.fromEnvironment(JSON.stringify([
    {
      tokenSha256,
      actorId: "digest-user",
      tenantId: "digest-tenant",
      roles: ["consumer"],
      allowedPurposes: ["product_experience"],
    },
  ]));
  const { baseUrl } = await fixture({ authenticator });
  const response = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-purpose": "product_experience",
    },
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).data, []);
});

test("signed evidence registration/query works through JSON dispatch and remains environment bound", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const scope = `B66:verifyStoreTransaction:store-provider:${"a".repeat(64)}`;
  const { baseUrl, runtime } = await fixture({
    runtimeOptions: {
      evidencePolicy: "development",
      evidenceEnvironment: "staging",
      trustedEvidenceKeys: [{
        issuer: "store-issuer",
        provider: "store-provider",
        keyId: "store-key-1",
        algorithm: "Ed25519",
        publicKeyPem,
        allowedScopes: [scope],
        allowedEnvironments: ["staging"],
      }],
    },
  });
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId: "http-evidence-1",
    tenantId: "tenant-a",
    issuer: "store-issuer",
    provider: "store-provider",
    environment: "staging",
    scope,
    artifactSha256: "a".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    nonce: "http-evidence-nonce-0001",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "store-key-1",
  }, privateKeyPem);
  const registrationRequest = () => fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-register-evidence-1" }),
    body: JSON.stringify({ command: "evidence.register", input: { evidence } }),
  });
  const registrations = await Promise.all([registrationRequest(), registrationRequest()]);
  assert.deepEqual(registrations.map((response) => response.status), [200, 200]);
  const registrationBodies = await Promise.all(registrations.map(json));
  assert.deepEqual(registrationBodies.map((body) => body.data.replayed).sort(), [false, true]);
  assert.equal(registrationBodies[0].data.value.environment, "staging");

  const changedEvidence = signExternalEvidence({
    ...evidence,
    evidenceId: "http-evidence-changed-body",
    artifactSha256: "b".repeat(64),
    nonce: "http-evidence-changed-body-nonce",
    signature: undefined,
  }, privateKeyPem);
  const changed = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-register-evidence-1" }),
    body: JSON.stringify({ command: "evidence.register", input: { evidence: changedEvidence } }),
  });
  assert.equal(changed.status, 409);
  assert.equal((await json(changed)).error.code, "IDEMPOTENCY_CONFLICT");

  const queried = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query: "evidence.get", input: { evidenceId: evidence.evidenceId } }),
  });
  assert.equal(queried.status, 200);
  assert.equal((await json(queried)).data.scope, scope);
  assert.equal(
    runtime.requireExternalEvidence(
      {
        actorId: "admin-1",
        tenantId: "tenant-a",
        roles: ["platform_admin"],
        purpose: "product_operation",
        requestId: "http-consume-evidence",
        stepUp: true,
        operationId: "server-operation-1",
      },
      scope,
      [evidence.evidenceId],
    )[0].consumedAt !== null,
    true,
  );
});

test("service-only participant registry and canonical consent scope run through closed HTTP contracts", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authenticator = new StaticTokenAuthenticator([
    {
      token: "identity-service-token-0001",
      actorId: "identity-service-http",
      tenantId: "tenant-a",
      roles: ["service_account", "platform_admin"],
      allowedPurposes: ["identity_management"],
      stepUp: true,
    },
    {
      token: "identity-consumer-token-0001",
      actorId: "identity-consumer-http",
      tenantId: "tenant-a",
      roles: ["consumer"],
      allowedPurposes: ["age_transformation"],
    },
  ]);
  const { baseUrl } = await fixture({
    authenticator,
    runtimeOptions: {
      evidencePolicy: "development",
      evidenceEnvironment: "sandbox",
      trustedEvidenceKeys: [{
        issuer: "identity-http-verifier",
        provider: "identity-http-registry",
        keyId: "identity-http-key-1",
        algorithm: "Ed25519",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        allowedScopes: ["identity.*"],
        allowedEnvironments: ["sandbox"],
      }],
    },
  });
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const mutation = {
    operation: "participant.register",
    tenantId: "tenant-a",
    participantId: "identity-consumer-http",
    ownerActorId: "identity-consumer-http",
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
  };
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId: "identity-http-participant-evidence-1",
    tenantId: mutation.tenantId,
    issuer: "identity-http-verifier",
    provider: "identity-http-registry",
    environment: "sandbox",
    scope: participantEvidenceScope(mutation),
    artifactSha256: "9".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    nonce: "identity-http-participant-nonce-0001",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "identity-http-key-1",
  }, privateKey.export({ type: "pkcs8", format: "pem" }));
  const serviceHeaders = {
    authorization: "Bearer identity-service-token-0001",
    "content-type": "application/json",
    "x-purpose": "identity_management",
  };
  const participantInput = {
    participantId: mutation.participantId,
    ownerActorId: mutation.ownerActorId,
    minorStatus: mutation.minorStatus,
    expiresAt: mutation.expiresAt,
    expectedVersion: mutation.expectedVersion,
    evidenceId: evidence.evidenceId,
  };
  const evidenceResponse = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...serviceHeaders, "idempotency-key": "identity-http-evidence-register-1" },
    body: JSON.stringify({ command: "evidence.register", input: { evidence } }),
  });
  assert.equal(evidenceResponse.status, 200);

  const expandedParticipant = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...serviceHeaders, "idempotency-key": "identity-http-participant-expanded-1" },
    body: JSON.stringify({
      command: "participant.register",
      input: { ...participantInput, clientDeclaredAuthority: true },
    }),
  });
  assert.equal(expandedParticipant.status, 422);
  assert.equal((await json(expandedParticipant)).error.code, "VALIDATION_FAILED");

  const participantResponse = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...serviceHeaders, "idempotency-key": "identity-http-participant-register-1" },
    body: JSON.stringify({
      command: "participant.register",
      input: participantInput,
    }),
  });
  assert.equal(participantResponse.status, 200);
  assert.equal((await json(participantResponse)).data.value.ownerActorId, mutation.ownerActorId);

  const consumerHeaders = {
    authorization: "Bearer identity-consumer-token-0001",
    "content-type": "application/json",
    "x-purpose": "age_transformation",
  };
  const scope = { resource: "media.asset:identity-http-asset-1", actions: ["ingest", "transform"] };
  const locationOverride = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...consumerHeaders, "idempotency-key": "identity-http-consent-location-override-1" },
    body: JSON.stringify({
      command: "consent.grant",
      input: {
        participantId: mutation.participantId,
        grantorCapacity: "self",
        purpose: "age_transformation",
        scope,
        policyVersion: "privacy-v1",
        evidenceHash: "8".repeat(64),
        jurisdiction: "US",
        locale: "en-US",
      },
    }),
  });
  assert.equal(locationOverride.status, 422);
  assert.equal((await json(locationOverride)).error.code, "VALIDATION_FAILED");
  const grant = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...consumerHeaders, "idempotency-key": "identity-http-consent-grant-1" },
    body: JSON.stringify({
      command: "consent.grant",
      input: {
        participantId: mutation.participantId,
        grantorCapacity: "self",
        purpose: "age_transformation",
        scope,
        policyVersion: "privacy-v1",
        evidenceHash: "8".repeat(64),
      },
    }),
  });
  assert.equal(grant.status, 200);

  const required = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerHeaders,
    body: JSON.stringify({
      query: "consent.require",
      input: {
        participantIds: [mutation.participantId],
        purpose: "age_transformation",
        scope: { resource: scope.resource, action: "ingest" },
      },
    }),
  });
  assert.equal(required.status, 200);
  assert.equal((await json(required)).data.length, 1);

  const expandedRequirement = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: consumerHeaders,
    body: JSON.stringify({
      query: "consent.require",
      input: {
        participantIds: [mutation.participantId],
        purpose: "age_transformation",
        scope: { resource: scope.resource, action: "ingest", actions: ["transform"] },
      },
    }),
  });
  assert.equal(expandedRequirement.status, 422);
  assert.equal((await json(expandedRequirement)).error.code, "VALIDATION_FAILED");
});

test("service-only external-event.apply resolves the compiled reducer and exposes command diagnostics", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const authenticator = new StaticTokenAuthenticator([
    {
      token: "business-event-service-token-0001",
      actorId: "integration-gateway",
      tenantId: "tenant-a",
      roles: ["service_account"],
      permissions: ["external-event:apply", "external-command:read", "record:create"],
      allowedPurposes: ["product_operation"],
    },
    {
      token: "business-operator-token-0001",
      actorId: "business-operator",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      allowedPurposes: ["product_operation"],
      stepUp: true,
    },
  ]);
  const { baseUrl, runtime } = await fixture({
    authenticator,
    runtimeOptions: {
      evidencePolicy: "development",
      evidenceEnvironment: "sandbox",
      trustedEvidenceKeys: [{
        issuer: "wechat-gateway",
        provider: "wechat-pay",
        keyId: "wechat-http-key-1",
        algorithm: "Ed25519",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        allowedScopes: ["B71:*"],
        allowedEnvironments: ["sandbox"],
      }],
    },
  });
  const claims = {
    accountId: "account-http-1",
    amountMinor: 880,
    currency: "CNY",
    outTradeNo: "order-http-1",
    providerTransactionId: "wechat-http-transaction-1",
  };
  const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
  const unsignedEvent = {
    version: "ltm.external-business-event.v1",
    eventId: "wechat-http-event-1",
    tenantId: "tenant-a",
    batchId: "B71",
    operation: "recordWechatCommercialAction",
    provider: "wechat-pay",
    subjectType: "payment",
    subjectId: "payment-http-1",
    eventType: "payment.captured",
    providerOccurredAt: new Date(Date.now() - 1_000).toISOString(),
    sequence: 1,
    correlationId: "order-http-1",
    artifactSha256: "d".repeat(64),
    evidenceId: "wechat-http-evidence-1",
    evidenceScope: "B71:payment:payment-http-1",
    canonicalClaims: claims,
    canonicalClaimsSha256,
  };
  const event = {
    ...unsignedEvent,
    businessEventSha256: canonicalBusinessEventSha256(unsignedEvent),
  };
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId: event.evidenceId,
    tenantId: event.tenantId,
    issuer: "wechat-gateway",
    provider: event.provider,
    environment: "sandbox",
    scope: event.evidenceScope,
    artifactSha256: event.artifactSha256,
    canonicalClaimsSha256,
    businessEventSha256: event.businessEventSha256,
    issuedAt: new Date(Date.now() - 5_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "wechat-http-nonce-000001",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "wechat-http-key-1",
  }, privateKeyPem);
  const serviceHeaders = {
    authorization: "Bearer business-event-service-token-0001",
    "content-type": "application/json",
    "x-purpose": "product_operation",
  };
  const operatorDenied = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: {
      authorization: "Bearer business-operator-token-0001",
      "content-type": "application/json",
      "x-purpose": "product_operation",
      "idempotency-key": "http-external-event-operator-denied-1",
    },
    body: JSON.stringify({ command: "external-event.apply", input: { event, evidence } }),
  });
  assert.equal(operatorDenied.status, 403);
  assert.equal((await json(operatorDenied)).error.code, "AUTH_FORBIDDEN");
  const injected = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...serviceHeaders, "idempotency-key": "http-external-event-injected-1" },
    body: JSON.stringify({
      command: "external-event.apply",
      input: { event, evidence, reducer: { name: "caller-controlled" } },
    }),
  });
  assert.equal(injected.status, 403);
  assert.equal((await json(injected)).error.code, "AUTH_FORBIDDEN");

  const applied = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...serviceHeaders, "idempotency-key": "http-external-event-apply-1" },
    body: JSON.stringify({ command: "external-event.apply", input: { event, evidence } }),
  });
  assert.equal(applied.status, 200);
  const appliedBody = await json(applied);
  assert.equal(appliedBody.data.value.aggregate.data.state, "captured");
  assert.equal(appliedBody.data.value.ledgerTransaction.lines.length, 2);

  const commandContext = {
    actorId: "business-operator",
    tenantId: "tenant-a",
    roles: ["platform_admin"],
    purpose: "product_operation",
    requestId: "create-diagnostic-command",
    stepUp: true,
  };
  runtime.createExternalCommand(commandContext, {
    record: {
      id: "diagnostic-command-record-1",
      collection: "operations.external-commands",
      data: { state: "requested" },
    },
    commandId: "diagnostic-command-1",
    batchId: "B74",
    operation: "scheduleMultiChannelNotification",
    idempotencyKey: "create-diagnostic-command-1",
  });
  const queried = await fetch(`${baseUrl}/v1/queries`, {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ query: "external-command.get", input: { commandId: "diagnostic-command-1" } }),
  });
  assert.equal(queried.status, 200);
  const command = (await json(queried)).data;
  assert.equal(command.state, "requested");
  assert.equal(command.reconciliationState, "clear");
});

test("HTTP external-event.apply atomically reconciles a frozen command while direct transition stays closed", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const authenticator = new StaticTokenAuthenticator([{
    token: "reconciliation-service-token-0001",
    actorId: "integration-gateway",
    tenantId: "tenant-a",
    roles: ["service_account"],
    permissions: ["external-event:apply", "external-command:transition", "external-command:read"],
    allowedPurposes: ["product_operation"],
  }]);
  const { baseUrl, runtime } = await fixture({
    authenticator,
    runtimeOptions: {
      evidencePolicy: "development",
      evidenceEnvironment: "sandbox",
      trustedEvidenceKeys: [{
        issuer: "vendor-gateway",
        provider: "vendor:vendor-http-1",
        keyId: "vendor-http-key-1",
        algorithm: "Ed25519",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        allowedScopes: ["B98:*"],
        allowedEnvironments: ["sandbox"],
      }],
    },
  });
  const service = {
    actorId: "integration-gateway",
    tenantId: "tenant-a",
    roles: ["platform_admin", "service_account"],
    purpose: "product_operation",
    requestId: "http-reconciliation-setup",
  };
  runtime.createExternalCommand(service, {
    record: {
      id: "vendor-http-command-1",
      collection: "supply.vendor-production-commands",
      data: {
        operationMode: "external-command",
        batchId: "B98",
        operation: "createVendorProductionJob",
        vendorId: "vendor-http-1",
      },
    },
    commandId: "vendor-http-command-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    idempotencyKey: "create-http-reconciliation-command",
  });
  runtime.transitionExternalCommand(service, {
    commandId: "vendor-http-command-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    aggregateCollection: "supply.vendor-production-commands",
    aggregateId: "vendor-http-command-1",
    toState: "dispatched",
    providerOperationId: "vendor-http-operation-1",
    idempotencyKey: "dispatch-http-reconciliation-command",
  });
  const requestEvent = runtime.listOutbox(service, { limit: 200 }).find((event) =>
    event.eventType === "external_command.requested" && event.aggregateId === "vendor-http-command-1");
  assert.notEqual(requestEvent, undefined);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const claimed = runtime.claimOutbox(service, "http-reconciliation-worker", 200, 30_000);
    for (const event of claimed) {
      if (event.id !== requestEvent.id) {
        runtime.markOutboxPublished(service, event.id, "http-reconciliation-worker");
      } else if (attempt < 10) {
        runtime.markOutboxFailed(service, event.id, "http-reconciliation-worker", "provider result unknown", {
          retryAt: new Date(Date.now() - 10_000).toISOString(),
        });
      }
    }
    if (attempt === 10) {
      runtime.deadLetterExternalCommand(service, {
        eventId: requestEvent.id,
        workerId: "http-reconciliation-worker",
        error: "provider result unknown after ten attempts",
      });
    }
  }
  const headers = {
    authorization: "Bearer reconciliation-service-token-0001",
    "content-type": "application/json",
    "x-purpose": "product_operation",
  };
  const direct = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "direct-http-frozen-transition" },
    body: JSON.stringify({
      command: "external-command.transition",
      input: {
        commandId: "vendor-http-command-1",
        batchId: "B98",
        operation: "createVendorProductionJob",
        aggregateCollection: "supply.vendor-production-commands",
        aggregateId: "vendor-http-command-1",
        toState: "acknowledged",
      },
    }),
  });
  assert.equal(direct.status, 409);
  assert.equal((await json(direct)).error.code, "EVIDENCE_REVOKED");

  const claims = { providerOperationId: "vendor-http-operation-1", vendorId: "vendor-http-1" };
  const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
  const unsignedEvent = {
    version: "ltm.external-business-event.v1",
    eventId: "vendor-http-terminal-event-1",
    tenantId: "tenant-a",
    batchId: "B98",
    operation: "createVendorProductionJob",
    provider: "vendor:vendor-http-1",
    subjectType: "vendor-job",
    subjectId: "vendor-http-command-1",
    eventType: "external-command.failed",
    providerOccurredAt: new Date(Date.now() - 1_000).toISOString(),
    sequence: 1,
    correlationId: "vendor-http-command-1",
    artifactSha256: "8".repeat(64),
    evidenceId: "vendor-http-terminal-evidence-1",
    evidenceScope: "B98:vendor-job:vendor-http-command-1",
    canonicalClaims: claims,
    canonicalClaimsSha256,
  };
  const event = { ...unsignedEvent, businessEventSha256: canonicalBusinessEventSha256(unsignedEvent) };
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId: event.evidenceId,
    tenantId: event.tenantId,
    issuer: "vendor-gateway",
    provider: event.provider,
    environment: "sandbox",
    scope: event.evidenceScope,
    artifactSha256: event.artifactSha256,
    canonicalClaimsSha256,
    businessEventSha256: event.businessEventSha256,
    issuedAt: new Date(Date.now() - 5_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "vendor-http-terminal-nonce-0001",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "vendor-http-key-1",
  }, privateKeyPem);
  const applied = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "http-terminal-reconciliation-apply" },
    body: JSON.stringify({ command: "external-event.apply", input: { event, evidence } }),
  });
  assert.equal(applied.status, 200);
  const result = (await json(applied)).data.value;
  assert.equal(result.command.state, "failed");
  assert.equal(result.command.decisionState, "active");
  assert.equal(result.command.reconciliationState, "clear");
  assert.equal(result.command.details.originalFreezeReason, "outbox_dead_letter");
  assert.equal(result.command.details.reconciliationEventId, event.eventId);
  assert.equal(result.command.details.reconciliationEvidenceId, evidence.evidenceId);
  assert.equal(result.aggregate.data._externalDecisionState, "active");
  assert.equal(result.aggregate.data._externalReconciliationState, "clear");
});

test("metrics can be digest protected and unexpected errors never leak secret text to logs", async () => {
  const metricsSecret = "metrics-secret-value-0001";
  const metricsTokenSha256 = createHash("sha256").update(metricsSecret).digest("hex");
  const logs = [];
  const { baseUrl } = await fixture({ metricsTokenSha256, logger: (entry) => logs.push(entry) });
  const denied = await fetch(`${baseUrl}/metrics`);
  assert.equal(denied.status, 401);
  const metrics = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${metricsSecret}` },
  });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /ltm_api_requests_total/);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(metricsSecret));

  const secretInError = "must-not-leak-auth-secret";
  const failing = await fixture({
    authenticator: { authenticate() { throw new Error(secretInError); } },
    logger: (entry) => logs.push(entry),
  });
  const response = await fetch(`${failing.baseUrl}/v1/queries`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query: "record.list", input: { collection: "projects" } }),
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secretInError));
});
