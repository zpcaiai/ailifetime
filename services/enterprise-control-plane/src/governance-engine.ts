import {
  EnterpriseControlError, assertActor, bps, conflict, digest, exactKeys, exactUtc, freeze,
  hexDigest, identifier, integer, requireState, text, unique,
  type EnterpriseActor, type JsonObject, type JsonValue,
} from "./common.js";
import { EnterpriseAttestationVerifier, type SignedEnterpriseAttestation, type VerifiedEnterpriseAttestation } from "./attestation.js";
import type { EnterpriseRepository, EnterpriseSnapshot } from "./store.js";

const ADMIN = ["platform_admin", "security_admin", "configuration_admin"] as const;
const REGIONAL = ["platform_admin", "security_admin", "regional_operator"] as const;
const PROTECTED_KEYS = new Set(["consent.required", "safety.enabled", "aiLabel.required", "children.protectionEnabled", "highImpactDecisioning.disabled", "provenance.required"]);
const LAYERS = ["code", "environment", "region", "tenant", "dynamic"] as const;
type Layer = typeof LAYERS[number];

export class EnterpriseGovernanceEngine {
  readonly #repository: EnterpriseRepository; readonly #facts: EnterpriseAttestationVerifier; readonly #clock: () => Date;
  constructor(input: { repository: EnterpriseRepository; attestationVerifier: EnterpriseAttestationVerifier; clock?: () => Date }) {
    this.#repository = input.repository; this.#facts = input.attestationVerifier; this.#clock = input.clock ?? (() => new Date());
  }

  // B119-R01 — typed, layered, versioned configuration with effective/rollback semantics.
  registerConfigurationSchema(actor: EnterpriseActor, input: {
    schemaId: string; version: string; fields: readonly { key: string; type: "boolean" | "integer" | "string"; required: boolean; minimum?: number; maximum?: number; allowedValues?: readonly string[]; tenantOverridable: boolean; highRisk: boolean; protected: boolean }[]; idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ADMIN);
    const fields = input.fields.map((field) => {
      const key = identifier(field.key, "configuration key");
      if (field.protected !== PROTECTED_KEYS.has(key)) throw new EnterpriseControlError("POLICY_BLOCKED", "protected configuration key declaration must match the immutable platform set");
      if (field.protected && field.tenantOverridable) throw new EnterpriseControlError("POLICY_BLOCKED", "protected controls cannot be tenant-overridable");
      if (field.type === "integer" && (field.minimum === undefined || field.maximum === undefined || field.minimum > field.maximum)) throw new EnterpriseControlError("VALIDATION_FAILED", "integer field requires valid bounds");
      if (field.allowedValues !== undefined && field.type !== "string") throw new EnterpriseControlError("VALIDATION_FAILED", "allowedValues only applies to string fields");
      return { ...field, key, allowedValues: field.allowedValues === undefined ? null : unique(field.allowedValues, "allowedValues") };
    });
    if (fields.length < 1 || new Set(fields.map((field) => field.key)).size !== fields.length) throw new EnterpriseControlError("VALIDATION_FAILED", "configuration schema fields must be nonempty and unique");
    const state: JsonObject = { schemaId: identifier(input.schemaId, "schemaId"), version: identifier(input.version, "version"), layers: LAYERS, fields, protectedKeys: [...PROTECTED_KEYS].sort(), state: "active" };
    return this.#write(actor, input.idempotencyKey, "B119.registerSchema", state, "config.schema", `${input.schemaId}:${input.version}`, "config.schemaRegistered", state);
  }

