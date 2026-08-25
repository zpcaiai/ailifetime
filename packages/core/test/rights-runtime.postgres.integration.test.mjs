import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  DomainError,
  PostgresLifeTimeMachineRuntime,
  RIGHTS_REQUEST_COLLECTION,
  SHARE_EXPORT_COLLECTION,
  participantEvidenceScope,
  rightsAuthorityScope,
  signExternalEvidence,
} from "../dist/index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

function serviceContext(tenantId, operationId) {
  return {
    actorId: "rights-pg-identity-service",
    tenantId,
    roles: ["service_account", "platform_admin"],
    purpose: "privacy_rights",
    requestId: `request-${operationId}`,
    operationId,
    stepUp: true,
  };
}

async function registerIdentityEvidence(runtime, signing, mutation, evidenceId) {
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: mutation.tenantId,
    issuer: signing.trustedKey.issuer,
    provider: signing.trustedKey.provider,
    environment: "sandbox",
    scope: participantEvidenceScope(mutation),
    artifactSha256: "e".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: signing.evidenceExpiresAt,
    nonce: `rights-pg-${evidenceId}-${randomUUID()}`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: signing.trustedKey.keyId,
  }, signing.privateKeyPem);
  await runtime.registerExternalEvidence(serviceContext(mutation.tenantId, `evidence:${evidenceId}`), {
    evidence,
    idempotencyKey: `evidence:${evidenceId}`,
  });
}

