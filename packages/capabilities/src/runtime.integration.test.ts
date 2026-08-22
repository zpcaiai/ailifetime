import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test, { type TestContext } from "node:test";
import { DomainError, LifeTimeMachineRuntime, signExternalEvidence, type ActorContext } from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import { createCapabilityRegistry } from "./index.js";
import type { JsonObject, JsonValue } from "./registry.js";

function runtimeFor(testContext: TestContext): LifeTimeMachineRuntime {
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
  return runtime;
}

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorId: "consumer-1",
    tenantId: "tenant-1",
    roles: ["consumer"],
    purpose: "age_transformation",
    requestId: "runtime-integration-test",
    ...overrides,
  };
}

function objectResult(value: JsonValue): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function rejectsDomainCode(promise: Promise<JsonValue>, code: DomainError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

test("B04 grants consent once, replays idempotently, and preserves the audit chain", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const guardian = actor({
    actorId: "guardian-1",
    roles: ["guardian"],
    permissions: ["audit:read"],
    guardianVerified: true,
  });
  const input = {
    participantId: "child-1",
    purpose: "age_transformation",
    policyVersion: "privacy-v1",
    evidenceHash: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "active",
    isMinor: true,
    guardianConsentId: "guardian-verification-1",
  };

  const first = objectResult(
    await registry.execute(runtime, "B04", {
      actor: guardian,
      idempotencyKey: "grant-child-consent",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B04", {
      actor: { ...guardian, requestId: "runtime-integration-replay" },
      idempotencyKey: "grant-child-consent",
      input,
    }),
  );

  assert.equal(first.state, "active");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.consentId, first.consentId);
  assert.equal(runtime.listConsents(guardian, "child-1").length, 1);
  assert.ok(runtime.listAudit(guardian, 100).some((entry) => entry.action === "capability.B04.execute"));
  assert.deepEqual(runtime.verifyAuditChain(guardian), { valid: true, entriesChecked: 4, invalidSequence: null });
});

test("B14 persists an authorized illustrative timeline", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: consumer.purpose,
    scope: { feature: "timeline" },
    policyVersion: "privacy-v1",
    evidenceHash: "b".repeat(64),
    idempotencyKey: "self-consent",
  });

  const result = objectResult(
    await registry.execute(runtime, "B14", {
      actor: consumer,
      idempotencyKey: "timeline-job-1",
      input: {
        jobId: "job-1",
        sourceAssetId: "asset-1",
        participantIds: [consumer.actorId],
        targetAges: [0, 18, 35, 65, 100],
        seed: "seed-1",
        promptPolicyVersion: "prompt-v1",
        illustrativeLabel: true,
      },
    }),
  );

  assert.equal(result.state, "requested");
  assert.equal(result.commandState, "requested");
  assert.equal(result.replayed, false);
  const records = runtime.listRecords(consumer, { collection: "generation.timeline-commands" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.data.jobId, "job-1");
  assert.equal(records[0]?.data.illustrativeLabel, true);
  assert.equal(records[0]?.data.operationMode, "external-command");
});

test("B09 applies stateful generation transitions, replays, and rejects stale state", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: consumer.purpose,
    scope: { feature: "generation_job" },
    policyVersion: "privacy-v1",
    evidenceHash: "c".repeat(64),
    idempotencyKey: "generation-job-consent",
  });
  const transitionInput = {
    jobId: "stateful-job-1",
    participantIds: [consumer.actorId],
    fromState: "queued",
    toState: "preflight",
    requestFingerprint: "fingerprint-1",
    milestones: ["request_accepted"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B09", {
      actor: consumer,
      idempotencyKey: "queued-to-preflight",
      input: transitionInput,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B09", {
      actor: { ...consumer, requestId: "generation-job-replay" },
      idempotencyKey: "queued-to-preflight",
      input: transitionInput,
    }),
  );

  assert.equal(first.state, "preflight");
  assert.equal(first.previousState, "queued");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const aggregate = runtime.getRecord(consumer, "generation.jobs", "stateful-job-1");
  assert.equal(aggregate.data.state, "preflight");
  assert.equal(aggregate.data.transitionCount, 1);

  await rejectsDomainCode(
    registry.execute(runtime, "B09", {
      actor: { ...consumer, requestId: "generation-job-stale" },
      idempotencyKey: "stale-queued-to-preflight",
      input: transitionInput,
    }),
    "VERSION_CONFLICT",
  );
});

