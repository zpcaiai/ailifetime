import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  DomainError,
  DurableShareGrantService,
  PostgresLifeTimeMachineRuntime,
  participantEvidenceScope,
  SHARE_EXPORT_COLLECTION,
  SHARE_REVOKE_COLLECTION,
  shareRevokeCommandId,
  signExternalEvidence,
} from "../dist/index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

function identityService(tenantId, operationId) {
  return {
    actorId: "share-pg-identity-service",
    tenantId,
    roles: ["platform_admin", "service_account"],
    purpose: "sharing",
    requestId: `request-${operationId}`,
    operationId,
    stepUp: true,
  };
}

async function registerIdentityMutationEvidence(runtime, signing, mutation, evidenceId, expiresAt) {
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: mutation.tenantId,
    issuer: signing.trustedKey.issuer,
    provider: signing.trustedKey.provider,
    environment: "sandbox",
    scope: participantEvidenceScope(mutation),
    artifactSha256: "f".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    nonce: `nonce-${evidenceId}-${randomUUID()}`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: signing.trustedKey.keyId,
  }, signing.privateKeyPem);
  await runtime.registerExternalEvidence(
    identityService(mutation.tenantId, `evidence:${evidenceId}`),
    { evidence, idempotencyKey: `evidence:${evidenceId}` },
  );
}

async function registerParticipant(runtime, signing, input) {
  const mutation = {
    operation: "participant.register",
    tenantId: input.tenantId,
    participantId: input.participantId,
    ownerActorId: input.ownerActorId,
    minorStatus: input.minorStatus,
    expiresAt: input.expiresAt,
    expectedVersion: null,
  };
  const evidenceId = `participant-${randomUUID()}`;
  await registerIdentityMutationEvidence(runtime, signing, mutation, evidenceId, signing.evidenceExpiresAt);
  return runtime.registerParticipant(
    identityService(input.tenantId, `participant-register:${input.participantId}`),
    {
      participantId: input.participantId,
      ownerActorId: input.ownerActorId,
      minorStatus: input.minorStatus,
      expiresAt: input.expiresAt,
      expectedVersion: null,
      evidenceId,
      idempotencyKey: `participant-register:${input.participantId}`,
    },
  );
}

function shareCommandInput({ commandId, ownerActorId, participantId, workId, containsMinor = false }) {
  return {
    record: {
      id: commandId,
      collection: SHARE_EXPORT_COLLECTION,
      ownerActorId,
      participantIds: [participantId],
      containsMinor,
      processingPurpose: "sharing",
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId,
        participantIds: [participantId],
        format: "single_image",
        visibility: "private",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        aiLabel: true,
        provenanceId: `provenance-${commandId}`,
        revocable: true,
        containsMinor,
        purpose: "sharing",
      },
    },
    commandId,
    batchId: "B10",
    operation: "publishExport",
    details: { requestedBy: ownerActorId },
    idempotencyKey: `create-${commandId}`,
  };
}

