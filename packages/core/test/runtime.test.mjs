import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DomainError,
  LifeTimeMachineRuntime,
  signExternalEvidence,
  verifyDatabaseBackup,
} from "../dist/index.js";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "ltm-core-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.sqlite");
}

function actor(overrides = {}) {
  return {
    actorId: "admin-1",
    tenantId: "tenant-a",
    roles: ["platform_admin"],
    purpose: "product_operation",
    requestId: "request-1",
    stepUp: true,
    ...overrides,
  };
}

function expectDomainError(fn, code) {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code);
}

test("tenant CRUD is durable, optimistic, audited, and idempotent", () => {
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({ databasePath: path });
  const context = actor();
  const input = {
    collection: "projects",
    data: { name: "Family timeline", state: "draft" },
    idempotencyKey: "create-project-1",
  };

  const created = runtime.createRecord(context, input);
  assert.equal(created.replayed, false);
  assert.equal(created.value.version, 1);
  assert.equal(created.value.ownerActorId, context.actorId);

  const replayed = runtime.createRecord(context, input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.value.id, created.value.id);

  expectDomainError(
    () => runtime.createRecord(context, { ...input, data: { name: "Different" } }),
    "IDEMPOTENCY_CONFLICT",
  );
  expectDomainError(
    () =>
      runtime.updateRecord(context, {
        collection: "projects",
        id: created.value.id,
        expectedVersion: 9,
        data: { name: "No" },
        idempotencyKey: "update-project-wrong-version",
      }),
    "VERSION_CONFLICT",
  );

  const updated = runtime.updateRecord(context, {
    collection: "projects",
    id: created.value.id,
    expectedVersion: 1,
    data: { name: "Family timeline", state: "ready" },
    idempotencyKey: "update-project-1",
  });
  assert.equal(updated.value.version, 2);
  assert.equal(updated.value.data.state, "ready");
  assert.equal(runtime.listOutbox(context).length, 2);

  runtime.createRecord(context, {
    collection: "projects",
    id: "delete-me",
    data: { state: "draft" },
    idempotencyKey: "create-delete-me-1",
  });
  const deleteInput = {
    collection: "projects",
    id: "delete-me",
    expectedVersion: 1,
    idempotencyKey: "delete-project-1",
  };
  assert.equal(runtime.deleteRecord(context, deleteInput).replayed, false);
  const deleteReplay = runtime.deleteRecord(context, deleteInput);
  assert.equal(deleteReplay.replayed, true);
  assert.equal(deleteReplay.value.deletedAt !== null, true);

  const otherTenant = actor({ tenantId: "tenant-b", requestId: "request-other" });
  expectDomainError(() => runtime.getRecord(otherTenant, "projects", created.value.id), "RESOURCE_NOT_FOUND");
  assert.deepEqual(runtime.listRecords(otherTenant, { collection: "projects" }), []);
  assert.equal(runtime.verifyAuditChain(context).valid, true);
  runtime.close();

  const reopened = new LifeTimeMachineRuntime({ databasePath: path });
  assert.equal(reopened.getRecord(context, "projects", created.value.id).version, 2);
  assert.equal(reopened.readiness().ready, true);
  reopened.close();
});