test("tenant mismatch is rejected before a capability write", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  await rejectsDomainCode(
    registry.execute(runtime, "B01", {
      actor: actor(),
      idempotencyKey: "cross-tenant-architecture",
      input: {
        tenantId: "tenant-2",
        repositoryId: "repo-1",
        stackProfile: "typescript",
        boundedContexts: ["consumer", "media"],
        healthChecks: ["liveness", "readiness"],
        ownershipRules: ["explicit-owner"],
      },
    }),
    "TENANT_SCOPE_MISMATCH",
  );
});

test("B01 creates one stable architecture resource and rejects identity overwrite", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const platformActor = actor({
    actorId: "platform-1",
    roles: ["platform_admin"],
    purpose: "platform_architecture",
    requestId: "architecture-resource",
  });
  const input = {
    tenantId: platformActor.tenantId,
    repositoryId: "repository-1",
    stackProfile: "typescript-sqlite",
    boundedContexts: ["consumer", "media"],
    healthChecks: ["liveness", "readiness"],
    ownershipRules: ["single-owner-per-context"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B01", {
      actor: platformActor,
      idempotencyKey: "architecture-resource-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B01", {
      actor: { ...platformActor, requestId: "architecture-resource-replay" },
      idempotencyKey: "architecture-resource-1",
      input,
    }),
  );

  assert.equal(first.state, "persisted");
  assert.equal(first.recordId, "repository-1");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const architecture = runtime.getRecord(platformActor, "platform.architectures", "repository-1");
  assert.equal(architecture.data.operationMode, "resource");
  assert.equal(architecture.data.stackProfile, "typescript-sqlite");

  await rejectsDomainCode(
    registry.execute(runtime, "B01", {
      actor: { ...platformActor, requestId: "architecture-resource-conflict" },
      idempotencyKey: "architecture-resource-conflict",
      input: { ...input, stackProfile: "different-stack" },
    }),
    "VERSION_CONFLICT",
  );
});

test("B14 rejects generation when participant consent is missing", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  await rejectsDomainCode(
    registry.execute(runtime, "B14", {
      actor: consumer,
      idempotencyKey: "timeline-without-consent",
      input: {
        jobId: "job-without-consent",
        sourceAssetId: "asset-1",
        participantIds: [consumer.actorId],
        targetAges: [18, 80],
        seed: "seed-1",
        promptPolicyVersion: "prompt-v1",
        illustrativeLabel: true,
      },
    }),
    "CONSENT_REQUIRED",
  );
});

test("B21 rejects a minor workflow without verified guardian context", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  await rejectsDomainCode(
    registry.execute(runtime, "B21", {
      actor: actor(),
      idempotencyKey: "minor-without-guardian",
      input: {
        safeguardId: "safeguard-1",
        participantIds: ["child-1"],
        containsMinor: true,
        requestedFeature: "private_generation",
        ageBand: "child",
        guardianControlsVersion: "guardian-v1",
      },
    }),
    "GUARDIAN_VERIFICATION_REQUIRED",
  );
});

