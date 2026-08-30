import { createHash } from "node:crypto";

export class DeveloperPlatformError extends Error {
  constructor(
    readonly code: "VALIDATION_FAILED" | "AUTHORIZATION_DENIED" | "CONFLICT" | "NOT_FOUND" | "POLICY_BLOCKED" | "RATE_LIMITED" | "DEPENDENCY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DeveloperPlatformError";
  }
}

export function required(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim() || value.length > 512) throw new DeveloperPlatformError("VALIDATION_FAILED", `${field} is invalid`);
  return value;
}

export function utc(value: string, field = "timestamp"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(value);
  if (match === null) throw new DeveloperPlatformError("VALIDATION_FAILED", `${field} must use canonical UTC`);
  const [, year, month, day, hour, minute, second, millis] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis)));
  if (parsed.toISOString() !== value) throw new DeveloperPlatformError("VALIDATION_FAILED", `${field} is not a real instant`);
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new DeveloperPlatformError("VALIDATION_FAILED", "canonical JSON number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new DeveloperPlatformError("VALIDATION_FAILED", "value is not JSON-compatible");
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function unique(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0 || new Set(values).size !== values.length || values.some((value) => value.length === 0 || value !== value.trim())) throw new DeveloperPlatformError("VALIDATION_FAILED", `${field} must be non-empty and unique`);
  return Object.freeze([...values]);
}

export function clone<T>(value: T): T { return structuredClone(value); }

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, /secret|token|authorization|credential|media|conversation|face|child/i.test(key) ? "[REDACTED]" : redact(entry)]));
  }
  return value;
}
