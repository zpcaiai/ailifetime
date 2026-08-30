import { clone, DeveloperPlatformError, digest, redact, required, utc, unique } from "./common.js";

export const PORTAL_SECTIONS = ["getting-started", "authentication", "api", "webhooks", "sdks", "errors", "rate-limits", "versions", "examples", "security-consent"] as const;
export type PortalSection = (typeof PORTAL_SECTIONS)[number];

export interface DeveloperDocumentationContract {
  readonly version: string;
  readonly openApiSha256: string;
  readonly eventContractSha256: string;
  readonly permissionContractSha256: string;
  readonly sections: Readonly<Record<PortalSection, string>>;
  readonly examples: readonly Readonly<{ language: string; title: string; source: string; links: readonly string[] }>[];
  readonly errorCodes: readonly string[];
  readonly rateLimits: Readonly<Record<string, number>>;
  readonly sdkVersions: Readonly<Record<string, string>>;
}

export interface BuiltDeveloperDocumentation extends DeveloperDocumentationContract {
  readonly contractSha256: string;
  readonly generatedAt: string;
}

export class DeveloperDocumentationBuilder {
  build(contract: DeveloperDocumentationContract, generatedAt: string): BuiltDeveloperDocumentation {
    required(contract.version, "documentation version"); utc(generatedAt, "generatedAt");
    for (const [field, value] of [["openApiSha256", contract.openApiSha256], ["eventContractSha256", contract.eventContractSha256], ["permissionContractSha256", contract.permissionContractSha256]] as const) {
      if (!/^[a-f0-9]{64}$/u.test(value)) throw new DeveloperPlatformError("VALIDATION_FAILED", `${field} is invalid`);
    }
    for (const section of PORTAL_SECTIONS) if (contract.sections[section].trim().length < 20) throw new DeveloperPlatformError("VALIDATION_FAILED", `portal section ${section} is incomplete`);
    unique(contract.errorCodes, "error codes");
    if (Object.keys(contract.rateLimits).length === 0 || Object.values(contract.rateLimits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) throw new DeveloperPlatformError("VALIDATION_FAILED", "rate limit contract is invalid");
    if (Object.keys(contract.sdkVersions).length < 3) throw new DeveloperPlatformError("VALIDATION_FAILED", "documentation must publish at least three SDK versions");
    for (const example of contract.examples) {
      required(example.language, "example language"); required(example.title, "example title");
      if (/\b(?:sk_live|prod[_-]?secret|authorization:\s*bearer\s+[a-z0-9._-]{12,})/iu.test(example.source)) throw new DeveloperPlatformError("POLICY_BLOCKED", "documentation example contains a credential-like value");
      for (const link of example.links) if (!PORTAL_SECTIONS.some((section) => link === `#${section}`)) throw new DeveloperPlatformError("VALIDATION_FAILED", `documentation link ${link} is broken`);
      if (!/idempotency/i.test(example.source)) throw new DeveloperPlatformError("VALIDATION_FAILED", "write examples must demonstrate idempotency");
    }
    const snapshot = clone(contract);
    return Object.freeze({ ...snapshot, generatedAt, contractSha256: digest(snapshot) });
  }

  assertCompatible(previous: DeveloperDocumentationContract, next: DeveloperDocumentationContract): void {
    const previousMajor = Number.parseInt(previous.version.split(".")[0] ?? "", 10);
    const nextMajor = Number.parseInt(next.version.split(".")[0] ?? "", 10);
    const removedErrors = previous.errorCodes.filter((code) => !next.errorCodes.includes(code));
    const removedSdks = Object.keys(previous.sdkVersions).filter((sdk) => next.sdkVersions[sdk] === undefined);
    if ((removedErrors.length > 0 || removedSdks.length > 0 || previous.openApiSha256 !== next.openApiSha256) && nextMajor <= previousMajor) {
      throw new DeveloperPlatformError("CONFLICT", "breaking documentation contract change requires a new major version and migration guide");
    }
  }
}

export type SandboxScenario = "success" | "failure" | "duplicate" | "out_of_order" | "timeout" | "cancelled" | "refunded" | "consent_revoked" | "deleted" | "rate_limited" | "security_denied";
export interface SandboxPrincipal {
  readonly partnerId: string;
  readonly actorId: string;
  readonly roles: readonly ("partner_admin" | "developer" | "viewer")[];
  readonly agreementsAccepted: boolean;
  readonly securityBoundaryAccepted: boolean;
}

export interface SandboxApplication {
  readonly id: string;
  readonly partnerId: string;
  readonly name: string;
  readonly scenario: SandboxScenario;
  readonly generation: number;
  readonly createdAt: string;
}

export interface SandboxFixture {
  readonly personId: `syn_person_${string}`;
  readonly mediaId: `syn_media_${string}`;
  readonly paymentId: `syn_payment_${string}`;
  readonly shipmentId: `syn_shipment_${string}`;
  readonly callbackId: `syn_callback_${string}`;
  readonly synthetic: true;
}

export interface SandboxLog {
  readonly id: string;
  readonly applicationId: string;
  readonly occurredAt: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly status: number;
}

export interface SimulatedSandboxEvent {
  readonly eventId: string;
  readonly applicationId: string;
  readonly scenario: SandboxScenario;
  readonly sequence: number;
  readonly outcome: "success" | "failure" | "pending";
  readonly occurredAt: string;
  readonly synthetic: true;
}

export class DeveloperSandbox {
  readonly #applications = new Map<string, SandboxApplication>();
  readonly #logs = new Map<string, SandboxLog[]>();
  readonly #events = new Map<string, SimulatedSandboxEvent[]>();
  readonly #idempotency = new Map<string, { fingerprint: string; application: SandboxApplication }>();

