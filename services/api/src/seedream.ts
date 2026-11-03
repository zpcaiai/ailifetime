import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { DomainError, parseTimelineImageAsset, type TimelineImageAsset } from "@ltm/core";

export const SEEDREAM_MODEL = "doubao-seedream-5-0-pro-260628";
export const SEEDREAM_SIZE = "2048x2048";
const ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const MAX_IMAGE = 25 * 1024 * 1024;
export interface SeedreamInput {
  tenantId: string; actorId: string; idempotencyKey: string; prompt: string;
  source: Uint8Array; mimeType: "image/png" | "image/jpeg";
  imageQuality?: "standard" | "hd";
  editReference?: { source: Uint8Array; mimeType: "image/png" | "image/jpeg" };
  /** Runs after the durable intent, immediately before the single paid POST. */
  beforeSubmit?: () => Promise<void>;
  planSha256?: string;
}
export interface GeneratedImageSink {
  put(input: { tenantId: string; actorId: string; id: string; bytes: Uint8Array; generatedAt: string }): Promise<TimelineImageAsset>;
}
const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
/** One paid POST per durable key. Ark does not document a deduplicating idempotency key.
 * An interrupted or ambiguous operation MUST be reconciled rather than resubmitted.
 * This creates candidate bytes only; it does not certify identity/age/safety or publish B14.
 */
export class SeedreamImageGenerator {
  private readonly endpoint: string;
  constructor(private readonly pool: Pool, private readonly sink: GeneratedImageSink, private readonly apiKey: string,
    testEndpoint?: { environment: "test"; url: string }) {
    if (!apiKey || /\s/.test(apiKey)) throw new DomainError("CONFIGURATION_INVALID", "Seedream API credential is missing or invalid");
    this.endpoint = ENDPOINT;
    if (testEndpoint) {
      const url = new URL(testEndpoint.url);
      if (testEndpoint.environment !== "test" || process.env.APP_ENV !== "test" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
        throw new DomainError("CONFIGURATION_INVALID", "Seedream test endpoint requires explicit loopback test environment");
      }
      this.endpoint = url.href;
    }
  }
  async generate(input: SeedreamInput): Promise<{ asset: TimelineImageAsset; generatedAt: string }> {
    const quality = input.imageQuality === undefined ? "hd" : input.imageQuality;
    if (quality !== "standard" && quality !== "hd") throw new DomainError("VALIDATION_FAILED","invalid image quality");
    const dimension = quality === "standard" ? 1536 : 2048, size = `${dimension}x${dimension}`;
    for (const id of [input.tenantId,input.actorId,input.idempotencyKey]) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new DomainError("VALIDATION_FAILED", "invalid generation identity");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000 || input.source.byteLength < 1 || input.source.byteLength > MAX_IMAGE || !["image/png","image/jpeg"].includes(input.mimeType)) throw new DomainError("VALIDATION_FAILED", "invalid generation source or prompt");
    const original = `data:${input.mimeType};base64,${Buffer.from(input.source).toString("base64")}`;
    if (input.editReference && (input.editReference.source.byteLength < 1 || input.editReference.source.byteLength > MAX_IMAGE || !["image/png","image/jpeg"].includes(input.editReference.mimeType))) throw new DomainError("VALIDATION_FAILED","invalid edit reference");
    const request = { model: SEEDREAM_MODEL, size, prompt: input.prompt,
      image: input.editReference ? [original, `data:${input.editReference.mimeType};base64,${Buffer.from(input.editReference.source).toString("base64")}`] : original,
      response_format: "b64_json", output_format: "png", watermark: true, optimize_prompt_options: { mode: "standard" } };
    if (input.planSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.planSha256)) throw new DomainError("VALIDATION_FAILED","invalid generation plan digest");
    const requestSha256 = sha(JSON.stringify(input.planSha256 === undefined ? request : { request, planSha256: input.planSha256 })), keys = [input.tenantId,input.actorId,input.idempotencyKey];
    const claim = await this.pool.query("INSERT INTO photo_service.generations (tenant_id,actor_id,idempotency_key,request_sha256,state) VALUES ($1,$2,$3,$4,'executing') ON CONFLICT DO NOTHING RETURNING state", [...keys,requestSha256]);
    if (claim.rowCount !== 1) {
      const prior = (await this.pool.query("SELECT request_sha256,state,asset,generated_at FROM photo_service.generations WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3",keys)).rows[0];
      if (!prior || prior.request_sha256 !== requestSha256) throw new DomainError("VERSION_CONFLICT", "Seedream idempotency key has a different request");
      if (prior.state === "succeeded") return { asset: parseTimelineImageAsset(prior.asset), generatedAt: new Date(prior.generated_at).toISOString() };
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "SEEDREAM_RECONCILIATION_REQUIRED");
    }
    try {
      await input.beforeSubmit?.();
      const response = await fetch(this.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(request) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("SEEDREAM_PROVIDER_REJECTED"); }
      const reader = response.body?.getReader(); if (!reader) throw new Error("SEEDREAM_EMPTY_RESPONSE");
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_IMAGE * 4 / 3 + 65536) { await reader.cancel(); throw new Error("SEEDREAM_RESPONSE_TOO_LARGE"); }
        chunks.push(next.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const image = result?.data?.[0];
      if (result?.model !== SEEDREAM_MODEL || !Array.isArray(result.data) || result.data.length !== 1 || image.error || image.size !== size || typeof image.b64_json !== "string" || image.b64_json.length > Math.ceil(MAX_IMAGE/3)*4) throw new Error("SEEDREAM_RESPONSE_INVALID");
      const bytes = Buffer.from(image.b64_json,"base64");
      if (bytes.toString("base64") !== image.b64_json || bytes.length < 45 || bytes.length > MAX_IMAGE || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii",12,16) !== "IHDR" || bytes.readUInt32BE(16) !== dimension || bytes.readUInt32BE(20) !== dimension || bytes.toString("ascii",bytes.length-8,bytes.length-4) !== "IEND") throw new Error("SEEDREAM_IMAGE_INVALID");
      const generatedAt = new Date().toISOString(), id = `seedream-${sha(JSON.stringify(keys))}`;
      const asset = await this.sink.put({ tenantId: input.tenantId, actorId: input.actorId, id, bytes, generatedAt });
      if (asset.sha256 !== sha(bytes) || asset.width !== dimension || asset.height !== dimension || asset.mimeType !== "image/png" || asset.byteLength !== bytes.byteLength || asset.id !== id) throw new Error("SEEDREAM_STORAGE_BINDING_INVALID");
      const saved = await this.pool.query("UPDATE photo_service.generations SET state='succeeded',asset=$4::jsonb,generated_at=$5 WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND state='executing'",[...keys,JSON.stringify(asset),generatedAt]);
      if (saved.rowCount !== 1) throw new Error("SEEDREAM_JOURNAL_CHANGED");
      return { asset, generatedAt };
    } catch {
      await this.pool.query("UPDATE photo_service.generations SET state='reconciliation_required' WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND state='executing'",keys);
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "SEEDREAM_RECONCILIATION_REQUIRED");
    }
  }
}
