import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DurableShareGrantService,
  LifeTimeMachineRuntime,
  participantEvidenceScope,
  SHARE_EXPORT_COLLECTION,
  SHARE_REVOKE_COLLECTION,
  shareRevokeCommandId,
  signExternalEvidence,
} from "../dist/index.js";

const NOW = new Date("2026-08-24T03:00:00.000Z");

function context(overrides = {}) {
  return {
    actorId: "share-service-1",
    tenantId: "tenant-share-1",
    roles: ["platform_admin", "service_account"],
    purpose: "sharing",
    requestId: "share-request-1",
    stepUp: true,
    ...overrides,
  };
}

function callbackBundle({ commandId, operation, aggregateCollection, providerOperationId, targetProviderOperationId, eventId, evidenceId, sequence }, key) {
  const claims = {
    providerOperationId,
    ...(targetProviderOperationId === undefined ? {} : { targetProviderOperationId }),
  };
  const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
  const unsigned = {
    version: "ltm.external-business-event.v1",
    eventId,
    tenantId: "tenant-share-1",
    batchId: "B10",
    operation,
    provider: "export-publisher",
    subjectType: operation === "publishExport" ? "export" : "export-revocation",
    subjectId: commandId,
    eventType: "external-command.succeeded",
    providerOccurredAt: new Date(NOW.getTime() - 5_000 + sequence).toISOString(),
    sequence,
    correlationId: commandId,
    artifactSha256: sequence.toString(16).padStart(64, "a").slice(-64),
    evidenceId,
    evidenceScope: `B10:${operation}:${commandId}`,
    canonicalClaims: claims,
    canonicalClaimsSha256,
  };
  const event = { ...unsigned, businessEventSha256: canonicalBusinessEventSha256(unsigned) };
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: event.tenantId,
    issuer: "share-callback-gateway",
    provider: event.provider,
    environment: "sandbox",
    scope: event.evidenceScope,
    artifactSha256: event.artifactSha256,
    canonicalClaimsSha256,
    businessEventSha256: event.businessEventSha256,
    issuedAt: new Date(NOW.getTime() - 10_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    nonce: `nonce-${evidenceId}-0123456789`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "share-key-1",
  }, key);
  const reducer = {
    name: `test-${operation}-signed-terminal-v1`,
    locate: () => ({ collection: aggregateCollection, aggregateId: commandId }),
    reduce: () => ({
      stateField: "providerState",
      allowedPriorStates: [null],
      nextState: "succeeded",
      patch: { providerOperationId, providerResultSha256: event.artifactSha256 },
      decisionType: operation === "publishExport" ? "export-publication-result" : "export-revocation-result",
      decisionId: eventId,
      commandTransition: {
        commandId,
        toState: "succeeded",
        providerOperationId,
        evidenceId,
      },
    }),
  };
  return { event, evidence, reducer };
}

function registerAdultParticipant(runtime, service, participantId, ownerActorId, privateKeyPem) {
  const expiresAt = "2026-08-24T03:50:00.000Z";
  const mutation = {
    operation: "participant.register",
    tenantId: service.tenantId,
    participantId,
    ownerActorId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
  };
  const scope = participantEvidenceScope(mutation);
  const evidenceId = `participant-evidence-${participantId}`;
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: service.tenantId,
    issuer: "share-callback-gateway",
    provider: "export-publisher",
    environment: "sandbox",
    scope,
    artifactSha256: "d".repeat(64),
    issuedAt: "2026-08-24T02:59:00.000Z",
    expiresAt: "2026-08-24T04:00:00.000Z",
    nonce: `participant-nonce-${participantId}-0123456789`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "share-key-1",
  }, privateKeyPem);
  runtime.registerExternalEvidence(service, {
    evidence,
    idempotencyKey: `register-participant-evidence-${participantId}`,
  });
  return runtime.registerParticipant({ ...service, operationId: `participant-register:${participantId}` }, {
    participantId,
    ownerActorId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
    evidenceId,
    idempotencyKey: `register-participant-${participantId}`,
  });
}

