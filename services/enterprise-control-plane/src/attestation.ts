import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { EnterpriseControlError, canonicalJson, exactUtc, freeze, hexDigest, identifier, sha256, unique, type JsonObject, type JsonValue } from "./common.js";

export type EnterpriseEnvironment = "test" | "staging" | "production";
export interface UnsignedEnterpriseAttestation {
  readonly version: "ltm.enterprise-attestation.v1"; readonly factId: string; readonly tenantId: string;
  readonly issuer: string; readonly issuerRole: string; readonly environment: EnterpriseEnvironment; readonly factKind: string;
  readonly subjectId: string; readonly sequence: number; readonly occurredAt: string; readonly expiresAt: string;
  readonly payload: JsonObject; readonly payloadSha256: string; readonly algorithm: "Ed25519"; readonly keyId: string;
}
export interface SignedEnterpriseAttestation extends UnsignedEnterpriseAttestation { readonly signature: string }
export interface EnterpriseAuthority {
  readonly issuer: string; readonly issuerRole: string; readonly keyId: string; readonly publicKeyPem: string;
  readonly environments: readonly EnterpriseEnvironment[]; readonly factKinds: readonly string[]; readonly tenantIds?: readonly string[];
  readonly independent: boolean;
}
export interface VerifiedEnterpriseAttestation extends SignedEnterpriseAttestation { readonly factSha256: string; readonly independent: boolean }

function bytes(fact: UnsignedEnterpriseAttestation): Buffer {
  return Buffer.from(canonicalJson({ version: fact.version, factId: fact.factId, tenantId: fact.tenantId, issuer: fact.issuer, issuerRole: fact.issuerRole, environment: fact.environment, factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt, expiresAt: fact.expiresAt, payload: fact.payload, payloadSha256: fact.payloadSha256, algorithm: fact.algorithm, keyId: fact.keyId }), "utf8");
}
export function signEnterpriseAttestation(input: Omit<UnsignedEnterpriseAttestation, "payloadSha256">, privateKeyPem: string): SignedEnterpriseAttestation {
  const fact: UnsignedEnterpriseAttestation = { ...input, payloadSha256: sha256(canonicalJson(input.payload)) };
  validate(fact); const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new EnterpriseControlError("CONFIGURATION_INVALID", "attestation key must be Ed25519");
  return freeze({ ...fact, signature: sign(null, bytes(fact), key).toString("base64url") });
}
export class EnterpriseAttestationVerifier {
  readonly #authorities: readonly EnterpriseAuthority[]; readonly #environment: EnterpriseEnvironment; readonly #clock: () => Date;
  constructor(input: { authorities: readonly EnterpriseAuthority[]; environment: EnterpriseEnvironment; clock?: () => Date }) {
    if (input.authorities.length < 1) throw new EnterpriseControlError("CONFIGURATION_INVALID", "enterprise authorities required");
    const identities = new Set<string>();
    for (const authority of input.authorities) {
      identifier(authority.issuer, "issuer"); identifier(authority.issuerRole, "issuerRole"); identifier(authority.keyId, "keyId");
      unique(authority.environments, "environments"); unique(authority.factKinds, "factKinds");
      if (authority.factKinds.some((kind) => kind.includes("*"))) throw new EnterpriseControlError("CONFIGURATION_INVALID", "attestation kinds cannot wildcard");
      if (createPublicKey(authority.publicKeyPem).asymmetricKeyType !== "ed25519") throw new EnterpriseControlError("CONFIGURATION_INVALID", "authority key must be Ed25519");
      const identity = `${authority.issuer}\n${authority.issuerRole}\n${authority.keyId}`; if (identities.has(identity)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "authority duplicated"); identities.add(identity);
    }
    this.#authorities = freeze([...input.authorities]); this.#environment = input.environment; this.#clock = input.clock ?? (() => new Date());
  }
  verify(fact: SignedEnterpriseAttestation, expected: { tenantId: string; factKind: string; subjectId?: string; independent?: boolean; issuerRole?: string }): VerifiedEnterpriseAttestation {
    validate(fact);
    if (fact.environment !== this.#environment || fact.tenantId !== expected.tenantId || fact.factKind !== expected.factKind || (expected.subjectId !== undefined && fact.subjectId !== expected.subjectId) || (expected.issuerRole !== undefined && fact.issuerRole !== expected.issuerRole)) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "attestation scope mismatch");
    if (Date.parse(fact.occurredAt) > this.#clock().getTime() + 300_000 || Date.parse(fact.expiresAt) <= this.#clock().getTime()) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "attestation expired or future-dated");
    if (sha256(canonicalJson(fact.payload)) !== fact.payloadSha256) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "attestation payload digest mismatch");
    const authority = this.#authorities.find((key) => key.issuer === fact.issuer && key.issuerRole === fact.issuerRole && key.keyId === fact.keyId);
    if (authority === undefined || !authority.environments.includes(fact.environment) || !authority.factKinds.includes(fact.factKind) || (authority.tenantIds !== undefined && !authority.tenantIds.includes(fact.tenantId)) || (expected.independent === true && !authority.independent)) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "no exact authority for attestation");
    if (!verify(null, bytes(fact), createPublicKey(authority.publicKeyPem), Buffer.from(fact.signature, "base64url"))) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "attestation signature invalid");
    return freeze({ ...fact, factSha256: sha256(canonicalJson(fact as unknown as JsonValue)), independent: authority.independent });
  }
}
function validate(fact: UnsignedEnterpriseAttestation): void {
  if (fact.version !== "ltm.enterprise-attestation.v1" || fact.algorithm !== "Ed25519") throw new EnterpriseControlError("VALIDATION_FAILED", "attestation version/algorithm invalid");
  identifier(fact.factId, "factId"); identifier(fact.tenantId, "tenantId"); identifier(fact.issuer, "issuer"); identifier(fact.issuerRole, "issuerRole"); identifier(fact.factKind, "factKind"); identifier(fact.subjectId, "subjectId"); identifier(fact.keyId, "keyId");
  exactUtc(fact.occurredAt, "occurredAt"); exactUtc(fact.expiresAt, "expiresAt"); hexDigest(fact.payloadSha256, "payloadSha256");
  if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 1 || !/^[A-Za-z0-9_-]{80,100}$/.test((fact as SignedEnterpriseAttestation).signature ?? "A".repeat(80))) throw new EnterpriseControlError("VALIDATION_FAILED", "attestation sequence/signature invalid");
}