test("B87 rejects an unbalanced journal before persistence", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const financeActor = actor({
    actorId: "finance-1",
    roles: ["finance_operator"],
    permissions: ["ledger:post"],
    purpose: "financial_reporting",
    stepUp: true,
  });
  await rejectsDomainCode(
    registry.execute(runtime, "B87", {
      actor: financeActor,
      idempotencyKey: "unbalanced-journal",
      input: {
        journalId: "journal-1",
        legalEntityId: "entity-1",
        sourceType: "order",
        sourceId: "order-1",
        currency: "USD",
        period: "2026-08",
        periodState: "open",
        lines: [
          { accountCode: "cash", direction: "debit", amountMinor: 100, currency: "USD" },
          { accountCode: "revenue", direction: "credit", amountMinor: 90, currency: "USD" },
        ],
      },
    }),
    "LEDGER_UNBALANCED",
  );
  assert.throws(
    () => runtime.getLedgerTransaction(financeActor, "journal-1"),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("B87 posts a balanced immutable ledger transaction and replays idempotently", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const financeActor = actor({
    actorId: "finance-1",
    roles: ["finance_operator"],
    permissions: ["ledger:post", "ledger:read", "audit:read", "outbox:read"],
    purpose: "financial_reporting",
    stepUp: true,
  });
  const input = {
    journalId: "journal-balanced-1",
    legalEntityId: "entity-1",
    sourceType: "order",
    sourceId: "order-balanced-1",
    currency: "USD",
    period: "2026-08",
    periodState: "open",
    lines: [
      { accountCode: "cash", direction: "debit", amountMinor: 125, currency: "USD" },
      { accountCode: "revenue", direction: "credit", amountMinor: 125, currency: "USD" },
    ],
  };

  const first = objectResult(
    await registry.execute(runtime, "B87", {
      actor: financeActor,
      idempotencyKey: "balanced-journal",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B87", {
      actor: { ...financeActor, requestId: "balanced-journal-replay" },
      idempotencyKey: "balanced-journal",
      input,
    }),
  );

  assert.equal(first.state, "posted");
  assert.equal(first.transactionId, "journal-balanced-1");
  assert.equal(first.replayed, false);
  assert.equal(replay.transactionId, first.transactionId);
  assert.equal(replay.replayed, true);
  const transaction = runtime.getLedgerTransaction(financeActor, "journal-balanced-1");
  assert.equal(transaction.lines.length, 2);
  assert.equal(runtime.getAccountBalance(financeActor, "cash", "USD").debitMinor, 125);
  assert.equal(runtime.getAccountBalance(financeActor, "revenue", "USD").creditMinor, 125);
  assert.equal(runtime.listOutbox(financeActor).filter((event) => event.eventType === "ledger.transaction.posted").length, 1);
  assert.equal(runtime.listAudit(financeActor, 100).filter((entry) => entry.action === "ledger.posted").length, 1);
});

test("B34 closes a balanced partner settlement once and rejects allocation drift", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const financeActor = actor({
    actorId: "partner-finance-1",
    roles: ["finance_operator"],
    purpose: "partner_settlement",
    requestId: "partner-settlement",
    stepUp: true,
  });
  const input = {
    settlementId: "settlement-1",
    partnerId: "partner-1",
    contractVersion: "partner-contract-v3",
    period: "2026-08",
    meterState: "reconciled",
    paymentState: "settled",
    grossMinor: 10_000,
    platformMinor: 2_500,
    partnerMinor: 7_000,
    refundMinor: 500,
    currency: "USD",
  };

  const first = objectResult(
    await registry.execute(runtime, "B34", {
      actor: financeActor,
      idempotencyKey: "partner-settlement-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B34", {
      actor: { ...financeActor, requestId: "partner-settlement-replay" },
      idempotencyKey: "partner-settlement-1",
      input,
    }),
  );

  assert.equal(first.state, "posted");
  assert.equal(first.transactionId, "settlement-1");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const transaction = runtime.getLedgerTransaction(financeActor, "settlement-1");
  assert.equal(
    transaction.lines.filter((line) => line.direction === "debit").reduce((sum, line) => sum + line.amountMinor, 0),
    10_000,
  );
  assert.equal(
    transaction.lines.filter((line) => line.direction === "credit").reduce((sum, line) => sum + line.amountMinor, 0),
    10_000,
  );

  await rejectsDomainCode(
    registry.execute(runtime, "B34", {
      actor: { ...financeActor, requestId: "partner-settlement-drift" },
      idempotencyKey: "partner-settlement-drift",
      input: { ...input, settlementId: "settlement-drift", partnerMinor: 6_999 },
    }),
    "VALIDATION_FAILED",
  );
});

test("B41 deduplicates analytics inbox events and rejects event ID payload drift", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const analyticsActor = actor({
    actorId: "analytics-service-1",
    roles: ["platform_admin"],
    purpose: "product_analytics",
    requestId: "analytics-event",
  });
  const input = {
    eventId: "analytics-event-1",
    eventType: "timeline.completed",
    schemaVersion: "v1",
    occurredAt: "2026-08-20T01:00:00.000Z",
    receivedAt: "2026-08-20T01:00:01.000Z",
    actorPseudonym: "subject-hash-1",
    dimensions: { surface: "web", plan: "consumer" },
    metricNames: ["timeline_completion"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B41", {
      actor: analyticsActor,
      idempotencyKey: "analytics-ingest-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B41", {
      actor: { ...analyticsActor, requestId: "analytics-event-replay" },
      idempotencyKey: "analytics-ingest-replay",
      input,
    }),
  );

  assert.equal(first.state, "received");
  assert.equal(first.replayed, false);
  assert.equal(replay.eventId, first.eventId);
  assert.equal(replay.replayed, true);
  const inboxEvent = runtime.getInboxEvent(analyticsActor, String(first.eventId));
  assert.equal(inboxEvent.sourceEventId, "analytics-event-1");
  assert.equal(inboxEvent.payload.operationMode, "inbox-event");

  await rejectsDomainCode(
    registry.execute(runtime, "B41", {
      actor: { ...analyticsActor, requestId: "analytics-event-conflict" },
      idempotencyKey: "analytics-ingest-conflict",
      input: { ...input, dimensions: { surface: "mobile", plan: "consumer" } },
    }),
    "EVENT_FINGERPRINT_CONFLICT",
  );
});

