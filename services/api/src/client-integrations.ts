import { isAbsolute } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { DomainError, type ActorContext, type Role } from "@ltm/core";
import type { WechatPlatformPort } from "./wechat-platform.js";

const MAX_BROKER_RESPONSE_BYTES = 512 * 1024;
const CLIENT_ROLES = new Set<Role>([
  "consumer", "household_admin", "guardian", "partner_employee", "partner_admin", "studio_operator",
  "support_agent", "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account",
]);

export interface ClientSessionProjection {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly Role[];
  readonly purpose: string;
}

export interface WechatIdentityPort {
  createSession(input: {
    readonly code: string;
    readonly consentVersion: string;
    readonly clientRequestId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{ readonly session: ClientSessionProjection }>;
  refreshSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{ readonly session: ClientSessionProjection }>;
  revokeSession(input: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<void>;
  readiness(): Promise<{ readonly ready: boolean; readonly dependency: string }>;
}

export interface ResumableUploadPort {
  create(context: ActorContext, input: {
    readonly fileSize: number;
    readonly fileDigest: string;
    readonly digestAlgorithm: "sha256";
    readonly contentType: "image/jpeg";
    readonly clientRequestId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly uploadId: string; readonly nextOffset: number; readonly expiresAt: string }>;
  append(context: ActorContext, input: {
    readonly uploadId: string;
    readonly bytes: Uint8Array;
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly idempotencyKey: string;
  }): Promise<{ readonly nextOffset: number }>;
  complete(context: ActorContext, input: {
    readonly uploadId: string;
    readonly fileDigest: string;
    readonly digestAlgorithm: "sha256";
    readonly idempotencyKey: string;
  }): Promise<{ readonly uploadId: string; readonly assetId: string; readonly state: "available" }>;
  cancel(context: ActorContext, input: {
    readonly uploadId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  resolveIntake(context: ActorContext, input: {
    readonly assetId: string;
    readonly participantIds: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<MediaIntakeProjection>;
  deleteAsset(context: ActorContext, input: {
    readonly assetId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<MediaDeletionProjection>;
  readiness(): Promise<{ readonly ready: boolean; readonly dependency: string }>;
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
  readonly classification: "raw" | "intermediate" | "derived" | "share" | "print" | "backup";
  readonly retentionDays: number;
  readonly retentionExpiresAt: string;
  readonly encrypted: true;
  readonly deletionTargets: readonly string[];
  readonly targetReceipts: readonly MediaDeletionTargetReceiptProjection[];
}

export interface MediaDeletionTargetReceiptProjection {
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

export interface MediaIntakeProjection {
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

export interface ClientIntegrationPorts {
  readonly wechatIdentity?: WechatIdentityPort;
  readonly wechatPlatform?: WechatPlatformPort;
  readonly resumableUploads?: ResumableUploadPort;
}

export interface BrokerClientOptions {
  readonly baseUrl: string;
  readonly workloadTokenFile: string;
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class HttpWechatIdentityBroker implements WechatIdentityPort {
  readonly #broker: BrokerClient;

  constructor(options: BrokerClientOptions) { this.#broker = new BrokerClient(options); }

  async createSession(input: Parameters<WechatIdentityPort["createSession"]>[0]): Promise<{ session: ClientSessionProjection }> {
    const value = await this.#broker.json("POST", "/v1/wechat/sessions", {
      code: bounded(input.code, "code", 512),
      consentVersion: bounded(input.consentVersion, "consentVersion", 128),
      clientRequestId: identifier(input.clientRequestId, "clientRequestId"),
    }, input.idempotencyKey, input.requestId);
    const response = record(value, "WeChat identity response");
    exactUpstreamKeys(response, ["session"], "WeChat identity response");
    return { session: sessionProjection(response.session) };
  }

  async refreshSession(input: Parameters<WechatIdentityPort["refreshSession"]>[0]): Promise<{ session: ClientSessionProjection }> {
    const value = await this.#broker.json("POST", "/v1/wechat/sessions/refresh", {}, input.idempotencyKey, input.requestId, input.accessToken);
    const response = record(value, "WeChat refresh response");
    exactUpstreamKeys(response, ["session"], "WeChat refresh response");
    return { session: sessionProjection(response.session) };
  }

  async revokeSession(input: Parameters<WechatIdentityPort["revokeSession"]>[0]): Promise<void> {
    await this.#broker.empty("POST", "/v1/wechat/sessions/revoke", {}, input.idempotencyKey, input.requestId, input.accessToken);
  }

  readiness(): Promise<{ ready: boolean; dependency: string }> { return this.#broker.readiness("wechat-identity"); }
}

export class HttpResumableUploadBroker implements ResumableUploadPort {
  readonly #broker: BrokerClient;

  constructor(options: BrokerClientOptions) { this.#broker = new BrokerClient(options); }

  async create(context: ActorContext, input: Parameters<ResumableUploadPort["create"]>[1]) {
    const value = await this.#broker.json("POST", "/v1/media/uploads", {
      principal: principal(context),
      fileSize: input.fileSize,
      fileDigest: input.fileDigest,
      digestAlgorithm: input.digestAlgorithm,
      contentType: input.contentType,
      clientRequestId: input.clientRequestId,
    }, input.idempotencyKey, context.requestId);
    const response = record(value, "upload create response");
    return {
      uploadId: identifier(response.uploadId, "uploadId"),
      nextOffset: safeInteger(response.nextOffset, "nextOffset", 0, input.fileSize),
      expiresAt: futureTimestamp(response.expiresAt, "expiresAt"),
    };
  }

  async append(context: ActorContext, input: Parameters<ResumableUploadPort["append"]>[1]) {
    const value = await this.#broker.bytes(
      "PUT", `/v1/media/uploads/${encodeURIComponent(identifier(input.uploadId, "uploadId"))}/chunks`,
      input.bytes, input.idempotencyKey, context.requestId, principalHeaders(context),
      { "content-range": `bytes ${input.start}-${input.end}/${input.total}` },
    );
    const response = record(value, "upload chunk response");
    return { nextOffset: safeInteger(response.nextOffset, "nextOffset", input.end + 1, input.total) };
  }

  async complete(context: ActorContext, input: Parameters<ResumableUploadPort["complete"]>[1]) {
    const uploadId = identifier(input.uploadId, "uploadId");
    const value = await this.#broker.json(
      "POST", `/v1/media/uploads/${encodeURIComponent(uploadId)}/complete`,
      { principal: principal(context), fileDigest: input.fileDigest, digestAlgorithm: input.digestAlgorithm },
      input.idempotencyKey, context.requestId,
    );
    const response = record(value, "upload completion response");
    if (response.state !== "available") unavailable("upload broker returned a non-terminal completion state");
    const returnedUploadId = identifier(response.uploadId, "uploadId");
    if (returnedUploadId !== uploadId) unavailable("upload broker changed the upload binding");
    return { uploadId, assetId: identifier(response.mediaReference, "mediaReference"), state: "available" as const };
  }

  async cancel(context: ActorContext, input: Parameters<ResumableUploadPort["cancel"]>[1]): Promise<void> {
    const uploadId = identifier(input.uploadId, "uploadId");
    await this.#broker.empty(
      "POST", `/v1/media/uploads/${encodeURIComponent(uploadId)}/cancel`, { principal: principal(context) },
      input.idempotencyKey, context.requestId,
    );
  }

  async resolveIntake(context: ActorContext, input: Parameters<ResumableUploadPort["resolveIntake"]>[1]): Promise<MediaIntakeProjection> {
    const assetId = identifier(input.assetId, "assetId");
    const value = await this.#broker.json(
      "POST",
      "/v1/media/intakes/resolve",
      { principal: principal(context), mediaReference: assetId, participantIds: input.participantIds },
      input.idempotencyKey,
      context.requestId,
    );
    const response = record(value, "media intake response");
    upstreamExactKeys(response, [
      "assetId", "sourceSha256", "canonicalSha256", "lineageSha256", "byteLength", "width", "height",
      "faceCount", "scanEvidenceId", "scannerProvider", "scanAssessedAt", "participantIds",
      "participantMappingEvidenceId", "participantMappingProvider", "participantMappingAssessedAt",
      "participantMapComplete", "mimeType", "metadataStripped",
    ], "media intake response");
    const returnedAssetId = identifier(response.assetId, "assetId");
    const participantIds = upstreamIdentifiers(response.participantIds, "participantIds");
    if (returnedAssetId !== assetId || response.mimeType !== "image/jpeg" || response.metadataStripped !== true ||
        response.participantMapComplete !== true || !sameStrings(participantIds, input.participantIds)) {
      unavailable("media broker changed or weakened the intake binding");
    }
    const sourceSha256 = upstreamDigest(response.sourceSha256, "sourceSha256");
    const canonicalSha256 = upstreamDigest(response.canonicalSha256, "canonicalSha256");
    const lineageSha256 = upstreamDigest(response.lineageSha256, "lineageSha256");
    const expectedLineageSha256 = createHash("sha256")
      .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
      .digest("hex");
    const faceCount = safeInteger(response.faceCount, "faceCount", 1, 20);
    if (lineageSha256 !== expectedLineageSha256 || faceCount !== participantIds.length) {
      unavailable("media broker returned an invalid canonical lineage or participant mapping");
    }
    return {
      assetId,
      sourceSha256,
      canonicalSha256,
      lineageSha256,
      byteLength: safeInteger(response.byteLength, "byteLength", 1, 25 * 1024 * 1024),
      width: safeInteger(response.width, "width", 1, 8_192),
      height: safeInteger(response.height, "height", 1, 8_192),
      faceCount,
      scanEvidenceId: identifier(response.scanEvidenceId, "scanEvidenceId"),
      scannerProvider: identifier(response.scannerProvider, "scannerProvider"),
      scanAssessedAt: pastTimestamp(response.scanAssessedAt, "scanAssessedAt"),
      participantIds,
      participantMappingEvidenceId: identifier(response.participantMappingEvidenceId, "participantMappingEvidenceId"),
      participantMappingProvider: identifier(response.participantMappingProvider, "participantMappingProvider"),
      participantMappingAssessedAt: pastTimestamp(response.participantMappingAssessedAt, "participantMappingAssessedAt"),
      participantMapComplete: true,
      mimeType: "image/jpeg",
      metadataStripped: true,
    };
  }

  async deleteAsset(context: ActorContext, input: Parameters<ResumableUploadPort["deleteAsset"]>[1]): Promise<MediaDeletionProjection> {
    const assetId = identifier(input.assetId, "assetId");
    const value = await this.#broker.json(
      "POST",
      `/v1/media/assets/${encodeURIComponent(assetId)}/delete`,
      { principal: principal(context), reason: bounded(input.reason, "reason", 500) },
      input.idempotencyKey,
      context.requestId,
    );
    const response = record(value, "media deletion response");
    upstreamExactKeys(response, [
      "mediaReference", "state", "auditId", "deletionRequestId", "requestedAt", "deletedAt", "policyId",
      "policySha256", "classification", "retentionDays", "retentionExpiresAt", "encrypted", "deletionTargets", "targetReceipts",
    ], "media deletion response");
    const mediaReference = identifier(response.mediaReference, "mediaReference");
    const deletionRequestId = identifier(response.deletionRequestId, "deletionRequestId");
    const policySha256 = upstreamDigest(response.policySha256, "policySha256");
    const classification = response.classification;
    if (mediaReference !== assetId || response.state !== "deleted" || response.encrypted !== true ||
        !["raw", "intermediate", "derived", "share", "print", "backup"].includes(String(classification))) {
      unavailable("media broker changed the deletion binding");
    }
    const deletionTargets = upstreamIdentifiersBounded(response.deletionTargets, "deletionTargets", 64);
    if (!Array.isArray(response.targetReceipts) || response.targetReceipts.length !== deletionTargets.length) {
      unavailable("media broker returned an incomplete target receipt set");
    }
    let boundCanonicalSha256: string | undefined;
    const targetReceipts = response.targetReceipts.map((entry, index): MediaDeletionTargetReceiptProjection => {
      const receipt = record(entry, "media deletion target receipt");
      const optional = ["providerReceiptId", "deletedVersions", "deletedMarkers", "verifiedAbsent"]
        .filter((key) => receipt[key] !== undefined);
      upstreamExactKeys(receipt, [
        "schemaVersion", "targetId", "targetKind", "deletionRequestId", "tenantId", "mediaReference",
        "canonicalSha256", "policySha256", "state", "completedAt", "evidenceSha256", ...optional,
      ], "media deletion target receipt");
      const targetId = identifier(receipt.targetId, "target receipt targetId");
      const targetKind = receipt.targetKind;
      if (receipt.schemaVersion !== "ltm.media-deletion-target-receipt.v1" || targetId !== deletionTargets[index] ||
          !["s3-object", "s3-prefix", "https"].includes(String(targetKind)) || receipt.deletionRequestId !== deletionRequestId ||
          receipt.tenantId !== context.tenantId || receipt.mediaReference !== mediaReference ||
          receipt.policySha256 !== policySha256 || receipt.state !== "deleted") {
        unavailable("media deletion target receipt binding is invalid");
      }
      const canonicalSha256 = upstreamDigest(receipt.canonicalSha256, "target receipt canonicalSha256");
      if (boundCanonicalSha256 !== undefined && canonicalSha256 !== boundCanonicalSha256) {
        unavailable("media deletion target receipts disagree on the canonical media digest");
      }
      boundCanonicalSha256 = canonicalSha256;
      const evidenceSha256 = upstreamDigest(receipt.evidenceSha256, "target receipt evidenceSha256");
      const providerReceiptId = receipt.providerReceiptId === undefined ? undefined : identifier(receipt.providerReceiptId, "providerReceiptId");
      const deletedVersions = receipt.deletedVersions === undefined ? undefined : safeInteger(receipt.deletedVersions, "deletedVersions", 0, 100_000);
      const deletedMarkers = receipt.deletedMarkers === undefined ? undefined : safeInteger(receipt.deletedMarkers, "deletedMarkers", 0, 100_000);
      if (receipt.verifiedAbsent !== undefined && receipt.verifiedAbsent !== true) unavailable("target receipt verifiedAbsent must be true");
      const s3Target = targetKind === "s3-object" || targetKind === "s3-prefix";
      if (s3Target
        ? providerReceiptId !== undefined || deletedVersions === undefined || deletedMarkers === undefined || receipt.verifiedAbsent !== true
        : providerReceiptId === undefined || deletedVersions !== undefined || deletedMarkers !== undefined || receipt.verifiedAbsent !== undefined) {
        unavailable("media deletion target receipt proof does not match its target kind");
      }
      return {
        schemaVersion: "ltm.media-deletion-target-receipt.v1",
        targetId,
        targetKind: targetKind as MediaDeletionTargetReceiptProjection["targetKind"],
        deletionRequestId,
        tenantId: context.tenantId,
        mediaReference,
        canonicalSha256,
        policySha256,
        state: "deleted",
        completedAt: pastTimestamp(receipt.completedAt, "target receipt completedAt"),
        evidenceSha256,
        ...(providerReceiptId === undefined ? {} : { providerReceiptId }),
        ...(deletedVersions === undefined ? {} : { deletedVersions }),
        ...(deletedMarkers === undefined ? {} : { deletedMarkers }),
        ...(receipt.verifiedAbsent === undefined ? {} : { verifiedAbsent: true }),
      };
    });
    return {
      mediaReference,
      state: "deleted",
      auditId: identifier(response.auditId, "auditId"),
      deletionRequestId,
      requestedAt: pastTimestamp(response.requestedAt, "requestedAt"),
      deletedAt: pastTimestamp(response.deletedAt, "deletedAt"),
      policyId: identifier(response.policyId, "policyId"),
      policySha256,
      classification: classification as MediaDeletionProjection["classification"],
      retentionDays: safeInteger(response.retentionDays, "retentionDays", 0, 36_500),
      retentionExpiresAt: anyTimestamp(response.retentionExpiresAt, "retentionExpiresAt"),
      encrypted: true,
      deletionTargets,
      targetReceipts,
    };
  }

  readiness(): Promise<{ ready: boolean; dependency: string }> { return this.#broker.readiness("resumable-upload"); }
}

export class BrokerClient {
  readonly #baseUrl: string;
  readonly #tokenFile: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BrokerClientOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw configuration("broker baseUrl must be an absolute URL"); }
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
        (url.protocol !== "https:" && !(options.allowInsecureLoopback === true && url.protocol === "http:" && loopback))) {
      throw configuration("broker baseUrl must be an HTTPS origin without credentials, path, query, or fragment");
    }
    if (!isAbsolute(options.workloadTokenFile)) throw configuration("broker workloadTokenFile must be absolute");
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 30_000) throw configuration("broker timeout is invalid");
    this.#baseUrl = url.origin;
    this.#tokenFile = options.workloadTokenFile;
    this.#timeoutMs = timeout;
    this.#fetch = options.fetch ?? fetch;
  }

  async json(method: "POST", path: string, value: object, idempotencyKey: string, requestId: string, subjectToken?: string): Promise<unknown> {
    return this.#request(method, path, JSON.stringify(value), {
      "content-type": "application/json",
      "idempotency-key": header(idempotencyKey, "idempotencyKey", 200),
      "x-request-id": header(requestId, "requestId", 128),
      ...(subjectToken === undefined ? {} : { "x-ltm-subject-token": header(subjectToken, "subject token", 8_192) }),
    }, true);
  }

  async bytes(method: "PUT", path: string, value: Uint8Array, idempotencyKey: string, requestId: string,
    identityHeaders: Readonly<Record<string, string>>, extraHeaders: Readonly<Record<string, string>>): Promise<unknown> {
    if (value.byteLength < 1 || value.byteLength > 6 * 1024 * 1024) throw validation("upload chunk size is invalid");
    return this.#request(method, path, value, {
      "content-type": "application/octet-stream",
      "idempotency-key": header(idempotencyKey, "idempotencyKey", 200),
      "x-request-id": header(requestId, "requestId", 128),
      ...identityHeaders,
      ...extraHeaders,
    }, true);
  }

  async empty(method: "POST", path: string, value: object, idempotencyKey: string, requestId: string, subjectToken?: string): Promise<void> {
    await this.#request(method, path, JSON.stringify(value), {
      "content-type": "application/json",
      "idempotency-key": header(idempotencyKey, "idempotencyKey", 200),
      "x-request-id": header(requestId, "requestId", 128),
      ...(subjectToken === undefined ? {} : { "x-ltm-subject-token": header(subjectToken, "subject token", 8_192) }),
    }, false);
  }

  async readiness(dependency: string): Promise<{ ready: boolean; dependency: string }> {
    try {
      const value = await this.#request("GET", "/health/ready", undefined, {}, true);
      return { ready: record(value, "broker readiness").ready === true, dependency };
    } catch { return { ready: false, dependency }; }
  }

  async #request(method: "GET" | "POST" | "PUT", path: string, body: string | Uint8Array | undefined,
    headers: Readonly<Record<string, string>>, expectsJson: boolean): Promise<unknown> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes("..")) throw configuration("broker path is invalid");
    const workloadToken = this.#workloadToken();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: "application/json", authorization: `Bearer ${workloadToken}`, ...headers },
        ...(body === undefined ? {} : { body }),
      });
    } catch { unavailable("client integration broker is unreachable"); }
    if (!response.ok) unavailable("client integration broker rejected the request");
    if (!expectsJson && response.status === 204) return undefined;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_BROKER_RESPONSE_BYTES) {
      await response.body?.cancel();
      unavailable("client integration broker response is too large");
    }
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];
    let size=0;
    if(reader!==undefined) {
      try {
        for(;;) {
          const next=await reader.read();if(next.done)break;
          size+=next.value.byteLength;
          if(size>MAX_BROKER_RESPONSE_BYTES) {
            await reader.cancel();unavailable("client integration broker response is too large");
          }
          chunks.push(next.value);
        }
      }catch(error){if(error instanceof DomainError)throw error;unavailable("client integration broker response stream failed");}
      finally{reader.releaseLock();}
    }
    const raw=Buffer.concat(chunks,size).toString("utf8");
    if (raw.length === 0 && !expectsJson) return undefined;
    if (Buffer.byteLength(raw, "utf8") > MAX_BROKER_RESPONSE_BYTES) unavailable("client integration broker response is too large");
    try { return JSON.parse(raw) as unknown; } catch { unavailable("client integration broker returned invalid JSON"); }
  }

  #workloadToken(): string {
    try {
      const metadata = statSync(this.#tokenFile);
      if (!metadata.isFile() || metadata.size < 20 || metadata.size > 8_192 || (metadata.mode & 0o022) !== 0) {
        throw new Error("unsafe token file");
      }
      return header(readFileSync(this.#tokenFile, "utf8").trim(), "workload token", 8_192);
    } catch { unavailable("client integration workload token is unavailable"); }
  }
}

function principal(context: ActorContext): object {
  return { actorId: context.actorId, tenantId: context.tenantId, roles: context.roles, purpose: context.purpose };
}
function principalHeaders(context: ActorContext): Readonly<Record<string, string>> {
  return {
    "x-ltm-actor-id": header(context.actorId, "actorId", 128),
    "x-ltm-tenant-id": header(context.tenantId, "tenantId", 128),
    "x-ltm-purpose": header(context.purpose, "purpose", 120),
    "x-ltm-roles": header(context.roles.join(","), "roles", 1_024),
  };
}
function sessionProjection(value: unknown): ClientSessionProjection {
  const session = record(value, "session");
  exactUpstreamKeys(session, ["accessToken", "expiresAt", "tenantId", "actorId", "roles", "purpose"], "session");
  const roles = session.roles;
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > 20 ||
      new Set(roles).size !== roles.length ||
      roles.some((role) => typeof role !== "string" || !CLIENT_ROLES.has(role as Role))) unavailable("identity broker returned invalid roles");
  const expiresAt = futureTimestamp(session.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) > Date.now() + 24 * 60 * 60_000) unavailable("identity broker session lifetime exceeds 24 hours");
  return {
    accessToken: upstreamBounded(session.accessToken, "accessToken", 8_192, 20),
    expiresAt,
    tenantId: identifier(session.tenantId, "tenantId"),
    actorId: identifier(session.actorId, "actorId"),
    roles: [...roles] as Role[],
    purpose: upstreamBounded(session.purpose, "purpose", 120),
  };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactUpstreamKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    unavailable(`identity broker returned an invalid ${label}`);
  }
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) unavailable(`${label} is invalid`);
  return value;
}
function bounded(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) validation(`${label} is invalid`);
  return value;
}
function upstreamBounded(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    unavailable(`identity broker returned an invalid ${label}`);
  }
  return value;
}
function header(value: string, label: string, maximum: number): string {
  return bounded(value, label, maximum);
}
function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) unavailable(`${label} is invalid`);
  return value as number;
}
function futureTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) unavailable(`${label} is invalid`);
  return value;
}
function pastTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now() + 5 * 60_000) {
    unavailable(`${label} is invalid`);
  }
  return new Date(Date.parse(value)).toISOString();
}
function anyTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) unavailable(`${label} is invalid`);
  return new Date(Date.parse(value)).toISOString();
}
function upstreamDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) unavailable(`${label} is invalid`);
  return value;
}
function upstreamIdentifiers(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length) unavailable(`${label} is invalid`);
  return value.map((entry) => identifier(entry, label));
}
function upstreamIdentifiersBounded(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum ||
      value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length) unavailable(`${label} is invalid`);
  return value.map((entry) => identifier(entry, label));
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function upstreamExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) unavailable(`${label} is not a closed response`);
}
function configuration(message: string): DomainError { return new DomainError("CONFIGURATION_INVALID", message); }
function validation(message: string): never { throw new DomainError("VALIDATION_FAILED", message); }
function unavailable(message: string): never { throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", message); }
