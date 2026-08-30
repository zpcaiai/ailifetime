export const MOBILE_REMOTE_CONFIG_SCHEMA = "ltm.mobile.remote-config.v1" as const;
export const MOBILE_PUSH_SCHEMA = "ltm.mobile.push.v1" as const;

export interface PrincipalBinding {
  readonly tenantId: string;
  readonly actorId: string;
  readonly purpose: string;
  readonly consentRevision: number;
  readonly revocationRevision: number;
}

export interface CipherPort {
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<string>;
  open(sealed: string, associatedData: Uint8Array): Promise<Uint8Array>;
}

export interface NamespacedCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<readonly string[]>;
}

export interface OfflineCacheRecord {
  readonly key: string;
  readonly kind: "metadata" | "thumbnail";
  readonly value: string;
  readonly expiresAt: string;
  readonly consentRevision: number;
}

interface PersistedCacheRecord extends OfflineCacheRecord, PrincipalBinding {
  readonly schemaVersion: "ltm.mobile.cache.v1";
  readonly storedAt: string;
}

/** Encrypted, purpose-bound cache. Raw media and credentials are structurally impossible inputs. */
export class RevocableOfflineCache {
  readonly #prefix: string;
  readonly #clock: () => Date;
  #binding: PrincipalBinding | undefined;

  constructor(
    private readonly store: NamespacedCacheStore,
    private readonly cipher: CipherPort,
    options: { readonly namespace?: string; readonly clock?: () => Date } = {},
  ) {
    this.#prefix = `${safeToken(options.namespace ?? "ltm.mobile.cache", "cache namespace")}:`;
    this.#clock = options.clock ?? (() => new Date());
  }

  async activate(binding: PrincipalBinding): Promise<void> {
    this.#binding = validateBinding(binding);
    await this.sweep();
  }

