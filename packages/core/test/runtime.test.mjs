import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DomainError, LifeTimeMachineRuntime } from "../dist/index.js";

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

test("external evidence is accepted only through a configured server-side verifier", () => {
  const context = actor();
  const absent = new LifeTimeMachineRuntime({ databasePath: databasePath() });
  expectDomainError(
    () => absent.requireExternalEvidence(context, "B127:certifyRelease", ["evidence-1"]),
    "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
  absent.close();

  const rejecting = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    externalEvidenceVerifier: { verify: () => [] },
  });
  expectDomainError(
    () => rejecting.requireExternalEvidence(context, "B127:certifyRelease", ["evidence-1"]),
    "EXTERNAL_EVIDENCE_UNVERIFIED",
  );
  rejecting.close();

  const verifiedCalls = [];
  const accepting = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    externalEvidenceVerifier: {
      verify: (actorContext, scope, ids) => {
        verifiedCalls.push({ actorContext, scope, ids });
        return ids;
      },
    },
  });
  accepting.requireExternalEvidence(
    context,
    "B127:certifyRelease",
    ["evidence-2", "evidence-1", "evidence-2"],
  );
  assert.deepEqual(verifiedCalls[0].ids, ["evidence-1", "evidence-2"]);
  assert.equal(verifiedCalls[0].actorContext.tenantId, "tenant-a");
  assert.equal(verifiedCalls[0].scope, "B127:certifyRelease");
  accepting.close();
});
