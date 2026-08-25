import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DomainError,
  LifeTimeMachineRuntime,
  participantEvidenceScope,
  signExternalEvidence,
} from "../dist/index.js";

const NOW = new Date("2026-08-24T03:00:00.000Z");

function actor(purpose, requestId) {
  return {
    actorId: "purpose-owner-1",
    tenantId: "tenant-purpose-1",
    roles: ["consumer"],
    purpose,
    requestId,
    stepUp: false,
  };
}

function expectPurposeFailure(work) {
  assert.throws(work, (error) => error instanceof DomainError && error.code === "PURPOSE_REQUIRED");
}

test("stored processing purpose cannot be bypassed by a different active consent purpose", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-processing-purpose-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const runtime = new LifeTimeMachineRuntime({
    databasePath: join(directory, "runtime.sqlite"),
    allowLegacyConsentPolicy: true,
    clock: { now: () => NOW },
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    trustedEvidenceKeys: [{
      issuer: "participant-registry-test",
      provider: "identity-review-test",
      keyId: "participant-purpose-key-1",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["identity.participant.register:*"],
      allowedEnvironments: ["sandbox"],
    }],
  });
  const service = {
    actorId: "identity-service-1",
    tenantId: "tenant-purpose-1",
    roles: ["platform_admin", "service_account"],
    purpose: "identity_verification",
    requestId: "participant-purpose-register",
    operationId: "participant-purpose-register-operation",
    stepUp: true,
  };
  const participantId = "purpose-owner-1";
  const expiresAt = "2026-08-24T03:50:00.000Z";
  const mutation = {
    operation: "participant.register",
    tenantId: service.tenantId,
    participantId,
    ownerActorId: participantId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
  };
  const evidenceId = "participant-purpose-evidence-1";
  const scope = participantEvidenceScope(mutation);
  runtime.registerExternalEvidence(service, {
    evidence: signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: service.tenantId,
      issuer: "participant-registry-test",
      provider: "identity-review-test",
      environment: "sandbox",
      scope,
      artifactSha256: "e".repeat(64),
      issuedAt: "2026-08-24T02:59:00.000Z",
      expiresAt: "2026-08-24T04:00:00.000Z",
      nonce: "participant-purpose-nonce-0123456789",
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: "participant-purpose-key-1",
    }, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    idempotencyKey: "participant-purpose-evidence-register",
  });
  runtime.registerParticipant(service, {
    participantId,
    ownerActorId: participantId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
    evidenceId,
    idempotencyKey: "participant-purpose-register",
  });

  const purposeA = actor("purpose_a", "purpose-a-request");
  const purposeB = actor("purpose_b", "purpose-b-request");
  const recordId = "purpose-record-1";
  const consentScope = { resource: `projects:${recordId}`, actions: ["process", "delete"] };
  const consentA = runtime.grantConsent(purposeA, {
    id: "purpose-consent-a",
    participantId,
    grantorCapacity: "self",
    purpose: "purpose_a",
    scope: consentScope,
    policyVersion: "purpose-policy-a",
    evidenceHash: "a".repeat(64),
    idempotencyKey: "purpose-consent-a-grant",
  });
  const created = runtime.createRecord(purposeA, {
    collection: "projects",
    id: recordId,
    processingPurpose: "purpose_a",
    participantIds: [participantId],
    data: { state: "draft" },
    idempotencyKey: "purpose-record-create",
  });
  assert.equal(created.value.processingPurpose, "purpose_a");
  runtime.grantConsent(purposeB, {
    id: "purpose-consent-b",
    participantId,
    grantorCapacity: "self",
    purpose: "purpose_b",
    scope: consentScope,
    policyVersion: "purpose-policy-b",
    evidenceHash: "b".repeat(64),
    idempotencyKey: "purpose-consent-b-grant",
  });
  runtime.withdrawConsent(purposeA, {
    consentId: consentA.value.id,
    expectedVersion: 1,
    reason: "purpose_a_withdrawn",
    idempotencyKey: "purpose-consent-a-withdraw",
  });

  expectPurposeFailure(() => runtime.getRecord(purposeB, "projects", recordId));
  expectPurposeFailure(() => runtime.listRecords(purposeB, { collection: "projects" }));
  expectPurposeFailure(() => runtime.updateRecord(purposeB, {
    collection: "projects",
    id: recordId,
    expectedVersion: 1,
    data: { state: "ready" },
    idempotencyKey: "purpose-record-update-b",
  }));
  expectPurposeFailure(() => runtime.deleteRecord(purposeB, {
    collection: "projects",
    id: recordId,
    expectedVersion: 1,
    idempotencyKey: "purpose-record-delete-b",
  }));
  expectPurposeFailure(() => runtime.createRecord(purposeB, {
    collection: "projects",
    id: "purpose-record-mismatched-create",
    processingPurpose: "purpose_a",
    data: {},
    idempotencyKey: "purpose-record-mismatched-create",
  }));
  runtime.close();
});