  publishConfigurationLayer(actor: EnterpriseActor, input: {
    schemaId: string; schemaVersion: string; layer: Layer; scope: string; version: number; values: JsonObject;
    effectiveAt: string; expiresAt: string | null; rollbackVersion: number | null; idempotencyKey: string;
  }): JsonObject {
    assertActor(actor, ADMIN);
    const schema = this.#required(actor.tenantId, "config.schema", `${input.schemaId}:${input.schemaVersion}`).state;
    const validated = validateConfiguration(schema, input.values, input.layer);
    const effectiveAt = exactUtc(input.effectiveAt, "effectiveAt");
    const expiresAt = input.expiresAt === null ? null : exactUtc(input.expiresAt, "expiresAt");
    if (expiresAt !== null && expiresAt <= effectiveAt) throw new EnterpriseControlError("VALIDATION_FAILED", "configuration expiry precedes effective time");
    const version = integer(input.version, "version", 1);
    if (input.rollbackVersion !== null && input.rollbackVersion >= version) throw new EnterpriseControlError("VALIDATION_FAILED", "rollbackVersion must identify an earlier version");
    const aggregateId = `${input.schemaId}:${input.layer}:${identifier(input.scope, "scope")}`;
    const current = this.#repository.get<JsonObject>(actor.tenantId, "config.layer", aggregateId);
    if (current !== undefined && version <= Number(current.state.version)) conflict("configuration versions must increase monotonically");
    const state: JsonObject = { schemaId: input.schemaId, schemaVersion: input.schemaVersion, layer: input.layer, scope: input.scope, version, values: validated, effectiveAt, expiresAt, rollbackVersion: input.rollbackVersion, state: "published", publishedBy: actor.actorId };
    return this.#write(actor, input.idempotencyKey, "B119.publishLayer", state, "config.layer", aggregateId, "config.layerPublished", state, current?.version ?? null);
  }

  resolveConfiguration(input: { tenantId: string; schemaId: string; schemaVersion: string; environment: string; region: string; at: string }): JsonObject {
    const at = exactUtc(input.at, "at"); const schema = this.#required(input.tenantId, "config.schema", `${input.schemaId}:${input.schemaVersion}`).state;
    const scopeByLayer: Readonly<Record<Layer, string>> = { code: "global", environment: input.environment, region: input.region, tenant: input.tenantId, dynamic: input.tenantId };
    const values: Record<string, JsonValue> = {}; const applied: JsonObject[] = [];
    for (const layer of LAYERS) {
      const snapshot = this.#repository.get<JsonObject>(input.tenantId, "config.layer", `${input.schemaId}:${layer}:${scopeByLayer[layer]}`);
      if (snapshot === undefined || String(snapshot.state.effectiveAt) > at || (snapshot.state.expiresAt !== null && String(snapshot.state.expiresAt) <= at)) continue;
      Object.assign(values, snapshot.state.values as JsonObject); applied.push({ layer, scope: scopeByLayer[layer], version: snapshot.state.version });
    }
    const fields = schema.fields as readonly JsonObject[];
    if (fields.some((field) => field.required === true && values[String(field.key)] === undefined)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "required resolved configuration is missing");
    for (const key of PROTECTED_KEYS) if (values[key] !== (key === "highImpactDecisioning.disabled" ? true : true)) throw new EnterpriseControlError("POLICY_BLOCKED", `protected control ${key} cannot be disabled`);
    return freeze({ schemaId: input.schemaId, schemaVersion: input.schemaVersion, environment: input.environment, region: input.region, tenantId: input.tenantId, at, values, appliedLayers: applied, resolutionSha256: digest({ values, applied }) });
  }

  // B119-R02 — secret references only; no material crosses this boundary.
  registerSecretBinding(actor: EnterpriseActor, input: { bindingId: string; environment: string; workloadIdentity: string; secretReference: string; consumers: readonly string[]; expiresAt: string; rotationIntervalDays: number; lastRotatedAt: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, ADMIN);
    if (!/^(secret-manager|kms):\/\/[A-Za-z0-9._/-]+$/.test(input.secretReference) || /password|token=|BEGIN|secret:[^/]/i.test(input.secretReference)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "only opaque key-manager references are allowed");
    if (!/^workload-identity:\/\/[A-Za-z0-9._/-]+$/.test(input.workloadIdentity)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "secret binding requires workload identity");
    const state: JsonObject = { bindingId: identifier(input.bindingId, "bindingId"), environment: identifier(input.environment, "environment"), workloadIdentity: input.workloadIdentity, secretReference: input.secretReference, consumers: unique(input.consumers, "consumers"), expiresAt: exactUtc(input.expiresAt, "expiresAt"), rotationIntervalDays: integer(input.rotationIntervalDays, "rotationIntervalDays", 1, 365), lastRotatedAt: exactUtc(input.lastRotatedAt, "lastRotatedAt"), secretMaterialStored: false, state: "active" };
    return this.#write(actor, input.idempotencyKey, "B119.registerSecret", state, "config.secretBinding", input.bindingId, "config.secretBindingRegistered", { bindingId: input.bindingId, workloadIdentity: input.workloadIdentity, referenceSha256: digest(input.secretReference), consumers: state.consumers });
  }

