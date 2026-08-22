import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createCapabilityRegistry } from "@ltm/capabilities";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DomainError,
  LifeTimeMachineRuntime,
  signExternalEvidence,
} from "@ltm/core";
import { StaticTokenAuthenticator, createApiServer } from "../dist/index.js";

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
  ]);
  const server = createApiServer({
    runtime,
    authenticator,
    capabilityRegistry: createCapabilityRegistry(),
    staticDirectory,
    bodyLimitBytes: options.bodyLimitBytes ?? 256 * 1024,
    ...(options.allowSandboxStepUpHeader === undefined
      ? {}
      : { allowSandboxStepUpHeader: options.allowSandboxStepUpHeader }),
    ...(options.appEnvironment === undefined ? {} : { appEnvironment: options.appEnvironment }),
    ...(options.metricsTokenSha256 === undefined ? {} : { metricsTokenSha256: options.metricsTokenSha256 }),
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

async function json(response) {
  return response.json();
}

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
  const unhashedAsset = await fetch(`${baseUrl}/app.js`);
  assert.equal(unhashedAsset.headers.get("cache-control"), "no-cache");
  const hashedAsset = await fetch(`${baseUrl}/app-abcdef123456.js`);
  assert.equal(hashedAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const namedAsset = await fetch(`${baseUrl}/application-mainbundle.js`);
  assert.equal(namedAsset.headers.get("cache-control"), "no-cache");
});

test("authenticated command/query flow enforces tenant context and idempotency fingerprints", async () => {
  const { baseUrl } = await fixture();
  const createBody = {
    command: "record.create",
    input: { collection: "projects", data: { name: "First project" } },
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
    body: JSON.stringify({ ...createBody, input: { collection: "projects", data: { name: "Changed" } } }),
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
        monitoringDomains: ["quality", "payment", "refund", "support", "ledger", "supply", "privacy", "security"],
        approvalIds: ["approval-1", "approval-2"],
        rollbackExerciseId: "rollback-exercise-1",
        automaticPausePolicyVersion: "pause-policy-v1",
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
    body: JSON.stringify({ command: "record.create", input: { collection: "projects", data: { local: true } } }),
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
  const registered = await fetch(`${baseUrl}/v1/commands`, {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "http-register-evidence-1" }),
    body: JSON.stringify({ command: "evidence.register", input: { evidence } }),
  });
  assert.equal(registered.status, 200);
  assert.equal((await json(registered)).data.value.environment, "staging");

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
