import { DomainError } from "./errors.js";
import type { ActorContext, AuthorizationResource, Role } from "./types.js";

const ROLE_PERMISSIONS: Readonly<Record<Role, readonly string[]>> = {
  consumer: [
    "record:create",
    "record:read",
    "record:update",
    "record:delete",
    "consent:grant:self",
    "consent:withdraw:self",
    "consent:read:self",
    "rights-request:create",
    "rights-request:read:self",
    "support.ticket.create",
    "audit:append",
  ],
  household_admin: ["record:*", "consent:read", "audit:append"],
  guardian: [
    "record:*",
    "consent:*",
    "rights-request:create",
    "rights-request:read:self",
    "minor:data:manage",
    "minor:public-share:restricted",
    "audit:append",
  ],
  partner_employee: ["record:create", "record:read", "record:update", "consent:read", "audit:append"],
  partner_admin: ["record:*", "consent:read", "event:receive", "outbox:read", "audit:append"],
  studio_operator: ["record:create", "record:read", "record:update", "consent:read", "audit:append"],
  support_agent: ["record:read", "record:update", "consent:read", "rights-request:read:any", "audit:append"],
  moderator: ["record:read", "record:update", "audit:append"],
  privacy_officer: [
    "record:*",
    "consent:*",
    "rights-request:create",
    "rights-request:read:any",
    "rights-request:review",
    "rights-request:escalate",
    "audit:read",
    "audit:append",
  ],
  finance_operator: ["record:read", "ledger:*", "audit:append"],
  platform_admin: ["*"],
  auditor: ["record:read", "consent:read", "ledger:read", "audit:read", "outbox:read", "evidence:read"],
  service_account: [],
};

const PROHIBITED_PURPOSES = new Set([
  "credit_decision",
  "employment_decision",
  "insurance_eligibility",
  "insurance_pricing",
  "insurance_underwriting",
  "medical_diagnosis",
  "medical_treatment",
  "wealth_prediction",
]);

function permissionMatches(granted: string, requested: string): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }
  if (!granted.endsWith("*")) {
    return false;
  }
  return requested.startsWith(granted.slice(0, -1));
}

export function effectivePermissions(context: ActorContext): readonly string[] {
  const rolePermissions = context.roles.flatMap((role) => ROLE_PERMISSIONS[role] ?? []);
  return [...new Set([...rolePermissions, ...(context.permissions ?? [])])];
}

export function hasPermission(context: ActorContext, action: string): boolean {
  return effectivePermissions(context).some((permission) => permissionMatches(permission, action));
}

export function validateContext(context: ActorContext): void {
  if (context.actorId.trim().length === 0 || context.tenantId.trim().length === 0) {
    throw new DomainError("AUTH_UNAUTHENTICATED", "A server-resolved actor and tenant are required");
  }
  if (context.roles.length === 0) {
    throw new DomainError("AUTH_FORBIDDEN", "The actor has no assigned role");
  }
  if (context.purpose.trim().length === 0) {
    throw new DomainError("PURPOSE_REQUIRED", "A data-use purpose is required");
  }
  if (context.requestId.trim().length === 0) {
    throw new DomainError("VALIDATION_FAILED", "A request ID is required");
  }
  const normalizedPurpose = context.purpose.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  if (PROHIBITED_PURPOSES.has(normalizedPurpose)) {
    throw new DomainError("AUTH_FORBIDDEN", "The requested purpose is prohibited by product policy");
  }
}

export function authorize(context: ActorContext, action: string, resource: AuthorizationResource = {}): void {
  validateContext(context);
  if (resource.tenantId !== undefined && resource.tenantId !== context.tenantId) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "The resource is outside the authenticated tenant");
  }
  if (!hasPermission(context, action)) {
    throw new DomainError("AUTH_FORBIDDEN", `Permission ${action} is required`);
  }
  if (resource.ownerActorId !== undefined && resource.ownerActorId !== null && context.roles.includes("consumer")) {
    if (resource.ownerActorId !== context.actorId && !hasPermission(context, `${action}:any`)) {
      throw new DomainError("AUTH_FORBIDDEN", "Consumers may access only resources they own");
    }
  }
  if (resource.containsMinor === true && !hasPermission(context, "minor:data:manage")) {
    throw new DomainError("AUTH_FORBIDDEN", "Managing a minor's data requires a verified guardian role");
  }
  if (resource.containsMinor === true && context.guardianVerified !== true) {
    throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "Verified guardian context is required");
  }
  if (resource.sensitive === true && context.stepUp !== true) {
    throw new DomainError("AUTH_FORBIDDEN", "Step-up authentication is required for this action");
  }
}
