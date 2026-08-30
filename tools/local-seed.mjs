#!/usr/bin/env node
import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityRegistry } from "../packages/capabilities/dist/index.js";
import { LifeTimeMachineRuntime } from "../packages/core/dist/index.js";

const productRoot = fileURLToPath(new URL("../", import.meta.url));
const dataRoot = resolve(productRoot, ".data");

export async function seedLocalDatabase(databasePath) {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const runtime = new LifeTimeMachineRuntime({ databasePath, allowLegacyConsentPolicy: true });
  const registry = createCapabilityRegistry();
  const actor = Object.freeze({
    actorId: "local-platform-seeder",
    tenantId: "tenant-local",
    roles: ["platform_admin"],
    purpose: "platform_bootstrap",
    requestId: "local-seed-v1",
  });
  try {
    const architecture = await registry.execute(runtime, "B01", {
      actor,
      idempotencyKey: "local-seed:B01:v1",
      input: {
        repositoryId: "ai-life-time-machine-local",
        stackProfile: "all-typescript",
        boundedContexts: ["consumer", "control-plane", "media", "commerce", "partner", "assurance"],
        healthChecks: ["liveness", "readiness"],
        ownershipRules: ["ui-through-api", "tenant-state-isolated", "external-effects-through-outbox"],
      },
    });
    const contracts = await registry.execute(runtime, "B02", {
      actor: { ...actor, requestId: "local-seed-v1-contracts" },
      idempotencyKey: "local-seed:B02:v1",
      input: {
        contractVersion: "1.0.0-local",
        schemaVersion: "5",
        aggregateTypes: [
          "user", "participant", "asset", "consent", "generation_job", "work", "share",
          "family", "order", "product", "partner", "settlement", "deletion_request", "audit_record",
        ],
        compatibility: "additive",
        sensitiveFieldsClassified: true,
      },
    });
    return Object.freeze({
      schemaVersion: "ltm.local-seed-result.v1",
      tenantId: actor.tenantId,
      records: Object.freeze([architecture, contracts]),
      readiness: runtime.readiness(),
    });
  } finally {
    runtime.close();
  }
}

function argument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function assertSafeLocalTarget(path) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(dataRoot);
  const target = resolve(productRoot, path);
  const targetRelative = relative(canonicalRoot, target);
  if (targetRelative === "" || targetRelative.startsWith("..") || targetRelative.includes("/../")) {
    throw new Error("local seed database must be a file below the product .data directory");
  }
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("local seed target must be a regular non-symlink file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databasePath = await assertSafeLocalTarget(argument("database") ?? ".data/ltm-local.sqlite");
  const result = await seedLocalDatabase(databasePath);
  const artifactPath = resolve(productRoot, ".artifacts/local-seed/manifest.json");
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  const temporary = `${artifactPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ ...result, databasePath: relative(productRoot, databasePath) })}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  await rename(temporary, artifactPath);
  process.stdout.write(`${JSON.stringify({ status: "SEEDED", databasePath, artifactPath, readiness: result.readiness })}\n`);
}