  async put(record: OfflineCacheRecord): Promise<void> {
    const binding = this.requireBinding();
    const key = safeToken(record.key, "cache key");
    if (record.kind !== "metadata" && record.kind !== "thumbnail") throw new Error("offline cache kind is not permitted");
    if (typeof record.value !== "string" || record.value.length === 0) throw new Error("offline cache value is empty");
    const maximum = record.kind === "thumbnail" ? 768 * 1_024 : 64 * 1_024;
    if (new TextEncoder().encode(record.value).byteLength > maximum) throw new Error("offline cache value exceeds its minimized limit");
    if (!Number.isSafeInteger(record.consentRevision) || record.consentRevision !== binding.consentRevision) {
      throw new Error("offline cache consent revision is stale");
    }
    const now = validInstant(this.#clock(), "cache clock");
    const expiresAt = parseInstant(record.expiresAt, "cache expiry");
    if (expiresAt <= now || expiresAt - now > 7 * 24 * 60 * 60 * 1_000) throw new Error("offline cache expiry is outside policy");
    const payload: PersistedCacheRecord = {
      schemaVersion: "ltm.mobile.cache.v1",
      ...binding,
      ...record,
      key,
      storedAt: new Date(now).toISOString(),
    };
    const aad = this.aad(binding, key);
    const sealed = await this.cipher.seal(new TextEncoder().encode(JSON.stringify(payload)), aad);
    if (typeof sealed !== "string" || sealed.length < 32) throw new Error("cache cipher returned an invalid envelope");
    await this.store.set(this.storageKey(key), sealed);
  }

  async get(keyValue: string): Promise<OfflineCacheRecord | null> {
    const binding = this.requireBinding();
    const key = safeToken(keyValue, "cache key");
    const storageKey = this.storageKey(key);
    const sealed = await this.store.get(storageKey);
    if (sealed === null) return null;
    try {
      const plaintext = await this.cipher.open(sealed, this.aad(binding, key));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      const record = validatePersistedCache(parsed);
      if (!sameBinding(record, binding) || record.key !== key || record.consentRevision !== binding.consentRevision ||
          record.revocationRevision !== binding.revocationRevision || parseInstant(record.expiresAt, "cache expiry") <= validInstant(this.#clock(), "cache clock")) {
        await this.store.delete(storageKey);
        return null;
      }
      return { key, kind: record.kind, value: record.value, expiresAt: record.expiresAt, consentRevision: record.consentRevision };
    } catch (error) {
      await this.store.delete(storageKey);
      throw new Error("offline cache authentication failed closed", { cause: error });
    }
  }

  async applyRemoteRevocation(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly revision: number;
    readonly keys?: readonly string[];
    readonly clearAll?: boolean;
  }): Promise<void> {
    const binding = this.requireBinding();
    if (input.tenantId !== binding.tenantId || input.actorId !== binding.actorId) throw new Error("remote cache revocation binding is invalid");
    if (!Number.isSafeInteger(input.revision) || input.revision <= binding.revocationRevision) throw new Error("remote cache revocation is stale");
    if (input.clearAll === true) await this.purge();
    else {
      if (!Array.isArray(input.keys) || input.keys.length === 0) throw new Error("remote cache revocation has no targets");
      await Promise.all(input.keys.map((key) => this.store.delete(this.storageKey(safeToken(key, "cache revocation key")))));
    }
    this.#binding = { ...binding, revocationRevision: input.revision };
  }

  async sweep(): Promise<void> {
    const binding = this.requireBinding();
    for (const storageKey of await this.store.keys(this.#prefix)) {
      const key = storageKey.slice(this.#prefix.length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(key)) {
        await this.store.delete(storageKey);
        continue;
      }
      try { await this.get(key); } catch { /* authentication failure already deletes the entry */ }
    }
    if (binding.revocationRevision < 0) throw new Error("unreachable revocation revision");
  }

  async purge(): Promise<void> {
    await Promise.all((await this.store.keys(this.#prefix)).map((key) => this.store.delete(key)));
  }

  private requireBinding(): PrincipalBinding {
    if (this.#binding === undefined) throw new Error("offline cache requires a server-verified principal binding");
    return this.#binding;
  }

  private storageKey(key: string): string { return `${this.#prefix}${key}`; }
  private aad(binding: PrincipalBinding, key: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      schemaVersion: "ltm.mobile.cache-aad.v1", key, tenantId: binding.tenantId, actorId: binding.actorId,
      purpose: binding.purpose, consentRevision: binding.consentRevision, revocationRevision: binding.revocationRevision,
    }));
  }
}

export interface DetectedFaceQuality {
  readonly id: string;
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
  readonly occlusionRatio: number;
  readonly frameAreaRatio: number;
}

export interface CaptureQualityInput {
  readonly mimeType: "image/jpeg" | "image/png" | "image/heic" | "image/heif";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly laplacianVariance: number;
  readonly meanLuminance: number;
  readonly orientationNormalized: boolean;
  readonly metadataStripped: boolean;
  readonly faces: readonly DetectedFaceQuality[];
  readonly selectedFaceIds: readonly string[];
  readonly disclosureAccepted: boolean;
  readonly retentionAccepted: boolean;
  readonly authorizationReferences: readonly string[];
}

export interface CaptureQualityDecision {
  readonly accepted: boolean;
  readonly serverRecheckRequired: true;
  readonly reasons: readonly string[];
  readonly selectedFaceIds: readonly string[];
}

/** Deterministic policy over measurements produced by native on-device image and face analyzers. */
export function assessCaptureQuality(input: CaptureQualityInput): CaptureQualityDecision {
  const reasons: string[] = [];
  if (!new Set(["image/jpeg", "image/png", "image/heic", "image/heif"]).has(input.mimeType)) reasons.push("UNSUPPORTED_MEDIA_TYPE");
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 768 || input.height < 768) reasons.push("RESOLUTION_TOO_LOW");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > 25 * 1_024 * 1_024) reasons.push("FILE_SIZE_OUT_OF_RANGE");
  if (!Number.isFinite(input.laplacianVariance) || input.laplacianVariance < 90) reasons.push("IMAGE_BLURRY");
  if (!Number.isFinite(input.meanLuminance) || input.meanLuminance < 45) reasons.push("IMAGE_TOO_DARK");
  if (input.meanLuminance > 225) reasons.push("IMAGE_OVEREXPOSED");
  if (!input.orientationNormalized) reasons.push("ORIENTATION_NOT_NORMALIZED");
  if (!input.metadataStripped) reasons.push("METADATA_NOT_STRIPPED");
  if (!input.disclosureAccepted || !input.retentionAccepted) reasons.push("CAPTURE_DISCLOSURE_REQUIRED");
  if (input.faces.length === 0) reasons.push("NO_FACE_DETECTED");
  const faceIds = new Set<string>();
  for (const face of input.faces) {
    const id = safeToken(face.id, "face selection id");
    if (faceIds.has(id)) reasons.push("DUPLICATE_FACE_ID");
    faceIds.add(id);
    if (![face.yawDegrees, face.pitchDegrees, face.rollDegrees, face.occlusionRatio, face.frameAreaRatio].every(Number.isFinite)) {
      reasons.push("FACE_MEASUREMENT_INVALID");
      continue;
    }
    if (Math.abs(face.yawDegrees) > 28 || Math.abs(face.pitchDegrees) > 24 || Math.abs(face.rollDegrees) > 25) reasons.push("FACE_ANGLE_UNSUITABLE");
    if (face.occlusionRatio > 0.35) reasons.push("FACE_OCCLUDED");
    if (face.frameAreaRatio < 0.04) reasons.push("FACE_TOO_SMALL");
  }
  if (new Set(input.selectedFaceIds).size !== input.selectedFaceIds.length || input.selectedFaceIds.some((id) => !faceIds.has(id))) {
    reasons.push("FACE_SELECTION_INVALID");
  }
  if (input.faces.length > 1 && input.selectedFaceIds.length === 0) reasons.push("MULTI_FACE_SELECTION_REQUIRED");
  if (input.authorizationReferences.length < input.selectedFaceIds.length ||
      input.authorizationReferences.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value))) {
    reasons.push("PARTICIPANT_AUTHORIZATION_REQUIRED");
  }
  const unique = [...new Set(reasons)];
  return { accepted: unique.length === 0, serverRecheckRequired: true, reasons: unique, selectedFaceIds: [...input.selectedFaceIds] };
}

