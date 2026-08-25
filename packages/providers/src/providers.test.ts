import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES,
} from "@ltm/core";
import {
  assertArtifactDigest,
  assertCapabilityEvidenceBinding,
  assertSignedCapabilityEvidence,
  capabilityEvidenceScope,
  ExternalEvidenceAdapterUnavailableError,
  FailClosedExternalEvidenceAdapterPorts,
  FailClosedProviderPorts,
  externalCommandTerminalBusinessEventDraft,
  ProviderUnavailableError,
  SandboxProviderPorts,
  sha256Artifact,
  type ExternalCommandCallbackEvidenceBinding,
  type StoreTransactionEvidenceBinding,
} from "./index.js";

test("all 19 external-command callback evidence tuples bind exact routes, commands, providers, and result digests", () => {
  assert.equal(EXTERNAL_COMMAND_CALLBACK_ROUTES.length, 19);
  for (const route of EXTERNAL_COMMAND_CALLBACK_ROUTES) {
    const provider = route.providerBinding.kind === "exact"
      ? route.providerBinding.provider
      : route.providerBinding.kind === "record-field"
        ? `${route.providerBinding.prefix}provider-1`
        : `${route.providerBinding.allowedTypes[0]}:provider-1`;
    const artifactSha256 = sha256Artifact(Buffer.from(`${route.batchId}:signed-native-result`));
    const binding = {
      tenantId: "tenant-1",
      batchId: route.batchId,
      operation: route.operation,
      kind: route.evidenceKind,
      provider,
      artifactSha256,
      environment: "sandbox",
      subjectId: `${route.batchId.toLowerCase()}-command-1`,
    } as ExternalCommandCallbackEvidenceBinding;
    assert.doesNotThrow(() => assertCapabilityEvidenceBinding(binding), route.batchId);
    const scope = capabilityEvidenceScope(binding);
    assert.notEqual(scope, capabilityEvidenceScope({ ...binding, subjectId: `${binding.subjectId}-other` }), route.batchId);
    assert.notEqual(scope, capabilityEvidenceScope({ ...binding, artifactSha256: "f".repeat(64) }), route.batchId);

    const draft = externalCommandTerminalBusinessEventDraft(binding, {
      eventId: `${route.batchId.toLowerCase()}-event-1`,
      terminalState: "succeeded",
      providerOccurredAt: "2026-08-20T00:00:00.000Z",
      sequence: 1,
      providerOperationId: `${route.batchId.toLowerCase()}-provider-operation-1`,
      requiredClaims: Object.fromEntries(
        (route.requiredClaimIdentifiers ?? []).map((field) => [field, `${field}-1`]),
      ),
    });
    assert.equal(draft.subjectType, route.subjectType, route.batchId);
    assert.equal(draft.subjectId, binding.subjectId, route.batchId);
    assert.equal(draft.correlationId, binding.subjectId, route.batchId);
    assert.equal(draft.eventType, EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES.succeeded, route.batchId);
    assert.deepEqual(
      Object.keys(draft.canonicalClaims),
      ["providerOperationId", ...(route.requiredClaimIdentifiers ?? [])],
      route.batchId,
    );
    assert.equal("tenantId" in draft, false, route.batchId);
    assert.equal("collection" in draft, false, route.batchId);
    assert.equal("patch" in draft, false, route.batchId);

    assert.throws(() => assertCapabilityEvidenceBinding({
      ...binding,
      operation: `${route.operation}Other`,
    } as unknown as ExternalCommandCallbackEvidenceBinding), /not a permitted tuple/, route.batchId);
    assert.throws(() => assertCapabilityEvidenceBinding({
      ...binding,
      kind: `${route.evidenceKind}-other`,
    } as unknown as ExternalCommandCallbackEvidenceBinding), /not a permitted tuple/, route.batchId);
    assert.throws(() => assertCapabilityEvidenceBinding({
      ...binding,
      provider: "attacker-provider",
    } as unknown as ExternalCommandCallbackEvidenceBinding), /not a permitted tuple/, route.batchId);
  }
});

test("unconfigured providers fail closed", async () => {
  const providers = new FailClosedProviderPorts();
  await assert.rejects(
    providers.authorizePayment({
      requestId: "req-1", tenantId: "tenant-1", idempotencyKey: "idem-1", region: "CN",
      consentReceiptIds: ["consent-1"], synthetic: true, paymentToken: "tok_synthetic_ok", amountMinor: 100, currency: "CNY",
    }),
    ProviderUnavailableError,
  );
});

