import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export type BrokerErrorCode =
  | "AUTH_UNAUTHENTICATED"
  | "VALIDATION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "DIGEST_MISMATCH"
  | "INVALID_MEDIA"
  | "SAFETY_REJECTED"
  | "LEGAL_HOLD_ACTIVE"
  | "POLICY_EXPIRED"
  | "DELETION_PENDING"
  | "NOT_CONFIGURED"
  | "DEPENDENCY_UNAVAILABLE"
  | "CONFIGURATION_INVALID";

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface Principal {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly purpose: string;
}

export interface SessionProjection {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly purpose: string;
}

export interface VerifiedWechatIdentity {
  readonly appId: string;
  readonly openId: string;
  readonly unionId?: string;
  readonly sessionKeySha256: string;
  readonly verifiedAt: string;
}

export interface WechatCodeExchangePort {
  exchange(code: string): Promise<VerifiedWechatIdentity>;
  readiness(): Promise<boolean>;
}

export interface EnterpriseIdentityPort {
  createSession(input: {
    readonly identity: VerifiedWechatIdentity;
    readonly consentVersion: string;
    readonly clientRequestId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<SessionProjection>;
  refreshSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<SessionProjection>;
  revokeSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<void>;
  readiness(): Promise<boolean>;
}

export interface IdempotencyStore {
  execute<T extends JsonValue>(
    operation: string,
    key: string,
    fingerprint: string,
    work: () => Promise<T>,
    policy?: {
      readonly completedTtlMs?: number | ((response: T) => number);
    },
  ): Promise<T>;
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

export interface MultipartPart {
  readonly partNumber: number;
  readonly start: number;
  readonly end: number;
  readonly etag: string;
  readonly sha256: string;
}

export interface MediaSafetyEvidence {
  readonly version: "ltm.media-safety-evidence.v2" | "ltm.media-safety-evidence.v3";
  readonly requestNonce: string;
  readonly evidenceId: string;
  readonly provider: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly mediaReference: string;
  readonly canonicalSha256: string;
  readonly malwareState: "clean";
  readonly contentPolicyState: "allowed";
  readonly faceCount: number;
  readonly faceSubjectReferences: readonly string[];
  readonly assessedAt: string;
  readonly environment?: "test" | "development" | "staging" | "production";
  readonly policyId?: string;
  readonly policySha256?: string;
  readonly modelVersion?: string;
  readonly keyId?: string;
  readonly signature?: string;
}

export interface ParticipantMappingEvidence {
  readonly version: "ltm.media-participant-mapping.v2";
  readonly requestNonce: string;
  readonly evidenceId: string;
  readonly provider: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly mediaReference: string;
  readonly canonicalSha256: string;
  readonly scanEvidenceId: string;
  readonly participantIds: readonly string[];
  readonly faceSubjectReferences: readonly string[];
  readonly state: "approved";
  readonly assessedAt: string;
}

export interface NormalizedJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly metadataStripped: true;
}

export interface JpegNormalizerPort {
  normalize(bytes: Uint8Array): Promise<NormalizedJpeg>;
}

export interface MediaSafetyScannerPort {
  scan(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly mediaReference: string;
    readonly canonicalSha256: string;
    readonly bytes: Uint8Array;
  }): Promise<MediaSafetyEvidence>;
  approveParticipants(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly mediaReference: string;
    readonly canonicalSha256: string;
    readonly scanEvidence: MediaSafetyEvidence;
    readonly participantIds: readonly string[];
  }): Promise<ParticipantMappingEvidence>;
  readiness(): Promise<boolean>;
  authority?(): {
    readonly mediaSafetyPolicySha256: string;
    readonly provider: string;
    readonly policyId: string;
    readonly modelVersion: string;
    readonly keyId: string;
    readonly environment: "test" | "development" | "staging" | "production";
  } | undefined;
  verifyEvidence?(evidence: MediaSafetyEvidence): void;
}

export type UploadFailureCode = "DIGEST_MISMATCH" | "INVALID_MEDIA" | "SAFETY_REJECTED" | "CANONICAL_MISMATCH";
export type UploadStateName = "uploading" | "completing" | "verifying" | "normalizing" | "available" | "cancelled" | "failed";

