import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, clone, DataIntelligenceError, fingerprint, required, strictUtc, unique } from "./common.js";

export type DataAssetKind = "database" | "object_store" | "event" | "warehouse_model" | "metric" | "dashboard" | "export" | "third_party_destination";
export type GovernanceClassification = "public" | "internal" | "confidential" | "restricted";

export interface DataAsset {
  readonly id: string;
  readonly kind: DataAssetKind;
  readonly owner: string;
  readonly tenantScoped: boolean;
  readonly classifications: Readonly<Record<string, GovernanceClassification>>;
  readonly allowedPurposes: readonly string[];
  readonly retentionPolicy: string;
  readonly deletionSupported: boolean;
}

export interface LineageEdge {
  readonly fromAssetId: string;
  readonly toAssetId: string;
  readonly fieldMappings: Readonly<Record<string, string>>;
  readonly transformFingerprint: string;
}

export type QualityRuleType = "complete" | "unique" | "valid" | "fresh" | "amount_balance" | "referential_integrity" | "distribution_drift";
export interface QualityRule {
  readonly id: string;
  readonly assetId: string;
  readonly type: QualityRuleType;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly threshold: number;
  readonly owner: string;
}
export interface QualityObservation { readonly ruleId: string; readonly measured: number; readonly observedAt: string; }
export interface QualityResult { readonly ruleId: string; readonly passed: boolean; readonly severity: QualityRule["severity"]; readonly incidentId?: string; }

export interface DataAccessPolicy {
  readonly policyId: string;
  readonly assetId: string;
  readonly roles: readonly string[];
  readonly tenantIds: readonly string[];
  readonly regions: readonly string[];
  readonly purposes: readonly string[];
  readonly allowedColumns: readonly string[];
  readonly maskedColumns: readonly string[];
  readonly expiresAt: string;
  readonly exportAllowed: boolean;
}

export interface GovernanceActor {
  readonly actorId: string;
  readonly role: string;
  readonly tenantId: string;
  readonly region: string;
  readonly purpose: string;
}

export const DELETION_TARGETS = ["business_database", "warehouse", "cache", "search", "export", "downstream_connector"] as const;
export type DeletionTarget = (typeof DELETION_TARGETS)[number];
export interface DeletionReceipt {
  readonly requestId: string;
  readonly target: DeletionTarget;
  readonly subjectDigest: string;
  readonly deletedAt: string;
  readonly authority: string;
  readonly artifactSha256: string;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
}

export interface DeletionAuthorityKey {
  readonly authority: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly targets: readonly DeletionTarget[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface DeletionReceiptAuthority {
  verify(receipt: DeletionReceipt): boolean;
}

export class Ed25519DeletionReceiptAuthority implements DeletionReceiptAuthority {
  readonly #keys = new Map<string, DeletionAuthorityKey>();

  constructor(keys: readonly DeletionAuthorityKey[]) {
    for (const key of keys) {
      required(key.authority, "deletion authority"); required(key.keyId, "deletion authority key id");
      strictUtc(key.notBefore, "authority notBefore"); strictUtc(key.expiresAt, "authority expiresAt");
      if (Date.parse(key.notBefore) >= Date.parse(key.expiresAt) || key.targets.length === 0 || new Set(key.targets).size !== key.targets.length) throw new DataIntelligenceError("VALIDATION_FAILED", "deletion authority key scope is invalid");
      if (key.revokedAt !== undefined) strictUtc(key.revokedAt, "authority revokedAt");
      createPublicKey(key.publicKeyPem);
      const id = `${key.authority}:${key.keyId}`; if (this.#keys.has(id)) throw new DataIntelligenceError("CONFLICT", "deletion authority key is duplicated");
      this.#keys.set(id, Object.freeze(clone(key)));
    }
  }

  verify(receipt: DeletionReceipt): boolean {
    const key = this.#keys.get(`${receipt.authority}:${receipt.keyId}`);
    if (key === undefined || receipt.algorithm !== "Ed25519" || !key.targets.includes(receipt.target) ||
        Date.parse(receipt.deletedAt) < Date.parse(key.notBefore) || Date.parse(receipt.deletedAt) >= Date.parse(key.expiresAt) ||
        (key.revokedAt !== undefined && Date.parse(receipt.deletedAt) >= Date.parse(key.revokedAt))) return false;
    let signature: Buffer;
    try { signature = Buffer.from(receipt.signature, "base64"); } catch { return false; }
    if (signature.length !== 64) return false;
    const unsigned: Omit<DeletionReceipt, "signature"> = {
      requestId: receipt.requestId, target: receipt.target, subjectDigest: receipt.subjectDigest,
      deletedAt: receipt.deletedAt, authority: receipt.authority, artifactSha256: receipt.artifactSha256,
      algorithm: receipt.algorithm, keyId: receipt.keyId,
    };
    return verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), createPublicKey(key.publicKeyPem), signature);
  }
}

interface DeletionRequest {
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly requestedAt: string;
  readonly receipts: Map<DeletionTarget, DeletionReceipt>;
}

export class DataGovernanceService {
  readonly #assets = new Map<string, DataAsset>();
  readonly #lineage: LineageEdge[] = [];
  readonly #rules = new Map<string, QualityRule>();
  readonly #policies = new Map<string, DataAccessPolicy>();
  readonly #deletions = new Map<string, DeletionRequest>();
  readonly #audit: Array<Readonly<Record<string, string>>> = [];