test("purpose consent and verified-guardian safeguards fail closed", () => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: databasePath() });
  const consumer = actor({
    actorId: "person-1",
    roles: ["consumer"],
    purpose: "age_transformation",
    stepUp: false,
  });
  runtime.createRecord(consumer, {
    collection: "participants",
    id: "participant-1",
    data: { alias: "P1" },
    idempotencyKey: "participant-create-1",
  });
  const consent = runtime.grantConsent(consumer, {
    participantId: "participant-1",
    grantorCapacity: "self",
    purpose: "age_transformation",
    scope: { media: true },
    policyVersion: "v1",
    evidenceHash: "a".repeat(64),
    idempotencyKey: "consent-grant-1",
  });
  assert.equal(consent.value.status, "active");
  assert.equal(runtime.requireConsent(consumer, { participantIds: ["participant-1"] }).length, 1);

  runtime.createRecord(consumer, {
    collection: "projects",
    id: "project-with-consent",
    data: { state: "draft" },
    participantIds: ["participant-1"],
    idempotencyKey: "project-consented-1",
  });
  const marketing = { ...consumer, purpose: "marketing", requestId: "marketing-request" };
  expectDomainError(
    () =>
      runtime.createRecord(marketing, {
        collection: "projects",
        id: "project-without-marketing-consent",
        data: { state: "draft" },
        participantIds: ["participant-1"],
        idempotencyKey: "project-marketing-1",
      }),
    "CONSENT_REQUIRED",
  );

  expectDomainError(
    () =>
      runtime.grantConsent(consumer, {
        participantId: "child-1",
        grantorCapacity: "guardian",
        purpose: "age_transformation",
        scope: { media: true },
        policyVersion: "v1",
        evidenceHash: "b".repeat(64),
        isMinor: true,
        idempotencyKey: "minor-consent-invalid",
      }),
    "GUARDIAN_VERIFICATION_REQUIRED",
  );

  const guardian = actor({
    actorId: "guardian-1",
    roles: ["guardian"],
    purpose: "age_transformation",
    guardianVerified: true,
  });
  const minorConsent = runtime.grantConsent(guardian, {
    participantId: "child-1",
    grantorCapacity: "guardian",
    purpose: "age_transformation",
    scope: { media: true, publicShare: false },
    policyVersion: "v1",
    evidenceHash: "c".repeat(64),
    isMinor: true,
    idempotencyKey: "minor-consent-valid",
  });
  assert.equal(minorConsent.value.isMinor, true);
  runtime.close();
});

