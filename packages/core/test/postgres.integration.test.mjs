import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DomainError,
  PostgresLifeTimeMachineRuntime,
  participantEvidenceScope,
  signExternalEvidence,
} from "../dist/index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

function actor(tenantId, operationId = "operation-default") {
  return {
    actorId: "admin-integration",
    tenantId,
    roles: ["platform_admin"],
    purpose: "product_operation",
    requestId: `request-${tenantId}-${operationId}`,
    stepUp: true,
    guardianVerified: true,
    operationId,
  };
}

test("PostgreSQL runtime enforces RLS and persists the complete core transaction surface", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedEvidenceKey = {
    issuer: "integration-issuer",
    provider: "integration-provider",
    keyId: "integration-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B127:*", "identity.*"],
    allowedEnvironments: ["sandbox"],
  };
  const runtime = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-core-integration-test",
    trustedEvidenceKeys: [trustedEvidenceKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const rawPool = new Pool({ connectionString, application_name: "ltm-core-raw-assertions" });
  try {
    assert.deepEqual(await runtime.readiness(), {
      ready: true,
      database: "ok",
      auditChain: "ok",
      evidenceTrust: "ok",
      consentPolicy: "legacy_test_only",
    });

    const tenantA = actor("tenant-pg-a");
    const tenantB = actor("tenant-pg-b");
    const [first, replay] = await Promise.all([
      runtime.createRecord(tenantA, {
        collection: "projects",
        data: { name: "PostgreSQL project" },
        idempotencyKey: "pg-create-concurrent-1",
      }),
      runtime.createRecord(tenantA, {
        collection: "projects",
        data: { name: "PostgreSQL project" },
        idempotencyKey: "pg-create-concurrent-1",
      }),
    ]);
    assert.deepEqual([first.replayed, replay.replayed].sort(), [false, true]);
    assert.equal(first.value.id, replay.value.id);
    await assert.rejects(
      runtime.createRecord(tenantA, {
        collection: "projects",
        data: { name: "Conflicting request" },
        idempotencyKey: "pg-create-concurrent-1",
      }),
      (error) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const tenantBRecord = await runtime.createRecord(tenantB, {
      id: "tenant-b-only-record",
      collection: "projects",
      data: { secret: "tenant-b" },
      idempotencyKey: "pg-tenant-b-create-1",
    });
    assert.equal(tenantBRecord.value.tenantId, "tenant-pg-b");
    await assert.rejects(
      runtime.getRecord(tenantA, "projects", "tenant-b-only-record"),
      (error) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
    );

    const updated = await runtime.updateRecord(tenantA, {
      collection: "projects",
      id: first.value.id,
      expectedVersion: 1,
      data: { name: "Updated on PostgreSQL" },
      idempotencyKey: "pg-update-1",
    });
    assert.equal(updated.value.version, 2);
    await assert.rejects(
      runtime.updateRecord(tenantA, {
        collection: "projects",
        id: first.value.id,
        expectedVersion: 1,
        data: { name: "Stale" },
        idempotencyKey: "pg-update-stale-1",
      }),
      (error) => error instanceof DomainError && error.code === "VERSION_CONFLICT",
    );

    const participantExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const participantMutation = {
      operation: "participant.register",
      tenantId: tenantA.tenantId,
      participantId: "participant-pg-1",
      ownerActorId: tenantA.actorId,
      minorStatus: "adult",
      expiresAt: participantExpiresAt,
      expectedVersion: null,
    };
    const participantEvidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: "participant-evidence-pg-1",
      tenantId: tenantA.tenantId,
      issuer: trustedEvidenceKey.issuer,
      provider: trustedEvidenceKey.provider,
      environment: "sandbox",
      scope: participantEvidenceScope(participantMutation),
      artifactSha256: "c".repeat(64),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: participantExpiresAt,
      nonce: "nonce-participant-pg-integration-0001",
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedEvidenceKey.keyId,
    }, privateKey.export({ type: "pkcs8", format: "pem" }));
    const identityService = {
      ...tenantA,
      roles: ["service_account", "platform_admin"],
      requestId: "request-participant-pg-1",
      operationId: "participant-register-pg-1",
    };
    await runtime.registerExternalEvidence(identityService, {
      evidence: participantEvidence,
      idempotencyKey: "participant-evidence-register-pg-1",
    });
    await runtime.registerParticipant(identityService, {
      participantId: participantMutation.participantId,
      ownerActorId: participantMutation.ownerActorId,
      minorStatus: participantMutation.minorStatus,
      expiresAt: participantMutation.expiresAt,
      expectedVersion: null,
      evidenceId: participantEvidence.evidenceId,
      idempotencyKey: "participant-register-pg-1",
    });
    const consent = await runtime.grantConsent(tenantA, {
      participantId: "participant-pg-1",
      grantorCapacity: "self",
      purpose: "product_operation",
      scope: { resource: "projects:pg-consent-bound-record-1", actions: ["process"] },
      policyVersion: "policy-1",
      evidenceHash: "a".repeat(64),
      idempotencyKey: "pg-consent-1",
    });
    assert.equal(consent.value.status, "active");
    const consentBound = await runtime.createRecord(tenantA, {
      collection: "projects",
      id: "pg-consent-bound-record-1",
      participantIds: ["participant-pg-1"],
      data: { consentBound: true },
      idempotencyKey: "pg-consent-record-1",
    });
    assert.equal(consentBound.value.participantIds[0], "participant-pg-1");

    const ledger = await runtime.postLedgerTransaction(tenantA, {
      sourceType: "invoice",
      sourceId: "invoice-pg-1",
      description: "PostgreSQL balanced transaction",
      lines: [
        { accountCode: "cash", direction: "debit", amountMinor: 2500, currency: "USD" },
        { accountCode: "revenue", direction: "credit", amountMinor: 2500, currency: "USD" },
      ],
      idempotencyKey: "pg-ledger-1",
    });
    assert.equal(ledger.value.lines.length, 2);
    assert.equal((await runtime.getAccountBalance(tenantA, "cash", "USD")).netMinor, 2500);

    const inbox = await runtime.receiveInboxEvent(tenantA, {
      source: "integration",
      sourceEventId: "event-pg-1",
      eventType: "project.observed",
      payload: { projectId: first.value.id },
    });
    assert.equal(inbox.replayed, false);
    assert.equal((await runtime.receiveInboxEvent(tenantA, {
      source: "integration",
      sourceEventId: "event-pg-1",
      eventType: "project.observed",
      payload: { projectId: first.value.id },
    })).replayed, true);
    assert.ok((await runtime.listOutbox(tenantA)).length >= 5);

    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const scope = `B127:certify:integration:${"b".repeat(64)}`;
    const signed = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: "evidence-pg-1",
      tenantId: tenantA.tenantId,
      issuer: trustedEvidenceKey.issuer,
      provider: trustedEvidenceKey.provider,
      environment: "sandbox",
      scope,
      artifactSha256: "b".repeat(64),
      issuedAt,
      expiresAt,
      nonce: "nonce-pg-integration-0001",
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedEvidenceKey.keyId,
    }, privateKey.export({ type: "pkcs8", format: "pem" }));
    await runtime.registerExternalEvidence(tenantA, {
      evidence: signed,
      idempotencyKey: "pg-evidence-register-1",
    });
    const [consumed, consumedReplay] = await Promise.all([
      runtime.requireExternalEvidence(actor(tenantA.tenantId, "certify-operation-1"), scope, [signed.evidenceId]),
      runtime.requireExternalEvidence(actor(tenantA.tenantId, "certify-operation-1"), scope, [signed.evidenceId]),
    ]);
    assert.match(consumed[0]?.consumptionKeyHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(consumedReplay[0]?.consumptionKeyHash, consumed[0]?.consumptionKeyHash);
    await assert.rejects(
      runtime.requireExternalEvidence(actor(tenantA.tenantId, "certify-operation-2"), scope, [signed.evidenceId]),
      (error) => error instanceof DomainError && error.code === "EVIDENCE_REPLAY_DETECTED",
    );
    await assert.rejects(
      runtime.requireExternalEvidence(actor(tenantA.tenantId, "certify-operation-1"), `${scope}:wrong`, [signed.evidenceId]),
      (error) => error instanceof DomainError && error.code === "EVIDENCE_SCOPE_MISMATCH",
    );

    const serviceA = {
      ...tenantA,
      roles: ["platform_admin", "service_account"],
      requestId: "request-tenant-pg-a-external-business",
    };
    const deadLetterCommand = await runtime.createExternalCommand(serviceA, {
      record: {
        id: "pg-dead-letter-command-record-1",
        collection: "operations.delivery-commands",
        data: { state: "requested", operationMode: "external-command" },
      },
      commandId: "pg-dead-letter-command-1",
      batchId: "B98",
      operation: "createVendorProductionJob",
      idempotencyKey: "pg-dead-letter-command-create-1",
    });
    await runtime.transitionExternalCommand(serviceA, {
      commandId: deadLetterCommand.value.command.commandId,
      batchId: deadLetterCommand.value.command.batchId,
      operation: deadLetterCommand.value.command.operation,
      aggregateCollection: deadLetterCommand.value.command.aggregateCollection,
      aggregateId: deadLetterCommand.value.command.aggregateId,
      toState: "dispatched",
      idempotencyKey: "pg-dead-letter-command-dispatched-1",
    });
    const deadLetterRequestId = (await runtime.listOutbox(serviceA))
      .find((event) => event.eventType === "external_command.requested" &&
        event.aggregateId === deadLetterCommand.value.record.id)?.id;
    assert.notEqual(deadLetterRequestId, undefined);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const leased = await runtime.claimOutbox(serviceA, "pg-dead-letter-worker", 200, 30_000);
      const request = leased.find((event) => event.id === deadLetterRequestId);
      assert.notEqual(request, undefined);
      for (const event of leased) {
        if (event.id !== deadLetterRequestId) {
          await runtime.markOutboxPublished(serviceA, event.id, "pg-dead-letter-worker");
        } else if (attempt < 10) {
          await runtime.markOutboxFailed(
            serviceA,
            event.id,
            "pg-dead-letter-worker",
            "provider acceptance unknown",
            { retryAt: "2020-01-01T00:00:00.000Z" },
          );
        }
      }
      if (attempt === 10) {
        const dead = await runtime.deadLetterExternalCommand(serviceA, {
          eventId: deadLetterRequestId,
          workerId: "pg-dead-letter-worker",
          error: "provider acceptance unknown after ten attempts",
        });
        assert.equal(dead.status, "dead");
      }
    }
    const reconciledCommand = await runtime.getExternalCommand(serviceA, deadLetterCommand.value.command.commandId);
    assert.equal(reconciledCommand.state, "dispatched");
    assert.equal(reconciledCommand.decisionState, "frozen");
    assert.equal(reconciledCommand.reconciliationState, "reconciliation_required");
    const reconciledAggregate = await runtime.getRecord(
      serviceA,
      deadLetterCommand.value.record.collection,
      deadLetterCommand.value.record.id,
    );
    assert.equal(reconciledAggregate.data.executionState, "reconciliation_required");
    assert.equal(reconciledAggregate.data._externalDecisionState, "frozen");

    const externalCommand = await runtime.createExternalCommand(serviceA, {
      record: {
        id: "pg-release-command-record-1",
        collection: "operations.release-commands",
        data: { state: "requested" },
      },
      commandId: "pg-release-command-record-1",
      batchId: "B127",
      operation: "certifyRelease",
      idempotencyKey: "pg-release-command-create-1",
    });
    assert.equal(externalCommand.value.command.state, "requested");
    const transitionBase = {
      commandId: "pg-release-command-record-1",
      batchId: "B127",
      operation: "certifyRelease",
      aggregateCollection: "operations.release-commands",
      aggregateId: "pg-release-command-record-1",
      providerOperationId: "release-provider-operation-1",
    };
    await runtime.transitionExternalCommand(serviceA, {
      ...transitionBase,
      toState: "dispatched",
      idempotencyKey: "pg-release-command-dispatched-1",
    });
    const claims = { status: "approved", approvalId: "approval-pg-1" };
    const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
    const unsignedBusinessEvent = {
      version: "ltm.external-business-event.v1",
      eventId: "pg-release-event-1",
      tenantId: tenantA.tenantId,
      batchId: "B127",
      operation: "certifyRelease",
      provider: trustedEvidenceKey.provider,
      subjectType: "release-command",
      subjectId: "pg-release-command-record-1",
      eventType: "release.approved",
      providerOccurredAt: new Date(Date.now() - 500).toISOString(),
      sequence: 1,
      correlationId: "pg-release-command-record-1",
      artifactSha256: "c".repeat(64),
      evidenceId: "pg-release-business-evidence-1",
      evidenceScope: "B127:certify:pg-release-command-1",
      canonicalClaims: claims,
      canonicalClaimsSha256,
    };
    const businessEvent = {
      ...unsignedBusinessEvent,
      businessEventSha256: canonicalBusinessEventSha256(unsignedBusinessEvent),
    };
    const businessEvidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: businessEvent.evidenceId,
      tenantId: businessEvent.tenantId,
      issuer: trustedEvidenceKey.issuer,
      provider: businessEvent.provider,
      environment: "sandbox",
      scope: businessEvent.evidenceScope,
      artifactSha256: businessEvent.artifactSha256,
      canonicalClaimsSha256,
      businessEventSha256: businessEvent.businessEventSha256,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce-pg-business-event-0001",
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedEvidenceKey.keyId,
    }, privateKey.export({ type: "pkcs8", format: "pem" }));
    const businessReducer = {
      name: "pg-release-approval-v1",
      locate: () => ({
        collection: "operations.release-commands",
        aggregateId: "pg-release-command-record-1",
      }),
      reduce: (event) => ({
        stateField: "state",
        allowedPriorStates: ["requested"],
        nextState: "succeeded",
        patch: { providerApprovalId: event.canonicalClaims.approvalId },
        decisionType: "release-provider-approval",
        decisionId: event.eventId,
        commandTransition: {
          commandId: "pg-release-command-record-1",
          toState: "succeeded",
          providerOperationId: "release-provider-operation-1",
        },
      }),
    };
    const appliedBusinessEvent = await runtime.applyExternalBusinessEvent(serviceA, {
      event: businessEvent,
      evidence: businessEvidence,
      reducer: businessReducer,
      idempotencyKey: "pg-release-business-event-apply-1",
    });
    assert.equal(appliedBusinessEvent.value.command.state, "succeeded");
    assert.equal(appliedBusinessEvent.value.aggregate.data.executionState, "succeeded");
    assert.equal((await runtime.applyExternalBusinessEvent(serviceA, {
      event: businessEvent,
      evidence: businessEvidence,
      reducer: businessReducer,
      idempotencyKey: "pg-release-business-event-apply-replay-1",
    })).replayed, true);
    await runtime.revokeExternalEvidence(serviceA, {
      evidenceId: businessEvidence.evidenceId,
      expectedVersion: 1,
      reason: "integration revocation projection",
      idempotencyKey: "pg-release-business-evidence-revoke-1",
    });
    const frozenCommand = await runtime.getExternalCommand(serviceA, "pg-release-command-record-1");
    assert.equal(frozenCommand.decisionState, "frozen");
    assert.equal(frozenCommand.reconciliationState, "reconciliation_required");
    const frozenAggregate = await runtime.getRecord(
      serviceA,
      "operations.release-commands",
      "pg-release-command-record-1",
    );
    assert.equal(frozenAggregate.data._externalDecisionState, "frozen");

    const audit = await runtime.verifyAuditChain(tenantA);
    assert.equal(audit.valid, true);
    assert.ok(audit.entriesChecked >= 8);

    const client = await rawPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA.tenantId]);
      const isolated = await client.query("SELECT id FROM ltm.records WHERE tenant_id=$1", [tenantB.tenantId]);
      assert.equal(isolated.rows.length, 0);
      await assert.rejects(
        client.query(
          `INSERT INTO ltm.records(tenant_id,collection,id,data)
           VALUES ($1,'projects','cross-tenant-write','{}'::jsonb)`,
          [tenantB.tenantId],
        ),
        (error) => error?.code === "42501",
      );
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA.tenantId]);
      await assert.rejects(
        client.query("UPDATE ltm.audit_log SET details='{}'::jsonb WHERE tenant_id=$1", [tenantA.tenantId]),
        (error) => error?.code === "P0001",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  } finally {
    await rawPool.end();
    await runtime.close();
  }
});