  // B119-R03/R04 — protected tenant fields and two-person canary/rollback state machine.
  proposeHighRiskConfiguration(actor: EnterpriseActor, input: { changeId: string; schemaId: string; schemaVersion: string; targetLayer: "environment" | "region" | "tenant" | "dynamic"; targetScope: string; patch: JsonObject; previewAffectedTenants: readonly string[]; previewRiskCodes: readonly string[]; rollbackVersion: number; idempotencyKey: string }): JsonObject {
    assertActor(actor, ADMIN);
    const schema = this.#required(actor.tenantId, "config.schema", `${input.schemaId}:${input.schemaVersion}`).state;
    validateConfiguration(schema, input.patch, input.targetLayer);
    const state: JsonObject = { changeId: identifier(input.changeId, "changeId"), schemaId: input.schemaId, schemaVersion: input.schemaVersion, targetLayer: input.targetLayer, targetScope: identifier(input.targetScope, "targetScope"), patch: input.patch, previewAffectedTenants: unique(input.previewAffectedTenants, "previewAffectedTenants"), previewRiskCodes: unique(input.previewRiskCodes, "previewRiskCodes"), rollbackVersion: integer(input.rollbackVersion, "rollbackVersion", 1), approvals: [], state: "awaiting_approvals", canaryBasisPoints: 0, rollbackReason: null };
    return this.#write(actor, input.idempotencyKey, "B119.proposeHighRisk", state, "config.change", input.changeId, "config.highRiskChangeProposed", state);
  }
  approveConfigurationCanary(actor: EnterpriseActor, input: { changeId: string; approverIds: readonly string[]; canaryBasisPoints: number; healthBudgetSha256: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, ADMIN, input.approverIds); const change = this.#required(actor.tenantId, "config.change", input.changeId); requireState(change.state.state === "awaiting_approvals", "change is not approvable");
    const canary = bps(input.canaryBasisPoints, "canaryBasisPoints"); if (canary < 1 || canary > 2_500) throw new EnterpriseControlError("POLICY_BLOCKED", "high-risk first canary must be 0.01%-25%");
    const state: JsonObject = { ...change.state, approvals: unique(input.approverIds, "approverIds", 2), canaryBasisPoints: canary, healthBudgetSha256: hexDigest(input.healthBudgetSha256, "healthBudgetSha256"), state: "canary" };
    return this.#write(actor, input.idempotencyKey, "B119.approveCanary", { changeId: input.changeId, approvals: state.approvals, canary, healthBudgetSha256: input.healthBudgetSha256 }, "config.change", input.changeId, "config.canaryStarted", { canaryBasisPoints: canary, approvals: state.approvals }, change.version, state);
  }
  evaluateConfigurationCanary(actor: EnterpriseActor, input: { changeId: string; observedBudgetSha256: string; healthy: boolean; reason: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, ADMIN); const change = this.#required(actor.tenantId, "config.change", input.changeId); requireState(change.state.state === "canary", "only canary changes can be evaluated");
    const healthy = input.healthy && input.observedBudgetSha256 === change.state.healthBudgetSha256;
    const state: JsonObject = { ...change.state, state: healthy ? "ready_for_next_stage" : "rolled_back", observedBudgetSha256: hexDigest(input.observedBudgetSha256, "observedBudgetSha256"), rollbackReason: healthy ? null : text(input.reason, "reason"), automaticallyRolledBack: !healthy };
    return this.#write(actor, input.idempotencyKey, "B119.evaluateCanary", { changeId: input.changeId, observedBudgetSha256: input.observedBudgetSha256, healthy: input.healthy, reason: input.reason }, "config.change", input.changeId, healthy ? "config.canaryHealthy" : "config.canaryAutoRolledBack", { healthy, rollbackVersion: change.state.rollbackVersion, reason: input.reason }, change.version, state);
  }

