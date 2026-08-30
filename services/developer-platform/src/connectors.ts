import { clone, DeveloperPlatformError, digest, required, utc, unique } from "./common.js";

export type AdapterCategory = "crm" | "cdp_marketing" | "support" | "accounting";
export interface ConnectorManifest {
  readonly id: string;
  readonly publisher: string;
  readonly version: string;
  readonly categories: readonly AdapterCategory[];
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly dataCategories: readonly string[];
  readonly eventTypes: readonly string[];
  readonly configurationSchemaSha256: string;
  readonly regions: readonly string[];
  readonly ratePerMinute: number;
  readonly supportTier: "community" | "standard" | "enterprise";
  readonly pricing: string;
  readonly artifactSha256: string;
}

export interface ConnectorReview {
  readonly manifestId: string;
  readonly version: string;
  readonly supplyChainScanPassed: boolean;
  readonly codeReviewPassed: boolean;
  readonly configurationReviewPassed: boolean;
  readonly sandboxCertificationId: string;
  readonly compatibilityPassed: boolean;
  readonly reviewerIds: readonly string[];
  readonly reviewedAt: string;
}

export interface FieldMapping {
  readonly sourceField: string;
  readonly targetField: string;
  readonly sourceOfTruth: "ltm" | "connector" | "latest_explicit_user_change";
  readonly classification: "public" | "internal" | "confidential" | "restricted";
  readonly purpose: string;
  readonly contactConsentRequired: boolean;
  readonly exportAllowed: boolean;
  readonly conflictRule: "source_wins" | "target_wins" | "manual_case";
}

export interface ConnectorInstallInput {
  readonly id: string;
  readonly connectorId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly administratorId: string;
  readonly credentialReference: string;
  readonly grantedScopes: readonly string[];
  readonly fieldMappings: readonly FieldMapping[];
  readonly privacyFlowConfirmed: boolean;
  readonly connectionTestArtifactSha256: string;
  readonly quotaPerDay: number;
}

export interface ConnectorInstall extends ConnectorInstallInput {
  readonly status: "ACTIVE" | "PAUSED" | "CANCELLED" | "UNINSTALLED" | "REVOKED";
  readonly cursor: number;
  readonly installedAt: string;
  readonly lastSyncAt?: string;
}

export interface ConnectorRecord {
  readonly sourceId: string;
  readonly sequence: number;
  readonly updatedAt: string;
  readonly deleted: boolean;
  readonly unsubscribed: boolean;
  readonly contactConsent: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ConnectorSyncReport {
  readonly syncId: string;
  readonly installId: string;
  readonly state: "COMMITTED" | "NOOP" | "DEAD_LETTERED";
  readonly cursor: number;
  readonly written: number;
  readonly deletionsPropagated: number;
  readonly unsubscriptionsPropagated: number;
  readonly amountControlMinor: number;
  readonly errorCount: number;
  readonly retryAfterMs?: number;
  readonly manualCaseIds: readonly string[];
}

export interface ConnectorTarget {
  apply(input: {
    readonly tenantId: string;
    readonly installId: string;
    readonly sourceId: string;
    readonly values: Readonly<Record<string, unknown>>;
    readonly deleted: boolean;
    readonly unsubscribed: boolean;
    readonly idempotencyKey: string;
  }): Promise<{ readonly accepted: boolean; readonly retryable: boolean; readonly correlationId: string; readonly amountMinor?: number; readonly conflicts?: readonly string[] }>;
}

interface StoredInstall { value: ConnectorInstall; readonly recordFingerprints: Map<string, string>; readonly syncFingerprints: Map<string, string>; usedToday: { day: string; count: number }; }

export class ConnectorPlatform {
  readonly #manifests = new Map<string, ConnectorManifest>();
  readonly #reviews = new Map<string, ConnectorReview>();
  readonly #installs = new Map<string, StoredInstall>();

  constructor(readonly target: ConnectorTarget, readonly now: () => Date = () => new Date()) {}

