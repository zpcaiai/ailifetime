import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue | undefined }

export type CommercialErrorCode =
  | "AUTHORIZATION_REQUIRED"
  | "CONFIGURATION_INVALID"
  | "CONFLICT"
  | "EXTERNAL_FACT_REQUIRED"
  | "EXTERNAL_FACT_UNVERIFIED"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "PERIOD_LOCKED"
  | "POLICY_BLOCKED"
  | "STATE_TRANSITION_INVALID"
  | "VALIDATION_FAILED";

export class CommercialOperationsError extends Error {
  constructor(
    readonly code: CommercialErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "CommercialOperationsError";
  }
}

export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue | undefined): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) && !Number.isFinite(value)) invalid("JSON number must be finite");
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  if (typeof value !== "object" || value === undefined) invalid("value is not canonical JSON");
  const object = value as JsonObject;
  const fields = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${fields.map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function identifier(value: string, field: string, maximum = 128): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > maximum) {
    invalid(`${field} is invalid`, { field });
  }
  return value;
}

export function nonEmpty(value: string, field: string, maximum = 512): string {
  if (value.trim() !== value || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(`${field} is invalid`, { field });
  }
  return value;
}

export function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) invalid("currency must be an ISO-4217 code");
  return value;
}

export function minor(value: number, field = "amountMinor", allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) invalid(`${field} must use exact currency minor units`);
  return value;
}

export function signedMinor(value: number, field = "amountMinor"): number {
  if (!Number.isSafeInteger(value)) invalid(`${field} must use exact currency minor units`);
  return value;
}

export function basisPoints(value: number, field = "basisPoints"): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) invalid(`${field} must be between 0 and 10000`);
  return value;
}

export function exactUtc(value: string, field: string): string {
  const seconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
  const milliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
  const parsed = Date.parse(value);
  const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  if ((!seconds && !milliseconds) || (seconds ? canonical !== value.replace(/Z$/, ".000Z") : canonical !== value)) {
    invalid(`${field} must be an exact UTC timestamp`, { field });
  }
  return value;
}

export function dateOnly(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be an exact calendar date`, { field });
  }
  return value;
}

export function sortedUnique(values: readonly string[], field: string, minimum = 1): readonly string[] {
  if (values.length < minimum || values.length > 256) invalid(`${field} has an invalid size`);
  const normalized = values.map((value) => nonEmpty(value, field, 256));
  if (new Set(normalized).size !== normalized.length) invalid(`${field} must be unique`);
  return Object.freeze([...normalized].sort());
}

export function assertExactKeys(object: Readonly<Record<string, unknown>>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) {
    invalid(`${field} does not match its closed contract`);
  }
}

export function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
    }
  }
  return value;
}

export function invalid(message: string, details: Readonly<Record<string, JsonValue>> = {}): never {
  throw new CommercialOperationsError("VALIDATION_FAILED", message, details);
}

export function conflict(message: string, details: Readonly<Record<string, JsonValue>> = {}): never {
  throw new CommercialOperationsError("CONFLICT", message, details);
}

export function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CommercialOperationsError("STATE_TRANSITION_INVALID", message);
}

export function requireAuthorization(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CommercialOperationsError("AUTHORIZATION_REQUIRED", message);
}

export interface CommercialActor {
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly purpose: string;
  readonly stepUp: boolean;
  readonly reason: string;
}

export function assertActor(actor: CommercialActor, roles: readonly string[], twoPersonApprovers?: readonly string[]): void {
  identifier(actor.tenantId, "tenantId");
  identifier(actor.actorId, "actorId");
  nonEmpty(actor.purpose, "purpose");
  nonEmpty(actor.reason, "reason");
  requireAuthorization(actor.stepUp, "commercial mutation requires step-up authentication");
  requireAuthorization(roles.some((role) => actor.roles.includes(role)), "commercial role is not authorized");
  if (twoPersonApprovers !== undefined) {
    const approvers = sortedUnique(twoPersonApprovers, "approverIds", 2);
    requireAuthorization(!approvers.includes(actor.actorId), "executor must be independent of both approvers");
  }
}