test("B10 share grants survive restart and become revoked only after the persisted provider callback", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-share-grants-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const runtimeOptions = {
    databasePath,
    allowLegacyConsentPolicy: true,
    clock: { now: () => NOW },
    trustedEvidenceKeys: [{
      issuer: "share-callback-gateway",
      provider: "export-publisher",
      keyId: "share-key-1",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["B10:*", "identity.participant.register:*"],
      allowedEnvironments: ["sandbox"],
    }],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  };
  const serviceActor = context();
  const ownerActor = context({
    actorId: "consumer-share-1",
    roles: ["consumer"],
    requestId: "share-owner-request-1",
    stepUp: false,
  });
  const exportCommandId = "B10:export-share-command-1";
  let runtime = new LifeTimeMachineRuntime(runtimeOptions);
  runtime.createExternalCommand(serviceActor, {
    record: {
      collection: SHARE_EXPORT_COLLECTION,
      id: exportCommandId,
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId: "work-share-1",
        participantIds: [],
        format: "single_image",
        visibility: "link",
        expiresAt: "2026-08-24T04:00:00.000Z",
        aiLabel: true,
        provenanceId: "provenance-share-1",
        revocable: true,
        containsMinor: false,
        purpose: "sharing",
      },
      ownerActorId: ownerActor.actorId,
    },
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    details: { requestedBy: ownerActor.actorId },
    idempotencyKey: "create-share-export-1",
  });
  runtime.transitionExternalCommand(serviceActor, {
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    aggregateCollection: SHARE_EXPORT_COLLECTION,
    aggregateId: exportCommandId,
    toState: "dispatched",
    idempotencyKey: "dispatch-share-export-1",
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  runtime.applyExternalBusinessEvent(serviceActor, {
    ...callbackBundle({
      commandId: exportCommandId,
      operation: "publishExport",
      aggregateCollection: SHARE_EXPORT_COLLECTION,
      providerOperationId: "provider-share-grant-1",
      eventId: "share-published-event-1",
      evidenceId: "share-published-evidence-1",
      sequence: 1,
    }, privateKeyPem),
    idempotencyKey: "apply-share-published-1",
  });

  let grants = new DurableShareGrantService(runtime);
  assert.deepEqual(await grants.get(ownerActor, exportCommandId), {
    grantId: exportCommandId,
    exportCommandId,
    exportRecordId: exportCommandId,
    workId: "work-share-1",
    expiresAt: "2026-08-24T04:00:00.000Z",
    state: "active",
    providerOperationId: "provider-share-grant-1",
    exportCommandState: "succeeded",
    revokeCommandId: null,
    revokeCommandState: null,
    updatedAt: NOW.toISOString(),
  });
  assert.equal((await grants.list(ownerActor))[0]?.providerOperationId, "provider-share-grant-1");
  const expiredView = new DurableShareGrantService(runtime, () => new Date("2026-08-24T05:00:00.000Z"));
  assert.equal((await expiredView.get(ownerActor, exportCommandId)).state, "expired");
  assert.equal((await expiredView.get(ownerActor, exportCommandId)).providerOperationId, null);
  assert.throws(
    () => runtime.getExternalCommand(ownerActor, exportCommandId),
    (error) => error && error.code === "AUTH_FORBIDDEN",
  );
  assert.equal(runtime.getExternalCommand(serviceActor, exportCommandId).commandId, exportCommandId);
  const otherConsumer = context({
    actorId: "consumer-share-other",
    roles: ["consumer"],
    requestId: "share-request-other",
    stepUp: false,
  });
  assert.deepEqual(await grants.list(otherConsumer), []);
  await assert.rejects(
    grants.get(otherConsumer, exportCommandId),
    (error) => error && error.code === "AUTH_FORBIDDEN",
  );
  await assert.rejects(
    grants.requestRevocation(otherConsumer, {
      exportCommandId,
      reason: "attacker_request",
      idempotencyKey: "other-consumer-share-revoke",
    }),
    (error) => error && error.code === "AUTH_FORBIDDEN",
  );
  runtime.close();

  runtime = new LifeTimeMachineRuntime(runtimeOptions);
  grants = new DurableShareGrantService(runtime, () => NOW);
  assert.equal((await grants.list(ownerActor))[0]?.state, "active");
  const requested = await grants.requestRevocation(ownerActor, {
    exportCommandId,
    reason: "user_requested",
    idempotencyKey: "x".repeat(200),
  });
  assert.equal(requested.replayed, false);
  assert.equal(requested.value.grant.state, "revocation_requested");
  assert.equal(requested.value.record.data.targetProviderOperationId, "provider-share-grant-1");
  assert.equal(requested.value.record.data.requestedByActorId, ownerActor.actorId);
  assert.equal(requested.value.command.commandId, shareRevokeCommandId(exportCommandId));
  assert.equal((await grants.requestRevocation(ownerActor, {
    exportCommandId,
    reason: "user_requested",
    idempotencyKey: "x".repeat(200),
  })).replayed, true);
  const revokeRequestedOutbox = runtime.listOutbox(serviceActor, { limit: 200 }).filter((event) =>
    event.aggregateType === SHARE_REVOKE_COLLECTION && event.eventType === "external_command.requested");
  assert.equal(revokeRequestedOutbox.length, 1);
  assert.equal((await grants.get(ownerActor, exportCommandId)).state, "revocation_requested");
  assert.equal((await grants.get(ownerActor, exportCommandId)).providerOperationId, null);

  const revokeCommandId = shareRevokeCommandId(exportCommandId);
  runtime.transitionExternalCommand(serviceActor, {
    commandId: revokeCommandId,
    batchId: "B10",
    operation: "revokeExport",
    aggregateCollection: SHARE_REVOKE_COLLECTION,
    aggregateId: revokeCommandId,
    toState: "dispatched",
    idempotencyKey: "dispatch-share-revoke-1",
  });
  // Dispatch and even a provider HTTP response do not revoke client truth.
  assert.equal((await grants.get(ownerActor, exportCommandId)).state, "revocation_requested");
  runtime.applyExternalBusinessEvent(serviceActor, {
    ...callbackBundle({
      commandId: revokeCommandId,
      operation: "revokeExport",
      aggregateCollection: SHARE_REVOKE_COLLECTION,
      providerOperationId: "provider-revoke-operation-1",
      targetProviderOperationId: "provider-share-grant-1",
      eventId: "share-revoked-event-1",
      evidenceId: "share-revoked-evidence-1",
      sequence: 2,
    }, privateKeyPem),
    idempotencyKey: "apply-share-revoked-1",
  });
  const revoked = await grants.get(ownerActor, exportCommandId);
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.providerOperationId, null);
  assert.equal(revoked.revokeCommandState, "succeeded");
  runtime.close();

  runtime = new LifeTimeMachineRuntime(runtimeOptions);
  grants = new DurableShareGrantService(runtime, () => NOW);
  assert.equal((await grants.get(ownerActor, exportCommandId)).state, "revoked");
  runtime.close();
});

