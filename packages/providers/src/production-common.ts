import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  canonicalBusinessClaimsSha256,
  canonicalBusinessEventSha256,
  EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES,
  resolveExternalCommandCallbackRoute,
  parseTimelineResultManifest,
  signExternalEvidence,
  type ExternalCommandTerminalState,
  type JsonObject,
  type UnsignedExternalEvidence,
  type VerifiedBusinessEvent,
} from "@ltm/core";
import {
  assertArtifactDigest,
  assertSignedCapabilityEvidence,
  capabilityEvidenceScope,
  type CapabilityEvidenceBinding,
  type SignedCapabilityEvidence,
} from "./evidence.js";
import type { SecretReference } from "./external-evidence-adapters.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ProductionIntegrationError extends Error {
  constructor(
    readonly code:
      | "CONFIGURATION_INVALID"
      | "CREDENTIAL_UNAVAILABLE"
      | "PROVIDER_REJECTED"
      | "PROVIDER_RESPONSE_INVALID"
      | "PROVIDER_SIGNATURE_INVALID"
      | "PROVIDER_REPLAY_DETECTED"
      | "PROVIDER_TIMEOUT",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProductionIntegrationError";
  }
}

export interface SecretResolver {
  /** Resolve a managed-secret reference. Implementations must never log returned bytes. */
  resolve(reference: SecretReference): Promise<Uint8Array>;
}

export interface EvidenceArtifactStore {
  /** Persist exact native-provider bytes in an encrypted, access-controlled evidence store. */
  put(input: {
    readonly tenantId: string;
    readonly provider: string;
    readonly subjectId: string;
    readonly artifact: Uint8Array;
    readonly sha256: string;
    readonly retentionClass: "financial" | "release" | "operational";
  }): Promise<{ readonly uri: string; readonly sha256: string }>;
}

export interface ReplayStore {
  /** Atomically claim a value until expiresAt. False means it has already been seen. */
  claimOnce(namespace: string, value: string, expiresAt: Date): Promise<boolean>;
}

export interface EvidenceAttestorOptions {
  readonly issuer: string;
  readonly keyId: string;
  readonly privateKeyReference: SecretReference;
  readonly lifetimeMs?: number;
  readonly replayPolicy?: "reusable" | "single_use";
  readonly clock?: () => Date;
}

export interface EvidenceAttestor {
  attest<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
  ): Promise<SignedCapabilityEvidence<Binding>>;
  attestBusinessEvent?<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
    event: BusinessEventDraft,
  ): Promise<AttestedBusinessEvent<Binding>>;
}

export type BusinessEventDraft = Pick<
  VerifiedBusinessEvent,
  | "eventId"
  | "subjectType"
  | "subjectId"
  | "eventType"
  | "providerOccurredAt"
  | "sequence"
  | "correlationId"
  | "canonicalClaims"
>;

export interface AttestedBusinessEvent<Binding extends CapabilityEvidenceBinding = CapabilityEvidenceBinding> {
  readonly evidence: SignedCapabilityEvidence<Binding> & {
    readonly canonicalClaimsSha256: string;
    readonly businessEventSha256: string;
  };
  readonly event: VerifiedBusinessEvent;
}

export interface ExternalCommandTerminalCallbackDraft {
  readonly eventId: string;
  readonly terminalState: ExternalCommandTerminalState;
  readonly providerOccurredAt: string;
  readonly sequence: number | null;
  readonly providerOperationId: string;
  /** Route-owned provider identifiers extracted only from the verified body. */
  readonly requiredClaims?: JsonObject;
  readonly resultManifest?: unknown;
}

/**
 * Derive a terminal callback solely from the server-owned evidence binding and
 * a verified native result. Tenant, route, provider, subject/correlation,
 * collection, patch and state-transition shapes are never callback inputs.
 */
