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
import {
  createCapabilityRegistry,
  listExternalBusinessEventReducerRoutes,
  type JsonObject,
  type JsonValue,
} from "./index.js";
import {
  CANONICAL_CAPABILITY_BATCH_IDS,
  createCapabilityValidInputFixtures,
  type CanonicalCapabilityBatchId,
} from "./valid-fixtures.js";

const FIXTURE_ACTOR_ID = "fixture-actor";
const FIXTURE_TENANT_ID = "fixture-tenant";
const DIGEST = "a".repeat(64);
const EXTERNAL_EVENT_ONLY = ["B66", "B71", "B99", "B100", "B102"] as const;

const identityKeyPair = generateKeyPairSync("ed25519");
const identityPublicKeyPem = identityKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const identityPrivateKeyPem = identityKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const evidenceKeyPair = generateKeyPairSync("ed25519");
const evidencePublicKeyPem = evidenceKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const evidencePrivateKeyPem = evidenceKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const registeredParticipants = new WeakMap<LifeTimeMachineRuntime, Set<string>>();

function baseActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorId: FIXTURE_ACTOR_ID,
    tenantId: FIXTURE_TENANT_ID,
    roles: [
      "platform_admin",
      "service_account",
      "consumer",
      "guardian",
      "auditor",
      "support_agent",
      "finance_operator",
      "partner_admin",
    ],
    permissions: ["*"],
    purpose: "fixture_operation",
    requestId: "valid-fixture-test",
    operationId: "valid-fixture-test",
    stepUp: true,
    guardianVerified: true,
    ...overrides,
  };
}

function runtimeForLocalExecution(testContext: TestContext): LifeTimeMachineRuntime {
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    allowLegacyConsentPolicy: true,
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    maxEvidenceLifetimeMs: 120 * 86_400_000,
    trustedEvidenceKeys: [{
      issuer: "fixture-identity-authority",
      provider: "fixture-participant-registry",
      keyId: "fixture-identity-key",
      algorithm: "Ed25519",
      publicKeyPem: identityPublicKeyPem,
      allowedScopes: ["identity.*"],
      allowedEnvironments: ["sandbox"],
    }],
  });
  testContext.after(() => runtime.close());
  return runtime;
}

function runtimeForConsentCatalog(testContext: TestContext): LifeTimeMachineRuntime {
  const keyPair = generateKeyPairSync("ed25519");
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const catalog = signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "valid-fixture-consent-catalog",
    issuer: "fixture-privacy-authority",
    environment: "sandbox",
    issuedAt,
    expiresAt,
    algorithm: "Ed25519",
    keyId: "fixture-consent-policy-key",
    policies: [{
      policyVersion: "sharing-v1",
      purpose: "sharing",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["work"],
      allowedActions: ["share"],
      grantorCapacities: ["authorized_agent", "guardian", "self"],
      minorApplicability: "all",
      disclosureSha256: DIGEST,
      effectiveFrom: issuedAt,
      effectiveUntil: expiresAt,
      maxConsentLifetimeSeconds: 3_600,
    }],
  }, keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidenceEnvironment: "sandbox",
    consentPolicyCatalog: catalog,
    trustedConsentPolicyKeys: [{
      keyId: "fixture-consent-policy-key",
      issuer: "fixture-privacy-authority",
      algorithm: "Ed25519",
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      allowedEnvironments: ["sandbox"],
      notBefore: issuedAt,
      notAfter: expiresAt,
    }],
    consentPolicyJurisdiction: "CN",
    consentPolicyLocale: "zh-CN",
  });
  testContext.after(() => runtime.close());
  return runtime;
}