test("withdrawing exact sharing consent atomically hides the provider reference and queues one durable revoke", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-share-withdraw-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const runtime = new LifeTimeMachineRuntime({
    databasePath,
    allowLegacyConsentPolicy: true,
    clock: { now: () => NOW },
    trustedEvidenceKeys: [{
      issuer: "share-callback-gateway",
      provider: "export-publisher",
      keyId: "share-key-1",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["B10:*", "identity.participant.register:*"],
      allowedEnvironments: ["sandbox"],
    }],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const owner = context({
    actorId: "consumer-withdraw-1",
    roles: ["consumer"],
    requestId: "share-withdraw-owner",
    stepUp: false,
  });
  const service = context({ requestId: "share-withdraw-service" });
  const participantId = "consumer-withdraw-1";
  const workId = "work-withdraw-1";
  const exportCommandId = "B10:export-withdraw-1";
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  registerAdultParticipant(runtime, service, participantId, owner.actorId, privateKeyPem);
  const consent = runtime.grantConsent(owner, {
    id: "sharing-consent-withdraw-1",
    participantId,
    grantorCapacity: "self",
    purpose: "sharing",
    scope: { resource: `work:${workId}`, actions: ["share"] },
    policyVersion: "sharing-v1",
    evidenceHash: "c".repeat(64),
    idempotencyKey: "sharing-consent-withdraw-grant-1",
  });
  runtime.createExternalCommand(service, {
    record: {
      collection: SHARE_EXPORT_COLLECTION,
      id: exportCommandId,
      ownerActorId: owner.actorId,
      participantIds: [participantId],
      processingPurpose: "sharing",
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId,
        participantIds: [participantId],
        format: "single_image",
        visibility: "link",
        expiresAt: "2026-08-24T04:00:00.000Z",
        aiLabel: true,
        provenanceId: "provenance-withdraw-1",
        revocable: true,
        containsMinor: false,
        purpose: "sharing",
      },
    },
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    details: { requestedBy: owner.actorId },
    idempotencyKey: "create-share-withdraw-export-1",
  });
  runtime.transitionExternalCommand(service, {
    commandId: exportCommandId,
    batchId: "B10",
    operation: "publishExport",
    aggregateCollection: SHARE_EXPORT_COLLECTION,
    aggregateId: exportCommandId,
    toState: "dispatched",
    idempotencyKey: "dispatch-share-withdraw-export-1",
  });
  runtime.applyExternalBusinessEvent(service, {
    ...callbackBundle({
      commandId: exportCommandId,
      operation: "publishExport",
      aggregateCollection: SHARE_EXPORT_COLLECTION,
      providerOperationId: "provider-withdraw-share-1",
      eventId: "share-withdraw-published-event-1",
      evidenceId: "share-withdraw-published-evidence-1",
      sequence: 41,
    }, privateKeyPem),
    idempotencyKey: "apply-share-withdraw-published-1",
  });
  const grants = new DurableShareGrantService(runtime, () => NOW);
  assert.equal((await grants.get(owner, exportCommandId)).providerOperationId, "provider-withdraw-share-1");

  const withdrawalInput = {
    consentId: consent.value.id,
    expectedVersion: 1,
    reason: "participant_withdrew_sharing",
    idempotencyKey: "withdraw-share-consent-1",
  };
  const withdrawn = runtime.withdrawConsent(owner, withdrawalInput);
  assert.equal(withdrawn.replayed, false);
  assert.equal(withdrawn.value.status, "withdrawn");
  assert.equal(runtime.withdrawConsent(owner, withdrawalInput).replayed, true);

  const withoutRenewedConsent = { ...owner, purpose: "age_transformation", requestId: "share-after-withdraw" };
  const projection = await grants.get(withoutRenewedConsent, exportCommandId);
  assert.equal(projection.state, "revocation_required");
  assert.equal(projection.providerOperationId, null);
  assert.equal(projection.revokeCommandId, shareRevokeCommandId(exportCommandId));
  assert.equal(projection.revokeCommandState, "requested");
  const listed = await grants.list(withoutRenewedConsent, { limit: 50 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].providerOperationId, null);
  assert.equal(listed[0].state, "revocation_required");
  const revokeEvents = runtime.listOutbox(service, { limit: 200 }).filter((event) =>
    event.aggregateType === SHARE_REVOKE_COLLECTION && event.eventType === "external_command.requested");
  assert.equal(revokeEvents.length, 1);
  runtime.close();
});