export function externalCommandTerminalBusinessEventDraft(
  binding: CapabilityEvidenceBinding,
  callback: ExternalCommandTerminalCallbackDraft,
): BusinessEventDraft {
  const route = resolveExternalCommandCallbackRoute(binding.batchId, binding.operation);
  if (route === undefined || route.evidenceKind !== binding.kind) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence binding is not an external-command callback route");
  }
  identifier(callback.providerOperationId, "providerOperationId");
  const expectedClaims = route.requiredClaimIdentifiers ?? [];
  const suppliedClaims = callback.requiredClaims ?? {};
  if (Object.keys(suppliedClaims).length !== expectedClaims.length ||
      Object.keys(suppliedClaims).some((field) => !expectedClaims.includes(field))) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "terminal callback required claims do not match the fixed route contract");
  }
  const requiredClaims = Object.fromEntries(expectedClaims.map((field) => {
    const value = suppliedClaims[field];
    if (typeof value !== "string") {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `terminal callback ${field} must be an identifier`);
    }
    return [field, identifier(value, field)];
  }));
  if (callback.resultManifest !== undefined && route.batchId !== "B14") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "only B14 callbacks may carry timeline results");
  }
  let resultManifest: JsonObject | undefined;
  if (callback.resultManifest !== undefined) {
    try { resultManifest = parseTimelineResultManifest(callback.resultManifest) as unknown as JsonObject; }
    catch { throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "timeline result manifest is invalid"); }
  }
  return {
    eventId: callback.eventId,
    subjectType: route.subjectType,
    subjectId: binding.subjectId,
    eventType: EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES[callback.terminalState],
    providerOccurredAt: callback.providerOccurredAt,
    sequence: callback.sequence,
    correlationId: binding.subjectId,
    canonicalClaims: { providerOperationId: callback.providerOperationId, ...requiredClaims,
      ...(resultManifest === undefined ? {} : { resultManifest }) },
  };
}

export interface EvidenceEnvelopeStore {
  /** Atomically return the first signed envelope stored for an exact evidence scope. */
  getOrStore(scope: string, candidate: Uint8Array, expiresAt: Date): Promise<Uint8Array>;
}

/**
 * Issues the LTM envelope only after a native provider verifier has succeeded.
 * The long-lived Ed25519 key remains behind the SecretResolver/KMS boundary.
 */
export class Ed25519EvidenceAttestor implements EvidenceAttestor {
  readonly #lifetimeMs: number;
  readonly #clock: () => Date;

  constructor(
    private readonly options: EvidenceAttestorOptions,
    private readonly secrets: SecretResolver,
  ) {
    identifier(options.issuer, "issuer");
    identifier(options.keyId, "keyId");
    this.#lifetimeMs = options.lifetimeMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#lifetimeMs) || this.#lifetimeMs < 60_000 || this.#lifetimeMs > 24 * 60 * 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence lifetime must be between one minute and 24 hours");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async attest<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
  ): Promise<SignedCapabilityEvidence<Binding>> {
    assertArtifactDigest(artifact, binding.artifactSha256);
    if (binding.environment === "production" && isNonProductionIssuer(this.options.issuer)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "a non-production issuer cannot attest production evidence");
    }
    const issuedAt = this.#clock();
    const expiresAt = new Date(issuedAt.getTime() + this.#lifetimeMs);
    const unsigned: UnsignedExternalEvidence = {
      version: "ltm.external-evidence.v1",
      evidenceId: randomUUID(),
      tenantId: binding.tenantId,
      issuer: this.options.issuer,
      provider: binding.provider,
      environment: binding.environment,
      scope: capabilityEvidenceScope(binding),
      artifactSha256: binding.artifactSha256,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: randomUUID(),
      replayPolicy: this.options.replayPolicy ?? "single_use",
      algorithm: "Ed25519",
      keyId: this.options.keyId,
    };
    const privateKey = Buffer.from(await this.secrets.resolve(this.options.privateKeyReference));
    try {
      const signed = signExternalEvidence(unsigned, privateKey);
      return { ...signed, provider: binding.provider, binding };
    } finally {
      privateKey.fill(0);
    }
  }

