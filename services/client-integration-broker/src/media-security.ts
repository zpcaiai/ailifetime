import sharp from "sharp";
import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  BrokerError,
  RotatingSecretFile,
  configuration,
  dependency,
  exactKeys,
  identifier,
  object,
  safeInteger,
  sha256,
  timestamp,
  validation,
  type JpegNormalizerPort,
  type MediaSafetyEvidence,
  type MediaSafetyScannerPort,
  type ParticipantMappingEvidence,
} from "./contracts.js";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_SCANNER_RESPONSE_BYTES = 64 * 1024;

/** Decodes the entire JPEG and re-encodes pixels without EXIF, XMP, ICC or comments. */
export class SharpJpegNormalizer implements JpegNormalizerPort {
  async normalize(value: Uint8Array) {
    const bytes = Buffer.from(value);
    if (bytes.byteLength < 4 || bytes.byteLength > MAX_MEDIA_BYTES ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
        bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw invalidMedia("media does not have a complete JPEG byte signature");
    }
    try {
      const decoder = sharp(bytes, {
        failOn: "error",
        limitInputPixels: MAX_PIXELS,
        sequentialRead: true,
        animated: false,
      });
      const metadata = await decoder.metadata();
      if (metadata.format !== "jpeg" || metadata.width === undefined || metadata.height === undefined ||
          (metadata.pages ?? 1) !== 1 || metadata.width < 1 || metadata.height < 1 ||
          metadata.width > 8_192 || metadata.height > 8_192) {
        throw invalidMedia("media is not a supported single-frame JPEG");
      }
      const output = await decoder
        .rotate()
        .jpeg({
          quality: 92,
          chromaSubsampling: "4:4:4",
          progressive: false,
          optimiseCoding: true,
          force: true,
        })
        .toBuffer({ resolveWithObject: true });
      if (output.data.byteLength < 4 || output.data.byteLength > MAX_MEDIA_BYTES ||
          output.data[0] !== 0xff || output.data[1] !== 0xd8 || output.data.at(-2) !== 0xff || output.data.at(-1) !== 0xd9 ||
          output.info.width < 1 || output.info.height < 1) {
        throw invalidMedia("canonical JPEG output is invalid");
      }
      return {
        bytes: output.data,
        width: output.info.width,
        height: output.info.height,
        metadataStripped: true as const,
      };
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw invalidMedia("JPEG structure cannot be fully decoded");
    } finally {
      bytes.fill(0);
    }
  }
}

/** Explicit deployment boundary used until a real malware/face scanner is configured. */
export class FailClosedMediaSafetyScanner implements MediaSafetyScannerPort {
  scan(): Promise<MediaSafetyEvidence> {
    return Promise.reject(new BrokerError(
      "NOT_CONFIGURED",
      "media safety scanner is not configured",
      503,
      false,
    ));
  }
  approveParticipants(): Promise<ParticipantMappingEvidence> {
    return Promise.reject(new BrokerError(
      "NOT_CONFIGURED",
      "media participant identity-review authority is not configured",
      503,
      false,
    ));
  }
  readiness(): Promise<boolean> { return Promise.resolve(false); }
}

export interface HttpsMediaSafetyScannerOptions {
  readonly baseUrl: string;
  readonly tokenFile: RotatingSecretFile;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  readonly receiptAuthority?: {
    readonly publicKeyFile: string;
    readonly provider: string;
    readonly policyId: string;
    readonly policySha256: string;
    readonly modelVersion: string;
    readonly keyId: string;
    readonly environment: "test" | "development" | "staging" | "production";
  };
}

/**
 * Sends the canonical, metadata-free JPEG to a separately operated scanner.
 * Its closed response is bound to the exact canonical digest and supplies the
 * malware/content/face evidence consumed by B07.
 */
export class HttpsMediaSafetyScanner implements MediaSafetyScannerPort {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #receiptPublicKey?: KeyObject;

