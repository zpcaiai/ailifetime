import { createHash } from "node:crypto";
import { DomainError } from "@ltm/core";
import type { ActorContext, Role } from "@ltm/core";

export interface AuthenticationRequest {
  readonly authorization: string | undefined;
  readonly purpose: string | undefined;
  readonly requestId: string;
}

export interface RequestAuthenticator {
  authenticate(request: AuthenticationRequest): ActorContext | Promise<ActorContext>;
}

interface PrincipalFields {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly permissions?: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly stepUp?: boolean;
  readonly guardianVerified?: boolean;
}

export type StaticTokenPrincipal = PrincipalFields &
  (
    | { readonly token: string; readonly tokenSha256?: never }
    | { readonly token?: never; readonly tokenSha256: string }
  );

interface StoredPrincipal {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly permissions?: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly stepUp?: boolean;
  readonly guardianVerified?: boolean;
}

const ROLES = new Set<Role>([
  "consumer",
  "household_admin",
  "guardian",
  "partner_employee",
  "partner_admin",
  "studio_operator",
  "support_agent",
  "moderator",
  "privacy_officer",
  "finance_operator",
  "platform_admin",
  "auditor",
  "service_account",
]);

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function visibleText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return normalized;
}

export class StaticTokenAuthenticator implements RequestAuthenticator {
  readonly #principals = new Map<string, StoredPrincipal>();

  constructor(principals: readonly StaticTokenPrincipal[]) {
    if (principals.length === 0) {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "At least one server-side API principal must be configured");
    }
    for (const principal of principals) {
      const tokenDigest = principal.tokenSha256 === undefined
        ? digest(visibleText(principal.token, "API token", 4_096))
        : visibleText(principal.tokenSha256.toLowerCase(), "API token SHA-256", 64);
      if (principal.tokenSha256 === undefined && principal.token.length < 12) {
        throw new DomainError("VALIDATION_FAILED", "API tokens must contain at least 12 characters");
      }
      if (!/^[a-f0-9]{64}$/.test(tokenDigest)) {
        throw new DomainError("VALIDATION_FAILED", "API token SHA-256 must be a lowercase 64-character digest");
      }
      const actorId = visibleText(principal.actorId, "actorId", 128);
      const tenantId = visibleText(principal.tenantId, "tenantId", 128);
      if (principal.roles.length === 0 || principal.roles.some((role) => !ROLES.has(role))) {
        throw new DomainError("VALIDATION_FAILED", "Every API principal needs valid server-side roles");
      }
      if (principal.allowedPurposes.length === 0) {
        throw new DomainError("VALIDATION_FAILED", "Every API principal needs at least one allowed purpose");
      }
      const allowedPurposes = principal.allowedPurposes.map((purpose) => visibleText(purpose, "allowed purpose", 120));
      const permissions = principal.permissions?.map((permission) => visibleText(permission, "permission", 160));
      if (this.#principals.has(tokenDigest)) {
        throw new DomainError("VALIDATION_FAILED", "API tokens must be unique");
      }
      const stored: StoredPrincipal = {
        actorId,
        tenantId,
        roles: [...principal.roles],
        allowedPurposes,
        ...(permissions === undefined ? {} : { permissions }),
        ...(principal.stepUp === undefined ? {} : { stepUp: principal.stepUp }),
        ...(principal.guardianVerified === undefined ? {} : { guardianVerified: principal.guardianVerified }),
      };
      this.#principals.set(tokenDigest, stored);
    }
  }

  authenticate(request: AuthenticationRequest): ActorContext {
    const match = /^Bearer ([^\s]+)$/i.exec(request.authorization ?? "");
    if (match?.[1] === undefined) {
      throw new DomainError("AUTH_UNAUTHENTICATED", "A bearer token is required");
    }
    const principal = this.#principals.get(digest(match[1]));
    if (principal === undefined) {
      throw new DomainError("AUTH_UNAUTHENTICATED", "Bearer token is invalid");
    }
    const purpose = visibleText(request.purpose ?? "", "x-purpose", 120);
    if (!principal.allowedPurposes.includes("*") && !principal.allowedPurposes.includes(purpose)) {
      throw new DomainError("AUTH_FORBIDDEN", "The principal is not authorized for this purpose");
    }
    return {
      actorId: principal.actorId,
      tenantId: principal.tenantId,
      roles: principal.roles,
      purpose,
      requestId: request.requestId,
      ...(principal.permissions === undefined ? {} : { permissions: principal.permissions }),
      ...(principal.stepUp === undefined ? {} : { stepUp: principal.stepUp }),
      ...(principal.guardianVerified === undefined ? {} : { guardianVerified: principal.guardianVerified }),
    };
  }

  static fromEnvironment(serialized: string | undefined): StaticTokenAuthenticator {
    if (serialized === undefined || serialized.trim().length === 0) {
      throw new DomainError(
        "DEPENDENCY_UNAVAILABLE",
        "LTM_API_TOKENS_JSON is required; the API refuses to start without authentication principals",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new DomainError("VALIDATION_FAILED", "LTM_API_TOKENS_JSON must contain valid JSON");
    }
    if (!Array.isArray(value)) {
      throw new DomainError("VALIDATION_FAILED", "LTM_API_TOKENS_JSON must be an array");
    }
    const principals = value.map(parsePrincipal);
    if (principals.some((principal) => principal.token !== undefined && principal.token.length < 16)) {
      throw new DomainError("VALIDATION_FAILED", "Configured API tokens must contain at least 16 characters");
    }
    return new StaticTokenAuthenticator(principals);
  }

  static localSynthetic(appEnvironment: string | undefined): StaticTokenAuthenticator {
    if (appEnvironment?.trim().toLowerCase() === "production") {
      throw new DomainError(
        "DEPENDENCY_UNAVAILABLE",
        "LTM_AUTH_MODE=local-synthetic-only is forbidden when APP_ENV=production",
      );
    }
    return new StaticTokenAuthenticator([
      {
        token: "local-consumer",
        actorId: "user-synthetic",
        tenantId: "tenant-local",
        roles: ["consumer"],
        allowedPurposes: ["*"],
      },
    ]);
  }
}

