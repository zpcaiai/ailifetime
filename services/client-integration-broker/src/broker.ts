import { createHash, randomUUID } from "node:crypto";
import {
  BrokerError,
  bounded,
  conflict,
  dependency,
  fingerprint,
  identifier,
  idempotencyKey,
  notFound,
  principalFingerprint,
  roles,
  safeInteger,
  sha256,
  sha256Digest,
  timestamp,
  validateMediaAssetRecord,
  validateSession,
  validation,
  type EnterpriseIdentityPort,
  type IdempotencyStore,
  type JpegNormalizerPort,
  type JsonValue,
  type MediaAssetRecord,
  type MediaAssetDeletionAudit,
  type MediaAssetStore,
  type MediaDeletionAttempt,
  type MediaDeletionTargetReceipt,
  type MediaLifecycleBinding,
  type MediaSafetyEvidence,
  type MediaSafetyScannerPort,
  type MultipartObjectStore,
  type MultipartPart,
  type Principal,
  type SessionProjection,
  type UploadState,
  type UploadStateStore,
  type WechatCodeExchangePort,
} from "./contracts.js";
import {
  MediaLifecycleRegistry,
  MediaLifecycleTargetPending,
  developmentMediaLifecycleRegistry,
  type MediaDownloadAuthorizer,
} from "./media-lifecycle.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PART_BYTES = 5 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60_000;
const SESSION_IDEMPOTENCY_MAX_TTL_MS = 5 * 60_000;
const PARTICIPANT_MAPPING_MAX_AGE_MS = 15 * 60_000;
const PARTICIPANT_MAPPING_IDEMPOTENCY_TTL_MS = 10 * 60_000;

interface MediaIntakeResolution {
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly canonicalSha256: string;
  readonly lineageSha256: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly faceCount: number;
  readonly scanEvidenceId: string;
  readonly scannerProvider: string;
  readonly scanAssessedAt: string;
  readonly participantIds: readonly string[];
  readonly participantMappingEvidenceId: string;
  readonly participantMappingProvider: string;
  readonly participantMappingAssessedAt: string;
  readonly participantMapComplete: true;
  readonly mimeType: "image/jpeg";
  readonly metadataStripped: true;
}

export interface MediaDeletionProjection {
  readonly mediaReference: string;
  readonly state: "deleted";
  readonly auditId: string;
  readonly deletionRequestId: string;
  readonly requestedAt: string;
  readonly deletedAt: string;
  readonly policyId: string;
  readonly policySha256: string;
  readonly classification: string;
  readonly retentionDays: number;
  readonly retentionExpiresAt: string;
  readonly encrypted: true;
  readonly deletionTargets: readonly string[];
  readonly targetReceipts: readonly MediaDeletionTargetReceipt[];
}

export interface BrokerDependencies {
  readonly wechat: WechatCodeExchangePort;
  readonly identity: EnterpriseIdentityPort;
  readonly idempotency: IdempotencyStore;
  readonly uploads: UploadStateStore;
  readonly assets: MediaAssetStore;
  readonly objects: MultipartObjectStore;
  readonly jpegNormalizer: JpegNormalizerPort;
  readonly safetyScanner: MediaSafetyScannerPort;
  readonly lifecycleRegistry?: MediaLifecycleRegistry;
  readonly downloadAuthorizer?: MediaDownloadAuthorizer;
  readonly objectKeyPrefix?: string;
  readonly clock?: () => Date;
}

export class ClientIntegrationBroker {
  readonly #clock: () => Date;
  readonly #prefix: string;
  readonly #lifecycle: MediaLifecycleRegistry;

  constructor(private readonly dependencies: BrokerDependencies) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#prefix = dependencies.objectKeyPrefix ?? "media/v1";
    this.#lifecycle = dependencies.lifecycleRegistry ?? developmentMediaLifecycleRegistry(this.#clock());
    if (!/^[a-z0-9][a-z0-9/_-]{0,127}$/.test(this.#prefix) || this.#prefix.includes("..")) {
      throw validation("object key prefix is invalid");
    }
  }

