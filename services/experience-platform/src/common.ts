import { createHash } from "node:crypto";

export class ExperienceError extends Error {
  constructor(readonly code: "VALIDATION_FAILED" | "AUTHORIZATION_DENIED" | "CONSENT_REQUIRED" | "POLICY_BLOCKED" | "CONFLICT" | "NOT_FOUND" | "QUOTA_EXCEEDED", message: string) {
    super(message); this.name = "ExperienceError";
  }
}
export function required(value: string, field: string): string { if (value.length === 0 || value !== value.trim() || value.length > 512) throw new ExperienceError("VALIDATION_FAILED", `${field} is invalid`); return value; }
export function utc(value: string, field = "timestamp"): string { const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(value); if (match === null) throw new ExperienceError("VALIDATION_FAILED", `${field} must be canonical UTC`); const [,y,m,d,h,mi,s,ms] = match; const parsed = new Date(Date.UTC(Number(y),Number(m)-1,Number(d),Number(h),Number(mi),Number(s),Number(ms))); if (parsed.toISOString() !== value) throw new ExperienceError("VALIDATION_FAILED", `${field} is not a real instant`); return value; }
export function stable(value: unknown): string { if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value) || Object.is(value,-0)) throw new ExperienceError("VALIDATION_FAILED","number is not canonical"); return JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (typeof value === "object") { const object=value as Record<string,unknown>; return `{${Object.keys(object).sort().map((key)=>`${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`; } throw new ExperienceError("VALIDATION_FAILED","value is not JSON-compatible"); }
export function digest(value: unknown): string { return createHash("sha256").update(stable(value),"utf8").digest("hex"); }
export function clone<T>(value:T):T { return structuredClone(value); }
export function unique(values:readonly string[],field:string):readonly string[]{ if(values.length===0||new Set(values).size!==values.length||values.some((value)=>value.length===0||value!==value.trim()))throw new ExperienceError("VALIDATION_FAILED",`${field} must be non-empty and unique`);return Object.freeze([...values]); }
export function minor(value:number,field:string):number { if(!Number.isSafeInteger(value)||value<0)throw new ExperienceError("VALIDATION_FAILED",`${field} must use non-negative minor units`);return value; }