export interface UploadBinding { readonly tenantId: string; readonly actorId: string; readonly purpose: string }
export interface UploadSessionState extends UploadBinding {
  readonly schemaVersion: "ltm.mobile.upload.v1";
  readonly uploadId: string;
  readonly sourceUri: string;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly nextOffset: number;
  readonly wholeFileSha256: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
}

export interface UploadSessionStore {
  load(uploadId: string): Promise<UploadSessionState | null>;
  save(state: UploadSessionState): Promise<void>;
  delete(uploadId: string): Promise<void>;
}

export interface UploadChunkSource {
  read(uri: string, offset: number, length: number): Promise<Uint8Array>;
  remove(uri: string): Promise<void>;
}

export interface ResumableUploadApi {
  create(input: Omit<UploadSessionState, "schemaVersion" | "uploadId" | "nextOffset" | "attempts" | "expiresAt">): Promise<{
    readonly uploadId: string; readonly nextOffset: number; readonly chunkBytes: number; readonly expiresAt: string;
  }>;
  putChunk(input: {
    readonly uploadId: string;
    readonly offset: number;
    readonly totalBytes: number;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly nextOffset: number }>;
  complete(input: { readonly uploadId: string; readonly wholeFileSha256: string; readonly idempotencyKey: string }): Promise<{ readonly assetId: string; readonly state: "server_validation_pending" }>;
  cancel(input: { readonly uploadId: string; readonly reason: "user_requested" | "expired" | "authorization_changed" }): Promise<void>;
}

export interface UploadNetworkPort { current(): Promise<{ readonly connected: boolean; readonly metered: boolean }> }
export interface DigestPort { sha256(bytes: Uint8Array): Promise<string> }

export class ResumableUploadCoordinator {
  constructor(
    private readonly api: ResumableUploadApi,
    private readonly state: UploadSessionStore,
    private readonly source: UploadChunkSource,
    private readonly digest: DigestPort,
    private readonly network: UploadNetworkPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: {
    readonly binding: UploadBinding; readonly sourceUri: string; readonly totalBytes: number;
    readonly wholeFileSha256: string; readonly idempotencyKey: string;
  }): Promise<UploadSessionState> {
    const binding = validateUploadBinding(input.binding);
    const sourceUri = localPrivateUri(input.sourceUri);
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > 25 * 1_024 * 1_024) throw new Error("upload size is invalid");
    const wholeFileSha256 = sha256(input.wholeFileSha256, "whole-file checksum");
    const idempotencyKey = safeToken(input.idempotencyKey, "upload idempotency key");
    const created = await this.api.create({ ...binding, sourceUri, totalBytes: input.totalBytes, chunkBytes: 0, wholeFileSha256, idempotencyKey });
    const uploadId = safeToken(created.uploadId, "upload id");
    if (created.nextOffset !== 0 || !Number.isSafeInteger(created.chunkBytes) || created.chunkBytes < 64 * 1_024 || created.chunkBytes > 5 * 1_024 * 1_024) {
      throw new Error("server upload session contract is invalid");
    }
    if (parseInstant(created.expiresAt, "upload expiry") <= validInstant(this.clock(), "upload clock")) throw new Error("server upload session is already expired");
    const value: UploadSessionState = {
      schemaVersion: "ltm.mobile.upload.v1", uploadId, ...binding, sourceUri, totalBytes: input.totalBytes,
      chunkBytes: created.chunkBytes, nextOffset: 0, wholeFileSha256, expiresAt: created.expiresAt, idempotencyKey, attempts: 0,
    };
    await this.state.save(value);
    return value;
  }

