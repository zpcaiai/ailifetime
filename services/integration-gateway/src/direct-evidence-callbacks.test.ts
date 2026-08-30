import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  decisionRequestSha256,
  DomainError,
  LifeTimeMachineRuntime,
} from "@ltm/core";
import { createCapabilityRegistry } from "@ltm/capabilities";
import {
  Ed25519EvidenceAttestor,
  ProductionIntegrationError,
  sha256,
  toRuntimeExternalEvidence,
  type EvidenceArtifactStore,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import {
  DIRECT_EVIDENCE_CALLBACK_ROUTES,
  createDirectEvidenceCallbackHandlers,
  directEvidenceCallbackPath,
  parseDirectEvidenceAuthorityDocument,
} from "./direct-evidence-callbacks.js";

const NOW = new Date();
const WEBHOOK_REFERENCE: SecretReference = "secret-manager:ltm/test/direct-evidence-webhook";
const ATTESTOR_REFERENCE: SecretReference = "secret-manager:ltm/test/direct-evidence-attestor";
const WEBHOOK_KEY = Buffer.from("direct-evidence-webhook-key-at-least-32-bytes");

class MemorySecrets implements SecretResolver {
  constructor(private readonly values: ReadonlyMap<SecretReference, Uint8Array>) {}
  async resolve(reference: SecretReference): Promise<Uint8Array> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error(`missing test secret ${reference}`);
    return Buffer.from(value);
  }
}

class MemoryReplays implements ReplayStore {
  readonly values = new Set<string>();
  async claimOnce(namespace: string, value: string): Promise<boolean> {
    const key = `${namespace}:${value}`;
    if (this.values.has(key)) return false;
    this.values.add(key);
    return true;
  }
}

class MemoryArtifacts implements EvidenceArtifactStore {
  readonly values: Array<{ readonly provider: string; readonly subjectId: string; readonly sha256: string }> = [];
  async put(input: Parameters<EvidenceArtifactStore["put"]>[0]) {
    this.values.push({ provider: input.provider, subjectId: input.subjectId, sha256: input.sha256 });
    return { uri: `memory://direct-evidence/${input.sha256}`, sha256: input.sha256 };
  }
}

function authorityDocument() {
  return {
    version: "ltm.direct-evidence-authorities.v1",
    authorities: DIRECT_EVIDENCE_CALLBACK_ROUTES.map((route) => ({
      routeId: route.routeId,
      provider: route.providerRule.exact?.[0] ?? `${route.providerRule.prefixes?.[0]}authority-1`,
      signatureScheme: "hmac-sha256",
      verificationKeyReference: WEBHOOK_REFERENCE,
      maximumClockSkewSeconds: 300,
      maximumBodyBytes: 64 * 1_024,
      retentionClass: ["B91", "B92", "B94"].includes(route.batchId) ? "financial" : "release",
    })),
  };
}

