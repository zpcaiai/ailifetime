import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { canonicalJson, EXTERNAL_COMMAND_CALLBACK_ROUTES } from "@ltm/core";
import {
  Ed25519EvidenceAttestor,
  ProductionIntegrationError,
  sha256,
  type CallbackDeliveryLease,
  type CallbackDeliveryStateStore,
  type EvidenceArtifactStore,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import { createIntegrationGatewayServer } from "./gateway.js";
import {
  createExternalCommandPartnerCallbackHandler,
  parseExternalCommandPartnerPolicyDocument,
  partnerCallbackPath,
} from "./partner-callbacks.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const WEBHOOK_REFERENCE: SecretReference = "secret-manager:ltm/test/partner-webhook";
const ATTESTOR_REFERENCE: SecretReference = "vault:test-partner-attestor";
const WEBHOOK_KEY = Buffer.from("gateway-partner-webhook-key-at-least-32-bytes");

class MemorySecrets implements SecretResolver {
  constructor(private readonly values: ReadonlyMap<SecretReference, Uint8Array>) {}
  async resolve(reference: SecretReference): Promise<Uint8Array> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error(`missing test secret ${reference}`);
    return Buffer.from(value);
  }
}

class MemoryArtifacts implements EvidenceArtifactStore {
  readonly stored: string[] = [];
  async put(input: Parameters<EvidenceArtifactStore["put"]>[0]) {
    assert.equal(input.sha256, sha256(input.artifact));
    this.stored.push(input.sha256);
    return { uri: `memory://partner/${input.sha256}`, sha256: input.sha256 };
  }
}

class MemoryReplays implements ReplayStore {
  readonly values = new Set<string>();
  async claimOnce(namespace: string, value: string, _expiresAt: Date): Promise<boolean> {
    const key = `${namespace}:${value}`;
    if (this.values.has(key)) return false;
    this.values.add(key);
    return true;
  }
}

class MemoryCallbackState implements CallbackDeliveryStateStore {
  readonly values = new Map<string, { state: "processing" | "delivering" | "ready" | "completed"; leaseId: string; payload?: Buffer }>();
  nextLease = 0;
  async begin(namespace: string, fingerprint: string) {
    const key = `${namespace}:${fingerprint}`;
    const current = this.values.get(key);
    if (current?.state === "completed") return { state: "completed" as const };
    if (current?.state === "processing" || current?.state === "delivering") return { state: "busy" as const };
    const leaseId = `00000000-0000-0000-0000-${String(++this.nextLease).padStart(12, "0")}`;
    const lease = { key, leaseId };
    if (current?.state === "ready" && current.payload !== undefined) {
      this.values.set(key, { state: "delivering", leaseId, payload: current.payload });
      return { state: "deliver" as const, lease, payload: current.payload };
    }
    this.values.set(key, { state: "processing", leaseId });
    return { state: "process" as const, lease };
  }
  async stageForDelivery(lease: CallbackDeliveryLease, payload: Uint8Array) {
    this.values.set(lease.key, { state: "delivering", leaseId: lease.leaseId, payload: Buffer.from(payload) });
  }
  async releaseForRetry(lease: CallbackDeliveryLease, payload: Uint8Array) {
    this.values.set(lease.key, { state: "ready", leaseId: lease.leaseId, payload: Buffer.from(payload) });
  }
  async complete(lease: CallbackDeliveryLease) {
    this.values.set(lease.key, { state: "completed", leaseId: lease.leaseId });
  }
  async abandon(lease: CallbackDeliveryLease) { this.values.delete(lease.key); }
  isReady() { return true; }
  async close() {}
}

function providerFor(definition: (typeof EXTERNAL_COMMAND_CALLBACK_ROUTES)[number]): string {
  const binding = definition.providerBinding;
  if (binding.kind === "exact") return binding.provider;
  if (binding.kind === "record-field") return `${binding.prefix}production-authority`;
  return `${binding.allowedTypes[0]}:production-authority`;
}

