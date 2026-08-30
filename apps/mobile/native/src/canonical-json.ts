export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_JSON_NUMBER_INVALID");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_VALUE_INVALID");
}

export function parseCanonicalJson(raw: string): unknown {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 1_048_576) throw new Error("CANONICAL_JSON_BODY_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("CANONICAL_JSON_BODY_INVALID"); }
  if (canonicalJson(parsed) !== raw) throw new Error("CANONICAL_JSON_BODY_NONCANONICAL");
  return parsed;
}