test("PostgreSQL rights requests remain subject-owned, revalidate agent authority, and atomically restrict B10", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const tenantId = `tenant-rights-pg-${randomUUID()}`;
  const participantId = `participant-rights-pg-${randomUUID()}`;
  const ownerActorId = `owner-rights-pg-${randomUUID()}`;
  const agentActorId = `agent-rights-pg-${randomUUID()}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "rights-pg-identity-authority",
    provider: "rights-pg-identity-registry",
    keyId: "rights-pg-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["identity.*"],
    allowedEnvironments: ["sandbox"],
  };
  const options = {
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-rights-pg-integration-test",
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  };
  const signing = {
    trustedKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    evidenceExpiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
  };
  const first = await PostgresLifeTimeMachineRuntime.connect(options);
  const second = await PostgresLifeTimeMachineRuntime.connect({ ...options, applicationName: "ltm-rights-pg-racer" });
  const rawPool = new Pool({ connectionString, application_name: "ltm-rights-pg-assertions" });
  try {
    const participantExpiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const participantMutation = {
      operation: "participant.register",
      tenantId,
      participantId,
      ownerActorId,
      minorStatus: "adult",
      expiresAt: participantExpiresAt,
      expectedVersion: null,
    };
    const participantEvidenceId = `rights-pg-participant-${randomUUID()}`;
    await registerIdentityEvidence(first, signing, participantMutation, participantEvidenceId);
    await first.registerParticipant(serviceContext(tenantId, `participant:${participantId}`), {
      ...participantMutation,
      evidenceId: participantEvidenceId,
      idempotencyKey: `participant:${participantId}`,
    });

    const owner = {
      actorId: ownerActorId,
      tenantId,
      roles: ["consumer"],
      purpose: "privacy_rights",
      requestId: "rights-pg-owner-request",
      stepUp: false,
    };
    const exportAuthorityScope = rightsAuthorityScope(participantId, "export");
    const authorizationId = `rights-pg-agent-authority-${randomUUID()}`;
    const authorityMutation = {
      operation: "participant-authority.grant",
      tenantId,
      authorizationId,
      authorizedActorId: agentActorId,
      participantId,
      capacity: "authorized_agent",
      scope: { resource: exportAuthorityScope.resource, actions: [exportAuthorityScope.action] },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    const authorityEvidenceId = `rights-pg-agent-grant-${randomUUID()}`;
    await registerIdentityEvidence(first, signing, authorityMutation, authorityEvidenceId);
    const authority = (await first.grantParticipantAuthority(
      serviceContext(tenantId, `authority:${authorizationId}`),
      {
        ...authorityMutation,
        evidenceId: authorityEvidenceId,
        idempotencyKey: `authority:${authorizationId}`,
      },
    )).value;
    const agent = {
      ...owner,
      actorId: agentActorId,
      permissions: ["rights-request:create", "rights-request:create:agent", "rights-request:read:agent"],
      requestId: "rights-pg-agent-request",
    };
    const agentRequestId = `rights-pg-agent-export-${randomUUID()}`;
    await first.submitRightsRequest(agent, {
      requestId: agentRequestId,
      participantId,
      requestType: "export",
      requestedProcessingPurpose: "all",
      idempotencyKey: agentRequestId,
    });
    assert.equal((await first.getRightsRequest(agent, agentRequestId)).requestId, agentRequestId);
    assert.equal((await first.getRightsRequest(owner, agentRequestId)).requestId, agentRequestId);

    const rawClient = await rawPool.connect();
    try {
      await rawClient.query("BEGIN");
      await rawClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const stored = await rawClient.query(
        `SELECT owner_actor_id,participant_ids FROM ltm.records
         WHERE tenant_id=$1 AND collection=$2 AND id=$3`,
        [tenantId, RIGHTS_REQUEST_COLLECTION, agentRequestId],
      );
      assert.equal(stored.rows[0]?.owner_actor_id, ownerActorId);
      assert.deepEqual(stored.rows[0]?.participant_ids, [participantId]);
      await rawClient.query("ROLLBACK");
    } finally {
      rawClient.release();
    }

    const revokeMutation = {
      operation: "participant-authority.revoke",
      tenantId,
      authorizationId,
      capacity: "authorized_agent",
      expectedVersion: authority.version,
      reason: "agency ended",
    };
    const revokeEvidenceId = `rights-pg-agent-revoke-${randomUUID()}`;
    await registerIdentityEvidence(first, signing, revokeMutation, revokeEvidenceId);
    await first.revokeParticipantAuthority(serviceContext(tenantId, `revoke:${authorizationId}`), {
      ...revokeMutation,
      evidenceId: revokeEvidenceId,
      idempotencyKey: `revoke:${authorizationId}`,
    });
    await assert.rejects(
      first.getRightsRequest(agent, agentRequestId),
      (error) => error instanceof DomainError && error.code === "AUTH_FORBIDDEN",
    );
    assert.equal((await first.getRightsRequest(owner, agentRequestId)).requestId, agentRequestId);

    const workId = `rights-pg-work-${randomUUID()}`;
    const sharingOwner = { ...owner, purpose: "sharing", requestId: "rights-pg-sharing-owner" };
    const ageOwner = { ...owner, purpose: "age_transformation", requestId: "rights-pg-age-owner" };
    const sharingConsent = (await first.grantConsent(sharingOwner, {
      participantId,
      grantorCapacity: "self",
      purpose: "sharing",
      scope: { resource: `work:${workId}`, actions: ["share"] },
      policyVersion: "rights-pg-sharing-v1",
      evidenceHash: "a".repeat(64),
      idempotencyKey: `rights-pg-sharing-consent-${randomUUID()}`,
    })).value;
    const ageConsent = (await first.grantConsent(ageOwner, {
      participantId,
      grantorCapacity: "self",
      purpose: "age_transformation",
      scope: { resource: "projects:rights-pg-future", actions: ["create"] },
      policyVersion: "rights-pg-age-v1",
      evidenceHash: "b".repeat(64),
      idempotencyKey: `rights-pg-age-consent-${randomUUID()}`,
    })).value;
    const commandId = `B10:rights-pg-${randomUUID()}`;
    const restrictId = `rights-pg-restrict-${randomUUID()}`;
    const [shareCreated, restricted] = await Promise.allSettled([
      first.createExternalCommand(sharingOwner, {
        record: {
          id: commandId,
          collection: SHARE_EXPORT_COLLECTION,
          ownerActorId,
          participantIds: [participantId],
          processingPurpose: "sharing",
          data: {
            batchId: "B10",
            skill: "building-consumer-time-machine",
            operation: "publishExport",
            operationMode: "external-command",
            workId,
            participantIds: [participantId],
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            revocable: true,
            purpose: "sharing",
          },
        },
        commandId,
        batchId: "B10",
        operation: "publishExport",
        idempotencyKey: `rights-pg-share-${randomUUID()}`,
      }),
      second.submitRightsRequest({ ...owner, requestId: "rights-pg-restrict-request" }, {
        requestId: restrictId,
        participantId,
        requestType: "restrict_processing",
        requestedProcessingPurpose: "all",
        idempotencyKey: restrictId,
      }),
    ]);
    assert.equal(restricted.status, "fulfilled");
    if (shareCreated.status === "fulfilled") {
      const command = await first.getExternalCommand(serviceContext(tenantId, "inspect-rights-share"), commandId);
      assert.equal(command.state, "cancelled");
    } else {
      assert.ok(shareCreated.reason instanceof DomainError);
      assert.ok(["CONSENT_REQUIRED", "CONSENT_WITHDRAWN", "PROCESSING_RESTRICTED"].includes(shareCreated.reason.code));
    }
    const consents = await first.listConsents(owner, participantId);
    assert.equal(consents.find((entry) => entry.id === sharingConsent.id)?.status, "disputed");
    assert.equal(consents.find((entry) => entry.id === ageConsent.id)?.status, "disputed");
    await assert.rejects(
      first.assertConsent(ageOwner, {
        participantIds: [participantId],
        purpose: "age_transformation",
        scope: { resource: "projects:rights-pg-future", action: "create" },
      }),
      (error) => error instanceof DomainError && error.code === "PROCESSING_RESTRICTED",
    );
  } finally {
    await Promise.all([first.close(), second.close(), rawPool.end()]);
  }
});