function policyDocument() {
  return {
    version: "ltm.partner-webhook-policies.v2",
    routes: EXTERNAL_COMMAND_CALLBACK_ROUTES.map((definition) => ({
      routeId: definition.routeId,
      batchId: definition.batchId,
      operation: definition.operation,
      evidenceKind: definition.evidenceKind,
      provider: providerFor(definition),
      signatureScheme: "hmac-sha256",
      verificationKeyReference: WEBHOOK_REFERENCE,
      maximumClockSkewSeconds: 300,
      maximumBodyBytes: 1_048_576,
      retentionClass: "operational",
      commandIdField: "command.id",
      eventIdField: "event.id",
      terminalStateField: "result.state",
      providerOccurredAtField: "event.occurredAt",
      sequenceField: "event.sequence",
      providerOperationIdField: "result.operationId",
      requiredClaimFields: Object.fromEntries(
        (definition.requiredClaimIdentifiers ?? []).map((field) => [field, `result.claims.${field}`]),
      ),
      terminalStateMap: {
        completed: "succeeded",
        error: "failed",
        voided: "cancelled",
        reversed: "compensated",
      },
    })),
  };
}

function parsePolicies(document: unknown = policyDocument()) {
  return parseExternalCommandPartnerPolicyDocument(document, {
    tenantId: "tenant-1",
    evidenceEnvironment: "sandbox",
  });
}

function callbackPayload(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    command: { id: "command-1" },
    event: { id: "event-1", occurredAt: NOW.toISOString(), sequence: 1 },
    result: { state: "completed", operationId: "provider-operation-1" },
    ...overrides,
  };
}