  publish(manifest: ConnectorManifest, review: ConnectorReview): void {
    validateManifest(manifest); validateReview(manifest, review);
    const key = manifestKey(manifest.id, manifest.version);
    if (this.#manifests.has(key)) throw new DeveloperPlatformError("CONFLICT", "connector version already exists");
    this.#manifests.set(key, Object.freeze(clone(manifest))); this.#reviews.set(key, Object.freeze(clone(review)));
  }

  install(input: ConnectorInstallInput): ConnectorInstall {
    required(input.id, "install id"); required(input.tenantId, "tenantId"); required(input.administratorId, "administratorId");
    if (!input.privacyFlowConfirmed || !/^[a-f0-9]{64}$/u.test(input.connectionTestArtifactSha256)) throw new DeveloperPlatformError("POLICY_BLOCKED", "connector install requires privacy/data-flow confirmation and a bound connection test");
    if (!/^(?:vault|secret-manager|key-vault):[A-Za-z0-9/_.:-]+$/u.test(input.credentialReference)) throw new DeveloperPlatformError("POLICY_BLOCKED", "connector credentials must be referenced from an approved secret manager");
    const manifest = this.#manifest(input.connectorId, input.version);
    if (input.grantedScopes.some((scope) => !manifest.permissions.includes(scope))) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "connector install scope exceeds its manifest");
    unique(input.grantedScopes, "connector granted scopes"); validateMappings(input.fieldMappings, manifest.categories);
    if (!Number.isSafeInteger(input.quotaPerDay) || input.quotaPerDay < 1) throw new DeveloperPlatformError("VALIDATION_FAILED", "connector quota is invalid");
    if (this.#installs.has(input.id)) throw new DeveloperPlatformError("CONFLICT", "connector install id already exists");
    const value = Object.freeze({ ...clone(input), status: "ACTIVE" as const, cursor: 0, installedAt: this.now().toISOString() });
    this.#installs.set(input.id, { value, recordFingerprints: new Map(), syncFingerprints: new Map(), usedToday: { day: this.now().toISOString().slice(0, 10), count: 0 } });
    return value;
  }

  async sync(input: { readonly syncId: string; readonly installId: string; readonly records: readonly ConnectorRecord[]; readonly expectedAmountMinor: number }): Promise<ConnectorSyncReport> {
    required(input.syncId, "sync id");
    const stored = this.#install(input.installId);
    if (stored.value.status !== "ACTIVE") throw new DeveloperPlatformError("POLICY_BLOCKED", "connector install is not active");
    const syncFingerprint = digest(input);
    const prior = stored.syncFingerprints.get(input.syncId);
    if (prior !== undefined) {
      if (prior !== syncFingerprint) throw new DeveloperPlatformError("CONFLICT", "connector sync id was reused with changed input");
      return Object.freeze({ syncId: input.syncId, installId: input.installId, state: "NOOP", cursor: stored.value.cursor, written: 0, deletionsPropagated: 0, unsubscriptionsPropagated: 0, amountControlMinor: 0, errorCount: 0, manualCaseIds: Object.freeze([]) });
    }
    const day = this.now().toISOString().slice(0, 10);
    if (stored.usedToday.day !== day) stored.usedToday = { day, count: 0 };
    if (stored.usedToday.count + input.records.length > stored.value.quotaPerDay) throw new DeveloperPlatformError("RATE_LIMITED", "connector daily quota exceeded");
    const records = [...input.records].sort((left, right) => left.sequence - right.sequence);
    let cursor = stored.value.cursor; let written = 0; let deletions = 0; let unsubscriptions = 0; let amount = 0; let errors = 0;
    const manualCaseIds: string[] = [];
    for (const record of records) {
      validateRecord(record);
      const recordFingerprint = digest(record); const recordKey = `${record.sequence}:${record.sourceId}`;
      if (record.sequence <= cursor) {
        if (stored.recordFingerprints.get(recordKey) !== recordFingerprint) throw new DeveloperPlatformError("CONFLICT", "connector source record changed after cursor commit");
        continue;
      }
      if (record.sequence !== cursor + 1) throw new DeveloperPlatformError("CONFLICT", `connector cursor gap at ${cursor + 1}`);
      const mapped = mapRecord(record, stored.value.fieldMappings);
      const result = await this.target.apply({ tenantId: stored.value.tenantId, installId: stored.value.id, sourceId: record.sourceId, values: mapped, deleted: record.deleted, unsubscribed: record.unsubscribed, idempotencyKey: `${stored.value.id}:${record.sequence}:${record.sourceId}` });
      if (!result.accepted) {
        errors += 1;
        if (result.retryable) return Object.freeze({ syncId: input.syncId, installId: input.installId, state: "DEAD_LETTERED", cursor, written, deletionsPropagated: deletions, unsubscriptionsPropagated: unsubscriptions, amountControlMinor: amount, errorCount: errors, retryAfterMs: 5_000, manualCaseIds: Object.freeze(manualCaseIds) });
        manualCaseIds.push(`connector-case:${input.installId}:${record.sourceId}`);
        return Object.freeze({ syncId: input.syncId, installId: input.installId, state: "DEAD_LETTERED", cursor, written, deletionsPropagated: deletions, unsubscriptionsPropagated: unsubscriptions, amountControlMinor: amount, errorCount: errors, manualCaseIds: Object.freeze(manualCaseIds) });
      }
      for (const conflict of result.conflicts ?? []) manualCaseIds.push(`connector-conflict:${input.installId}:${record.sourceId}:${conflict}`);
      cursor = record.sequence; written += 1; if (record.deleted) deletions += 1; if (record.unsubscribed) unsubscriptions += 1; amount += result.amountMinor ?? 0;
      stored.recordFingerprints.set(recordKey, recordFingerprint);
    }
    if (amount !== input.expectedAmountMinor) throw new DeveloperPlatformError("CONFLICT", "connector accounting/support control total does not reconcile");
    stored.usedToday.count += records.length; stored.syncFingerprints.set(input.syncId, syncFingerprint);
    stored.value = Object.freeze({ ...stored.value, cursor, lastSyncAt: this.now().toISOString() });
    return Object.freeze({ syncId: input.syncId, installId: input.installId, state: "COMMITTED", cursor, written, deletionsPropagated: deletions, unsubscriptionsPropagated: unsubscriptions, amountControlMinor: amount, errorCount: errors, manualCaseIds: Object.freeze(manualCaseIds) });
  }

  setStatus(installId: string, status: "ACTIVE" | "PAUSED" | "CANCELLED" | "UNINSTALLED"): ConnectorInstall {
    const stored = this.#install(installId);
    if (stored.value.status === "REVOKED") throw new DeveloperPlatformError("POLICY_BLOCKED", "emergency-revoked connector cannot be reactivated");
    stored.value = Object.freeze({ ...stored.value, status });
    return stored.value;
  }

  emergencyRevoke(connectorId: string, version: string): number {
    const key = manifestKey(connectorId, version); this.#manifest(connectorId, version);
    let revoked = 0;
    for (const stored of this.#installs.values()) if (manifestKey(stored.value.connectorId, stored.value.version) === key && stored.value.status !== "REVOKED") { stored.value = Object.freeze({ ...stored.value, status: "REVOKED" }); revoked += 1; }
    return revoked;
  }

  marketplace(): readonly Readonly<ConnectorManifest & { reviewStatus: "APPROVED" }>[] {
    return Object.freeze([...this.#manifests.entries()].map(([key, manifest]) => Object.freeze({ ...clone(manifest), reviewStatus: this.#reviews.has(key) ? "APPROVED" as const : neverValue() })));
  }

  #manifest(id: string, version: string): ConnectorManifest {
    const manifest = this.#manifests.get(manifestKey(id, version)); if (manifest === undefined) throw new DeveloperPlatformError("NOT_FOUND", "connector version is not published"); return manifest;
  }
  #install(id: string): StoredInstall { const install = this.#installs.get(id); if (install === undefined) throw new DeveloperPlatformError("NOT_FOUND", "connector install does not exist"); return install; }
}

export const REFERENCE_ADAPTERS = Object.freeze({
  crm: { id: "reference-crm", entities: ["contact", "lead", "activity", "consent", "deletion"] },
  cdp_marketing: { id: "reference-cdp-marketing", entities: ["contact", "event", "audience", "unsubscribe", "deletion"] },
  support: { id: "reference-support", entities: ["contact", "ticket", "conversation_metadata", "deletion"] },
  accounting: { id: "reference-accounting", entities: ["invoice", "journal", "settlement", "control_total"] },
} as const);

function validateManifest(manifest: ConnectorManifest): void {
  required(manifest.id, "connector id"); required(manifest.publisher, "connector publisher"); required(manifest.version, "connector version"); required(manifest.pricing, "connector pricing");
  unique(manifest.categories, "connector categories"); unique(manifest.capabilities, "connector capabilities"); unique(manifest.permissions, "connector permissions"); unique(manifest.dataCategories, "connector data categories"); unique(manifest.eventTypes, "connector events"); unique(manifest.regions, "connector regions");
  if (!/^[a-f0-9]{64}$/u.test(manifest.configurationSchemaSha256) || !/^[a-f0-9]{64}$/u.test(manifest.artifactSha256) || !Number.isSafeInteger(manifest.ratePerMinute) || manifest.ratePerMinute < 1) throw new DeveloperPlatformError("VALIDATION_FAILED", "connector digests or rate are invalid");
}
function validateReview(manifest: ConnectorManifest, review: ConnectorReview): void {
  utc(review.reviewedAt, "connector reviewedAt"); unique(review.reviewerIds, "connector reviewers"); required(review.sandboxCertificationId, "sandbox certification id");
  if (review.manifestId !== manifest.id || review.version !== manifest.version || !review.supplyChainScanPassed || !review.codeReviewPassed || !review.configurationReviewPassed || !review.compatibilityPassed || review.reviewerIds.length < 2) throw new DeveloperPlatformError("POLICY_BLOCKED", "connector review and certification are incomplete");
}
function validateMappings(mappings: readonly FieldMapping[], categories: readonly AdapterCategory[]): void {
  if (mappings.length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "connector install needs field mappings");
  const targets = new Set<string>();
  for (const mapping of mappings) {
    required(mapping.sourceField, "mapping source"); required(mapping.targetField, "mapping target"); required(mapping.purpose, "mapping purpose");
    if (!targets.add(mapping.targetField)) throw new DeveloperPlatformError("VALIDATION_FAILED", "connector target field is mapped more than once");
    if (/face|biometric|child|private_conversation|raw_media/i.test(`${mapping.sourceField}:${mapping.targetField}`) || (mapping.classification === "restricted" && mapping.exportAllowed)) throw new DeveloperPlatformError("POLICY_BLOCKED", "restricted face, child, media, or private-conversation data cannot be exported");
    const contactField = /contact|email|phone|lead|activity|audience|marketing/i.test(`${mapping.sourceField}:${mapping.targetField}:${mapping.purpose}`);
    if ((categories.includes("crm") || categories.includes("cdp_marketing")) && contactField && mapping.exportAllowed && !mapping.contactConsentRequired) throw new DeveloperPlatformError("POLICY_BLOCKED", "contact export requires explicit contact consent");
  }
}
function validateRecord(record: ConnectorRecord): void { required(record.sourceId, "connector source id"); utc(record.updatedAt, "connector updatedAt"); if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new DeveloperPlatformError("VALIDATION_FAILED", "connector sequence is invalid"); }
function mapRecord(record: ConnectorRecord, mappings: readonly FieldMapping[]): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const mapping of mappings) {
    if (!mapping.exportAllowed) continue;
    if (mapping.contactConsentRequired && !record.contactConsent) continue;
    output[mapping.targetField] = record.values[mapping.sourceField];
  }
  if (record.unsubscribed) output["unsubscribed"] = true;
  if (record.deleted) output["deleted"] = true;
  return Object.freeze(output);
}
function manifestKey(id: string, version: string): string { return `${id}@${version}`; }
function neverValue(): never { throw new DeveloperPlatformError("CONFLICT", "connector review is missing"); }
