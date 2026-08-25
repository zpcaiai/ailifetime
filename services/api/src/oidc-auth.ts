import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWSAlgorithm, JWTVerifyGetKey, JWTPayload } from "jose";
import { DomainError } from "@ltm/core";
import type { ActorContext, Role } from "@ltm/core";
import type { AuthenticationRequest, RequestAuthenticator } from "./auth.js";

const INTERNAL_ROLES = new Set<Role>([
  "consumer", "household_admin", "guardian", "partner_employee", "partner_admin",
  "studio_operator", "support_agent", "moderator", "privacy_officer", "finance_operator",
  "platform_admin", "auditor", "service_account",
]);

export type OidcAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

export interface OidcAuthenticatorOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: URL;
  readonly algorithms: readonly OidcAlgorithm[];
  readonly tokenType?: string;
  readonly maximumTokenAgeSeconds?: number;
  readonly clockToleranceSeconds?: number;
  readonly tenantClaim?: string;
  readonly rolesClaim?: string;
  readonly permissionsClaim?: string;
  readonly purposesClaim?: string;
  readonly roleMap?: Readonly<Record<string, Role>>;
  readonly stepUpAcrValues?: readonly string[];
  readonly guardianVerifiedClaim?: string;
}

/** OIDC access-token authenticator with pinned issuer, audience, typ, algorithms and claim mapping. */
export class OidcAuthenticator implements RequestAuthenticator {
  readonly #keyResolver: JWTVerifyGetKey;
  readonly #maximumTokenAge: number;
  readonly #clockTolerance: number;
  readonly #tenantClaim: string;
  readonly #rolesClaim: string;
  readonly #permissionsClaim: string;
  readonly #purposesClaim: string;

