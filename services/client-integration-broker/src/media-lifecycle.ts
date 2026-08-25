import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  BrokerError,
  RotatingSecretFile,
  bounded,
  configuration,
  dependency,
  exactKeys,
  identifier,
  object,
  safeInteger,
  sha256,
  timestamp,
  validation,
  type MediaAssetRecord,
  type MediaClassification,
  type MediaDeletionTargetReceipt,
  type MediaLifecycleBinding,
  type MediaLifecycleTargetBinding,
  type MultipartObjectStore,
  type Principal,
} from "./contracts.js";

const CATALOG_VERSION = "ltm.media-lifecycle-policy-catalog.v1";
const RECEIPT_VERSION = "ltm.media-deletion-receipt.v1";
const DOWNLOAD_VERSION = "ltm.media-download-authorization.v1";
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

export interface MediaLifecyclePolicy {
  readonly policyId: string;
  readonly classification: MediaClassification;
  readonly retentionDays: number;
  readonly subjectDeletionAllowed: boolean;
  readonly legalHoldMode: "allowed" | "required" | "prohibited";
  readonly deletionTargetIds: readonly string[];
}

export interface MediaLifecycleTargetDefinition {
  readonly targetId: string;
  readonly kind: "s3-object" | "s3-prefix" | "https";
  readonly endpoint?: string;
  readonly credentialFile?: string;
  readonly receiptPublicKeyFile?: string;
}

export interface SignedCatalog {
  readonly schemaVersion: typeof CATALOG_VERSION;
  readonly catalogId: string;
  readonly issuer: string;
  readonly environment: "test" | "development" | "staging" | "production";
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly policies: readonly MediaLifecyclePolicy[];
  readonly targets: readonly MediaLifecycleTargetDefinition[];
  readonly signature: string;
}

export interface MediaLifecycleRegistryOptions {
  readonly catalog: SignedCatalog;
  readonly catalogSha256: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly targetSecretRoot?: string;
}

export interface MediaDeletionExecution {
  readonly deletionRequestId: string;
  readonly tenantId: string;
  readonly mediaReference: string;
  readonly canonicalSha256: string;
  readonly policySha256: string;
  readonly target: MediaLifecycleTargetBinding;
}

export class MediaLifecycleTargetPending extends BrokerError {
  constructor(
    readonly targetId: string,
    readonly pendingCode: "TARGET_PENDING" | "OBJECT_LOCK_ACTIVE",
    readonly evidenceSha256: string,
    message: string,
  ) {
    super(pendingCode === "OBJECT_LOCK_ACTIVE" ? "LEGAL_HOLD_ACTIVE" : "DELETION_PENDING", message, 409, true);
  }
}

/**
 * An immutable, signature-verified, closed media lifecycle policy and target registry.
 * Request payloads can select only an asset; classifications and targets are always
 * derived from this registry and bound into the durable asset record.
 */
export class MediaLifecycleRegistry {
  readonly catalogId: string;
  readonly catalogSha256: string;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly environment: "test" | "development" | "staging" | "production";
  readonly #policies = new Map<MediaClassification, MediaLifecyclePolicy>();
  readonly #targets = new Map<string, MediaLifecycleTargetDefinition>();
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #targetSecretRoot: string | undefined;