  async resume(uploadIdValue: string, bindingValue: UploadBinding, options: { readonly lowDataMode?: boolean; readonly maxChunks?: number } = {}): Promise<
    { readonly state: "suspended"; readonly reason: "offline" | "metered" | "budget"; readonly nextOffset: number } |
    { readonly state: "server_validation_pending"; readonly assetId: string }
  > {
    const uploadId = safeToken(uploadIdValue, "upload id");
    const binding = validateUploadBinding(bindingValue);
    let current = await this.state.load(uploadId);
    if (current === null) throw new Error("upload session is not resumable");
    validateUploadState(current);
    if (!sameUploadBinding(current, binding)) {
      await this.api.cancel({ uploadId, reason: "authorization_changed" });
      await Promise.all([this.state.delete(uploadId), this.source.remove(current.sourceUri)]);
      throw new Error("upload principal changed; local media was purged");
    }
    if (parseInstant(current.expiresAt, "upload expiry") <= validInstant(this.clock(), "upload clock")) {
      await this.api.cancel({ uploadId, reason: "expired" });
      await Promise.all([this.state.delete(uploadId), this.source.remove(current.sourceUri)]);
      throw new Error("upload session expired and was purged");
    }
    const maximum = options.maxChunks ?? 16;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) throw new Error("background upload chunk budget is invalid");
    let completedChunks = 0;
    while (current.nextOffset < current.totalBytes) {
      const connection = await this.network.current();
      if (!connection.connected) return { state: "suspended", reason: "offline", nextOffset: current.nextOffset };
      if (options.lowDataMode === true && connection.metered) return { state: "suspended", reason: "metered", nextOffset: current.nextOffset };
      if (completedChunks >= maximum) return { state: "suspended", reason: "budget", nextOffset: current.nextOffset };
      const length = Math.min(current.chunkBytes, current.totalBytes - current.nextOffset);
      const bytes = await this.source.read(current.sourceUri, current.nextOffset, length);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error("local upload chunk is incomplete");
      const chunkSha256 = sha256(await this.digest.sha256(bytes), "chunk checksum");
      const response = await this.api.putChunk({
        uploadId, offset: current.nextOffset, totalBytes: current.totalBytes, bytes, sha256: chunkSha256,
        idempotencyKey: `${current.idempotencyKey}:${current.nextOffset}`,
      });
      if (!Number.isSafeInteger(response.nextOffset) || response.nextOffset !== current.nextOffset + length) {
        throw new Error("server upload offset did not acknowledge the exact chunk");
      }
      current = { ...current, nextOffset: response.nextOffset, attempts: 0 };
      await this.state.save(current);
      completedChunks += 1;
    }
    const completed = await this.api.complete({ uploadId, wholeFileSha256: current.wholeFileSha256, idempotencyKey: `${current.idempotencyKey}:complete` });
    if (completed.state !== "server_validation_pending") throw new Error("client cannot accept a terminal asset state");
    const assetId = safeToken(completed.assetId, "asset id");
    await Promise.all([this.state.delete(uploadId), this.source.remove(current.sourceUri)]);
    return { state: "server_validation_pending", assetId };
  }

  async cancel(uploadIdValue: string): Promise<void> {
    const uploadId = safeToken(uploadIdValue, "upload id");
    const current = await this.state.load(uploadId);
    if (current === null) return;
    await this.api.cancel({ uploadId, reason: "user_requested" });
    await Promise.all([this.state.delete(uploadId), this.source.remove(current.sourceUri)]);
  }
}