test("double-entry ledger rejects imbalance and requires exact reversals", () => {
  const runtime = new LifeTimeMachineRuntime({ databasePath: databasePath() });
  const finance = actor({ actorId: "finance-1", roles: ["finance_operator"], purpose: "accounting" });
  const lines = [
    { accountCode: "cash", direction: "debit", amountMinor: 1250, currency: "CNY" },
    { accountCode: "revenue", direction: "credit", amountMinor: 1250, currency: "CNY" },
  ];
  expectDomainError(
    () =>
      runtime.postLedgerTransaction(finance, {
        sourceType: "order",
        sourceId: "bad-order",
        description: "Unbalanced",
        lines: [lines[0], { ...lines[1], amountMinor: 1200 }],
        idempotencyKey: "ledger-bad-1",
      }),
    "LEDGER_UNBALANCED",
  );
  const posted = runtime.postLedgerTransaction(finance, {
    sourceType: "order",
    sourceId: "order-1",
    description: "Order paid",
    lines,
    idempotencyKey: "ledger-order-1",
  });
  const replay = runtime.postLedgerTransaction(finance, {
    sourceType: "order",
    sourceId: "order-1",
    description: "Order paid",
    lines,
    idempotencyKey: "ledger-order-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.id, posted.value.id);
  assert.equal(runtime.getAccountBalance(finance, "cash", "CNY").netMinor, 1250);

  const reversal = runtime.postLedgerTransaction(finance, {
    sourceType: "refund",
    sourceId: "refund-1",
    description: "Full reversal",
    reversedTransactionId: posted.value.id,
    lines: [
      { accountCode: "cash", direction: "credit", amountMinor: 1250, currency: "CNY" },
      { accountCode: "revenue", direction: "debit", amountMinor: 1250, currency: "CNY" },
    ],
    idempotencyKey: "ledger-refund-1",
  });
  assert.equal(reversal.value.reversedTransactionId, posted.value.id);
  assert.equal(runtime.getAccountBalance(finance, "cash", "CNY").netMinor, 0);
  runtime.close();
});

test("inbox fingerprints, outbox leases, absent publishers, and immutable audit are enforced", async () => {
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({ databasePath: path });
  const context = actor();
  const first = runtime.receiveInboxEvent(context, {
    source: "payment-provider",
    sourceEventId: "evt-1",
    eventType: "payment.captured",
    payload: { amountMinor: 100 },
  });
  assert.equal(first.replayed, false);
  assert.equal(
    runtime.receiveInboxEvent(context, {
      source: "payment-provider",
      sourceEventId: "evt-1",
      eventType: "payment.captured",
      payload: { amountMinor: 100 },
    }).replayed,
    true,
  );
  expectDomainError(
    () =>
      runtime.receiveInboxEvent(context, {
        source: "payment-provider",
        sourceEventId: "evt-1",
        eventType: "payment.captured",
        payload: { amountMinor: 999 },
      }),
    "EVENT_FINGERPRINT_CONFLICT",
  );
  await assert.rejects(
    runtime.publishOutbox(context, undefined),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
  const claimed = runtime.claimOutbox(context, "worker-1", 10, 5_000);
  assert.equal(claimed.length, 1);
  const published = runtime.markOutboxPublished(context, claimed[0].id, "worker-1");
  assert.equal(published.status, "published");
  assert.equal(runtime.verifyAuditChain(context).valid, true);
  runtime.close();

  const raw = new DatabaseSync(path);
  assert.throws(() => raw.prepare("UPDATE audit_entries SET action = 'tampered'").run(), /append-only/);
  assert.throws(() => raw.prepare("DELETE FROM audit_entries").run(), /append-only/);
  raw.close();
});

test("external evidence is signed, tenant/scope bound, durable, and replay resistant", () => {
  const context = actor({ operationId: "release-operation-1" });
  const absent = new LifeTimeMachineRuntime({ databasePath: databasePath() });
  expectDomainError(
    () => absent.requireExternalEvidence(context, "B127:certifyRelease", ["evidence-1"]),
    "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
  absent.close();

  expectDomainError(
    () => new LifeTimeMachineRuntime({ databasePath: databasePath(), evidencePolicy: "production" }),
    "CONFIGURATION_INVALID",
  );

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const trustedEvidenceKeys = [{
    issuer: "release-auditor",
    provider: "assurance-provider",
    keyId: "key-2026-01",
    algorithm: "Ed25519",
    publicKeyPem,
    allowedScopes: ["B127:*"],
    allowedEnvironments: ["production"],
  }];
  expectDomainError(
    () => new LifeTimeMachineRuntime({
      databasePath: databasePath(),
      evidencePolicy: "production",
      evidenceEnvironment: "production",
      trustedEvidenceKeys: [{ ...trustedEvidenceKeys[0], issuer: "test:release-auditor" }],
    }),
    "CONFIGURATION_INVALID",
  );
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({
    databasePath: path,
    evidencePolicy: "production",
    evidenceEnvironment: "production",
    trustedEvidenceKeys,
  });
  const unsigned = {
    version: "ltm.external-evidence.v1",
    evidenceId: "evidence-1",
    tenantId: "tenant-a",
    issuer: "release-auditor",
    provider: "assurance-provider",
    environment: "production",
    scope: "B127:approveStagedProductionLaunch:assurance-provider:" + "a".repeat(64),
    artifactSha256: "a".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    nonce: "nonce-release-00000001",
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "key-2026-01",
  };
  const signed = signExternalEvidence(unsigned, privateKeyPem);
  const wrongEnvironment = signExternalEvidence({
    ...unsigned,
    evidenceId: "evidence-test-environment",
    environment: "test",
    nonce: "nonce-release-test-0001",
  }, privateKeyPem);
  expectDomainError(
    () => runtime.registerExternalEvidence(context, {
      evidence: wrongEnvironment,
      idempotencyKey: "register-test-environment-1",
    }),
    "EVIDENCE_TRUST_KEY_NOT_FOUND",
  );
  const registered = runtime.registerExternalEvidence(context, {
    evidence: signed,
    idempotencyKey: "register-evidence-1",
  });
  assert.equal(registered.value.status, "verified");
  assert.equal(registered.value.artifactSha256, "a".repeat(64));
  assert.equal(runtime.readiness().evidenceTrust, "ok");

  const verified = runtime.requireExternalEvidence(context, unsigned.scope, ["evidence-1"]);
  assert.equal(verified[0].consumedAt !== null, true);
  assert.equal(runtime.requireExternalEvidence(context, unsigned.scope, ["evidence-1"])[0].evidenceId, "evidence-1");
  expectDomainError(
    () => runtime.requireExternalEvidence({ ...context, operationId: "release-operation-2" }, unsigned.scope, ["evidence-1"]),
    "EVIDENCE_REPLAY_DETECTED",
  );
  expectDomainError(
    () => runtime.requireExternalEvidence(context, `${unsigned.scope}:other`, ["evidence-1"]),
    "EVIDENCE_SCOPE_MISMATCH",
  );

  const tampered = { ...signed, evidenceId: "evidence-tampered", artifactSha256: "b".repeat(64), nonce: "nonce-release-00000002" };
  expectDomainError(
    () => runtime.registerExternalEvidence(context, { evidence: tampered, idempotencyKey: "register-tampered-1" }),
    "EVIDENCE_SIGNATURE_INVALID",
  );

  const nonceReplay = signExternalEvidence({ ...unsigned, evidenceId: "evidence-2" }, privateKeyPem);
  expectDomainError(
    () => runtime.registerExternalEvidence(context, { evidence: nonceReplay, idempotencyKey: "register-nonce-replay-1" }),
    "EVIDENCE_REPLAY_DETECTED",
  );
  expectDomainError(
    () => runtime.registerExternalEvidence(context, { evidence: signed, idempotencyKey: "register-evidence-again-1" }),
    "EVIDENCE_REPLAY_DETECTED",
  );

  const reusable = signExternalEvidence({
    ...unsigned,
    evidenceId: "evidence-reusable",
    nonce: "nonce-release-00000003",
    replayPolicy: "reusable",
  }, privateKeyPem);
  runtime.registerExternalEvidence(context, { evidence: reusable, idempotencyKey: "register-reusable-1" });
  const revoked = runtime.revokeExternalEvidence(context, {
    evidenceId: "evidence-reusable",
    expectedVersion: 1,
    reason: "issuer withdrew the attestation",
    idempotencyKey: "revoke-reusable-1",
  });
  assert.equal(revoked.value.status, "revoked");
  expectDomainError(
    () => runtime.requireExternalEvidence(context, unsigned.scope, ["evidence-reusable"]),
    "EVIDENCE_REVOKED",
  );
  runtime.close();

  const reopened = new LifeTimeMachineRuntime({
    databasePath: path,
    evidencePolicy: "production",
    evidenceEnvironment: "production",
    trustedEvidenceKeys,
  });
  assert.equal(reopened.getExternalEvidence(context, "evidence-1").consumedAt !== null, true);
  assert.equal(reopened.listExternalEvidence(context, { scope: unsigned.scope }).length, 2);
  reopened.close();

  const raw = new DatabaseSync(path);
  assert.throws(
    () => raw.prepare(`
      UPDATE external_evidence
      SET status = 'verified', version = version + 1, revoked_at = NULL, revocation_reason = NULL
      WHERE tenant_id = 'tenant-a' AND id = 'evidence-reusable'
    `).run(),
    /only transition once/,
  );
  assert.throws(
    () => raw.prepare(`UPDATE external_evidence SET version = version + 1 WHERE id = 'evidence-1'`).run(),
    /only transition once/,
  );
  raw.close();
});

test("external business events atomically drive commands, reject tampering and order violations, and freeze on revocation", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "wechat-callback-verifier",
    provider: "wechat-pay",
    keyId: "wechat-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B71:*"],
    allowedEnvironments: ["sandbox"],
  };
  const runtime = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    clock: { now: () => now },
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const context = actor({
    roles: ["platform_admin", "service_account"],
    requestId: "external-business-request-1",
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const makeBundle = ({ eventId, evidenceId, sequence, scope = "B71:pay:payment-1", claims }) => {
    const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
    const unsignedEvent = {
      version: "ltm.external-business-event.v1",
      eventId,
      tenantId: context.tenantId,
      batchId: "B71",
      operation: "createWeChatPayment",
      provider: trustedKey.provider,
      subjectType: "payment",
      subjectId: "payment-1",
      eventType: "payment.succeeded",
      providerOccurredAt: new Date(now.getTime() - 1_000 + sequence).toISOString(),
      sequence,
      correlationId: "payment-1",
      artifactSha256: "c".repeat(64),
      evidenceId,
      evidenceScope: scope,
      canonicalClaims: claims,
      canonicalClaimsSha256,
    };
    const event = {
      ...unsignedEvent,
      businessEventSha256: canonicalBusinessEventSha256(unsignedEvent),
    };
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: context.tenantId,
      issuer: trustedKey.issuer,
      provider: trustedKey.provider,
      environment: "sandbox",
      scope,
      artifactSha256: event.artifactSha256,
      canonicalClaimsSha256,
      businessEventSha256: event.businessEventSha256,
      issuedAt: new Date(now.getTime() - 5_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      nonce: `nonce-${evidenceId}-0123456789`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedKey.keyId,
    }, privateKeyPem);
    return { event, evidence };
  };
  const reducer = {
    name: "wechat-payment-test-v1",
    locate: () => ({ collection: "commerce.wechat-payments", aggregateId: "payment-1" }),
    reduce: (event) => ({
      stateField: "state",
      allowedPriorStates: ["requested", "succeeded"],
      nextState: "succeeded",
      patch: { providerStatus: event.canonicalClaims.status },
      decisionType: "payment_settlement",
      decisionId: event.eventId,
      commandTransition: {
        commandId: "command-payment-1",
        toState: "succeeded",
        providerOperationId: "wechat-operation-1",
      },
    }),
  };

  const created = runtime.createExternalCommand(context, {
    record: {
      id: "payment-1",
      collection: "commerce.wechat-payments",
      data: { state: "requested", amountMinor: 500 },
    },
    commandId: "command-payment-1",
    batchId: "B71",
    operation: "createWeChatPayment",
    details: { channel: "wechat" },
    idempotencyKey: "create-payment-command-1",
  });
  assert.equal(created.value.command.state, "requested");
  assert.equal(created.value.record.data.executionState, "requested");
  expectDomainError(() => runtime.transitionExternalCommand(context, {
    commandId: "command-payment-1",
    batchId: "B71",
    operation: "createWeChatPayment",
    aggregateCollection: "commerce.wechat-payments",
    aggregateId: "payment-1",
    toState: "acknowledged",
    idempotencyKey: "illegal-ack-1",
  }), "VERSION_CONFLICT");
  const dispatchedInput = {
    commandId: "command-payment-1",
    batchId: "B71",
    operation: "createWeChatPayment",
    aggregateCollection: "commerce.wechat-payments",
    aggregateId: "payment-1",
    toState: "dispatched",
    providerOperationId: "wechat-operation-1",
    idempotencyKey: "dispatch-payment-1",
  };
  assert.equal(runtime.transitionExternalCommand(context, dispatchedInput).value.state, "dispatched");
  assert.equal(runtime.transitionExternalCommand(context, dispatchedInput).replayed, true);
  assert.equal(runtime.transitionExternalCommand(context, {
    ...dispatchedInput,
    toState: "acknowledged",
    idempotencyKey: "ack-payment-1",
  }).value.state, "acknowledged");
  expectDomainError(() => runtime.transitionExternalCommand(context, {
    ...dispatchedInput,
    toState: "succeeded",
    idempotencyKey: "terminal-without-evidence-1",
  }), "AUTH_FORBIDDEN");

  const bundle = makeBundle({
    eventId: "wechat-event-10",
    evidenceId: "wechat-evidence-10",
    sequence: 10,
    claims: { status: "SUCCESS", amountMinor: 500 },
  });
  const tampered = {
    ...bundle.event,
    canonicalClaims: { status: "SUCCESS", amountMinor: 1 },
  };
  expectDomainError(() => runtime.applyExternalBusinessEvent(context, {
    event: tampered,
    evidence: bundle.evidence,
    reducer,
    idempotencyKey: "tampered-claims-1",
  }), "EVENT_FINGERPRINT_CONFLICT");
  const crossScopeUnsigned = {
    ...bundle.event,
    evidenceScope: "B71:pay:other-payment",
  };
  const crossScope = {
    ...crossScopeUnsigned,
    businessEventSha256: canonicalBusinessEventSha256(crossScopeUnsigned),
  };
  expectDomainError(() => runtime.applyExternalBusinessEvent(context, {
    event: crossScope,
    evidence: bundle.evidence,
    reducer,
    idempotencyKey: "cross-scope-1",
  }), "EVIDENCE_SCOPE_MISMATCH");

  const applied = runtime.applyExternalBusinessEvent(context, {
    ...bundle,
    reducer,
    idempotencyKey: "apply-wechat-event-10",
  });
  assert.equal(applied.replayed, false);
  assert.equal(applied.value.command.state, "succeeded");
  assert.equal(applied.value.aggregate.data.executionState, "succeeded");
  assert.equal(applied.value.aggregate.data.externalReceipt.evidenceId, bundle.evidence.evidenceId);
  assert.equal(runtime.applyExternalBusinessEvent(context, {
    ...bundle,
    reducer,
    idempotencyKey: "apply-wechat-event-10-again",
  }).replayed, true);

  const stale = makeBundle({
    eventId: "wechat-event-09",
    evidenceId: "wechat-evidence-09",
    sequence: 9,
    claims: { status: "SUCCESS", amountMinor: 500 },
  });
  expectDomainError(() => runtime.applyExternalBusinessEvent(context, {
    ...stale,
    reducer,
    idempotencyKey: "apply-wechat-event-09",
  }), "VERSION_CONFLICT");
  expectDomainError(() => runtime.getExternalEvidence(context, stale.evidence.evidenceId), "RESOURCE_NOT_FOUND");

  runtime.revokeExternalEvidence(context, {
    evidenceId: bundle.evidence.evidenceId,
    expectedVersion: 1,
    reason: "provider reversed the verified callback",
    idempotencyKey: "revoke-wechat-event-10",
  });
  const frozen = runtime.getRecord(context, "commerce.wechat-payments", "payment-1");
  assert.equal(frozen.data._externalDecisionState, "frozen");
  assert.equal(frozen.data._externalReconciliationState, "reconciliation_required");
  assert.equal(runtime.getExternalCommand(context, "command-payment-1").decisionState, "frozen");
  runtime.close();
});

test("online backup is restorable and independently verifies integrity and audit chains", async () => {
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({ databasePath: path });
  const context = actor();
  const created = runtime.createRecord(context, {
    collection: "projects",
    id: "backup-project",
    data: { state: "recoverable" },
    idempotencyKey: "backup-project-create-1",
  });
  const backupPath = join(path.slice(0, path.lastIndexOf("/")), "verified-backup.sqlite");
  const verification = await runtime.createVerifiedBackup(backupPath);
  assert.equal(verification.integrity, "ok");
  assert.equal(verification.auditChainsValid, true);
  assert.equal(verification.recordCount, 1);
  assert.equal(verification.auditEntryCount > 0, true);
  assert.match(verification.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    runtime.createVerifiedBackup(backupPath),
    (error) => error instanceof DomainError && error.code === "BACKUP_VERIFICATION_FAILED",
  );
  runtime.close();

  const restored = new LifeTimeMachineRuntime({ databasePath: backupPath });
  assert.equal(restored.getRecord(context, "projects", created.value.id).data.state, "recoverable");
  assert.equal(restored.verifyAuditChain(context).valid, true);
  restored.close();

  const corruptPath = join(path.slice(0, path.lastIndexOf("/")), "corrupt-backup.sqlite");
  copyFileSync(backupPath, corruptPath);
  truncateSync(corruptPath, 512);
  await assert.rejects(
    verifyDatabaseBackup(corruptPath),
    (error) => error instanceof DomainError && error.code === "BACKUP_VERIFICATION_FAILED",
  );

  const unauditedPath = join(path.slice(0, path.lastIndexOf("/")), "unaudited-backup.sqlite");
  copyFileSync(backupPath, unauditedPath);
  const unaudited = new DatabaseSync(unauditedPath);
  unaudited.prepare(`
    INSERT INTO records(
      tenant_id, collection, id, owner_actor_id, participant_ids_json, contains_minor,
      data_json, version, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, NULL, '[]', 0, '{}', 1, ?, ?, NULL)
  `).run("tenant-without-audit", "projects", "raw-record", new Date().toISOString(), new Date().toISOString());
  unaudited.close();
  await assert.rejects(
    verifyDatabaseBackup(unauditedPath),
    (error) => error instanceof DomainError && error.code === "BACKUP_VERIFICATION_FAILED",
  );
});

test("schema v2 evidence stores migrate to an explicit sandbox environment", () => {
  const path = databasePath();
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '2');
    CREATE TABLE external_evidence (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      envelope_version TEXT NOT NULL,
      issuer TEXT NOT NULL,
      provider TEXT NOT NULL,
      scope TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      nonce TEXT NOT NULL,
      replay_policy TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      key_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      verified_at TEXT NOT NULL,
      revoked_at TEXT,
      revocation_reason TEXT,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, issuer, provider, nonce)
    ) STRICT;
  `);
  legacy.close();

  const migrated = new LifeTimeMachineRuntime({ databasePath: path });
  migrated.close();
  const raw = new DatabaseSync(path);
  const columns = raw.prepare("PRAGMA table_info(external_evidence)").all();
  assert.equal(columns.some((column) => column.name === "environment"), true);
  assert.equal(raw.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get().value, "4");
  for (const table of [
    "external_commands",
    "external_command_transitions",
    "evidence_decisions",
    "external_business_events",
  ]) {
    assert.equal(
      raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table)?.present,
      1,
    );
  }
  raw.close();
});

test("unknown schema versions fail closed before migrations run", () => {
  const path = databasePath();
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '999');
  `);
  raw.close();
  expectDomainError(() => new LifeTimeMachineRuntime({ databasePath: path }), "DEPENDENCY_UNAVAILABLE");
  const unchanged = new DatabaseSync(path, { readOnly: true });
  assert.equal(unchanged.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get().value, "999");
  unchanged.close();
});
