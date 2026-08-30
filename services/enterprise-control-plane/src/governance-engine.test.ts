import assert from "node:assert/strict";
import { test } from "node:test";
import { EnterpriseControlError } from "./common.js";
import { EnterpriseGovernanceEngine } from "./governance-engine.js";
import { ACTOR, APPROVERS, HASH, HASH2, fact, makeHarness } from "./test-fixtures.js";

function schema(engine: EnterpriseGovernanceEngine): void {
  engine.registerConfigurationSchema(ACTOR, { schemaId: "platform", version: "v1", idempotencyKey: "schema", fields: [
    { key: "consent.required", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "safety.enabled", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "aiLabel.required", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "children.protectionEnabled", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "highImpactDecisioning.disabled", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "provenance.required", type: "boolean", required: true, tenantOverridable: false, highRisk: true, protected: true },
    { key: "worker.concurrency", type: "integer", required: true, minimum: 1, maximum: 100, tenantOverridable: true, highRisk: true, protected: false },
  ] });
}
function baseValues(concurrency = 10): Record<string, boolean | number> { return { "consent.required": true, "safety.enabled": true, "aiLabel.required": true, "children.protectionEnabled": true, "highImpactDecisioning.disabled": true, "provenance.required": true, "worker.concurrency": concurrency }; }
function topology(engine: EnterpriseGovernanceEngine): void {
  const planes = (suffix: string) => ({ control: `control-${suffix}`, media: `media-${suffix}`, objectStorage: `object-${suffix}`, database: `db-${suffix}`, queue: `queue-${suffix}`, analytics: `analytics-${suffix}`, logs: `logs-${suffix}` });
  engine.registerRegionalTopology(ACTOR, { topologyId: "topology", version: "v1", idempotencyKey: "topology", regions: [
    { region: "cn-east", jurisdiction: "CN", planes: planes("cn"), allowedClassifications: ["personal"] },
    { region: "sg", jurisdiction: "SG", planes: planes("sg"), allowedClassifications: ["personal"] },
  ], flows: [{ from: "cn-east", to: "sg", classification: "personal", purpose: "contract-backup", encrypted: true, approvalId: "approval-1" }] });
}

test("B119-R01 resolves typed layered versioned configuration and records rollback", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); schema(engine);
  engine.publishConfigurationLayer(ACTOR, { schemaId: "platform", schemaVersion: "v1", layer: "code", scope: "global", version: 1, values: baseValues(), effectiveAt: "2026-08-28T00:00:00.000Z", expiresAt: null, rollbackVersion: null, idempotencyKey: "layer-code" });
  engine.publishConfigurationLayer(ACTOR, { schemaId: "platform", schemaVersion: "v1", layer: "environment", scope: "production", version: 2, values: { "worker.concurrency": 20 }, effectiveAt: "2026-08-28T00:00:00.000Z", expiresAt: null, rollbackVersion: 1, idempotencyKey: "layer-env" });
  const resolved = engine.resolveConfiguration({ tenantId: ACTOR.tenantId, schemaId: "platform", schemaVersion: "v1", environment: "production", region: "cn-east", at: "2026-08-28T08:00:00.000Z" });
  assert.equal((resolved.values as Record<string, unknown>)["worker.concurrency"], 20); assert.equal((resolved.appliedLayers as unknown[]).length, 2); h.repository.close();
});

test("B119-R02 accepts only opaque manager references with workload identity", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  assert.throws(() => engine.registerSecretBinding(ACTOR, { bindingId: "bad", environment: "production", workloadIdentity: "workload-identity://api", secretReference: "token=plaintext", consumers: ["api"], expiresAt: "2027-01-01T00:00:00.000Z", rotationIntervalDays: 30, lastRotatedAt: "2026-08-01T00:00:00.000Z", idempotencyKey: "bad" }), EnterpriseControlError);
  const saved = engine.registerSecretBinding(ACTOR, { bindingId: "good", environment: "production", workloadIdentity: "workload-identity://api", secretReference: "secret-manager://production/api", consumers: ["api"], expiresAt: "2027-01-01T00:00:00.000Z", rotationIntervalDays: 30, lastRotatedAt: "2026-08-01T00:00:00.000Z", idempotencyKey: "good" }); assert.equal(saved.secretMaterialStored, false); h.repository.close();
});

test("B119-R03 protected controls cannot be disabled or tenant-overridden", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); schema(engine);
  assert.throws(() => engine.publishConfigurationLayer(ACTOR, { schemaId: "platform", schemaVersion: "v1", layer: "tenant", scope: ACTOR.tenantId, version: 1, values: { "consent.required": false }, effectiveAt: "2026-08-28T00:00:00.000Z", expiresAt: null, rollbackVersion: null, idempotencyKey: "protected" }), /tenant cannot override|cannot be disabled/); h.repository.close();
});

test("B119-R04 enforces independent two-person canary and automatic rollback", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); schema(engine);
  engine.proposeHighRiskConfiguration(ACTOR, { changeId: "change-1", schemaId: "platform", schemaVersion: "v1", targetLayer: "environment", targetScope: "production", patch: { "worker.concurrency": 80 }, previewAffectedTenants: [ACTOR.tenantId], previewRiskCodes: ["queue-saturation"], rollbackVersion: 1, idempotencyKey: "propose" });
  engine.approveConfigurationCanary(ACTOR, { changeId: "change-1", approverIds: APPROVERS, canaryBasisPoints: 500, healthBudgetSha256: HASH, idempotencyKey: "approve" });
  const rolled = engine.evaluateConfigurationCanary(ACTOR, { changeId: "change-1", observedBudgetSha256: HASH2, healthy: true, reason: "budget mismatch", idempotencyKey: "evaluate" }); assert.equal(rolled.state, "rolled_back"); assert.equal(rolled.automaticallyRolledBack, true); h.repository.close();
});