test("sandbox is deterministic and refuses real data", async () => {
  const providers = new SandboxProviderPorts("test");
  const request = {
    requestId: "req-1", tenantId: "tenant-1", idempotencyKey: "idem-1", region: "CN",
    consentReceiptIds: ["consent-1"], synthetic: true, sourceAssetId: "asset-1",
    targetAges: [0, 25, 100], promptPolicyVersion: "1", seed: "seed-1",
  } as const;
  assert.deepEqual(await providers.generateMedia(request), await providers.generateMedia(request));
  await assert.rejects(providers.generateMedia({ ...request, synthetic: false }), /non-synthetic/);
  assert.throws(() => new SandboxProviderPorts("production"), /cannot run in production/);
});

test("webhook verification uses an exact HMAC", () => {
  const providers = new SandboxProviderPorts("local");
  const secret = "synthetic-secret-value";
  const payload = Buffer.from("event-body");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(providers.verifyWebhook(payload, signature, secret), true);
  assert.equal(providers.verifyWebhook(Buffer.from("changed"), signature, secret), false);
});

test("typed evidence scope binds tenant, operation, provider, artifact, environment, and subject", () => {
  const artifact = Buffer.from("synthetic app-store sandbox response");
  const binding: StoreTransactionEvidenceBinding = {
    tenantId: "tenant-1",
    batchId: "B66",
    operation: "verifyStoreTransaction",
    kind: "store-transaction",
    provider: "apple-app-store",
    artifactSha256: sha256Artifact(artifact),
    environment: "sandbox",
    subjectId: "transaction-1",
  };
  const scope = capabilityEvidenceScope(binding);
  assert.match(scope, /^ltm-evidence:v1:[a-f0-9]{64}$/);
  assert.notEqual(scope, capabilityEvidenceScope({ ...binding, tenantId: "tenant-2" }));
  assert.notEqual(scope, capabilityEvidenceScope({ ...binding, provider: "google-play" }));
  assert.notEqual(scope, capabilityEvidenceScope({ ...binding, subjectId: "transaction-2" }));
  assertArtifactDigest(artifact, binding.artifactSha256);
  assert.throws(() => assertArtifactDigest(Buffer.from("changed"), binding.artifactSha256), /does not match/);
});

test("test evidence is explicit and cannot be promoted to production", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const binding: StoreTransactionEvidenceBinding = {
    tenantId: "tenant-1",
    batchId: "B66",
    operation: "verifyStoreTransaction",
    kind: "store-transaction",
    provider: "apple-app-store",
    artifactSha256: "a".repeat(64),
    environment: "sandbox",
    subjectId: "transaction-1",
  };
  const evidence = {
    version: "ltm.external-evidence.v1" as const,
    evidenceId: "evidence-1",
    tenantId: binding.tenantId,
    binding,
    scope: capabilityEvidenceScope(binding),
    issuer: "test:ltm-fixture",
    provider: binding.provider,
    artifactSha256: binding.artifactSha256,
    issuedAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-08-21T00:00:00.000Z",
    nonce: "nonce-1",
    replayPolicy: "single_use" as const,
    algorithm: "Ed25519" as const,
    keyId: "test-key-1",
    signature: "test-signature-not-a-provider-receipt",
  };
  assert.doesNotThrow(() => assertSignedCapabilityEvidence(evidence, now));
  assert.throws(
    () => assertSignedCapabilityEvidence({ ...evidence, binding: { ...binding, environment: "production" } }, now),
    /scope does not match/,
  );
  const productionBinding = { ...binding, environment: "production" } as const;
  assert.throws(
    () => assertSignedCapabilityEvidence({ ...evidence, binding: productionBinding, scope: capabilityEvidenceScope(productionBinding) }, now),
    /production evidence cannot use a test issuer/,
  );
});

test("unconfigured typed external adapters fail closed without fabricating receipts", async () => {
  const adapters = new FailClosedExternalEvidenceAdapterPorts();
  const binding: StoreTransactionEvidenceBinding = {
    tenantId: "tenant-1",
    batchId: "B66",
    operation: "verifyStoreTransaction",
    kind: "store-transaction",
    provider: "apple-app-store",
    artifactSha256: "a".repeat(64),
    environment: "sandbox",
    subjectId: "transaction-1",
  };
  await assert.rejects(
    adapters.verifyStoreTransaction({
      binding,
      artifact: Buffer.from("synthetic fixture"),
      providerSignature: { scheme: "apple-jws", bytes: Buffer.from("synthetic signature") },
      credentialReference: "vault:test-app-store-key",
      receivedAt: "2026-08-20T00:00:00.000Z",
    }),
    ExternalEvidenceAdapterUnavailableError,
  );
});
