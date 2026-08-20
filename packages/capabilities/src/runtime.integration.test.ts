import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DomainError, LifeTimeMachineRuntime, type ActorContext } from "@ltm/core";
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

  assert.equal(result.state, "persisted");
  assert.equal(result.replayed, false);
  const records = runtime.listRecords(consumer, { collection: "capability.building-age-media-pipeline" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.data.jobId, "job-1");
  assert.equal(records[0]?.data.illustrativeLabel, true);
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
