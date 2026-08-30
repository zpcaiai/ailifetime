import { createHash, verify } from "node:crypto";

export class OrchestrationError extends Error {
  constructor(
    readonly code: "VALIDATION_FAILED" | "NO_ELIGIBLE_PROVIDER" | "BUDGET_EXCEEDED" | "CONFLICT" | "DEPENDENCY_FAILED" | "AUTHORIZATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}

export interface ProviderDefinition {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly regions: readonly string[];
  readonly allowedForMinors: boolean;
  readonly dataCategories: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly retentionDays: number;
  readonly trainingUseAllowed: boolean;
  readonly supportsDeletion: boolean;
  readonly costPerUnitMinor: number;
  readonly maximumConcurrency: number;
  readonly canaryBasisPoints: number;
  readonly healthAuthority: string;
  readonly healthKeyId: string;
  readonly healthPublicKeyPem: string;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly observedAt: string;
  readonly state: "healthy" | "degraded" | "unavailable";
  readonly p95LatencyMs: number;
  readonly errorRate: number;
  readonly capacityAvailable: number;
  readonly authority: string;
  readonly keyId: string;
  readonly artifactSha256: string;
  readonly signature: string;
}

export interface ProviderHealthProbe {
  probe(provider: ProviderDefinition): Promise<ProviderHealth>;
}

export interface RouteRequest {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly capability: string;
  readonly region: string;
  readonly participantMinor: boolean;
  readonly dataCategories: readonly string[];
  readonly consentPurposes: readonly string[];
  readonly requiredPurposes: readonly string[];
  readonly units: number;
  readonly maxCostMinor: number;
  readonly maximumRetentionDays: number;
  readonly requestId: string;
  readonly excludeProviderIds?: readonly string[];
}

export interface ProviderRoute {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly estimatedCostMinor: number;
  readonly reason: string;
  readonly healthArtifactSha256: string;
}

interface Runtime {
  definition: ProviderDefinition;
  health?: ProviderHealth;
  failures: number[];
  active: number;
  spentDay: { day: string; minor: number };
  dailyBudgetMinor: number;
}

export class ProviderControlPlane {
  readonly #providers = new Map<string, Runtime>();

  constructor(
    readonly probe: ProviderHealthProbe,
    readonly now: () => Date = () => new Date(),
  ) {}

  register(definition: ProviderDefinition, dailyBudgetMinor: number): void {
    if (
      !/^[a-z][a-z0-9-]+$/u.test(definition.id)
      || definition.capabilities.length === 0
      || definition.regions.length === 0
      || definition.dataCategories.length === 0
      || definition.allowedPurposes.length === 0
      || !Number.isSafeInteger(definition.retentionDays)
      || definition.retentionDays < 0
      || !Number.isSafeInteger(definition.costPerUnitMinor)
      || definition.costPerUnitMinor < 0
      || !Number.isSafeInteger(definition.maximumConcurrency)
      || definition.maximumConcurrency < 1
      || !Number.isSafeInteger(definition.canaryBasisPoints)
      || definition.canaryBasisPoints < 0
      || definition.canaryBasisPoints > 10_000
      || !Number.isSafeInteger(dailyBudgetMinor)
      || dailyBudgetMinor < 0
      || definition.healthAuthority.trim() === ""
      || definition.healthKeyId.trim() === ""
      || !definition.healthPublicKeyPem.includes("PUBLIC KEY")
    ) {
      throw new OrchestrationError("VALIDATION_FAILED", "provider definition is invalid");
    }
    if (this.#providers.has(definition.id)) {
      throw new OrchestrationError("CONFLICT", "provider already exists");
    }
    this.#providers.set(definition.id, {
      definition: Object.freeze(structuredClone(definition)),
      failures: [],
      active: 0,
      spentDay: { day: this.now().toISOString().slice(0, 10), minor: 0 },
      dailyBudgetMinor,
    });
  }