function registerParticipant(runtime: LifeTimeMachineRuntime, actor: ActorContext, participantId: string): void {
  const existing = registeredParticipants.get(runtime) ?? new Set<string>();
  registeredParticipants.set(runtime, existing);
  if (existing.has(participantId)) return;
  const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const service: ActorContext = {
    ...actor,
    actorId: "fixture-identity-service",
    roles: ["service_account", "platform_admin"],
    purpose: "identity_registry_operation",
    requestId: `register-${participantId}`,
    operationId: `register-${participantId}`,
  };
  const mutation = {
    operation: "participant.register" as const,
    tenantId: actor.tenantId,
    participantId,
    ownerActorId: actor.actorId,
    minorStatus: "adult" as const,
    expiresAt,
    expectedVersion: null,
  };
  const evidenceId = `identity-${createHash("sha256").update(participantId).digest("hex").slice(0, 24)}`;
  const evidence = signExternalEvidence({
    version: "ltm.external-evidence.v1",
    evidenceId,
    tenantId: actor.tenantId,
    issuer: "fixture-identity-authority",
    provider: "fixture-participant-registry",
    environment: "sandbox",
    scope: participantEvidenceScope(mutation),
    artifactSha256: DIGEST,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    nonce: `nonce-${evidenceId}`,
    replayPolicy: "single_use",
    algorithm: "Ed25519",
    keyId: "fixture-identity-key",
  }, identityPrivateKeyPem);
  runtime.registerExternalEvidence(service, {
    evidence,
    idempotencyKey: `evidence-${participantId}`,
  });
  runtime.registerParticipant(service, {
    participantId,
    ownerActorId: actor.actorId,
    minorStatus: "adult",
    expiresAt,
    expectedVersion: null,
    evidenceId,
    idempotencyKey: `participant-${participantId}`,
  });
  existing.add(participantId);
}

function participantIds(input: JsonObject, parsed: JsonObject): readonly string[] {
  const listed = Array.isArray(parsed.participantIds)
    ? parsed.participantIds.filter((value): value is string => typeof value === "string")
    : [];
  const single = typeof input.participantId === "string"
    ? [input.participantId]
    : typeof input.subjectId === "string" && parsed.status === "active"
      ? [input.subjectId]
      : [];
  return [...new Set([...listed, ...single])];
}

function objectResult(value: JsonValue): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function executeWithExactConsent(
  runtime: LifeTimeMachineRuntime,
  batchId: CanonicalCapabilityBatchId,
  input: JsonObject,
  actor: ActorContext,
  idempotencyPrefix: string,
): Promise<JsonObject> {
  const registry = createCapabilityRegistry();
  const definition = registry.get(batchId);
  assert.ok(definition);
  const parsed = definition.parseInput({ actor, idempotencyKey: `${idempotencyPrefix}-parse`, input });
  const registered = new Set<string>();
  for (const participantId of participantIds(input, parsed)) {
    registerParticipant(runtime, actor, participantId);
    registered.add(participantId);
  }

  const granted = new Set<string>();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return objectResult(await registry.execute(runtime, batchId, {
        actor: { ...actor, requestId: `${idempotencyPrefix}-execute-${attempt}` },
        idempotencyKey: `${idempotencyPrefix}-execute`,
        input,
      }));
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "CONSENT_REQUIRED") throw error;
      const participantId = error.details.participantId;
      const purpose = error.details.purpose;
      const resource = error.details.resource;
      const action = error.details.action;
      if (typeof participantId !== "string" || typeof purpose !== "string" ||
          typeof resource !== "string" || typeof action !== "string") {
        throw error;
      }
      if (!registered.has(participantId)) {
        registerParticipant(runtime, actor, participantId);
        registered.add(participantId);
      }
      const grantKey = `${participantId}:${purpose}:${resource}:${action}`;
      if (granted.has(grantKey)) throw error;
      runtime.grantConsent({
        ...actor,
        purpose,
        requestId: `${idempotencyPrefix}-consent-${granted.size}`,
      }, {
        participantId,
        grantorCapacity: "self",
        purpose,
        scope: { resource, actions: [action] },
        policyVersion: "fixture-policy-v1",
        evidenceHash: DIGEST,
        idempotencyKey: `${idempotencyPrefix}-consent-${granted.size}`,
      });
      granted.add(grantKey);
    }
  }
  throw new Error(`${batchId} exceeded the bounded consent setup attempts`);
}