export interface UploadState {
  readonly schemaVersion: "ltm.resumable-upload.v4";
  readonly uploadId: string;
  readonly mediaReference: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly principalSha256: string;
  readonly clientRequestId: string;
  readonly fileSize: number;
  readonly expectedSha256: string;
  readonly contentType: "image/jpeg";
  readonly objectKey: string;
  readonly providerUploadId: string;
  readonly nextOffset: number;
  readonly parts: readonly MultipartPart[];
  readonly state: UploadStateName;
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly canonicalSha256?: string;
  readonly sourceSha256?: string;
  readonly lineageSha256?: string;
  readonly canonicalByteLength?: number;
  readonly width?: number;
  readonly height?: number;
  readonly metadataStripped?: true;
  readonly safetyEvidence?: MediaSafetyEvidence;
  readonly failureCode?: UploadFailureCode;
}

export interface UploadStateStore {
  create(state: UploadState): Promise<void>;
  get(uploadId: string): Promise<UploadState | undefined>;
  compareAndSwap(uploadId: string, expectedVersion: number, state: UploadState): Promise<boolean>;
  withUploadLease<T>(uploadId: string, work: () => Promise<T>): Promise<T>;
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

export interface MediaAssetDeletionAudit {
  readonly deletionRequestId: string;
  readonly auditId: string;
  readonly requestedByActorId: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly deletedAt?: string;
  readonly policySha256?: string;
  readonly targetIds?: readonly string[];
  readonly targetReceipts?: readonly MediaDeletionTargetReceipt[];
  readonly attempts?: readonly MediaDeletionAttempt[];
  readonly nextRetryAt?: string;
  readonly alert?: MediaDeletionAlert;
}

export type MediaClassification = "raw" | "intermediate" | "derived" | "share" | "print" | "backup";

export interface MediaLifecycleTargetBinding {
  readonly targetId: string;
  readonly kind: "s3-object" | "s3-prefix" | "https";
  /** Server-derived locator. It is never accepted from a deletion request. */
  readonly locator: string;
}

export interface MediaLifecycleBinding {
  readonly schemaVersion: "ltm.media-lifecycle-binding.v1";
  readonly catalogId: string;
  readonly catalogIssuer: string;
  readonly catalogEnvironment: "test" | "development" | "staging" | "production";
  readonly policyId: string;
  readonly policySha256: string;
  readonly classification: MediaClassification;
  readonly retentionDays: number;
  readonly retentionExpiresAt: string;
  readonly encrypted: true;
  readonly subjectDeletionAllowed: boolean;
  readonly legalHoldMode: "allowed" | "required" | "prohibited";
  readonly deletionTargets: readonly MediaLifecycleTargetBinding[];
}

export interface MediaLegalHold {
  readonly holdId: string;
  readonly reason: string;
  readonly authority: string;
  readonly placedByActorId: string;
  readonly placedAt: string;
  readonly expiresAt?: string;
  readonly releasedAt?: string;
  readonly releasedByActorId?: string;
  readonly releaseReason?: string;
  readonly releaseAuthority?: string;
}

export interface MediaDeletionTargetReceipt {
  readonly schemaVersion: "ltm.media-deletion-target-receipt.v1";
  readonly targetId: string;
  readonly targetKind: "s3-object" | "s3-prefix" | "https";
  readonly deletionRequestId: string;
  readonly tenantId: string;
  readonly mediaReference: string;
  readonly canonicalSha256: string;
  readonly policySha256: string;
  readonly state: "deleted";
  readonly completedAt: string;
  readonly evidenceSha256: string;
  readonly providerReceiptId?: string;
  readonly deletedVersions?: number;
  readonly deletedMarkers?: number;
  readonly verifiedAbsent?: true;
}

export interface MediaDeletionAttempt {
  readonly targetId: string;
  readonly attempt: number;
  readonly attemptedAt: string;
  readonly outcome: "deleted" | "pending" | "held";
  readonly errorCode?: string;
  readonly evidenceSha256?: string;
}

export interface MediaDeletionAlert {
  readonly code: "TARGET_PENDING" | "OBJECT_LOCK_ACTIVE" | "RESURRECTION_DETECTED" | "ORPHAN_DETECTED";
  readonly targetId: string;
  readonly raisedAt: string;
  readonly detailSha256: string;
}

export interface MediaAssetRecord {
  readonly schemaVersion: "ltm.media-asset.v1" | "ltm.media-asset.v2";
  readonly mediaReference: string;
  readonly uploadId: string;
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly ownerPrincipalSha256: string;
  readonly objectKey: string;
  readonly sourceSha256: string;
  readonly canonicalSha256: string;
  readonly lineageSha256: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly metadataStripped: true;
  readonly safetyEvidence: MediaSafetyEvidence;
  readonly state: "available" | "deletion_pending" | "deleted";
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle?: MediaLifecycleBinding;
  readonly legalHold?: MediaLegalHold;
  readonly deletion?: MediaAssetDeletionAudit;
}

/** Durable, non-expiring media authority independent from resumable-upload TTL. */
export interface MediaAssetStore {
  createAvailableAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord>;
  getAsset(mediaReference: string): Promise<MediaAssetRecord | undefined>;
  compareAndSwapAsset(mediaReference: string, expectedVersion: number, asset: MediaAssetRecord): Promise<boolean>;
  withAssetLease<T>(mediaReference: string, work: () => Promise<T>): Promise<T>;
  listAssets(input: { readonly cursor?: string; readonly limit: number }): Promise<{
    readonly assets: readonly MediaAssetRecord[];
    readonly cursor?: string;
  }>;
  readiness(): Promise<boolean>;
}

export interface MultipartObjectStore {
  create(input: { readonly objectKey: string; readonly contentType: "image/jpeg" }): Promise<string>;
  putPart(input: {
    readonly objectKey: string;
    readonly providerUploadId: string;
    readonly partNumber: number;
    readonly bytes: Uint8Array;
    readonly sha256Base64: string;
  }): Promise<{ readonly etag: string; readonly sha256Base64?: string }>;
  complete(input: {
    readonly objectKey: string;
    readonly providerUploadId: string;
    readonly parts: readonly Pick<MultipartPart, "partNumber" | "etag" | "sha256">[];
  }): Promise<void>;
  read(input: { readonly objectKey: string; readonly maximumBytes: number }): Promise<AsyncIterable<Uint8Array>>;
  replace(input: {
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly sha256Base64: string;
  }): Promise<void>;
  abort(input: { readonly objectKey: string; readonly providerUploadId: string }): Promise<void>;
  delete(input: { readonly objectKey: string }): Promise<void>;
  deleteVerified(input: {
    readonly objectKey?: string;
    readonly prefix?: string;
    readonly maximumObjects: number;
  }): Promise<{
    readonly state: "deleted" | "held";
    readonly deletedVersions: number;
    readonly deletedMarkers: number;
    readonly verifiedAbsent: boolean;
    readonly evidenceSha256: string;
    readonly hold?: { readonly reason: "legal-hold" | "retention"; readonly expiresAt?: string };
  }>;
  verifyAbsent(input: { readonly objectKey?: string; readonly prefix?: string; readonly maximumObjects: number }): Promise<{
    readonly absent: boolean;
    readonly objectCount: number;
    readonly evidenceSha256: string;
  }>;
  listObjectKeys(input: { readonly prefix: string; readonly maximumObjects: number }): Promise<readonly string[]>;
  readiness(): Promise<boolean>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export class RotatingSecretFile {
  constructor(
    readonly path: string,
    private readonly minimumBytes = 20,
    private readonly maximumBytes = 8_192,
  ) {
    if (!path.startsWith("/")) throw configuration("secret projection path must be absolute");
  }

  read(): string {
    try {
      const metadata = statSync(this.path);
      if (!metadata.isFile() || metadata.size < this.minimumBytes || metadata.size > this.maximumBytes ||
          (metadata.mode & 0o022) !== 0) {
        throw new Error("unsafe secret projection");
      }
      return bounded(readFileSync(this.path, "utf8").trim(), "secret projection", this.maximumBytes, this.minimumBytes);
    } catch {
      throw dependency("secret projection is unavailable");
    }
  }

  ready(): boolean {
    try { this.read(); return true; } catch { return false; }
  }
}

export class DigestBearerAuthenticator {
  readonly #digests: readonly Buffer[];