  async refresh(): Promise<readonly ProviderHealth[]> {
    const health = await Promise.all([...this.#providers.values()].map(async (runtime) => {
      const value = await this.probe.probe(runtime.definition);
      const signedPayload = providerHealthPayload(value);
      const signature = decodeBase64Url(value.signature);
      const validSignature = value.authority === runtime.definition.healthAuthority
        && value.keyId === runtime.definition.healthKeyId
        && verify(null, Buffer.from(signedPayload), runtime.definition.healthPublicKeyPem, signature);
      if (
        value.providerId !== runtime.definition.id
        || value.authority.trim() === ""
        || value.keyId.trim() === ""
        || !strictUtc(value.observedAt)
        || !Number.isFinite(value.errorRate)
        || value.errorRate < 0
        || value.errorRate > 1
        || !Number.isFinite(value.p95LatencyMs)
        || value.p95LatencyMs < 0
        || !Number.isSafeInteger(value.capacityAvailable)
        || value.capacityAvailable < 0
        || !/^[a-f0-9]{64}$/u.test(value.artifactSha256)
        || value.artifactSha256 !== sha256(signedPayload)
        || !validSignature
      ) {
        throw new OrchestrationError("DEPENDENCY_FAILED", "provider health probe returned an invalid signed observation");
      }
      runtime.health = Object.freeze(structuredClone(value));
      return runtime.health;
    }));
    return Object.freeze(health);
  }

  route(request: RouteRequest): ProviderRoute {
    if (
      request.tenantId.trim() === ""
      || request.subjectId.trim() === ""
      || !Number.isSafeInteger(request.units)
      || request.units < 1
      || !Number.isSafeInteger(request.maxCostMinor)
      || request.maxCostMinor < 0
      || !Number.isSafeInteger(request.maximumRetentionDays)
      || request.maximumRetentionDays < 0
      || request.requiredPurposes.some((purpose) => !request.consentPurposes.includes(purpose))
    ) {
      throw new OrchestrationError("VALIDATION_FAILED", "route identity, units, budget, retention, or purpose grants are invalid");
    }
    const excluded = new Set(request.excludeProviderIds ?? []);
    const eligible = [...this.#providers.values()].filter((runtime) => {
      this.#rollDay(runtime);
      const health = runtime.health;
      const circuitOpen = runtime.failures.filter((time) => time > this.now().getTime() - 60_000).length >= 3;
      const estimate = runtime.definition.costPerUnitMinor * request.units;
      return !excluded.has(runtime.definition.id)
        && health !== undefined
        && health.state !== "unavailable"
        && Date.parse(health.observedAt) > this.now().getTime() - 120_000
        && Date.parse(health.observedAt) <= this.now().getTime() + 5_000
        && runtime.definition.capabilities.includes(request.capability)
        && runtime.definition.regions.includes(request.region)
        && (!request.participantMinor || runtime.definition.allowedForMinors)
        && request.dataCategories.every((category) => runtime.definition.dataCategories.includes(category))
        && request.requiredPurposes.every((purpose) => runtime.definition.allowedPurposes.includes(purpose))
        && runtime.definition.retentionDays <= request.maximumRetentionDays
        && !runtime.definition.trainingUseAllowed
        && runtime.definition.supportsDeletion
        && !circuitOpen
        && runtime.active < Math.min(runtime.definition.maximumConcurrency, health.capacityAvailable)
        && estimate <= request.maxCostMinor
        && runtime.spentDay.minor + estimate <= runtime.dailyBudgetMinor
        && canaryAllows(runtime.definition.canaryBasisPoints, request.requestId);
    }).sort((left, right) => score(left) - score(right));
    const selected = eligible[0];
    if (selected === undefined) {
      throw new OrchestrationError("NO_ELIGIBLE_PROVIDER", "no healthy provider satisfies region, consent, minor safety, data, retention, canary, capacity, circuit, latency, and budget constraints");
    }
    const estimatedCostMinor = selected.definition.costPerUnitMinor * request.units;
    selected.active += 1;
    selected.spentDay.minor += estimatedCostMinor;
    return Object.freeze({
      providerId: selected.definition.id,
      providerVersion: selected.definition.version,
      estimatedCostMinor,
      reason: "signed_health_budget_consent_residency_route",
      healthArtifactSha256: (selected.health as ProviderHealth).artifactSha256,
    });
  }

  complete(providerId: string, succeeded: boolean): void {
    const runtime = this.#providers.get(providerId);
    if (runtime === undefined || runtime.active < 1) {
      throw new OrchestrationError("CONFLICT", "provider operation was not reserved");
    }
    runtime.active -= 1;
    if (!succeeded) runtime.failures.push(this.now().getTime());
  }

  #rollDay(runtime: Runtime): void {
    const day = this.now().toISOString().slice(0, 10);
    if (runtime.spentDay.day !== day) runtime.spentDay = { day, minor: 0 };
  }
}

export function providerHealthPayload(value: Omit<ProviderHealth, "signature" | "artifactSha256">): string;
export function providerHealthPayload(value: ProviderHealth): string;
export function providerHealthPayload(value: ProviderHealth | Omit<ProviderHealth, "signature" | "artifactSha256">): string {
  return JSON.stringify({
    authority: value.authority,
    capacityAvailable: value.capacityAvailable,
    errorRate: value.errorRate,
    keyId: value.keyId,
    observedAt: value.observedAt,
    p95LatencyMs: value.p95LatencyMs,
    providerId: value.providerId,
    state: value.state,
  });
}

function score(runtime: Runtime): number {
  return (runtime.health?.p95LatencyMs ?? Number.MAX_SAFE_INTEGER)
    + runtime.definition.costPerUnitMinor * 10
    + (runtime.health?.errorRate ?? 1) * 10_000;
}

function canaryAllows(basisPoints: number, requestId: string): boolean {
  if (basisPoints === 10_000) return true;
  if (basisPoints === 0) return false;
  const bucket = Number.parseInt(createHash("sha256").update(requestId).digest("hex").slice(0, 8), 16) % 10_000;
  return bucket < basisPoints;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return Buffer.alloc(0);
  return Buffer.from(value, "base64url");
}
