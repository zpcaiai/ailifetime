import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  LifeTimeMachineRuntime,
  participantEvidenceScope,
  signConsentPolicyCatalog,
  signExternalEvidence,
  type ActorContext,
} from "@ltm/core";
import { capabilityEvidenceScope } from "@ltm/providers";
import { createCapabilityRegistry } from "./index.js";
import type { JsonObject, JsonValue } from "./registry.js";

interface IdentityTestState {
  readonly privateKeyPem: string;
  readonly participants: Map<string, {
    readonly ownerActorId: string;
    readonly minorStatus: "adult" | "minor";
    readonly expiresAt: string;
  }>;
}

const identityTestState = new WeakMap<LifeTimeMachineRuntime, IdentityTestState>();

function runtimeFor(testContext: TestContext): LifeTimeMachineRuntime {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    allowLegacyConsentPolicy: true,
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    trustedEvidenceKeys: [{
      issuer: "identity-verifier",
      provider: "identity-registry",
      keyId: "identity-key-1",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedScopes: ["identity.*"],
      allowedEnvironments: ["sandbox"],
    }],
  });
  identityTestState.set(runtime, {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    participants: new Map(),
  });
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

function registerIdentityEvidence(
  runtime: LifeTimeMachineRuntime,
  service: ActorContext,
  evidenceId: string,
  mutation: Parameters<typeof participantEvidenceScope>[0],
  expiresAt: string,
): void {
  const state = identityTestState.get(runtime);
  assert.ok(state !== undefined);
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: service.tenantId,
    issuer: "identity-verifier",
    provider: "identity-registry",
    environment: "sandbox",
    scope: participantEvidenceScope(mutation),
    artifactSha256: "f".repeat(64),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    nonce: `nonce-${evidenceId}`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "identity-key-1",
  }, state.privateKeyPem);
  runtime.registerExternalEvidence(
    { ...service, operationId: `evidence:${evidenceId}` },
    { evidence, idempotencyKey: `evidence:${evidenceId}` },
  );
}

function identityService(context: ActorContext, operationId: string): ActorContext {
  return {
    ...context,
    actorId: "identity-service",
    roles: ["service_account", "platform_admin"],
    requestId: `request:${operationId}`,
    operationId,
  };
}