  constructor(private readonly options: HttpsMediaSafetyScannerOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw validation("media scanner URL is invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw validation("media scanner must be a credential-free HTTPS origin");
    }
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 60_000) throw validation("media scanner timeout is invalid");
    this.#origin = url.origin;
    this.#timeoutMs = timeout;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    if (options.receiptAuthority !== undefined) {
      const authority = options.receiptAuthority;
      identifier(authority.provider, "media scanner expected provider");
      identifier(authority.policyId, "media scanner expected policyId");
      identifier(authority.modelVersion, "media scanner expected modelVersion");
      identifier(authority.keyId, "media scanner expected keyId");
      if (!/^[a-f0-9]{64}$/.test(authority.policySha256) ||
          !["test", "development", "staging", "production"].includes(authority.environment)) {
        throw configuration("media scanner receipt authority is invalid");
      }
      this.#receiptPublicKey = scannerPublicKey(authority.publicKeyFile);
    }
  }

  authority(): ReturnType<NonNullable<MediaSafetyScannerPort["authority"]>> {
    const authority = this.options.receiptAuthority;
    if (authority === undefined) return undefined;
    return {
      mediaSafetyPolicySha256: authority.policySha256,
      provider: authority.provider,
      policyId: authority.policyId,
      modelVersion: authority.modelVersion,
      keyId: authority.keyId,
      environment: authority.environment,
    };
  }

  verifyEvidence(evidence: MediaSafetyEvidence): void {
    const authority = this.options.receiptAuthority;
    if (authority === undefined) {
      if (evidence.version !== "ltm.media-safety-evidence.v2") throw dependency("persisted media safety evidence authority is invalid", false);
      return;
    }
    if (evidence.version !== "ltm.media-safety-evidence.v3" || evidence.provider !== authority.provider ||
        evidence.environment !== authority.environment || evidence.policyId !== authority.policyId ||
        evidence.policySha256 !== authority.policySha256 || evidence.modelVersion !== authority.modelVersion ||
        evidence.keyId !== authority.keyId || evidence.signature === undefined || this.#receiptPublicKey === undefined) {
      throw dependency("persisted media safety evidence authority is invalid", false);
    }
    const signed: Record<string, unknown> = { ...evidence };
    delete signed.signature;
    if (!verify(null, Buffer.from(canonicalJson(signed)), this.#receiptPublicKey, Buffer.from(evidence.signature, "base64url"))) {
      throw dependency("persisted media safety evidence signature is invalid", false);
    }
  }

  async scan(input: Parameters<MediaSafetyScannerPort["scan"]>[0]): Promise<MediaSafetyEvidence> {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_MEDIA_BYTES || sha256(input.bytes) !== input.canonicalSha256) {
      throw validation("media scanner input digest is invalid");
    }
    const tenantId = identifier(input.tenantId, "tenantId");
    const actorId = identifier(input.actorId, "actorId");
    const mediaReference = identifier(input.mediaReference, "mediaReference");
    const requestNonce = `scan_${randomUUID()}`;
    const requestBytes = Buffer.from(input.bytes);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/v1/media/scan`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.tokenFile.read()}`,
          "content-type": "image/jpeg",
          "x-ltm-tenant-id": tenantId,
          "x-ltm-actor-id": actorId,
          "x-ltm-media-reference": mediaReference,
          "x-ltm-content-sha256": input.canonicalSha256,
          "x-ltm-request-nonce": requestNonce,
        },
        body: requestBytes,
      });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw dependency("media safety scanner is unavailable");
    } finally { requestBytes.fill(0); }
    assertScannerStatus(response, "media safety scanner");
    try {
      const payload = object(await boundedJson(response), "media safety response");
      const authority = this.options.receiptAuthority;
      exactKeys(payload, authority === undefined ? [
        "version", "requestNonce", "evidenceId", "provider", "tenantId", "actorId", "mediaReference",
        "canonicalSha256", "malwareState", "contentPolicyState", "faceCount", "faceSubjectReferences", "assessedAt",
      ] : [
        "version", "requestNonce", "evidenceId", "provider", "environment", "policyId", "policySha256", "modelVersion",
        "keyId", "tenantId", "actorId", "mediaReference", "canonicalSha256", "malwareState", "contentPolicyState",
        "faceCount", "faceSubjectReferences", "assessedAt", "signature",
      ], "media safety response");
      if (payload.version !== (authority === undefined ? "ltm.media-safety-evidence.v2" : "ltm.media-safety-evidence.v3") ||
          payload.requestNonce !== requestNonce ||
          payload.tenantId !== tenantId || payload.actorId !== actorId || payload.mediaReference !== mediaReference ||
          payload.canonicalSha256 !== input.canonicalSha256 || payload.malwareState !== "clean" ||
          payload.contentPolicyState !== "allowed") {
        throw new Error("media safety response binding mismatch");
      }
      if (authority !== undefined) {
        const signatureValue = payload.signature;
        if (payload.provider !== authority.provider || payload.environment !== authority.environment ||
            payload.policyId !== authority.policyId || payload.policySha256 !== authority.policySha256 ||
            payload.modelVersion !== authority.modelVersion || payload.keyId !== authority.keyId ||
            typeof signatureValue !== "string" || !/^[A-Za-z0-9_-]{80,256}$/.test(signatureValue) ||
            this.#receiptPublicKey === undefined) throw new Error("media safety receipt authority mismatch");
        const signed = { ...payload };
        delete signed.signature;
        if (!verify(null, Buffer.from(canonicalJson(signed)), this.#receiptPublicKey, Buffer.from(signatureValue, "base64url"))) {
          throw new Error("media safety receipt signature mismatch");
        }
      }
      const assessedAt = timestamp(payload.assessedAt, "media safety assessedAt");
      const age = this.#clock().getTime() - Date.parse(assessedAt);
      if (age < -5 * 60_000 || age > 15 * 60_000) throw new Error("media safety evidence time window invalid");
      const faceCount = safeInteger(payload.faceCount, "media safety faceCount", 1, 20);
      const faceSubjectReferences = responseIdentifiers(payload.faceSubjectReferences, "faceSubjectReferences", faceCount);
      return {
        version: authority === undefined ? "ltm.media-safety-evidence.v2" : "ltm.media-safety-evidence.v3",
        requestNonce,
        evidenceId: identifier(payload.evidenceId, "media safety evidenceId"),
        provider: identifier(payload.provider, "media safety provider"),
        tenantId,
        actorId,
        mediaReference,
        canonicalSha256: input.canonicalSha256,
        malwareState: "clean",
        contentPolicyState: "allowed",
        faceCount,
        faceSubjectReferences,
        assessedAt,
        ...(authority === undefined ? {} : {
          environment: authority.environment,
          policyId: authority.policyId,
          policySha256: authority.policySha256,
          modelVersion: authority.modelVersion,
          keyId: authority.keyId,
          signature: payload.signature as string,
        }),
      };
    } catch (error) {
      if (error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE") throw error;
      throw dependency("media safety scanner returned an invalid closed response", false);
    }
  }

  async approveParticipants(
    input: Parameters<MediaSafetyScannerPort["approveParticipants"]>[0],
  ): Promise<ParticipantMappingEvidence> {
    const participantIds = requestIdentifiers(input.participantIds, "participantIds", input.scanEvidence.faceCount);
    const faceSubjectReferences = requestIdentifiers(
      input.scanEvidence.faceSubjectReferences,
      "faceSubjectReferences",
      input.scanEvidence.faceCount,
    );
    const tenantId = identifier(input.tenantId, "tenantId");
    const actorId = identifier(input.actorId, "actorId");
    const mediaReference = identifier(input.mediaReference, "mediaReference");
    if (input.scanEvidence.canonicalSha256 !== input.canonicalSha256 ||
        input.scanEvidence.tenantId !== tenantId || input.scanEvidence.actorId !== actorId ||
        input.scanEvidence.mediaReference !== mediaReference) {
      throw validation("participant review scan binding is invalid");
    }
    const requestNonce = `mapping_${randomUUID()}`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/v1/media/participant-mappings`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.tokenFile.read()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: "ltm.media-participant-mapping-request.v2",
          requestNonce,
          tenantId,
          actorId,
          mediaReference,
          canonicalSha256: input.canonicalSha256,
          scanEvidenceId: input.scanEvidence.evidenceId,
          participantIds,
          faceSubjectReferences,
        }),
      });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw dependency("media participant identity-review authority is unavailable");
    }
    assertScannerStatus(response, "media participant identity-review authority");
    try {
      const payload = object(await boundedJson(response), "participant mapping response");
      exactKeys(payload, [
        "version", "requestNonce", "evidenceId", "provider", "tenantId", "actorId", "mediaReference",
        "canonicalSha256", "scanEvidenceId", "participantIds", "faceSubjectReferences", "state", "assessedAt",
      ], "participant mapping response");
      const returnedParticipants = responseIdentifiers(payload.participantIds, "participantIds", participantIds.length);
      const returnedFaces = responseIdentifiers(payload.faceSubjectReferences, "faceSubjectReferences", faceSubjectReferences.length);
      if (payload.version !== "ltm.media-participant-mapping.v2" || payload.requestNonce !== requestNonce ||
          payload.tenantId !== tenantId || payload.actorId !== actorId || payload.mediaReference !== mediaReference ||
          payload.state !== "approved" || payload.canonicalSha256 !== input.canonicalSha256 ||
          payload.scanEvidenceId !== input.scanEvidence.evidenceId || !sameStrings(returnedParticipants, participantIds) ||
          !sameStrings(returnedFaces, faceSubjectReferences)) {
        throw new Error("participant mapping response binding mismatch");
      }
      const assessedAt = timestamp(payload.assessedAt, "participant mapping assessedAt");
      const age = this.#clock().getTime() - Date.parse(assessedAt);
      if (age < -5 * 60_000 || age > 15 * 60_000) throw new Error("participant mapping time window invalid");
      return {
        version: "ltm.media-participant-mapping.v2",
        requestNonce,
        evidenceId: identifier(payload.evidenceId, "participant mapping evidenceId"),
        provider: identifier(payload.provider, "participant mapping provider"),
        tenantId,
        actorId,
        mediaReference,
        canonicalSha256: input.canonicalSha256,
        scanEvidenceId: input.scanEvidence.evidenceId,
        participantIds,
        faceSubjectReferences,
        state: "approved",
        assessedAt,
      };
    } catch (error) {
      if (error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE") throw error;
      throw dependency("participant identity-review authority returned an invalid closed response", false);
    }
  }

  async readiness(): Promise<boolean> {
    if (!this.options.tokenFile.ready()) return false;
    try {
      const response = await this.#fetch(`${this.#origin}/health/ready`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: "application/json", authorization: `Bearer ${this.options.tokenFile.read()}` },
      });
      if (!response.ok) return false;
      const payload = object(await boundedJson(response), "media scanner readiness");
      exactKeys(payload, ["ready"], "media scanner readiness");
      return payload.ready === true;
    } catch { return false; }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw dependency("media scanner response content-type must be application/json", false);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SCANNER_RESPONSE_BYTES)) {
    throw dependency("media scanner response is too large", false);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw dependency("media scanner response body is unavailable", false);
  const chunks: Buffer[] = [];
  let total = 0;
  let completed = false;
  let cancelled = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { completed = true; break; }
      const bytes = Buffer.from(next.value);
      total += bytes.byteLength;
      if (total > MAX_SCANNER_RESPONSE_BYTES) {
        bytes.fill(0);
        await reader.cancel("media scanner response exceeded the bounded contract").catch(() => undefined);
        cancelled = true;
        throw dependency("media scanner response is too large", false);
      }
      chunks.push(bytes);
    }
    if (total < 2) throw dependency("media scanner response size is invalid", false);
    const bytes = Buffer.concat(chunks, total);
    try { return JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw dependency("media scanner returned invalid JSON", false); }
    finally { bytes.fill(0); }
  } finally {
    if (!completed && !cancelled) await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function invalidMedia(message: string): BrokerError {
  return new BrokerError("INVALID_MEDIA", message, 422, false);
}

function safetyRejected(message: string): BrokerError {
  return new BrokerError("SAFETY_REJECTED", message, 422, false);
}

function requestIdentifiers(value: unknown, label: string, exactLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length !== exactLength || value.length < 1 || value.length > 20 ||
      value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length) {
    throw validation(`${label} must contain exactly ${exactLength} unique identifiers`);
  }
  return value.map((entry) => identifier(entry, label));
}

function responseIdentifiers(value: unknown, label: string, exactLength: number): readonly string[] {
  return requestIdentifiers(value, label, exactLength);
}

function assertScannerStatus(response: Response, dependencyName: string): void {
  if (response.ok) return;
  if (response.status === 422) throw safetyRejected(`${dependencyName} explicitly rejected the media`);
  if ([401, 403, 404].includes(response.status)) {
    throw configuration(`${dependencyName} authentication or endpoint configuration was rejected`);
  }
  if ([408, 409, 425, 429].includes(response.status) || response.status >= 500) {
    throw dependency(`${dependencyName} is temporarily unavailable`, true);
  }
  throw dependency(`${dependencyName} rejected the request without safety evidence`, false);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scannerPublicKey(path: string): KeyObject {
  if (!path.startsWith("/")) throw configuration("media scanner receipt public key path must be absolute");
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size < 64 || metadata.size > 32 * 1024 || (metadata.mode & 0o022) !== 0) {
      throw new Error("unsafe public key");
    }
    return createPublicKey(readFileSync(path));
  } catch { throw configuration("media scanner receipt public key is unavailable or invalid"); }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw configuration("media scanner signed receipt contains an unsupported value");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
