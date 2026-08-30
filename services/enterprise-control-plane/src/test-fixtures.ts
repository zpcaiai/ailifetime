import { generateKeyPairSync } from "node:crypto";
import { EnterpriseAttestationVerifier, signEnterpriseAttestation, type SignedEnterpriseAttestation } from "./attestation.js";
import { sha256, type EnterpriseActor, type JsonObject } from "./common.js";
import { SqliteEnterpriseRepository } from "./store.js";

export const NOW = "2026-08-28T08:00:00.000Z";
export const HASH = sha256("enterprise-test-artifact");
export const HASH2 = sha256("enterprise-test-artifact-2");
export const APPROVERS = ["approver-a", "approver-b"] as const;
export const ACTOR: EnterpriseActor = {
  tenantId: "tenant-enterprise", actorId: "executor", purpose: "enterprise-control-test", ticketId: "CHG-119", stepUp: true,
  roles: ["platform_admin", "security_admin", "configuration_admin", "regional_operator", "reliability_engineer", "capacity_operator", "compliance_admin", "privacy_officer", "legal_operator", "release_manager"],
};

const generalKeys = generateKeyPairSync("ed25519");
const independentKeys = generateKeyPairSync("ed25519");
const generalPrivate = generalKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const independentPrivate = independentKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FACT_KINDS = [
  "cdn.purge", "regional.runtime", "resilience.game-day", "security.build-provenance", "security.scan-matrix", "security.dast",
  "security.pentest", "security.finding-retest", "compliance.legal-filing", "compliance.evidence-collection", "compliance.recertification",
] as const;
const INDEPENDENT_ROLES: Partial<Record<typeof FACT_KINDS[number], string>> = {
  "regional.runtime": "independent-regional-runtime-authority",
  "resilience.game-day": "independent-resilience-authority",
  "security.pentest": "independent-pentest-authority",
  "security.finding-retest": "independent-security-retest-authority",
  "compliance.legal-filing": "regulatory-filing-authority",
  "compliance.recertification": "independent-compliance-authority",
};
let sequence = 0;

export function makeHarness(): { repository: SqliteEnterpriseRepository; verifier: EnterpriseAttestationVerifier; clock: () => Date } {
  const clock = (): Date => new Date(NOW);
  const verifier = new EnterpriseAttestationVerifier({ environment: "test", clock, authorities: [
    { issuer: "enterprise-ci", issuerRole: "enterprise-evidence-authority", keyId: "general-test-key", publicKeyPem: generalKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), environments: ["test"], factKinds: FACT_KINDS, tenantIds: [ACTOR.tenantId], independent: false },
    ...Object.entries(INDEPENDENT_ROLES).map(([kind, role]) => ({ issuer: "independent-assessor", issuerRole: role, keyId: "independent-test-key", publicKeyPem: independentKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), environments: ["test" as const], factKinds: [kind], tenantIds: [ACTOR.tenantId], independent: true })),
  ] });
  return { repository: new SqliteEnterpriseRepository(":memory:", clock), verifier, clock };
}

export function fact(kind: typeof FACT_KINDS[number], subjectId: string, payload: JsonObject, independent = false): SignedEnterpriseAttestation {
  sequence += 1;
  const issuerRole = independent ? INDEPENDENT_ROLES[kind] : "enterprise-evidence-authority"; if (issuerRole === undefined) throw new Error(`${kind} has no independent test authority`);
  return signEnterpriseAttestation({ version: "ltm.enterprise-attestation.v1", factId: `fact-${sequence}`, tenantId: ACTOR.tenantId, issuer: independent ? "independent-assessor" : "enterprise-ci", issuerRole, environment: "test", factKind: kind, subjectId, sequence, occurredAt: "2026-08-28T07:59:00.000Z", expiresAt: "2026-08-29T08:00:00.000Z", payload, algorithm: "Ed25519", keyId: independent ? "independent-test-key" : "general-test-key" }, independent ? independentPrivate : generalPrivate);
}