  async attestBusinessEvent<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
    draft: BusinessEventDraft,
  ): Promise<AttestedBusinessEvent<Binding>> {
    assertArtifactDigest(artifact, binding.artifactSha256);
    if (binding.environment === "production" && isNonProductionIssuer(this.options.issuer)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "a non-production issuer cannot attest production evidence");
    }
    assertBusinessDraft(binding, draft);
    const issuedAt = this.#clock();
    const expiresAt = new Date(issuedAt.getTime() + this.#lifetimeMs);
    const evidenceId = randomUUID();
    const scope = capabilityEvidenceScope(binding);
    const canonicalClaimsSha256Value = canonicalBusinessClaimsSha256(draft.canonicalClaims);
    const eventWithoutDigest = {
      version: "ltm.external-business-event.v1" as const,
      eventId: draft.eventId,
      tenantId: binding.tenantId,
      batchId: binding.batchId,
      operation: binding.operation,
      provider: binding.provider,
      subjectType: draft.subjectType,
      subjectId: draft.subjectId,
      eventType: draft.eventType,
      providerOccurredAt: draft.providerOccurredAt,
      sequence: draft.sequence,
      correlationId: draft.correlationId,
      artifactSha256: binding.artifactSha256,
      evidenceId,
      evidenceScope: scope,
      canonicalClaims: draft.canonicalClaims,
      canonicalClaimsSha256: canonicalClaimsSha256Value,
    };
    const businessEventSha256 = canonicalBusinessEventSha256(eventWithoutDigest);
    const event: VerifiedBusinessEvent = { ...eventWithoutDigest, businessEventSha256 };
    const unsigned: UnsignedExternalEvidence = {
      version: "ltm.external-evidence.v1",
      evidenceId,
      tenantId: binding.tenantId,
      issuer: this.options.issuer,
      provider: binding.provider,
      environment: binding.environment,
      scope,
      artifactSha256: binding.artifactSha256,
      canonicalClaimsSha256: canonicalClaimsSha256Value,
      businessEventSha256,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: randomUUID(),
      replayPolicy: this.options.replayPolicy ?? "single_use",
      algorithm: "Ed25519",
      keyId: this.options.keyId,
    };
    const privateKey = Buffer.from(await this.secrets.resolve(this.options.privateKeyReference));
    try {
      const signed = signExternalEvidence(unsigned, privateKey);
      return {
        event,
        evidence: {
          ...signed,
          provider: binding.provider,
          binding,
          canonicalClaimsSha256: canonicalClaimsSha256Value,
          businessEventSha256,
        },
      };
    } finally {
      privateKey.fill(0);
    }
  }
}

/** Persists a signed envelope before returning it so crash retries reuse its IDs, nonce, timestamps and signature. */
export class DurableEvidenceAttestor implements EvidenceAttestor {
  constructor(
    private readonly delegate: EvidenceAttestor,
    private readonly store: EvidenceEnvelopeStore,
  ) {}