  async createWechatSession(input: {
    readonly code: string;
    readonly consentVersion: string;
    readonly clientRequestId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{ readonly session: SessionProjection }> {
    const normalized = {
      code: bounded(input.code, "code", 512),
      consentVersion: bounded(input.consentVersion, "consentVersion", 128),
      clientRequestId: identifier(input.clientRequestId, "clientRequestId"),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      requestId: identifier(input.requestId, "requestId"),
    };
    const result = await this.dependencies.idempotency.execute(
      "wechat-session.create",
      normalized.idempotencyKey,
      fingerprint({ codeSha256: sha256(normalized.code), consentVersion: normalized.consentVersion, clientRequestId: normalized.clientRequestId }),
      async () => {
        const identity = await this.dependencies.wechat.exchange(normalized.code);
        const session = validateSession(await this.dependencies.identity.createSession({
          identity,
          consentVersion: normalized.consentVersion,
          clientRequestId: normalized.clientRequestId,
          idempotencyKey: normalized.idempotencyKey,
          requestId: normalized.requestId,
        }), this.#clock());
        return { session } as unknown as JsonValue;
      },
      { completedTtlMs: (response) => this.#sessionResultTtl(response) },
    );
    return result as unknown as { readonly session: SessionProjection };
  }

  async refreshWechatSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{ readonly session: SessionProjection }> {
    const accessToken = bounded(input.accessToken, "subject token", 8_192, 20);
    const key = idempotencyKey(input.idempotencyKey);
    const requestId = identifier(input.requestId, "requestId");
    const result = await this.dependencies.idempotency.execute(
      "wechat-session.refresh",
      key,
      fingerprint({ subjectTokenSha256: sha256(accessToken) }),
      async () => ({
        session: validateSession(
          await this.dependencies.identity.refreshSession({ accessToken, idempotencyKey: key, requestId }),
          this.#clock(),
        ),
      }) as unknown as JsonValue,
      { completedTtlMs: (response) => this.#sessionResultTtl(response) },
    );
    return result as unknown as { readonly session: SessionProjection };
  }

  async revokeWechatSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<void> {
    const accessToken = bounded(input.accessToken, "subject token", 8_192, 20);
    const key = idempotencyKey(input.idempotencyKey);
    const requestId = identifier(input.requestId, "requestId");
    await this.dependencies.idempotency.execute(
      "wechat-session.revoke",
      key,
      fingerprint({ subjectTokenSha256: sha256(accessToken) }),
      async () => {
        await this.dependencies.identity.revokeSession({ accessToken, idempotencyKey: key, requestId });
        return { revoked: true };
      },
      { completedTtlMs: SESSION_IDEMPOTENCY_MAX_TTL_MS },
    );
  }

  async createUpload(principal: Principal, input: {
    readonly fileSize: number;
    readonly fileDigest: string;
    readonly digestAlgorithm: "sha256";
    readonly contentType: "image/jpeg";
    readonly clientRequestId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly uploadId: string; readonly nextOffset: number; readonly expiresAt: string }> {
    const binding = principalFingerprint(principal);
    const fileSize = safeInteger(input.fileSize, "fileSize", 1, MAX_FILE_BYTES);
    const fileDigest = sha256Digest(input.fileDigest, "fileDigest");
    if (input.digestAlgorithm !== "sha256" || input.contentType !== "image/jpeg") throw validation("upload format is unsupported");
    const clientRequestId = identifier(input.clientRequestId, "clientRequestId");
    const key = idempotencyKey(input.idempotencyKey);
    return this.dependencies.idempotency.execute(
      this.#uploadOperation("media-upload.create", binding),
      key,
      fingerprint({ binding, fileSize, fileDigest, clientRequestId, contentType: input.contentType }),
      async () => {
        const referenceNonce = randomUUID();
        const uploadId = `upload_${referenceNonce}`;
        const mediaReference = `media_${referenceNonce}`;
        const tenantSegment = sha256(principal.tenantId).slice(0, 24);
        const objectKey = `${this.#prefix}/${tenantSegment}/${mediaReference}.jpeg`;
        const providerUploadId = await this.dependencies.objects.create({ objectKey, contentType: "image/jpeg" });
        const now = this.#clock();
        const state: UploadState = {
          schemaVersion: "ltm.resumable-upload.v4",
          uploadId,
          mediaReference,
          tenantId: principal.tenantId,
          actorId: principal.actorId,
          principalSha256: binding,
          clientRequestId,
          fileSize,
          expectedSha256: fileDigest,
          contentType: "image/jpeg",
          objectKey,
          providerUploadId,
          nextOffset: 0,
          parts: [],
          state: "uploading",
          version: 1,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + UPLOAD_LIFETIME_MS).toISOString(),
        };
        try {
          await this.dependencies.uploads.create(state);
        } catch (error) {
          await this.dependencies.objects.abort({ objectKey, providerUploadId }).catch(() => undefined);
          throw error;
        }
        return { uploadId, nextOffset: 0, expiresAt: state.expiresAt };
      },
    ) as Promise<{ readonly uploadId: string; readonly nextOffset: number; readonly expiresAt: string }>;
  }

  async appendUpload(principal: Principal, input: {
    readonly uploadId: string;
    readonly bytes: Uint8Array;
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly idempotencyKey: string;
  }): Promise<{ readonly nextOffset: number }> {
    const uploadId = identifier(input.uploadId, "uploadId");
    const bytes = Buffer.from(input.bytes);
    if (bytes.byteLength < 1 || bytes.byteLength > PART_BYTES) throw validation("upload chunk size is invalid");
    const start = safeInteger(input.start, "range start", 0, MAX_FILE_BYTES - 1);
    const end = safeInteger(input.end, "range end", start, MAX_FILE_BYTES - 1);
    const total = safeInteger(input.total, "range total", 1, MAX_FILE_BYTES);
    if (end - start + 1 !== bytes.byteLength || end >= total) throw validation("upload chunk does not match Content-Range");
    if (end + 1 < total && bytes.byteLength !== PART_BYTES) throw validation("non-final S3 multipart chunks must be exactly five MiB");
    const binding = principalFingerprint(principal);
    const key = idempotencyKey(input.idempotencyKey);
    const chunkSha256 = sha256(bytes);
    return this.dependencies.idempotency.execute(
      this.#uploadOperation("media-upload.append", binding),
      key,
      fingerprint({ uploadId, binding, start, end, total, chunkSha256 }),
      async () => this.dependencies.uploads.withUploadLease(uploadId, async () => {
        const current = await this.requiredUpload(uploadId, principal, binding);
        this.#assertActive(current);
        if (current.fileSize !== total) throw conflict("upload total changed");
        if (current.nextOffset !== start) {
          const replay = current.parts.find((part) => part.start === start && part.end === end && part.sha256 === chunkSha256);
          if (replay !== undefined && current.nextOffset >= end + 1) return { nextOffset: current.nextOffset };
          throw conflict("upload offset changed");
        }
        const partNumber = current.parts.length + 1;
        if (partNumber > 10_000) throw validation("multipart upload has too many parts");
        const sha256Base64 = Buffer.from(chunkSha256, "hex").toString("base64");
        const stored = await this.dependencies.objects.putPart({
          objectKey: current.objectKey,
          providerUploadId: current.providerUploadId,
          partNumber,
          bytes,
          sha256Base64,
        });
        if (stored.sha256Base64 !== undefined && stored.sha256Base64 !== sha256Base64) {
          throw dependency("object store returned a mismatched part checksum", false);
        }
        const part: MultipartPart = { partNumber, start, end, etag: bounded(stored.etag, "part ETag", 256), sha256: chunkSha256 };
        const updated: UploadState = {
          ...current,
          nextOffset: end + 1,
          parts: [...current.parts, part],
          version: current.version + 1,
        };
        if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, updated)) {
          const after = await this.requiredUpload(uploadId, principal, binding);
          const replay = after.parts.find((candidate) => candidate.partNumber === partNumber && candidate.sha256 === chunkSha256);
          if (replay === undefined || after.nextOffset < end + 1) throw conflict("upload state changed concurrently");
          return { nextOffset: after.nextOffset };
        }
        return { nextOffset: updated.nextOffset };
      }),
    ) as Promise<{ readonly nextOffset: number }>;
  }

  async completeUpload(principal: Principal, input: {
    readonly uploadId: string;
    readonly fileDigest: string;
    readonly digestAlgorithm: "sha256";
    readonly idempotencyKey: string;
  }): Promise<{ readonly uploadId: string; readonly mediaReference: string; readonly state: "available" }> {
    const uploadId = identifier(input.uploadId, "uploadId");
    const fileDigest = sha256Digest(input.fileDigest, "fileDigest");
    if (input.digestAlgorithm !== "sha256") throw validation("digestAlgorithm must be sha256");
    const binding = principalFingerprint(principal);
    const key = idempotencyKey(input.idempotencyKey);
    const result = await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-upload.complete", binding),
      key,
      fingerprint({ uploadId, binding, fileDigest }),
      async () => this.dependencies.uploads.withUploadLease(uploadId, async () => {
        let current = await this.requiredUpload(uploadId, principal, binding);
        if (current.state === "available") {
          await this.#requiredAvailableAsset(current.mediaReference, principal, binding);
          return { uploadId, mediaReference: current.mediaReference, state: "available" as const };
        }
        if (!["uploading", "completing", "verifying", "normalizing"].includes(current.state)) throw conflict("upload cannot be completed in its current state");
        if (current.fileSize !== current.nextOffset || current.expectedSha256 !== fileDigest) throw conflict("upload is incomplete or its digest binding changed");
        if (current.state === "uploading") {
          const completing: UploadState = { ...current, state: "completing", version: current.version + 1 };
          if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, completing)) {
            throw conflict("upload state changed before multipart completion");
          }
          current = completing;
        }
        if (current.state === "completing") {
          await this.dependencies.objects.complete({
            objectKey: current.objectKey,
            providerUploadId: current.providerUploadId,
            parts: current.parts.map(({ partNumber, etag, sha256: partSha256 }) => ({ partNumber, etag, sha256: partSha256 })),
          });
          const verifying: UploadState = { ...current, state: "verifying", version: current.version + 1 };
          if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, verifying)) {
            throw conflict("upload state changed after multipart completion");
          }
          current = verifying;
        }
        if (current.state === "available") {
          await this.#requiredAvailableAsset(current.mediaReference, principal, binding);
          return { uploadId, mediaReference: current.mediaReference, state: "available" as const };
        }
        if (current.state === "verifying") {
          const original = await this.#readObject(current.objectKey, current.fileSize);
          try {
            if (original.sha256 !== current.expectedSha256 || original.bytes.byteLength !== current.fileSize) {
              return await this.#failUpload(current, "DIGEST_MISMATCH", new BrokerError(
                "DIGEST_MISMATCH",
                "completed media digest does not match the declared SHA-256",
                422,
                false,
              ));
            }
            let normalized;
            try {
              normalized = await this.dependencies.jpegNormalizer.normalize(original.bytes);
            } catch (error) {
              if (error instanceof BrokerError && error.code === "INVALID_MEDIA") {
                return await this.#failUpload(current, "INVALID_MEDIA", error);
              }
              throw error;
            }
            const canonicalBytes = Buffer.from(normalized.bytes);
            try {
              const canonicalSha256 = sha256(canonicalBytes);
              let safetyEvidence: MediaSafetyEvidence;
              try {
                safetyEvidence = await this.dependencies.safetyScanner.scan({
                  tenantId: current.tenantId,
                  actorId: current.actorId,
                  mediaReference: current.mediaReference,
                  canonicalSha256,
                  bytes: canonicalBytes,
                });
                this.#assertSafetyEvidence(
                  safetyEvidence,
                  canonicalSha256,
                  current.tenantId,
                  current.actorId,
                  current.mediaReference,
                );
              } catch (error) {
                if (error instanceof BrokerError && error.code === "SAFETY_REJECTED") {
                  return await this.#failUpload(current, "SAFETY_REJECTED", error);
                }
                throw error;
              }
              const normalizing: UploadState = {
                ...current,
                state: "normalizing",
                canonicalSha256,
                sourceSha256: original.sha256,
                lineageSha256: sha256(`ltm-media-lineage-v1\n${original.sha256}\n${canonicalSha256}\n`),
                canonicalByteLength: canonicalBytes.byteLength,
                width: normalized.width,
                height: normalized.height,
                metadataStripped: true,
                safetyEvidence,
                version: current.version + 1,
              };
              if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, normalizing)) {
                throw conflict("upload state changed before canonical replacement");
              }
              current = normalizing;
              await this.dependencies.objects.replace({
                objectKey: current.objectKey,
                bytes: canonicalBytes,
                sha256Base64: Buffer.from(canonicalSha256, "hex").toString("base64"),
              });
            } finally {
              canonicalBytes.fill(0);
            }
          } finally {
            original.bytes.fill(0);
          }
        }
        if (current.state !== "normalizing") throw conflict("upload normalization state changed");
        await this.#ensureCanonicalObject(current);
        await this.dependencies.assets.withAssetLease(current.mediaReference, async () => {
          const asset = await this.dependencies.assets.createAvailableAsset(this.#assetFromUpload(current));
          if (asset.state !== "available") throw notFound("media asset has already been deleted");
          const available: UploadState = { ...current, state: "available", version: current.version + 1 };
          if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, available)) {
            const after = await this.requiredUpload(uploadId, principal, binding);
            if (after.state !== "available") throw conflict("upload state changed during verification");
            current = after;
          } else current = available;
        });
        return { uploadId, mediaReference: current.mediaReference, state: "available" as const };
      }),
    ) as { readonly uploadId: string; readonly mediaReference: string; readonly state: "available" };
    await this.#requiredAvailableAsset(result.mediaReference, principal, binding);
    return result;
  }

  async cancelUpload(principal: Principal, input: { readonly uploadId: string; readonly idempotencyKey: string }): Promise<void> {
    const uploadId = identifier(input.uploadId, "uploadId");
    const binding = principalFingerprint(principal);
    const key = idempotencyKey(input.idempotencyKey);
    await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-upload.cancel", binding),
      key,
      fingerprint({ uploadId, binding }),
      async () => this.dependencies.uploads.withUploadLease(uploadId, async () => {
        const current = await this.requiredUpload(uploadId, principal, binding);
        if (current.state === "cancelled") return { cancelled: true };
        if (current.state === "available") throw conflict("available media cannot be cancelled as an active upload");
        if (current.state === "failed") return { cancelled: true };
        await this.dependencies.objects.abort({ objectKey: current.objectKey, providerUploadId: current.providerUploadId });
        if (current.state === "completing" || current.state === "verifying" || current.state === "normalizing") {
          await this.dependencies.objects.delete({ objectKey: current.objectKey });
        }
        const cancelled: UploadState = { ...current, state: "cancelled", version: current.version + 1 };
        if (!await this.dependencies.uploads.compareAndSwap(uploadId, current.version, cancelled)) {
          const after = await this.requiredUpload(uploadId, principal, binding);
          if (after.state !== "cancelled") throw conflict("upload state changed during cancellation");
        }
        return { cancelled: true };
      }),
    );
  }

  async resolveMediaIntake(
    principal: Principal,
    mediaReferenceValue: string,
    participantIdValues: readonly string[],
    idempotencyKeyValue: string,
  ): Promise<MediaIntakeResolution> {
    const mediaReference = identifier(mediaReferenceValue, "mediaReference");
    if (!Array.isArray(participantIdValues) || participantIdValues.length < 1 || participantIdValues.length > 20 ||
        participantIdValues.some((value) => typeof value !== "string") || new Set(participantIdValues).size !== participantIdValues.length) {
      throw validation("participantIds must be a bounded unique identifier list");
    }
    const participantIds = participantIdValues.map((value) => identifier(value, "participantId"));
    const binding = principalFingerprint(principal);
    const key = idempotencyKey(idempotencyKeyValue);
    const result = await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-intake.resolve", binding),
      key,
      fingerprint({ binding, mediaReference, participantIds }),
      async () => this.dependencies.assets.withAssetLease(mediaReference, async () => {
        const asset = await this.#requiredAvailableAsset(mediaReference, principal, binding);
        this.#assertSafetyEvidence(
          asset.safetyEvidence,
          asset.canonicalSha256,
          asset.tenantId,
          asset.ownerActorId,
          asset.mediaReference,
        );
        if (participantIds.length !== asset.safetyEvidence.faceCount) {
          throw new BrokerError("SAFETY_REJECTED", "every detected face requires one reviewed participant mapping", 422, false);
        }
        const participantMapping = await this.dependencies.safetyScanner.approveParticipants({
          tenantId: asset.tenantId,
          actorId: asset.ownerActorId,
          mediaReference,
          canonicalSha256: asset.canonicalSha256,
          scanEvidence: asset.safetyEvidence,
          participantIds,
        });
        this.#assertParticipantMapping(participantMapping, asset.safetyEvidence, participantIds);
        return {
          assetId: mediaReference,
          sourceSha256: asset.sourceSha256,
          canonicalSha256: asset.canonicalSha256,
          lineageSha256: asset.lineageSha256,
          byteLength: asset.byteLength,
          width: asset.width,
          height: asset.height,
          faceCount: asset.safetyEvidence.faceCount,
          scanEvidenceId: asset.safetyEvidence.evidenceId,
          scannerProvider: asset.safetyEvidence.provider,
          scanAssessedAt: asset.safetyEvidence.assessedAt,
          participantIds,
          participantMappingEvidenceId: participantMapping.evidenceId,
          participantMappingProvider: participantMapping.provider,
          participantMappingAssessedAt: participantMapping.assessedAt,
          participantMapComplete: true,
          mimeType: "image/jpeg",
          metadataStripped: true,
        } as unknown as JsonValue;
      }),
      { completedTtlMs: (response) => this.#participantMappingResultTtl(response) },
    );
    await this.#requiredAvailableAsset(mediaReference, principal, binding);
    return result as unknown as MediaIntakeResolution;
  }

  async deleteMediaAsset(
    principal: Principal,
    mediaReferenceValue: string,
    reasonValue: string,
    idempotencyKeyValue: string,
  ): Promise<MediaDeletionProjection> {
    const mediaReference = identifier(mediaReferenceValue, "mediaReference");
    const reason = bounded(reasonValue, "deletion reason", 500);
    const binding = principalFingerprint(principal);
    const key = idempotencyKey(idempotencyKeyValue);
    const result = await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-asset.delete", binding),
      key,
      fingerprint({ tenantId: principal.tenantId, actorId: principal.actorId, mediaReference, reason }),
      async () => this.dependencies.assets.withAssetLease(mediaReference, async () => {
        let asset = await this.#requiredTenantAsset(mediaReference, principal.tenantId);
        asset = await this.#ensureLifecycleBinding(asset);
        this.#assertDeletionAuthority(principal, asset);
        return this.#orchestrateDeletion(asset, principal.actorId, reason) as unknown as JsonValue;
      }),
      { completedTtlMs: 7 * 24 * 60 * 60_000 },
    );
    return result as unknown as MediaDeletionProjection;
  }

  mediaLifecycleAuthority(): {
    readonly schemaVersion: "ltm.media-authority.v1";
    readonly mediaLifecycleCatalogSha256: string;
    readonly mediaSafetyPolicySha256: string;
    readonly lifecycleIssuer: string;
    readonly lifecycleEnvironment: "test" | "development" | "staging" | "production";
    readonly lifecycleExpiresAt: string;
    readonly scannerProvider: string;
    readonly scannerPolicyId: string;
    readonly scannerModelVersion: string;
    readonly scannerKeyId: string;
    readonly scannerEnvironment: "test" | "development" | "staging" | "production";
  } {
    this.#lifecycle.assertCurrent(this.#clock());
    const scanner = this.dependencies.safetyScanner.authority?.();
    if (scanner === undefined) throw new BrokerError("NOT_CONFIGURED", "signed media safety receipt authority is not configured", 503, false);
    return {
      schemaVersion: "ltm.media-authority.v1",
      mediaLifecycleCatalogSha256: this.#lifecycle.catalogSha256,
      mediaSafetyPolicySha256: scanner.mediaSafetyPolicySha256,
      lifecycleIssuer: this.#lifecycle.issuer,
      lifecycleEnvironment: this.#lifecycle.environment,
      lifecycleExpiresAt: this.#lifecycle.expiresAt,
      scannerProvider: scanner.provider,
      scannerPolicyId: scanner.policyId,
      scannerModelVersion: scanner.modelVersion,
      scannerKeyId: scanner.keyId,
      scannerEnvironment: scanner.environment,
    };
  }

  async placeMediaLegalHold(principal: Principal, mediaReferenceValue: string, input: {
    readonly reason: string;
    readonly authority: string;
    readonly expiresAt?: string;
    readonly idempotencyKey: string;
  }): Promise<MediaAssetRecord["legalHold"]> {
    const mediaReference = identifier(mediaReferenceValue, "mediaReference");
    this.#assertPrivacyAuthority(principal);
    const reason = bounded(input.reason, "legal hold reason", 500);
    const authority = bounded(input.authority, "legal hold authority", 500);
    const expiresAt = input.expiresAt === undefined ? undefined : timestamp(input.expiresAt, "legal hold expiresAt");
    if (expiresAt !== undefined && Date.parse(expiresAt) <= this.#clock().getTime()) throw validation("legal hold expiry must be in the future");
    const result = await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-asset.legal-hold.place", principalFingerprint(principal)),
      idempotencyKey(input.idempotencyKey),
      fingerprint({ principal: principalFingerprint(principal), mediaReference, reason, authority, expiresAt }),
      async () => this.dependencies.assets.withAssetLease(mediaReference, async () => {
        let asset = await this.#requiredTenantAsset(mediaReference, principal.tenantId);
        asset = await this.#ensureLifecycleBinding(asset);
        if (asset.state === "deleted") throw conflict("a legal hold cannot be placed on a deleted asset");
        if (asset.lifecycle?.legalHoldMode === "prohibited") throw conflict("the signed lifecycle policy prohibits legal holds for this classification");
        if (this.#activeLegalHold(asset) !== undefined) throw conflict("media asset already has an active legal hold");
        const now = this.#clock().toISOString();
        const updated: MediaAssetRecord = {
          ...asset,
          version: asset.version + 1,
          updatedAt: now,
          legalHold: {
            holdId: `hold_${randomUUID()}`,
            reason,
            authority,
            placedByActorId: principal.actorId,
            placedAt: now,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        };
        if (!await this.dependencies.assets.compareAndSwapAsset(mediaReference, asset.version, updated)) throw conflict("media asset changed while placing legal hold");
        return updated.legalHold as unknown as JsonValue;
      }),
    );
    return result as unknown as MediaAssetRecord["legalHold"];
  }

  async releaseMediaLegalHold(principal: Principal, mediaReferenceValue: string, holdIdValue: string, input: {
    readonly reason: string;
    readonly authority: string;
    readonly idempotencyKey: string;
  }): Promise<MediaAssetRecord["legalHold"]> {
    const mediaReference = identifier(mediaReferenceValue, "mediaReference");
    const holdId = identifier(holdIdValue, "holdId");
    this.#assertPrivacyAuthority(principal);
    const reason = bounded(input.reason, "legal hold release reason", 500);
    const authority = bounded(input.authority, "legal hold release authority", 500);
    const result = await this.dependencies.idempotency.execute(
      this.#uploadOperation("media-asset.legal-hold.release", principalFingerprint(principal)),
      idempotencyKey(input.idempotencyKey),
      fingerprint({ principal: principalFingerprint(principal), mediaReference, holdId, reason, authority }),
      async () => this.dependencies.assets.withAssetLease(mediaReference, async () => {
        const asset = await this.#requiredTenantAsset(mediaReference, principal.tenantId);
        if (asset.legalHold?.holdId !== holdId) throw notFound("legal hold was not found");
        if (asset.legalHold.releasedAt !== undefined) return asset.legalHold as unknown as JsonValue;
        const now = this.#clock().toISOString();
        const updated: MediaAssetRecord = {
          ...asset,
          version: asset.version + 1,
          updatedAt: now,
          legalHold: {
            ...asset.legalHold,
            releasedAt: now,
            releasedByActorId: principal.actorId,
            releaseReason: reason,
            releaseAuthority: authority,
          },
        };
        if (!await this.dependencies.assets.compareAndSwapAsset(mediaReference, asset.version, updated)) throw conflict("media asset changed while releasing legal hold");
        return updated.legalHold as unknown as JsonValue;
      }),
    );
    return result as unknown as MediaAssetRecord["legalHold"];
  }

  async issueMediaDownloadAuthorization(principal: Principal, mediaReferenceValue: string, input: {
    readonly audience: string;
    readonly purpose: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly downloadUrl: string; readonly token: string; readonly expiresAt: string }> {
    const authorizer = this.dependencies.downloadAuthorizer;
    if (authorizer === undefined) throw new BrokerError("NOT_CONFIGURED", "media download authorization is not configured", 503, false);
    const asset = await this.#requiredTenantAsset(identifier(mediaReferenceValue, "mediaReference"), principal.tenantId);
    this.#assertMediaReadAuthority(principal, asset);
    return authorizer.issue(asset, principal, { ...input, now: this.#clock() });
  }

  async verifyMediaDownloadAuthorization(principal: Principal, token: string): Promise<{
    readonly mediaReference: string;
    readonly objectKey: string;
    readonly canonicalSha256: string;
    readonly expiresAt: string;
  }> {
    const authorizer = this.dependencies.downloadAuthorizer;
    if (authorizer === undefined) throw new BrokerError("NOT_CONFIGURED", "media download authorization is not configured", 503, false);
    const untrustedParts = bounded(token, "media download token", 8_192, 64).split(".");
    if (untrustedParts[0] === undefined) throw new BrokerError("AUTH_UNAUTHENTICATED", "media download authorization is invalid", 401, false);
    let mediaReference: string;
    try {
      const claims = JSON.parse(Buffer.from(untrustedParts[0], "base64url").toString("utf8")) as { readonly mediaReference?: unknown };
      mediaReference = identifier(claims.mediaReference, "mediaReference");
    } catch { throw new BrokerError("AUTH_UNAUTHENTICATED", "media download authorization is invalid", 401, false); }
    const asset = await this.#requiredTenantAsset(mediaReference, principal.tenantId);
    this.#assertMediaReadAuthority(principal, asset);
    const claims = authorizer.verify(token, principal, asset, this.#clock());
    return { mediaReference, objectKey: asset.objectKey, canonicalSha256: asset.canonicalSha256, expiresAt: claims.expiresAt };
  }

  async readAuthorizedMedia(principal: Principal, token: string): Promise<{
    readonly bytes: Buffer;
    readonly canonicalSha256: string;
    readonly mediaReference: string;
    readonly expiresAt: string;
  }> {
    const authorization = await this.verifyMediaDownloadAuthorization(principal, token);
    const media = await this.#readObject(authorization.objectKey, MAX_FILE_BYTES);
    if (media.sha256 !== authorization.canonicalSha256) {
      media.bytes.fill(0);
      throw dependency("authorized media digest no longer matches its durable binding", false);
    }
    return { bytes: media.bytes, canonicalSha256: media.sha256, mediaReference: authorization.mediaReference, expiresAt: authorization.expiresAt };
  }

  async runMediaLifecycleMaintenance(principal: Principal, input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly inspected: number;
    readonly expiredQueued: number;
    readonly reconciled: number;
    readonly pending: number;
    readonly resurrectionDetected: number;
    readonly cursor?: string;
  }> {
    const normalizedRoles = roles(principal.roles);
    if (!normalizedRoles.some((role) => role === "platform_admin" || role === "service_account")) throw notFound("maintenance task was not found");
    const page = await this.dependencies.assets.listAssets({ limit: safeInteger(input.limit, "maintenance limit", 1, 1_000), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
    let expiredQueued = 0;
    let reconciled = 0;
    let pending = 0;
    let resurrectionDetected = 0;
    for (const listed of page.assets) {
      if (listed.tenantId !== principal.tenantId) continue;
      await this.dependencies.assets.withAssetLease(listed.mediaReference, async () => {
        let asset = await this.#requiredTenantAsset(listed.mediaReference, principal.tenantId);
        asset = await this.#ensureLifecycleBinding(asset);
        if (asset.state === "available" && Date.parse(asset.lifecycle?.retentionExpiresAt ?? "") <= this.#clock().getTime()) {
          expiredQueued += 1;
          try { await this.#orchestrateDeletion(asset, principal.actorId, "automatic retention expiry"); reconciled += 1; }
          catch { pending += 1; }
          return;
        }
        if (asset.state === "deletion_pending") {
          if (asset.deletion?.nextRetryAt !== undefined && Date.parse(asset.deletion.nextRetryAt) > this.#clock().getTime()) {
            pending += 1;
            return;
          }
          try { await this.#orchestrateDeletion(asset, principal.actorId, asset.deletion?.reason ?? "deletion reconciliation"); reconciled += 1; }
          catch { pending += 1; }
          return;
        }
        if (asset.state === "deleted" && asset.lifecycle !== undefined && asset.deletion !== undefined) {
          const lifecycle = asset.lifecycle;
          let deletion = asset.deletion;
          const deletedAt = deletion.deletedAt;
          if (deletedAt === undefined) throw dependency("media deletion tombstone is incomplete", false);
          for (const target of lifecycle.deletionTargets) {
            const absent = await this.#lifecycle.verifyTargetAbsent(this.dependencies.objects, target);
            if (target.kind === "https") {
              try {
                const refreshedReceipt = await this.#lifecycle.executeDeletion(this.dependencies.objects, {
                  deletionRequestId: deletion.deletionRequestId,
                  tenantId: asset.tenantId,
                  mediaReference: asset.mediaReference,
                  canonicalSha256: asset.canonicalSha256,
                  policySha256: lifecycle.policySha256,
                  target,
                });
                const refreshedAt = this.#clock().toISOString();
                const refreshedDeletion: MediaAssetDeletionAudit = {
                  ...this.#deletionBase(deletion),
                  deletedAt,
                  targetReceipts: deletion.targetReceipts?.map((receipt) =>
                    receipt.targetId === target.targetId ? refreshedReceipt : receipt) ?? [],
                };
                const refreshed: MediaAssetRecord = {
                  ...asset,
                  version: asset.version + 1,
                  updatedAt: refreshedAt,
                  deletion: refreshedDeletion,
                };
                if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, refreshed)) {
                  throw conflict("media asset changed during remote deletion revalidation");
                }
                asset = refreshed;
                deletion = refreshedDeletion;
                reconciled += 1;
              } catch (error) {
                if (error instanceof BrokerError && error.code === "VERSION_CONFLICT") throw error;
                const now = this.#clock().toISOString();
                const attempts = deletion.attempts ?? [];
                const attemptNumber = Math.max(0, ...attempts
                  .filter((attempt) => attempt.targetId === target.targetId)
                  .map((attempt) => attempt.attempt)) + 1;
                const evidenceSha256 = sha256(JSON.stringify({
                  targetId: target.targetId,
                  attemptNumber,
                  error: error instanceof BrokerError ? error.code : "unknown",
                }));
                const failedAttempt: MediaDeletionAttempt = {
                  targetId: target.targetId,
                  attempt: attemptNumber,
                  attemptedAt: now,
                  outcome: "pending",
                  errorCode: error instanceof BrokerError ? error.code : "DEPENDENCY_UNAVAILABLE",
                  evidenceSha256,
                };
                const quarantined: MediaAssetRecord = {
                  ...asset,
                  state: "deletion_pending",
                  version: asset.version + 1,
                  updatedAt: now,
                  deletion: {
                    ...this.#deletionBase(deletion),
                    targetReceipts: deletion.targetReceipts?.filter((receipt) => receipt.targetId !== target.targetId) ?? [],
                    attempts: [...attempts, failedAttempt].slice(-1_024),
                    nextRetryAt: new Date(this.#clock().getTime() + Math.min(
                      24 * 60 * 60_000,
                      30_000 * 2 ** Math.min(attemptNumber - 1, 10),
                    )).toISOString(),
                    alert: {
                      code: "TARGET_PENDING",
                      targetId: target.targetId,
                      raisedAt: now,
                      detailSha256: evidenceSha256,
                    },
                  },
                };
                if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, quarantined)) {
                  throw conflict("media asset changed during remote deletion quarantine");
                }
                asset = quarantined;
                deletion = quarantined.deletion ?? deletion;
                pending += 1;
                break;
              }
            } else if (!absent.absent) {
              resurrectionDetected += 1;
              const receiptSet = deletion.targetReceipts?.filter((receipt) => receipt.targetId !== target.targetId) ?? [];
              const now = this.#clock().toISOString();
              const pendingAsset: MediaAssetRecord = {
                ...asset,
                state: "deletion_pending",
                version: asset.version + 1,
                updatedAt: now,
                deletion: {
                  ...this.#deletionBase(deletion),
                  targetReceipts: receiptSet,
                  alert: { code: "RESURRECTION_DETECTED", targetId: target.targetId, raisedAt: now, detailSha256: absent.evidenceSha256 },
                },
              };
              if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, pendingAsset)) throw conflict("media asset changed during resurrection quarantine");
              try { await this.#orchestrateDeletion(pendingAsset, principal.actorId, deletion.reason); reconciled += 1; }
              catch { pending += 1; }
              break;
            }
          }
        }
      });
    }
    return { inspected: page.assets.length, expiredQueued, reconciled, pending, resurrectionDetected, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  async scanMediaOrphans(principal: Principal, maximumObjectsValue: number): Promise<{
    readonly inspectedObjects: number;
    readonly orphanObjectKeys: readonly string[];
    readonly evidenceSha256: string;
  }> {
    const normalizedRoles = roles(principal.roles);
    if (!normalizedRoles.some((role) => role === "platform_admin" || role === "service_account" || role === "privacy_officer")) throw notFound("orphan scan was not found");
    const maximumObjects = safeInteger(maximumObjectsValue, "orphan scan maximumObjects", 1, 10_000);
    const known = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.dependencies.assets.listAssets({ limit: Math.min(1_000, maximumObjects), ...(cursor === undefined ? {} : { cursor }) });
      for (const asset of page.assets) {
        if (asset.tenantId !== principal.tenantId) continue;
        known.add(asset.objectKey);
        if (asset.lifecycle !== undefined) for (const target of asset.lifecycle.deletionTargets) if (target.kind === "s3-prefix") known.add(target.locator);
      }
      cursor = page.cursor;
      if (known.size > maximumObjects) throw dependency("asset inventory exceeds the orphan scan bound", false);
    } while (cursor !== undefined);
    const keys = await this.dependencies.objects.listObjectKeys({ prefix: `${this.#prefix}/`, maximumObjects });
    const orphanObjectKeys = keys.filter((key) => !known.has(key) && ![...known].some((entry) => entry.endsWith("/") && key.startsWith(entry))).sort();
    return { inspectedObjects: keys.length, orphanObjectKeys, evidenceSha256: sha256(JSON.stringify({ prefix: this.#prefix, keys, known: [...known].sort(), orphanObjectKeys })) };
  }

  async readiness(): Promise<{
    readonly ready: boolean;
    readonly checks: Readonly<Record<"redis" | "mediaAssetRegistry" | "s3" | "idp" | "wechatAppSecret" | "mediaSafetyScanner", boolean>>;
  }> {
    const [idempotency, uploads, mediaAssetRegistry, s3, idp, wechat, mediaSafetyScanner] = await Promise.all([
      this.dependencies.idempotency.readiness().catch(() => false),
      this.dependencies.uploads.readiness().catch(() => false),
      this.dependencies.assets.readiness().catch(() => false),
      this.dependencies.objects.readiness().catch(() => false),
      this.dependencies.identity.readiness().catch(() => false),
      this.dependencies.wechat.readiness().catch(() => false),
      this.dependencies.safetyScanner.readiness().catch(() => false),
    ]);
    const checks = { redis: idempotency && uploads, mediaAssetRegistry, s3, idp, wechatAppSecret: wechat, mediaSafetyScanner } as const;
    return { ready: Object.values(checks).every(Boolean), checks };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.dependencies.idempotency.close(), this.dependencies.uploads.close()]);
  }

  async requiredUpload(uploadId: string, principal: Principal, binding = principalFingerprint(principal)): Promise<UploadState> {
    const state = await this.dependencies.uploads.get(uploadId);
    if (state === undefined) throw notFound("upload was not found");
    this.#assertUploadSchema(state);
    if (state.tenantId !== principal.tenantId || state.actorId !== principal.actorId || state.principalSha256 !== binding) {
      throw notFound("upload was not found");
    }
    if (Date.parse(state.expiresAt) <= this.#clock().getTime() && state.state !== "available") throw conflict("upload has expired");
    return state;
  }

  #assertUploadSchema(state: UploadState): void {
    const partsValid = state.parts.length <= 10_000 && state.parts.every((part, index) => {
      const priorEnd = index === 0 ? -1 : state.parts[index - 1]?.end;
      const size = part.end - part.start + 1;
      return part.partNumber === index + 1 && part.start === (priorEnd ?? -1) + 1 && part.end >= part.start &&
        part.end < state.fileSize && /^[a-f0-9]{64}$/.test(part.sha256) &&
        size <= PART_BYTES && (part.end + 1 === state.fileSize || size === PART_BYTES) &&
        typeof part.etag === "string" && part.etag.length >= 1 && part.etag.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(part.etag);
    });
    const projectedOffset = state.parts.length === 0 ? 0 : (state.parts[state.parts.length - 1]?.end ?? -1) + 1;
    const completeState = ["completing", "verifying", "normalizing", "available"].includes(state.state);
    const canonicalState = state.state === "normalizing" || state.state === "available";
    const canonicalValid = canonicalState
      ? /^[a-f0-9]{64}$/.test(state.canonicalSha256 ?? "") &&
        /^[a-f0-9]{64}$/.test(state.sourceSha256 ?? "") && /^[a-f0-9]{64}$/.test(state.lineageSha256 ?? "") &&
        state.lineageSha256 === sha256(`ltm-media-lineage-v1\n${state.sourceSha256 ?? ""}\n${state.canonicalSha256 ?? ""}\n`) &&
        Number.isSafeInteger(state.canonicalByteLength) && (state.canonicalByteLength ?? 0) > 0 &&
        (state.canonicalByteLength ?? 0) <= MAX_FILE_BYTES &&
        Number.isSafeInteger(state.width) && (state.width ?? 0) > 0 && (state.width ?? 0) <= 8_192 &&
        Number.isSafeInteger(state.height) && (state.height ?? 0) > 0 && (state.height ?? 0) <= 8_192 &&
        state.metadataStripped === true && state.safetyEvidence !== undefined
      : state.canonicalSha256 === undefined && state.sourceSha256 === undefined && state.lineageSha256 === undefined &&
        state.canonicalByteLength === undefined &&
        state.width === undefined && state.height === undefined && state.metadataStripped === undefined &&
        state.safetyEvidence === undefined;
    if (state.schemaVersion !== "ltm.resumable-upload.v4" || !Number.isSafeInteger(state.version) || state.version < 1 ||
        !Number.isSafeInteger(state.fileSize) || state.fileSize < 1 || state.fileSize > MAX_FILE_BYTES ||
        !Number.isSafeInteger(state.nextOffset) || state.nextOffset !== projectedOffset || state.nextOffset > state.fileSize ||
        !/^[a-f0-9]{64}$/.test(state.expectedSha256) || !/^[a-f0-9]{64}$/.test(state.principalSha256) || !partsValid ||
        !["uploading", "completing", "verifying", "normalizing", "available", "cancelled", "failed"].includes(state.state) ||
        (completeState && state.nextOffset !== state.fileSize) ||
        !canonicalValid ||
        state.contentType !== "image/jpeg" || !state.objectKey.startsWith(`${this.#prefix}/`) || state.objectKey.includes("..") ||
        !/^[a-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(state.objectKey) ||
        typeof state.providerUploadId !== "string" || state.providerUploadId.length < 1 || state.providerUploadId.length > 1_024 ||
        (state.state === "failed"
          ? !["DIGEST_MISMATCH", "INVALID_MEDIA", "SAFETY_REJECTED", "CANONICAL_MISMATCH"].includes(state.failureCode ?? "")
          : state.failureCode !== undefined) ||
        !Number.isFinite(Date.parse(state.createdAt)) || !Number.isFinite(Date.parse(state.expiresAt))) {
      throw dependency("stored upload state is invalid", false);
    }
    identifier(state.uploadId, "stored uploadId");
    identifier(state.mediaReference, "stored mediaReference");
    identifier(state.tenantId, "stored tenantId");
    identifier(state.actorId, "stored actorId");
    identifier(state.clientRequestId, "stored clientRequestId");
    if (canonicalState && state.safetyEvidence !== undefined && state.canonicalSha256 !== undefined) {
      this.#assertSafetyEvidence(
        state.safetyEvidence,
        state.canonicalSha256,
        state.tenantId,
        state.actorId,
        state.mediaReference,
      );
    }
  }

  #sessionResultTtl(response: JsonValue): number {
    const session = (response as unknown as { readonly session?: { readonly expiresAt?: unknown } }).session;
    if (typeof session?.expiresAt !== "string") throw dependency("idempotent session response is invalid", false);
    const remaining = Date.parse(session.expiresAt) - this.#clock().getTime();
    if (!Number.isFinite(remaining) || remaining <= 0) throw dependency("idempotent session already expired", false);
    return Math.max(1, Math.min(SESSION_IDEMPOTENCY_MAX_TTL_MS, remaining));
  }

  #participantMappingResultTtl(response: JsonValue): number {
    const assessedAtValue = (response as unknown as { readonly participantMappingAssessedAt?: unknown })
      .participantMappingAssessedAt;
    const assessedAt = timestamp(assessedAtValue, "participant mapping assessedAt");
    const age = this.#clock().getTime() - Date.parse(assessedAt);
    const remaining = PARTICIPANT_MAPPING_MAX_AGE_MS - age;
    if (age < -5 * 60_000 || remaining < 1) {
      throw dependency("participant mapping evidence is outside the idempotency freshness window", false);
    }
    return Math.min(PARTICIPANT_MAPPING_IDEMPOTENCY_TTL_MS, remaining);
  }

  #uploadOperation(operation: string, principalSha256: string): string {
    return `${operation}.${principalSha256.slice(0, 32)}`;
  }

  #assetFromUpload(state: UploadState): MediaAssetRecord {
    if (state.state !== "normalizing" || state.sourceSha256 === undefined || state.canonicalSha256 === undefined ||
        state.lineageSha256 === undefined || state.canonicalByteLength === undefined || state.width === undefined ||
        state.height === undefined || state.metadataStripped !== true || state.safetyEvidence === undefined) {
      throw dependency("verified upload cannot be projected into the durable media registry", false);
    }
    const updatedAt = new Date(Math.max(Date.parse(state.createdAt), Date.parse(state.safetyEvidence.assessedAt))).toISOString();
    const asset: MediaAssetRecord = {
      schemaVersion: "ltm.media-asset.v2",
      mediaReference: state.mediaReference,
      uploadId: state.uploadId,
      tenantId: state.tenantId,
      ownerActorId: state.actorId,
      ownerPrincipalSha256: state.principalSha256,
      objectKey: state.objectKey,
      sourceSha256: state.sourceSha256,
      canonicalSha256: state.canonicalSha256,
      lineageSha256: state.lineageSha256,
      byteLength: state.canonicalByteLength,
      width: state.width,
      height: state.height,
      metadataStripped: true,
      safetyEvidence: state.safetyEvidence,
      state: "available",
      version: 1,
      createdAt: state.createdAt,
      updatedAt,
      lifecycle: this.#lifecycle.bindAsset({ objectKey: state.objectKey, createdAt: state.createdAt, now: this.#clock() }),
    };
    validateMediaAssetRecord(asset);
    return asset;
  }

  async #requiredTenantAsset(mediaReference: string, tenantId: string): Promise<MediaAssetRecord> {
    const asset = await this.dependencies.assets.getAsset(mediaReference);
    if (asset === undefined) throw notFound("media asset was not found");
    validateMediaAssetRecord(asset);
    this.dependencies.safetyScanner.verifyEvidence?.(asset.safetyEvidence);
    if (asset.lifecycle !== undefined) {
      this.#lifecycle.assertBinding(asset.lifecycle, { objectKey: asset.objectKey, createdAt: asset.createdAt, now: this.#clock() });
    }
    if (asset.mediaReference !== mediaReference || asset.tenantId !== tenantId) throw notFound("media asset was not found");
    return asset;
  }

  async #requiredAvailableAsset(
    mediaReference: string,
    principal: Principal,
    binding = principalFingerprint(principal),
  ): Promise<MediaAssetRecord> {
    const asset = await this.#requiredTenantAsset(mediaReference, principal.tenantId);
    if (asset.state !== "available" || asset.ownerActorId !== principal.actorId || asset.ownerPrincipalSha256 !== binding) {
      throw notFound("media asset was not found");
    }
    return asset;
  }

  async #ensureLifecycleBinding(asset: MediaAssetRecord): Promise<MediaAssetRecord> {
    if (asset.schemaVersion === "ltm.media-asset.v2" && asset.lifecycle !== undefined) return asset;
    const lifecycle = this.#lifecycle.bindAsset({ objectKey: asset.objectKey, createdAt: asset.createdAt, now: this.#clock() });
    const now = this.#clock().toISOString();
    const priorDeletion = asset.deletion;
    const upgradedDeletion = priorDeletion === undefined ? undefined : {
      deletionRequestId: priorDeletion.deletionRequestId,
      auditId: priorDeletion.auditId,
      requestedByActorId: priorDeletion.requestedByActorId,
      reason: priorDeletion.reason,
      requestedAt: priorDeletion.requestedAt,
      policySha256: lifecycle.policySha256,
      targetIds: lifecycle.deletionTargets.map((target) => target.targetId),
      targetReceipts: [] as readonly MediaDeletionTargetReceipt[],
      attempts: [] as readonly MediaDeletionAttempt[],
    };
    const upgraded: MediaAssetRecord = {
      ...asset,
      schemaVersion: "ltm.media-asset.v2",
      lifecycle,
      state: priorDeletion === undefined ? asset.state : "deletion_pending",
      version: asset.version + 1,
      updatedAt: now,
      ...(upgradedDeletion === undefined ? {} : { deletion: upgradedDeletion }),
    };
    if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, upgraded)) {
      throw conflict("media asset changed while binding the lifecycle policy");
    }
    return upgraded;
  }

  #assertDeletionAuthority(principal: Principal, asset: MediaAssetRecord): void {
    const normalizedRoles = roles(principal.roles);
    const privacyAuthority = normalizedRoles.some((role) => role === "platform_admin" || role === "privacy_officer");
    const dataSubject = asset.ownerActorId === principal.actorId &&
      normalizedRoles.some((role) => role === "consumer" || role === "guardian" || role === "household_admin") &&
      asset.lifecycle?.subjectDeletionAllowed === true;
    const purposeAllowed = privacyAuthority
      ? ["product_operation", "privacy_compliance", "data_deletion"].includes(principal.purpose)
      : ["data_deletion", "privacy_request", "product_operation"].includes(principal.purpose);
    if ((!privacyAuthority && !dataSubject) || !purposeAllowed) throw notFound("media asset was not found");
  }

  #assertPrivacyAuthority(principal: Principal): void {
    const normalizedRoles = roles(principal.roles);
    if (!normalizedRoles.some((role) => role === "platform_admin" || role === "privacy_officer") ||
        !["product_operation", "privacy_compliance", "legal_hold"].includes(principal.purpose)) {
      throw notFound("media asset was not found");
    }
  }

  #assertMediaReadAuthority(principal: Principal, asset: MediaAssetRecord): void {
    const normalizedRoles = roles(principal.roles);
    if (asset.state !== "available" || (asset.ownerActorId !== principal.actorId &&
        !normalizedRoles.some((role) => role === "privacy_officer" || role === "platform_admin"))) {
      throw notFound("media asset was not found");
    }
  }

  #activeLegalHold(asset: MediaAssetRecord): MediaAssetRecord["legalHold"] | undefined {
    const hold = asset.legalHold;
    if (hold === undefined || hold.releasedAt !== undefined) return undefined;
    if (hold.expiresAt !== undefined && Date.parse(hold.expiresAt) <= this.#clock().getTime()) return undefined;
    return hold;
  }

  async #orchestrateDeletion(assetValue: MediaAssetRecord, requestedByActorId: string, reason: string): Promise<MediaDeletionProjection> {
    let asset = assetValue;
    if (asset.lifecycle === undefined || asset.schemaVersion !== "ltm.media-asset.v2") throw dependency("media lifecycle binding is missing", false);
    if (asset.state === "deleted") return this.#deletedProjection(asset);
    const activeHold = this.#activeLegalHold(asset);
    if (activeHold !== undefined) throw new BrokerError("LEGAL_HOLD_ACTIVE", `media deletion is blocked by legal hold ${activeHold.holdId}`, 409, false);
    if (asset.lifecycle.legalHoldMode === "required" && asset.legalHold === undefined) {
      throw new BrokerError("LEGAL_HOLD_ACTIVE", "the signed lifecycle policy requires a reasoned legal-hold review before deletion", 409, false);
    }
    if (asset.state === "available") {
      const now = this.#clock().toISOString();
      const pending: MediaAssetRecord = {
        ...asset,
        state: "deletion_pending",
        version: asset.version + 1,
        updatedAt: now,
        deletion: {
          deletionRequestId: `delete_${randomUUID()}`,
          auditId: `audit_${randomUUID()}`,
          requestedByActorId: identifier(requestedByActorId, "actorId"),
          reason,
          requestedAt: now,
          policySha256: asset.lifecycle.policySha256,
          targetIds: asset.lifecycle.deletionTargets.map((target) => target.targetId),
          targetReceipts: [],
          attempts: [],
        },
      };
      if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, pending)) {
        throw conflict("media asset changed before deletion was recorded");
      }
      asset = pending;
    }
    if (asset.state !== "deletion_pending" || asset.deletion === undefined || asset.lifecycle === undefined ||
        asset.deletion.targetReceipts === undefined || asset.deletion.attempts === undefined) {
      throw conflict("media asset cannot be deleted in its current state");
    }
    const lifecycle: MediaLifecycleBinding = asset.lifecycle;
    let deletion: MediaAssetDeletionAudit = asset.deletion;
    for (const target of lifecycle.deletionTargets) {
      const targetReceipts = deletion.targetReceipts ?? [];
      const attempts = deletion.attempts ?? [];
      if (targetReceipts.some((receipt) => receipt.targetId === target.targetId)) continue;
      const attemptNumber = Math.max(0, ...attempts
        .filter((attempt) => attempt.targetId === target.targetId)
        .map((attempt) => attempt.attempt)) + 1;
      const attemptedAt = this.#clock().toISOString();
      try {
        const receipt = await this.#lifecycle.executeDeletion(this.dependencies.objects, {
          deletionRequestId: deletion.deletionRequestId,
          tenantId: asset.tenantId,
          mediaReference: asset.mediaReference,
          canonicalSha256: asset.canonicalSha256,
          policySha256: lifecycle.policySha256,
          target,
        });
        const completedAttempt: MediaDeletionAttempt = {
          targetId: target.targetId,
          attempt: attemptNumber,
          attemptedAt,
          outcome: "deleted",
          evidenceSha256: receipt.evidenceSha256,
        };
        const completedTarget: MediaAssetRecord = {
          ...asset,
          version: asset.version + 1,
          updatedAt: this.#clock().toISOString(),
          deletion: {
            ...this.#deletionBase(deletion),
            targetReceipts: [...targetReceipts, receipt],
            attempts: [...attempts, completedAttempt].slice(-1_024),
          },
        };
        if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, completedTarget)) {
          throw conflict("media asset changed while recording a deletion receipt");
        }
        asset = completedTarget;
        deletion = completedTarget.deletion ?? deletion;
      } catch (error) {
        if (error instanceof BrokerError && error.code === "VERSION_CONFLICT") throw error;
        const pending = error instanceof MediaLifecycleTargetPending;
        const evidenceSha256 = pending
          ? error.evidenceSha256
          : sha256(JSON.stringify({ targetId: target.targetId, attemptNumber, error: error instanceof BrokerError ? error.code : "unknown" }));
        const failedAttempt: MediaDeletionAttempt = {
          targetId: target.targetId,
          attempt: attemptNumber,
          attemptedAt,
          outcome: pending && error.pendingCode === "OBJECT_LOCK_ACTIVE" ? "held" : "pending",
          errorCode: error instanceof BrokerError ? error.code : "DEPENDENCY_UNAVAILABLE",
          evidenceSha256,
        };
        const nextRetryAt = new Date(this.#clock().getTime() + Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(attemptNumber - 1, 10))).toISOString();
        const alerted: MediaAssetRecord = {
          ...asset,
          version: asset.version + 1,
          updatedAt: this.#clock().toISOString(),
          deletion: {
            ...this.#deletionBase(deletion),
            targetReceipts,
            attempts: [...attempts, failedAttempt].slice(-1_024),
            nextRetryAt,
            alert: {
              code: pending && error.pendingCode === "OBJECT_LOCK_ACTIVE" ? "OBJECT_LOCK_ACTIVE" : "TARGET_PENDING",
              targetId: target.targetId,
              raisedAt: this.#clock().toISOString(),
              detailSha256: evidenceSha256,
            },
          },
        };
        if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, alerted)) {
          throw conflict("media asset changed while recording a deletion alert");
        }
        if (error instanceof BrokerError) throw error;
        throw dependency(`media deletion target ${target.targetId} remains pending`);
      }
    }
    if ((deletion.targetReceipts?.length ?? 0) !== lifecycle.deletionTargets.length) {
      throw new BrokerError("DELETION_PENDING", "media deletion target receipts are incomplete", 409, true);
    }
    const deletedAt = this.#clock().toISOString();
    const deleted: MediaAssetRecord = {
      ...asset,
      state: "deleted",
      version: asset.version + 1,
      updatedAt: deletedAt,
      deletion: { ...this.#deletionBase(deletion), deletedAt },
    };
    if (!await this.dependencies.assets.compareAndSwapAsset(asset.mediaReference, asset.version, deleted)) {
      const after = await this.#requiredTenantAsset(asset.mediaReference, asset.tenantId);
      if (after.state !== "deleted") throw conflict("media asset changed while recording its deletion tombstone");
      return this.#deletedProjection(after);
    }
    return this.#deletedProjection(deleted);
  }

  #deletionBase(deletion: MediaAssetDeletionAudit): MediaAssetDeletionAudit {
    if (deletion.policySha256 === undefined || deletion.targetIds === undefined || deletion.targetReceipts === undefined ||
        deletion.attempts === undefined) throw dependency("media deletion orchestration is incomplete", false);
    return {
      deletionRequestId: deletion.deletionRequestId,
      auditId: deletion.auditId,
      requestedByActorId: deletion.requestedByActorId,
      reason: deletion.reason,
      requestedAt: deletion.requestedAt,
      policySha256: deletion.policySha256,
      targetIds: deletion.targetIds,
      targetReceipts: deletion.targetReceipts,
      attempts: deletion.attempts,
    };
  }

  #deletedProjection(asset: MediaAssetRecord): MediaDeletionProjection {
    if (asset.state !== "deleted" || asset.deletion?.deletedAt === undefined || asset.lifecycle === undefined ||
        asset.deletion.targetReceipts === undefined || asset.deletion.targetReceipts.length !== asset.lifecycle.deletionTargets.length) {
      throw dependency("media deletion tombstone is incomplete", false);
    }
    return {
      mediaReference: asset.mediaReference,
      state: "deleted",
      auditId: asset.deletion.auditId,
      deletionRequestId: asset.deletion.deletionRequestId,
      requestedAt: asset.deletion.requestedAt,
      deletedAt: asset.deletion.deletedAt,
      policyId: asset.lifecycle.policyId,
      policySha256: asset.lifecycle.policySha256,
      classification: asset.lifecycle.classification,
      retentionDays: asset.lifecycle.retentionDays,
      retentionExpiresAt: asset.lifecycle.retentionExpiresAt,
      encrypted: true,
      deletionTargets: asset.lifecycle.deletionTargets.map((target) => target.targetId),
      targetReceipts: asset.deletion.targetReceipts,
    };
  }

  async #readObject(objectKey: string, maximumBytes: number): Promise<{
    readonly bytes: Buffer;
    readonly sha256: string;
  }> {
    const sha256Hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of await this.dependencies.objects.read({ objectKey, maximumBytes })) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maximumBytes) {
        for (const stored of chunks) stored.fill(0);
        bytes.fill(0);
        throw dependency("object store returned oversized media", false);
      }
      sha256Hash.update(bytes);
      chunks.push(bytes);
    }
    if (total < 1) throw dependency("object store returned empty media", false);
    const combined = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    return { bytes: combined, sha256: sha256Hash.digest("hex") };
  }

  async #ensureCanonicalObject(state: UploadState): Promise<void> {
    if (state.canonicalSha256 === undefined || state.canonicalByteLength === undefined ||
        state.width === undefined || state.height === undefined || state.metadataStripped !== true) {
      throw dependency("normalizing upload is missing canonical media state", false);
    }
    let actual = await this.#readObject(state.objectKey, MAX_FILE_BYTES);
    try {
      if (actual.sha256 !== state.canonicalSha256 || actual.bytes.byteLength !== state.canonicalByteLength) {
        if (actual.sha256 !== state.expectedSha256 || actual.bytes.byteLength !== state.fileSize) {
          return await this.#failUpload(state, "CANONICAL_MISMATCH", new BrokerError(
            "DIGEST_MISMATCH",
            "stored media matches neither the uploaded nor canonical digest",
            422,
            false,
          ));
        }
        const normalized = await this.dependencies.jpegNormalizer.normalize(actual.bytes);
        const canonicalBytes = Buffer.from(normalized.bytes);
        try {
          if (sha256(canonicalBytes) !== state.canonicalSha256 || canonicalBytes.byteLength !== state.canonicalByteLength ||
              normalized.width !== state.width || normalized.height !== state.height || normalized.metadataStripped !== true) {
            return await this.#failUpload(state, "CANONICAL_MISMATCH", new BrokerError(
              "DIGEST_MISMATCH",
              "canonical JPEG normalization is not stable",
              422,
              false,
            ));
          }
          await this.dependencies.objects.replace({
            objectKey: state.objectKey,
            bytes: canonicalBytes,
            sha256Base64: Buffer.from(state.canonicalSha256, "hex").toString("base64"),
          });
        } finally { canonicalBytes.fill(0); }
        actual.bytes.fill(0);
        actual = await this.#readObject(state.objectKey, MAX_FILE_BYTES);
      }
      if (actual.sha256 !== state.canonicalSha256 || actual.bytes.byteLength !== state.canonicalByteLength) {
        return await this.#failUpload(state, "CANONICAL_MISMATCH", new BrokerError(
          "DIGEST_MISMATCH",
          "canonical media object digest confirmation failed",
          422,
          false,
        ));
      }
    } finally { actual.bytes.fill(0); }
  }

  async #failUpload(state: UploadState, failureCode: NonNullable<UploadState["failureCode"]>, error: BrokerError): Promise<never> {
    await this.dependencies.objects.delete({ objectKey: state.objectKey });
    const failedRecord: Record<string, unknown> = {
      ...state,
      state: "failed",
      failureCode,
      version: state.version + 1,
    };
    for (const field of [
      "canonicalSha256", "sourceSha256", "lineageSha256", "canonicalByteLength",
      "width", "height", "metadataStripped", "safetyEvidence",
    ]) delete failedRecord[field];
    const failed = failedRecord as unknown as UploadState;
    if (!await this.dependencies.uploads.compareAndSwap(state.uploadId, state.version, failed)) {
      throw conflict("upload state changed while recording a media verification failure");
    }
    throw error;
  }

  #assertSafetyEvidence(
    evidence: MediaSafetyEvidence,
    canonicalSha256: string,
    tenantId: string,
    actorId: string,
    mediaReference: string,
  ): void {
    try {
      if (!["ltm.media-safety-evidence.v2", "ltm.media-safety-evidence.v3"].includes(evidence.version) ||
          evidence.canonicalSha256 !== canonicalSha256 ||
          evidence.tenantId !== tenantId || evidence.actorId !== actorId || evidence.mediaReference !== mediaReference ||
          evidence.malwareState !== "clean" || evidence.contentPolicyState !== "allowed" ||
          !Number.isSafeInteger(evidence.faceCount) || evidence.faceCount < 1 || evidence.faceCount > 20 ||
          !Array.isArray(evidence.faceSubjectReferences) || evidence.faceSubjectReferences.length !== evidence.faceCount ||
          new Set(evidence.faceSubjectReferences).size !== evidence.faceSubjectReferences.length) {
        throw new Error("closed response mismatch");
      }
      identifier(evidence.requestNonce, "media safety requestNonce");
      identifier(evidence.evidenceId, "media safety evidenceId");
      identifier(evidence.provider, "media safety provider");
      for (const reference of evidence.faceSubjectReferences) identifier(reference, "face subject reference");
      timestamp(evidence.assessedAt, "media safety assessedAt");
    } catch {
      // The provider adapter is the sole authority that may map an explicit
      // HTTP 422 to SAFETY_REJECTED. Malformed returned evidence is a broken
      // dependency contract and must never trigger destructive cleanup.
      throw dependency("media safety authority returned invalid closed evidence", false);
    }
  }

  #assertParticipantMapping(
    evidence: import("./contracts.js").ParticipantMappingEvidence,
    scanEvidence: MediaSafetyEvidence,
    participantIds: readonly string[],
  ): void {
    try {
      if (evidence.version !== "ltm.media-participant-mapping.v2" || evidence.state !== "approved" ||
          evidence.tenantId !== scanEvidence.tenantId || evidence.actorId !== scanEvidence.actorId ||
          evidence.mediaReference !== scanEvidence.mediaReference ||
          evidence.canonicalSha256 !== scanEvidence.canonicalSha256 || evidence.scanEvidenceId !== scanEvidence.evidenceId ||
          evidence.participantIds.length !== participantIds.length ||
          !evidence.participantIds.every((value, index) => value === participantIds[index]) ||
          evidence.faceSubjectReferences.length !== scanEvidence.faceSubjectReferences.length ||
          !evidence.faceSubjectReferences.every((value, index) => value === scanEvidence.faceSubjectReferences[index])) {
        throw new Error("closed response mismatch");
      }
      identifier(evidence.requestNonce, "participant mapping requestNonce");
      identifier(evidence.evidenceId, "participant mapping evidenceId");
      identifier(evidence.provider, "participant mapping provider");
      for (const participantId of evidence.participantIds) identifier(participantId, "participant mapping participantId");
      for (const reference of evidence.faceSubjectReferences) identifier(reference, "participant mapping face subject reference");
      timestamp(evidence.assessedAt, "participant mapping assessedAt");
    } catch {
      throw dependency("participant mapping authority returned invalid closed evidence", false);
    }
  }

  #assertActive(state: UploadState): void {
    this.#assertUploadSchema(state);
    if (state.state !== "uploading") throw conflict("upload is not accepting chunks");
  }
}
