import { clone, DeveloperPlatformError, digest, redact, required, utc, unique } from "./common.js";

export const CERTIFICATION_SCENARIOS = ["happy_path", "duplicate", "out_of_order", "timeout", "cancelled", "refunded", "consent_revoked", "deleted", "rate_limited", "security_negative"] as const;
export type CertificationScenario = (typeof CERTIFICATION_SCENARIOS)[number];
export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface PartnerHarnessTarget {
  execute(input: { readonly scenario: CertificationScenario; readonly fixture: SyntheticPartnerFixture }): Promise<{
    readonly request: unknown;
    readonly response: unknown;
    readonly events: readonly unknown[];
    readonly signatures: readonly string[];
    readonly retries: number;
    readonly assertions: readonly { readonly id: string; readonly passed: boolean; readonly severity: FindingSeverity; readonly guidance: string }[];
  }>;
}

export interface SyntheticPartnerFixture {
  readonly personId: `synthetic-person-${string}`;
  readonly mediaId: `synthetic-media-${string}`;
  readonly orderId: `synthetic-order-${string}`;
  readonly shipmentId: `synthetic-shipment-${string}`;
  readonly resetGeneration: number;
  readonly synthetic: true;
}

export interface HarnessScenarioResult {
  readonly scenario: CertificationScenario;
  readonly request: unknown;
  readonly response: unknown;
  readonly events: readonly unknown[];
  readonly signatureDigests: readonly string[];
  readonly retries: number;
  readonly assertions: readonly { readonly id: string; readonly passed: boolean; readonly severity: FindingSeverity; readonly guidance: string }[];
}

export interface HarnessRun {
  readonly runId: string;
  readonly applicationId: string;
  readonly environment: "sandbox" | "staging";
  readonly apiVersion: string;
  readonly sdkVersion: string;
  readonly capabilities: readonly string[];
  readonly configurationSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: readonly HarnessScenarioResult[];
  readonly reportSha256: string;
}

export interface PartnerCertification {
  readonly certificationId: string;
  readonly applicationId: string;
  readonly environment: "sandbox" | "staging";
  readonly apiVersion: string;
  readonly sdkVersion: string;
  readonly capabilities: readonly string[];
  readonly configurationSha256: string;
  readonly runId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "ACTIVE" | "INVALIDATED";
  readonly invalidatedReason?: string;
}

interface Waiver { readonly findingId: string; readonly severity: "low" | "medium"; readonly approverIds: readonly string[]; readonly reason: string; readonly expiresAt: string; }

export class PartnerCertificationService {
  readonly #runs = new Map<string, HarnessRun>();
  readonly #certifications = new Map<string, PartnerCertification>();
  readonly #waivers = new Map<string, Waiver>();
  #generation = 1;

  constructor(readonly target: PartnerHarnessTarget, readonly now: () => Date = () => new Date()) {}