  async attest<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
  ): Promise<SignedCapabilityEvidence<Binding>> {
    const candidate = await this.delegate.attest(binding, artifact);
    const serialized = Buffer.from(JSON.stringify(candidate), "utf8");
    const storedBytes = await this.store.getOrStore(candidate.scope, serialized, new Date(candidate.expiresAt));
    let stored: unknown;
    try {
      stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(storedBytes)) as unknown;
    } catch {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable evidence envelope is invalid");
    }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable evidence envelope must be an object");
    }
    try {
      assertSignedCapabilityEvidence(stored as SignedCapabilityEvidence);
    } catch {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable evidence envelope failed validation");
    }
    const evidence = stored as SignedCapabilityEvidence;
    if (evidence.scope !== candidate.scope || evidence.tenantId !== candidate.tenantId ||
        evidence.provider !== candidate.provider || evidence.artifactSha256 !== candidate.artifactSha256 ||
        evidence.binding.batchId !== candidate.binding.batchId || evidence.binding.operation !== candidate.binding.operation ||
        evidence.binding.subjectId !== candidate.binding.subjectId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable evidence envelope scope binding is invalid");
    }
    return evidence as SignedCapabilityEvidence<Binding>;
  }

  async attestBusinessEvent<Binding extends CapabilityEvidenceBinding>(
    binding: Binding,
    artifact: Uint8Array,
    draft: BusinessEventDraft,
  ): Promise<AttestedBusinessEvent<Binding>> {
    if (this.delegate.attestBusinessEvent === undefined) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "business event attestation is not supported by the configured attestor");
    }
    const candidate = await this.delegate.attestBusinessEvent(binding, artifact, draft);
    const serialized = Buffer.from(JSON.stringify(candidate.evidence), "utf8");
    // Stable across crash retries: candidate evidence IDs are intentionally random,
    // while provider event IDs and exact evidence scopes are native-verified facts.
    const cacheKey = `${candidate.evidence.scope}:${draft.eventId}`;
    const storedBytes = await this.store.getOrStore(cacheKey, serialized, new Date(candidate.evidence.expiresAt));
    const evidence = decodeBusinessEvidence<Binding>(storedBytes, candidate.evidence);
    const canonicalClaimsSha256Value = canonicalBusinessClaimsSha256(draft.canonicalClaims);
    const eventWithoutDigest = {
      version: "ltm.external-business-event.v1" as const,
      eventId: draft.eventId,
      tenantId: binding.tenantId,
      batchId: binding.batchId,
      operation: binding.operation,
      provider: binding.provider,
      subjectType: draft.subjectType,
      subjectId: draft.subjectId,
      eventType: draft.eventType,
      providerOccurredAt: draft.providerOccurredAt,
      sequence: draft.sequence,
      correlationId: draft.correlationId,
      artifactSha256: binding.artifactSha256,
      evidenceId: evidence.evidenceId,
      evidenceScope: evidence.scope,
      canonicalClaims: draft.canonicalClaims,
      canonicalClaimsSha256: canonicalClaimsSha256Value,
    };
    const businessEventSha256 = canonicalBusinessEventSha256(eventWithoutDigest);
    if (evidence.canonicalClaimsSha256 !== canonicalClaimsSha256Value ||
        evidence.businessEventSha256 !== businessEventSha256) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable evidence does not bind the reconstructed business event");
    }
    return {
      evidence: evidence as AttestedBusinessEvent<Binding>["evidence"],
      event: { ...eventWithoutDigest, businessEventSha256 },
    };
  }
}

export async function attestVerifiedBusinessEvent<Binding extends CapabilityEvidenceBinding>(
  attestor: EvidenceAttestor,
  binding: Binding,
  artifact: Uint8Array,
  draft: BusinessEventDraft,
): Promise<AttestedBusinessEvent<Binding>> {
  if (attestor.attestBusinessEvent === undefined) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "verified business callbacks require a business-event-aware attestor");
  }
  return attestor.attestBusinessEvent(binding, artifact, draft);
}

function assertBusinessDraft(binding: CapabilityEvidenceBinding, draft: BusinessEventDraft): void {
  identifier(draft.eventId, "business eventId");
  identifier(draft.subjectType, "business subjectType");
  identifier(draft.subjectId, "business subjectId");
  identifier(draft.eventType, "business eventType");
  identifier(draft.correlationId, "business correlationId");
  if (!Number.isFinite(Date.parse(draft.providerOccurredAt)) || new Date(draft.providerOccurredAt).toISOString() !== draft.providerOccurredAt) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "business providerOccurredAt must be canonical UTC ISO-8601");
  }
  if (draft.sequence !== null && (!Number.isSafeInteger(draft.sequence) || draft.sequence < 0)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "business sequence must be null or a non-negative integer");
  }
  if (draft.canonicalClaims === null || typeof draft.canonicalClaims !== "object" ||
      Array.isArray(draft.canonicalClaims) || Object.keys(draft.canonicalClaims).length === 0) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "business canonicalClaims must be a non-empty object");
  }
  if (binding.batchId.trim() === "" || binding.operation.trim() === "") {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "business evidence binding route is incomplete");
  }
}