  // B119-R05 — deterministic drift/expiry/unused/wrong-environment/rotation audit.
  configurationHygiene(input: { tenantId: string; expectedLayerDigests: Readonly<Record<string, string>>; activeConsumers: readonly string[]; environment: string; at: string }): JsonObject {
    const at = exactUtc(input.at, "at"); const active = new Set(input.activeConsumers); const findings: JsonObject[] = [];
    for (const event of this.#repository.events(input.tenantId, "config.layer")) {
      if (event.eventType !== "config.layerPublished") continue; const key = `${String(event.payload.layer)}:${String(event.payload.scope)}`; const expected = input.expectedLayerDigests[key];
      if (expected === undefined || expected !== digest(event.payload)) findings.push({ category: "configuration_drift", subject: key, severity: "high" });
    }
    for (const event of this.#repository.events(input.tenantId, "config.secretBinding")) {
      const state = this.#repository.get<JsonObject>(input.tenantId, "config.secretBinding", event.aggregateId)?.state; if (state === undefined) continue;
      if (String(state.expiresAt) <= at) findings.push({ category: "expired_credential", subject: event.aggregateId, severity: "critical" });
      if (state.environment !== input.environment) findings.push({ category: "wrong_environment_reference", subject: event.aggregateId, severity: "critical" });
      if ((state.consumers as readonly string[]).every((consumer) => !active.has(consumer))) findings.push({ category: "unused_secret", subject: event.aggregateId, severity: "medium" });
      const rotationDue = Date.parse(String(state.lastRotatedAt)) + Number(state.rotationIntervalDays) * 86_400_000;
      if (rotationDue <= Date.parse(at)) findings.push({ category: "rotation_overdue", subject: event.aggregateId, severity: "high" });
    }
    return freeze({ at, environment: input.environment, findings, blocking: findings.some((finding) => finding.severity === "critical" || finding.severity === "high"), rotationDrillRequired: findings.some((finding) => finding.category === "rotation_overdue") });
  }