export interface MobileRemoteConfig {
  readonly schemaVersion: typeof MOBILE_REMOTE_CONFIG_SCHEMA;
  readonly revision: number;
  readonly minimumAppVersion: string;
  readonly latestAppVersion: string;
  readonly expiresAt: string;
  readonly routes: Readonly<Record<string, { readonly path: string; readonly minimumVersion: string; readonly enabled: boolean }>>;
  readonly features: Readonly<Record<string, boolean>>;
}

export function validateRemoteConfig(value: unknown, applicationVersion: string, now: Date = new Date()): MobileRemoteConfig {
  if (!plain(value) || value.schemaVersion !== MOBILE_REMOTE_CONFIG_SCHEMA || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !plain(value.routes) || !plain(value.features) || typeof value.expiresAt !== "string" || parseInstant(value.expiresAt, "remote config expiry") <= validInstant(now, "remote config clock")) {
    throw new Error("remote config envelope is invalid or expired");
  }
  const minimum = semanticVersion(value.minimumAppVersion, "minimum app version");
  const latest = semanticVersion(value.latestAppVersion, "latest app version");
  const current = semanticVersion(applicationVersion, "application version");
  if (compareVersions(current, minimum) < 0) throw new Error("application version is no longer authorized");
  if (compareVersions(minimum, latest) > 0) throw new Error("remote config version range is invalid");
  for (const [name, route] of Object.entries(value.routes)) {
    safeToken(name, "remote route name");
    if (!plain(route) || typeof route.path !== "string" || !/^\/[A-Za-z0-9/_-]{1,255}$/.test(route.path) ||
        typeof route.enabled !== "boolean" || compareVersions(current, semanticVersion(route.minimumVersion, "route minimum version")) < 0 && route.enabled) {
      throw new Error("remote route is invalid for this application version");
    }
  }
  for (const [name, enabled] of Object.entries(value.features)) {
    safeToken(name, "feature flag");
    if (typeof enabled !== "boolean") throw new Error("feature flag value is invalid");
  }
  return structuredClone(value) as unknown as MobileRemoteConfig;
}