  constructor(readonly now: () => Date = () => new Date()) {}

  createApplication(input: { readonly idempotencyKey: string; readonly applicationId: string; readonly name: string; readonly scenario: SandboxScenario }, principal: SandboxPrincipal): SandboxApplication {
    authorize(principal, "partner_admin"); required(input.idempotencyKey, "idempotency key"); required(input.applicationId, "applicationId"); required(input.name, "application name");
    if (!principal.agreementsAccepted || !principal.securityBoundaryAccepted) throw new DeveloperPlatformError("POLICY_BLOCKED", "agreement and security-boundary confirmation are required");
    const requestDigest = digest({ ...input, partnerId: principal.partnerId });
    const key = `${principal.partnerId}:${input.idempotencyKey}`;
    const previous = this.#idempotency.get(key);
    if (previous !== undefined) {
      if (previous.fingerprint !== requestDigest) throw new DeveloperPlatformError("CONFLICT", "idempotency key was reused with a changed request");
      return previous.application;
    }
    if (this.#applications.has(input.applicationId)) throw new DeveloperPlatformError("CONFLICT", "sandbox application id already exists");
    const application = Object.freeze({ id: input.applicationId, partnerId: principal.partnerId, name: input.name, scenario: input.scenario, generation: 1, createdAt: this.now().toISOString() });
    this.#applications.set(application.id, application); this.#logs.set(application.id, []); this.#events.set(application.id, []);
    this.#idempotency.set(key, { fingerprint: requestDigest, application });
    return application;
  }

  fixture(applicationId: string, principal: SandboxPrincipal): SandboxFixture {
    const application = this.#application(applicationId, principal);
    const suffix = digest(`${application.id}:${application.generation}`).slice(0, 12);
    return Object.freeze({ personId: `syn_person_${suffix}`, mediaId: `syn_media_${suffix}`, paymentId: `syn_payment_${suffix}`, shipmentId: `syn_shipment_${suffix}`, callbackId: `syn_callback_${suffix}`, synthetic: true });
  }

  selectScenario(applicationId: string, scenario: SandboxScenario, principal: SandboxPrincipal): SandboxApplication {
    authorize(principal, "developer");
    const current = this.#application(applicationId, principal);
    const next = Object.freeze({ ...current, scenario });
    this.#applications.set(applicationId, next);
    return next;
  }

  reset(applicationId: string, principal: SandboxPrincipal): SandboxApplication {
    authorize(principal, "partner_admin");
    const current = this.#application(applicationId, principal);
    const next = Object.freeze({ ...current, generation: current.generation + 1 });
    this.#applications.set(applicationId, next); this.#logs.set(applicationId, []); this.#events.set(applicationId, []);
    return next;
  }

  recordRequest(input: Omit<SandboxLog, "id" | "occurredAt">, principal: SandboxPrincipal): SandboxLog {
    this.#application(input.applicationId, principal);
    if (!Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599) throw new DeveloperPlatformError("VALIDATION_FAILED", "sandbox response status is invalid");
    const logs = this.#logs.get(input.applicationId) as SandboxLog[];
    const log = Object.freeze({ id: `sandbox-log-${logs.length + 1}`, applicationId: input.applicationId, occurredAt: this.now().toISOString(), request: redact(clone(input.request)), response: redact(clone(input.response)), status: input.status });
    logs.push(log);
    return log;
  }

  simulate(applicationId: string, principal: SandboxPrincipal): readonly SimulatedSandboxEvent[] {
    const application = this.#application(applicationId, principal);
    const events = this.#events.get(applicationId) as SimulatedSandboxEvent[];
    if (events.length > 0) return Object.freeze(events.map(clone));
    const order = application.scenario === "out_of_order" ? [2, 1] : application.scenario === "duplicate" ? [1, 1] : [1];
    for (const sequence of order) {
      const outcome = application.scenario === "success" || application.scenario === "duplicate" || application.scenario === "out_of_order" ? "success" : application.scenario === "timeout" ? "pending" : "failure";
      events.push(Object.freeze({ eventId: `syn_event_${application.id}_${sequence}`, applicationId, scenario: application.scenario, sequence, outcome, occurredAt: this.now().toISOString(), synthetic: true }));
    }
    return Object.freeze(events.map(clone));
  }

  logs(applicationId: string, principal: SandboxPrincipal): readonly SandboxLog[] {
    this.#application(applicationId, principal);
    return Object.freeze((this.#logs.get(applicationId) ?? []).map(clone));
  }

  #application(applicationId: string, principal: SandboxPrincipal): SandboxApplication {
    const application = this.#applications.get(applicationId);
    if (application === undefined) throw new DeveloperPlatformError("NOT_FOUND", "sandbox application does not exist");
    if (application.partnerId !== principal.partnerId) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", "cross-partner sandbox access is forbidden");
    return application;
  }
}

function authorize(principal: SandboxPrincipal, role: "partner_admin" | "developer" | "viewer"): void {
  required(principal.partnerId, "partnerId"); required(principal.actorId, "actorId");
  const rank = { viewer: 0, developer: 1, partner_admin: 2 } as const;
  if (!principal.roles.some((candidate) => rank[candidate] >= rank[role])) throw new DeveloperPlatformError("AUTHORIZATION_DENIED", `sandbox role ${role} is required`);
}
