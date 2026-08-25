import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  resolveConsentPolicy,
  signConsentPolicyCatalog,
  verifyConsentPolicyCatalog,
} from "../dist/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustKey = {
  keyId: "consent-policy-key-1",
  issuer: "privacy-office",
  algorithm: "Ed25519",
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedEnvironments: ["production"],
  notBefore: "2026-01-01T00:00:00.000Z",
  notAfter: "2028-01-01T00:00:00.000Z",
  revokedAt: null,
};

function catalog() {
  return signConsentPolicyCatalog({
    schemaVersion: "ltm.consent-policy-catalog.v1",
    catalogId: "catalog-2026-08",
    issuer: "privacy-office",
    environment: "production",
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    algorithm: "Ed25519",
    keyId: "consent-policy-key-1",
    policies: [{
      policyVersion: "age-transform-cn-v1",
      purpose: "age_transformation",
      locale: "zh-CN",
      jurisdictions: ["CN"],
      resourceKinds: ["media.asset"],
      allowedActions: ["ingest", "transform"],
      grantorCapacities: ["guardian", "self"],
      minorApplicability: "all",
      disclosureSha256: "a".repeat(64),
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      maxConsentLifetimeSeconds: 2_592_000,
    }],
  }, privateKey.export({ type: "pkcs8", format: "pem" }));
}

test("signed consent policy catalog resolves the exact server-side disclosure and bounded expiry", () => {
  const verified = verifyConsentPolicyCatalog(
    catalog(),
    [trustKey],
    "production",
    "2026-08-24T00:00:00.000Z",
  );
  const resolved = resolveConsentPolicy(verified, {
    policyVersion: "age-transform-cn-v1",
    purpose: "age_transformation",
    jurisdiction: "CN",
    locale: "zh-CN",
    scope: { resource: "media.asset:asset-1", actions: ["ingest", "transform"] },
    grantorCapacity: "self",
    isMinor: false,
    requestedExpiresAt: null,
    participantExpiresAt: "2027-06-01T00:00:00.000Z",
    at: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(resolved.disclosureSha256, "a".repeat(64));
  assert.equal(resolved.expiresAt, "2026-09-23T00:00:00.000Z");
  assert.match(resolved.catalogSha256, /^[a-f0-9]{64}$/);
});

test("catalog verification and resolution fail closed for tampering, ambiguity, or scope drift", () => {
  const signed = catalog();
  const tampered = structuredClone(signed);
  tampered.policies[0].disclosureSha256 = "b".repeat(64);
  assert.throws(
    () => verifyConsentPolicyCatalog(tampered, [trustKey], "production", "2026-08-24T00:00:00.000Z"),
    (error) => error?.code === "CONFIGURATION_INVALID",
  );
  const verified = verifyConsentPolicyCatalog(signed, [trustKey], "production", "2026-08-24T00:00:00.000Z");
  for (const drift of [
    { jurisdiction: "US" },
    { locale: "en-US" },
    { purpose: "marketing" },
    { scope: { resource: "media.asset:asset-1", actions: ["delete"] } },
    { grantorCapacity: "authorized_agent" },
  ]) {
    assert.throws(() => resolveConsentPolicy(verified, {
      policyVersion: "age-transform-cn-v1",
      purpose: "age_transformation",
      jurisdiction: "CN",
      locale: "zh-CN",
      scope: { resource: "media.asset:asset-1", actions: ["transform"] },
      grantorCapacity: "self",
      isMinor: false,
      requestedExpiresAt: "2026-09-01T00:00:00.000Z",
      participantExpiresAt: "2027-06-01T00:00:00.000Z",
      at: "2026-08-24T00:00:00.000Z",
      ...drift,
    }), (error) => error?.code === "CONSENT_REQUIRED");
  }
});
