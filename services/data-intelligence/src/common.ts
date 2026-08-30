import { createHash } from "node:crypto";

export class DataIntelligenceError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_FAILED"
      | "AUTHORIZATION_DENIED"
      | "CONSENT_REQUIRED"
      | "CONFLICT"
      | "SCHEMA_INCOMPATIBLE"
      | "CONTROL_TOTAL_MISMATCH"
      | "NOT_FOUND"
      | "POLICY_BLOCKED",
    message: string,
  ) {
    super(message);
    this.name = "DataIntelligenceError";
  }
}

export function required(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim() || value.length > 256) {
    throw new DataIntelligenceError("VALIDATION_FAILED", `${field} is invalid`);
  }
  return value;
}

export function strictUtc(value: string, field = "timestamp"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (match === null) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} must be canonical UTC`);
  const [, year, month, day, hour, minute, second, millis = "000"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis)));
  const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  if (date.toISOString() !== expected) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} is not a real UTC instant`);
  return expected;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new DataIntelligenceError("VALIDATION_FAILED", "canonical JSON number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new DataIntelligenceError("VALIDATION_FAILED", "value cannot be serialized");
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function assertFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} must be finite`);
  return value;
}

export function assertMinorUnits(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} must use integer minor units`);
  return value;
}

export function unique<T extends string>(values: readonly T[], field: string): readonly T[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new DataIntelligenceError("VALIDATION_FAILED", `${field} must be non-empty and unique`);
  }
  return Object.freeze([...values]);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