function parsePrincipal(value: unknown): StaticTokenPrincipal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", "Each API principal must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    (typeof record.token !== "string" && typeof record.tokenSha256 !== "string") ||
    (record.token !== undefined && record.tokenSha256 !== undefined) ||
    typeof record.actorId !== "string" ||
    typeof record.tenantId !== "string" ||
    !Array.isArray(record.roles) ||
    !record.roles.every((role) => typeof role === "string" && ROLES.has(role as Role)) ||
    !Array.isArray(record.allowedPurposes) ||
    !record.allowedPurposes.every((purpose) => typeof purpose === "string") ||
    (record.permissions !== undefined &&
      (!Array.isArray(record.permissions) || !record.permissions.every((permission) => typeof permission === "string"))) ||
    (record.stepUp !== undefined && typeof record.stepUp !== "boolean") ||
    (record.guardianVerified !== undefined && typeof record.guardianVerified !== "boolean")
  ) {
    throw new DomainError("VALIDATION_FAILED", "API principal has an invalid shape");
  }
  return {
    actorId: record.actorId,
    tenantId: record.tenantId,
    roles: record.roles as Role[],
    allowedPurposes: record.allowedPurposes as string[],
    ...(record.token === undefined
      ? { tokenSha256: record.tokenSha256 as string }
      : { token: record.token as string }),
    ...(record.permissions === undefined ? {} : { permissions: record.permissions as string[] }),
    ...(record.stepUp === undefined ? {} : { stepUp: record.stepUp as boolean }),
    ...(record.guardianVerified === undefined ? {} : { guardianVerified: record.guardianVerified as boolean }),
  };
}