  constructor(digests: readonly string[]) {
    const unique = [...new Set(digests)];
    if (unique.length < 1 || unique.length > 8 || unique.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
      throw configuration("one to eight workload bearer SHA-256 digests are required");
    }
    this.#digests = unique.map((value) => Buffer.from(value, "hex"));
  }

  authenticate(headerValue: string | undefined): void {
    const match = /^Bearer ([^\s]+)$/i.exec(headerValue ?? "");
    const token = match?.[1];
    if (token === undefined || token.length < 20 || token.length > 8_192 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw unauthenticated();
    }
    const supplied = createHash("sha256").update(token, "utf8").digest();
    let valid = false;
    for (const expected of this.#digests) valid = timingSafeEqual(supplied, expected) || valid;
    if (!valid) throw unauthenticated();
  }
}

export function principalFingerprint(principal: Principal): string {
  return sha256(JSON.stringify({
    actorId: identifier(principal.actorId, "actorId"),
    tenantId: identifier(principal.tenantId, "tenantId"),
    roles: roles(principal.roles),
    purpose: bounded(principal.purpose, "purpose", 120),
  }));
}

export function normalizePrincipal(value: unknown): Principal {
  const record = object(value, "principal");
  exactKeys(record, ["actorId", "tenantId", "roles", "purpose"], "principal");
  return {
    actorId: identifier(record.actorId, "actorId"),
    tenantId: identifier(record.tenantId, "tenantId"),
    roles: roles(record.roles),
    purpose: bounded(record.purpose, "purpose", 120),
  };
}

export function validateSession(value: SessionProjection, now: Date = new Date()): SessionProjection {
  const allowedRoles = new Set([
    "consumer", "household_admin", "guardian", "partner_employee", "partner_admin", "studio_operator",
    "support_agent", "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account",
  ]);
  const normalizedRoles = roles(value.roles);
  if (normalizedRoles.some((role) => !allowedRoles.has(role))) throw dependency("identity provider returned unsupported roles", false);
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - now.getTime();
  if (lifetime <= 0 || lifetime > 24 * 60 * 60_000) throw dependency("identity provider returned an invalid session lifetime", false);
  return {
    accessToken: bounded(value.accessToken, "accessToken", 8_192, 20),
    expiresAt,
    tenantId: identifier(value.tenantId, "tenantId"),
    actorId: identifier(value.actorId, "actorId"),
    roles: normalizedRoles,
    purpose: bounded(value.purpose, "purpose", 120),
  };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw validation(`${label} contains unsupported or missing fields`);
  }
}

export function bounded(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validation(`${label} is invalid`);
  }
  return value;
}

export function identifier(value: unknown, label: string): string {
  const normalized = bounded(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) throw validation(`${label} is invalid`);
  return normalized;
}

export function idempotencyKey(value: string): string {
  return bounded(value, "idempotency key", 200);
}

export function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw validation(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

export function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw validation(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) throw validation(`${label} is invalid`);
  return new Date(Date.parse(value)).toISOString();
}

export function roles(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some((entry) => typeof entry !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(entry))) {
    throw validation("roles are invalid");
  }
  return [...new Set(value as string[])].sort();
}