function signedRequest(rawBody: Uint8Array, nonce: string) {
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const signature = createHmac("sha256", WEBHOOK_KEY)
    .update(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${digest}\n`)
    .digest("base64");
  return {
    rawBody,
    headers: {
      "x-ltm-timestamp": timestamp,
      "x-ltm-nonce": nonce,
      "x-ltm-signature": signature,
    },
    requestId: `request-${nonce}`,
  };
}

function testDependencies() {
  const pair = generateKeyPairSync("ed25519");
  const secrets = new MemorySecrets(new Map([
    [WEBHOOK_REFERENCE, WEBHOOK_KEY],
    [ATTESTOR_REFERENCE, Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }))],
  ]));
  return {
    secrets,
    replays: new MemoryReplays(),
    artifacts: new MemoryArtifacts(),
    attestor: new Ed25519EvidenceAttestor({
      issuer: "test:integration-gateway",
      keyId: "test-partner-key",
      privateKeyReference: ATTESTOR_REFERENCE,
      replayPolicy: "single_use",
      clock: () => NOW,
    }, secrets),
    clock: () => NOW,
  };
}

test("managed partner policy is a closed 19-route mirror of the core command inventory", () => {
  const policies = parsePolicies();
  assert.equal(policies.length, 19);
  assert.deepEqual(
    policies.map((policy) => [policy.routeId, policy.routeDefinition.batchId, policy.routeDefinition.operation]),
    EXTERNAL_COMMAND_CALLBACK_ROUTES.map((definition) => [definition.routeId, definition.batchId, definition.operation]),
  );
  assert.deepEqual(
    policies.map(partnerCallbackPath),
    EXTERNAL_COMMAND_CALLBACK_ROUTES.map((definition) => `/v1/callbacks/partners/${definition.routeId}`),
  );
});

test("managed partner policy fails closed on missing, duplicate, extra, tuple, and provider mutations", () => {
  const missing = policyDocument();
  missing.routes.pop();
  assert.throws(() => parsePolicies(missing), /exactly 19 routes/);

  const duplicate = policyDocument();
  duplicate.routes[17] = { ...duplicate.routes[0]! };
  assert.throws(() => parsePolicies(duplicate), /duplicated/);

  const extra = policyDocument();
  extra.routes[0] = { ...extra.routes[0]!, collection: "attacker.collection" } as typeof extra.routes[number];
  assert.throws(() => parsePolicies(extra), /missing or unsupported fields/);

  const tuple = policyDocument();
  tuple.routes[0] = { ...tuple.routes[0]!, evidenceKind: "attacker-kind" as never };
  assert.throws(() => parsePolicies(tuple), /core batch\/operation\/evidenceKind/);

  const provider = policyDocument();
  provider.routes[0] = { ...provider.routes[0]!, provider: "attacker-provider" };
  assert.throws(() => parsePolicies(provider), /core authority binding/);
});

test("terminal callback rejects provider/subject/terminal tampering and native replay", async () => {
  const policy = parsePolicies()[0]!;
  const dependencies = testDependencies();
  const handler = createExternalCommandPartnerCallbackHandler(policy, dependencies);
  const validBody = Buffer.from(canonicalJson(callbackPayload()));
  const valid = signedRequest(validBody, "nonce-valid-1");

  const tamperedSubject = Buffer.from(canonicalJson(callbackPayload({ command: { id: "command-attacker" } })));
  await assert.rejects(
    handler.process({ ...valid, rawBody: tamperedSubject }),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_SIGNATURE_INVALID",
  );

  const providerBody = Buffer.from(canonicalJson(callbackPayload({ provider: "attacker-provider" })));
  await assert.rejects(
    handler.process(signedRequest(providerBody, "nonce-provider-1")),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID",
  );

  const booleanTerminalBody = Buffer.from(canonicalJson(callbackPayload({ result: { state: true, operationId: "provider-operation-1" } })));
  await assert.rejects(
    handler.process(signedRequest(booleanTerminalBody, "nonce-terminal-1")),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID",
  );

  const result = await handler.process(valid);
  assert.equal(result.disposition, "attested");
  if (result.disposition !== "attested") assert.fail("expected attested callback");
  assert.equal(result.businessEvent.subjectId, "command-1");
  assert.equal(result.businessEvent.correlationId, "command-1");
  assert.equal(result.businessEvent.eventType, "external-command.succeeded");
  assert.equal(result.businessEvent.provider, policy.binding.provider);
  assert.deepEqual(result.businessEvent.canonicalClaims, { providerOperationId: "provider-operation-1" });
  await assert.rejects(
    handler.process(valid),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED",
  );
});

test("B10 revoke callback binds the exact original provider share operation", async () => {
  const policy = parsePolicies().find((candidate) => candidate.routeId === "b10-export-revoke");
  assert.ok(policy);
  const handler = createExternalCommandPartnerCallbackHandler(policy, testDependencies());
  const missingTarget = Buffer.from(canonicalJson(callbackPayload()));
  await assert.rejects(
    handler.process(signedRequest(missingTarget, "nonce-revoke-missing-target")),
    (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
  const validBody = Buffer.from(canonicalJson(callbackPayload({
    result: {
      state: "completed",
      operationId: "provider-revoke-operation-1",
      claims: { targetProviderOperationId: "provider-share-grant-1" },
    },
  })));
  const result = await handler.process(signedRequest(validBody, "nonce-revoke-valid-target"));
  assert.equal(result.disposition, "attested");
  if (result.disposition !== "attested") assert.fail("expected attested callback");
  assert.deepEqual(result.businessEvent.canonicalClaims, {
    providerOperationId: "provider-revoke-operation-1",
    targetProviderOperationId: "provider-share-grant-1",
  });
});

test("fixed partner HTTP route verifies, attests, persists evidence, and publishes once", async (t) => {
  const policy = parsePolicies()[15]!;
  const dependencies = testDependencies();
  const handler = createExternalCommandPartnerCallbackHandler(policy, dependencies);
  const published: Array<Parameters<NonNullable<Parameters<typeof createIntegrationGatewayServer>[0]["evidenceOutput"]["publish"]>>[0]> = [];
  const server = createIntegrationGatewayServer({
    tenantId: "tenant-1",
    routes: new Map([[partnerCallbackPath(policy), handler]]),
    evidenceOutput: { async publish(input) { published.push(input); } },
    callbackState: new MemoryCallbackState(),
    bodyLimitBytes: 1_048_576,
    readiness: async () => ({ ready: true, checks: { callbackState: true } }),
    clock: () => NOW,
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const body = Buffer.from(canonicalJson(callbackPayload()));
  const signed = signedRequest(body, "nonce-http-1");
  const send = () => fetch(`http://127.0.0.1:${address.port}${partnerCallbackPath(policy)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body,
  });
  assert.equal((await send()).status, 204);
  assert.equal((await send()).status, 204);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.businessEvent?.batchId, policy.routeDefinition.batchId);
  assert.equal(published[0]?.businessEvent?.operation, policy.routeDefinition.operation);
  assert.equal(published[0]?.businessEvent?.subjectId, "command-1");
  assert.equal(published[0]?.businessEvent?.eventType, "external-command.succeeded");
  assert.equal(dependencies.artifacts.stored.length, 1);
});
