import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class CommerceError extends Error {
  constructor(readonly code: "VALIDATION" | "AUTHORIZATION" | "CONFLICT" | "DEPENDENCY" | "NOT_FOUND" | "RATE_LIMIT", message: string) { super(message); this.name = "CommerceError"; }
}
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const digest = (value: string | undefined): value is string => value !== undefined && /^[a-f0-9]{64}$/u.test(value);
export const strictUtc = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value;
export function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
export const hmac = (secret: string, value: string): string => createHmac("sha256", secret).update(value).digest("base64url");
export function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
export function assertMoney(value: number, label = "money"): void { if (!Number.isSafeInteger(value) || value < 0) throw new CommerceError("VALIDATION", `${label} must be a non-negative minor-unit integer`); }
