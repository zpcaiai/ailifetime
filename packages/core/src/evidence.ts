import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { DomainError } from "./errors.js";
import type { SignedExternalEvidence, TrustedEvidenceKey, UnsignedExternalEvidence } from "./types.js";

export function externalEvidenceSigningPayload(evidence: UnsignedExternalEvidence): Buffer {
  return Buffer.from(canonicalJson({
    version: evidence.version,
    evidenceId: evidence.evidenceId,
    tenantId: evidence.tenantId,
    issuer: evidence.issuer,
    provider: evidence.provider,
    environment: evidence.environment,
    scope: evidence.scope,
    artifactSha256: evidence.artifactSha256,
    ...(evidence.canonicalClaimsSha256 === undefined
      ? {}
      : { canonicalClaimsSha256: evidence.canonicalClaimsSha256 }),
    ...(evidence.businessEventSha256 === undefined
      ? {}
      : { businessEventSha256: evidence.businessEventSha256 }),
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.expiresAt,
    nonce: evidence.nonce,
    replayPolicy: evidence.replayPolicy,
    algorithm: evidence.algorithm,
    keyId: evidence.keyId,
  }), "utf8");
}

export function signExternalEvidence(evidence: UnsignedExternalEvidence, privateKey: string | Buffer): SignedExternalEvidence {
  if (evidence.algorithm !== "Ed25519") {
    throw new DomainError("VALIDATION_FAILED", "Only Ed25519 external evidence signatures are supported");
  }
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "External evidence private key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new DomainError("VALIDATION_FAILED", "External evidence signing requires an Ed25519 private key");
  }
  const signature = cryptoSign(null, externalEvidenceSigningPayload(evidence), key).toString("base64url");
  return { ...evidence, signature };
}

export function verifyExternalEvidenceSignature(evidence: SignedExternalEvidence, publicKey: string | Buffer): boolean {
  if (evidence.algorithm !== "Ed25519" || !/^[A-Za-z0-9_-]{80,100}$/.test(evidence.signature)) return false;
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    return false;
  }
  if (key.asymmetricKeyType !== "ed25519") return false;
  try {
    const signature = Buffer.from(evidence.signature, "base64url");
    if (signature.toString("base64url") !== evidence.signature) return false;
    return cryptoVerify(null, externalEvidenceSigningPayload(evidence), key, signature);
  } catch {
    return false;
  }
}

export function validateTrustedEvidenceKey(key: TrustedEvidenceKey): void {
  if (key.algorithm !== "Ed25519") {
    throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence keys must use Ed25519");
  }
  if (key.allowedScopes.length === 0) {
    throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence keys require at least one allowed scope");
  }
  if (key.allowedEnvironments.length === 0) {
    throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence keys require allowed environments");
  }
  for (const scope of key.allowedScopes) {
    if (scope.trim().length === 0 || scope.length > 512 || (scope.includes("*") && !scope.endsWith("*"))) {
      throw new DomainError("CONFIGURATION_INVALID", "Evidence key scopes must be exact values or suffix wildcards");
    }
  }
  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence public key must be a valid Ed25519 public key");
  }
}

export function evidenceScopeAllowed(allowedScopes: readonly string[], scope: string): boolean {
  return allowedScopes.some((allowed) =>
    allowed === "*" || allowed === scope || (allowed.endsWith("*") && scope.startsWith(allowed.slice(0, -1))),
  );
}