test("PostgreSQL evidence-gated mutations roll back failed writes and serialize competing consumers", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "pg-atomic-issuer",
    provider: "pg-atomic-provider",
    keyId: "pg-atomic-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B127:*"],
    allowedEnvironments: ["sandbox"],
  };
  const runtime = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    applicationName: "ltm-pg-evidence-atomic-test",
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const tenantId = "tenant-pg-evidence-atomic";
  const baseContext = actor(tenantId, "pg-atomic-register");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const register = async (suffix) => {
    const scope = `B127:atomic:${suffix}`;
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: `pg-atomic-evidence-${suffix}`,
      tenantId,
      issuer: trustedKey.issuer,
      provider: trustedKey.provider,
      environment: "sandbox",
      scope,
      artifactSha256: "e".repeat(64),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: `pg-atomic-nonce-${suffix}-2026`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedKey.keyId,
    }, privateKeyPem);
    await runtime.registerExternalEvidence(baseContext, {
      evidence,
      idempotencyKey: `pg-atomic-register-${suffix}`,
    });
    return { scope, evidenceId: evidence.evidenceId };
  };

  try {
    await runtime.createRecord(baseContext, {
      collection: "atomic.pg-records",
      id: "pg-atomic-conflict",
      data: { existing: true },
      idempotencyKey: "pg-atomic-conflict-fixture",
    });
    const rollbackEvidence = await register("rollback");
    await assert.rejects(runtime.executeEvidenceGatedMutation(
      actor(tenantId, "pg-atomic-rollback"),
      {
        scope: rollbackEvidence.scope,
        evidenceIds: [rollbackEvidence.evidenceId],
        idempotencyKey: "pg-atomic-conflicting-write",
        mutation: {
          kind: "record.create",
          input: {
            collection: "atomic.pg-records",
            id: "pg-atomic-conflict",
            data: { state: "should-not-persist" },
          },
        },
        audit: { action: "capability.B127.execute", details: { operation: "atomicRollback" } },
      },
    ), (error) => error instanceof DomainError && error.code === "VERSION_CONFLICT");
    assert.equal((await runtime.getExternalEvidence(baseContext, rollbackEvidence.evidenceId)).consumedAt, null);

    const concurrentEvidence = await register("concurrent");
    const mutation = (recordId, operationId) => runtime.executeEvidenceGatedMutation(
      actor(tenantId, operationId),
      {
        scope: concurrentEvidence.scope,
        evidenceIds: [concurrentEvidence.evidenceId],
        idempotencyKey: `pg-atomic-concurrent-${recordId}`,
        mutation: {
          kind: "record.create",
          input: {
            collection: "atomic.pg-records",
            id: recordId,
            data: { operationId },
          },
        },
        audit: { action: "capability.B127.execute", details: { operation: "atomicConcurrent" } },
      },
    );
    const outcomes = await Promise.allSettled([
      mutation("pg-atomic-winner-a", "pg-atomic-consumer-a"),
      mutation("pg-atomic-winner-b", "pg-atomic-consumer-b"),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof DomainError);
    assert.equal(rejected.reason.code, "EVIDENCE_REPLAY_DETECTED");
    assert.notEqual((await runtime.getExternalEvidence(baseContext, concurrentEvidence.evidenceId)).consumedAt, null);

    const records = await runtime.listRecords(baseContext, { collection: "atomic.pg-records", limit: 20 });
    assert.equal(records.filter((record) => record.id.startsWith("pg-atomic-winner-")).length, 1);
    assert.equal((await runtime.verifyAuditChain(baseContext)).valid, true);
  } finally {
    await runtime.close();
  }
});