export function validateMediaAssetRecord(asset: MediaAssetRecord): void {
  try {
    assertMediaAssetRecord(asset);
  } catch (error) {
    if (error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE") throw error;
    throw dependency("stored media asset is invalid", false);
  }
}

function assertMediaAssetRecord(asset: MediaAssetRecord): void {
  const safety = asset.safetyEvidence;
  const lifecycleValid = asset.schemaVersion === "ltm.media-asset.v1"
    ? asset.lifecycle === undefined
    : validLifecycleBinding(asset.lifecycle, asset.createdAt);
  const deletionValid = asset.state === "available"
    ? asset.deletion === undefined
    : asset.deletion !== undefined &&
      identifier(asset.deletion.deletionRequestId, "deletionRequestId") !== "" &&
      identifier(asset.deletion.auditId, "deletion auditId") !== "" &&
      identifier(asset.deletion.requestedByActorId, "deletion requestedByActorId") !== "" &&
      bounded(asset.deletion.reason, "deletion reason", 500) !== "" &&
      Number.isFinite(Date.parse(timestamp(asset.deletion.requestedAt, "deletion requestedAt"))) &&
      (asset.state === "deleted"
        ? asset.deletion.deletedAt !== undefined && Number.isFinite(Date.parse(timestamp(asset.deletion.deletedAt, "deletion deletedAt")))
        : asset.deletion.deletedAt === undefined) &&
      (asset.schemaVersion === "ltm.media-asset.v1" || validDeletionOrchestration(asset));
  if (!['ltm.media-asset.v1', 'ltm.media-asset.v2'].includes(asset.schemaVersion) ||
      !["available", "deletion_pending", "deleted"].includes(asset.state) ||
      !Number.isSafeInteger(asset.version) || asset.version < 1 ||
      !/^[a-f0-9]{64}$/.test(asset.ownerPrincipalSha256) ||
      !/^[a-f0-9]{64}$/.test(asset.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(asset.canonicalSha256) ||
      asset.lineageSha256 !== sha256(`ltm-media-lineage-v1\n${asset.sourceSha256}\n${asset.canonicalSha256}\n`) ||
      !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > 25 * 1024 * 1024 ||
      !Number.isSafeInteger(asset.width) || asset.width < 1 || asset.width > 8_192 ||
      !Number.isSafeInteger(asset.height) || asset.height < 1 || asset.height > 8_192 ||
      asset.metadataStripped !== true ||
      typeof asset.objectKey !== "string" || !/^[a-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(asset.objectKey) ||
      asset.objectKey.includes("..") || asset.objectKey.startsWith("/") || asset.objectKey.endsWith("/") ||
      safety === undefined || !["ltm.media-safety-evidence.v2", "ltm.media-safety-evidence.v3"].includes(safety.version) ||
      safety.tenantId !== asset.tenantId || safety.actorId !== asset.ownerActorId ||
      safety.mediaReference !== asset.mediaReference || safety.canonicalSha256 !== asset.canonicalSha256 ||
      safety.malwareState !== "clean" || safety.contentPolicyState !== "allowed" ||
      !Number.isSafeInteger(safety.faceCount) || safety.faceCount < 1 || safety.faceCount > 20 ||
      !Array.isArray(safety.faceSubjectReferences) || safety.faceSubjectReferences.length !== safety.faceCount ||
      new Set(safety.faceSubjectReferences).size !== safety.faceSubjectReferences.length || !validSafetyAuthority(safety) ||
      !lifecycleValid || !deletionValid ||
      !validLegalHold(asset.legalHold)) {
    throw dependency("stored media asset is invalid", false);
  }
  identifier(asset.mediaReference, "mediaReference");
  identifier(asset.uploadId, "uploadId");
  identifier(asset.tenantId, "tenantId");
  identifier(asset.ownerActorId, "ownerActorId");
  identifier(safety.requestNonce, "media safety requestNonce");
  identifier(safety.evidenceId, "media safety evidenceId");
  identifier(safety.provider, "media safety provider");
  for (const reference of safety.faceSubjectReferences) identifier(reference, "face subject reference");
  const createdAt = Date.parse(timestamp(asset.createdAt, "asset createdAt"));
  const updatedAt = Date.parse(timestamp(asset.updatedAt, "asset updatedAt"));
  const assessedAt = Date.parse(timestamp(safety.assessedAt, "media safety assessedAt"));
  if (updatedAt < createdAt || assessedAt < createdAt - 5 * 60_000) throw dependency("stored media asset chronology is invalid", false);
}

function validLifecycleBinding(value: MediaLifecycleBinding | undefined, createdAtValue: string): boolean {
  if (value === undefined || value.schemaVersion !== "ltm.media-lifecycle-binding.v1" ||
      !/^[a-f0-9]{64}$/.test(value.policySha256) || value.encrypted !== true ||
      !["raw", "intermediate", "derived", "share", "print", "backup"].includes(value.classification) ||
      !["allowed", "required", "prohibited"].includes(value.legalHoldMode) ||
      !Number.isSafeInteger(value.retentionDays) || value.retentionDays < 0 || value.retentionDays > 36_500 ||
      !Array.isArray(value.deletionTargets) || value.deletionTargets.length < 1 || value.deletionTargets.length > 64 ||
      !["test", "development", "staging", "production"].includes(value.catalogEnvironment) ||
      new Set(value.deletionTargets.map((entry) => entry.targetId)).size !== value.deletionTargets.length ||
      value.deletionTargets.some((entry) => !["s3-object", "s3-prefix", "https"].includes(entry.kind) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entry.targetId) || entry.locator.length < 1 ||
        entry.locator.length > 2_048 || /[\u0000-\u001f\u007f]/.test(entry.locator))) return false;
  try {
    identifier(value.catalogId, "lifecycle catalogId");
    identifier(value.catalogIssuer, "lifecycle catalogIssuer");
    identifier(value.policyId, "lifecycle policyId");
    const createdAt = Date.parse(timestamp(createdAtValue, "asset createdAt"));
    const expiresAt = Date.parse(timestamp(value.retentionExpiresAt, "retentionExpiresAt"));
    return expiresAt >= createdAt;
  } catch { return false; }
}

function validSafetyAuthority(value: MediaSafetyEvidence): boolean {
  if (value.version === "ltm.media-safety-evidence.v2") {
    return value.environment === undefined && value.policyId === undefined && value.policySha256 === undefined &&
      value.modelVersion === undefined && value.keyId === undefined && value.signature === undefined;
  }
  return value.environment !== undefined && ["test", "development", "staging", "production"].includes(value.environment) &&
    typeof value.policyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.policyId) &&
    typeof value.policySha256 === "string" && /^[a-f0-9]{64}$/.test(value.policySha256) &&
    typeof value.modelVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.modelVersion) &&
    typeof value.keyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.keyId) &&
    typeof value.signature === "string" && /^[A-Za-z0-9_-]{80,256}$/.test(value.signature);
}