export interface MobilePushPayload {
  readonly schemaVersion: typeof MOBILE_PUSH_SCHEMA;
  readonly navigationReference: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function validatePushPayload(value: unknown, now: Date = new Date()): MobilePushPayload {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "expiresAt,issuedAt,navigationReference,schemaVersion" ||
      value.schemaVersion !== MOBILE_PUSH_SCHEMA || typeof value.navigationReference !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(value.navigationReference) || typeof value.issuedAt !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("push payload must contain only an opaque navigation reference");
  }
  const issued = parseInstant(value.issuedAt, "push issuedAt");
  const expires = parseInstant(value.expiresAt, "push expiresAt");
  const current = validInstant(now, "push clock");
  if (issued > current + 60_000 || expires <= current || expires - issued > 24 * 60 * 60 * 1_000) throw new Error("push payload lifetime is invalid");
  return structuredClone(value) as unknown as MobilePushPayload;
}

export interface PinningPolicy {
  readonly host: string;
  readonly primaryPins: readonly string[];
  readonly backupPins: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
}

export function validatePinningPolicy(policy: PinningPolicy, now: Date = new Date()): PinningPolicy {
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(policy.host)) throw new Error("pinning host is invalid");
  const pins = [...policy.primaryPins, ...policy.backupPins];
  if (policy.primaryPins.length < 1 || policy.backupPins.length < 1 || new Set(pins).size !== pins.length ||
      pins.some((pin) => !/^[A-Za-z0-9+/]{43}=$/.test(pin))) throw new Error("pinning policy requires distinct primary and backup SPKI pins");
  const from = parseInstant(policy.validFrom, "pin validFrom");
  const until = parseInstant(policy.validUntil, "pin validUntil");
  const current = validInstant(now, "pin clock");
  if (from > current || until <= current || until - current < 7 * 24 * 60 * 60 * 1_000) throw new Error("pinning policy is outside its safe rotation window");
  return structuredClone(policy);
}

export interface ReleaseGateInput {
  readonly flavor: "development" | "test" | "staging" | "production";
  readonly applicationId: string;
  readonly expectedApplicationId: string;
  readonly checks: Readonly<Record<"unit" | "integration" | "device" | "visual" | "accessibility" | "security" | "privacy" | "iap" | "coldStart", boolean>>;
  readonly crashFreeRate: number;
  readonly anrRate: number;
  readonly coldStartP95Ms: number;
  readonly independentStoreReceipt?: string;
}

export function evaluateReleaseGate(input: ReleaseGateInput): {
  readonly codeReady: boolean; readonly productionRelease: "EVIDENCE_PENDING"; readonly externalCertification: "NOT_CERTIFIED"; readonly blockers: readonly string[];
} {
  const blockers: string[] = [];
  if (input.applicationId !== input.expectedApplicationId || !/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_-]*){2,}$/.test(input.applicationId)) blockers.push("APPLICATION_ID_MISMATCH");
  for (const [name, passed] of Object.entries(input.checks)) if (passed !== true) blockers.push(`CHECK_FAILED:${name}`);
  if (!Number.isFinite(input.crashFreeRate) || input.crashFreeRate < 0.995) blockers.push("CRASH_GUARDRAIL");
  if (!Number.isFinite(input.anrRate) || input.anrRate > 0.0047) blockers.push("ANR_GUARDRAIL");
  if (!Number.isFinite(input.coldStartP95Ms) || input.coldStartP95Ms > 2_500) blockers.push("COLD_START_GUARDRAIL");
  if (input.flavor === "production" && !/^[A-Za-z0-9._:-]{32,512}$/.test(input.independentStoreReceipt ?? "")) blockers.push("STORE_PROVIDER_EVIDENCE_PENDING");
  return { codeReady: blockers.length === 0, productionRelease: "EVIDENCE_PENDING", externalCertification: "NOT_CERTIFIED", blockers };
}