  constructor(options: MediaLifecycleRegistryOptions) {
    this.catalogId = identifier(options.catalog.catalogId, "lifecycle catalogId");
    this.issuer = identifier(options.catalog.issuer, "lifecycle catalog issuer");
    this.environment = options.catalog.environment;
    this.catalogSha256 = options.catalogSha256;
    this.expiresAt = timestamp(options.catalog.expiresAt, "lifecycle catalog expiresAt");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#targetSecretRoot = normalizeSecretRoot(options.targetSecretRoot);
    if (!/^[a-f0-9]{64}$/.test(this.catalogSha256) || !Number.isSafeInteger(this.#timeoutMs) ||
        this.#timeoutMs < 500 || this.#timeoutMs > 30_000) throw configuration("media lifecycle registry options are invalid");
    for (const target of options.catalog.targets) {
      if (this.#targets.has(target.targetId)) throw configuration("media lifecycle target IDs must be unique");
      const normalized = normalizeTarget(target, this.#targetSecretRoot);
      if (normalized.kind === "https") {
        new RotatingSecretFile(normalized.credentialFile ?? "", 20, 8_192).read();
        readPublicKey(normalized.receiptPublicKeyFile ?? "");
      }
      this.#targets.set(target.targetId, normalized);
    }
    for (const policy of options.catalog.policies) {
      const normalized = normalizePolicy(policy, this.#targets);
      if (this.#policies.has(normalized.classification)) throw configuration("one lifecycle policy per classification is required");
      this.#policies.set(normalized.classification, normalized);
    }
    if (!this.#policies.has("raw")) throw configuration("a raw media lifecycle policy is required");
  }

  assertCurrent(now: Date): void {
    if (Date.parse(this.expiresAt) <= now.getTime()) throw new BrokerError("POLICY_EXPIRED", "media lifecycle catalog has expired", 503, false);
  }

  bindAsset(input: {
    readonly classification?: MediaClassification;
    readonly objectKey: string;
    readonly createdAt: string;
    readonly now: Date;
  }): MediaLifecycleBinding {
    this.assertCurrent(input.now);
    const classification = input.classification ?? "raw";
    const policy = this.#policies.get(classification);
    if (policy === undefined) throw configuration(`no lifecycle policy exists for ${classification}`);
    const createdAt = Date.parse(timestamp(input.createdAt, "asset createdAt"));
    const retentionExpiresAt = new Date(createdAt + policy.retentionDays * 86_400_000).toISOString();
    const deletionTargets = policy.deletionTargetIds.map((targetId): MediaLifecycleTargetBinding => {
      const target = this.#targets.get(targetId);
      if (target === undefined) throw configuration("lifecycle policy referenced an unknown target");
      const locator = target.kind === "s3-object"
        ? input.objectKey
        : target.kind === "s3-prefix"
          ? `${input.objectKey}.derived/`
          : target.endpoint ?? "";
      return { targetId, kind: target.kind, locator };
    });
    return {
      schemaVersion: "ltm.media-lifecycle-binding.v1",
      catalogId: this.catalogId,
      catalogIssuer: this.issuer,
      catalogEnvironment: this.environment,
      policyId: policy.policyId,
      policySha256: sha256(canonicalJson({ catalogSha256: this.catalogSha256, policy })),
      classification,
      retentionDays: policy.retentionDays,
      retentionExpiresAt,
      encrypted: true,
      subjectDeletionAllowed: policy.subjectDeletionAllowed,
      legalHoldMode: policy.legalHoldMode,
      deletionTargets,
    };
  }

  assertBinding(binding: MediaLifecycleBinding, input: { readonly objectKey: string; readonly createdAt: string; readonly now: Date }): void {
    const expected = this.bindAsset({
      classification: binding.classification,
      objectKey: input.objectKey,
      createdAt: input.createdAt,
      now: input.now,
    });
    if (canonicalJson(binding) !== canonicalJson(expected)) {
      throw dependency("persisted media lifecycle binding does not match the verified catalog", false);
    }
  }

  async executeDeletion(objects: MultipartObjectStore, input: MediaDeletionExecution): Promise<MediaDeletionTargetReceipt> {
    this.assertCurrent(new Date());
    const definition = this.#targets.get(input.target.targetId);
    if (definition === undefined || definition.kind !== input.target.kind) throw dependency("persisted lifecycle target is no longer in the closed registry", false);
    if (input.target.kind === "s3-object" || input.target.kind === "s3-prefix") {
      const result = await objects.deleteVerified(input.target.kind === "s3-object"
        ? { objectKey: input.target.locator, maximumObjects: 10_000 }
        : { prefix: input.target.locator, maximumObjects: 10_000 });
      if (result.state === "held" || !result.verifiedAbsent) {
        throw new MediaLifecycleTargetPending(
          input.target.targetId,
          "OBJECT_LOCK_ACTIVE",
          result.evidenceSha256,
          "S3 Object Lock or retention prevents verified deletion",
        );
      }
      return targetReceipt(input, {
        completedAt: new Date().toISOString(),
        evidenceSha256: result.evidenceSha256,
        deletedVersions: result.deletedVersions,
        deletedMarkers: result.deletedMarkers,
        verifiedAbsent: true,
      });
    }
    return this.#executeHttps(definition, input);
  }

  async verifyTargetAbsent(objects: MultipartObjectStore, target: MediaLifecycleTargetBinding): Promise<{
    readonly absent: boolean;
    readonly evidenceSha256: string;
  }> {
    const definition = this.#targets.get(target.targetId);
    if (definition === undefined || definition.kind !== target.kind) throw dependency("persisted lifecycle target is outside the closed registry", false);
    if (target.kind === "https") {
      // A remote target must provide a new signed receipt through executeDeletion;
      // absence is never inferred locally from a successful HTTP status.
      return { absent: false, evidenceSha256: sha256(`remote-verification-required\n${target.targetId}`) };
    }
    const result = await objects.verifyAbsent(target.kind === "s3-object"
      ? { objectKey: target.locator, maximumObjects: 10_000 }
      : { prefix: target.locator, maximumObjects: 10_000 });
    return { absent: result.absent, evidenceSha256: result.evidenceSha256 };
  }

  async #executeHttps(definition: MediaLifecycleTargetDefinition, input: MediaDeletionExecution): Promise<MediaDeletionTargetReceipt> {
    if (definition.endpoint === undefined || definition.credentialFile === undefined || definition.receiptPublicKeyFile === undefined) {
      throw dependency("HTTPS lifecycle target is incompletely configured", false);
    }
    const nonce = `delete_nonce_${randomUUID()}`;
    const request = {
      schemaVersion: "ltm.media-deletion-request.v1",
      deletionRequestId: input.deletionRequestId,
      requestNonce: nonce,
      targetId: input.target.targetId,
      tenantId: input.tenantId,
      mediaReference: input.mediaReference,
      canonicalSha256: input.canonicalSha256,
      policySha256: input.policySha256,
    } as const;
    const credential = new RotatingSecretFile(definition.credentialFile, 20, 8_192);
    let response: Response;
    try {
      response = await this.#fetch(definition.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${credential.read()}` },
        body: JSON.stringify(request),
      });
    } catch { throw dependency(`media deletion target ${definition.targetId} is unreachable`); }
    if (!response.ok) throw dependency(`media deletion target ${definition.targetId} rejected deletion`, response.status >= 500);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type")?.trim() ?? "")) {
      throw dependency("media deletion receipt content-type is invalid", false);
    }
    const bytes = await boundedResponseBytes(response, MAX_RECEIPT_BYTES);
    let value: unknown;
    try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
    catch { throw dependency("media deletion receipt is not JSON", false); }
    const receipt = object(value, "media deletion receipt");
    exactKeys(receipt, [
      "schemaVersion", "receiptId", "requestNonce", "targetId", "deletionRequestId", "tenantId",
      "mediaReference", "canonicalSha256", "policySha256", "state", "completedAt", "evidenceSha256", "signature",
    ], "media deletion receipt");
    const signed = {
      schemaVersion: receipt.schemaVersion,
      receiptId: receipt.receiptId,
      requestNonce: receipt.requestNonce,
      targetId: receipt.targetId,
      deletionRequestId: receipt.deletionRequestId,
      tenantId: receipt.tenantId,
      mediaReference: receipt.mediaReference,
      canonicalSha256: receipt.canonicalSha256,
      policySha256: receipt.policySha256,
      state: receipt.state,
      completedAt: receipt.completedAt,
      evidenceSha256: receipt.evidenceSha256,
    };
    const signature = base64url(receipt.signature, "media deletion receipt signature", 256);
    const publicKey = readPublicKey(definition.receiptPublicKeyFile);
    if (!verify(null, Buffer.from(canonicalJson(signed)), publicKey, Buffer.from(signature, "base64url"))) {
      throw dependency("media deletion receipt signature is invalid", false);
    }
    if (signed.schemaVersion !== RECEIPT_VERSION || signed.state !== "deleted" || signed.requestNonce !== nonce ||
        signed.targetId !== input.target.targetId || signed.deletionRequestId !== input.deletionRequestId ||
        signed.tenantId !== input.tenantId || signed.mediaReference !== input.mediaReference ||
        signed.canonicalSha256 !== input.canonicalSha256 || signed.policySha256 !== input.policySha256) {
      throw dependency("media deletion receipt binding is invalid", false);
    }
    const completedAt = timestamp(signed.completedAt, "media deletion receipt completedAt");
    if (Math.abs(Date.now() - Date.parse(completedAt)) > 15 * 60_000) throw dependency("media deletion receipt is outside its freshness window", false);
    return targetReceipt(input, {
      completedAt,
      evidenceSha256: digest(signed.evidenceSha256, "media deletion receipt evidenceSha256"),
      providerReceiptId: identifier(signed.receiptId, "media deletion receiptId"),
    });
  }
}

export function loadSignedMediaLifecycleRegistry(input: {
  readonly catalogFile: string;
  readonly trustPublicKeyFile: string;
  readonly expectedKeyId: string;
  readonly expectedIssuer: string;
  readonly expectedEnvironment: "test" | "development" | "staging" | "production";
  readonly now?: Date;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly targetSecretRoot?: string;
}): MediaLifecycleRegistry {
  const bytes = safeFile(input.catalogFile, MAX_CATALOG_BYTES, 64);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw configuration("media lifecycle catalog must be JSON"); }
  const catalog = parseSignedCatalog(parsed);
  if (catalog.keyId !== identifier(input.expectedKeyId, "lifecycle expected keyId")) throw configuration("media lifecycle catalog keyId is not trusted");
  if (catalog.issuer !== identifier(input.expectedIssuer, "lifecycle expected issuer") || catalog.environment !== input.expectedEnvironment) {
    throw configuration("media lifecycle catalog issuer or environment is not trusted");
  }
  if (input.expectedEnvironment === "production" && input.targetSecretRoot === undefined) {
    throw configuration("production media lifecycle HTTPS targets require a dedicated secret projection root");
  }
  const unsigned = { ...catalog, signature: undefined } as Record<string, unknown>;
  delete unsigned.signature;
  const signature = Buffer.from(base64url(catalog.signature, "lifecycle catalog signature", 256), "base64url");
  if (!verify(null, Buffer.from(canonicalJson(unsigned)), readPublicKey(input.trustPublicKeyFile), signature)) {
    throw configuration("media lifecycle catalog signature is invalid");
  }
  const now = input.now ?? new Date();
  const issuedAt = Date.parse(catalog.issuedAt);
  if (issuedAt > now.getTime() + 5 * 60_000 || Date.parse(catalog.expiresAt) <= now.getTime()) {
    throw configuration("media lifecycle catalog is outside its validity window");
  }
  const registry = new MediaLifecycleRegistry({
    catalog,
    catalogSha256: sha256(canonicalJson(unsigned)),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.targetSecretRoot === undefined ? {} : { targetSecretRoot: input.targetSecretRoot }),
  });
  registry.assertCurrent(now);
  return registry;
}

/** Deterministic local registry for unit tests and explicitly non-production development. */
export function developmentMediaLifecycleRegistry(now = new Date()): MediaLifecycleRegistry {
  const catalog: SignedCatalog = {
    schemaVersion: CATALOG_VERSION,
    catalogId: "development-media-lifecycle",
    issuer: "development-media-policy-authority",
    environment: "development",
    keyId: "development-only",
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
    policies: [{
      policyId: "development-raw-v1",
      classification: "raw",
      retentionDays: 365,
      subjectDeletionAllowed: true,
      legalHoldMode: "allowed",
      deletionTargetIds: ["s3-primary", "s3-derived"],
    }],
    targets: [
      { targetId: "s3-primary", kind: "s3-object" },
      { targetId: "s3-derived", kind: "s3-prefix" },
    ],
    signature: "development-only",
  };
  return new MediaLifecycleRegistry({ catalog, catalogSha256: sha256(canonicalJson({ ...catalog, signature: undefined })) });
}

export interface DownloadAuthorizationClaims {
  readonly schemaVersion: typeof DOWNLOAD_VERSION;
  readonly tokenId: string;
  readonly issuer: string;
  readonly tenantId: string;
  readonly mediaReference: string;
  readonly canonicalSha256: string;
  readonly audience: string;
  readonly purpose: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class MediaDownloadAuthorizer {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #baseUrl: string;
  readonly #issuer: string;
  readonly #maximumTtlSeconds: number;

  constructor(input: {
    readonly privateKeyFile: string;
    readonly publicKeyFile: string;
    readonly baseUrl: string;
    readonly issuer: string;
    readonly maximumTtlSeconds: number;
  }) {
    this.#privateKey = createPrivateKey(safeFile(input.privateKeyFile, 32 * 1024, 64));
    this.#publicKey = readPublicKey(input.publicKeyFile);
    const base = new URL(input.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) {
      throw configuration("media download base URL must be a credential-free HTTPS origin");
    }
    this.#baseUrl = base.origin;
    this.#issuer = identifier(input.issuer, "media download issuer");
    this.#maximumTtlSeconds = safeInteger(input.maximumTtlSeconds, "media download maximum TTL", 30, 900);
    const probe = Buffer.from("ltm-media-download-key-probe");
    if (!verify(null, probe, this.#publicKey, sign(null, probe, this.#privateKey))) {
      throw configuration("media download signing key pair does not match");
    }
  }

  issue(asset: MediaAssetRecord, principal: Principal, input: {
    readonly audience: string;
    readonly purpose: string;
    readonly ttlSeconds: number;
    readonly now: Date;
  }): { readonly downloadUrl: string; readonly token: string; readonly expiresAt: string } {
    if (asset.state !== "available") throw validation("only available media can be downloaded");
    const audience = identifier(input.audience, "download audience");
    const purpose = bounded(input.purpose, "download purpose", 120);
    if (audience !== principal.actorId || purpose !== principal.purpose) throw validation("download audience and purpose must match the authenticated principal");
    const ttlSeconds = safeInteger(input.ttlSeconds, "download TTL", 1, this.#maximumTtlSeconds);
    const claims: DownloadAuthorizationClaims = {
      schemaVersion: DOWNLOAD_VERSION,
      tokenId: `download_${randomUUID()}`,
      issuer: this.#issuer,
      tenantId: asset.tenantId,
      mediaReference: asset.mediaReference,
      canonicalSha256: asset.canonicalSha256,
      audience,
      purpose,
      issuedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + ttlSeconds * 1_000).toISOString(),
    };
    const encoded = Buffer.from(canonicalJson(claims)).toString("base64url");
    const signature = sign(null, Buffer.from(encoded), this.#privateKey).toString("base64url");
    const token = `${encoded}.${signature}`;
    return { downloadUrl: `${this.#baseUrl}/v1/media/downloads/${token}`, token, expiresAt: claims.expiresAt };
  }

  verify(tokenValue: string, principal: Principal, asset: MediaAssetRecord, now: Date): DownloadAuthorizationClaims {
    const token = bounded(tokenValue, "media download token", 8_192, 64);
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined ||
        !verify(null, Buffer.from(parts[0]), this.#publicKey, Buffer.from(parts[1], "base64url"))) {
      throw new BrokerError("AUTH_UNAUTHENTICATED", "media download authorization is invalid", 401, false);
    }
    let claims: DownloadAuthorizationClaims;
    try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as DownloadAuthorizationClaims; }
    catch { throw new BrokerError("AUTH_UNAUTHENTICATED", "media download authorization is invalid", 401, false); }
    if (claims.schemaVersion !== DOWNLOAD_VERSION || claims.issuer !== this.#issuer || claims.tenantId !== principal.tenantId ||
        claims.mediaReference !== asset.mediaReference || claims.canonicalSha256 !== asset.canonicalSha256 ||
        claims.audience !== principal.actorId || claims.purpose !== principal.purpose || asset.state !== "available" ||
        Date.parse(claims.issuedAt) > now.getTime() + 60_000 || Date.parse(claims.expiresAt) <= now.getTime() ||
        Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) > this.#maximumTtlSeconds * 1_000) {
      throw new BrokerError("AUTH_UNAUTHENTICATED", "media download authorization binding is invalid", 401, false);
    }
    identifier(claims.tokenId, "media download tokenId");
    return claims;
  }
}

function targetReceipt(
  input: MediaDeletionExecution,
  evidence: Omit<MediaDeletionTargetReceipt, "schemaVersion" | "targetId" | "targetKind" | "deletionRequestId" |
    "tenantId" | "mediaReference" | "canonicalSha256" | "policySha256" | "state">,
): MediaDeletionTargetReceipt {
  return {
    schemaVersion: "ltm.media-deletion-target-receipt.v1",
    targetId: input.target.targetId,
    targetKind: input.target.kind,
    deletionRequestId: input.deletionRequestId,
    tenantId: input.tenantId,
    mediaReference: input.mediaReference,
    canonicalSha256: input.canonicalSha256,
    policySha256: input.policySha256,
    state: "deleted",
    ...evidence,
  };
}

function parseSignedCatalog(value: unknown): SignedCatalog {
  const record = object(value, "media lifecycle catalog");
  exactKeys(record, ["schemaVersion", "catalogId", "issuer", "environment", "keyId", "issuedAt", "expiresAt", "policies", "targets", "signature"], "media lifecycle catalog");
  if (record.schemaVersion !== CATALOG_VERSION || !Array.isArray(record.policies) || !Array.isArray(record.targets) ||
      record.policies.length < 1 || record.policies.length > 64 || record.targets.length < 1 || record.targets.length > 64) {
    throw configuration("media lifecycle catalog shape is invalid");
  }
  const policies = record.policies.map((entry) => {
    const policy = object(entry, "media lifecycle policy");
    exactKeys(policy, ["policyId", "classification", "retentionDays", "subjectDeletionAllowed", "legalHoldMode", "deletionTargetIds"], "media lifecycle policy");
    if (!Array.isArray(policy.deletionTargetIds) || typeof policy.subjectDeletionAllowed !== "boolean") throw configuration("media lifecycle policy is invalid");
    return {
      policyId: identifier(policy.policyId, "lifecycle policyId"),
      classification: classification(policy.classification),
      retentionDays: safeInteger(policy.retentionDays, "lifecycle retentionDays", 0, 36_500),
      subjectDeletionAllowed: policy.subjectDeletionAllowed,
      legalHoldMode: legalHoldMode(policy.legalHoldMode),
      deletionTargetIds: policy.deletionTargetIds.map((id) => identifier(id, "lifecycle targetId")),
    } satisfies MediaLifecyclePolicy;
  });
  const targets = record.targets.map((entry) => {
    const target = object(entry, "media lifecycle target");
    const kind = target.kind;
    if (kind === "https") {
      exactKeys(target, ["targetId", "kind", "endpoint", "credentialFile", "receiptPublicKeyFile"], "HTTPS lifecycle target");
      return normalizeTarget({
        targetId: identifier(target.targetId, "lifecycle targetId"), kind,
        endpoint: bounded(target.endpoint, "lifecycle target endpoint", 2_048),
        credentialFile: bounded(target.credentialFile, "lifecycle target credentialFile", 4_096),
        receiptPublicKeyFile: bounded(target.receiptPublicKeyFile, "lifecycle target receiptPublicKeyFile", 4_096),
      });
    }
    exactKeys(target, ["targetId", "kind"], "S3 lifecycle target");
    if (kind !== "s3-object" && kind !== "s3-prefix") throw configuration("media lifecycle target kind is invalid");
    return normalizeTarget({ targetId: identifier(target.targetId, "lifecycle targetId"), kind });
  });
  return {
    schemaVersion: CATALOG_VERSION,
    catalogId: identifier(record.catalogId, "lifecycle catalogId"),
    issuer: identifier(record.issuer, "lifecycle catalog issuer"),
    environment: catalogEnvironment(record.environment),
    keyId: identifier(record.keyId, "lifecycle keyId"),
    issuedAt: timestamp(record.issuedAt, "lifecycle catalog issuedAt"),
    expiresAt: timestamp(record.expiresAt, "lifecycle catalog expiresAt"),
    policies,
    targets,
    signature: base64url(record.signature, "lifecycle catalog signature", 256),
  };
}

function normalizePolicy(policy: MediaLifecyclePolicy, targets: ReadonlyMap<string, MediaLifecycleTargetDefinition>): MediaLifecyclePolicy {
  const deletionTargetIds = policy.deletionTargetIds.map((id) => identifier(id, "lifecycle deletion targetId"));
  if (deletionTargetIds.length < 1 || deletionTargetIds.length > 64 || new Set(deletionTargetIds).size !== deletionTargetIds.length ||
      deletionTargetIds.some((id) => !targets.has(id))) throw configuration("lifecycle policy deletion target set is invalid");
  const kinds = deletionTargetIds.map((id) => targets.get(id)?.kind);
  if (!kinds.includes("s3-object") || !kinds.includes("s3-prefix")) {
    throw configuration("every lifecycle policy must cover the canonical S3 object and its derived-object prefix");
  }
  return {
    policyId: identifier(policy.policyId, "lifecycle policyId"),
    classification: classification(policy.classification),
    retentionDays: safeInteger(policy.retentionDays, "lifecycle retentionDays", 0, 36_500),
    subjectDeletionAllowed: policy.subjectDeletionAllowed === true,
    legalHoldMode: legalHoldMode(policy.legalHoldMode),
    deletionTargetIds,
  };
}

function normalizeTarget(target: MediaLifecycleTargetDefinition, targetSecretRoot?: string): MediaLifecycleTargetDefinition {
  const targetId = identifier(target.targetId, "lifecycle targetId");
  if (target.kind !== "s3-object" && target.kind !== "s3-prefix" && target.kind !== "https") throw configuration("lifecycle target kind is invalid");
  if (target.kind !== "https") return { targetId, kind: target.kind };
  if (target.endpoint === undefined || target.credentialFile === undefined || target.receiptPublicKeyFile === undefined ||
      !target.credentialFile.startsWith("/") || !target.receiptPublicKeyFile.startsWith("/")) {
    throw configuration("HTTPS lifecycle target file projections must be absolute");
  }
  if (targetSecretRoot !== undefined && (!insideRoot(target.credentialFile, targetSecretRoot) ||
      !insideRoot(target.receiptPublicKeyFile, targetSecretRoot))) {
    throw configuration("HTTPS lifecycle target files must stay inside the dedicated secret projection root");
  }
  const endpoint = new URL(target.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw configuration("HTTPS lifecycle target endpoint must be credential-free HTTPS");
  }
  return { targetId, kind: target.kind, endpoint: endpoint.toString(), credentialFile: target.credentialFile, receiptPublicKeyFile: target.receiptPublicKeyFile };
}

function normalizeSecretRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw configuration("media lifecycle target secret root must be absolute");
  const normalized = resolve(value);
  if (normalized === "/") throw configuration("media lifecycle target secret root cannot be the filesystem root");
  return normalized;
}

function insideRoot(path: string, root: string): boolean {
  const child = relative(root, resolve(path));
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function classification(value: unknown): MediaClassification {
  if (value !== "raw" && value !== "intermediate" && value !== "derived" && value !== "share" && value !== "print" && value !== "backup") {
    throw configuration("media lifecycle classification is invalid");
  }
  return value;
}

function catalogEnvironment(value: unknown): "test" | "development" | "staging" | "production" {
  if (value !== "test" && value !== "development" && value !== "staging" && value !== "production") {
    throw configuration("media lifecycle catalog environment is invalid");
  }
  return value;
}

function legalHoldMode(value: unknown): "allowed" | "required" | "prohibited" {
  if (value !== "allowed" && value !== "required" && value !== "prohibited") {
    throw configuration("media lifecycle legal hold mode is invalid");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw configuration("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw configuration("canonical JSON contains an unsupported value");
}

function safeFile(path: string, maximum: number, minimum: number): Buffer {
  if (!path.startsWith("/")) throw configuration("security projection path must be absolute");
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum || (metadata.mode & 0o022) !== 0) throw new Error("unsafe file");
    return readFileSync(path);
  } catch { throw configuration("security projection is unavailable or unsafe"); }
}

function readPublicKey(path: string): KeyObject {
  try { return createPublicKey(safeFile(path, 32 * 1024, 64)); }
  catch { throw configuration("public key projection is invalid"); }
}

function base64url(value: unknown, label: string, maximum: number): string {
  const normalized = bounded(value, label, maximum);
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw validation(`${label} is invalid`);
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw dependency(`${label} is invalid`, false);
  return value;
}

async function boundedResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) < 2 || Number(declared) > maximum)) {
    throw dependency("media deletion receipt size is invalid", false);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw dependency("media deletion receipt body is unavailable", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { completed = true; break; }
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel("media deletion receipt exceeded its bound").catch(() => undefined);
        throw dependency("media deletion receipt size is invalid", false);
      }
      chunks.push(next.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (total < 2) throw dependency("media deletion receipt size is invalid", false);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
