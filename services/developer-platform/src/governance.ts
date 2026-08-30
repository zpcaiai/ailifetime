import { clone, DeveloperPlatformError, digest, required, utc, unique } from "./common.js";

export interface ApiContract {
  readonly version: string;
  readonly paths: Readonly<Record<string, readonly string[]>>;
  readonly schemas: Readonly<Record<string, Readonly<Record<string, { readonly type: string; readonly required: boolean }>>>>;
  readonly events: Readonly<Record<string, readonly string[]>>;
  readonly sdkVersions: Readonly<Record<string, string>>;
}

export interface CompatibilityReport {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly breakingChanges: readonly string[];
  readonly additiveChanges: readonly string[];
  readonly reportSha256: string;
}

export interface LifecyclePolicy {
  readonly minimumDeprecationDays: number;
  readonly securityEmergencyMinimumDays: number;
  readonly supportedMajorVersions: number;
  readonly supportMatrix: Readonly<Record<string, readonly string[]>>;
}

export interface ChangeLogEntry {
  readonly id: string;
  readonly apiVersions: readonly string[];
  readonly eventVersions: readonly string[];
  readonly sdkVersions: Readonly<Record<string, string>>;
  readonly databaseChanges: readonly string[];
  readonly migrationIds: readonly string[];
  readonly risks: readonly string[];
  readonly releaseAt: string;
  readonly actions: readonly string[];
}

export interface VersionUsage {
  readonly partnerId: string;
  readonly applicationId: string;
  readonly apiVersion: string;
  readonly sdkVersion: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly observedAt: string;
}

export interface DeprecationPlan {
  readonly version: string;
  readonly announcedAt: string;
  readonly retiresAt: string;
  readonly emergencySecurityException: boolean;
  readonly replacementVersion: string;
  readonly migrationGuideSha256: string;
  readonly sandboxAvailable: boolean;
  readonly harnessAvailable: boolean;
  readonly rollbackPlanSha256: string;
  readonly parallelRunSupported: boolean;
  readonly criticalPartnerIds: readonly string[];
  readonly acknowledgements: readonly string[];
}

export type DeveloperComponent = "api" | "webhook" | "sandbox" | "documentation" | "sdk";
export interface ComponentStatus {
  readonly component: DeveloperComponent;
  readonly status: "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";
  readonly observedAt: string;
  readonly incidentId?: string;
  readonly uptimeBasisPoints: number;
}

export interface SupportSla {
  readonly tier: "standard" | "enterprise";
  readonly severity: "sev1" | "sev2" | "sev3";
  readonly responseMinutes: number;
  readonly updateMinutes: number;
  readonly component: DeveloperComponent;
}

export class ApiLifecycleService {
  readonly #contracts = new Map<string, ApiContract>();
  readonly #reports = new Map<string, CompatibilityReport>();
  readonly #changes = new Map<string, ChangeLogEntry>();
  readonly #usage: VersionUsage[] = [];
  readonly #deprecations = new Map<string, DeprecationPlan>();
  readonly #statuses = new Map<DeveloperComponent, ComponentStatus>();
  readonly #slas: SupportSla[] = [];

  constructor(readonly policy: LifecyclePolicy, readonly now: () => Date = () => new Date()) {
    if (!Number.isSafeInteger(policy.minimumDeprecationDays) || policy.minimumDeprecationDays < 30 || !Number.isSafeInteger(policy.securityEmergencyMinimumDays) || policy.securityEmergencyMinimumDays < 1 || policy.securityEmergencyMinimumDays >= policy.minimumDeprecationDays || !Number.isSafeInteger(policy.supportedMajorVersions) || policy.supportedMajorVersions < 1) throw new DeveloperPlatformError("VALIDATION_FAILED", "API lifecycle policy is invalid");
  }

