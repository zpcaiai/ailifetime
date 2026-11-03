import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Pool } from "pg";
import { DomainError, type LifeTimeMachineRuntimePort } from "@ltm/core";
import { BrokerClient } from "./client-integrations.js";
import { BrokerTimelineSourceReader } from "./seedream-source.js";
import { SeedreamImageGenerator } from "./seedream.js";
import { TimelineSeedreamService } from "./timeline-seedream.js";
import { PrivateS3Images } from "./private-s3.js";
import { PostgresGeneratedMedia } from "./generated-media.js";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";

function invalid(): never { throw new DomainError("CONFIGURATION_INVALID", "Seedream Pro requires explicit opt-in, server credential, PostgreSQL, approved upload broker and private image storage"); }
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]; if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return invalid(); return value;
}
function credential(env: NodeJS.ProcessEnv): string {
  if (env.ARK_API_KEY && env.LTM_SEEDREAM_API_KEY_FILE) return invalid();
  let value: string;
  if (env.LTM_SEEDREAM_API_KEY_FILE) {
    const path = env.LTM_SEEDREAM_API_KEY_FILE; if (!isAbsolute(path)) return invalid();
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || (stat.mode & 0o077) !== 0) return invalid();
      value = readFileSync(fd, "utf8").trim();
    } catch { return invalid(); }
    finally { if (fd !== undefined) closeSync(fd); }
  } else value = required(env, "ARK_API_KEY");
  if (!/^[\x21-\x7e]{1,8192}$/.test(value)) return invalid(); return value;
}

/** Composition performs no inference. Only a service-account generation request can incur a model call. */
export function configuredSeedream(env: NodeJS.ProcessEnv, appEnvironment: string, runtime: LifeTimeMachineRuntimePort) {
  const enabled = env.LTM_SEEDREAM_ENABLED;
  if (enabled === undefined && env.LTM_SEEDREAM_API_KEY_FILE === undefined) return undefined;
  if (enabled === "false") return undefined;
  if (enabled !== "true") return invalid();
  const key = credential(env), connectionString = required(env, "DATABASE_URL");
  let database: URL;
  try { database = new URL(connectionString); } catch { return invalid(); }
  if (!["postgres:","postgresql:"].includes(database.protocol) || !database.username || !database.hostname || database.pathname.length < 2 || database.hash ||
      (!["local","test"].includes(appEnvironment) && database.searchParams.get("sslmode") !== "verify-full")) return invalid();
  const allowLoopback = env.LTM_CLIENT_INTEGRATION_ALLOW_HTTP_LOOPBACK;
  if (allowLoopback !== undefined && !["true","false"].includes(allowLoopback)) return invalid();
  if (allowLoopback === "true" && !["local","test"].includes(appEnvironment)) return invalid();
  const broker = new BrokerClient({ baseUrl: required(env,"LTM_UPLOAD_BROKER_URL"), workloadTokenFile: required(env,"LTM_UPLOAD_BROKER_TOKEN_FILE"), allowInsecureLoopback: allowLoopback === "true" });
  const objects = new PrivateS3Images({ endpoint: required(env,"LTM_PHOTO_S3_ENDPOINT"), region: required(env,"LTM_PHOTO_S3_REGION"), bucket: required(env,"LTM_PHOTO_S3_BUCKET"), accessKeyId: required(env,"LTM_PHOTO_S3_ACCESS_KEY_ID"), secretAccessKey: required(env,"LTM_PHOTO_S3_SECRET_ACCESS_KEY") });
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, application_name: "ltm-seedream-pro" });
  const originals = new BrokerTimelineSourceReader(broker), outputs = new PostgresGeneratedMedia(pool, objects);
  const media: TimelineArtifactReader = { read: (asset, actor) => asset.mimeType === "image/jpeg" ? originals.read(asset, actor) : outputs.read(asset, actor) };
  const generation = new TimelineSeedreamService(runtime, originals, outputs, new SeedreamImageGenerator(pool, outputs, key));
  return { generation, media, async readiness() {
    try {
      await pool.query("SELECT idempotency_key FROM photo_service.generations LIMIT 1");
      await pool.query("SELECT asset_id FROM photo_service.media LIMIT 1");
      await objects.readiness(); return (await broker.readiness("seedream-source")).ready;
    } catch { return false; }
  }, async close() { objects.close(); await pool.end(); } };
}
