import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createCapabilityRegistry } from "@ltm/capabilities";
import { DomainError, LifeTimeMachineRuntime } from "@ltm/core";
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
  const runtime = new LifeTimeMachineRuntime({ databasePath: join(directory, "api.sqlite") });
  const staticDirectory = join(directory, "public");
  mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>LTM</title><main>ui-shell</main>");
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
    body: JSON.stringify({ query: "record.list", input: { collection: "capability.bootstrapping-life-time-machine-platform" } }),
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
        releaseManifestDigest: "manifest-digest",
        repositoryCommit: "commit-1",
        artifactCommit: "commit-1",
        sbomDigest: "sbom-digest",
        wave: "internal",
        rolloutPercent: 1,
        waveStartedAt: "2026-08-20T00:00:00.000Z",
        releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
        monitoringDomains: ["quality", "payment", "refund", "support", "ledger", "supply", "privacy", "security"],
        approvalIds: ["approval-1", "approval-2"],
        rollbackTested: true,
        automaticPauseEnabled: true,
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
