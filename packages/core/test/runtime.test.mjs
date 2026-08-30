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
  PostgresLifeTimeMachineRuntime,
  participantEvidenceScope,
  signConsentPolicyCatalog,
  signExternalEvidence,
  verifyDatabaseBackup,
} from "../dist/index.js";

test("PostgreSQL runtime rejects connection URL startup options before connecting", async () => {
  for (const parameter of [
    "options=-c%20search_path%3Dltm",
    "OPTIONS=-c%20search_path%3Dpublic",
    "Options=-c%20role%3Dpostgres&options=-c%20search_path%3Dpg_catalog",
    "%6fptions=-c%20search_path%3Dltm",
  ]) {
    await assert.rejects(
      PostgresLifeTimeMachineRuntime.connect({
        connectionString: `postgresql://runtime:secret@127.0.0.1:1/ltm?${parameter}`,
        evidencePolicy: "disabled",
      }),
      (error) => error instanceof DomainError &&
        error.code === "CONFIGURATION_INVALID" &&
        /startup options/.test(error.message),
      parameter,
    );
  }
});

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

function identityFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "identity-verifier",
    provider: "identity-registry",
    keyId: "identity-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["identity.*"],
    allowedEnvironments: ["sandbox"],
  };
  return {
    trustedKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function registerIdentityEvidence(runtime, service, privateKeyPem, evidenceId, mutation, expiresAt) {
  const scope = participantEvidenceScope(mutation);
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: service.tenantId,
    issuer: "identity-verifier",
    provider: "identity-registry",
    environment: "sandbox",
    scope,
    artifactSha256: "f".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    nonce: `nonce-${evidenceId}`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "identity-key-1",
  }, privateKeyPem);
  runtime.registerExternalEvidence(
    { ...service, operationId: `evidence-register:${evidenceId}` },
    { evidence, idempotencyKey: `evidence-register:${evidenceId}` },
  );
  return scope;
}

test("tenant CRUD is durable, optimistic, audited, and idempotent", () => {
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({ databasePath: path, allowLegacyConsentPolicy: true });
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

  const reopened = new LifeTimeMachineRuntime({ databasePath: path, allowLegacyConsentPolicy: true });
  assert.equal(reopened.getRecord(context, "projects", created.value.id).version, 2);
  assert.equal(reopened.readiness().ready, true);
  reopened.close();
});