export function safeOperationalEvent(nameValue: string, fields: Record<string, unknown>): { name: string; fields: Record<string, string | number | boolean> } {
  const name = safeToken(nameValue, "telemetry event");
  const safe = new Set(["platform", "appVersion", "networkType", "status", "errorCode", "durationMs", "bytes", "attempt", "screen", "operation"]);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!safe.has(key)) throw new Error(`telemetry field is not allowlisted: ${key}`);
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        typeof value === "string" && (value.length > 128 || /https?:|file:|content:|bearer|token/i.test(value)) ||
        typeof value === "number" && !Number.isFinite(value)) throw new Error(`telemetry field is unsafe: ${key}`);
    output[key] = value;
  }
  return { name, fields: output };
}

function validateBinding(value: PrincipalBinding): PrincipalBinding {
  const binding = { tenantId: safeToken(value.tenantId, "tenant id"), actorId: safeToken(value.actorId, "actor id"), purpose: safeToken(value.purpose, "purpose"), consentRevision: value.consentRevision, revocationRevision: value.revocationRevision };
  if (!Number.isSafeInteger(binding.consentRevision) || binding.consentRevision < 1 || !Number.isSafeInteger(binding.revocationRevision) || binding.revocationRevision < 0) throw new Error("cache binding revisions are invalid");
  return binding;
}

function validatePersistedCache(value: unknown): PersistedCacheRecord {
  if (!plain(value) || value.schemaVersion !== "ltm.mobile.cache.v1" || (value.kind !== "metadata" && value.kind !== "thumbnail") ||
      typeof value.value !== "string" || typeof value.expiresAt !== "string" || typeof value.storedAt !== "string" || typeof value.key !== "string") {
    throw new Error("offline cache record is invalid");
  }
  validateBinding(value as unknown as PrincipalBinding);
  safeToken(value.key, "cache key");
  parseInstant(value.expiresAt, "cache expiry");
  parseInstant(value.storedAt, "cache storedAt");
  return value as unknown as PersistedCacheRecord;
}

function sameBinding(left: PrincipalBinding, right: PrincipalBinding): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.purpose === right.purpose &&
    left.consentRevision === right.consentRevision && left.revocationRevision === right.revocationRevision;
}

function validateUploadBinding(value: UploadBinding): UploadBinding {
  return { tenantId: safeToken(value.tenantId, "upload tenant"), actorId: safeToken(value.actorId, "upload actor"), purpose: safeToken(value.purpose, "upload purpose") };
}

function validateUploadState(value: UploadSessionState): void {
  if (value.schemaVersion !== "ltm.mobile.upload.v1") throw new Error("upload state schema is invalid");
  validateUploadBinding(value);
  safeToken(value.uploadId, "upload id");
  localPrivateUri(value.sourceUri);
  sha256(value.wholeFileSha256, "whole-file checksum");
  parseInstant(value.expiresAt, "upload expiry");
  if (![value.totalBytes, value.chunkBytes, value.nextOffset, value.attempts].every(Number.isSafeInteger) || value.totalBytes < 1 || value.chunkBytes < 1 || value.nextOffset < 0 || value.nextOffset > value.totalBytes || value.attempts < 0 || value.attempts > 3) throw new Error("upload state counters are invalid");
}

function sameUploadBinding(left: UploadBinding, right: UploadBinding): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.purpose === right.purpose;
}

function localPrivateUri(value: string): string {
  if (typeof value !== "string" || !/^(?:file|content):\/\/[A-Za-z0-9%+.,_~:/=@-]{1,2048}$/.test(value) || /\.\.(?:\/|%2f)/i.test(value)) throw new Error("upload source must be a private local URI");
  return value;
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function semanticVersion(value: unknown, field: string): readonly [number, number, number] {
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) throw new Error(`${field} is invalid`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

function parseInstant(value: string, field: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${field} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${field} is invalid`);
  return parsed;
}

function validInstant(value: Date, field: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${field} is invalid`);
  return value.getTime();
}

function safeToken(value: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