  registerContract(contract: ApiContract): CompatibilityReport | undefined {
    validateContract(contract);
    if (this.#contracts.has(contract.version)) throw new DeveloperPlatformError("CONFLICT", "API contract version already exists");
    const previous = [...this.#contracts.values()].sort((left, right) => semverCompare(right.version, left.version))[0];
    const report = previous === undefined ? undefined : compareContracts(previous, contract);
    if (report !== undefined && previous !== undefined) {
      const fromMajor = major(previous.version); const toMajor = major(contract.version);
      if (report.breakingChanges.length > 0 && toMajor <= fromMajor) throw new DeveloperPlatformError("CONFLICT", "breaking API/event/schema changes require a new major version");
      this.#reports.set(`${previous.version}->${contract.version}`, report);
    }
    this.#contracts.set(contract.version, Object.freeze(clone(contract)));
    return report;
  }

  publishChange(entry: ChangeLogEntry): void {
    required(entry.id, "change id"); unique(entry.apiVersions, "change API versions"); unique(entry.eventVersions, "change event versions"); unique(entry.databaseChanges, "database changes"); unique(entry.migrationIds, "migration ids"); unique(entry.risks, "change risks"); unique(entry.actions, "change actions"); utc(entry.releaseAt, "releaseAt");
    if (Object.keys(entry.sdkVersions).length === 0 || entry.apiVersions.some((version) => !this.#contracts.has(version))) throw new DeveloperPlatformError("VALIDATION_FAILED", "change log is not bound to registered API and SDK versions");
    if (this.#changes.has(entry.id)) throw new DeveloperPlatformError("CONFLICT", "change log id already exists");
    this.#changes.set(entry.id, Object.freeze(clone(entry)));
  }

  recordUsage(usage: VersionUsage): void {
    required(usage.partnerId, "usage partnerId"); required(usage.applicationId, "usage applicationId"); utc(usage.observedAt, "usage observedAt");
    if (!this.#contracts.has(usage.apiVersion) || !Number.isSafeInteger(usage.requestCount) || usage.requestCount < 0 || !Number.isSafeInteger(usage.errorCount) || usage.errorCount < 0 || usage.errorCount > usage.requestCount) throw new DeveloperPlatformError("VALIDATION_FAILED", "version usage record is invalid");
    this.#usage.push(Object.freeze(clone(usage)));
  }

  usageForPartner(partnerId: string): readonly VersionUsage[] { return Object.freeze(this.#usage.filter((usage) => usage.partnerId === partnerId).map(clone)); }

  planDeprecation(plan: DeprecationPlan): void {
    if (!this.#contracts.has(plan.version) || !this.#contracts.has(plan.replacementVersion)) throw new DeveloperPlatformError("NOT_FOUND", "deprecation version or replacement is not registered");
    utc(plan.announcedAt, "announcedAt"); utc(plan.retiresAt, "retiresAt"); unique(plan.criticalPartnerIds, "critical partners");
    const days = (Date.parse(plan.retiresAt) - Date.parse(plan.announcedAt)) / 86_400_000;
    const minimum = plan.emergencySecurityException ? this.policy.securityEmergencyMinimumDays : this.policy.minimumDeprecationDays;
    if (days < minimum || !/^[a-f0-9]{64}$/u.test(plan.migrationGuideSha256) || !/^[a-f0-9]{64}$/u.test(plan.rollbackPlanSha256) || !plan.sandboxAvailable || !plan.harnessAvailable || !plan.parallelRunSupported) throw new DeveloperPlatformError("POLICY_BLOCKED", "deprecation lacks notice, replacement, migration, sandbox, harness, parallel run, or rollback controls");
    if (plan.criticalPartnerIds.some((partnerId) => !plan.acknowledgements.includes(partnerId))) throw new DeveloperPlatformError("POLICY_BLOCKED", "every critical partner must acknowledge or submit an upgrade plan");
    this.#deprecations.set(plan.version, Object.freeze(clone(plan)));
  }

  upgradeWork(partnerId: string): readonly Readonly<{ applicationId: string; version: string; requestCount: number; errorCount: number; action: "UPGRADE_REMINDER" | "SUPPORT_TASK" }>[] {
    const byApp = new Map<string, VersionUsage>();
    for (const usage of this.#usage.filter((entry) => entry.partnerId === partnerId && this.#deprecations.has(entry.apiVersion))) {
      const key = `${usage.applicationId}:${usage.apiVersion}`; const previous = byApp.get(key);
      if (previous === undefined || Date.parse(usage.observedAt) > Date.parse(previous.observedAt)) byApp.set(key, usage);
    }
    return Object.freeze([...byApp.values()].map((usage) => Object.freeze({ applicationId: usage.applicationId, version: usage.apiVersion, requestCount: usage.requestCount, errorCount: usage.errorCount, action: usage.errorCount > 0 ? "SUPPORT_TASK" as const : "UPGRADE_REMINDER" as const })));
  }

  defineSla(sla: SupportSla): void {
    if (!Number.isSafeInteger(sla.responseMinutes) || sla.responseMinutes < 1 || !Number.isSafeInteger(sla.updateMinutes) || sla.updateMinutes < sla.responseMinutes) throw new DeveloperPlatformError("VALIDATION_FAILED", "support SLA is invalid");
    if (this.#slas.some((entry) => entry.tier === sla.tier && entry.severity === sla.severity && entry.component === sla.component)) throw new DeveloperPlatformError("CONFLICT", "support SLA is duplicated");
    this.#slas.push(Object.freeze(clone(sla)));
  }

  updateStatus(status: ComponentStatus): void {
    utc(status.observedAt, "component observedAt");
    if (!Number.isSafeInteger(status.uptimeBasisPoints) || status.uptimeBasisPoints < 0 || status.uptimeBasisPoints > 10_000 || (status.status === "OUTAGE" && status.incidentId === undefined)) throw new DeveloperPlatformError("VALIDATION_FAILED", "developer status must publish bounded uptime and link outages to an incident");
    if (status.incidentId !== undefined) required(status.incidentId, "incident id");
    this.#statuses.set(status.component, Object.freeze(clone(status)));
  }

  statusPage(): { readonly components: readonly ComponentStatus[]; readonly slas: readonly SupportSla[]; readonly generatedAt: string } {
    const missing = (["api", "webhook", "sandbox", "documentation", "sdk"] as const).filter((component) => !this.#statuses.has(component));
    if (missing.length > 0) throw new DeveloperPlatformError("POLICY_BLOCKED", `developer status page is missing ${missing.join(",")}`);
    if (this.#slas.length === 0) throw new DeveloperPlatformError("POLICY_BLOCKED", "developer status page has no support SLA");
    return Object.freeze({ components: Object.freeze([...this.#statuses.values()].map(clone)), slas: Object.freeze(this.#slas.map(clone)), generatedAt: this.now().toISOString() });
  }
}

function validateContract(contract: ApiContract): void {
  if (!/^\d+\.\d+\.\d+$/u.test(contract.version) || Object.keys(contract.paths).length === 0 || Object.keys(contract.schemas).length === 0 || Object.keys(contract.events).length === 0 || Object.keys(contract.sdkVersions).length < 3) throw new DeveloperPlatformError("VALIDATION_FAILED", "API contract is incomplete");
  for (const methods of Object.values(contract.paths)) unique(methods, "API path methods");
  for (const fields of Object.values(contract.schemas)) if (Object.keys(fields).length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", "API schema has no fields");
}

function compareContracts(previous: ApiContract, next: ApiContract): CompatibilityReport {
  const breaking: string[] = []; const additive: string[] = [];
  for (const [path, methods] of Object.entries(previous.paths)) {
    if (next.paths[path] === undefined) breaking.push(`path removed: ${path}`);
    else for (const method of methods) if (!next.paths[path]?.includes(method)) breaking.push(`method removed: ${method} ${path}`);
  }
  for (const [path, methods] of Object.entries(next.paths)) if (previous.paths[path] === undefined) additive.push(`path added: ${path}`); else for (const method of methods) if (!previous.paths[path]?.includes(method)) additive.push(`method added: ${method} ${path}`);
  for (const [schema, fields] of Object.entries(previous.schemas)) for (const [field, definition] of Object.entries(fields)) {
    const candidate = next.schemas[schema]?.[field];
    if (candidate === undefined || candidate.type !== definition.type || (definition.required && !candidate.required)) breaking.push(`schema field removed or weakened: ${schema}.${field}`);
  }
  for (const [schema, fields] of Object.entries(next.schemas)) for (const [field, definition] of Object.entries(fields)) if (previous.schemas[schema]?.[field] === undefined) (definition.required ? breaking : additive).push(`schema field ${definition.required ? "required" : "added"}: ${schema}.${field}`);
  for (const [event, fields] of Object.entries(previous.events)) {
    if (next.events[event] === undefined) breaking.push(`event removed: ${event}`);
    else for (const field of fields) if (!next.events[event]?.includes(field)) breaking.push(`event field removed: ${event}.${field}`);
  }
  const base = { fromVersion: previous.version, toVersion: next.version, breakingChanges: Object.freeze(breaking), additiveChanges: Object.freeze(additive) };
  return Object.freeze({ ...base, reportSha256: digest(base) });
}
function major(version: string): number { return Number.parseInt(version.split(".")[0] as string, 10); }
function semverCompare(left: string, right: string): number { const l = left.split(".").map(Number); const r = right.split(".").map(Number); for (let index = 0; index < 3; index += 1) { const delta = (l[index] ?? 0) - (r[index] ?? 0); if (delta !== 0) return delta; } return 0; }