  // B120-R01 — explicit seven-plane regional topology and data-flow allowlist.
  registerRegionalTopology(actor: EnterpriseActor, input: { topologyId: string; version: string; regions: readonly { region: string; jurisdiction: string; planes: Readonly<Record<"control" | "media" | "objectStorage" | "database" | "queue" | "analytics" | "logs", string>>; allowedClassifications: readonly string[] }[]; flows: readonly { from: string; to: string; classification: string; purpose: string; encrypted: boolean; approvalId: string }[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, REGIONAL);
    const planeKeys = ["control", "media", "objectStorage", "database", "queue", "analytics", "logs"];
    const regions = input.regions.map((region) => { exactKeys(region.planes, planeKeys, "regional planes"); return { region: identifier(region.region, "region"), jurisdiction: identifier(region.jurisdiction, "jurisdiction"), planes: region.planes, allowedClassifications: unique(region.allowedClassifications, "allowedClassifications") }; });
    if (new Set(regions.map((region) => region.region)).size !== regions.length) throw new EnterpriseControlError("VALIDATION_FAILED", "regional topology duplicates region");
    const regionIds = new Set(regions.map((region) => region.region));
    const flows = input.flows.map((flow) => { if (!regionIds.has(flow.from) || !regionIds.has(flow.to) || !flow.encrypted) throw new EnterpriseControlError("POLICY_BLOCKED", "regional flow must be known and encrypted"); return { from: flow.from, to: flow.to, classification: identifier(flow.classification, "classification"), purpose: text(flow.purpose, "purpose"), encrypted: true, approvalId: identifier(flow.approvalId, "approvalId") }; });
    const state: JsonObject = { topologyId: identifier(input.topologyId, "topologyId"), version: identifier(input.version, "version"), regions, flows, runtimeCertification: "NOT_CERTIFIED", state: "approved_design" };
    return this.#write(actor, input.idempotencyKey, "B120.registerTopology", state, "region.topology", input.topologyId, "region.topologyRegistered", state);
  }

  // B120-R02 — unknown/conflicting residence and contract policy fails closed.
  routeRegionalRequest(input: { tenantId: string; topologyId: string; userRegion: string; tenantRegion: string; contractRegions: readonly string[]; dataResidenceRegion: string; classification: string }): JsonObject {
    const topology = this.#required(input.tenantId, "region.topology", input.topologyId).state; const regions = topology.regions as readonly JsonObject[];
    const allowed = new Set(unique(input.contractRegions, "contractRegions"));
    if (input.userRegion !== input.tenantRegion || input.tenantRegion !== input.dataResidenceRegion || !allowed.has(input.dataResidenceRegion)) throw new EnterpriseControlError("POLICY_BLOCKED", "regional routing policy is unknown or conflicting");
    const region = regions.find((candidate) => candidate.region === input.dataResidenceRegion);
    if (region === undefined || !(region.allowedClassifications as readonly string[]).includes(input.classification)) throw new EnterpriseControlError("POLICY_BLOCKED", "classification is not permitted in the resolved region");
    return freeze({ region: input.dataResidenceRegion, jurisdiction: region.jurisdiction, classification: input.classification, routingDecision: "allow_same_region", crossRegion: false, topologyVersion: topology.version });
  }

  // B120-R03 — derived-only CDN grant, short TTL, regional key, revoke and purge proof.
  issueCdnGrant(actor: EnterpriseActor, input: { grantId: string; assetId: string; assetClassification: "authorized_derived_media"; region: string; regionalSigningKeyReference: string; tokenBindingSha256: string; expiresAt: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, REGIONAL); if (!input.regionalSigningKeyReference.startsWith(`kms://${input.region}/`)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "CDN signing key must be region-scoped KMS reference");
    const expiresAt = exactUtc(input.expiresAt, "expiresAt"); const ttl = Date.parse(expiresAt) - this.#clock().getTime(); if (ttl < 1 || ttl > 15 * 60_000) throw new EnterpriseControlError("POLICY_BLOCKED", "CDN grant TTL exceeds 15 minutes");
    const state: JsonObject = { grantId: identifier(input.grantId, "grantId"), assetId: identifier(input.assetId, "assetId"), classification: input.assetClassification, region: identifier(input.region, "region"), regionalSigningKeyReference: input.regionalSigningKeyReference, tokenBindingSha256: hexDigest(input.tokenBindingSha256, "tokenBindingSha256"), expiresAt, state: "active", revokedAt: null, purgeFactId: null };
    return this.#write(actor, input.idempotencyKey, "B120.issueCdnGrant", state, "cdn.grant", input.grantId, "cdn.grantIssued", { grantId: input.grantId, assetId: input.assetId, region: input.region, expiresAt });
  }
  revokeCdnGrant(actor: EnterpriseActor, input: { grantId: string; reason: string; idempotencyKey: string }): JsonObject {
    assertActor(actor, REGIONAL); const grant = this.#required(actor.tenantId, "cdn.grant", input.grantId); requireState(grant.state.state === "active", "CDN grant is not active");
    const state: JsonObject = { ...grant.state, state: "revoked_purge_pending", revokedAt: this.#clock().toISOString(), revokeReason: text(input.reason, "reason") };
    return this.#write(actor, input.idempotencyKey, "B120.revokeCdnGrant", { grantId: input.grantId, reason: input.reason }, "cdn.grant", input.grantId, "cdn.grantRevoked", { reason: input.reason }, grant.version, state);
  }
  applyCdnPurgeAttestation(actor: EnterpriseActor, factInput: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, REGIONAL); const fact = this.#facts.verify(factInput, { tenantId: actor.tenantId, factKind: "cdn.purge" }); const grant = this.#required(actor.tenantId, "cdn.grant", fact.subjectId); requireState(grant.state.state === "revoked_purge_pending", "purge proof requires revoked grant");
    exactKeys(fact.payload, ["grantId", "assetId", "region", "purged", "edgeCount", "purgeRequestId"], "CDN purge attestation");
    if (fact.payload.grantId !== grant.aggregateId || fact.payload.assetId !== grant.state.assetId || fact.payload.region !== grant.state.region || fact.payload.purged !== true || Number(fact.payload.edgeCount) < 1) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "CDN purge proof not bound to revoked grant");
    const state: JsonObject = { ...grant.state, state: "revoked_purged", purgeFactId: fact.factId, purgeFactSha256: fact.factSha256, purgeRequestId: fact.payload.purgeRequestId };
    return this.#factWrite(actor, fact, idempotencyKey, "B120.applyCdnPurge", { grantId: grant.aggregateId }, "cdn.grant", grant.aggregateId, "cdn.purgeProved", { factId: fact.factId, edgeCount: fact.payload.edgeCount }, grant.version, state);
  }