test("closed valid fixture catalog parses every B00-B127 batch-specific schema", () => {
  const registry = createCapabilityRegistry();
  const fixtures = createCapabilityValidInputFixtures();
  assert.deepEqual(Object.keys(fixtures), [...CANONICAL_CAPABILITY_BATCH_IDS]);
  assert.deepEqual(registry.list().map(({ batchId }) => batchId), [...CANONICAL_CAPABILITY_BATCH_IDS]);
  assert.equal(new Set(Object.keys(fixtures)).size, 128);

  for (const definition of registry.list()) {
    const input = fixtures[definition.batchId as CanonicalCapabilityBatchId];
    assert.deepEqual(JSON.parse(JSON.stringify(input)), input, definition.batchId);
    const parsed = definition.parseInput({
      actor: baseActor(),
      idempotencyKey: `parse-${definition.batchId}`,
      input,
    });
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), definition.batchId);
  }
});

test("every capability without external evidence executes positively on an isolated prepared runtime", async (testContext) => {
  const registry = createCapabilityRegistry();
  const fixtures = createCapabilityValidInputFixtures();
  const localDefinitions = registry.list().filter((definition) => definition.requiresExternalEvidence !== true);
  assert.equal(localDefinitions.length, 92);
  const executed: string[] = [];

  for (const definition of localDefinitions) {
    await testContext.test(definition.batchId, async (subtest) => {
      const input = fixtures[definition.batchId as CanonicalCapabilityBatchId];
      const initialParsed = definition.parseInput({
        actor: baseActor(),
        idempotencyKey: `purpose-${definition.batchId}`,
        input,
      });
      const purpose = typeof initialParsed.purpose === "string" ? initialParsed.purpose : "fixture_operation";
      const actor = baseActor({ purpose, requestId: `actor-${definition.batchId}`, operationId: `actor-${definition.batchId}` });
      const runtime = definition.batchId === "B03"
        ? runtimeForConsentCatalog(subtest)
        : runtimeForLocalExecution(subtest);

      if (definition.batchId === "B08" || definition.batchId === "B14") {
        await executeWithExactConsent(
          runtime,
          "B07",
          fixtures.B07,
          baseActor({ purpose: "age_transformation", requestId: `prerequisite-${definition.batchId}` }),
          `prerequisite-${definition.batchId}`,
        );
      }
      const result = definition.batchId === "B03"
        ? objectResult(await registry.execute(runtime, "B03", {
            actor,
            idempotencyKey: "execute-B03",
            input,
          }))
        : await executeWithExactConsent(runtime, definition.batchId as CanonicalCapabilityBatchId, input, actor, definition.batchId);
      assert.equal(result.batchId ?? definition.batchId, definition.batchId);
      executed.push(definition.batchId);
    });
  }
  assert.deepEqual(executed, localDefinitions.map(({ batchId }) => batchId));
});