test("PostgreSQL persists B10 share grants and provider-confirmed revocation across processes", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const now = new Date();
  const tenantId = `tenant-share-${randomUUID()}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "share-pg-gateway",
    provider: "export-publisher",
    keyId: "share-pg-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B10:*"],
    allowedEnvironments: ["sandbox"],
  };
  const options = {
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-share-grants-pg-test",
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  };
  const serviceActor = {
    actorId: "share-pg-service",
    tenantId,
    roles: ["platform_admin", "service_account"],
    purpose: "sharing",
    requestId: "share-pg-request",
    stepUp: true,
  };
  const ownerActor = {
    actorId: "share-pg-owner",
    tenantId,
    roles: ["consumer"],
    purpose: "sharing",
    requestId: "share-pg-owner-request",
    stepUp: false,
  };
  const otherConsumer = {
    ...ownerActor,
    actorId: "share-pg-other",
    requestId: "share-pg-other-request",
  };
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const applyCallback = async (runtime, input) => {
    const claims = {
      providerOperationId: input.providerOperationId,
      ...(input.targetProviderOperationId === undefined
        ? {}
        : { targetProviderOperationId: input.targetProviderOperationId }),
    };
    const claimsDigest = canonicalBusinessClaimsSha256(claims);
    const unsigned = {
      version: "ltm.external-business-event.v1",
      eventId: input.eventId,
      tenantId,
      batchId: "B10",
      operation: input.operation,
      provider: trustedKey.provider,
      subjectType: input.operation === "publishExport" ? "export" : "export-revocation",
      subjectId: input.commandId,
      eventType: "external-command.succeeded",
      providerOccurredAt: new Date(now.getTime() + input.sequence).toISOString(),
      sequence: input.sequence,
      correlationId: input.commandId,
      artifactSha256: input.sequence === 1 ? "a".repeat(64) : "b".repeat(64),
      evidenceId: input.evidenceId,
      evidenceScope: `B10:${input.operation}:${input.commandId}`,
      canonicalClaims: claims,
      canonicalClaimsSha256: claimsDigest,
    };
    const event = { ...unsigned, businessEventSha256: canonicalBusinessEventSha256(unsigned) };
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: event.evidenceId,
      tenantId,
      issuer: trustedKey.issuer,
      provider: trustedKey.provider,
      environment: "sandbox",
      scope: event.evidenceScope,
      artifactSha256: event.artifactSha256,
      canonicalClaimsSha256: claimsDigest,
      businessEventSha256: event.businessEventSha256,
      issuedAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      nonce: `nonce-${input.evidenceId}-0123456789`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedKey.keyId,
    }, privateKeyPem);
    const collection = input.operation === "publishExport" ? SHARE_EXPORT_COLLECTION : SHARE_REVOKE_COLLECTION;
    const reducer = {
      name: `share-pg-${input.operation}-v1`,
      locate: () => ({ collection, aggregateId: input.commandId }),
      reduce: (_event, reducerContext) => {
        if (reducerContext.current === null || reducerContext.current.data.externalCommandId !== input.commandId) {
          throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "callback command binding is invalid");
        }
        if (input.operation === "revokeExport" &&
            reducerContext.current.data.targetProviderOperationId !== claims.targetProviderOperationId) {
          throw new DomainError("TENANT_SCOPE_MISMATCH", "callback targets another provider share grant");
        }
        return {
          stateField: "providerState",
          allowedPriorStates: [null],
          nextState: "succeeded",
          patch: claims,
          decisionType: input.operation === "publishExport" ? "export-publication-result" : "export-revocation-result",
          decisionId: input.eventId,
          commandTransition: {
            commandId: input.commandId,
            toState: "succeeded",
            providerOperationId: input.providerOperationId,
            evidenceId: input.evidenceId,
          },
        };
      },
    };
    return runtime.applyExternalBusinessEvent(serviceActor, {
      event,
      evidence,
      reducer,
      idempotencyKey: `share-pg-apply-${input.eventId}`,
    });
  };

  let runtime = await PostgresLifeTimeMachineRuntime.connect(options);
  const exportCommandId = `B10:${randomUUID()}`;
  try {
    await runtime.createExternalCommand(serviceActor, {
      record: {
        id: exportCommandId,
        collection: SHARE_EXPORT_COLLECTION,
        ownerActorId: ownerActor.actorId,
        data: {
          batchId: "B10",
          skill: "building-consumer-time-machine",
          operation: "publishExport",
          operationMode: "external-command",
          workId: `work-${randomUUID()}`,
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
          revocable: true,
        },
      },
      commandId: exportCommandId,
      batchId: "B10",
      operation: "publishExport",
      details: { requestedBy: ownerActor.actorId },
      idempotencyKey: "share-pg-create-export",
    });
    await runtime.transitionExternalCommand(serviceActor, {
      commandId: exportCommandId,
      batchId: "B10",
      operation: "publishExport",
      aggregateCollection: SHARE_EXPORT_COLLECTION,
      aggregateId: exportCommandId,
      toState: "dispatched",
      idempotencyKey: "share-pg-dispatch-export",
    });
    await applyCallback(runtime, {
      operation: "publishExport",
      commandId: exportCommandId,
      providerOperationId: "provider-share-pg-1",
      eventId: "share-pg-published-1",
      evidenceId: "share-pg-published-evidence-1",
      sequence: 1,
    });
    const service = new DurableShareGrantService(runtime, () => now);
    assert.equal((await service.get(ownerActor, exportCommandId)).state, "active");
    assert.equal((await service.list(ownerActor)).length, 1);
    await assert.rejects(runtime.getExternalCommand(ownerActor, exportCommandId), (error) => error?.code === "AUTH_FORBIDDEN");
    assert.equal((await runtime.getExternalCommand(serviceActor, exportCommandId)).commandId, exportCommandId);
    assert.deepEqual(await service.list(otherConsumer), []);
    await assert.rejects(service.get(otherConsumer, exportCommandId), (error) => error?.code === "AUTH_FORBIDDEN");
    await assert.rejects(service.requestRevocation(otherConsumer, {
      exportCommandId,
      reason: "attacker_request",
      idempotencyKey: "share-pg-other-revoke",
    }), (error) => error?.code === "AUTH_FORBIDDEN");
    const requested = await service.requestRevocation(ownerActor, {
      exportCommandId,
      reason: "user_requested",
      idempotencyKey: "z".repeat(200),
    });
    assert.equal(requested.value.record.data.targetProviderOperationId, "provider-share-pg-1");
    assert.equal(requested.value.grant.state, "revocation_requested");
  } finally {
    await runtime.close();
  }

  runtime = await PostgresLifeTimeMachineRuntime.connect(options);
  try {
    const service = new DurableShareGrantService(runtime, () => now);
    assert.equal((await service.get(ownerActor, exportCommandId)).state, "revocation_requested");
    const revokeCommandId = shareRevokeCommandId(exportCommandId);
    await runtime.transitionExternalCommand(serviceActor, {
      commandId: revokeCommandId,
      batchId: "B10",
      operation: "revokeExport",
      aggregateCollection: SHARE_REVOKE_COLLECTION,
      aggregateId: revokeCommandId,
      toState: "dispatched",
      idempotencyKey: "share-pg-dispatch-revoke",
    });
    await applyCallback(runtime, {
      operation: "revokeExport",
      commandId: revokeCommandId,
      providerOperationId: "provider-share-pg-revoke-1",
      targetProviderOperationId: "provider-share-pg-1",
      eventId: "share-pg-revoked-1",
      evidenceId: "share-pg-revoked-evidence-1",
      sequence: 2,
    });
    assert.equal((await service.get(ownerActor, exportCommandId)).state, "revoked");
  } finally {
    await runtime.close();
  }
});

test("PostgreSQL serializes consent and guardian-authority revocation against point-of-use grants", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const tenantId = `tenant-share-race-${randomUUID()}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "share-pg-identity-authority",
    provider: "identity-registry",
    keyId: "share-pg-identity-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["identity.*"],
    allowedEnvironments: ["sandbox"],
  };
  const options = {
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-share-consent-race-pg-test",
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  };
  const signing = {
    trustedKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    evidenceExpiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
  };
  const participantExpiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const first = await PostgresLifeTimeMachineRuntime.connect(options);
  const second = await PostgresLifeTimeMachineRuntime.connect(options);
  try {
    const owner = {
      actorId: "share-race-owner",
      tenantId,
      roles: ["consumer"],
      purpose: "sharing",
      requestId: "share-race-owner-request",
      stepUp: false,
    };
    await registerParticipant(first, signing, {
      tenantId,
      participantId: owner.actorId,
      ownerActorId: owner.actorId,
      minorStatus: "adult",
      expiresAt: participantExpiresAt,
    });
    const workId = `work-share-race-${randomUUID()}`;
    const consent = await first.grantConsent(owner, {
      id: `consent-share-race-${randomUUID()}`,
      participantId: owner.actorId,
      grantorCapacity: "self",
      purpose: "sharing",
      scope: { resource: `work:${workId}`, actions: ["share"] },
      policyVersion: "sharing-v1",
      evidenceHash: "a".repeat(64),
      idempotencyKey: `consent-share-race-${randomUUID()}`,
    });
    const commandId = `B10:${randomUUID()}`;
    const [created, withdrawn] = await Promise.allSettled([
      first.createExternalCommand(
        { ...owner, requestId: "share-race-create" },
        shareCommandInput({
          commandId,
          ownerActorId: owner.actorId,
          participantId: owner.actorId,
          workId,
        }),
      ),
      second.withdrawConsent(
        { ...owner, requestId: "share-race-withdraw" },
        {
          consentId: consent.value.id,
          expectedVersion: consent.value.version,
          reason: "concurrent_share_withdrawal",
          idempotencyKey: `withdraw-share-race-${randomUUID()}`,
        },
      ),
    ]);
    assert.equal(withdrawn.status, "fulfilled");
    if (created.status === "rejected") {
      assert.ok(created.reason instanceof DomainError);
      assert.ok(["CONSENT_REQUIRED", "CONSENT_WITHDRAWN"].includes(created.reason.code));
    } else {
      const service = identityService(tenantId, "inspect-share-race");
      const command = await first.getExternalCommand(service, commandId);
      assert.equal(command.state, "cancelled");
      const grants = new DurableShareGrantService(first);
      const projection = await grants.get(
        { ...owner, requestId: "share-race-projection", purpose: "age_transformation" },
        commandId,
      );
      assert.equal(projection.providerOperationId, null);
      assert.equal(projection.state, "revocation_required");
      const requestEvents = (await first.listOutbox(service, { limit: 200 })).filter((event) =>
        event.eventType === "external_command.requested" && event.aggregateId === commandId);
      assert.equal(requestEvents.length, 1);
      assert.equal(requestEvents[0].status, "published");
    }

    const childId = `child-share-race-${randomUUID()}`;
    const childOwnerId = `child-owner-share-race-${randomUUID()}`;
    const guardianId = `guardian-share-race-${randomUUID()}`;
    const guardian = {
      actorId: guardianId,
      tenantId,
      roles: ["guardian"],
      purpose: "sharing",
      requestId: "guardian-share-race-request",
      guardianVerified: true,
      stepUp: true,
    };
    await registerParticipant(first, signing, {
      tenantId,
      participantId: childId,
      ownerActorId: childOwnerId,
      minorStatus: "minor",
      expiresAt: participantExpiresAt,
    });
    const guardianWorkId = `work-guardian-race-${randomUUID()}`;
    const authorizationId = `guardian-authority-${randomUUID()}`;
    const authorityScope = { resource: `work:${guardianWorkId}`, actions: ["share"] };
    const authorityExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const grantMutation = {
      operation: "participant-authority.grant",
      tenantId,
      authorizationId,
      authorizedActorId: guardianId,
      participantId: childId,
      capacity: "guardian",
      scope: authorityScope,
      expiresAt: authorityExpiresAt,
    };
    const grantEvidenceId = `authority-grant-${randomUUID()}`;
    await registerIdentityMutationEvidence(first, signing, grantMutation, grantEvidenceId, signing.evidenceExpiresAt);
    await first.grantParticipantAuthority(
      identityService(tenantId, `authority-grant:${authorizationId}`),
      {
        authorizationId,
        authorizedActorId: guardianId,
        participantId: childId,
        capacity: "guardian",
        scope: authorityScope,
        expiresAt: authorityExpiresAt,
        evidenceId: grantEvidenceId,
        idempotencyKey: `authority-grant:${authorizationId}`,
      },
    );
    const revokeReason = "concurrent_guardian_authority_revocation";
    const revokeMutation = {
      operation: "participant-authority.revoke",
      tenantId,
      authorizationId,
      capacity: "guardian",
      expectedVersion: 1,
      reason: revokeReason,
    };
    const revokeEvidenceId = `authority-revoke-${randomUUID()}`;
    await registerIdentityMutationEvidence(first, signing, revokeMutation, revokeEvidenceId, signing.evidenceExpiresAt);
    const guardianConsentId = `guardian-consent-${randomUUID()}`;
    const [granted, authorityRevoked] = await Promise.allSettled([
      first.grantConsent(
        { ...guardian, requestId: "guardian-consent-race" },
        {
          id: guardianConsentId,
          participantId: childId,
          grantorCapacity: "guardian",
          purpose: "sharing",
          scope: authorityScope,
          policyVersion: "guardian-sharing-v1",
          evidenceHash: "b".repeat(64),
          idempotencyKey: `guardian-consent-race-${randomUUID()}`,
        },
      ),
      second.revokeParticipantAuthority(
        identityService(tenantId, `authority-revoke:${authorizationId}`),
        {
          authorizationId,
          capacity: "guardian",
          expectedVersion: 1,
          reason: revokeReason,
          evidenceId: revokeEvidenceId,
          idempotencyKey: `authority-revoke:${authorizationId}`,
        },
      ),
    ]);
    assert.equal(
      authorityRevoked.status,
      "fulfilled",
      authorityRevoked.status === "rejected"
        ? `authority revocation failed: ${authorityRevoked.reason?.code ?? authorityRevoked.reason?.name ?? "unknown"}`
        : undefined,
    );
    if (granted.status === "rejected") {
      assert.ok(granted.reason instanceof DomainError);
      assert.ok(
        ["AUTH_FORBIDDEN", "CONSENT_REQUIRED", "GUARDIAN_VERIFICATION_REQUIRED"].includes(granted.reason.code),
        `unexpected consent race error: ${granted.reason.code} ${JSON.stringify(granted.reason.details)}`,
      );
    }
    const consents = await first.listConsents(identityService(tenantId, "inspect-guardian-consent-race"), childId);
    assert.equal(consents.some((entry) => entry.status === "active"), false);
    if (granted.status === "fulfilled") {
      assert.equal(consents.find((entry) => entry.id === guardianConsentId)?.status, "withdrawn");
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