test("share grant cursor pagination returns every owner grant beyond the default fifty", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-share-pagination-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = new LifeTimeMachineRuntime({
    databasePath: join(directory, "runtime.sqlite"),
    clock: { now: () => NOW },
  });
  const owner = context({ actorId: "consumer-pagination-1", roles: ["consumer"], stepUp: false });
  const service = context({ requestId: "share-pagination-service" });
  for (let index = 0; index < 75; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const commandId = `B10:pagination-${suffix}`;
    runtime.createExternalCommand(service, {
      record: {
        collection: SHARE_EXPORT_COLLECTION,
        id: commandId,
        ownerActorId: owner.actorId,
        processingPurpose: "sharing",
        data: {
          batchId: "B10",
          skill: "building-consumer-time-machine",
          operation: "publishExport",
          operationMode: "external-command",
          workId: "same-work-pagination",
          participantIds: [],
          expiresAt: "2026-08-24T04:00:00.000Z",
          revocable: true,
          purpose: "sharing",
        },
      },
      commandId,
      batchId: "B10",
      operation: "publishExport",
      details: { requestedBy: owner.actorId },
      idempotencyKey: `share-pagination-create-${suffix}`,
    });
  }
  const grants = new DurableShareGrantService(runtime, () => NOW);
  const first = await grants.list(owner, { limit: 50 });
  const second = await grants.list(owner, { limit: 50, cursor: first.at(-1).exportRecordId });
  assert.equal(first.length, 50);
  assert.equal(second.length, 25);
  assert.equal(new Set([...first, ...second].map((grant) => grant.exportCommandId)).size, 75);
  assert.equal([...first, ...second].every((grant) => grant.workId === "same-work-pagination"), true);
  runtime.close();
});