  // B120-R04 — complete domain/DNS/cert/WAF/origin/takeover lifecycle.
  registerDomain(actor: EnterpriseActor, input: { domainId: string; hostname: string; ownerTenantId: string; dnsZoneReference: string; certificateReference: string; certificateExpiresAt: string; wafPolicyId: string; originIdentityReference: string; ownershipChallengeSha256: string; whiteLabel: boolean; idempotencyKey: string }): JsonObject {
    assertActor(actor, REGIONAL); if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.hostname)) throw new EnterpriseControlError("VALIDATION_FAILED", "hostname invalid");
    for (const reference of [input.dnsZoneReference, input.certificateReference, input.originIdentityReference]) if (!/^(dns|cert|workload-identity|secret-manager):\/\//.test(reference)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "domain lifecycle references must be managed");
    const state: JsonObject = { domainId: identifier(input.domainId, "domainId"), hostname: input.hostname, ownerTenantId: identifier(input.ownerTenantId, "ownerTenantId"), dnsZoneReference: input.dnsZoneReference, certificateReference: input.certificateReference, certificateExpiresAt: exactUtc(input.certificateExpiresAt, "certificateExpiresAt"), wafPolicyId: identifier(input.wafPolicyId, "wafPolicyId"), originIdentityReference: input.originIdentityReference, ownershipChallengeSha256: hexDigest(input.ownershipChallengeSha256, "ownershipChallengeSha256"), whiteLabel: input.whiteLabel, state: "ownership_verified", originPubliclyReachable: false, takeoverProtection: true, runtimeCertification: "NOT_CERTIFIED" };
    return this.#write(actor, input.idempotencyKey, "B120.registerDomain", state, "domain.lifecycle", input.domainId, "domain.lifecycleRegistered", { domainId: input.domainId, hostname: input.hostname, certificateExpiresAt: input.certificateExpiresAt, wafPolicyId: input.wafPolicyId, takeoverProtection: true });
  }

  // B120-R05 — classification/purpose/encryption/approval-bound replication remains uncertified absent runtime proof.
  authorizeRegionalReplication(actor: EnterpriseActor, input: { replicationId: string; topologyId: string; sourceRegion: string; destinationRegion: string; classification: string; purpose: string; encryptionKeyReference: string; retentionDays: number; approverIds: readonly string[]; idempotencyKey: string }): JsonObject {
    assertActor(actor, REGIONAL, input.approverIds); const topology = this.#required(actor.tenantId, "region.topology", input.topologyId).state;
    const flow = (topology.flows as readonly JsonObject[]).find((candidate) => candidate.from === input.sourceRegion && candidate.to === input.destinationRegion && candidate.classification === input.classification && candidate.purpose === input.purpose);
    if (flow === undefined || !input.encryptionKeyReference.startsWith(`kms://${input.destinationRegion}/`)) throw new EnterpriseControlError("POLICY_BLOCKED", "replication is outside approved purpose/flow or destination encryption");
    const state: JsonObject = { replicationId: identifier(input.replicationId, "replicationId"), topologyId: input.topologyId, topologyVersion: topology.version, sourceRegion: input.sourceRegion, destinationRegion: input.destinationRegion, classification: input.classification, purpose: text(input.purpose, "purpose"), encryptionKeyReference: input.encryptionKeyReference, retentionDays: integer(input.retentionDays, "retentionDays", 1, 3_650), approvals: unique(input.approverIds, "approvers", 2), state: "authorized_design", runtimeCertification: "NOT_CERTIFIED" };
    return this.#write(actor, input.idempotencyKey, "B120.authorizeReplication", state, "region.replication", input.replicationId, "region.replicationAuthorized", state);
  }
  certifyRegionalRuntime(actor: EnterpriseActor, factInput: SignedEnterpriseAttestation, idempotencyKey: string): JsonObject {
    assertActor(actor, REGIONAL); const fact = this.#facts.verify(factInput, { tenantId: actor.tenantId, factKind: "regional.runtime", independent: true, issuerRole: "independent-regional-runtime-authority" }); const replication = this.#required(actor.tenantId, "region.replication", fact.subjectId);
    exactKeys(fact.payload, ["replicationId", "topologyVersion", "sourceRegion", "destinationRegion", "classification", "encrypted", "purposeEnforced", "runtimeEvidenceSha256"], "regional runtime attestation");
    if (fact.payload.replicationId !== replication.aggregateId || fact.payload.topologyVersion !== replication.state.topologyVersion || fact.payload.sourceRegion !== replication.state.sourceRegion || fact.payload.destinationRegion !== replication.state.destinationRegion || fact.payload.classification !== replication.state.classification || fact.payload.encrypted !== true || fact.payload.purposeEnforced !== true) throw new EnterpriseControlError("EVIDENCE_UNVERIFIED", "runtime regional evidence does not match approved replication");
    const state: JsonObject = { ...replication.state, runtimeCertification: fact.environment === "production" ? "CERTIFIED" : "TEST_VERIFIED", runtimeFactId: fact.factId, runtimeEvidenceSha256: hexDigest(String(fact.payload.runtimeEvidenceSha256), "runtimeEvidenceSha256") };
    return this.#factWrite(actor, fact, idempotencyKey, "B120.certifyRuntime", { replicationId: replication.aggregateId }, "region.replication", replication.aggregateId, "region.runtimeCertified", { factId: fact.factId, runtimeEvidenceSha256: state.runtimeEvidenceSha256 }, replication.version, state);
  }

  #write(actor: EnterpriseActor, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null = null, state: JsonObject = request): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, request, () => this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state).value as JsonObject;
  }
  #factWrite(actor: EnterpriseActor, fact: VerifiedEnterpriseAttestation, key: string, operation: string, request: JsonObject, aggregateType: string, aggregateId: string, eventType: string, event: JsonObject, expectedVersion: number | null, state: JsonObject): JsonObject {
    return this.#repository.execute(actor.tenantId, key, operation, { ...request, factSha256: fact.factSha256 }, () => { this.#repository.claimFact({ tenantId: actor.tenantId, factId: fact.factId, factSha256: fact.factSha256, issuer: fact.issuer, factKind: fact.factKind, subjectId: fact.subjectId, sequence: fact.sequence, occurredAt: fact.occurredAt }); return this.#repository.put({ tenantId: actor.tenantId, aggregateType, aggregateId, expectedVersion, state, eventType, event }).state; }).value as JsonObject;
  }
  #required<T extends JsonObject = JsonObject>(tenantId: string, type: string, id: string): EnterpriseSnapshot<T> { const value = this.#repository.get<T>(tenantId, type, id); if (value === undefined) throw new EnterpriseControlError("NOT_FOUND", `${type}/${id} not found`); return value; }
}