  constructor(readonly now: () => Date = () => new Date(), readonly deletionAuthority?: DeletionReceiptAuthority) {}

  registerAsset(asset: DataAsset): void {
    required(asset.id, "asset id"); required(asset.owner, "asset owner"); required(asset.retentionPolicy, "retention policy"); unique(asset.allowedPurposes, "asset purposes");
    if (Object.keys(asset.classifications).length === 0) throw new DataIntelligenceError("VALIDATION_FAILED", "asset must classify every published field");
    if (this.#assets.has(asset.id)) throw new DataIntelligenceError("CONFLICT", "asset already exists");
    this.#assets.set(asset.id, Object.freeze(clone(asset)));
  }

  addLineage(edge: LineageEdge): void {
    this.#asset(edge.fromAssetId); this.#asset(edge.toAssetId);
    if (edge.fromAssetId === edge.toAssetId || Object.keys(edge.fieldMappings).length === 0 || !/^[a-f0-9]{64}$/u.test(edge.transformFingerprint)) {
      throw new DataIntelligenceError("VALIDATION_FAILED", "lineage edge is invalid");
    }
    if (this.#pathExists(edge.toAssetId, edge.fromAssetId)) throw new DataIntelligenceError("CONFLICT", "lineage graph cannot contain cycles");
    this.#lineage.push(Object.freeze(clone(edge)));
  }

  impact(assetId: string): { readonly upstream: readonly string[]; readonly downstream: readonly string[]; readonly deletionBlocked: readonly string[]; readonly consentPurposes: readonly string[] } {
    this.#asset(assetId);
    const upstream = this.#walk(assetId, "upstream");
    const downstream = this.#walk(assetId, "downstream");
    const deletionBlocked = [assetId, ...downstream].filter((id) => !this.#asset(id).deletionSupported);
    const consentPurposes = new Set([assetId, ...upstream, ...downstream].flatMap((id) => this.#asset(id).allowedPurposes));
    return Object.freeze({ upstream: Object.freeze(upstream), downstream: Object.freeze(downstream), deletionBlocked: Object.freeze(deletionBlocked), consentPurposes: Object.freeze([...consentPurposes].sort()) });
  }

  registerQualityRule(rule: QualityRule): void {
    this.#asset(rule.assetId); required(rule.id, "quality rule id"); required(rule.owner, "quality rule owner");
    if (!Number.isFinite(rule.threshold) || rule.threshold < 0) throw new DataIntelligenceError("VALIDATION_FAILED", "quality threshold is invalid");
    if (this.#rules.has(rule.id)) throw new DataIntelligenceError("CONFLICT", "quality rule already exists");
    this.#rules.set(rule.id, Object.freeze(clone(rule)));
  }

  observeQuality(observation: QualityObservation): QualityResult {
    const rule = this.#rules.get(observation.ruleId);
    if (rule === undefined) throw new DataIntelligenceError("NOT_FOUND", "quality rule does not exist");
    strictUtc(observation.observedAt, "quality observedAt");
    if (!Number.isFinite(observation.measured)) throw new DataIntelligenceError("VALIDATION_FAILED", "quality measurement is invalid");
    const passed = rule.type === "distribution_drift" ? observation.measured <= rule.threshold : observation.measured >= rule.threshold;
    return Object.freeze({ ruleId: rule.id, passed, severity: rule.severity, ...(passed ? {} : { incidentId: `data-quality:${rule.id}:${observation.observedAt}` }) });
  }

  grant(policy: DataAccessPolicy): void {
    const asset = this.#asset(policy.assetId);
    required(policy.policyId, "policy id"); unique(policy.roles, "policy roles"); unique(policy.tenantIds, "policy tenants"); unique(policy.regions, "policy regions"); unique(policy.purposes, "policy purposes"); unique(policy.allowedColumns, "allowed columns");
    strictUtc(policy.expiresAt, "policy expiresAt");
    if (policy.allowedColumns.some((column) => asset.classifications[column] === undefined)) throw new DataIntelligenceError("VALIDATION_FAILED", "policy references an unknown column");
    if (policy.maskedColumns.some((column) => !policy.allowedColumns.includes(column))) throw new DataIntelligenceError("VALIDATION_FAILED", "masked columns must also be allowed");
    if (policy.purposes.some((purpose) => !asset.allowedPurposes.includes(purpose))) throw new DataIntelligenceError("POLICY_BLOCKED", "policy purpose is not allowed by the asset");
    this.#policies.set(policy.policyId, Object.freeze(clone(policy)));
  }

  read(input: { readonly policyId: string; readonly actor: GovernanceActor; readonly rowTenantId: string; readonly rowRegion: string; readonly values: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>> {
    const policy = this.#policies.get(input.policyId);
    if (policy === undefined) throw new DataIntelligenceError("NOT_FOUND", "data access policy does not exist");
    if (Date.parse(policy.expiresAt) <= this.now().getTime() || !policy.roles.includes(input.actor.role) || !policy.tenantIds.includes(input.actor.tenantId) ||
        !policy.regions.includes(input.actor.region) || !policy.purposes.includes(input.actor.purpose) || input.rowTenantId !== input.actor.tenantId || input.rowRegion !== input.actor.region) {
      throw new DataIntelligenceError("AUTHORIZATION_DENIED", "row, column, purpose, region, or temporary authorization denied access");
    }
    const values = Object.fromEntries(policy.allowedColumns.map((column) => [column, policy.maskedColumns.includes(column) && input.values[column] !== undefined ? "***" : input.values[column]]));
    this.#audit.push(Object.freeze({ action: "read", actorId: input.actor.actorId, tenantId: input.actor.tenantId, assetId: policy.assetId, purpose: input.actor.purpose, at: this.now().toISOString() }));
    return Object.freeze(values);
  }

  authorizeExport(policyId: string, actor: GovernanceActor): void {
    const policy = this.#policies.get(policyId);
    if (policy === undefined || !policy.exportAllowed || !policy.roles.includes(actor.role) || !policy.tenantIds.includes(actor.tenantId) || Date.parse(policy.expiresAt) <= this.now().getTime()) {
      throw new DataIntelligenceError("AUTHORIZATION_DENIED", "export is not authorized");
    }
    this.#audit.push(Object.freeze({ action: "export", actorId: actor.actorId, tenantId: actor.tenantId, assetId: policy.assetId, purpose: actor.purpose, at: this.now().toISOString() }));
  }

  requestDeletion(input: { readonly requestId: string; readonly subjectDigest: string; readonly requestedAt: string }): void {
    required(input.requestId, "deletion request id"); strictUtc(input.requestedAt, "deletion requestedAt");
    if (!/^[a-f0-9]{64}$/u.test(input.subjectDigest)) throw new DataIntelligenceError("VALIDATION_FAILED", "subject digest is invalid");
    const previous = this.#deletions.get(input.requestId);
    if (previous !== undefined) {
      if (previous.subjectDigest !== input.subjectDigest) throw new DataIntelligenceError("CONFLICT", "deletion request id was reused");
      return;
    }
    this.#deletions.set(input.requestId, { ...input, receipts: new Map() });
  }

  recordDeletionReceipt(receipt: DeletionReceipt): { readonly complete: boolean; readonly pending: readonly DeletionTarget[] } {
    const request = this.#deletions.get(receipt.requestId);
    if (request === undefined) throw new DataIntelligenceError("NOT_FOUND", "deletion request does not exist");
    if (request.subjectDigest !== receipt.subjectDigest || !/^[a-f0-9]{64}$/u.test(receipt.artifactSha256)) throw new DataIntelligenceError("CONFLICT", "deletion receipt is not bound to the request");
    strictUtc(receipt.deletedAt, "deletedAt"); required(receipt.authority, "deletion authority"); required(receipt.keyId, "deletion authority key id");
    if (Date.parse(receipt.deletedAt) < Date.parse(request.requestedAt) || Date.parse(receipt.deletedAt) > this.now().getTime() + 5 * 60_000) throw new DataIntelligenceError("CONFLICT", "deletion receipt time is outside the request-bound window");
    if (this.deletionAuthority === undefined || !this.deletionAuthority.verify(receipt)) throw new DataIntelligenceError("AUTHORIZATION_DENIED", "deletion receipt was not signed by a trusted target authority");
    const previous = request.receipts.get(receipt.target);
    if (previous !== undefined && fingerprint(previous) !== fingerprint(receipt)) throw new DataIntelligenceError("CONFLICT", "deletion target returned conflicting evidence");
    request.receipts.set(receipt.target, Object.freeze(clone(receipt)));
    const pending = DELETION_TARGETS.filter((target) => !request.receipts.has(target));
    return Object.freeze({ complete: pending.length === 0, pending: Object.freeze(pending) });
  }

  audit(): readonly Readonly<Record<string, string>>[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  #asset(assetId: string): DataAsset {
    const asset = this.#assets.get(assetId);
    if (asset === undefined) throw new DataIntelligenceError("NOT_FOUND", `data asset ${assetId} does not exist`);
    return asset;
  }

  #pathExists(from: string, to: string): boolean {
    return this.#walk(from, "downstream").includes(to);
  }

  #walk(assetId: string, direction: "upstream" | "downstream"): string[] {
    const seen = new Set<string>();
    const queue = [assetId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const adjacent = this.#lineage.filter((edge) => direction === "downstream" ? edge.fromAssetId === current : edge.toAssetId === current)
        .map((edge) => direction === "downstream" ? edge.toAssetId : edge.fromAssetId);
      for (const next of adjacent) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    seen.delete(assetId);
    return [...seen].sort();
  }
}
