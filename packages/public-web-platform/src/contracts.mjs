import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export class PublicWebError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PublicWebError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new PublicWebError(code, message, details);
}

export function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("VALIDATION_FAILED", `${label} must be an object`);
  }
  return value;
}

export function exactKeys(value, fields, label) {
  const actual = Object.keys(plainObject(value, label)).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("CONTRACT_FIELDS_INVALID", `${label} must contain exactly ${expected.join(", ")}`);
  }
}

export function requiredString(value, label, maximum = 512) {
  if (typeof value !== "string") fail("VALIDATION_FAILED", `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail("VALIDATION_FAILED", `${label} is invalid`);
  }
  return normalized;
}

export function optionalString(value, label, maximum = 512) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, maximum);
}

export function identifier(value, label) {
  const normalized = requiredString(value, label, 128);
  if (!IDENTIFIER.test(normalized)) fail("VALIDATION_FAILED", `${label} must be a stable identifier`);
  return normalized;
}

export function locale(value, label = "locale") {
  const normalized = requiredString(value, label, 16);
  if (!LOCALE.test(normalized)) fail("VALIDATION_FAILED", `${label} must be a canonical locale`);
  return normalized;
}

export function digest(value, label = "sha256") {
  const normalized = requiredString(value, label, 64);
  if (!SHA256.test(normalized)) fail("VALIDATION_FAILED", `${label} must be a lowercase SHA-256 digest`);
  return normalized;
}

export function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("VALIDATION_FAILED", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function boolean(value, label) {
  if (typeof value !== "boolean") fail("VALIDATION_FAILED", `${label} must be boolean`);
  return value;
}

export function stringArray(value, label, options = {}) {
  const { minimum = 0, maximum = 100, itemMaximum = 256 } = options;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail("VALIDATION_FAILED", `${label} must contain ${minimum} to ${maximum} items`);
  }
  const items = value.map((item, index) => requiredString(item, `${label}[${index}]`, itemMaximum));
  if (new Set(items).size !== items.length) fail("VALIDATION_FAILED", `${label} must not contain duplicates`);
  return items;
}

export function enumValue(value, allowed, label) {
  const normalized = requiredString(value, label, 128);
  if (!allowed.includes(normalized)) fail("VALIDATION_FAILED", `${label} is unsupported`);
  return normalized;
}

export function timestamp(value, label, options = {}) {
  const normalized = requiredString(value, label, 64);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    fail("VALIDATION_FAILED", `${label} must be a canonical ISO timestamp`);
  }
  if (options.after !== undefined && parsed <= new Date(options.after)) fail("VALIDATION_FAILED", `${label} is too early`);
  if (options.before !== undefined && parsed >= new Date(options.before)) fail("VALIDATION_FAILED", `${label} is too late`);
  return normalized;
}

export function httpsUrl(value, label, options = {}) {
  let url;
  try { url = new URL(requiredString(value, label, 2_048)); }
  catch { fail("VALIDATION_FAILED", `${label} must be an absolute URL`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    fail("VALIDATION_FAILED", `${label} must be credential-free HTTPS without a fragment`);
  }
  if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
    fail("DESTINATION_NOT_ALLOWED", `${label} origin is not enrolled`);
  }
  return url;
}

export function localPath(value, label) {
  const normalized = requiredString(value, label, 512);
  if (
    normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("\0") ||
    !SAFE_RELATIVE_PATH.test(normalized) || normalized.split("/").some((part) => part === "." || part === "..")
  ) fail("VALIDATION_FAILED", `${label} must be a safe relative path`);
  return normalized;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("VALIDATION_FAILED", "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("VALIDATION_FAILED", "canonical JSON supports JSON values only");
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonicalJson(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function signToken(claims, secret) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? "");
  if (key.length < 32) fail("TOKEN_KEY_INVALID", "token signing key must contain at least 32 bytes");
  const payload = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyToken(token, secret, expected = {}, now = new Date()) {
  const normalized = requiredString(token, "token", 8_192);
  const parts = normalized.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) {
    fail("TOKEN_INVALID", "token is malformed");
  }
  const expectedSignature = createHmac("sha256", Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? ""))
    .update(parts[0]).digest();
  const actualSignature = Buffer.from(parts[1], "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    fail("TOKEN_INVALID", "token signature is invalid");
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { fail("TOKEN_INVALID", "token payload is invalid"); }
  plainObject(claims, "token claims");
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(now.getTime() / 1_000)) fail("TOKEN_EXPIRED", "token has expired");
  for (const [field, value] of Object.entries(expected)) {
    if (claims[field] !== value) fail("TOKEN_BINDING_MISMATCH", `token ${field} binding does not match`);
  }
  return claims;
}

export function sanitizeText(value, label, maximum = 20_000) {
  const normalized = requiredString(value, label, maximum);
  if (
    /<\/?(?:script|iframe|object|embed|style|link|meta)\b/iu.test(normalized) ||
    /\bon[a-z]+\s*=/iu.test(normalized) || /javascript\s*:/iu.test(normalized) ||
    /data\s*:\s*text\/html/iu.test(normalized)
  ) fail("CONTENT_UNSAFE", `${label} contains executable or embedded content`);
  return normalized;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function syntheticOnly(value, label) {
  if (value !== "synthetic") fail("REAL_CUSTOMER_MEDIA_FORBIDDEN", `${label} must use synthetic demonstration data`);
  return value;
}
