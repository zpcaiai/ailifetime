import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  DomainError,
  LifeTimeMachineRuntime,
  RIGHTS_REQUEST_COLLECTION,
  SHARE_EXPORT_COLLECTION,
  participantEvidenceScope,
  rightsTaskEvidenceScope,
  signExternalEvidence,
} from "../dist/index.js";

const directory = mkdtempSync(join(tmpdir(), "ltm-rights-runtime-"));
const databasePath = join(directory, "runtime.sqlite");
const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const trustedKey = {
  issuer: "rights-identity-authority",
  provider: "rights-processor-registry",
  keyId: "rights-key-1",
  algorithm: "Ed25519",
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedScopes: ["identity.*", "B04:rights-task-receipt:v1:*"],
  allowedEnvironments: ["sandbox"],
};
const runtime = new LifeTimeMachineRuntime({
  databasePath,
  evidencePolicy: "development",
  evidenceEnvironment: "sandbox",
  trustedEvidenceKeys: [trustedKey],
  allowLegacyConsentPolicy: true,
});
const service = {
  actorId: "rights-service",
  tenantId: "tenant-rights-runtime",
  roles: ["service_account", "platform_admin"],
  purpose: "privacy_rights",
  requestId: "rights-service-request",
  stepUp: true,
};
const consumer = {
  actorId: "rights-owner",
  tenantId: service.tenantId,
  roles: ["consumer"],
  purpose: "privacy_rights",
  requestId: "rights-owner-request",
  stepUp: false,
};

after(() => {
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

function expectDomainError(fn, code) {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code);
}

function registerEvidence({ evidenceId, scope, artifactSha256, replayPolicy = "single_use" }) {
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: service.tenantId,
    issuer: trustedKey.issuer,
    provider: trustedKey.provider,
    environment: "sandbox",
    scope,
    artifactSha256,
    issuedAt,
    expiresAt,
    nonce: `rights-runtime-nonce-${evidenceId}`,
    replayPolicy,
    algorithm: "Ed25519",
    keyId: trustedKey.keyId,
  }, privateKeyPem);
  runtime.registerExternalEvidence(
    { ...service, operationId: `register-evidence:${evidenceId}` },
    { evidence, idempotencyKey: `register-evidence:${evidenceId}` },
  );
}

function registerParticipant() {
  const mutation = {
    operation: "participant.register",
    tenantId: service.tenantId,
    participantId: "participant-rights-runtime",
    ownerActorId: consumer.actorId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
  };
  registerEvidence({
    evidenceId: "rights-participant-evidence",
    scope: participantEvidenceScope(mutation),
    artifactSha256: "1".repeat(64),
  });
  runtime.registerParticipant(
    { ...service, operationId: "register-participant:rights-runtime" },
    { ...mutation, evidenceId: "rights-participant-evidence", idempotencyKey: "register-participant:rights-runtime" },
  );
}

registerParticipant();