test("PostgreSQL runtime rejects privileged roles before accepting traffic", {
  skip: process.env.LTM_TEST_POSTGRES_ADMIN_URL === undefined
    ? "set LTM_TEST_POSTGRES_ADMIN_URL to exercise startup role rejection"
    : false,
}, async () => {
  await assert.rejects(
    PostgresLifeTimeMachineRuntime.connect({
      connectionString: process.env.LTM_TEST_POSTGRES_ADMIN_URL,
      evidencePolicy: "disabled",
    }),
    (error) => error instanceof DomainError && error.code === "CONFIGURATION_INVALID",
  );
});

test("PostgreSQL readiness recovers after an idle pooled connection is terminated", {
  skip: connectionString === undefined || process.env.LTM_TEST_POSTGRES_ADMIN_URL === undefined
    ? "set app and admin PostgreSQL URLs to exercise transient pool recovery"
    : false,
}, async () => {
  assert.ok(connectionString);
  const runtime = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    applicationName: "ltm-readiness-recovery-test",
    evidencePolicy: "disabled",
    allowLegacyConsentPolicy: true,
  });
  const admin = new Pool({ connectionString: process.env.LTM_TEST_POSTGRES_ADMIN_URL });
  try {
    assert.equal((await runtime.readiness()).ready, true);
    const terminated = await admin.query(
      `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
       WHERE application_name='ltm-readiness-recovery-test' AND pid <> pg_backend_pid()`,
    );
    assert.ok(terminated.rows.some((row) => row.terminated === true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await runtime.readiness(), {
      ready: true,
      database: "ok",
      auditChain: "ok",
      evidenceTrust: "disabled",
      consentPolicy: "legacy_test_only",
    });
  } finally {
    await admin.end();
    await runtime.close();
  }
});