function decodeBusinessEvidence<Binding extends CapabilityEvidenceBinding>(
  bytes: Uint8Array,
  candidate: SignedCapabilityEvidence<Binding>,
): SignedCapabilityEvidence<Binding> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable business evidence envelope is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable business evidence envelope must be an object");
  }
  try {
    assertSignedCapabilityEvidence(value as SignedCapabilityEvidence);
  } catch {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable business evidence failed validation");
  }
  const evidence = value as SignedCapabilityEvidence<Binding>;
  if (evidence.scope !== candidate.scope || evidence.tenantId !== candidate.tenantId ||
      evidence.provider !== candidate.provider || evidence.artifactSha256 !== candidate.artifactSha256 ||
      evidence.binding.batchId !== candidate.binding.batchId || evidence.binding.operation !== candidate.binding.operation ||
      evidence.binding.subjectId !== candidate.binding.subjectId) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "durable business evidence scope binding is invalid");
  }
  return evidence;
}

export interface HardenedHttpRequest {
  readonly url: URL;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly acceptedStatuses?: readonly number[];
}

export interface HardenedHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface HttpTransport {
  request(input: HardenedHttpRequest): Promise<HardenedHttpResponse>;
}

export interface DnsAddressResolver {
  resolve(hostname: string): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
}

const systemDnsResolver: DnsAddressResolver = {
  async resolve(hostname) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => {
      if (entry.family !== 4 && entry.family !== 6) {
        throw new ProductionIntegrationError("PROVIDER_REJECTED", "provider DNS returned an unsupported address family");
      }
      return { address: entry.address, family: entry.family };
    });
  },
};

/** Trusted-config outbound transport with DNS allow-checking and TLS address pinning. */
export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly dns: DnsAddressResolver = systemDnsResolver) {}

  async request(input: HardenedHttpRequest): Promise<HardenedHttpResponse> {
    assertProductionEndpoint(input.url);
    const timeoutMs = boundedInteger(input.timeoutMs ?? 10_000, 500, 60_000, "timeoutMs");
    const maximum = boundedInteger(input.maximumResponseBytes ?? 1_048_576, 1, 10_485_760, "maximumResponseBytes");
    const originalHostname = input.url.hostname.replace(/^\[|\]$/g, "");
    let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
    try {
      addresses = isIP(originalHostname) === 0
        ? await this.dns.resolve(originalHostname)
        : [{ address: originalHostname, family: isIP(originalHostname) as 4 | 6 }];
    } catch {
      throw new ProductionIntegrationError(
        "PROVIDER_REJECTED",
        "provider DNS resolution failed",
        true,
      );
    }
    if (addresses.length === 0 || addresses.length > 32 ||
        addresses.some((entry) => isIP(entry.address) !== entry.family || !isGlobalUnicastAddress(entry.address))) {
      throw new ProductionIntegrationError(
        "PROVIDER_REJECTED",
        "provider DNS resolved to a non-global or invalid address",
        false,
      );
    }
    const pinned = [...addresses].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))[0];
    if (pinned === undefined) throw new ProductionIntegrationError("PROVIDER_REJECTED", "provider DNS returned no usable address");
    const response = await pinnedHttpsRequest(input, pinned, originalHostname, timeoutMs, maximum);
    const accepted = input.acceptedStatuses ?? [200];
    if (!accepted.includes(response.status)) {
      throw new ProductionIntegrationError(
        "PROVIDER_REJECTED",
        `provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    return response;
  }
}

export function assertProductionEndpoint(url: URL): void {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" ||
      (url.port !== "" && url.port !== "443")) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "provider endpoint must be a credential-free HTTPS URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") ||
      host === "metadata.google.internal" || host.endsWith(".local") ||
      host.endsWith(".internal") || host === "home.arpa" || host.endsWith(".home.arpa") ||
      (isIP(host) !== 0 && !isGlobalUnicastAddress(host))) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "provider endpoint cannot target a loopback or private address");
  }
}

export function isGlobalUnicastAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [a = 0, b = 0, c = 0] = octets;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped !== null) return isGlobalUnicastAddress(mapped[1] as string);
  const firstText = normalized.split(":", 1)[0];
  const first = Number.parseInt(firstText ?? "", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (normalized === "2001:db8::" || normalized.startsWith("2001:db8:")) return false;
  if (normalized === "2001::" || normalized.startsWith("2001:0:")) return false;
  if (normalized === "2002::" || normalized.startsWith("2002:")) return false;
  return true;
}

export function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} is not valid UTF-8 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function storeVerifiedArtifact(
  store: EvidenceArtifactStore,
  binding: CapabilityEvidenceBinding,
  artifact: Uint8Array,
  retentionClass: "financial" | "release" | "operational",
): Promise<void> {
  assertArtifactDigest(artifact, binding.artifactSha256);
  const stored = await store.put({
    tenantId: binding.tenantId,
    provider: binding.provider,
    subjectId: binding.subjectId,
    artifact,
    sha256: binding.artifactSha256,
    retentionClass,
  });
  if (!SHA256.test(stored.sha256) || stored.sha256 !== binding.artifactSha256 || stored.uri.trim() === "") {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "evidence artifact store did not confirm the exact digest");
  }
}

export function requiredString(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== "string") throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} must be a string`);
  if (value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${field} is invalid`);
  }
  return value;
}

export function identifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${field} is invalid`);
  return value;
}