test("B26 validates payment invariants before staging an external checkout command", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const commerceActor = actor({
    actorId: "commerce-service-1",
    roles: ["platform_admin"],
    purpose: "checkout",
    requestId: "checkout-command",
  });
  const input = {
    checkoutId: "checkout-1",
    quoteId: "quote-1",
    quoteState: "active",
    paymentAuthorizationId: "payment-authorization-1",
    paymentState: "authorized",
    quotedMinor: 4_999,
    authorizedMinor: 4_999,
    currency: "USD",
  };

  const result = objectResult(
    await registry.execute(runtime, "B26", {
      actor: commerceActor,
      idempotencyKey: "checkout-1",
      input,
    }),
  );

  assert.equal(result.state, "requested");
  const command = runtime.getRecord(commerceActor, "commerce.checkout-commands", "checkout-1");
  assert.equal(command.data.operationMode, "external-command");
  assert.equal(command.data.executionState, "requested");
  assert.equal(command.data.externalCommandId, "checkout-1");
  assert.equal(command.data.paymentAuthorizationId, "payment-authorization-1");

  await rejectsDomainCode(
    registry.execute(runtime, "B26", {
      actor: { ...commerceActor, requestId: "checkout-amount-mismatch" },
      idempotencyKey: "checkout-amount-mismatch",
      input: { ...input, checkoutId: "checkout-mismatch", authorizedMinor: 4_998 },
    }),
    "DEPENDENCY_UNAVAILABLE",
  );
});

