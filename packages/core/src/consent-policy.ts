import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";
import { normalizeConsentScope } from "./consent-scope.js";
import { DomainError } from "./errors.js";
import type {
  ConsentScope,
  EvidenceEnvironment,
  GrantorCapacity,
  JsonObject,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PURPOSE = /^[a-z][a-z0-9_:-]{0,119}$/;
const RESOURCE_KIND = /^[a-z][a-z0-9_.-]{0,79}$/;
const ACTION = /^[a-z][a-z0-9_.:-]{0,79}$/;
const JURISDICTION = /^(?:GLOBAL|[A-Z]{2}(?:-[A-Z0-9]{1,8})*)$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{80,100}$/;

export type ConsentPolicyMinorApplicability = "adult" | "minor" | "all";

export interface ConsentPolicyDefinition {
  readonly policyVersion: string;
  readonly purpose: string;
  readonly locale: string;
  readonly jurisdictions: readonly string[];
  readonly resourceKinds: readonly string[];
  readonly allowedActions: readonly string[];
  readonly grantorCapacities: readonly GrantorCapacity[];
  readonly minorApplicability: ConsentPolicyMinorApplicability;
  readonly disclosureSha256: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly maxConsentLifetimeSeconds: number;
}

export interface UnsignedConsentPolicyCatalog {
  readonly schemaVersion: "ltm.consent-policy-catalog.v1";
  readonly catalogId: string;
  readonly issuer: string;
  readonly environment: EvidenceEnvironment;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly policies: readonly ConsentPolicyDefinition[];
}

export interface SignedConsentPolicyCatalog extends UnsignedConsentPolicyCatalog {
  readonly signature: string;
}

export interface TrustedConsentPolicyKey {
  readonly keyId: string;
  readonly issuer: string;
  readonly algorithm: "Ed25519";
  readonly publicKeyPem: string;
  readonly allowedEnvironments: readonly EvidenceEnvironment[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly revokedAt?: string | null;
}

export interface VerifiedConsentPolicyCatalog {
  readonly document: SignedConsentPolicyCatalog;
  readonly sha256: string;
  readonly policies: ReadonlyMap<string, ConsentPolicyDefinition>;
}

export interface ResolveConsentPolicyInput {
  readonly policyVersion: string;
  readonly purpose: string;
  readonly jurisdiction: string;
  readonly locale: string;
  readonly scope: JsonObject;
  readonly grantorCapacity: GrantorCapacity;
  readonly isMinor: boolean;
  readonly requestedExpiresAt: string | null;
  readonly participantExpiresAt: string;
  readonly at: string;
}

export interface ResolvedConsentPolicy {
  readonly policyVersion: string;
  readonly disclosureSha256: string;
  readonly catalogSha256: string;
  readonly jurisdiction: string;
  readonly locale: string;
  readonly expiresAt: string;
  readonly scope: ConsentScope;
}

export function consentPolicyCatalogSigningPayload(catalog: UnsignedConsentPolicyCatalog): Buffer {
  return Buffer.from(canonicalJson(catalog), "utf8");
}

export function signConsentPolicyCatalog(
  catalog: UnsignedConsentPolicyCatalog,
  privateKey: string | Buffer,
): SignedConsentPolicyCatalog {
  const normalized = normalizeUnsignedCatalog(catalog);
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw configuration("Consent policy catalog private key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw configuration("Consent policy catalog signing requires an Ed25519 private key");
  }
  return {
    ...normalized,
    signature: cryptoSign(null, consentPolicyCatalogSigningPayload(normalized), key).toString("base64url"),
  };
}

export function verifyConsentPolicyCatalog(
  value: unknown,
  trustedKeys: readonly TrustedConsentPolicyKey[],
  expectedEnvironment: EvidenceEnvironment,
  atValue: string,
): VerifiedConsentPolicyCatalog {
  const document = normalizeSignedCatalog(value);
  const at = timestamp(atValue, "verification time");
  if (document.environment !== expectedEnvironment) {
    throw configuration("Consent policy catalog environment does not match the runtime");
  }
  if (document.issuedAt > at || document.expiresAt <= at || document.issuedAt >= document.expiresAt) {
    throw configuration("Consent policy catalog is outside its validity window");
  }
  const matching = trustedKeys.filter((key) => key.keyId === document.keyId && key.issuer === document.issuer);
  if (matching.length !== 1) {
    throw configuration("Consent policy catalog must match exactly one trusted key");
  }
  const trust = normalizeTrustKey(matching[0] as TrustedConsentPolicyKey);
  if (!trust.allowedEnvironments.includes(expectedEnvironment) || trust.notBefore > at || trust.notAfter <= at ||
      (trust.revokedAt !== null && trust.revokedAt <= at)) {
    throw configuration("Consent policy catalog trust key is not active for this environment");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(trust.publicKeyPem);
  } catch {
    throw configuration("Consent policy catalog trust key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw configuration("Consent policy catalog trust key must be Ed25519");
  }
  const signature = Buffer.from(document.signature, "base64url");
  if (signature.toString("base64url") !== document.signature ||
      !cryptoVerify(null, consentPolicyCatalogSigningPayload(withoutSignature(document)), publicKey, signature)) {
    throw configuration("Consent policy catalog signature is invalid");
  }
  const policies = new Map<string, ConsentPolicyDefinition>();
  const tuples = new Set<string>();
  for (const policy of document.policies) {
    if (policies.has(policy.policyVersion)) {
      throw configuration("Consent policy versions must be globally unique within a catalog");
    }
    policies.set(policy.policyVersion, policy);
    for (const jurisdiction of policy.jurisdictions) {
      const tuple = canonicalJson({
        purpose: policy.purpose,
        locale: policy.locale,
        jurisdiction,
        resourceKinds: policy.resourceKinds,
        allowedActions: policy.allowedActions,
        grantorCapacities: policy.grantorCapacities,
        minorApplicability: policy.minorApplicability,
        effectiveFrom: policy.effectiveFrom,
        effectiveUntil: policy.effectiveUntil,
      });
      if (tuples.has(tuple)) throw configuration("Consent policy catalog contains an ambiguous policy tuple");
      tuples.add(tuple);
    }
  }
  return {
    document,
    sha256: sha256(canonicalJson(document)),
    policies,
  };
}

export function resolveConsentPolicy(
  catalog: VerifiedConsentPolicyCatalog,
  input: ResolveConsentPolicyInput,
): ResolvedConsentPolicy {
  const policyVersion = identifier(input.policyVersion, "policyVersion");
  const purpose = patterned(input.purpose, "purpose", PURPOSE);
  const jurisdiction = patterned(input.jurisdiction, "jurisdiction", JURISDICTION);
  const locale = patterned(input.locale, "locale", LOCALE);
  const at = timestamp(input.at, "policy evaluation time");
  const participantExpiresAt = timestamp(input.participantExpiresAt, "participant expiry");
  const requestedExpiresAt = input.requestedExpiresAt === null
    ? null
    : timestamp(input.requestedExpiresAt, "requested consent expiry");
  const scope = normalizeConsentScope(input.scope);
  const resourceKind = scope.resource.split(":", 1)[0] as string;
  const policy = catalog.policies.get(policyVersion);
  if (policy === undefined || policy.purpose !== purpose || policy.locale !== locale ||
      !(policy.jurisdictions.includes(jurisdiction) || policy.jurisdictions.includes("GLOBAL")) ||
      !policy.resourceKinds.includes(resourceKind) ||
      scope.actions.some((action) => !policy.allowedActions.includes(action)) ||
      !policy.grantorCapacities.includes(input.grantorCapacity) ||
      (policy.minorApplicability === "minor") !== input.isMinor && policy.minorApplicability !== "all" ||
      policy.effectiveFrom > at || policy.effectiveUntil <= at) {
    throw new DomainError("CONSENT_REQUIRED", "The selected consent policy does not cover this exact grant");
  }
  const maximumExpiry = new Date(Math.min(
    Date.parse(policy.effectiveUntil),
    Date.parse(catalog.document.expiresAt),
    Date.parse(participantExpiresAt),
    Date.parse(at) + policy.maxConsentLifetimeSeconds * 1_000,
  )).toISOString();
  const expiresAt = requestedExpiresAt ?? maximumExpiry;
  if (expiresAt <= at || expiresAt > maximumExpiry) {
    throw new DomainError("VALIDATION_FAILED", "Consent expiry exceeds the policy, catalog, or participant authority window");
  }
  return {
    policyVersion,
    disclosureSha256: policy.disclosureSha256,
    catalogSha256: catalog.sha256,
    jurisdiction,
    locale,
    expiresAt,
    scope,
  };
}

function normalizeSignedCatalog(value: unknown): SignedConsentPolicyCatalog {
  const object = exactObject(value, [
    "schemaVersion", "catalogId", "issuer", "environment", "issuedAt", "expiresAt",
    "algorithm", "keyId", "policies", "signature",
  ], "consent policy catalog");
  const signature = patterned(object.signature, "catalog signature", BASE64URL_SIGNATURE);
  const { signature: _signature, ...unsignedFields } = object;
  const unsigned = normalizeUnsignedCatalog(unsignedFields as unknown as UnsignedConsentPolicyCatalog);
  return { ...unsigned, signature };
}

function normalizeUnsignedCatalog(value: UnsignedConsentPolicyCatalog): UnsignedConsentPolicyCatalog {
  const object = exactObject(value, [
    "schemaVersion", "catalogId", "issuer", "environment", "issuedAt", "expiresAt",
    "algorithm", "keyId", "policies",
  ], "unsigned consent policy catalog");
  if (object.schemaVersion !== "ltm.consent-policy-catalog.v1" || object.algorithm !== "Ed25519" ||
      !["sandbox", "staging", "production"].includes(String(object.environment))) {
    throw configuration("Consent policy catalog version, algorithm, or environment is unsupported");
  }
  if (!Array.isArray(object.policies) || object.policies.length < 1 || object.policies.length > 1_000) {
    throw configuration("Consent policy catalog must contain one to 1000 policies");
  }
  const policies = object.policies.map((policy, index) => normalizePolicy(policy, index));
  return {
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: identifier(object.catalogId, "catalogId"),
    issuer: identifier(object.issuer, "issuer"),
    environment: object.environment as EvidenceEnvironment,
    issuedAt: timestamp(object.issuedAt, "catalog issuedAt"),
    expiresAt: timestamp(object.expiresAt, "catalog expiresAt"),
    algorithm: "Ed25519",
    keyId: identifier(object.keyId, "keyId"),
    policies,
  };
}

function normalizePolicy(value: unknown, index: number): ConsentPolicyDefinition {
  const label = `consent policy ${index}`;
  const object = exactObject(value, [
    "policyVersion", "purpose", "locale", "jurisdictions", "resourceKinds", "allowedActions",
    "grantorCapacities", "minorApplicability", "disclosureSha256", "effectiveFrom", "effectiveUntil",
    "maxConsentLifetimeSeconds",
  ], label);
  const effectiveFrom = timestamp(object.effectiveFrom, `${label} effectiveFrom`);
  const effectiveUntil = timestamp(object.effectiveUntil, `${label} effectiveUntil`);
  if (effectiveFrom >= effectiveUntil) throw configuration(`${label} validity window is invalid`);
  const maxConsentLifetimeSeconds = integer(object.maxConsentLifetimeSeconds, `${label} maxConsentLifetimeSeconds`, 60, 31_622_400);
  const grantorCapacities = strings(object.grantorCapacities, `${label} grantorCapacities`, 1, 3)
    .map((capacity) => {
      if (!new Set(["self", "guardian", "authorized_agent"]).has(capacity)) {
        throw configuration(`${label} grantor capacity is unsupported`);
      }
      return capacity as GrantorCapacity;
    });
  const minorApplicability = String(object.minorApplicability);
  if (!new Set(["adult", "minor", "all"]).has(minorApplicability)) {
    throw configuration(`${label} minorApplicability is unsupported`);
  }
  return {
    policyVersion: identifier(object.policyVersion, `${label} policyVersion`),
    purpose: patterned(object.purpose, `${label} purpose`, PURPOSE),
    locale: patterned(object.locale, `${label} locale`, LOCALE),
    jurisdictions: strings(object.jurisdictions, `${label} jurisdictions`, 1, 64)
      .map((item) => patterned(item, `${label} jurisdiction`, JURISDICTION)),
    resourceKinds: strings(object.resourceKinds, `${label} resourceKinds`, 1, 100)
      .map((item) => patterned(item, `${label} resource kind`, RESOURCE_KIND)),
    allowedActions: strings(object.allowedActions, `${label} allowedActions`, 1, 100)
      .map((item) => patterned(item, `${label} action`, ACTION)),
    grantorCapacities,
    minorApplicability: minorApplicability as ConsentPolicyMinorApplicability,
    disclosureSha256: patterned(object.disclosureSha256, `${label} disclosureSha256`, SHA256),
    effectiveFrom,
    effectiveUntil,
    maxConsentLifetimeSeconds,
  };
}

function normalizeTrustKey(value: TrustedConsentPolicyKey): Required<TrustedConsentPolicyKey> {
  const object = exactObject(value, [
    "keyId", "issuer", "algorithm", "publicKeyPem", "allowedEnvironments", "notBefore", "notAfter",
    ...(Object.prototype.hasOwnProperty.call(value, "revokedAt") ? ["revokedAt"] : []),
  ], "consent policy trust key");
  if (object.algorithm !== "Ed25519" || typeof object.publicKeyPem !== "string" || object.publicKeyPem.length > 16_384) {
    throw configuration("Consent policy trust key must be a bounded Ed25519 PEM");
  }
  const allowedEnvironments = strings(object.allowedEnvironments, "allowedEnvironments", 1, 3)
    .map((environment) => {
      if (!new Set(["sandbox", "staging", "production"]).has(environment)) {
        throw configuration("Consent policy trust environment is unsupported");
      }
      return environment as EvidenceEnvironment;
    });
  const notBefore = timestamp(object.notBefore, "trust key notBefore");
  const notAfter = timestamp(object.notAfter, "trust key notAfter");
  if (notBefore >= notAfter) throw configuration("Consent policy trust key window is invalid");
  const revokedAt = object.revokedAt === undefined || object.revokedAt === null
    ? null
    : timestamp(object.revokedAt, "trust key revokedAt");
  return {
    keyId: identifier(object.keyId, "trust key keyId"),
    issuer: identifier(object.issuer, "trust key issuer"),
    algorithm: "Ed25519",
    publicKeyPem: object.publicKeyPem,
    allowedEnvironments,
    notBefore,
    notAfter,
    revokedAt,
  };
}

function withoutSignature(value: SignedConsentPolicyCatalog): UnsignedConsentPolicyCatalog {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configuration(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw configuration(`${label} fields do not match the closed contract`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
      value.some((item) => typeof item !== "string")) {
    throw configuration(`${label} must be a bounded string array`);
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length || [...normalized].sort().some((item, index) => item !== normalized[index])) {
    throw configuration(`${label} must be unique and canonically sorted`);
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  return patterned(value, label, IDENTIFIER);
}

function patterned(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value)) {
    throw configuration(`${label} has an invalid canonical format`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw configuration(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw configuration(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function configuration(message: string): DomainError {
  return new DomainError("CONFIGURATION_INVALID", message);
}