test("all evidence-gated capability paths fail closed first, then execute only with exact signed evidence", async (testContext) => {
  const registry = createCapabilityRegistry();
  const fixtures = createCapabilityValidInputFixtures();
  const directEvidenceDefinitions = registry.list().filter((definition) =>
    definition.requiresExternalEvidence === true && definition.executionPath === "capability"
  );
  assert.equal(directEvidenceDefinitions.length, 31);

  for (const definition of directEvidenceDefinitions) {
    await testContext.test(definition.batchId, async (subtest) => {
      const input = fixtures[definition.batchId as CanonicalCapabilityBatchId];
      const actor = baseActor({
        purpose: "sandbox_commercial_validation",
        requestId: `evidence-${definition.batchId}`,
        operationId: `evidence-${definition.batchId}`,
      });
      const parsed = definition.parseInput({ actor, idempotencyKey: `parse-${definition.batchId}`, input });
      const scope = parsed.evidenceScope;
      assert.equal(typeof scope, "string", definition.batchId);
      if (definition.batchId === "B127") {
        assert.equal(parsed.decisionRequestSha256, undefined, definition.batchId);
      } else {
        assert.match(String(parsed.decisionRequestSha256), /^[a-f0-9]{64}$/, definition.batchId);
      }
      const idsValue = input.externalEvidenceIds ?? input.approvalEvidenceIds;
      assert.ok(Array.isArray(idsValue) && idsValue.length > 0, definition.batchId);
      const evidenceIds = idsValue.filter((value): value is string => typeof value === "string");
      assert.equal(evidenceIds.length, idsValue.length, definition.batchId);
      const provider = `fixture-provider-${definition.batchId.toLowerCase()}`;
      const runtime = new LifeTimeMachineRuntime({
        databasePath: ":memory:",
        evidencePolicy: "development",
        evidenceEnvironment: "sandbox",
        trustedEvidenceKeys: [{
          issuer: "fixture-evidence-issuer",
          provider,
          keyId: "fixture-evidence-key",
          algorithm: "Ed25519",
          publicKeyPem: evidencePublicKeyPem,
          allowedScopes: [scope as string],
          allowedEnvironments: ["sandbox"],
        }],
      });
      subtest.after(() => runtime.close());

      await assert.rejects(registry.execute(runtime, definition.batchId, {
        actor,
        idempotencyKey: `missing-${definition.batchId}`,
        input,
      }), (error: unknown) => error instanceof DomainError && error.code === "EXTERNAL_EVIDENCE_UNVERIFIED");

      evidenceIds.forEach((evidenceId, index) => {
        runtime.registerExternalEvidence({
          ...actor,
          requestId: `register-${definition.batchId}-${index}`,
          operationId: `register-${definition.batchId}-${index}`,
        }, {
          evidence: signExternalEvidence({
            version: "ltm.external-evidence.v1",
            evidenceId,
            tenantId: actor.tenantId,
            issuer: "fixture-evidence-issuer",
            provider,
            environment: "sandbox",
            scope: scope as string,
            artifactSha256: DIGEST,
            issuedAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            nonce: `fixture-nonce-${definition.batchId}-${index}-2026`,
            replayPolicy: "single_use",
            algorithm: "Ed25519",
            keyId: "fixture-evidence-key",
          }, evidencePrivateKeyPem),
          idempotencyKey: `register-${definition.batchId}-${index}`,
        });
      });

      const result = objectResult(await registry.execute(runtime, definition.batchId, {
        actor: { ...actor, requestId: `execute-${definition.batchId}` },
        idempotencyKey: `execute-${definition.batchId}`,
        input,
      }));
      assert.ok(typeof result.state === "string" || result.recordId !== undefined || result.transactionId !== undefined, definition.batchId);
      for (const evidenceId of evidenceIds) {
        assert.notEqual(runtime.getExternalEvidence(actor, evidenceId).consumedAt, null, definition.batchId);
      }
    });
  }
});

test("B91 authority evidence binds the complete decision so action and amount cannot be changed after issuance", async (t) => {
  const registry = createCapabilityRegistry();
  const definition = registry.get("B91");
  assert.ok(definition);
  const input = createCapabilityValidInputFixtures().B91;
  const actor = baseActor({
    purpose: "sandbox_commercial_validation",
    requestId: "b91-request-binding",
    operationId: "b91-request-binding",
  });
  const parsed = definition.parseInput({ actor, idempotencyKey: "parse-b91-request-binding", input });
  assert.throws(() => definition.parseInput({
    actor,
    idempotencyKey: "parse-b91-invalid-leap-date",
    input: { ...input, responseDueAt: "2025-02-29T00:00:00.000Z" },
  }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
  assert.equal(typeof parsed.decisionRequestSha256, "string");
  assert.equal(typeof parsed.evidenceScope, "string");
  const provider = "fixture-provider-b91";
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
    trustedEvidenceKeys: [{
      issuer: "fixture-evidence-issuer",
      provider,
      keyId: "fixture-evidence-key",
      algorithm: "Ed25519",
      publicKeyPem: evidencePublicKeyPem,
      allowedScopes: [parsed.evidenceScope as string],
      allowedEnvironments: ["sandbox"],
    }],
  });
  t.after(() => runtime.close());
  const evidenceId = (input.externalEvidenceIds as string[])[0];
  assert.ok(evidenceId);
  runtime.registerExternalEvidence(actor, {
    evidence: signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: actor.tenantId,
      issuer: "fixture-evidence-issuer",
      provider,
      environment: "sandbox",
      scope: parsed.evidenceScope as string,
      artifactSha256: DIGEST,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: "fixture-b91-request-binding-nonce",
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: "fixture-evidence-key",
    }, evidencePrivateKeyPem),
    idempotencyKey: "register-b91-request-binding",
  });
  for (const mutation of [
    { action: "write_off" },
    { amountMinor: (input.amountMinor as number) + 1 },
  ]) {
    await assert.rejects(registry.execute(runtime, "B91", {
      actor: {
        ...actor,
        requestId: `b91-mutated-${Object.keys(mutation)[0]}`,
        operationId: `b91-mutated-${Object.keys(mutation)[0]}`,
      },
      idempotencyKey: `execute-b91-mutated-${Object.keys(mutation)[0]}`,
      input: { ...input, ...mutation },
    }), (error: unknown) => error instanceof DomainError && error.code === "EVIDENCE_SCOPE_MISMATCH");
  }
  assert.equal(runtime.getExternalEvidence(actor, evidenceId).consumedAt, null);
});