  constructor(
    private readonly options: OidcAuthenticatorOptions,
    keyResolver?: JWTVerifyGetKey,
  ) {
    const issuer = strictHttpsUrl(options.issuer, "OIDC issuer", true);
    if (issuer.toString().replace(/\/$/, "") !== options.issuer.replace(/\/$/, "")) {
      throw new DomainError("CONFIGURATION_INVALID", "OIDC issuer must be a canonical HTTPS URL");
    }
    const jwksUrl = strictHttpsUrl(options.jwksUrl.toString(), "OIDC JWKS URL", false);
    if (jwksUrl.origin !== issuer.origin) {
      throw new DomainError("CONFIGURATION_INVALID", "OIDC JWKS URL must share the trusted issuer origin");
    }
    visible(options.audience, "OIDC audience", 512);
    if (options.algorithms.length === 0 || new Set(options.algorithms).size !== options.algorithms.length) {
      throw new DomainError("CONFIGURATION_INVALID", "OIDC algorithms must be a non-empty unique allowlist");
    }
    this.#maximumTokenAge = boundedInteger(options.maximumTokenAgeSeconds ?? 900, 60, 3_600, "OIDC maximum token age");
    this.#clockTolerance = boundedInteger(options.clockToleranceSeconds ?? 5, 0, 60, "OIDC clock tolerance");
    this.#tenantClaim = claimName(options.tenantClaim ?? "tenant_id");
    this.#rolesClaim = claimName(options.rolesClaim ?? "roles");
    this.#permissionsClaim = claimName(options.permissionsClaim ?? "permissions");
    this.#purposesClaim = claimName(options.purposesClaim ?? "purposes");
    if (options.guardianVerifiedClaim !== undefined) claimName(options.guardianVerifiedClaim);
    for (const acr of options.stepUpAcrValues ?? []) visible(acr, "OIDC ACR value", 256);
    if (options.roleMap !== undefined) {
      for (const [external, internal] of Object.entries(options.roleMap)) {
        visible(external, "OIDC external role", 256);
        if (!INTERNAL_ROLES.has(internal)) throw new DomainError("CONFIGURATION_INVALID", "OIDC role map contains an invalid internal role");
      }
    }
    this.#keyResolver = keyResolver ?? createRemoteJWKSet(options.jwksUrl, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  async authenticate(request: AuthenticationRequest): Promise<ActorContext> {
    const match = /^Bearer ([^\s]+)$/i.exec(request.authorization ?? "");
    const token = match?.[1];
    if (token === undefined || token.length < 32 || token.length > 16_384) {
      throw new DomainError("AUTH_UNAUTHENTICATED", "A valid OIDC bearer token is required");
    }
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.#keyResolver, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [...this.options.algorithms] as JWSAlgorithm[],
        typ: this.options.tokenType ?? "at+jwt",
        maxTokenAge: this.#maximumTokenAge,
        clockTolerance: this.#clockTolerance,
        requiredClaims: ["sub", "exp", "iat", this.#tenantClaim, this.#rolesClaim, this.#purposesClaim],
      });
      payload = verified.payload;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_FETCH_FAILED") {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "OIDC signing keys are temporarily unavailable", { retryable: true });
      }
      throw new DomainError("AUTH_UNAUTHENTICATED", "OIDC bearer token verification failed");
    }
    const actorId = visibleClaim(payload.sub, "OIDC sub", 128);
    const tenantId = visibleClaim(payload[this.#tenantClaim], `OIDC ${this.#tenantClaim}`, 128);
    const externalRoles = stringArrayClaim(payload[this.#rolesClaim], this.#rolesClaim, 32, 256);
    const roles = externalRoles.map((role) => {
      const mapped = this.options.roleMap?.[role] ?? (INTERNAL_ROLES.has(role as Role) ? role as Role : undefined);
      if (mapped === undefined) throw new DomainError("AUTH_FORBIDDEN", "OIDC token contains an unmapped role");
      return mapped;
    });
    if (roles.length === 0 || new Set(roles).size !== roles.length) {
      throw new DomainError("AUTH_FORBIDDEN", "OIDC token must resolve to unique internal roles");
    }
    const allowedPurposes = stringArrayClaim(payload[this.#purposesClaim], this.#purposesClaim, 32, 120);
    const purpose = visible(request.purpose ?? "", "x-purpose", 120);
    if (!allowedPurposes.includes("*") && !allowedPurposes.includes(purpose)) {
      throw new DomainError("AUTH_FORBIDDEN", "OIDC principal is not authorized for this purpose");
    }
    const permissions = payload[this.#permissionsClaim] === undefined
      ? undefined
      : stringArrayClaim(payload[this.#permissionsClaim], this.#permissionsClaim, 256, 160);
    const acr = typeof payload.acr === "string" ? payload.acr : undefined;
    const amr = Array.isArray(payload.amr) && payload.amr.every((item) => typeof item === "string")
      ? payload.amr as string[]
      : [];
    const stepUp = (acr !== undefined && (this.options.stepUpAcrValues ?? []).includes(acr)) || amr.includes("mfa");
    const guardianVerified = this.options.guardianVerifiedClaim === undefined
      ? false
      : payload[this.options.guardianVerifiedClaim] === true;
    return {
      actorId,
      tenantId,
      roles,
      purpose,
      requestId: request.requestId,
      ...(permissions === undefined ? {} : { permissions }),
      ...(stepUp ? { stepUp: true } : {}),
      ...(guardianVerified ? { guardianVerified: true } : {}),
    };
  }
}

function strictHttpsUrl(value: string, label: string, allowPath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      (!allowPath && url.pathname === "/")) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be a credential-free canonical HTTPS URL`);
  }
  return url;
}

function claimName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new DomainError("CONFIGURATION_INVALID", "OIDC claim name is invalid");
  }
  return value;
}

function stringArrayClaim(value: unknown, label: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new DomainError("AUTH_FORBIDDEN", `OIDC ${label} must be a non-empty bounded string array`);
  }
  const result = value.map((item) => visibleClaim(item, `OIDC ${label}`, maximumLength));
  if (new Set(result).size !== result.length) throw new DomainError("AUTH_FORBIDDEN", `OIDC ${label} must not contain duplicates`);
  return result;
}

function visibleClaim(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("AUTH_FORBIDDEN", `${label} must be a string`);
  return visible(value, label, maximum);
}

function visible(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