function signedHeaders(body: Uint8Array, nonce: string): Readonly<Record<string, string>> {
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  return {
    "x-ltm-timestamp": timestamp,
    "x-ltm-nonce": nonce,
    "x-ltm-signature": createHmac("sha256", WEBHOOK_KEY)
      .update(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${sha256(body)}\n`)
      .digest("base64"),
  };
}

function harness() {
  const keyPair = generateKeyPairSync("ed25519");
  const secrets = new MemorySecrets(new Map([
    [WEBHOOK_REFERENCE, WEBHOOK_KEY],
    [ATTESTOR_REFERENCE, Buffer.from(keyPair.privateKey.export({ type: "pkcs8", format: "pem" }))],
  ]));
  const replays = new MemoryReplays();
  const artifacts = new MemoryArtifacts();
  const authorities = parseDirectEvidenceAuthorityDocument(authorityDocument(), {
    tenantId: "tenant-direct-evidence-1",
    evidenceEnvironment: "sandbox",
  });
  return {
    keyPair,
    authorities,
    replays,
    artifacts,
    handlers: createDirectEvidenceCallbackHandlers(authorities, {
      secrets,
      replays,
      artifacts,
      attestor: new Ed25519EvidenceAttestor({
        issuer: "sandbox:direct-evidence-gateway",
        keyId: "direct-evidence-attestor-key-1",
        privateKeyReference: ATTESTOR_REFERENCE,
        clock: () => NOW,
      }, secrets),
      clock: () => NOW,
    }),
  };
}

test("managed direct evidence policy closes all 30 non-B127 direct gate routes", () => {
  assert.equal(DIRECT_EVIDENCE_CALLBACK_ROUTES.length, 30);
  assert.equal(new Set(DIRECT_EVIDENCE_CALLBACK_ROUTES.map((route) => route.routeId)).size, 30);
  assert.equal(DIRECT_EVIDENCE_CALLBACK_ROUTES.some((route) => route.batchId === "B127"), false);
  const document = authorityDocument();
  const loaded = parseDirectEvidenceAuthorityDocument(document, {
    tenantId: "tenant-direct-evidence-1",
    evidenceEnvironment: "sandbox",
  });
  assert.equal(loaded.length, 30);
  assert.equal(new Set(loaded.map((authority) => authority.route.routeId)).size, 30);

  assert.throws(() => parseDirectEvidenceAuthorityDocument({
    ...document,
    authorities: document.authorities.slice(0, 29),
  }, { tenantId: "tenant-direct-evidence-1", evidenceEnvironment: "sandbox" }), /30 to 128 authorities/);

  assert.throws(() => parseDirectEvidenceAuthorityDocument({
    ...document,
    authorities: [...document.authorities, document.authorities[0]],
  }, { tenantId: "tenant-direct-evidence-1", evidenceEnvironment: "sandbox" }), /duplicated/);

  assert.throws(() => parseDirectEvidenceAuthorityDocument({
    ...document,
    authorities: document.authorities.map((authority) => authority.routeId === "b69-store-release"
      ? { ...authority, provider: "apple-app-store-untrusted" }
      : authority),
  }, { tenantId: "tenant-direct-evidence-1", evidenceEnvironment: "sandbox" }), /not allowed/);

  assert.throws(() => parseDirectEvidenceAuthorityDocument({
    ...document,
    authorities: document.authorities.map((authority, index) => index === 0
      ? { ...authority, routeId: "b127-production-launch" }
      : authority),
  }, { tenantId: "tenant-direct-evidence-1", evidenceEnvironment: "sandbox" }), /unknown direct evidence route/);
});

test("direct callback evidence registers and is consumed once by its exact request-bound B91 capability", async (t) => {
  const { handlers, keyPair } = harness();
  const route = DIRECT_EVIDENCE_CALLBACK_ROUTES.find((candidate) => candidate.batchId === "B91");
  assert.ok(route);
  const handler = handlers.get(directEvidenceCallbackPath(route));
  assert.ok(handler);
  const registry = createCapabilityRegistry();
  const definition = registry.get("B91");
  assert.ok(definition);
  const actor = {
    actorId: "finance-operator-1",
    tenantId: "tenant-direct-evidence-1",
    roles: ["platform_admin", "finance_operator"] as const,
    purpose: "payment_dispute_resolution",
    requestId: "request-b91-e2e",
    operationId: "operation-b91-e2e",
    stepUp: true,
  };
  const input = {
    disputeId: "dispute-e2e-1",
    providerCaseId: "provider-case-e2e-1",
    providerId: "authority-1",
    providerEnvironment: "sandbox",
    disputeArtifactSha256: "0".repeat(64),
    action: "accept",
    amountMinor: 2500,
    currency: "CNY",
    responseDueAt: "2099-12-31T23:59:59.000Z",
    evidenceIds: ["provider-case-e2e-1"],
    reserveEntryId: "reserve-e2e-1",
    externalEvidenceIds: ["pending-evidence-id"],
  };
  const parsed = definition.parseInput({ actor, idempotencyKey: "parse-b91-e2e", input });
  const {
    evidenceScope: _scope,
    externalEvidenceIds: _ids,
    disputeArtifactSha256: _artifact,
    decisionRequestSha256: requestSha256,
    ...decisionRequest
  } = parsed;
  assert.equal(typeof requestSha256, "string");
  const payload = {
    version: "ltm.direct-evidence-callback.v1",
    routeId: route.routeId,
    provider: "payment:authority-1",
    evidenceEventId: "payment-decision-e2e-1",
    subjectId: input.disputeId,
    providerOccurredAt: NOW.toISOString(),
    decision: "approved",
    decisionReference: input.providerCaseId,
    claims: { nativeCaseId: input.providerCaseId, amountMinor: input.amountMinor, currency: input.currency },
    decisionRequest,
    decisionRequestSha256: requestSha256,
  };
  const rawBody = Buffer.from(canonicalJson(payload));
  const callback = await handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "direct-evidence-b91-e2e-nonce"),
    requestId: "direct-evidence-b91-e2e-callback",
  });
  assert.equal(callback.disposition, "evidence");
  if (callback.disposition !== "evidence") assert.fail("expected request-bound evidence");
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    trustedEvidenceKeys: [{
      issuer: callback.evidence.issuer,
      provider: callback.evidence.provider,
      keyId: callback.evidence.keyId,
      algorithm: "Ed25519",
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: [callback.evidence.scope],
      allowedEnvironments: ["sandbox"],
    }],
  });
  t.after(() => runtime.close());
  runtime.registerExternalEvidence(actor, {
    evidence: toRuntimeExternalEvidence(callback.evidence),
    idempotencyKey: "register-b91-e2e",
  });
  const boundInput = {
    ...input,
    disputeArtifactSha256: callback.evidence.artifactSha256,
    externalEvidenceIds: [callback.evidence.evidenceId],
  };
  await registry.execute(runtime, "B91", {
    actor,
    idempotencyKey: "execute-b91-e2e",
    input: boundInput,
  });
  assert.notEqual(runtime.getExternalEvidence(actor, callback.evidence.evidenceId).consumedAt, null);
  await assert.rejects(registry.execute(runtime, "B91", {
    actor: {
      ...actor,
      requestId: "request-b91-e2e-replay",
      operationId: "operation-b91-e2e-replay",
    },
    idempotencyKey: "execute-b91-e2e-replay",
    input: boundInput,
  }), (error: unknown) => error instanceof DomainError && error.code === "EVIDENCE_REPLAY_DETECTED");
});

test("direct decision callback registers exact signed evidence and rejects caller control fields, route confusion, and replay", async () => {
  const { handlers, artifacts } = harness();
  const route = DIRECT_EVIDENCE_CALLBACK_ROUTES.find((candidate) => candidate.routeId === "b91-payment-dispute");
  assert.ok(route);
  const handler = handlers.get(directEvidenceCallbackPath(route));
  assert.ok(handler);
  const payload = {
    version: "ltm.direct-evidence-callback.v1",
    routeId: "b91-payment-dispute",
    provider: "payment:authority-1",
    evidenceEventId: "payment-dispute-decision-event-1",
    subjectId: "payment-dispute-1",
    providerOccurredAt: NOW.toISOString(),
    decision: "approved",
    decisionReference: "processor-case-1",
    claims: {
      nativeCaseId: "processor-case-1",
      dispositionCode: "merchant_prevailed",
      amountMinor: 2500,
      currency: "CNY",
    },
    decisionRequest: {
      disputeId: "payment-dispute-1",
      providerCaseId: "processor-case-1",
      action: "defend",
      amountMinor: 2500,
      currency: "CNY",
    },
    decisionRequestSha256: "",
  };
  payload.decisionRequestSha256 = decisionRequestSha256("B91", "recordDisputeDecision", payload.decisionRequest);
  const rawBody = Buffer.from(canonicalJson(payload));
  const result = await handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "direct-evidence-decision-nonce-1"),
    requestId: "direct-evidence-request-1",
  });
  assert.equal(result.disposition, "evidence");
  if (result.disposition !== "evidence") assert.fail("expected direct evidence result");
  assert.equal(result.providerEventId, payload.evidenceEventId);
  assert.equal(result.evidence.binding.batchId, "B91");
  assert.equal(result.evidence.binding.operation, "recordDisputeDecision");
  assert.equal(result.evidence.binding.subjectId, payload.subjectId);
  assert.equal(result.evidence.binding.provider, payload.provider);
  assert.equal(result.evidence.binding.requestSha256, payload.decisionRequestSha256);
  assert.equal(result.evidence.canonicalClaimsSha256, undefined);
  assert.equal(result.evidence.businessEventSha256, undefined);
  assert.deepEqual(artifacts.values, [{
    provider: payload.provider,
    subjectId: payload.subjectId,
    sha256: sha256(rawBody),
  }]);

  await assert.rejects(handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "direct-evidence-decision-nonce-1"),
    requestId: "direct-evidence-request-replay",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED");

  const forbidden = Buffer.from(canonicalJson({ ...payload, claims: { ...payload.claims, approved: true } }));
  await assert.rejects(handler.process({
    rawBody: forbidden,
    headers: signedHeaders(forbidden, "direct-evidence-forbidden-claim-nonce"),
    requestId: "direct-evidence-request-forbidden-claim",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");

  const wrongDecision = Buffer.from(canonicalJson({ ...payload, decision: "passed" }));
  await assert.rejects(handler.process({
    rawBody: wrongDecision,
    headers: signedHeaders(wrongDecision, "direct-evidence-wrong-decision-nonce"),
    requestId: "direct-evidence-request-wrong-decision",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");

  const otherRoute = DIRECT_EVIDENCE_CALLBACK_ROUTES.find((candidate) => candidate.routeId === "b92-partner-payout");
  assert.ok(otherRoute);
  const otherHandler = handlers.get(directEvidenceCallbackPath(otherRoute));
  assert.ok(otherHandler);
  await assert.rejects(otherHandler.process({
    rawBody,
    headers: signedHeaders(rawBody, "direct-evidence-route-confusion-nonce"),
    requestId: "direct-evidence-request-route-confusion",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");

  const changedRequest = Buffer.from(canonicalJson({
    ...payload,
    decisionRequest: { ...payload.decisionRequest, action: "write_off" },
  }));
  await assert.rejects(handler.process({
    rawBody: changedRequest,
    headers: signedHeaders(changedRequest, "direct-evidence-changed-request-nonce"),
    requestId: "direct-evidence-request-changed-request",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");

  const invalidLeapDate = Buffer.from(canonicalJson({ ...payload, providerOccurredAt: "2025-02-29T00:00:00Z" }));
  await assert.rejects(handler.process({
    rawBody: invalidLeapDate,
    headers: signedHeaders(invalidLeapDate, "direct-evidence-invalid-date-nonce"),
    requestId: "direct-evidence-request-invalid-date",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");
});

test("operational callback validates the closed report schema before attesting it", async () => {
  const { handlers } = harness();
  const route = DIRECT_EVIDENCE_CALLBACK_ROUTES.find((candidate) => candidate.routeId === "b121-capacity-gate");
  assert.ok(route);
  const handler = handlers.get(directEvidenceCallbackPath(route));
  assert.ok(handler);
  const report = {
    version: "ltm.capacity-test-report.v1",
    testRunId: "capacity-run-1",
    scenarios: ["baseline", "peak", "burst", "soak", "dependency_degraded"],
    observedP95Ms: 250,
    maxP95Ms: 500,
    observedErrorRate: 0.001,
    maxErrorRate: 0.01,
    syntheticDataOnly: true,
    paidTasksProtected: true,
    tenantFairnessVerified: true,
    violations: [],
    passed: true,
  };
  const payload = {
    version: "ltm.direct-evidence-callback.v1",
    routeId: "b121-capacity-gate",
    provider: "load-test:authority-1",
    evidenceEventId: "capacity-evidence-event-1",
    report,
    decisionRequest: {
      testRunId: "capacity-run-1",
      scenarios: ["baseline", "peak", "burst", "soak", "dependency_degraded"],
      maxP95Ms: 500,
      maxErrorRate: 0.01,
      reportSchemaVersion: "ltm.capacity-test-report.v1",
    },
    decisionRequestSha256: "",
  };
  payload.decisionRequestSha256 = decisionRequestSha256("B121", "approveCapacityGate", payload.decisionRequest);
  const rawBody = Buffer.from(canonicalJson(payload));
  const result = await handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "direct-evidence-capacity-nonce-1"),
    requestId: "direct-evidence-capacity-request-1",
  });
  assert.equal(result.disposition, "evidence");
  if (result.disposition !== "evidence") assert.fail("expected direct evidence result");
  assert.equal(result.evidence.binding.batchId, "B121");
  assert.equal(result.evidence.binding.subjectId, report.testRunId);

  const failed = Buffer.from(canonicalJson({
    ...payload,
    report: { ...report, observedP95Ms: 900 },
  }));
  await assert.rejects(handler.process({
    rawBody: failed,
    headers: signedHeaders(failed, "direct-evidence-capacity-failed-nonce"),
    requestId: "direct-evidence-capacity-failed-request",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");

  const looserThreshold = Buffer.from(canonicalJson({
    ...payload,
    report: { ...report, maxP95Ms: 900 },
  }));
  await assert.rejects(handler.process({
    rawBody: looserThreshold,
    headers: signedHeaders(looserThreshold, "direct-evidence-capacity-threshold-nonce"),
    requestId: "direct-evidence-capacity-threshold-request",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");
});