function validDeletionOrchestration(asset: MediaAssetRecord): boolean {
  const deletion = asset.deletion;
  const lifecycle = asset.lifecycle;
  if (deletion === undefined || lifecycle === undefined || deletion.policySha256 !== lifecycle.policySha256 ||
      deletion.targetIds === undefined || deletion.targetReceipts === undefined || deletion.attempts === undefined ||
      deletion.targetIds.length !== lifecycle.deletionTargets.length ||
      deletion.targetIds.some((id, index) => id !== lifecycle.deletionTargets[index]?.targetId) ||
      new Set(deletion.targetReceipts.map((receipt) => receipt.targetId)).size !== deletion.targetReceipts.length ||
      deletion.targetReceipts.some((receipt) => receipt.schemaVersion !== "ltm.media-deletion-target-receipt.v1" ||
        receipt.deletionRequestId !== deletion.deletionRequestId || receipt.tenantId !== asset.tenantId ||
        receipt.mediaReference !== asset.mediaReference || receipt.canonicalSha256 !== asset.canonicalSha256 ||
        receipt.policySha256 !== lifecycle.policySha256 || receipt.state !== "deleted" ||
        !deletion.targetIds?.includes(receipt.targetId) || !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256) ||
        !Number.isFinite(Date.parse(receipt.completedAt))) || deletion.attempts.length > 1_024 ||
      deletion.attempts.some((attempt) => !deletion.targetIds?.includes(attempt.targetId) ||
        !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || !Number.isFinite(Date.parse(attempt.attemptedAt)))) return false;
  if (asset.state === "deleted" && deletion.targetReceipts.length !== deletion.targetIds.length) return false;
  if (deletion.nextRetryAt !== undefined && !Number.isFinite(Date.parse(deletion.nextRetryAt))) return false;
  return deletion.alert === undefined || (/^[a-f0-9]{64}$/.test(deletion.alert.detailSha256) &&
    deletion.targetIds.includes(deletion.alert.targetId) && Number.isFinite(Date.parse(deletion.alert.raisedAt)));
}