test("the five signed-event-only fixtures map to their existing positive reducer contract tests", async () => {
  const registry = createCapabilityRegistry();
  const fixtures = createCapabilityValidInputFixtures();
  const reducerRoutes = new Set(listExternalBusinessEventReducerRoutes());
  const runtime = new LifeTimeMachineRuntime({ databasePath: ":memory:", allowLegacyConsentPolicy: true });
  const positiveReducerTestMap: Readonly<Record<typeof EXTERNAL_EVENT_ONLY[number], string>> = {
    B66: "external-business-event-reducers.test.ts#store entitlement and WeChat payment reducers",
    B71: "external-business-event-reducers.test.ts#store entitlement and WeChat payment reducers",
    B99: "external-business-event-reducers.test.ts#shipment reducer",
    B100: "external-business-event-reducers.test.ts#inventory reducer",
    B102: "external-business-event-reducers.test.ts#vendor scorecard reducer",
  };
  assert.deepEqual(Object.keys(positiveReducerTestMap), [...EXTERNAL_EVENT_ONLY]);

  try {
    for (const batchId of EXTERNAL_EVENT_ONLY) {
      const definition = registry.get(batchId);
      assert.ok(definition);
      assert.equal(definition.executionPath, "signed-external-event");
      assert.ok(reducerRoutes.has(`${batchId}:${definition.operation}`), positiveReducerTestMap[batchId]);
      definition.parseInput({ actor: baseActor(), idempotencyKey: `parse-${batchId}`, input: fixtures[batchId] });
      await assert.rejects(definition.execute(runtime, {
        actor: baseActor(),
        idempotencyKey: `closed-${batchId}`,
        input: fixtures[batchId],
      }), (error: unknown) => error instanceof DomainError && error.code === "AUTH_FORBIDDEN");
    }
  } finally {
    runtime.close();
  }
});

test("B127 global observation binding is exclusive to a completed global wave", () => {
  const definition = createCapabilityRegistry().get("B127");
  assert.ok(definition);
  const input = createCapabilityValidInputFixtures().B127;
  const preGlobalInput: JsonObject = { ...input, wave: "internal", rolloutPercent: 1 };
  delete preGlobalInput.globalWaveObservationPath;
  delete preGlobalInput.globalWaveObservationSha256;
  assert.doesNotThrow(() => definition.parseInput({
    actor: baseActor(),
    idempotencyKey: "valid-pre-global-wave",
    input: preGlobalInput,
  }));
  assert.throws(() => definition.parseInput({
    actor: baseActor(),
    idempotencyKey: "predeclared-global-observation",
    input: { ...input, wave: "internal", rolloutPercent: 1 },
  }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
  assert.throws(() => definition.parseInput({
    actor: baseActor(),
    idempotencyKey: "incomplete-global-wave",
    input: { ...input, rolloutPercent: 99 },
  }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
  const missingGlobalObservationPath: JsonObject = { ...input };
  delete missingGlobalObservationPath.globalWaveObservationPath;
  assert.throws(() => definition.parseInput({
    actor: baseActor(),
    idempotencyKey: "missing-global-observation-path",
    input: missingGlobalObservationPath,
  }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
  for (const invalidPath of ["/absolute.json", "../escape.json", "security//empty.json", "security\\windows.json"]) {
    assert.throws(() => definition.parseInput({
      actor: baseActor(),
      idempotencyKey: `invalid-path-${invalidPath}`,
      input: { ...input, globalWaveObservationPath: invalidPath },
    }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
  }
  assert.throws(() => definition.parseInput({
    actor: baseActor(),
    idempotencyKey: "invalid-global-observation-digest",
    input: { ...input, globalWaveObservationSha256: "A".repeat(64) },
  }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_FAILED");
});
