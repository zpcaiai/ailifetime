import { generateKeyPairSync } from "node:crypto";
import type { CommercialActor, JsonObject } from "./common.js";
import { FinanceOperationsEngine } from "./finance-engine.js";
import {
  CommercialFactVerifier,
  signCommercialFact,
  type CommercialFactTrustKey,
  type SignedCommercialFact,
} from "./signed-facts.js";
import { SqliteCommercialOperationsRepository } from "./store.js";
import { SupplyOperationsEngine } from "./supply-engine.js";

export const TEST_NOW = new Date("2026-08-28T12:00:00.000Z");
export const TEST_DIGEST = "a".repeat(64);
export const TEST_DIGEST_B = "b".repeat(64);

const authorities = Object.freeze({
  "payment:stripe": ["payment.statement"],
  "bank:main": ["bank.statement"],
  "tax:platform": ["tax.document"],
  "revenue:milestone": ["revenue.milestone"],
  "payment:chargeback": ["payment.dispute", "payment.dispute.decision"],
  "bank:payout": ["partner.bank-account", "partner.payout"],
  "vendor:cost": ["cost.vendor"],
  "erp:main": ["accounting.export-ack"],
  "vendor:v1": ["vendor.capacity", "vendor.job", "vendor.job-cancelled", "claim.recovery"],
  "vendor:v2": ["vendor.capacity", "vendor.job", "vendor.job-cancelled", "claim.recovery"],
  "carrier:c1": ["carrier.rate", "carrier.label", "carrier.tracking", "claim.recovery"],
  "inventory:v1": ["inventory.adjustment"],
  "platform:quality": ["quality.observation", "quality.capa-retest", "quality.cleanup"],
} as const);

export interface CommercialTestFixture {
  readonly repository: SqliteCommercialOperationsRepository;
  readonly finance: FinanceOperationsEngine;
  readonly supply: SupplyOperationsEngine;
  readonly actor: CommercialActor;
  readonly reviewer: CommercialActor;
  readonly approver: CommercialActor;
  readonly fact: (provider: keyof typeof authorities, kind: string, subjectId: string, payload: JsonObject, sequence?: number, factId?: string) => SignedCommercialFact;
}

export function commercialTestFixture(): CommercialTestFixture {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keys: CommercialFactTrustKey[] = Object.entries(authorities).map(([provider, kinds]) => ({
    issuer: "ltm-test-authority",
    provider,
    keyId: `key-${provider.replace(/:/g, "-")}`,
    publicKeyPem,
    allowedEnvironments: ["test"],
    allowedFactKinds: kinds,
    allowedTenantIds: ["tenant-a"],
  }));
  const repository = new SqliteCommercialOperationsRepository(":memory:", () => TEST_NOW);
  const verifier = new CommercialFactVerifier({ keys, environment: "test", clock: () => TEST_NOW });
  let counter = 0;
  const fact = (provider: keyof typeof authorities, kind: string, subjectId: string, payload: JsonObject, sequence = 1, factId?: string): SignedCommercialFact => {
    counter += 1;
    return signCommercialFact({
      version: "ltm.commercial-fact.v1", factId: factId ?? `fact-${counter}`, tenantId: "tenant-a",
      issuer: "ltm-test-authority", provider, environment: "test", factKind: kind, subjectId,
      occurredAt: "2026-08-28T11:00:00Z", sequence, payload, algorithm: "Ed25519",
      keyId: `key-${provider.replace(/:/g, "-")}`,
    }, privateKeyPem);
  };
  return {
    repository,
    finance: new FinanceOperationsEngine({ repository, factVerifier: verifier, clock: () => TEST_NOW }),
    supply: new SupplyOperationsEngine({ repository, factVerifier: verifier, clock: () => TEST_NOW }),
    actor: { tenantId: "tenant-a", actorId: "operator", roles: ["finance_operator", "supply_operator", "platform_admin"], purpose: "commercial-test", stepUp: true, reason: "requirement-test" },
    reviewer: { tenantId: "tenant-a", actorId: "reviewer", roles: ["finance_admin", "vendor_manager", "quality_manager", "platform_admin", "auditor"], purpose: "commercial-review", stepUp: true, reason: "requirement-test" },
    approver: { tenantId: "tenant-a", actorId: "approver", roles: ["customer", "studio", "partner", "internal_approver"], purpose: "proof-approval", stepUp: true, reason: "requirement-test" },
    fact,
  };
}
