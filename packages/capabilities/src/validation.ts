import { DomainError } from "@ltm/core";
import type { JsonObject, JsonValue } from "./registry.js";

export function requiredString(input: JsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(input: JsonObject, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a non-empty string`);
  }
  return value;
}

export function requiredNumber(input: JsonObject, field: string, minimum?: number): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a valid number`);
  }
  return value;
}

export function requiredBoolean(input: JsonObject, field: string): boolean {
  const value = input[field];
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a boolean`);
  }
  return value;
}

export function stringList(input: JsonObject, field: string, options: { min?: number; unique?: boolean } = {}): string[] {
  const value = input[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a string array`);
  }
  const list = value as string[];
  if ((options.min ?? 0) > list.length || (options.unique && new Set(list).size !== list.length)) {
    throw new DomainError("VALIDATION_FAILED", `${field} does not satisfy list constraints`);
  }
  return [...list];
}

export function objectValue(input: JsonObject, field: string): JsonObject {
  const value: JsonValue | undefined = input[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an object`);
  }
  return value;
}

export function assertAllowed<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new DomainError("VALIDATION_FAILED", `${field} is not supported`, {
      details: { field, allowed: [...allowed] },
    });
  }
  return value as T;
}
