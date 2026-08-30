import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  CommercialOperationsError,
  canonicalJson,
  exactUtc,
  freeze,
  identifier,
  sha256,
  sortedUnique,
  type JsonObject,
} from "./common.js";

export type CommercialEnvironment = "test" | "sandbox" | "staging" | "production";

export interface UnsignedCommercialFact {
  readonly version: "ltm.commercial-fact.v1";
  readonly factId: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly provider: string;
  readonly environment: CommercialEnvironment;
  readonly factKind: string;
  readonly subjectId: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly payload: JsonObject;
  readonly payloadSha256: string;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
}

export interface SignedCommercialFact extends UnsignedCommercialFact {
  readonly signature: string;
}

export interface CommercialFactTrustKey {
  readonly issuer: string;
  readonly provider: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly allowedEnvironments: readonly CommercialEnvironment[];
  readonly allowedFactKinds: readonly string[];
  readonly allowedTenantIds?: readonly string[];
  readonly notBefore?: string;
  readonly notAfter?: string;
}

export interface VerifiedCommercialFact extends SignedCommercialFact {
  readonly factSha256: string;
}

export function commercialFactSigningPayload(fact: UnsignedCommercialFact): Buffer {
  return Buffer.from(canonicalJson({
    version: fact.version,
    factId: fact.factId,
    tenantId: fact.tenantId,
    issuer: fact.issuer,
    provider: fact.provider,
    environment: fact.environment,
    factKind: fact.factKind,
    subjectId: fact.subjectId,
    occurredAt: fact.occurredAt,
    sequence: fact.sequence,
    payload: fact.payload,
    payloadSha256: fact.payloadSha256,
    algorithm: fact.algorithm,
    keyId: fact.keyId,
  }), "utf8");
}

export function signCommercialFact(
  input: Omit<UnsignedCommercialFact, "payloadSha256"> & { readonly payloadSha256?: string },
  privateKeyPem: string,
): SignedCommercialFact {
  const payloadSha256 = sha256(canonicalJson(input.payload));
  if (input.payloadSha256 !== undefined && input.payloadSha256 !== payloadSha256) {
    throw new CommercialOperationsError("VALIDATION_FAILED", "commercial fact payload digest does not match payload");
  }
  const unsigned: UnsignedCommercialFact = { ...input, payloadSha256 };
  validateUnsignedFact(unsigned);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial fact signing key must be Ed25519");
  }
  return freeze({
    ...unsigned,
    signature: sign(null, commercialFactSigningPayload(unsigned), key).toString("base64url"),
  });
}

export class CommercialFactVerifier {
  readonly #keys: readonly CommercialFactTrustKey[];
  readonly #environment: CommercialEnvironment;
  readonly #clock: () => Date;
  readonly #maximumFutureSkewMs: number;

  constructor(options: {
    readonly keys: readonly CommercialFactTrustKey[];
    readonly environment: CommercialEnvironment;
    readonly clock?: () => Date;
    readonly maximumFutureSkewMs?: number;
  }) {
    if (options.keys.length < 1) {
      throw new CommercialOperationsError("CONFIGURATION_INVALID", "at least one commercial fact authority is required");
    }
    const identities = new Set<string>();
    for (const key of options.keys) {
      identifier(key.issuer, "fact trust issuer");
      identifier(key.provider, "fact trust provider");
      identifier(key.keyId, "fact trust keyId");
      sortedUnique(key.allowedEnvironments, "allowed environments");
      sortedUnique(key.allowedFactKinds, "allowed fact kinds");
      if (key.allowedFactKinds.some((kind) => kind.includes("*"))) {
        throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial fact kinds must be exact, not wildcarded");
      }
      if (key.allowedTenantIds !== undefined) sortedUnique(key.allowedTenantIds, "allowed tenant IDs");
      if (key.notBefore !== undefined) exactUtc(key.notBefore, "fact key notBefore");
      if (key.notAfter !== undefined) exactUtc(key.notAfter, "fact key notAfter");
      const publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial fact authority key must be Ed25519");
      }
      const identity = `${key.issuer}\n${key.provider}\n${key.keyId}`;
      if (identities.has(identity)) throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial fact key identity is duplicated");
      identities.add(identity);
    }
    this.#keys = Object.freeze([...options.keys]);
    this.#environment = options.environment;
    this.#clock = options.clock ?? (() => new Date());
    this.#maximumFutureSkewMs = options.maximumFutureSkewMs ?? 300_000;
  }

  verify(fact: SignedCommercialFact, expected: {
    readonly tenantId: string;
    readonly factKind: string;
    readonly subjectId?: string;
    readonly provider?: string;
  }): VerifiedCommercialFact {
    validateUnsignedFact(fact);
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(fact.signature)) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "commercial fact signature encoding is invalid");
    }
    if (fact.environment !== this.#environment || fact.tenantId !== expected.tenantId || fact.factKind !== expected.factKind ||
        (expected.subjectId !== undefined && fact.subjectId !== expected.subjectId) ||
        (expected.provider !== undefined && fact.provider !== expected.provider)) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "commercial fact binding does not match the command");
    }
    if (Date.parse(fact.occurredAt) > this.#clock().getTime() + this.#maximumFutureSkewMs) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "commercial fact occurrence time is in the future");
    }
    if (sha256(canonicalJson(fact.payload)) !== fact.payloadSha256) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "commercial fact payload digest is invalid");
    }
    const key = this.#keys.find((candidate) =>
      candidate.issuer === fact.issuer && candidate.provider === fact.provider && candidate.keyId === fact.keyId);
    if (key === undefined || !key.allowedEnvironments.includes(fact.environment) ||
        !key.allowedFactKinds.includes(fact.factKind) ||
        (key.allowedTenantIds !== undefined && !key.allowedTenantIds.includes(fact.tenantId)) ||
        (key.notBefore !== undefined && Date.parse(fact.occurredAt) < Date.parse(key.notBefore)) ||
        (key.notAfter !== undefined && Date.parse(fact.occurredAt) > Date.parse(key.notAfter))) {
      throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "no commercial fact authority matches this exact scope");
    }
    const verified = verify(null, commercialFactSigningPayload(fact), createPublicKey(key.publicKeyPem), Buffer.from(fact.signature, "base64url"));
    if (!verified) throw new CommercialOperationsError("EXTERNAL_FACT_UNVERIFIED", "commercial fact signature is invalid");
    const factSha256 = sha256(canonicalJson({
      ...fact,
      signature: fact.signature,
    }));
    return freeze({ ...fact, factSha256 });
  }
}

function validateUnsignedFact(fact: UnsignedCommercialFact): void {
  if (fact.version !== "ltm.commercial-fact.v1" || fact.algorithm !== "Ed25519") {
    throw new CommercialOperationsError("VALIDATION_FAILED", "commercial fact version or algorithm is unsupported");
  }
  identifier(fact.factId, "factId");
  identifier(fact.tenantId, "tenantId");
  identifier(fact.issuer, "issuer");
  identifier(fact.provider, "provider");
  identifier(fact.factKind, "factKind");
  identifier(fact.subjectId, "subjectId");
  identifier(fact.keyId, "keyId");
  exactUtc(fact.occurredAt, "occurredAt");
  if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 1) {
    throw new CommercialOperationsError("VALIDATION_FAILED", "commercial fact sequence must be a positive integer");
  }
  if (!/^[a-f0-9]{64}$/.test(fact.payloadSha256)) {
    throw new CommercialOperationsError("VALIDATION_FAILED", "commercial fact payloadSha256 is invalid");
  }
}
