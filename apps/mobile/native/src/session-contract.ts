export interface VerifiedPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly purpose: string;
  readonly roles: readonly string[];
  readonly stepUp: boolean;
  readonly guardianVerified: boolean;
}

export function parseServerSession(value: unknown): VerifiedPrincipal {
  const envelope = exact(value, ["requestId", "session"], "SERVER_SESSION_ENVELOPE_INVALID");
  if (!identifier(envelope.requestId, 8, 128)) throw new Error("SERVER_SESSION_ENVELOPE_INVALID");
  const session = exact(envelope.session, [
    "actorId", "authenticationState", "guardianVerified", "purpose", "roles", "stepUp", "tenantId",
  ], "SERVER_PRINCIPAL_INVALID");
  if (session.authenticationState !== "server_verified" || !identifier(session.tenantId) || !identifier(session.actorId) ||
      !identifier(session.purpose) || typeof session.stepUp !== "boolean" || typeof session.guardianVerified !== "boolean" ||
      !Array.isArray(session.roles) || session.roles.length < 1 || session.roles.length > 20 ||
      new Set(session.roles).size !== session.roles.length || session.roles.some((role: unknown) => !identifier(role))) {
    throw new Error("SERVER_PRINCIPAL_INVALID");
  }
  return Object.freeze({
    tenantId: session.tenantId,
    actorId: session.actorId,
    purpose: session.purpose,
    roles: Object.freeze([...session.roles]),
    stepUp: session.stepUp,
    guardianVerified: session.guardianVerified,
  });
}

function identifier(value: unknown, minimum = 1, maximum = 256): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function exact(value: unknown, keys: readonly string[], code: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(code);
  }
  return value as Record<string, any>;
}