test("durable participant ownership and exact guardian authority govern consent", () => {
  const identity = identityFixture();
  const policyKeys = generateKeyPairSync("ed25519");
  const policyIssuedAt = new Date(Date.now() - 60_000).toISOString();
  const policyExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const consentPolicyCatalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "age-transformation-policy-1",
    issuer: "privacy-policy-authority",
    environment: "sandbox",
    issuedAt: policyIssuedAt,
    expiresAt: policyExpiresAt,
    algorithm: "Ed25519",
    keyId: "age-policy-key-1",
    policies: [{
      policyVersion: "v1",
      purpose: "age_transformation",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["media.asset", "projects"],
      allowedActions: ["process", "transform"],
      grantorCapacities: ["authorized_agent", "guardian", "self"],
      minorApplicability: "all",
      disclosureSha256: "a".repeat(64),
      effectiveFrom: policyIssuedAt,
      effectiveUntil: policyExpiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, policyKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const runtime = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    trustedEvidenceKeys: [identity.trustedKey],
    consentPolicyCatalog,
    trustedConsentPolicyKeys: [{
      keyId: "age-policy-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem: policyKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedEnvironments: ["sandbox"],
      notBefore: policyIssuedAt,
      notAfter: policyExpiresAt,
    }],
    consentPolicyJurisdiction: "CN",
    consentPolicyLocale: "zh-CN",
  });
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const service = actor({
    actorId: "identity-service",
    roles: ["service_account", "platform_admin"],
    purpose: "age_transformation",
    requestId: "identity-service-request",
  });
  const registerParticipant = ({ participantId, ownerActorId, minorStatus, evidenceId }) => {
    const mutation = {
      operation: "participant.register",
      tenantId: service.tenantId,
      participantId,
      ownerActorId,
      minorStatus,
      expiresAt,
      expectedVersion: null,
    };
    registerIdentityEvidence(runtime, service, identity.privateKeyPem, evidenceId, mutation, expiresAt);
    return runtime.registerParticipant(
      { ...service, operationId: `participant-register:${participantId}` },
      { ...mutation, evidenceId, idempotencyKey: `participant-register:${participantId}` },
    ).value;
  };
  registerParticipant({
    participantId: "participant-1",
    ownerActorId: "person-1",
    minorStatus: "adult",
    evidenceId: "identity-adult-1",
  });
  registerParticipant({
    participantId: "child-1",
    ownerActorId: "child-owner-1",
    minorStatus: "minor",
    evidenceId: "identity-child-1",
  });

  const consumer = actor({
    actorId: "person-1",
    roles: ["consumer"],
    purpose: "age_transformation",
    stepUp: false,
  });
  const projectScope = { resource: "projects:project-with-consent", actions: ["process"] };
  const consent = runtime.grantConsent(consumer, {
    participantId: "participant-1",
    grantorCapacity: "self",
    purpose: "age_transformation",
    scope: projectScope,
    policyVersion: "v1",
    evidenceHash: "a".repeat(64),
    idempotencyKey: "consent-grant-1",
  });
  assert.equal(consent.value.status, "active");
  assert.equal(consent.value.evidenceHash, "a".repeat(64));
  assert.equal(consent.value.policyCatalogSha256, runtime.getConsentPolicyCatalogMetadata(actor({
    roles: ["platform_admin"],
  })).catalogSha256);
  assert.equal(consent.value.jurisdiction, "CN");
  assert.equal(consent.value.locale, "zh-CN");
  assert.equal(runtime.requireConsent(consumer, {
    participantIds: ["participant-1"],
    scope: { resource: projectScope.resource, action: "process" },
  }).length, 1);
  expectDomainError(
    () => runtime.requireConsent(consumer, {
      participantIds: ["participant-1"],
      scope: { resource: projectScope.resource, action: "delete" },
    }),
    "CONSENT_REQUIRED",
  );

  runtime.createRecord(consumer, {
    collection: "projects",
    id: "project-with-consent",
    data: { state: "draft" },
    participantIds: ["participant-1"],
    idempotencyKey: "project-consented-1",
  });
  const marketing = { ...consumer, purpose: "marketing", requestId: "marketing-request" };
  expectDomainError(
    () => runtime.createRecord(marketing, {
      collection: "projects",
      id: "project-without-marketing-consent",
      data: { state: "draft" },
      participantIds: ["participant-1"],
      idempotencyKey: "project-marketing-1",
    }),
    "CONSENT_REQUIRED",
  );

  const childScope = { resource: "media.asset:child-portrait", actions: ["transform"] };
  expectDomainError(
    () => runtime.grantConsent(consumer, {
      participantId: "child-1",
      grantorCapacity: "guardian",
      purpose: "age_transformation",
      scope: childScope,
      policyVersion: "v1",
      evidenceHash: "b".repeat(64),
      idempotencyKey: "minor-consent-invalid",
    }),
    "GUARDIAN_VERIFICATION_REQUIRED",
  );

  const authorityMutation = {
    operation: "participant-authority.grant",
    tenantId: service.tenantId,
    authorizationId: "guardian-authority-1",
    authorizedActorId: "guardian-1",
    participantId: "child-1",
    capacity: "guardian",
    scope: childScope,
    expiresAt,
  };
  registerIdentityEvidence(
    runtime,
    service,
    identity.privateKeyPem,
    "identity-guardian-1",
    authorityMutation,
    expiresAt,
  );
  runtime.grantParticipantAuthority(
    { ...service, operationId: "participant-authority:guardian-1" },
    { ...authorityMutation, evidenceId: "identity-guardian-1", idempotencyKey: "guardian-authority-grant-1" },
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
    scope: childScope,
    policyVersion: "v1",
    idempotencyKey: "minor-consent-valid",
  });
  assert.equal(minorConsent.value.isMinor, true);
  assert.equal(runtime.requireConsent(guardian, {
    participantIds: ["child-1"],
    scope: { resource: childScope.resource, action: "transform" },
  })[0].id, minorConsent.value.id);
  const unrelated = actor({ actorId: "privacy-1", roles: ["privacy_officer"], purpose: "age_transformation" });
  expectDomainError(
    () => runtime.withdrawConsent(unrelated, {
      consentId: minorConsent.value.id,
      expectedVersion: 1,
      reason: "unrelated actor cannot withdraw",
      idempotencyKey: "minor-withdraw-unrelated",
    }),
    "AUTH_FORBIDDEN",
  );
  assert.equal(runtime.withdrawConsent(guardian, {
    consentId: minorConsent.value.id,
    expectedVersion: 1,
    reason: "guardian withdrawal",
    idempotencyKey: "minor-withdraw-guardian",
  }).value.status, "withdrawn");

  const agentScope = { resource: "media.asset:adult-portrait", actions: ["transform"] };
  const agent = actor({
    actorId: "agent-1",
    roles: ["support_agent"],
    permissions: ["consent:grant:agent", "consent:read:agent", "consent:withdraw:agent"],
    purpose: "age_transformation",
  });
  expectDomainError(
    () => runtime.grantConsent(agent, {
      participantId: "participant-1",
      grantorCapacity: "authorized_agent",
      purpose: "age_transformation",
      scope: agentScope,
      policyVersion: "v1",
      evidenceHash: "d".repeat(64),
      idempotencyKey: "agent-consent-without-authority",
    }),
    "AUTH_FORBIDDEN",
  );
  const agentAuthorityMutation = {
    operation: "participant-authority.grant",
    tenantId: service.tenantId,
    authorizationId: "agent-authority-1",
    authorizedActorId: "agent-1",
    participantId: "participant-1",
    capacity: "authorized_agent",
    scope: agentScope,
    expiresAt,
  };
  registerIdentityEvidence(
    runtime,
    service,
    identity.privateKeyPem,
    "identity-agent-1",
    agentAuthorityMutation,
    expiresAt,
  );
  const agentAuthority = runtime.grantParticipantAuthority(
    { ...service, operationId: "participant-authority:agent-1" },
    { ...agentAuthorityMutation, evidenceId: "identity-agent-1", idempotencyKey: "agent-authority-grant-1" },
  ).value;
  const agentConsent = runtime.grantConsent(agent, {
    participantId: "participant-1",
    grantorCapacity: "authorized_agent",
    purpose: "age_transformation",
    scope: agentScope,
    policyVersion: "v1",
    idempotencyKey: "agent-consent-with-authority",
  }).value;
  assert.equal(runtime.listConsents(agent, "participant-1").some((entry) => entry.id === agentConsent.id), true);
  const revokeMutation = {
    operation: "participant-authority.revoke",
    tenantId: service.tenantId,
    authorizationId: agentAuthority.authorizationId,
    capacity: "authorized_agent",
    expectedVersion: agentAuthority.version,
    reason: "agency ended",
  };
  registerIdentityEvidence(
    runtime,
    service,
    identity.privateKeyPem,
    "identity-agent-revoke-1",
    revokeMutation,
    expiresAt,
  );
  runtime.revokeParticipantAuthority(
    { ...service, operationId: "participant-authority:agent-revoke-1" },
    {
      ...revokeMutation,
      evidenceId: "identity-agent-revoke-1",
      idempotencyKey: "agent-authority-revoke-1",
    },
  );
  assert.equal(runtime.listConsents(agent, "participant-1").length, 0);
  expectDomainError(
    () => runtime.assertConsent(agent, {
      participantIds: ["participant-1"],
      purpose: "age_transformation",
      scope: { resource: agentScope.resource, action: "transform" },
    }),
    "CONSENT_WITHDRAWN",
  );
  expectDomainError(
    () => runtime.withdrawConsent(agent, {
      consentId: agentConsent.id,
      expectedVersion: agentConsent.version,
      reason: "authority is no longer active",
      idempotencyKey: "agent-withdraw-after-revoke",
    }),
    "AUTH_FORBIDDEN",
  );
  const participantRevokeMutation = {
    operation: "participant.revoke",
    tenantId: service.tenantId,
    participantId: "participant-1",
    expectedVersion: 1,
    reason: "subject registry closed",
  };
  registerIdentityEvidence(
    runtime,
    service,
    identity.privateKeyPem,
    "identity-participant-revoke-1",
    participantRevokeMutation,
    expiresAt,
  );
  runtime.revokeParticipant(
    { ...service, operationId: "participant-revoke:participant-1" },
    {
      ...participantRevokeMutation,
      evidenceId: "identity-participant-revoke-1",
      idempotencyKey: "participant-revoke-1",
    },
  );
  expectDomainError(
    () => runtime.withdrawConsent(consumer, {
      consentId: consent.value.id,
      expectedVersion: consent.value.version,
      reason: "data subject confirms withdrawal after registry closure",
      idempotencyKey: "self-withdraw-after-participant-revoke",
    }),
    "CONSENT_WITHDRAWN",
  );
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
  const releaseAuthorityKeyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const releaseAuthorityPrivateKeyPem = releaseAuthorityKeyPair.privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const exactB127Scope = `ltm-evidence:v1:${"b".repeat(64)}`;
  const policyIssuedAt = new Date(Date.now() - 60_000).toISOString();
  const policyExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const consentPolicyCatalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "production-consent-policy-1",
    issuer: "privacy-policy-authority",
    environment: "production",
    issuedAt: policyIssuedAt,
    expiresAt: policyExpiresAt,
    algorithm: "Ed25519",
    keyId: "consent-policy-key-1",
    policies: [{
      policyVersion: "privacy-production-v1",
      purpose: "product_operation",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["record"],
      allowedActions: ["read"],
      grantorCapacities: ["self"],
      minorApplicability: "adult",
      disclosureSha256: "c".repeat(64),
      effectiveFrom: policyIssuedAt,
      effectiveUntil: policyExpiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, privateKeyPem);
  const consentPolicyOptions = {
    consentPolicyCatalog,
    trustedConsentPolicyKeys: [{
      keyId: "consent-policy-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem,
      allowedEnvironments: ["production"],
      notBefore: policyIssuedAt,
      notAfter: policyExpiresAt,
    }],
    consentPolicyJurisdiction: "CN",
    consentPolicyLocale: "zh-CN",
  };
  const trustedEvidenceKeys = [{
    issuer: "release-auditor",
    provider: "assurance-provider",
    keyId: "key-2026-01",
    algorithm: "Ed25519",
    publicKeyPem,
    allowedScopes: ["B127:*", exactB127Scope],
    allowedEnvironments: ["production"],
  }, {
    issuer: "independent-release-control",
    provider: "release-control:independent-board",
    keyId: "release-authority-key-2026-01",
    algorithm: "Ed25519",
    publicKeyPem: releaseAuthorityKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: [exactB127Scope],
    allowedEnvironments: ["production"],
    authorityRoles: ["b127-production-release-authority"],
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
  expectDomainError(
    () => new LifeTimeMachineRuntime({
      databasePath: databasePath(),
      evidencePolicy: "disabled",
      evidenceEnvironment: "production",
    }),
    "CONFIGURATION_INVALID",
  );
  const path = databasePath();
  const runtime = new LifeTimeMachineRuntime({
    databasePath: path,
    evidencePolicy: "production",
    evidenceEnvironment: "production",
    trustedEvidenceKeys,
    ...consentPolicyOptions,
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

  const ordinaryExactEvidence = signExternalEvidence({
    ...unsigned,
    evidenceId: "evidence-b127-ordinary-exact",
    scope: exactB127Scope,
    nonce: "nonce-b127-ordinary-exact-2026",
  }, privateKeyPem);
  runtime.registerExternalEvidence(context, {
    evidence: ordinaryExactEvidence,
    idempotencyKey: "register-b127-ordinary-exact",
  });
  const releaseMutation = (evidenceId, idempotencyKey, recordId) => ({
    scope: exactB127Scope,
    evidenceIds: [evidenceId],
    idempotencyKey,
    mutation: {
      kind: "record.create",
      input: {
        collection: "release.authorizations",
        id: recordId,
        data: { batchId: "B127", state: "approved" },
      },
    },
    audit: { action: "capability.B127.execute", details: { operation: "approveProductionRelease" } },
  });
  expectDomainError(
    () => runtime.executeEvidenceGatedMutation(context, releaseMutation(
      ordinaryExactEvidence.evidenceId,
      "reject-ordinary-b127-authority",
      "rejected-ordinary-authority",
    )),
    "EVIDENCE_TRUST_KEY_NOT_FOUND",
  );
  assert.equal(runtime.getExternalEvidence(context, ordinaryExactEvidence.evidenceId).consumedAt, null);
  const privilegedEvidence = signExternalEvidence({
    ...unsigned,
    evidenceId: "evidence-b127-release-authority",
    issuer: "independent-release-control",
    provider: "release-control:independent-board",
    keyId: "release-authority-key-2026-01",
    scope: exactB127Scope,
    nonce: "nonce-b127-release-authority-2026",
  }, releaseAuthorityPrivateKeyPem);
  runtime.registerExternalEvidence(context, {
    evidence: privilegedEvidence,
    idempotencyKey: "register-b127-release-authority",
  });
  const authorizedRelease = runtime.executeEvidenceGatedMutation(context, releaseMutation(
    privilegedEvidence.evidenceId,
    "accept-independent-b127-authority",
    "accepted-independent-authority",
  ));
  assert.equal(authorizedRelease.kind, "record.create");
  assert.notEqual(runtime.getExternalEvidence(context, privilegedEvidence.evidenceId).consumedAt, null);

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
    ...consentPolicyOptions,
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

test("evidence-gated mutations consume evidence atomically with records, transitions, commands, ledgers, audit, and outbox", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = {
    issuer: "atomic-assurance-issuer",
    provider: "atomic-assurance-provider",
    keyId: "atomic-key-1",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B127:*"],
    allowedEnvironments: ["sandbox"],
  };
  const runtime = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    trustedEvidenceKeys: [trustedKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const context = actor({ operationId: "atomic-capability-operation" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const register = (suffix) => {
    const scope = `B127:atomic:${suffix}`;
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: `atomic-evidence-${suffix}`,
      tenantId: context.tenantId,
      issuer: trustedKey.issuer,
      provider: trustedKey.provider,
      environment: "sandbox",
      scope,
      artifactSha256: "d".repeat(64),
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: `atomic-evidence-nonce-${suffix}-2026`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedKey.keyId,
    }, privateKeyPem);
    runtime.registerExternalEvidence(context, {
      evidence,
      idempotencyKey: `register-atomic-${suffix}`,
    });
    return { scope, evidenceId: evidence.evidenceId };
  };

  runtime.createRecord(context, {
    collection: "atomic.capabilities",
    id: "record-conflict",
    data: { existing: true },
    idempotencyKey: "atomic-record-conflict-fixture",
  });
  const recordEvidence = register("record");
  const outboxBeforeFailure = runtime.listOutbox(context).length;
  const conflictingMutation = {
    scope: recordEvidence.scope,
    evidenceIds: [recordEvidence.evidenceId],
    idempotencyKey: "atomic-record-conflicting-write",
    mutation: {
      kind: "record.create",
      input: {
        collection: "atomic.capabilities",
        id: "record-conflict",
        data: { state: "evidence_persisted" },
      },
    },
    audit: { action: "capability.B127.execute", details: { operation: "atomicRecord" } },
  };
  expectDomainError(() => runtime.executeEvidenceGatedMutation(context, conflictingMutation), "VERSION_CONFLICT");
  assert.equal(runtime.getExternalEvidence(context, recordEvidence.evidenceId).consumedAt, null);
  assert.equal(runtime.listOutbox(context).length, outboxBeforeFailure);

  const recordMutation = {
    ...conflictingMutation,
    idempotencyKey: "atomic-record-write",
    mutation: {
      ...conflictingMutation.mutation,
      input: { ...conflictingMutation.mutation.input, id: "record-success" },
    },
  };
  const recordResult = runtime.executeEvidenceGatedMutation(context, recordMutation);
  assert.equal(recordResult.kind, "record.create");
  assert.equal(recordResult.replayed, false);
  assert.equal(recordResult.value.id, "record-success");
  assert.notEqual(runtime.getExternalEvidence(context, recordEvidence.evidenceId).consumedAt, null);
  assert.equal(runtime.executeEvidenceGatedMutation(context, recordMutation).replayed, true);
  expectDomainError(
    () => runtime.executeEvidenceGatedMutation(
      { ...context, operationId: "competing-atomic-operation", requestId: "competing-atomic-request" },
      recordMutation,
    ),
    "EVIDENCE_REPLAY_DETECTED",
  );

  const transitionEvidence = register("transition");
  const transitionResult = runtime.executeEvidenceGatedMutation(context, {
    scope: transitionEvidence.scope,
    evidenceIds: [transitionEvidence.evidenceId],
    idempotencyKey: "atomic-transition-write",
    mutation: {
      kind: "record.transition",
      input: {
        collection: "atomic.transitions",
        id: "release-atomic",
        data: { batchId: "B127", operationMode: "state-transition" },
        stateField: "environment",
        fromState: "preview",
        toState: "staging",
        initialFromStates: ["preview"],
      },
    },
    audit: {
      action: "capability.B127.transition",
      replayAction: "capability.B127.transition-replayed",
      details: { operation: "promoteRelease" },
    },
  });
  assert.equal(transitionResult.kind, "record.transition");
  assert.equal(transitionResult.value.data.environment, "staging");

  const commandEvidence = register("command");
  const commandResult = runtime.executeEvidenceGatedMutation(context, {
    scope: commandEvidence.scope,
    evidenceIds: [commandEvidence.evidenceId],
    idempotencyKey: "atomic-command-write",
    mutation: {
      kind: "external-command.create",
      input: {
        record: {
          collection: "atomic.commands",
          id: "atomic-command-record",
          data: { operationMode: "external-command" },
        },
        commandId: "atomic-command-1",
        batchId: "B127",
        operation: "atomicCommand",
      },
    },
    audit: { action: "capability.B127.execute", details: { operation: "atomicCommand" } },
  });
  assert.equal(commandResult.kind, "external-command.create");
  assert.equal(commandResult.value.command.state, "requested");

  const ledgerEvidence = register("ledger");
  const ledgerResult = runtime.executeEvidenceGatedMutation(context, {
    scope: ledgerEvidence.scope,
    evidenceIds: [ledgerEvidence.evidenceId],
    idempotencyKey: "atomic-ledger-write",
    mutation: {
      kind: "ledger.post",
      input: {
        transactionId: "atomic-ledger-1",
        sourceType: "atomic_capability",
        sourceId: "atomic-source-1",
        description: "Atomic evidence-gated ledger post",
        lines: [
          { accountCode: "cash", direction: "debit", amountMinor: 500, currency: "USD" },
          { accountCode: "revenue", direction: "credit", amountMinor: 500, currency: "USD" },
        ],
      },
    },
    audit: { action: "capability.B127.execute", details: { operation: "atomicLedger" } },
  });
  assert.equal(ledgerResult.kind, "ledger.post");
  assert.equal(ledgerResult.value.lines.length, 2);

  const audit = runtime.listAudit(context, 200);
  assert.ok(audit.some((entry) => entry.action === "capability.B127.transition"));
  assert.ok(audit.filter((entry) => entry.action === "capability.B127.execute").length >= 3);
  const outbox = runtime.listOutbox(context, { limit: 200 });
  assert.ok(outbox.some((event) => event.eventType === "external_command.requested"));
  assert.ok(outbox.some((event) => event.eventType === "ledger.transaction.posted"));
  assert.equal(runtime.verifyAuditChain(context).valid, true);
  runtime.close();
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
  const makeBundle = ({ eventId, evidenceId, sequence, scope = "B71:pay:payment-1", correlationId = "payment-1", claims }) => {
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
      correlationId,
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
        commandId: "payment-1",
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
    commandId: "payment-1",
    batchId: "B71",
    operation: "createWeChatPayment",
    details: { channel: "wechat" },
    idempotencyKey: "create-payment-command-1",
  });
  assert.equal(created.value.command.state, "requested");
  assert.equal(created.value.record.data.executionState, "requested");
  expectDomainError(() => runtime.transitionExternalCommand(context, {
    commandId: "payment-1",
    batchId: "B71",
    operation: "createWeChatPayment",
    aggregateCollection: "commerce.wechat-payments",
    aggregateId: "payment-1",
    toState: "acknowledged",
    idempotencyKey: "illegal-ack-1",
  }), "VERSION_CONFLICT");
  const dispatchedInput = {
    commandId: "payment-1",
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
  const wrongCommandCorrelation = makeBundle({
    eventId: "wechat-event-wrong-command",
    evidenceId: "wechat-evidence-wrong-command",
    sequence: 5,
    correlationId: "payment-other",
    claims: { status: "SUCCESS", amountMinor: 500 },
  });
  expectDomainError(() => runtime.applyExternalBusinessEvent(context, {
    ...wrongCommandCorrelation,
    reducer,
    idempotencyKey: "wrong-command-correlation-1",
  }), "EVENT_FINGERPRINT_CONFLICT");
  expectDomainError(
    () => runtime.getExternalEvidence(context, wrongCommandCorrelation.evidence.evidenceId),
    "RESOURCE_NOT_FOUND",
  );
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
  assert.equal(runtime.getExternalCommand(context, "payment-1").decisionState, "frozen");
  runtime.close();
});

test("a single-use signed terminal event is the only path that reconciles a frozen external command", () => {
  const now = new Date("2026-08-20T02:00:00.000Z");
  const vendorKeys = generateKeyPairSync("ed25519");
  const wrongKeys = generateKeyPairSync("ed25519");
  const trusted = (provider, keyId, publicKey) => ({
    issuer: `${provider}-gateway`,
    provider,
    keyId,
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["B98:*"],
    allowedEnvironments: ["sandbox"],
  });
  const runtime = new LifeTimeMachineRuntime({
    databasePath: databasePath(),
    clock: { now: () => now },
    trustedEvidenceKeys: [
      trusted("vendor:vendor-1", "vendor-key-1", vendorKeys.publicKey),
      trusted("vendor:wrong-vendor", "wrong-key-1", wrongKeys.publicKey),
    ],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  const service = actor({
    actorId: "integration-service",
    roles: ["platform_admin", "service_account"],
    requestId: "frozen-reconciliation-request",
  });
  const privateKeys = {
    "vendor:vendor-1": vendorKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "vendor:wrong-vendor": wrongKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const bundle = ({
    eventId,
    evidenceId,
    eventType,
    sequence,
    provider = "vendor:vendor-1",
    subjectId = "vendor-command-1",
    replayPolicy = "single_use",
  }) => {
    const claims = { providerOperationId: "vendor-operation-1", vendorId: "vendor-1" };
    const canonicalClaimsSha256 = canonicalBusinessClaimsSha256(claims);
    const unsignedEvent = {
      version: "ltm.external-business-event.v1",
      eventId,
      tenantId: service.tenantId,
      batchId: "B98",
      operation: "createVendorProductionJob",
      provider,
      subjectType: "vendor-job",
      subjectId,
      eventType,
      providerOccurredAt: new Date(now.getTime() - 20_000 + sequence).toISOString(),
      sequence,
      correlationId: subjectId,
      artifactSha256: "9".repeat(64),
      evidenceId,
      evidenceScope: `B98:vendor-job:${subjectId}`,
      canonicalClaims: claims,
      canonicalClaimsSha256,
    };
    const event = { ...unsignedEvent, businessEventSha256: canonicalBusinessEventSha256(unsignedEvent) };
    const keyId = provider === "vendor:vendor-1" ? "vendor-key-1" : "wrong-key-1";
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: event.tenantId,
      issuer: `${provider}-gateway`,
      provider,
      environment: "sandbox",
      scope: event.evidenceScope,
      artifactSha256: event.artifactSha256,
      canonicalClaimsSha256,
      businessEventSha256: event.businessEventSha256,
      issuedAt: new Date(now.getTime() - 30_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      nonce: `nonce-${evidenceId}-0000000000`,
      replayPolicy,
      algorithm: "Ed25519",
      keyId,
    }, privateKeys[provider]);
    return { event, evidence };
  };
  const reducer = (eventType, commandState, commandId = "vendor-command-1") => ({
    name: `vendor-reconciliation-${eventType}`,
    locate: () => ({ collection: "supply.vendor-production-commands", aggregateId: commandId }),
    reduce: () => ({
      stateField: "providerState",
      allowedPriorStates: [null, "accepted", "succeeded", "failed"],
      nextState: eventType === "vendor-job.accepted" ? "accepted" : commandState ?? "production",
      patch: { providerOperationId: "vendor-operation-1", vendorId: "vendor-1" },
      decisionType: "vendor-job-provider-decision",
      decisionId: `decision-${eventType.replaceAll(".", "-")}`,
      ...(commandState === undefined ? {} : {
        commandTransition: {
          commandId,
          toState: commandState,
          providerOperationId: "vendor-operation-1",
        },
      }),
    }),
  });
  const deadLetter = (commandId, workerId) => {
    const requestEvent = runtime.listOutbox(service, { limit: 200 }).find((event) =>
      event.eventType === "external_command.requested" && event.aggregateId === commandId);
    assert.notEqual(requestEvent, undefined);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const claimed = runtime.claimOutbox(service, workerId, 200, 30_000);
      for (const event of claimed) {
        if (event.id !== requestEvent.id) {
          runtime.markOutboxPublished(service, event.id, workerId);
        } else if (attempt < 10) {
          runtime.markOutboxFailed(service, event.id, workerId, "provider result unknown", {
            retryAt: new Date(now.getTime() - 1_000).toISOString(),
          });
        }
      }
      if (attempt === 10) {
        runtime.deadLetterExternalCommand(service, {
          eventId: requestEvent.id,
          workerId,
          error: "provider result remained unknown after ten attempts",
        });
      }
    }
  };

  runtime.createExternalCommand(service, {
    record: {
      id: "vendor-command-1",
      collection: "supply.vendor-production-commands",
      data: {
        operationMode: "external-command",
        batchId: "B98",
        operation: "createVendorProductionJob",
        vendorId: "vendor-1",
      },
    },
    commandId: "vendor-command-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    idempotencyKey: "create-vendor-command-for-reconciliation",
  });
  const accepted = bundle({
    eventId: "vendor-accepted-event",
    evidenceId: "vendor-accepted-evidence",
    eventType: "vendor-job.accepted",
    sequence: 10,
  });
  runtime.applyExternalBusinessEvent(service, {
    ...accepted,
    reducer: reducer("vendor-job.accepted"),
    idempotencyKey: "apply-vendor-accepted-before-freeze",
  });

  deadLetter("vendor-command-1", "reconciliation-worker");
  assert.equal(runtime.getExternalCommand(service, "vendor-command-1").decisionState, "frozen");
  expectDomainError(() => runtime.transitionExternalCommand(service, {
    commandId: "vendor-command-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    aggregateCollection: "supply.vendor-production-commands",
    aggregateId: "vendor-command-1",
    toState: "acknowledged",
    idempotencyKey: "direct-frozen-transition-denied",
  }), "EVIDENCE_REVOKED");

  const rejected = [
    {
      value: bundle({ eventId: "nonterminal-reconcile", evidenceId: "nonterminal-reconcile-evidence", eventType: "vendor-job.production", sequence: 11 }),
      state: "acknowledged",
      code: "EVIDENCE_REVOKED",
    },
    {
      value: bundle({ eventId: "wrong-provider-reconcile", evidenceId: "wrong-provider-reconcile-evidence", eventType: "external-command.failed", sequence: 11, provider: "vendor:wrong-vendor" }),
      state: "failed",
      code: "TENANT_SCOPE_MISMATCH",
    },
    {
      value: bundle({ eventId: "wrong-subject-reconcile", evidenceId: "wrong-subject-reconcile-evidence", eventType: "external-command.failed", sequence: 11, subjectId: "other-command" }),
      state: "failed",
      code: "EVENT_FINGERPRINT_CONFLICT",
    },
    {
      value: bundle({ eventId: "stale-sequence-reconcile", evidenceId: "stale-sequence-reconcile-evidence", eventType: "external-command.failed", sequence: 9 }),
      state: "failed",
      code: "VERSION_CONFLICT",
    },
    {
      value: bundle({ eventId: "reusable-evidence-reconcile", evidenceId: "reusable-evidence-reconcile-evidence", eventType: "external-command.failed", sequence: 11, replayPolicy: "reusable" }),
      state: "failed",
      code: "EVIDENCE_REPLAY_DETECTED",
    },
  ];
  for (const candidate of rejected) {
    expectDomainError(() => runtime.applyExternalBusinessEvent(service, {
      ...candidate.value,
      reducer: reducer(candidate.value.event.eventType, candidate.state),
      idempotencyKey: `reject-${candidate.value.event.eventId}`,
    }), candidate.code);
    expectDomainError(
      () => runtime.getExternalEvidence(service, candidate.value.evidence.evidenceId),
      "RESOURCE_NOT_FOUND",
    );
  }

  const terminal = bundle({
    eventId: "terminal-reconciliation-event",
    evidenceId: "terminal-reconciliation-evidence",
    eventType: "external-command.failed",
    sequence: 11,
  });
  const applied = runtime.applyExternalBusinessEvent(service, {
    ...terminal,
    reducer: reducer(terminal.event.eventType, "failed"),
    idempotencyKey: "apply-terminal-reconciliation",
  });
  assert.equal(applied.value.command.state, "failed");
  assert.equal(applied.value.command.decisionState, "active");
  assert.equal(applied.value.command.reconciliationState, "clear");
  assert.equal(applied.value.command.details.originalFreezeReason, "outbox_dead_letter");
  assert.equal(applied.value.command.details.reconciliationEventId, terminal.event.eventId);
  assert.equal(applied.value.command.details.reconciliationEvidenceId, terminal.evidence.evidenceId);
  assert.equal(applied.value.command.details.reconciliationProvider, terminal.event.provider);
  assert.equal(applied.value.command.details.previousState, "requested");
  assert.equal(applied.value.command.details.reconciledAt, now.toISOString());
  assert.equal(applied.value.aggregate.data._externalDecisionState, "active");
  assert.equal(applied.value.aggregate.data._externalReconciliationState, "clear");
  assert.equal(applied.value.aggregate.data.externalReconciliation.reconciliationEventId, terminal.event.eventId);
  assert.equal(runtime.applyExternalBusinessEvent(service, {
    ...terminal,
    reducer: reducer(terminal.event.eventType, "failed"),
    idempotencyKey: "apply-terminal-reconciliation-replay",
  }).replayed, true);
  assert.equal(runtime.listAudit(service, 200).some((entry) => entry.action === "external_command.reconciled"), true);
  const reconciliationOutbox = runtime.listOutbox(service, { limit: 200 })
    .find((event) => event.eventType === "external_command.reconciled");
  assert.equal(reconciliationOutbox?.payload.reconciliationEventId, terminal.event.eventId);
  assert.equal(reconciliationOutbox?.payload.reconciliationEvidenceId, terminal.evidence.evidenceId);

  runtime.createExternalCommand(service, {
    record: {
      id: "vendor-command-success-1",
      collection: "supply.vendor-production-commands",
      data: {
        operationMode: "external-command",
        batchId: "B98",
        operation: "createVendorProductionJob",
        vendorId: "vendor-1",
      },
    },
    commandId: "vendor-command-success-1",
    batchId: "B98",
    operation: "createVendorProductionJob",
    idempotencyKey: "create-requested-success-reconciliation-command",
  });
  deadLetter("vendor-command-success-1", "requested-success-reconciliation-worker");
  const succeededTerminal = bundle({
    eventId: "requested-success-reconciliation-event",
    evidenceId: "requested-success-reconciliation-evidence",
    eventType: "external-command.succeeded",
    sequence: 1,
    subjectId: "vendor-command-success-1",
  });
  const succeeded = runtime.applyExternalBusinessEvent(service, {
    ...succeededTerminal,
    reducer: reducer(succeededTerminal.event.eventType, "succeeded", "vendor-command-success-1"),
    idempotencyKey: "apply-requested-success-reconciliation",
  });
  assert.equal(succeeded.value.command.state, "succeeded");
  assert.equal(succeeded.value.command.decisionState, "active");
  assert.equal(succeeded.value.command.reconciliationState, "clear");
  assert.equal(succeeded.value.command.details.previousState, "requested");
  assert.equal(succeeded.value.command.details.reconciliationSyntheticEdge, true);
  assert.equal(succeeded.value.aggregate.data.executionState, "succeeded");
  const successTransitions = runtime.listAudit(service, 500).filter((entry) =>
    entry.action === "external_command.transitioned" && entry.details.commandId === "vendor-command-success-1");
  assert.deepEqual(successTransitions.map((entry) => entry.details.toState).reverse(), [
    "dispatched",
    "acknowledged",
    "succeeded",
  ]);

  runtime.revokeExternalEvidence(service, {
    evidenceId: succeededTerminal.evidence.evidenceId,
    expectedVersion: 1,
    reason: "provider signing authority revoked the terminal assertion",
    idempotencyKey: "revoke-reconciled-terminal-evidence",
  });
  assert.equal(runtime.getExternalCommand(service, "vendor-command-success-1").decisionState, "frozen");
  const compensationAfterRevocation = bundle({
    eventId: "revoked-evidence-auto-reconciliation-event",
    evidenceId: "revoked-evidence-auto-reconciliation-evidence",
    eventType: "external-command.compensated",
    sequence: 2,
    subjectId: "vendor-command-success-1",
  });
  expectDomainError(() => runtime.applyExternalBusinessEvent(service, {
    ...compensationAfterRevocation,
    reducer: reducer(
      compensationAfterRevocation.event.eventType,
      "compensated",
      "vendor-command-success-1",
    ),
    idempotencyKey: "reject-evidence-revocation-auto-reconciliation",
  }), "EVIDENCE_REVOKED");
  expectDomainError(
    () => runtime.getExternalEvidence(service, compensationAfterRevocation.evidence.evidenceId),
    "RESOURCE_NOT_FOUND",
  );
  assert.equal(runtime.verifyAuditChain(service).valid, true);
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
  assert.equal(raw.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get().value, "5");
  for (const table of [
    "external_commands",
    "external_command_transitions",
    "evidence_decisions",
    "external_business_events",
    "participants",
    "guardian_authorizations",
    "authorized_agent_authorizations",
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