test("B74, B89, B98, and B101 create requested commands without trusting pre-request result evidence", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const operator = actor({
    actorId: "commercial-operator-1",
    roles: ["platform_admin"],
    purpose: "commercial_operations",
    requestId: "requested-command-lifecycle",
    stepUp: true,
  });
  runtime.grantConsent(operator, {
    participantId: operator.actorId,
    grantorCapacity: "self",
    purpose: operator.purpose,
    scope: { feature: "notification_delivery" },
    policyVersion: "notification-consent-v1",
    evidenceHash: "d".repeat(64),
    idempotencyKey: "grant-notification-command-consent",
  });
  const commands: readonly {
    batchId: `B${string}`;
    collection: string;
    recordId: string;
    forbiddenResultField: string;
    input: JsonObject;
  }[] = [
    {
      batchId: "B74",
      collection: "notification.delivery-commands",
      recordId: "notification-request-74",
      forbiddenResultField: "notificationArtifactSha256",
      input: {
        notificationId: "notification-request-74", providerId: "provider-74", providerEnvironment: "sandbox",
        participantIds: [operator.actorId], purpose: operator.purpose, channel: "email",
        recipientRef: "opaque-contact-74", templateVersion: "template-v1", providerRoute: ["primary", "fallback"],
        eligibilityDecisionId: "eligibility-74", callbackVerificationPolicyVersion: "callback-policy-v1", boundedRetries: 3,
      },
    },
    {
      batchId: "B89",
      collection: "finance.tax-document-commands",
      recordId: "invoice-request-89",
      forbiddenResultField: "taxRequestArtifactSha256",
      input: {
        invoiceId: "invoice-request-89", legalEntityId: "entity-89", providerId: "tax-provider-89",
        providerEnvironment: "sandbox", invoiceType: "invoice", taxProfileVersion: "tax-profile-v1",
        sequenceScope: "entity-89:2026", amountMinor: 10_000, currency: "USD",
        creditNotePolicyVersion: "credit-note-v1",
      },
    },
    {
      batchId: "B98",
      collection: "supply.vendor-production-commands",
      recordId: "vendor-job-98",
      forbiddenResultField: "vendorRequestArtifactSha256",
      input: {
        jobId: "vendor-job-98", orderId: "order-98", vendorId: "vendor-98", purchaseOrderId: "po-98",
        approvedProofHash: "proof-hash-98", providerEnvironment: "sandbox", routeVersion: "route-v1",
        orderState: "approved_for_production", priorJobDisposition: "none", capacitySnapshotId: "capacity-98",
      },
    },
    {
      batchId: "B101",
      collection: "supply.return-claim-commands",
      recordId: "claim-101",
      forbiddenResultField: "claimArtifactSha256",
      input: {
        claimId: "claim-101", orderId: "order-101", action: "carrier_claim", providerType: "carrier",
        providerId: "carrier-101", vendorId: "vendor-101", providerEnvironment: "sandbox", evidenceReferences: ["redacted-reference-101"],
        eligibilityDecisionId: "eligibility-101", remedyLedgerReference: "ledger-101",
        returnAddressToken: "vault-return-address-101",
      },
    },
  ];

  for (const command of commands) {
    const result = objectResult(await registry.execute(runtime, command.batchId, {
      actor: { ...operator, requestId: `request-${command.batchId}` },
      idempotencyKey: `request-${command.batchId}`,
      input: command.input,
    }));
    assert.equal(result.state, "requested");
    assert.equal(result.commandState, "requested");
    const record = runtime.getRecord(operator, command.collection, command.recordId);
    assert.equal(record.data.commandState, "requested");
    assert.equal(record.data.executionState, "requested");
    assert.equal(record.data.externalCommandId, command.recordId);

    await rejectsDomainCode(registry.execute(runtime, command.batchId, {
      actor: { ...operator, requestId: `legacy-result-${command.batchId}` },
      idempotencyKey: `legacy-result-${command.batchId}`,
      input: { ...command.input, [command.forbiddenResultField]: "a".repeat(64) },
    }), "VALIDATION_FAILED");
  }
});

test("B48 persists certification only after verifying signed external evidence", async (testContext) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const certificationRunId = "certification-signed-1";
  const auditorProviderId = "business-loop-auditor";
  const provider = `e2e-auditor:${auditorProviderId}` as const;
  const providerEnvironment = "staging" as const;
  const certificationArtifactSha256 = "a".repeat(64);
  const evidenceScope = capabilityEvidenceScope({
    tenantId: "tenant-1",
    batchId: "B48",
    operation: "submitBusinessLoopEvidence",
    kind: "business-loop-certification",
    provider,
    artifactSha256: certificationArtifactSha256,
    environment: providerEnvironment,
    subjectId: certificationRunId,
  });
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    trustedEvidenceKeys: [{
      issuer: "certification-auditor",
      provider,
      keyId: "certification-key-1",
      algorithm: "Ed25519",
      publicKeyPem: String(publicKey.export({ format: "pem", type: "spki" })),
      allowedScopes: [evidenceScope],
      allowedEnvironments: ["staging"],
    }],
    evidencePolicy: "development",
    evidenceEnvironment: "staging",
  });
  testContext.after(() => runtime.close());
  const registry = createCapabilityRegistry();
  const certificationActor = actor({
    actorId: "release-1",
    roles: ["platform_admin"],
    purpose: "release_certification",
    requestId: "signed-certification",
    stepUp: true,
  });
  const evidenceIds = ["consumer", "family", "studio", "education", "abuse"].map((loop) => {
    const evidenceId = `business-loop-${loop}`;
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: certificationActor.tenantId,
      issuer: "certification-auditor",
      provider,
      environment: providerEnvironment,
      scope: evidenceScope,
      artifactSha256: certificationArtifactSha256,
      issuedAt,
      expiresAt,
      nonce: `business-loop-nonce-${loop}`,
      replayPolicy: "reusable",
      algorithm: "Ed25519",
      keyId: "certification-key-1",
    }, privateKey.export({ format: "pem", type: "pkcs8" }));
    runtime.registerExternalEvidence(certificationActor, {
      evidence,
      idempotencyKey: `register-${evidenceId}`,
    });
    return evidenceId;
  });

  const result = objectResult(
    await registry.execute(runtime, "B48", {
      actor: certificationActor,
      idempotencyKey: "signed-certification-run",
      input: {
        certificationRunId,
        environment: "isolated_staging",
        loopEvidence: {
          consumer: "passed",
          familyGift: "passed",
          studio: "passed",
          educationCrm: "passed",
          failureAbuse: "passed",
        },
        externalEvidenceIds: evidenceIds,
        abuseFixturesSynthetic: true,
        auditorProviderId,
        providerEnvironment,
        certificationArtifactSha256,
      },
    }),
  );

  assert.equal(result.state, "evidence_persisted");
  const attestation = runtime.getRecord(
    certificationActor,
    "certification.business-loop-runs",
    "certification-signed-1",
  );
  assert.equal(attestation.data.operationMode, "attestation");
  assert.equal(attestation.data.executionState, "evidence_persisted");
  assert.equal(attestation.data.certificationState, "evidence_submitted");
});