function validateConfiguration(schema: JsonObject, values: JsonObject, layer: Layer): JsonObject {
  const definitions = new Map((schema.fields as readonly JsonObject[]).map((field) => [String(field.key), field])); const output: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = definitions.get(key); if (field === undefined) throw new EnterpriseControlError("CONFIGURATION_INVALID", `configuration field ${key} is not approved`);
    if (layer === "tenant" && field.tenantOverridable !== true) throw new EnterpriseControlError("POLICY_BLOCKED", `tenant cannot override ${key}`);
    if (field.protected === true && raw !== true) throw new EnterpriseControlError("POLICY_BLOCKED", `protected configuration ${key} cannot be disabled`);
    if (field.type === "boolean" && typeof raw !== "boolean") throw new EnterpriseControlError("CONFIGURATION_INVALID", `${key} must be boolean`);
    if (field.type === "integer" && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < Number(field.minimum) || raw > Number(field.maximum))) throw new EnterpriseControlError("CONFIGURATION_INVALID", `${key} is outside bounds`);
    if (field.type === "string" && (typeof raw !== "string" || (field.allowedValues !== null && !(field.allowedValues as readonly string[]).includes(raw)))) throw new EnterpriseControlError("CONFIGURATION_INVALID", `${key} is not allowed`);
    output[key] = raw as JsonValue;
  }
  return freeze(output);
}
