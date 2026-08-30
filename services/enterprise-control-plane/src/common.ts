import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue | undefined }

export type EnterpriseErrorCode =
  | "AUTHORIZATION_REQUIRED" | "CERTIFICATION_REQUIRED" | "CONFIGURATION_INVALID" | "CONFLICT"
  | "EVIDENCE_UNVERIFIED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "POLICY_BLOCKED"
  | "QUOTA_EXCEEDED" | "STATE_TRANSITION_INVALID" | "VALIDATION_FAILED";

export class EnterpriseControlError extends Error {
  constructor(readonly code: EnterpriseErrorCode, message: string, readonly details: Readonly<Record<string, JsonValue>> = {}) {
    super(message);
    this.name = "EnterpriseControlError";
  }
}

export interface EnterpriseActor {
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly purpose: string;
  readonly ticketId: string;
  readonly stepUp: boolean;
}

export function canonicalJson(value: JsonValue): string { return serialize(value); }
function serialize(value: JsonValue | undefined): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("non-finite JSON number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  if (typeof value !== "object" || value === undefined) invalid("value is not canonical JSON");
  const object = value as JsonObject;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function digest(value: JsonValue): string { return sha256(canonicalJson(value)); }

export function identifier(value: string, field: string, maximum = 160): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || value.length > maximum) invalid(`${field} is invalid`);
  return value;
}
export function text(value: string, field: string, maximum = 1_000): string {
  if (value.trim() !== value || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${field} is invalid`);
  return value;
}
export function exactUtc(value: string, field: string): string {
  const seconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
  const milliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
  const parsed = Date.parse(value);
  const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  if ((!seconds && !milliseconds) || (seconds ? canonical !== value.replace(/Z$/, ".000Z") : canonical !== value)) invalid(`${field} must be exact UTC`);
  return value;
}
export function integer(value: number, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${field} is outside integer bounds`);
  return value;
}
export function bps(value: number, field: string): number { return integer(value, field, 0, 10_000); }
export function unique(values: readonly string[], field: string, minimum = 1): readonly string[] {
  if (values.length < minimum || values.length > 256) invalid(`${field} has invalid size`);
  const normalized = values.map((value) => text(value, field, 256));
  if (new Set(normalized).size !== normalized.length) invalid(`${field} must be unique`);
  return freeze([...normalized].sort());
}
export function exactKeys(object: Readonly<Record<string, unknown>>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  if (Object.keys(object).length !== keys.length || Object.keys(object).some((key) => !expected.has(key))) invalid(`${field} violates its closed contract`);
}
export function hexDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(`${field} is not SHA-256`);
  return value;
}
export function assertActor(actor: EnterpriseActor, roles: readonly string[], approvers?: readonly string[]): void {
  identifier(actor.tenantId, "tenantId"); identifier(actor.actorId, "actorId"); text(actor.purpose, "purpose"); identifier(actor.ticketId, "ticketId");
  if (!actor.stepUp || !roles.some((role) => actor.roles.includes(role))) throw new EnterpriseControlError("AUTHORIZATION_REQUIRED", "step-up enterprise role is required");
  if (approvers !== undefined) {
    const approved = unique(approvers, "approvers", 2);
    if (approved.includes(actor.actorId)) throw new EnterpriseControlError("AUTHORIZATION_REQUIRED", "executor must be independent from approvers");
  }
}
export function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EnterpriseControlError("STATE_TRANSITION_INVALID", message);
}
export function requirePolicy(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EnterpriseControlError("POLICY_BLOCKED", message);
}
export function invalid(message: string): never { throw new EnterpriseControlError("VALIDATION_FAILED", message); }
export function conflict(message: string): never { throw new EnterpriseControlError("CONFLICT", message); }
export function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}
