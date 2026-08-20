import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

function normalize(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError("VALIDATION_FAILED", `${path} must contain only finite numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new DomainError("VALIDATION_FAILED", `${path} must not contain cycles`);
    }
    seen.add(value);
    const result = value.map((item, index) => normalize(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new DomainError("VALIDATION_FAILED", `${path} must not contain cycles`);
    }
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new DomainError("VALIDATION_FAILED", `${path}.${key} is not JSON serializable`);
      }
      result[key] = normalize(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new DomainError("VALIDATION_FAILED", `${path} is not JSON serializable`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$", new Set<object>()));
}

export function jsonObject(value: unknown, path = "value"): JsonObject {
  const normalized = normalize(value, path, new Set<object>());
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new DomainError("VALIDATION_FAILED", `${path} must be a JSON object`);
  }
  return normalized;
}

export function parseJsonObject(serialized: string, path: string): JsonObject {
  try {
    return jsonObject(JSON.parse(serialized) as unknown, path);
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError("INTERNAL_ERROR", `Stored ${path} is invalid JSON`);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(operation: string, input: unknown): string {
  return sha256(`${operation}\n${canonicalJson(input)}`);
}