function validLegalHold(hold: MediaLegalHold | undefined): boolean {
  if (hold === undefined) return true;
  try {
    identifier(hold.holdId, "legal holdId");
    identifier(hold.placedByActorId, "legal hold actorId");
    bounded(hold.reason, "legal hold reason", 500);
    bounded(hold.authority, "legal hold authority", 500);
    timestamp(hold.placedAt, "legal hold placedAt");
    if (hold.expiresAt !== undefined) timestamp(hold.expiresAt, "legal hold expiresAt");
    const released = hold.releasedAt !== undefined || hold.releasedByActorId !== undefined ||
      hold.releaseReason !== undefined || hold.releaseAuthority !== undefined;
    if (!released) return true;
    if (hold.releasedAt === undefined || hold.releasedByActorId === undefined || hold.releaseReason === undefined ||
        hold.releaseAuthority === undefined) return false;
    timestamp(hold.releasedAt, "legal hold releasedAt");
    identifier(hold.releasedByActorId, "legal hold releasedByActorId");
    bounded(hold.releaseReason, "legal hold releaseReason", 500);
    bounded(hold.releaseAuthority, "legal hold releaseAuthority", 500);
    return Date.parse(hold.releasedAt) >= Date.parse(hold.placedAt);
  } catch { return false; }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function configuration(message: string): BrokerError {
  return new BrokerError("CONFIGURATION_INVALID", message, 500, false);
}

export function validation(message: string): BrokerError {
  return new BrokerError("VALIDATION_FAILED", message, 400, false);
}

export function conflict(message: string, idempotency = false): BrokerError {
  return new BrokerError(idempotency ? "IDEMPOTENCY_CONFLICT" : "VERSION_CONFLICT", message, 409, false);
}

export function notFound(message: string): BrokerError {
  return new BrokerError("RESOURCE_NOT_FOUND", message, 404, false);
}

export function dependency(message: string, retryable = true): BrokerError {
  return new BrokerError("DEPENDENCY_UNAVAILABLE", message, 503, retryable);
}

export function unauthenticated(): BrokerError {
  return new BrokerError("AUTH_UNAUTHENTICATED", "workload authentication failed", 401, false);
}