test("rights workflow is durable, evidence-gated, idempotent and requires split review", () => {
  const submission = {
    requestId: "rights-access-1",
    participantId: "participant-rights-runtime",
    requestType: "access",
    requestedProcessingPurpose: "all",
    idempotencyKey: "submit-rights-access-1",
  };
  const created = runtime.submitRightsRequest(consumer, submission);
  assert.equal(created.replayed, false);
  assert.equal(created.value.status, "propagation_pending");
  assert.equal(created.value.progress.total, 8);
  assert.equal(runtime.submitRightsRequest(consumer, submission).replayed, true);
  expectDomainError(
    () => runtime.submitRightsRequest(consumer, { ...submission, requestType: "export" }),
    "IDEMPOTENCY_CONFLICT",
  );
  expectDomainError(
    () => runtime.getRecord(consumer, RIGHTS_REQUEST_COLLECTION, submission.requestId),
    "AUTH_FORBIDDEN",
  );

  const firstTask = created.value.tasks[0];
  const mismatchResult = "0".repeat(64);
  const mismatchOccurredAt = new Date().toISOString();
  registerEvidence({
    evidenceId: "rights-task-evidence-mismatch",
    scope: rightsTaskEvidenceScope({
      tenantId: service.tenantId,
      requestId: submission.requestId,
      task: { taskId: firstTask.taskId, target: firstTask.target, operation: "access", assetId: null },
      outcome: "succeeded",
      resultSha256: mismatchResult,
      providerOccurredAt: mismatchOccurredAt,
      errorCode: null,
    }),
    artifactSha256: "f".repeat(64),
  });
  expectDomainError(
    () => runtime.recordRightsTaskReceipt(
      { ...service, operationId: "rights-receipt:mismatch" },
      {
        requestId: submission.requestId,
        taskId: firstTask.taskId,
        outcome: "succeeded",
        resultSha256: mismatchResult,
        providerOccurredAt: mismatchOccurredAt,
        evidenceId: "rights-task-evidence-mismatch",
        idempotencyKey: "rights-receipt:mismatch",
      },
    ),
    "EXTERNAL_EVIDENCE_UNVERIFIED",
  );
  assert.equal(runtime.getRightsRequest(consumer, submission.requestId).tasks[0].attempts, 0);

  let projection = created.value;
  for (const [index, task] of projection.tasks.entries()) {
    const resultSha256 = index.toString(16).padStart(64, "0");
    const providerOccurredAt = new Date(Date.now() + index * 1_000).toISOString();
    const evidenceId = `rights-task-evidence-${index}`;
    const scope = rightsTaskEvidenceScope({
      tenantId: service.tenantId,
      requestId: submission.requestId,
      task: { taskId: task.taskId, target: task.target, operation: "access", assetId: null },
      outcome: "succeeded",
      resultSha256,
      providerOccurredAt,
      errorCode: null,
    });
    registerEvidence({ evidenceId, scope, artifactSha256: resultSha256 });
    projection = runtime.recordRightsTaskReceipt(
      { ...service, requestId: `receipt-request-${index}`, operationId: `rights-receipt:${task.taskId}` },
      {
        requestId: submission.requestId,
        taskId: task.taskId,
        outcome: "succeeded",
        resultSha256,
        providerOccurredAt,
        evidenceId,
        idempotencyKey: `rights-receipt:${task.taskId}`,
      },
    ).value;
    assert.notEqual(projection.status, "completed");
  }
  assert.equal(projection.status, "review_pending");

  const reviewer1 = {
    ...consumer,
    actorId: "privacy-reviewer-1",
    roles: ["privacy_officer"],
    requestId: "privacy-review-1",
    stepUp: true,
  };
  const reviewer2 = { ...reviewer1, actorId: "privacy-reviewer-2", requestId: "privacy-review-2" };
  const first = runtime.reviewRightsRequest(reviewer1, {
    requestId: submission.requestId,
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-runtime-1",
    idempotencyKey: "privacy-review-runtime-1",
  });
  assert.equal(first.value.status, "awaiting_second_review");
  expectDomainError(
    () => runtime.reviewRightsRequest(reviewer1, {
      requestId: submission.requestId,
      decision: "approve",
      reasonCode: "VERIFIED_COMPLETE",
      caseReference: "privacy-case-runtime-1",
      idempotencyKey: "privacy-review-runtime-same-actor",
    }),
    "AUTH_FORBIDDEN",
  );
  const completed = runtime.reviewRightsRequest(reviewer2, {
    requestId: submission.requestId,
    decision: "approve",
    reasonCode: "VERIFIED_COMPLETE",
    caseReference: "privacy-case-runtime-1",
    idempotencyKey: "privacy-review-runtime-2",
  });
  assert.equal(completed.value.status, "completed");
  assert.equal(runtime.verifyAuditChain({ ...service, purpose: "audit" }).valid, true);
});

test("authorized-agent submissions remain subject-owned and current authority controls visibility", () => {
  const authorityMutation = {
    operation: "participant-authority.grant",
    tenantId: service.tenantId,
    authorizationId: "rights-agent-authority-1",
    authorizedActorId: "rights-agent-1",
    participantId: "participant-rights-runtime",
    capacity: "authorized_agent",
    scope: { resource: "privacy.subject:participant-rights-runtime", actions: ["rights.export"] },
    expiresAt,
  };
  registerEvidence({
    evidenceId: "rights-agent-authority-evidence",
    scope: participantEvidenceScope(authorityMutation),
    artifactSha256: "2".repeat(64),
  });
  const authority = runtime.grantParticipantAuthority(
    { ...service, operationId: "grant-rights-agent-authority" },
    {
      ...authorityMutation,
      evidenceId: "rights-agent-authority-evidence",
      idempotencyKey: "grant-rights-agent-authority",
    },
  ).value;
  const agent = {
    ...consumer,
    actorId: "rights-agent-1",
    permissions: ["rights-request:create", "rights-request:create:agent", "rights-request:read:agent"],
    requestId: "rights-agent-request",
  };
  const request = runtime.submitRightsRequest(agent, {
    requestId: "rights-export-agent-1",
    participantId: "participant-rights-runtime",
    requestType: "export",
    requestedProcessingPurpose: "all",
    idempotencyKey: "rights-export-agent-1",
  }).value;
  assert.equal(runtime.getRightsRequest(agent, request.requestId).requestId, request.requestId);
  assert.equal(runtime.getRightsRequest(consumer, request.requestId).requestId, request.requestId);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const stored = database.prepare(
    "SELECT owner_actor_id,participant_ids_json FROM records WHERE collection=? AND id=?",
  ).get(RIGHTS_REQUEST_COLLECTION, request.requestId);
  database.close();
  assert.equal(stored.owner_actor_id, consumer.actorId);
  assert.deepEqual(JSON.parse(stored.participant_ids_json), ["participant-rights-runtime"]);

  const revokeMutation = {
    operation: "participant-authority.revoke",
    tenantId: service.tenantId,
    authorizationId: authority.authorizationId,
    capacity: "authorized_agent",
    expectedVersion: authority.version,
    reason: "agency ended",
  };
  registerEvidence({
    evidenceId: "rights-agent-revoke-evidence",
    scope: participantEvidenceScope(revokeMutation),
    artifactSha256: "3".repeat(64),
  });
  runtime.revokeParticipantAuthority(
    { ...service, operationId: "revoke-rights-agent-authority" },
    {
      ...revokeMutation,
      evidenceId: "rights-agent-revoke-evidence",
      idempotencyKey: "revoke-rights-agent-authority",
    },
  );
  expectDomainError(() => runtime.getRightsRequest(agent, request.requestId), "AUTH_FORBIDDEN");
  assert.equal(runtime.getRightsRequest(consumer, request.requestId).requestId, request.requestId);
});