  fixture(seed: string): SyntheticPartnerFixture {
    required(seed, "fixture seed"); const suffix = digest(`${seed}:${this.#generation}`).slice(0, 16);
    return Object.freeze({ personId: `synthetic-person-${suffix}`, mediaId: `synthetic-media-${suffix}`, orderId: `synthetic-order-${suffix}`, shipmentId: `synthetic-shipment-${suffix}`, resetGeneration: this.#generation, synthetic: true });
  }

  reset(): number { this.#generation += 1; return this.#generation; }

  async run(input: { readonly runId: string; readonly applicationId: string; readonly environment: "sandbox" | "staging"; readonly apiVersion: string; readonly sdkVersion: string; readonly capabilities: readonly string[]; readonly configurationSha256: string }): Promise<HarnessRun> {
    required(input.runId, "run id"); required(input.applicationId, "application id"); required(input.apiVersion, "API version"); required(input.sdkVersion, "SDK version"); unique(input.capabilities, "certified capabilities");
    if (!/^[a-f0-9]{64}$/u.test(input.configurationSha256)) throw new DeveloperPlatformError("VALIDATION_FAILED", "certification configuration digest is invalid");
    if (this.#runs.has(input.runId)) throw new DeveloperPlatformError("CONFLICT", "harness run id already exists");
    const startedAt = this.now().toISOString(); const fixture = this.fixture(input.runId); const results: HarnessScenarioResult[] = [];
    for (const scenario of CERTIFICATION_SCENARIOS) {
      const raw = await this.target.execute({ scenario, fixture });
      if (!Number.isSafeInteger(raw.retries) || raw.retries < 0 || raw.retries > 5 || raw.assertions.length === 0) throw new DeveloperPlatformError("VALIDATION_FAILED", `scenario ${scenario} returned an invalid harness result`);
      for (const assertion of raw.assertions) { required(assertion.id, "assertion id"); required(assertion.guidance, "assertion guidance"); }
      results.push(Object.freeze({ scenario, request: redact(clone(raw.request)), response: redact(clone(raw.response)), events: Object.freeze(raw.events.map((event) => redact(clone(event)))), signatureDigests: Object.freeze(raw.signatures.map((signature) => digest(signature))), retries: raw.retries, assertions: Object.freeze(raw.assertions.map((assertion) => Object.freeze(clone(assertion)))) }));
    }
    const completedAt = this.now().toISOString();
    const report = { ...clone(input), startedAt, completedAt, results };
    const run: HarnessRun = Object.freeze({ ...report, results: Object.freeze(results), reportSha256: digest(report) });
    this.#runs.set(input.runId, run); return run;
  }

  waive(input: { readonly findingId: string; readonly severity: FindingSeverity; readonly approverIds: readonly string[]; readonly reason: string; readonly expiresAt: string }): void {
    required(input.findingId, "finding id"); required(input.reason, "waiver reason"); utc(input.expiresAt, "waiver expiresAt");
    if (input.severity === "high" || input.severity === "critical") throw new DeveloperPlatformError("POLICY_BLOCKED", "authorization, tenant, safety, or financial failures cannot be waived");
    if (new Set(input.approverIds).size < 2) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "waiver requires two independent approvers");
    this.#waivers.set(input.findingId, Object.freeze({ ...clone(input), severity: input.severity }));
  }

  issue(input: { readonly certificationId: string; readonly runId: string; readonly expiresAt: string }): PartnerCertification {
    required(input.certificationId, "certification id"); utc(input.expiresAt, "certification expiresAt");
    const run = this.#runs.get(input.runId); if (run === undefined) throw new DeveloperPlatformError("NOT_FOUND", "harness run does not exist");
    if (Date.parse(input.expiresAt) <= this.now().getTime()) throw new DeveloperPlatformError("VALIDATION_FAILED", "certification expiry must be in the future");
    const failed = run.results.flatMap((result) => result.assertions.filter((assertion) => !assertion.passed));
    for (const finding of failed) {
      const waiver = this.#waivers.get(finding.id);
      if (finding.severity === "high" || finding.severity === "critical" || waiver === undefined || Date.parse(waiver.expiresAt) <= this.now().getTime()) throw new DeveloperPlatformError("POLICY_BLOCKED", `certification finding ${finding.id} is unresolved`);
    }
    if (this.#certifications.has(input.certificationId)) throw new DeveloperPlatformError("CONFLICT", "certification id already exists");
    const certification: PartnerCertification = Object.freeze({ certificationId: input.certificationId, applicationId: run.applicationId, environment: run.environment, apiVersion: run.apiVersion, sdkVersion: run.sdkVersion, capabilities: Object.freeze([...run.capabilities]), configurationSha256: run.configurationSha256, runId: run.runId, issuedAt: this.now().toISOString(), expiresAt: input.expiresAt, state: "ACTIVE" });
    this.#certifications.set(input.certificationId, certification); return certification;
  }

  validate(certificationId: string, binding: { readonly applicationId: string; readonly environment: "sandbox" | "staging"; readonly apiVersion: string; readonly sdkVersion: string; readonly capabilities: readonly string[]; readonly configurationSha256: string }): PartnerCertification {
    const certification = this.#certifications.get(certificationId); if (certification === undefined) throw new DeveloperPlatformError("NOT_FOUND", "partner certification does not exist");
    if (certification.state !== "ACTIVE" || Date.parse(certification.expiresAt) <= this.now().getTime() || certification.applicationId !== binding.applicationId || certification.environment !== binding.environment || certification.apiVersion !== binding.apiVersion || certification.sdkVersion !== binding.sdkVersion || certification.configurationSha256 !== binding.configurationSha256 || digest(certification.capabilities) !== digest(binding.capabilities)) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "partner certification is inactive, expired, or no longer bound to the integration configuration");
    return certification;
  }

  invalidateForChange(applicationId: string, reason: string): number {
    required(reason, "invalidation reason"); let count = 0;
    for (const [id, certification] of this.#certifications) if (certification.applicationId === applicationId && certification.state === "ACTIVE") { this.#certifications.set(id, Object.freeze({ ...certification, state: "INVALIDATED", invalidatedReason: reason })); count += 1; }
    return count;
  }

  downloadRun(runId: string): string {
    const run = this.#runs.get(runId); if (run === undefined) throw new DeveloperPlatformError("NOT_FOUND", "harness run does not exist"); return JSON.stringify(run, null, 2);
  }
}