test("B119-R05 reports drift expiration environment unused and rotation findings", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); schema(engine);
  engine.publishConfigurationLayer(ACTOR, { schemaId: "platform", schemaVersion: "v1", layer: "code", scope: "global", version: 1, values: baseValues(), effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: null, rollbackVersion: null, idempotencyKey: "layer" });
  engine.registerSecretBinding(ACTOR, { bindingId: "old", environment: "staging", workloadIdentity: "workload-identity://worker", secretReference: "kms://staging/worker", consumers: ["retired-worker"], expiresAt: "2026-08-01T00:00:00.000Z", rotationIntervalDays: 30, lastRotatedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "old-secret" });
  const result = engine.configurationHygiene({ tenantId: ACTOR.tenantId, expectedLayerDigests: { "code:global": HASH }, activeConsumers: ["api"], environment: "production", at: "2026-08-28T08:00:00.000Z" }); const categories = new Set((result.findings as Array<Record<string, unknown>>).map((finding) => finding.category));
  for (const category of ["configuration_drift", "expired_credential", "wrong_environment_reference", "unused_secret", "rotation_overdue"]) assert(categories.has(category)); h.repository.close();
});

test("B120-R01 requires all seven regional planes and encrypted allowed flows", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  assert.throws(() => engine.registerRegionalTopology(ACTOR, { topologyId: "bad", version: "v1", idempotencyKey: "bad-topology", regions: [{ region: "cn", jurisdiction: "CN", planes: { control: "c", media: "m", objectStorage: "o", database: "d", queue: "q", analytics: "a" } as never, allowedClassifications: ["personal"] }], flows: [] }), /closed contract/); topology(engine); assert.equal(engine.routeRegionalRequest({ tenantId: ACTOR.tenantId, topologyId: "topology", userRegion: "cn-east", tenantRegion: "cn-east", contractRegions: ["cn-east"], dataResidenceRegion: "cn-east", classification: "personal" }).crossRegion, false); h.repository.close();
});

test("B120-R02 blocks unknown or conflicting residence and contract routing", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); topology(engine);
  assert.throws(() => engine.routeRegionalRequest({ tenantId: ACTOR.tenantId, topologyId: "topology", userRegion: "sg", tenantRegion: "cn-east", contractRegions: ["cn-east"], dataResidenceRegion: "cn-east", classification: "personal" }), /unknown or conflicting/); h.repository.close();
});

test("B120-R03 enforces derived-only short TTL CDN revoke and signed purge", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  engine.issueCdnGrant(ACTOR, { grantId: "grant-1", assetId: "asset-1", assetClassification: "authorized_derived_media", region: "cn-east", regionalSigningKeyReference: "kms://cn-east/cdn", tokenBindingSha256: HASH, expiresAt: "2026-08-28T08:10:00.000Z", idempotencyKey: "grant" }); engine.revokeCdnGrant(ACTOR, { grantId: "grant-1", reason: "consent withdrawn", idempotencyKey: "revoke" });
  const purged = engine.applyCdnPurgeAttestation(ACTOR, fact("cdn.purge", "grant-1", { grantId: "grant-1", assetId: "asset-1", region: "cn-east", purged: true, edgeCount: 12, purgeRequestId: "purge-1" }), "purge"); assert.equal(purged.state, "revoked_purged"); h.repository.close();
});

test("B120-R04 records managed domain DNS certificate WAF origin and takeover protection", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock });
  const domain = engine.registerDomain(ACTOR, { domainId: "domain-1", hostname: "memories.example.com", ownerTenantId: ACTOR.tenantId, dnsZoneReference: "dns://production/example", certificateReference: "cert://production/example", certificateExpiresAt: "2027-01-01T00:00:00.000Z", wafPolicyId: "waf-1", originIdentityReference: "workload-identity://cdn-origin", ownershipChallengeSha256: HASH, whiteLabel: true, idempotencyKey: "domain" }); assert.equal(domain.takeoverProtection, true); assert.equal(domain.runtimeCertification, "NOT_CERTIFIED"); h.repository.close();
});

test("B120-R05 binds replication to approved flow and keeps test evidence non-production", () => {
  const h = makeHarness(); const engine = new EnterpriseGovernanceEngine({ repository: h.repository, attestationVerifier: h.verifier, clock: h.clock }); topology(engine);
  engine.authorizeRegionalReplication(ACTOR, { replicationId: "replication-1", topologyId: "topology", sourceRegion: "cn-east", destinationRegion: "sg", classification: "personal", purpose: "contract-backup", encryptionKeyReference: "kms://sg/replication", retentionDays: 30, approverIds: APPROVERS, idempotencyKey: "replication" });
  const verified = engine.certifyRegionalRuntime(ACTOR, fact("regional.runtime", "replication-1", { replicationId: "replication-1", topologyVersion: "v1", sourceRegion: "cn-east", destinationRegion: "sg", classification: "personal", encrypted: true, purposeEnforced: true, runtimeEvidenceSha256: HASH }, true), "regional-fact"); assert.equal(verified.runtimeCertification, "TEST_VERIFIED"); h.repository.close();
});
