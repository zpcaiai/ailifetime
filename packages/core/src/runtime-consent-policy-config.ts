import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { verifyConsentPolicyCatalog, type TrustedConsentPolicyKey } from "./consent-policy.js";
import { DomainError } from "./errors.js";
import type { EvidenceEnvironment, RuntimeOptions } from "./types.js";

export type ConsentPolicyApplicationEnvironment =
  | "local"
  | "development"
  | "test"
  | "staging"
  | "production";

export type ConsentPolicyRuntimeOptions = Pick<RuntimeOptions,
  "consentPolicyCatalog" | "trustedConsentPolicyKeys" | "consentPolicyJurisdiction" |
  "consentPolicyLocale" | "allowLegacyConsentPolicy">;

export interface ConsentPolicyConfigurationInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly applicationEnvironment: ConsentPolicyApplicationEnvironment;
  readonly evidenceEnvironment: EvidenceEnvironment;
  readonly productRoot: string;
  /**
   * Development-only service processes may explicitly make their default
   * legacy mode visible through their configuration object. Production and
   * staging never receive this compatibility default.
   */
  readonly defaultLegacyForDevelopment?: boolean;
  readonly clock?: () => Date;
}

/**
 * Shared fail-closed loader used by every process that opens the runtime.
 * Keeping file safety, trust parsing and signature verification here prevents
 * API and worker processes from drifting into different consent authorities.
 */
export function loadConsentPolicyRuntimeOptions(
  input: ConsentPolicyConfigurationInput,
): ConsentPolicyRuntimeOptions {
  const { environment } = input;
  const catalogFile = environment.LTM_CONSENT_POLICY_CATALOG_FILE?.trim();
  const trustJson = environment.LTM_CONSENT_POLICY_TRUST_KEYS_JSON?.trim();
  const jurisdiction = environment.LTM_CONSENT_POLICY_JURISDICTION?.trim();
  const locale = environment.LTM_CONSENT_POLICY_LOCALE?.trim();
  const legacyValue = environment.LTM_ALLOW_LEGACY_CONSENT_POLICY;
  if (legacyValue !== undefined && legacyValue !== "true" && legacyValue !== "false") {
    throw configuration("LTM_ALLOW_LEGACY_CONSENT_POLICY must be true or false");
  }
  const developmentDefault = input.defaultLegacyForDevelopment === true &&
    (input.applicationEnvironment === "local" || input.applicationEnvironment === "development" ||
      input.applicationEnvironment === "test");
  const allowLegacyConsentPolicy = legacyValue === "true" ||
    (legacyValue === undefined && developmentDefault);
  if (allowLegacyConsentPolicy &&
      (input.applicationEnvironment === "production" || input.applicationEnvironment === "staging")) {
    throw configuration("Legacy consent policy mode is forbidden in staging and production");
  }
  const supplied = [catalogFile, trustJson, jurisdiction, locale]
    .filter((value) => value !== undefined).length;
  if (supplied !== 0 && supplied !== 4) {
    throw configuration(
      "Consent policy catalog file, trust keys JSON, jurisdiction, and locale must be configured together",
    );
  }
  if (supplied === 0) {
    if (input.applicationEnvironment === "production") {
      throw configuration(
        "Production requires LTM_CONSENT_POLICY_CATALOG_FILE, trust keys, jurisdiction, and locale",
      );
    }
    return allowLegacyConsentPolicy ? { allowLegacyConsentPolicy: true } : {};
  }
  if (allowLegacyConsentPolicy) {
    throw configuration("Legacy consent policy mode cannot accompany a signed catalog");
  }
  const path = resolveProductPath(catalogFile as string, input.productRoot);
  const catalogValue = readBoundedJsonFile(path, "LTM_CONSENT_POLICY_CATALOG_FILE", 2 * 1_024 * 1_024);
  const trustedConsentPolicyKeys = parseTrustedConsentPolicyKeys(trustJson);
  const verified = verifyConsentPolicyCatalog(
    catalogValue,
    trustedConsentPolicyKeys,
    input.evidenceEnvironment,
    (input.clock?.() ?? new Date()).toISOString(),
  );
  return {
    consentPolicyCatalog: verified.document,
    trustedConsentPolicyKeys,
    consentPolicyJurisdiction: visibleValue(jurisdiction as string, "LTM_CONSENT_POLICY_JURISDICTION", 32),
    consentPolicyLocale: visibleValue(locale as string, "LTM_CONSENT_POLICY_LOCALE", 16),
  };
}

function parseTrustedConsentPolicyKeys(serialized: string | undefined): readonly TrustedConsentPolicyKey[] {
  if (serialized === undefined || serialized.trim().length === 0) {
    throw configuration("LTM_CONSENT_POLICY_TRUST_KEYS_JSON is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw configuration("LTM_CONSENT_POLICY_TRUST_KEYS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw configuration("Consent policy trust must contain one to 100 keys");
  }
  return parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw configuration("Each consent policy trust key must be an object");
    }
    const record = value as Record<string, unknown>;
    const allowedFields = new Set([
      "keyId", "issuer", "algorithm", "publicKeyPem", "allowedEnvironments", "notBefore", "notAfter", "revokedAt",
    ]);
    if (Object.keys(record).some((field) => !allowedFields.has(field))) {
      throw configuration("Consent policy trust key contains an unsupported field");
    }
    return {
      keyId: requiredString(record.keyId, "consent policy keyId", 128),
      issuer: requiredString(record.issuer, "consent policy issuer", 128),
      algorithm: enumValue(record.algorithm, "consent policy algorithm", ["Ed25519"] as const),
      publicKeyPem: requiredPem(record.publicKeyPem),
      allowedEnvironments: enumList(
        record.allowedEnvironments,
        "consent policy allowedEnvironments",
        ["sandbox", "staging", "production"] as const,
      ),
      notBefore: requiredString(record.notBefore, "consent policy notBefore", 64),
      notAfter: requiredString(record.notAfter, "consent policy notAfter", 64),
      ...(record.revokedAt === undefined || record.revokedAt === null
        ? {}
        : { revokedAt: requiredString(record.revokedAt, "consent policy revokedAt", 64) }),
    };
  });
}

function readBoundedJsonFile(path: string, label: string, maximumBytes: number): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      throw configuration(`${label} must be a bounded regular file`);
    }
    const serialized = readFileSync(descriptor, { encoding: "utf8" });
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw configuration(`${label} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CONFIGURATION_INVALID", `${label} could not be read as bounded JSON`, {
      details: { cause: error instanceof Error ? error.name : "unknown" },
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveProductPath(value: string, productRoot: string): string {
  return resolve(isAbsolute(value) ? value : resolve(productRoot, value));
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw configuration(`${label} must be a string`);
  return visibleValue(value.trim(), label, maximum);
}

function visibleValue(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw configuration(`${label} is invalid`);
  }
  return value;
}

function requiredPem(value: unknown): string {
  if (typeof value !== "string" || value.length < 80 || value.length > 8_192 || !value.includes("BEGIN PUBLIC KEY")) {
    throw configuration("publicKeyPem must be a PEM public key");
  }
  return value;
}

function enumList<T extends string>(value: unknown, label: string, allowed: readonly T[]): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !allowed.includes(item as T))) {
    throw configuration(`${label} contains an unsupported value`);
  }
  const result = value as T[];
  if (new Set(result).size !== result.length) throw configuration(`${label} must not contain duplicates`);
  return [...result];
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw configuration(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function configuration(message: string): DomainError {
  return new DomainError("CONFIGURATION_INVALID", message);
}