function ensureParticipant(
  runtime: LifeTimeMachineRuntime,
  context: ActorContext,
  participantId = context.actorId,
  ownerActorId = context.actorId,
  minorStatus: "adult" | "minor" = "adult",
): string {
  const state = identityTestState.get(runtime);
  assert.ok(state !== undefined);
  const key = `${context.tenantId}:${participantId}`;
  const existing = state.participants.get(key);
  if (existing !== undefined) {
    assert.equal(existing.ownerActorId, ownerActorId);
    assert.equal(existing.minorStatus, minorStatus);
    return existing.expiresAt;
  }
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const service = identityService(context, `participant-register:${participantId}`);
  const mutation = {
    operation: "participant.register" as const,
    tenantId: context.tenantId,
    participantId,
    ownerActorId,
    minorStatus,
    expiresAt,
    expectedVersion: null,
  };
  const evidenceId = `participant-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  registerIdentityEvidence(runtime, service, evidenceId, mutation, expiresAt);
  runtime.registerParticipant(service, {
    participantId,
    ownerActorId,
    minorStatus,
    expiresAt,
    expectedVersion: null,
    evidenceId,
    idempotencyKey: `participant-register:${participantId}`,
  });
  state.participants.set(key, { ownerActorId, minorStatus, expiresAt });
  return expiresAt;
}

function grantParticipantAuthority(
  runtime: LifeTimeMachineRuntime,
  context: ActorContext,
  input: {
    readonly authorizationId: string;
    readonly authorizedActorId: string;
    readonly participantId: string;
    readonly capacity: "guardian" | "authorized_agent";
    readonly scope: { readonly resource: string; readonly actions: readonly string[] };
    readonly expiresAt: string;
  },
): void {
  const service = identityService(context, `authority-grant:${input.authorizationId}`);
  const mutation = {
    operation: "participant-authority.grant" as const,
    tenantId: context.tenantId,
    ...input,
  };
  const evidenceId = `authority-${createHash("sha256").update(input.authorizationId).digest("hex").slice(0, 24)}`;
  registerIdentityEvidence(runtime, service, evidenceId, mutation, input.expiresAt);
  runtime.grantParticipantAuthority(service, {
    ...input,
    scope: { resource: input.scope.resource, actions: [...input.scope.actions] },
    evidenceId,
    idempotencyKey: `authority-grant:${input.authorizationId}`,
  });
}

function grantAgeConsent(
  runtime: LifeTimeMachineRuntime,
  consumer: ActorContext,
  idempotencyKey: string,
  assetId = "asset-1",
) {
  ensureParticipant(runtime, consumer);
  return runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: consumer.purpose,
    scope: { resource: `media.asset:${assetId}`, actions: ["ingest", "transform"] },
    policyVersion: "privacy-v1",
    evidenceHash: "b".repeat(64),
    idempotencyKey,
  });
}

function acceptedMediaInput(assetId: string, participantIds: readonly string[]): JsonObject {
  const sourceSha256 = "1".repeat(64);
  const canonicalSha256 = "2".repeat(64);
  return {
    assetId,
    mimeType: "image/jpeg",
    byteLength: 4_096,
    faceCount: participantIds.length,
    participantIds: [...participantIds],
    magicVerified: true,
    metadataStripped: true,
    malwareState: "clean",
    sourceSha256,
    canonicalSha256,
    lineageSha256: createHash("sha256")
      .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
      .digest("hex"),
    scanEvidenceId: "scan-evidence-1",
    scannerProvider: "trusted-media-scanner",
    scanAssessedAt: "2026-08-24T00:00:00.000Z",
    participantMappingEvidenceId: "participant-map-evidence-1",
    participantMappingProvider: "trusted-participant-mapper",
    participantMappingAssessedAt: "2026-08-24T00:00:01.000Z",
    participantMapComplete: true,
    qualityDimensions: { width: 640, height: 480 },
  };
}

async function persistAcceptedMediaIntake(
  runtime: LifeTimeMachineRuntime,
  registry: ReturnType<typeof createCapabilityRegistry>,
  consumer: ActorContext,
  assetId = "asset-1",
): Promise<void> {
  await registry.execute(runtime, "B07", {
    actor: consumer,
    idempotencyKey: `accept-${assetId}`,
    input: acceptedMediaInput(assetId, [consumer.actorId]),
  });
}

async function rejectsDomainCode(promise: Promise<JsonValue>, code: DomainError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

test("B03 publishes only server-verified consent catalog metadata for an authorized platform identity", async (testContext) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const catalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "capability-consent-policy-1",
    issuer: "privacy-policy-authority",
    environment: "sandbox",
    issuedAt,
    expiresAt,
    algorithm: "Ed25519",
    keyId: "capability-consent-policy-key-1",
    policies: [{
      policyVersion: "sharing-v1",
      purpose: "sharing",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["work"],
      allowedActions: ["share"],
      grantorCapacities: ["authorized_agent", "guardian", "self"],
      minorApplicability: "all",
      disclosureSha256: "a".repeat(64),
      effectiveFrom: issuedAt,
      effectiveUntil: expiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidenceEnvironment: "sandbox",
    consentPolicyCatalog: catalog,
    trustedConsentPolicyKeys: [{
      keyId: "capability-consent-policy-key-1",
      issuer: "privacy-policy-authority",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedEnvironments: ["sandbox"],
      notBefore: issuedAt,
      notAfter: expiresAt,
    }],
    consentPolicyJurisdiction: "CN",
    consentPolicyLocale: "zh-CN",
  });
  testContext.after(() => runtime.close());
  const registry = createCapabilityRegistry();
  const admin = actor({
    actorId: "platform-admin-1",
    roles: ["platform_admin"],
    purpose: "product_operation",
  });
  const published = objectResult(await registry.execute(runtime, "B03", {
    actor: admin,
    idempotencyKey: "publish-consent-policy-1",
    input: { tenantId: admin.tenantId },
  }));
  const record = runtime.getRecord<JsonObject>(admin, "identity.consent-policy-catalogs", String(published.recordId));
  assert.equal(record.id, record.data.catalogSha256);
  assert.match(String(record.data.catalogSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual(record.data.policyVersions, ["sharing-v1"]);
  assert.equal(record.data.catalogId, "capability-consent-policy-1");
  assert.equal(record.data.issuer, "privacy-policy-authority");
  assert.equal(record.data.environment, "sandbox");
  assert.equal(record.data.jurisdiction, "CN");
  assert.equal(record.data.locale, "zh-CN");
  assert.equal(record.data.disclosureSha256, undefined);
  assert.equal(record.data.policies, undefined);

  await rejectsDomainCode(registry.execute(runtime, "B03", {
    actor: { ...admin, requestId: "reject-client-policy" },
    idempotencyKey: "publish-consent-policy-client-authored",
    input: { policies: [{ policyVersion: "caller-controlled" }] },
  }), "VALIDATION_FAILED");
  await rejectsDomainCode(registry.execute(runtime, "B03", {
    actor: actor({ permissions: ["consent-policy:publish", "record:create", "audit:append"] }),
    idempotencyKey: "publish-consent-policy-consumer",
    input: {},
  }), "AUTH_FORBIDDEN");
  const service = actor({
    actorId: "consent-policy-publisher",
    tenantId: "tenant-2",
    roles: ["service_account"],
    purpose: "product_operation",
    permissions: ["record:create"],
  });
  await rejectsDomainCode(registry.execute(runtime, "B03", {
    actor: service,
    idempotencyKey: "publish-consent-policy-service-without-permission",
    input: {},
  }), "AUTH_FORBIDDEN");
  const servicePublished = objectResult(await registry.execute(runtime, "B03", {
    actor: { ...service, permissions: ["consent-policy:publish", "record:create", "audit:append"] },
    idempotencyKey: "publish-consent-policy-service-authorized",
    input: {},
  }));
  assert.match(String(servicePublished.recordId), /^[a-f0-9]{64}$/);
});

test("B04 grants consent once, replays idempotently, and preserves the audit chain", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const guardian = actor({
    actorId: "guardian-1",
    roles: ["guardian"],
    permissions: ["audit:read"],
    guardianVerified: true,
  });
  const expiresAt = ensureParticipant(runtime, guardian, "child-1", "child-owner-1", "minor");
  const scope = { resource: "media.asset:child-1", actions: ["transform"] };
  grantParticipantAuthority(runtime, guardian, {
    authorizationId: "guardian-child-1",
    authorizedActorId: guardian.actorId,
    participantId: "child-1",
    capacity: "guardian",
    scope,
    expiresAt,
  });
  const input = {
    participantId: "child-1",
    purpose: "age_transformation",
    policyVersion: "privacy-v1",
    evidenceHash: "a".repeat(64),
    expiresAt,
    status: "active",
    grantorCapacity: "guardian",
    scope,
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
  assert.equal(runtime.verifyAuditChain(guardian).valid, true);
});

test("B14 persists an authorized illustrative timeline", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  ensureParticipant(runtime, consumer);
  runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: consumer.purpose,
    scope: { resource: "media.asset:asset-1", actions: ["ingest", "transform"] },
    policyVersion: "privacy-v1",
    evidenceHash: "b".repeat(64),
    idempotencyKey: "self-consent",
  });
  await persistAcceptedMediaIntake(runtime, registry, consumer);

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

  assert.equal(result.state, "requested");
  assert.equal(result.commandState, "requested");
  assert.equal(result.replayed, false);
  const records = runtime.listRecords(consumer, { collection: "generation.timeline-commands" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.data.jobId, "job-1");
  assert.equal(records[0]?.data.illustrativeLabel, true);
  assert.equal(records[0]?.data.operationMode, "external-command");
  const fullInput: JsonObject = {
    jobId: "job-full-21", sourceAssetId: "asset-1", participantIds: [consumer.actorId],
    targetAges: [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100],
    currentAge: 35, timelineProfile: "lifespan-21-v1", templateId: "portrait-selected-v2",
    seed: "full-seed", promptPolicyVersion: "prompt-v1", illustrativeLabel: true,
  };
  const full = objectResult(await registry.execute(runtime, "B14", {
    actor: consumer, idempotencyKey: "full-21-key", input: fullInput,
  }));
  const replay = objectResult(await registry.execute(runtime, "B14", {
    actor: consumer, idempotencyKey: "full-21-key", input: fullInput,
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.externalCommandId, full.externalCommandId);
  const persisted = runtime.listRecords(consumer, { collection: "generation.timeline-commands" });
  assert.equal(persisted.length, 2);
  const fullRecord = persisted.find((record) => record.data.jobId === "job-full-21");
  assert.ok(fullRecord);
  const plan = objectResult(fullRecord.data.generationPlan as JsonValue);
  assert.equal(plan.expectedImageCount, 21);
  assert.equal(plan.currentAge, 35);
  assert.equal(plan.templateId, "portrait-selected-v2");
  assert.ok(Array.isArray(plan.nodes));
  assert.equal(plan.nodes.length, 21);
  assert.deepEqual(plan.nodes.map((node) => objectResult(node).targetAge), fullInput.targetAges);
  assert.ok(plan.nodes.every((node) => objectResult(node).sourceAssetId === "asset-1"));
  assert.equal(fullRecord.data.commandState, "requested");
});

test("B09 applies stateful generation transitions, replays, and rejects stale state", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  ensureParticipant(runtime, consumer);
  runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: consumer.purpose,
    scope: { resource: "generation.jobs:stateful-job-1", actions: ["process"] },
    policyVersion: "privacy-v1",
    evidenceHash: "c".repeat(64),
    idempotencyKey: "generation-job-consent",
  });
  const transitionInput = {
    jobId: "stateful-job-1",
    participantIds: [consumer.actorId],
    fromState: "queued",
    toState: "preflight",
    requestFingerprint: "fingerprint-1",
    milestones: ["request_accepted"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B09", {
      actor: consumer,
      idempotencyKey: "queued-to-preflight",
      input: transitionInput,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B09", {
      actor: { ...consumer, requestId: "generation-job-replay" },
      idempotencyKey: "queued-to-preflight",
      input: transitionInput,
    }),
  );

  assert.equal(first.state, "preflight");
  assert.equal(first.previousState, "queued");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const aggregate = runtime.getRecord(consumer, "generation.jobs", "stateful-job-1");
  assert.equal(aggregate.data.state, "preflight");
  assert.equal(aggregate.data.transitionCount, 1);

  await rejectsDomainCode(
    registry.execute(runtime, "B09", {
      actor: { ...consumer, requestId: "generation-job-stale" },
      idempotencyKey: "stale-queued-to-preflight",
      input: transitionInput,
    }),
    "VERSION_CONFLICT",
  );
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

test("B01 creates one stable architecture resource and rejects identity overwrite", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const platformActor = actor({
    actorId: "platform-1",
    roles: ["platform_admin"],
    purpose: "platform_architecture",
    requestId: "architecture-resource",
  });
  const input = {
    tenantId: platformActor.tenantId,
    repositoryId: "repository-1",
    stackProfile: "typescript-sqlite",
    boundedContexts: ["consumer", "media"],
    healthChecks: ["liveness", "readiness"],
    ownershipRules: ["single-owner-per-context"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B01", {
      actor: platformActor,
      idempotencyKey: "architecture-resource-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B01", {
      actor: { ...platformActor, requestId: "architecture-resource-replay" },
      idempotencyKey: "architecture-resource-1",
      input,
    }),
  );

  assert.equal(first.state, "persisted");
  assert.equal(first.recordId, "repository-1");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const architecture = runtime.getRecord(platformActor, "platform.architectures", "repository-1");
  assert.equal(architecture.data.operationMode, "resource");
  assert.equal(architecture.data.stackProfile, "typescript-sqlite");

  await rejectsDomainCode(
    registry.execute(runtime, "B01", {
      actor: { ...platformActor, requestId: "architecture-resource-conflict" },
      idempotencyKey: "architecture-resource-conflict",
      input: { ...input, stackProfile: "different-stack" },
    }),
    "VERSION_CONFLICT",
  );
});

test("B00, B01 and B02 reject consumer control-plane writes even with generic record permission", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor({ permissions: ["record:create"] });
  await rejectsDomainCode(
    registry.execute(runtime, "B00", {
      actor: consumer,
      idempotencyKey: "consumer-repository-baseline",
      input: {
        repositoryId: "consumer-repository",
        repositoryKind: "monorepo",
        baseCommit: "abcdef1",
        inventoryHash: "a".repeat(64),
        inventory: { stack: "typescript" },
        commandResults: { build: "passed" },
        riskIds: ["risk-1"],
      },
    }),
    "AUTH_FORBIDDEN",
  );
  await rejectsDomainCode(
    registry.execute(runtime, "B01", {
      actor: consumer,
      idempotencyKey: "consumer-platform-architecture",
      input: {
        repositoryId: "consumer-repository",
        stackProfile: "all-typescript",
        boundedContexts: ["identity", "generation"],
        healthChecks: ["liveness", "readiness"],
        ownershipRules: ["tenant-scoped"],
      },
    }),
    "AUTH_FORBIDDEN",
  );
  await rejectsDomainCode(
    registry.execute(runtime, "B02", {
      actor: { ...consumer, requestId: "consumer-contract-publication" },
      idempotencyKey: "consumer-platform-contract",
      input: {
        contractVersion: "consumer-v1",
        schemaVersion: "1.0.0",
        aggregateTypes: ["Project"],
        compatibility: "backward",
        sensitiveFieldsClassified: true,
      },
    }),
    "AUTH_FORBIDDEN",
  );
});

test("B50 terminates local orchestration at factory_attested and cannot mint production certification", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const platformActor = actor({
    actorId: "platform-orchestrator",
    roles: ["platform_admin"],
    purpose: "platform_orchestration",
    requestId: "b50-planned-ready",
  });
  const base = {
    orchestrationId: "full-commercial-orchestration",
    batchId: "B50",
    branch: "feat/b50",
    worktree: "/workspace/b50",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    dependencyBatchIds: [],
    verifiedDependencyIds: [],
  };
  const transitions = [
    ["planned", "ready"],
    ["ready", "running"],
    ["running", "review"],
    ["review", "merged"],
    ["merged", "factory_attested"],
  ] as const;
  for (const [index, [fromState, toState]] of transitions.entries()) {
    const result = objectResult(await registry.execute(runtime, "B50", {
      actor: { ...platformActor, requestId: `b50-${index}` },
      idempotencyKey: `b50-${index}`,
      input: {
        ...base,
        fromState,
        toState,
        evidenceIds: ["code-evidence-1"],
      },
    }));
    assert.equal(result.state, toState);
  }
  const record = runtime.getRecord(platformActor, "orchestration.batches", "B50");
  assert.equal(record.data.state, "factory_attested");

  await rejectsDomainCode(
    registry.execute(runtime, "B50", {
      actor: { ...platformActor, requestId: "b50-production-word" },
      idempotencyKey: "b50-production-word",
      input: { ...base, fromState: "merged", toState: "certified", evidenceIds: ["code-evidence-1"] },
    }),
    "VALIDATION_FAILED",
  );
  await rejectsDomainCode(
    registry.execute(runtime, "B50", {
      actor: { ...platformActor, requestId: "b50-external-evidence-injection" },
      idempotencyKey: "b50-external-evidence-injection",
      input: {
        ...base,
        fromState: "merged",
        toState: "factory_attested",
        evidenceIds: ["code-evidence-1"],
        externalEvidenceIds: ["fake-production-certificate"],
      },
    }),
    "VALIDATION_FAILED",
  );
});

test("B08 and B14 reject source media that has not passed the B07 intake gate", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  grantAgeConsent(runtime, consumer, "missing-b07-consent", "asset-without-b07");

  await rejectsDomainCode(
    registry.execute(runtime, "B08", {
      actor: consumer,
      idempotencyKey: "composition-without-b07",
      input: {
        draftId: "draft-without-b07",
        sourceAssetId: "asset-without-b07",
        templateId: "timeline-classic-v1",
        participantIds: [consumer.actorId],
        targetAges: [18, 80],
        composition: { sourceAssetIds: ["asset-without-b07"], layout: "timeline" },
        illustrativeLabel: true,
      },
    }),
    "VALIDATION_FAILED",
  );
  await rejectsDomainCode(
    registry.execute(runtime, "B14", {
      actor: consumer,
      idempotencyKey: "timeline-without-b07",
      input: {
        jobId: "job-without-b07",
        sourceAssetId: "asset-without-b07",
        participantIds: [consumer.actorId],
        targetAges: [18, 80],
        seed: "seed-without-b07",
        promptPolicyVersion: "prompt-v1",
        illustrativeLabel: true,
      },
    }),
    "VALIDATION_FAILED",
  );
  assert.equal(runtime.listRecords(consumer, { collection: "consumer.composition-drafts" }).length, 0);
  assert.equal(runtime.listRecords(consumer, { collection: "generation.timeline-commands" }).length, 0);
});

test("B07 rejects a source-to-canonical digest lineage mismatch before persistence", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  grantAgeConsent(runtime, consumer, "invalid-media-lineage-consent", "asset-invalid-lineage");
  await rejectsDomainCode(
    registry.execute(runtime, "B07", {
      actor: consumer,
      idempotencyKey: "invalid-media-lineage",
      input: { ...acceptedMediaInput("asset-invalid-lineage", [consumer.actorId]), lineageSha256: "0".repeat(64) },
    }),
    "VALIDATION_FAILED",
  );
  assert.equal(runtime.listRecords(consumer, { collection: "media.intake-results" }).length, 0);
});

test("B14 rejects generation when the B07 participant consent was withdrawn", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor();
  const consent = grantAgeConsent(runtime, consumer, "temporary-media-consent");
  await persistAcceptedMediaIntake(runtime, registry, consumer);
  runtime.withdrawConsent(consumer, {
    consentId: consent.value.id,
    expectedVersion: consent.value.version,
    reason: "exercise the generation consent gate",
    idempotencyKey: "withdraw-temporary-media-consent",
  });
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
    "CONSENT_WITHDRAWN",
  );
});

test("B10 share lifetime is bounded by product policy and exact consent/participant authority", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const consumer = actor({ purpose: "sharing", requestId: "b10-lifetime" });
  ensureParticipant(runtime, consumer);
  const workId = "work-b10-lifetime-1";
  const consentExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  runtime.grantConsent(consumer, {
    participantId: consumer.actorId,
    grantorCapacity: "self",
    purpose: "sharing",
    scope: { resource: `work:${workId}`, actions: ["share"] },
    policyVersion: "sharing-v1",
    evidenceHash: "d".repeat(64),
    expiresAt: consentExpiresAt,
    idempotencyKey: "b10-lifetime-consent",
  });
  const baseInput: JsonObject = {
    workId,
    participantIds: [consumer.actorId],
    format: "single_image",
    visibility: "link",
    aiLabel: true,
    provenanceId: "provenance-b10-lifetime-1",
    revocable: true,
    containsMinor: false,
  };
  const accepted = objectResult(await registry.execute(runtime, "B10", {
    actor: consumer,
    idempotencyKey: "b10-lifetime-accepted",
    input: { ...baseInput, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() },
  }));
  assert.equal(accepted.commandState, "requested");

  await rejectsDomainCode(registry.execute(runtime, "B10", {
    actor: { ...consumer, requestId: "b10-after-consent-cutoff" },
    idempotencyKey: "b10-after-consent-cutoff",
    input: { ...baseInput, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  }), "CONSENT_REQUIRED");
  await rejectsDomainCode(registry.execute(runtime, "B10", {
    actor: { ...consumer, requestId: "b10-over-product-maximum" },
    idempotencyKey: "b10-over-product-maximum",
    input: { ...baseInput, expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60_000).toISOString() },
  }), "VALIDATION_FAILED");

  const guardian = actor({
    actorId: "guardian-b10-lifetime",
    roles: ["guardian"],
    guardianVerified: true,
    purpose: "sharing",
    requestId: "guardian-b10-lifetime",
  });
  const childId = "child-b10-lifetime";
  const guardianWorkId = "work-b10-guardian-lifetime";
  ensureParticipant(runtime, guardian, childId, "child-owner-b10-lifetime", "minor");
  const authorityExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  grantParticipantAuthority(runtime, guardian, {
    authorizationId: "guardian-b10-lifetime-authority",
    authorizedActorId: guardian.actorId,
    participantId: childId,
    capacity: "guardian",
    scope: { resource: `work:${guardianWorkId}`, actions: ["share"] },
    expiresAt: authorityExpiresAt,
  });
  runtime.grantConsent(guardian, {
    participantId: childId,
    grantorCapacity: "guardian",
    purpose: "sharing",
    scope: { resource: `work:${guardianWorkId}`, actions: ["share"] },
    policyVersion: "guardian-sharing-v1",
    evidenceHash: "e".repeat(64),
    idempotencyKey: "guardian-b10-lifetime-consent",
  });
  await rejectsDomainCode(registry.execute(runtime, "B10", {
    actor: guardian,
    idempotencyKey: "guardian-b10-after-authority-cutoff",
    input: {
      ...baseInput,
      workId: guardianWorkId,
      participantIds: [childId],
      visibility: "private",
      containsMinor: true,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  }), "CONSENT_REQUIRED");
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

test("B34 closes a balanced partner settlement once and rejects allocation drift", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const financeActor = actor({
    actorId: "partner-finance-1",
    roles: ["finance_operator"],
    purpose: "partner_settlement",
    requestId: "partner-settlement",
    stepUp: true,
  });
  const input = {
    settlementId: "settlement-1",
    partnerId: "partner-1",
    contractVersion: "partner-contract-v3",
    period: "2026-08",
    meterState: "reconciled",
    paymentState: "settled",
    grossMinor: 10_000,
    platformMinor: 2_500,
    partnerMinor: 7_000,
    refundMinor: 500,
    currency: "USD",
  };

  const first = objectResult(
    await registry.execute(runtime, "B34", {
      actor: financeActor,
      idempotencyKey: "partner-settlement-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B34", {
      actor: { ...financeActor, requestId: "partner-settlement-replay" },
      idempotencyKey: "partner-settlement-1",
      input,
    }),
  );

  assert.equal(first.state, "posted");
  assert.equal(first.transactionId, "settlement-1");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const transaction = runtime.getLedgerTransaction(financeActor, "settlement-1");
  assert.equal(
    transaction.lines.filter((line) => line.direction === "debit").reduce((sum, line) => sum + line.amountMinor, 0),
    10_000,
  );
  assert.equal(
    transaction.lines.filter((line) => line.direction === "credit").reduce((sum, line) => sum + line.amountMinor, 0),
    10_000,
  );

  await rejectsDomainCode(
    registry.execute(runtime, "B34", {
      actor: { ...financeActor, requestId: "partner-settlement-drift" },
      idempotencyKey: "partner-settlement-drift",
      input: { ...input, settlementId: "settlement-drift", partnerMinor: 6_999 },
    }),
    "VALIDATION_FAILED",
  );
});

test("B41 deduplicates analytics inbox events and rejects event ID payload drift", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const analyticsActor = actor({
    actorId: "analytics-service-1",
    roles: ["platform_admin"],
    purpose: "product_analytics",
    requestId: "analytics-event",
  });
  const input = {
    eventId: "analytics-event-1",
    eventType: "timeline.completed",
    schemaVersion: "v1",
    occurredAt: "2026-08-20T01:00:00.000Z",
    receivedAt: "2026-08-20T01:00:01.000Z",
    actorPseudonym: "subject-hash-1",
    dimensions: { surface: "web", plan: "consumer" },
    metricNames: ["timeline_completion"],
  };

  const first = objectResult(
    await registry.execute(runtime, "B41", {
      actor: analyticsActor,
      idempotencyKey: "analytics-ingest-1",
      input,
    }),
  );
  const replay = objectResult(
    await registry.execute(runtime, "B41", {
      actor: { ...analyticsActor, requestId: "analytics-event-replay" },
      idempotencyKey: "analytics-ingest-replay",
      input,
    }),
  );

  assert.equal(first.state, "received");
  assert.equal(first.replayed, false);
  assert.equal(replay.eventId, first.eventId);
  assert.equal(replay.replayed, true);
  const inboxEvent = runtime.getInboxEvent(analyticsActor, String(first.eventId));
  assert.equal(inboxEvent.sourceEventId, "analytics-event-1");
  assert.equal(inboxEvent.payload.operationMode, "inbox-event");

  await rejectsDomainCode(
    registry.execute(runtime, "B41", {
      actor: { ...analyticsActor, requestId: "analytics-event-conflict" },
      idempotencyKey: "analytics-ingest-conflict",
      input: { ...input, dimensions: { surface: "mobile", plan: "consumer" } },
    }),
    "EVENT_FINGERPRINT_CONFLICT",
  );
});

test("B26 validates payment invariants before staging an external checkout command", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const commerceActor = actor({
    actorId: "commerce-service-1",
    roles: ["platform_admin"],
    purpose: "checkout",
    requestId: "checkout-command",
  });
  const input = {
    checkoutId: "checkout-1",
    quoteId: "quote-1",
    quoteState: "active",
    paymentAuthorizationId: "payment-authorization-1",
    paymentState: "authorized",
    quotedMinor: 4_999,
    authorizedMinor: 4_999,
    currency: "USD",
  };

  const result = objectResult(
    await registry.execute(runtime, "B26", {
      actor: commerceActor,
      idempotencyKey: "checkout-1",
      input,
    }),
  );

  assert.equal(result.state, "requested");
  const command = runtime.getRecord(commerceActor, "commerce.checkout-commands", "checkout-1");
  assert.equal(command.data.operationMode, "external-command");
  assert.equal(command.data.executionState, "requested");
  assert.equal(command.data.externalCommandId, "checkout-1");
  assert.equal(command.data.paymentAuthorizationId, "payment-authorization-1");

  await rejectsDomainCode(
    registry.execute(runtime, "B26", {
      actor: { ...commerceActor, requestId: "checkout-amount-mismatch" },
      idempotencyKey: "checkout-amount-mismatch",
      input: { ...input, checkoutId: "checkout-mismatch", authorizedMinor: 4_998 },
    }),
    "DEPENDENCY_UNAVAILABLE",
  );
});

test("B74, B89, B98, and B101 create requested commands without trusting pre-request result evidence", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const operator = actor({
    actorId: "commercial-operator-1",
    roles: ["platform_admin"],
    purpose: "commercial_operations",
    requestId: "requested-command-lifecycle",
    stepUp: true,
  });
  const commands: readonly {
    batchId: `B${string}`;
    collection: string;
    recordId: string;
    forbiddenResultField: string;
    input: JsonObject;
  }[] = [
    {
      batchId: "B74",
      collection: "notification.delivery-commands",
      recordId: "notification-request-74",
      forbiddenResultField: "notificationArtifactSha256",
      input: {
        notificationId: "notification-request-74", providerId: "provider-74", providerEnvironment: "sandbox",
        participantIds: [operator.actorId], purpose: operator.purpose, channel: "email",
        recipientRef: "opaque-contact-74", templateVersion: "template-v1", providerRoute: ["primary", "fallback"],
        eligibilityDecisionId: "eligibility-74", callbackVerificationPolicyVersion: "callback-policy-v1", boundedRetries: 3,
      },
    },
    {
      batchId: "B89",
      collection: "finance.tax-document-commands",
      recordId: "invoice-request-89",
      forbiddenResultField: "taxRequestArtifactSha256",
      input: {
        invoiceId: "invoice-request-89", legalEntityId: "entity-89", providerId: "tax-provider-89",
        providerEnvironment: "sandbox", invoiceType: "invoice", taxProfileVersion: "tax-profile-v1",
        sequenceScope: "entity-89:2026", amountMinor: 10_000, currency: "USD",
        creditNotePolicyVersion: "credit-note-v1",
      },
    },
    {
      batchId: "B98",
      collection: "supply.vendor-production-commands",
      recordId: "vendor-job-98",
      forbiddenResultField: "vendorRequestArtifactSha256",
      input: {
        jobId: "vendor-job-98", orderId: "order-98", vendorId: "vendor-98", purchaseOrderId: "po-98",
        approvedProofHash: "proof-hash-98", providerEnvironment: "sandbox", routeVersion: "route-v1",
        orderState: "approved_for_production", priorJobDisposition: "none", capacitySnapshotId: "capacity-98",
      },
    },
    {
      batchId: "B101",
      collection: "supply.return-claim-commands",
      recordId: "claim-101",
      forbiddenResultField: "claimArtifactSha256",
      input: {
        claimId: "claim-101", orderId: "order-101", action: "carrier_claim", providerType: "carrier",
        providerId: "carrier-101", vendorId: "vendor-101", providerEnvironment: "sandbox", evidenceReferences: ["redacted-reference-101"],
        eligibilityDecisionId: "eligibility-101", remedyLedgerReference: "ledger-101",
        returnAddressToken: "vault-return-address-101",
      },
    },
  ];

  for (const command of commands) {
    if (command.batchId === "B74") {
      ensureParticipant(runtime, operator);
      runtime.grantConsent(operator, {
        participantId: operator.actorId,
        grantorCapacity: "self",
        purpose: operator.purpose,
        scope: { resource: `${command.collection}:${command.recordId}`, actions: ["process"] },
        policyVersion: "notification-consent-v1",
        evidenceHash: "d".repeat(64),
        idempotencyKey: "grant-notification-command-consent",
      });
    }
    const result = objectResult(await registry.execute(runtime, command.batchId, {
      actor: { ...operator, requestId: `request-${command.batchId}` },
      idempotencyKey: `request-${command.batchId}`,
      input: command.input,
    }));
    assert.equal(result.state, "requested");
    assert.equal(result.commandState, "requested");
    const record = runtime.getRecord(operator, command.collection, command.recordId);
    assert.equal(record.data.commandState, "requested");
    assert.equal(record.data.executionState, "requested");
    assert.equal(record.data.externalCommandId, command.recordId);

    await rejectsDomainCode(registry.execute(runtime, command.batchId, {
      actor: { ...operator, requestId: `legacy-result-${command.batchId}` },
      idempotencyKey: `legacy-result-${command.batchId}`,
      input: { ...command.input, [command.forbiddenResultField]: "a".repeat(64) },
    }), "VALIDATION_FAILED");
  }
});

test("B48 persists certification only after verifying signed external evidence", async (testContext) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const certificationRunId = "certification-signed-1";
  const auditorProviderId = "business-loop-auditor";
  const provider = `e2e-auditor:${auditorProviderId}` as const;
  const providerEnvironment = "staging" as const;
  const certificationArtifactSha256 = "a".repeat(64);
  const evidenceIds = ["consumer", "family", "studio", "education", "abuse"].map((loop) => `business-loop-${loop}`);
  const registry = createCapabilityRegistry();
  const certificationActor = actor({
    actorId: "release-1",
    roles: ["platform_admin"],
    purpose: "release_certification",
    requestId: "signed-certification",
    stepUp: true,
  });
  const certificationInput = {
    certificationRunId,
    environment: "isolated_staging",
    loopEvidence: {
      consumer: "passed",
      familyGift: "passed",
      studio: "passed",
      educationCrm: "passed",
      failureAbuse: "passed",
    },
    externalEvidenceIds: evidenceIds,
    abuseFixturesSynthetic: true,
    auditorProviderId,
    providerEnvironment,
    certificationArtifactSha256,
  };
  const parsed = registry.get("B48")?.parseInput({
    actor: certificationActor,
    idempotencyKey: "request-bound-certification",
    input: certificationInput,
  });
  assert.ok(parsed);
  const evidenceScope = parsed.evidenceScope;
  assert.equal(typeof evidenceScope, "string");
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    trustedEvidenceKeys: [{
      issuer: "certification-auditor",
      provider,
      keyId: "certification-key-1",
      algorithm: "Ed25519",
      publicKeyPem: String(publicKey.export({ format: "pem", type: "spki" })),
      allowedScopes: [evidenceScope as string],
      allowedEnvironments: ["staging"],
    }],
    evidencePolicy: "development",
    evidenceEnvironment: "staging",
  });
  testContext.after(() => runtime.close());
  evidenceIds.forEach((evidenceId, index) => {
    const loop = ["consumer", "family", "studio", "education", "abuse"][index];
    assert.ok(loop);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: certificationActor.tenantId,
      issuer: "certification-auditor",
      provider,
      environment: providerEnvironment,
      scope: evidenceScope as string,
      artifactSha256: certificationArtifactSha256,
      issuedAt,
      expiresAt,
      nonce: `business-loop-nonce-${loop}`,
      replayPolicy: "reusable",
      algorithm: "Ed25519",
      keyId: "certification-key-1",
    }, privateKey.export({ format: "pem", type: "pkcs8" }));
    runtime.registerExternalEvidence(certificationActor, {
      evidence,
      idempotencyKey: `register-${evidenceId}`,
    });
  });

  const result = objectResult(
    await registry.execute(runtime, "B48", {
      actor: certificationActor,
      idempotencyKey: "signed-certification-run",
      input: certificationInput,
    }),
  );

  assert.equal(result.state, "evidence_persisted");
  const attestation = runtime.getRecord(
    certificationActor,
    "certification.business-loop-runs",
    "certification-signed-1",
  );
  assert.equal(attestation.data.operationMode, "attestation");
  assert.equal(attestation.data.executionState, "evidence_persisted");
  assert.equal(attestation.data.certificationState, "evidence_submitted");
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
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:" });
  testContext.after(() => runtime.close());
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
        auditorProviderId: "business-loop-auditor",
        providerEnvironment: "staging",
        certificationArtifactSha256: "a".repeat(64),
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

test("B106 rejects literal, loopback, metadata, and non-standard-port webhook endpoints", async (testContext) => {
  const runtime = runtimeFor(testContext);
  const registry = createCapabilityRegistry();
  const operator = actor({
    actorId: "platform-operator",
    roles: ["platform_admin"],
    permissions: ["webhook.endpoint.manage", "record:create"],
    purpose: "webhook_registration",
    requestId: "webhook-ssrf",
    stepUp: true,
  });
  const input = {
    endpointId: "endpoint-1",
    eventTypes: ["order.created"],
    signatureAlgorithm: "ed25519",
    signatureToleranceSeconds: 60,
    replayEventId: "replay-1",
    replayReason: "operator_requested",
    consumerIdempotencyVerified: true,
    tenantActive: true,
  };
  for (const endpointUrl of [
    "https://127.0.0.1/callback",
    "https://localhost/callback",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/callback",
    "https://hooks.example.com:8443/callback",
    "https://user:password@hooks.example.com/callback",
  ]) {
    await rejectsDomainCode(registry.execute(runtime, "B106", {
      actor: { ...operator, requestId: `webhook-${Buffer.from(endpointUrl).toString("base64url")}` },
      idempotencyKey: `webhook-${Buffer.from(endpointUrl).toString("base64url")}`,
      input: { ...input, endpointUrl },
    }), "VALIDATION_FAILED");
  }
});
