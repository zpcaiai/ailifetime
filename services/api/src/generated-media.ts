import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DomainError, parseTimelineImageAsset, type ActorContext, type TimelineImageAsset } from "@ltm/core";
import type { GeneratedImageSink } from "./seedream.js";

export interface PrivateImageObjects {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string, maximumBytes: number): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
  /** Only an authenticated 404 means absent; 403 and transport errors MUST throw. */
  exists(key: string): Promise<boolean>;
}
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const fail = (message: string): never => { throw new DomainError("DEPENDENCY_UNAVAILABLE",message); };
/** Metadata/journal in PostgreSQL, bytes in a private object bucket. No public URLs.
 * Every original or derivative must have its own entry with the original completion time.
 */
export class PostgresGeneratedMedia implements GeneratedImageSink {
  constructor(private readonly pool: Pool, private readonly objects: PrivateImageObjects) {}
  async put(input: { tenantId: string; actorId: string; id: string; bytes: Uint8Array; generatedAt: string }): Promise<TimelineImageAsset> {
    for (const id of [input.tenantId,input.actorId,input.id]) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new DomainError("VALIDATION_FAILED","invalid media owner or identity");
    const bytes = Buffer.from(input.bytes);
    if (bytes.length < 45 || bytes.length > 25*1024*1024 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii",12,16) !== "IHDR") fail("generated image is not PNG");
    if (!Number.isFinite(Date.parse(input.generatedAt)) || new Date(input.generatedAt).toISOString() !== input.generatedAt || Date.parse(input.generatedAt) > Date.now()+30_000) throw new DomainError("VALIDATION_FAILED","invalid generation completion time");
    const asset = parseTimelineImageAsset({ id: input.id, sha256: sha(bytes), mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), byteLength: bytes.length });
    const keys = [input.tenantId,input.actorId,input.id], objectKey = `generated/${sha(JSON.stringify([...keys,asset.sha256]))}.png`;
    await this.pool.query("INSERT INTO photo_service.media (tenant_id,actor_id,asset_id,asset,object_key,generated_at,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz,$6::timestamptz+interval '720 hours') ON CONFLICT DO NOTHING",[...keys,JSON.stringify(asset),objectKey,input.generatedAt]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Hold the row lock during the bounded object write: cleanup cannot pass an
      // in-flight upload and a stale uploader cannot resurrect a tombstoned object.
      const row = (await client.query("SELECT *,expires_at>clock_timestamp() AS live FROM photo_service.media WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=$3 FOR UPDATE",keys)).rows[0];
      if (!row || row.object_key !== objectKey || new Date(row.generated_at).toISOString() !== input.generatedAt || JSON.stringify(parseTimelineImageAsset(row.asset)) !== JSON.stringify(asset)) throw new DomainError("VERSION_CONFLICT","generated media identity was reused");
      if (!row.live || !["uploading","ready"].includes(row.state)) throw new DomainError("RESOURCE_NOT_FOUND","generated photo expired or was deleted");
      if (row.state === "uploading") {
        await this.objects.put(objectKey,bytes);
        if (!await this.objects.exists(objectKey)) fail("uploaded object was not found");
        const verified = await this.objects.get(objectKey,bytes.length);
        if (verified.byteLength !== bytes.length || sha(verified) !== asset.sha256) fail("uploaded object verification failed");
        await client.query("UPDATE photo_service.media SET state='ready' WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=$3",keys);
      }
      await client.query("COMMIT"); return asset;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async read(value: TimelineImageAsset, actor?: Pick<ActorContext,"tenantId"|"actorId">): Promise<Uint8Array> {
    if (!actor) throw new DomainError("AUTH_FORBIDDEN","generated photo owner is required");
    const asset = parseTimelineImageAsset(value), keys = [actor.tenantId,actor.actorId,asset.id];
    const owned = async () => (await this.pool.query("SELECT asset,object_key FROM photo_service.media WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=$3 AND state='ready' AND expires_at>clock_timestamp()",keys)).rows[0];
    const row = await owned(); if (!row) throw new DomainError("RESOURCE_NOT_FOUND","generated photo is unavailable or expired");
    if (JSON.stringify(parseTimelineImageAsset(row.asset)) !== JSON.stringify(asset)) fail("generated photo metadata changed");
    const bytes = await this.objects.get(row.object_key,asset.byteLength);
    if (bytes.byteLength !== asset.byteLength || sha(bytes) !== asset.sha256) fail("generated photo bytes changed");
    if (!await owned()) throw new DomainError("RESOURCE_NOT_FOUND","generated photo expired during download");
    return bytes;
  }
  async cleanup(limit = 20): Promise<{ claimed: number; deleted: number; retrying: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("VALIDATION_FAILED","invalid cleanup batch limit");
    const fence = randomUUID();
    const rows = (await this.pool.query(`WITH due AS (
      SELECT tenant_id,actor_id,asset_id FROM photo_service.media
      WHERE state<>'deleted' AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      AND (expires_at<=clock_timestamp() OR (state='uploading' AND created_at<=clock_timestamp()-interval '1 hour') OR state='deleting')
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE photo_service.media m SET state='deleting',fence=$2,lease_until=clock_timestamp()+interval '2 minutes',attempts=m.attempts+1
      FROM due WHERE (m.tenant_id,m.actor_id,m.asset_id)=(due.tenant_id,due.actor_id,due.asset_id) RETURNING m.*`,[limit,fence])).rows;
    let deleted = 0, retrying = 0;
    for (const row of rows) {
      const keys = [row.tenant_id,row.actor_id,row.asset_id,fence];
      try {
        await this.objects.remove(row.object_key);
        if (await this.objects.exists(row.object_key)) fail("deleted object is still present");
        const saved = await this.pool.query("UPDATE photo_service.media SET state='deleted',deleted_at=clock_timestamp(),lease_until=NULL WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=$3 AND fence=$4 AND state='deleting' AND lease_until>clock_timestamp()",keys);
        if (saved.rowCount === 1) deleted++;
      } catch {
        retrying++;
        await this.pool.query("UPDATE photo_service.media SET lease_until=NULL,next_attempt_at=clock_timestamp()+($5::integer*interval '1 second') WHERE tenant_id=$1 AND actor_id=$2 AND asset_id=$3 AND fence=$4 AND state='deleting'",[...keys,Math.min(3600,30*2**Math.min(row.attempts,7))]);
      }
    }
    return { claimed: rows.length, deleted, retrying };
  }
}
