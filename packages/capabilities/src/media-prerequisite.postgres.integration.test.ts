import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import {
  DomainError,
  participantEvidenceScope,
  PostgresLifeTimeMachineRuntime,
  signExternalEvidence,
  type ActorContext,
} from "@ltm/core";
import { createCapabilityRegistry } from "./index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

test("PostgreSQL persists the B07 gate required by both B08 and B14", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const suffix = randomUUID();
  const actor: ActorContext = {
    actorId: `consumer-${suffix}`,
    tenantId: `tenant-media-${suffix}`,
    roles: ["consumer"],
    purpose: "age_transformation",
    requestId: `media-prerequisite-${suffix}`,
  };
  const registry = createCapabilityRegistry();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedEvidenceKey = {
    issuer: "identity-verifier",
    provider: "identity-registry",
    keyId: "identity-key-1",
    algorithm: "Ed25519" as const,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedScopes: ["identity.*"],
    allowedEnvironments: ["sandbox" as const],
  };
  const acceptedAssetId = `accepted-${suffix}`;
  const missingAssetId = `missing-${suffix}`;
  const first = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-capability-media-prerequisite-seed",
    trustedEvidenceKeys: [trustedEvidenceKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  try {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const participantMutation = {
      operation: "participant.register" as const,
      tenantId: actor.tenantId,
      participantId: actor.actorId,
      ownerActorId: actor.actorId,
      minorStatus: "adult" as const,
      expiresAt,
      expectedVersion: null,
    };
    const evidence = signExternalEvidence({
      version: "ltm.external-evidence.v1",
      evidenceId: `identity-${suffix}`,
      tenantId: actor.tenantId,
      issuer: trustedEvidenceKey.issuer,
      provider: trustedEvidenceKey.provider,
      environment: "sandbox",
      scope: participantEvidenceScope(participantMutation),
      artifactSha256: "f".repeat(64),
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt,
      nonce: `nonce-identity-${suffix}`,
      replayPolicy: "single_use",
      algorithm: "Ed25519",
      keyId: trustedEvidenceKey.keyId,
    }, privateKey.export({ type: "pkcs8", format: "pem" }));
    const service = {
      ...actor,
      actorId: `identity-service-${suffix}`,
      roles: ["service_account", "platform_admin"],
      requestId: `identity-request-${suffix}`,
      operationId: `identity-operation-${suffix}`,
    } satisfies ActorContext;
    await first.registerExternalEvidence(service, {
      evidence,
      idempotencyKey: `identity-evidence-${suffix}`,
    });
    await first.registerParticipant(service, {
      participantId: actor.actorId,
      ownerActorId: actor.actorId,
      minorStatus: "adult",
      expiresAt,
      expectedVersion: null,
      evidenceId: evidence.evidenceId,
      idempotencyKey: `identity-participant-${suffix}`,
    });
    for (const assetId of [acceptedAssetId, missingAssetId]) {
      await first.grantConsent(actor, {
        participantId: actor.actorId,
        grantorCapacity: "self",
        purpose: "age_transformation",
        scope: { resource: `media.asset:${assetId}`, actions: ["ingest", "transform"] },
        policyVersion: "privacy-v1",
        evidenceHash: "b".repeat(64),
        idempotencyKey: `media-consent-${assetId}`,
      });
    }
    await registry.execute(first, "B07", {
      actor,
      idempotencyKey: `media-accept-${suffix}`,
      input: acceptedMediaInput(acceptedAssetId, actor.actorId),
    });
  } finally {
    await first.close();
  }

  const second = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    allowLegacyConsentPolicy: true,
    applicationName: "ltm-capability-media-prerequisite-consume",
    trustedEvidenceKeys: [trustedEvidenceKey],
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  try {
    await assert.rejects(
      registry.execute(second, "B08", {
        actor,
        idempotencyKey: `composition-missing-${suffix}`,
        input: compositionInput(`draft-missing-${suffix}`, missingAssetId, actor.actorId),
      }),
      validationFailure,
    );
    await assert.rejects(
      registry.execute(second, "B14", {
        actor,
        idempotencyKey: `timeline-missing-${suffix}`,
        input: timelineInput(`job-missing-${suffix}`, missingAssetId, actor.actorId),
      }),
      validationFailure,
    );
    const composition = await registry.execute(second, "B08", {
      actor,
      idempotencyKey: `composition-accepted-${suffix}`,
      input: compositionInput(`draft-accepted-${suffix}`, acceptedAssetId, actor.actorId),
    });
    const timeline = await registry.execute(second, "B14", {
      actor,
      idempotencyKey: `timeline-accepted-${suffix}`,
      input: timelineInput(`job-accepted-${suffix}`, acceptedAssetId, actor.actorId),
    });
    assert.equal((composition as Record<string, unknown>).state, "persisted");
    assert.equal((timeline as Record<string, unknown>).state, "requested");
  } finally {
    await second.close();
  }
});

function acceptedMediaInput(assetId: string, participantId: string) {
  const sourceSha256 = "1".repeat(64);
  const canonicalSha256 = "2".repeat(64);
  return {
    assetId,
    mimeType: "image/jpeg",
    byteLength: 4_096,
    faceCount: 1,
    participantIds: [participantId],
    magicVerified: true,
    metadataStripped: true,
    malwareState: "clean",
    sourceSha256,
    canonicalSha256,
    lineageSha256: createHash("sha256")
      .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
      .digest("hex"),
    scanEvidenceId: `scan-${assetId}`,
    scannerProvider: "trusted-media-scanner",
    scanAssessedAt: "2026-08-24T00:00:00.000Z",
    participantMappingEvidenceId: `participant-map-${assetId}`,
    participantMappingProvider: "trusted-participant-mapper",
    participantMappingAssessedAt: "2026-08-24T00:00:01.000Z",
    participantMapComplete: true,
    qualityDimensions: { width: 640, height: 480 },
  };
}

function compositionInput(draftId: string, sourceAssetId: string, participantId: string) {
  return {
    draftId,
    sourceAssetId,
    templateId: "timeline-classic-v1",
    participantIds: [participantId],
    targetAges: [18, 80],
    composition: { sourceAssetIds: [sourceAssetId], layout: "timeline" },
    illustrativeLabel: true,
  };
}

function timelineInput(jobId: string, sourceAssetId: string, participantId: string) {
  return {
    jobId,
    sourceAssetId,
    participantIds: [participantId],
    targetAges: [18, 80],
    seed: `seed-${jobId}`,
    promptPolicyVersion: "prompt-v1",
    illustrativeLabel: true,
  };
}

function validationFailure(error: unknown): boolean {
  return error instanceof DomainError && error.code === "VALIDATION_FAILED";
}