function isNonProductionIssuer(value: string): boolean {
  return value === "test" || value.startsWith("test:") || value.startsWith("sandbox:") || value.startsWith("fixture:");
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", `${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pinnedHttpsRequest(
  input: HardenedHttpRequest,
  pinned: { readonly address: string; readonly family: 4 | 6 },
  originalHostname: string,
  timeoutMs: number,
  maximum: number,
): Promise<HardenedHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === "host" && value !== input.url.host) {
        reject(new ProductionIntegrationError("CONFIGURATION_INVALID", "provider Host header cannot override the pinned endpoint"));
        return;
      }
      headers[lower] = value;
    }
    headers.host = input.url.host;
    headers["accept-encoding"] = "identity";
    if (input.body !== undefined) headers["content-length"] = String(input.body.byteLength);
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof ProductionIntegrationError
        ? error
        : new ProductionIntegrationError(
            error instanceof Error && error.name === "PinnedRequestTimeout" ? "PROVIDER_TIMEOUT" : "PROVIDER_REJECTED",
            error instanceof Error && error.name === "PinnedRequestTimeout"
              ? "provider request timed out"
              : "provider request failed before a complete response was received",
            true,
          ));
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: pinned.address,
      family: pinned.family,
      port: input.url.port === "" ? 443 : Number(input.url.port),
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers,
      ...(isIP(originalHostname) === 0 ? { servername: originalHostname } : {}),
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      const declared = response.headers["content-length"];
      if (declared !== undefined && (Array.isArray(declared) || !/^\d+$/.test(declared) || Number(declared) > maximum)) {
        response.destroy();
        fail(new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "provider response exceeds the configured size limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        length += bytes.byteLength;
        if (length > maximum) {
          response.destroy();
          fail(new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "provider response exceeds the configured size limit"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
        }
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: responseHeaders,
          body: Buffer.concat(chunks, length),
        });
      });
    });
    request.once("error", fail);
    request.setTimeout(timeoutMs, () => {
      const error = new Error("pinned HTTPS request timed out");
      error.name = "PinnedRequestTimeout";
      request.destroy(error);
    });
    if (input.body !== undefined) request.write(Buffer.from(input.body));
    request.end();
  });
}
