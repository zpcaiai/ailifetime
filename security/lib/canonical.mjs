import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not allow non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("canonical JSON contains an unsupported value");
  const entries = Object.keys(value).sort().map((key) => [key, value[key]]);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value) {
  return sha256(Buffer.from(canonicalize(value), "utf8"));
}

export function stableJson(value) {
  return `${canonicalize(value)}\n`;
}