test("B48 rejects certification without external evidence", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const certificationActor = actor({
    actorId: "release-1",
    roles: ["platform_admin"],
    permissions: ["certification.business_loop.submit"],
    purpose: "release_certification",
    stepUp: true,
  });
  await rejectsDomainCode(
    registry.execute(runtime, "B48", {
      actor: certificationActor,
      idempotencyKey: "missing-external-evidence",
      input: {
        certificationRunId: "certification-1",
        environment: "isolated_staging",
        loopEvidence: {
          consumer: "passed",
          familyGift: "passed",
          studio: "passed",
          educationCrm: "passed",
          failureAbuse: "passed",
        },
        externalEvidenceIds: [],
        abuseFixturesSynthetic: true,
      },
    }),
    "VALIDATION_FAILED",
  );
});

test("B48 rejects client-supplied evidence when no server verifier is configured", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const certificationActor = actor({
    actorId: "release-1",
    roles: ["platform_admin"],
    permissions: ["certification.business_loop.submit"],
    purpose: "release_certification",
    stepUp: true,
  });
  await rejectsDomainCode(
    registry.execute(runtime, "B48", {
      actor: certificationActor,
      idempotencyKey: "fabricated-external-evidence",
      input: {
        certificationRunId: "certification-2",
        environment: "isolated_staging",
        loopEvidence: {
          consumer: "passed",
          familyGift: "passed",
          studio: "passed",
          educationCrm: "passed",
          failureAbuse: "passed",
        },
        externalEvidenceIds: [
          "client-asserted-consumer",
          "client-asserted-family",
          "client-asserted-studio",
          "client-asserted-crm",
          "client-asserted-abuse",
        ],
        abuseFixturesSynthetic: true,
        auditorProviderId: "business-loop-auditor",
        providerEnvironment: "staging",
        certificationArtifactSha256: "a".repeat(64),
      },
    }),
    "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
});

test("unknown capability IDs are rejected", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  await assert.rejects(
    registry.execute(runtime, "B999", {
      actor: actor(),
      idempotencyKey: "unknown-capability",
      input: {},
    }),
    /Unknown capability: B999/,
  );
});

test("B106 rejects literal, loopback, metadata, and non-standard-port webhook endpoints", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const operator = actor({
    actorId: "platform-operator",
    roles: ["platform_admin"],
    permissions: ["webhook.endpoint.manage", "record:create"],
    purpose: "webhook_registration",
    requestId: "webhook-ssrf",
    stepUp: true,
  });
  const input = {
    endpointId: "endpoint-1",
    eventTypes: ["order.created"],
    signatureAlgorithm: "ed25519",
    signatureToleranceSeconds: 60,
    replayEventId: "replay-1",
    replayReason: "operator_requested",
    consumerIdempotencyVerified: true,
    tenantActive: true,
  };
  for (const endpointUrl of [
    "https://127.0.0.1/callback",
    "https://localhost/callback",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/callback",
    "https://hooks.example.com:8443/callback",
    "https://user:password@hooks.example.com/callback",
  ]) {
    await rejectsDomainCode(registry.execute(runtime, "B106", {
      actor: { ...operator, requestId: `webhook-${Buffer.from(endpointUrl).toString("base64url")}` },
      idempotencyKey: `webhook-${Buffer.from(endpointUrl).toString("base64url")}`,
      input: { ...input, endpointUrl },
    }), "VALIDATION_FAILED");
  }
});