test("restrict processing atomically disputes consent, freezes future processing, and lists beyond 50", () => {
  const processing = { ...consumer, purpose: "age_transformation", requestId: "age-processing-request" };
  const consent = runtime.grantConsent(processing, {
    participantId: "participant-rights-runtime",
    grantorCapacity: "self",
    purpose: "age_transformation",
    scope: { resource: "projects:future-project", actions: ["create"] },
    policyVersion: "legacy-v1",
    evidenceHash: "4".repeat(64),
    idempotencyKey: "rights-restriction-consent",
  }).value;
  const sharing = { ...consumer, purpose: "sharing", requestId: "sharing-processing-request" };
  const workId = "rights-restriction-work";
  const sharingConsent = runtime.grantConsent(sharing, {
    participantId: "participant-rights-runtime",
    grantorCapacity: "self",
    purpose: "sharing",
    scope: { resource: `work:${workId}`, actions: ["share"] },
    policyVersion: "legacy-v1",
    evidenceHash: "5".repeat(64),
    idempotencyKey: "rights-restriction-sharing-consent",
  }).value;
  const shareCommandId = "B10:rights-restriction-share";
  runtime.createExternalCommand(sharing, {
    record: {
      id: shareCommandId,
      collection: SHARE_EXPORT_COLLECTION,
      ownerActorId: consumer.actorId,
      participantIds: ["participant-rights-runtime"],
      processingPurpose: "sharing",
      data: {
        batchId: "B10",
        skill: "building-consumer-time-machine",
        operation: "publishExport",
        operationMode: "external-command",
        workId,
        participantIds: ["participant-rights-runtime"],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        revocable: true,
        purpose: "sharing",
      },
    },
    commandId: shareCommandId,
    batchId: "B10",
    operation: "publishExport",
    idempotencyKey: "rights-restriction-share-command",
  });
  const restricted = runtime.submitRightsRequest(consumer, {
    requestId: "rights-restrict-1",
    participantId: "participant-rights-runtime",
    requestType: "restrict_processing",
    requestedProcessingPurpose: "all",
    idempotencyKey: "rights-restrict-1",
  }).value;
  assert.equal(restricted.status, "propagation_pending");
  assert.equal(runtime.listConsents(consumer, "participant-rights-runtime").find((entry) => entry.id === consent.id).status,
    "disputed");
  assert.equal(runtime.listConsents(consumer, "participant-rights-runtime")
    .find((entry) => entry.id === sharingConsent.id).status, "disputed");
  assert.equal(runtime.getExternalCommand(service, shareCommandId).state, "cancelled");
  expectDomainError(
    () => runtime.assertConsent(processing, {
      participantIds: ["participant-rights-runtime"],
      purpose: "age_transformation",
      scope: { resource: "projects:future-project", action: "create" },
    }),
    "PROCESSING_RESTRICTED",
  );

  for (let index = 0; index < 55; index += 1) {
    runtime.submitRightsRequest(consumer, {
      requestId: `rights-list-${String(index).padStart(3, "0")}`,
      participantId: "participant-rights-runtime",
      requestType: "access",
      requestedProcessingPurpose: "all",
      idempotencyKey: `rights-list-${String(index).padStart(3, "0")}`,
    });
  }
  const listed = runtime.listRightsRequests(consumer, { limit: 100 });
  assert.ok(listed.length > 50);
  assert.equal(listed.every((entry) => !JSON.stringify(entry).includes("participant-rights-runtime")), true);
});
