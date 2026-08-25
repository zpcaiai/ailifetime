import { isAbsolute, resolve } from "node:path";
import { DomainError, type ActorContext, type PostgresRuntimeOptions } from "@ltm/core";
import type { PartnerCommandAdapterOptions, PartnerWebhookSignatureScheme, SecretReference } from "@ltm/providers";
import type { WorkerOptions, WorkerRoute } from "./index.js";

const EXTERNAL_COMMAND_BATCHES = [
  "B05", "B10", "B13", "B14", "B16", "B23", "B26", "B29", "B36",
  "B38", "B40", "B65", "B67", "B74", "B83", "B89", "B98", "B101",
] as const;
const ROUTES = ["media", "notification", "fulfillment", "integration", "data"] as const;

export interface CommandAdapterConfiguration {
  readonly endpoint: URL;
  readonly signingSecretReference: SecretReference;
  readonly responseVerificationKeyReference: SecretReference;
  readonly responseSignatureScheme: PartnerWebhookSignatureScheme;
  readonly responseMaximumClockSkewSeconds?: number;
  readonly timeoutMs?: number;
}

export interface WorkerConfiguration {
  readonly appEnvironment: "development" | "staging" | "production";
  readonly deploymentProfile: "single-node" | "distributed";
  readonly databasePath: string;
  readonly postgresRuntimeOptions: PostgresRuntimeOptions | undefined;
  readonly actor: ActorContext;
  readonly workerOptions: WorkerOptions;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly metricsTokenSha256: string | undefined;
  readonly externalCommandAdapters: Readonly<Record<`B${string}`, CommandAdapterConfiguration>>;
  readonly routeAdapters: Readonly<Record<WorkerRoute, CommandAdapterConfiguration>>;
}

export function loadWorkerConfiguration(environment: NodeJS.ProcessEnv, productRoot: string): WorkerConfiguration {
  const appEnvironment = enumValue(
    environment.APP_ENV?.trim().toLowerCase() || "development",
    "APP_ENV",
    ["development", "staging", "production"] as const,
  );
  const databasePath = resolveProductPath(
    environment.LTM_DATABASE_PATH?.trim() || ".data/ltm-local.sqlite",
    productRoot,
  );
  if (appEnvironment === "production" && databasePath === ":memory:") {
    throw new DomainError("CONFIGURATION_INVALID", "production worker cannot use an in-memory database");
  }
  const deploymentProfile = enumValue(
    environment.LTM_DEPLOYMENT_PROFILE?.trim() || (appEnvironment === "production" ? "distributed" : "single-node"),
    "LTM_DEPLOYMENT_PROFILE",
    ["single-node", "distributed"] as const,
  );
  if (deploymentProfile === "distributed" && environment.LTM_DATABASE_PATH?.trim()) {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "LTM_DATABASE_PATH is incompatible with the distributed PostgreSQL worker profile",
    );
  }
  if (appEnvironment === "production" && deploymentProfile === "single-node" &&
      environment.LTM_ALLOW_SINGLE_NODE_SQLITE !== "true") {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "single-node production worker SQLite requires explicit LTM_ALLOW_SINGLE_NODE_SQLITE=true acceptance",
    );
  }
  const externalCommandAdapters = parseAdapters(
    environment.LTM_EXTERNAL_COMMAND_ADAPTERS_JSON,
    "LTM_EXTERNAL_COMMAND_ADAPTERS_JSON",
  );
  const routeAdapters = parseAdapters(
    environment.LTM_OUTBOX_ROUTE_ADAPTERS_JSON,
    "LTM_OUTBOX_ROUTE_ADAPTERS_JSON",
  );
  if (appEnvironment === "production") {
    requireKeys(externalCommandAdapters, EXTERNAL_COMMAND_BATCHES, "external command batches");
    requireKeys(routeAdapters, ROUTES, "outbox routes");
  }
  const metricsTokenSha256 = optionalDigest(environment.LTM_METRICS_TOKEN_SHA256, "LTM_METRICS_TOKEN_SHA256");
  if (appEnvironment === "production" && metricsTokenSha256 === undefined) {
    throw new DomainError("CONFIGURATION_INVALID", "production worker requires LTM_METRICS_TOKEN_SHA256");
  }
  return {
    appEnvironment,
    deploymentProfile,
    databasePath,
    postgresRuntimeOptions: deploymentProfile === "distributed"
      ? postgresRuntimeOptions(environment, appEnvironment)
      : undefined,
    actor: {
      actorId: token(environment.LTM_WORKER_ACTOR_ID ?? "ltm-production-worker", "LTM_WORKER_ACTOR_ID"),
      tenantId: token(required(environment.LTM_WORKER_TENANT_ID, "LTM_WORKER_TENANT_ID"), "LTM_WORKER_TENANT_ID"),
      roles: ["service_account"],
      permissions: [
        "outbox:read",
        "outbox:publish",
        "record:read",
        "record:purpose:cross",
        "external-command:read",
        "external-command:transition",
        "audit:append",
      ],
      purpose: "external_provider_delivery",
      requestId: `worker:${token(environment.LTM_WORKER_ID ?? "ltm-outbox-worker", "LTM_WORKER_ID")}`,
    },
    workerOptions: {
      workerId: token(environment.LTM_WORKER_ID ?? "ltm-outbox-worker", "LTM_WORKER_ID"),
      batchSize: integerValue(environment.LTM_WORKER_BATCH_SIZE, 50, 1, 200, "LTM_WORKER_BATCH_SIZE"),
      leaseMs: integerValue(environment.LTM_WORKER_LEASE_MS, 30_000, 1_000, 900_000, "LTM_WORKER_LEASE_MS"),
      idlePollMs: integerValue(environment.LTM_WORKER_IDLE_POLL_MS, 1_000, 25, 60_000, "LTM_WORKER_IDLE_POLL_MS"),
    },
    healthHost: host(environment.LTM_WORKER_HEALTH_HOST ?? "0.0.0.0", "LTM_WORKER_HEALTH_HOST"),
    healthPort: integerValue(environment.LTM_WORKER_HEALTH_PORT, 8_090, 1, 65_535, "LTM_WORKER_HEALTH_PORT"),
    metricsTokenSha256,
    externalCommandAdapters: externalCommandAdapters as Readonly<Record<`B${string}`, CommandAdapterConfiguration>>,
    routeAdapters: routeAdapters as Readonly<Record<WorkerRoute, CommandAdapterConfiguration>>,
  };
}

function postgresRuntimeOptions(
  environment: NodeJS.ProcessEnv,
  appEnvironment: WorkerConfiguration["appEnvironment"],
): PostgresRuntimeOptions {
  const connectionString = required(environment.DATABASE_URL, "DATABASE_URL");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must use postgres:// or postgresql://");
  }
  if (url.username.length === 0 || url.hostname.length === 0 || url.pathname.length <= 1 || url.hash.length > 0) {
    throw new DomainError("CONFIGURATION_INVALID", "DATABASE_URL must identify a PostgreSQL role, host, and database");
  }
  if (appEnvironment === "production" && url.searchParams.get("sslmode") !== "verify-full") {
    throw new DomainError(
      "CONFIGURATION_INVALID",
      "distributed production worker DATABASE_URL must set sslmode=verify-full",
    );
  }
  return {
    connectionString,
    applicationName: token(environment.LTM_POSTGRES_WORKER_APPLICATION_NAME ?? "ltm-worker", "LTM_POSTGRES_WORKER_APPLICATION_NAME"),
    poolMax: integerValue(environment.LTM_POSTGRES_WORKER_POOL_MAX, 5, 1, 100, "LTM_POSTGRES_WORKER_POOL_MAX"),
    connectionTimeoutMs: integerValue(
      environment.LTM_POSTGRES_CONNECTION_TIMEOUT_MS,
      5_000,
      100,
      60_000,
      "LTM_POSTGRES_CONNECTION_TIMEOUT_MS",
    ),
    idleTimeoutMs: integerValue(
      environment.LTM_POSTGRES_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      600_000,
      "LTM_POSTGRES_IDLE_TIMEOUT_MS",
    ),
    statementTimeoutMs: integerValue(
      environment.LTM_POSTGRES_STATEMENT_TIMEOUT_MS,
      15_000,
      1_000,
      120_000,
      "LTM_POSTGRES_STATEMENT_TIMEOUT_MS",
    ),
    evidencePolicy: "disabled",
    evidenceEnvironment: appEnvironment === "production" ? "production" : "staging",
  };
}

function optionalDigest(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new DomainError("CONFIGURATION_INVALID", `${label} must be a lowercase SHA-256 digest`);
  return normalized;
}

function host(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 255 || /[\u0000-\u0020\u007f/?#]/.test(normalized)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function parseAdapters(serialized: string | undefined, label: string): Readonly<Record<string, CommandAdapterConfiguration>> {
  if (serialized === undefined || serialized.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 128) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be an object with at most 128 adapters`);
  }
  const result: Record<string, CommandAdapterConfiguration> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    token(key, `${label} key`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const allowed = new Set([
      "endpoint", "signingSecretReference", "responseVerificationKeyReference",
      "responseSignatureScheme", "responseMaximumClockSkewSeconds", "timeoutMs",
    ]);
    if (Object.keys(record).some((field) => !allowed.has(field))) {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key} contains an unsupported field`);
    }
    const endpointValue = requiredString(record.endpoint, `${label}.${key}.endpoint`, 2_048);
    let endpoint: URL;
    try {
      endpoint = new URL(endpointValue);
    } catch {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key}.endpoint must be a URL`);
    }
    if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key}.endpoint must be credential-free HTTPS`);
    }
    const secretReference = requiredString(
      record.signingSecretReference,
      `${label}.${key}.signingSecretReference`,
      2_048,
    );
    if (!secretReference.startsWith("secret-manager:") || secretReference.length === "secret-manager:".length) {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key} must use an AWS Secrets Manager reference`);
    }
    const responseReference = requiredString(
      record.responseVerificationKeyReference,
      `${label}.${key}.responseVerificationKeyReference`,
      2_048,
    );
    if (!responseReference.startsWith("secret-manager:") || responseReference.length === "secret-manager:".length) {
      throw new DomainError("CONFIGURATION_INVALID", `${label}.${key} response verification must use an AWS Secrets Manager reference`);
    }
    const responseSignatureScheme = enumUnknown(
      record.responseSignatureScheme,
      `${label}.${key}.responseSignatureScheme`,
      ["hmac-sha256", "ed25519", "es256"] as const,
    );
    result[key] = {
      endpoint,
      signingSecretReference: secretReference as SecretReference,
      responseVerificationKeyReference: responseReference as SecretReference,
      responseSignatureScheme,
      ...(record.responseMaximumClockSkewSeconds === undefined
        ? {}
        : { responseMaximumClockSkewSeconds: integerUnknown(
            record.responseMaximumClockSkewSeconds,
            30,
            900,
            `${label}.${key}.responseMaximumClockSkewSeconds`,
          ) }),
      ...(record.timeoutMs === undefined
        ? {}
        : { timeoutMs: integerUnknown(record.timeoutMs, 1_000, 60_000, `${label}.${key}.timeoutMs`) }),
    } satisfies PartnerCommandAdapterOptions;
  }
  return result;
}

function requireKeys<T extends string>(value: Readonly<Record<string, unknown>>, keys: readonly T[], label: string): void {
  const missing = keys.filter((key) => value[key] === undefined);
  if (missing.length > 0) {
    throw new DomainError("CONFIGURATION_INVALID", `production configuration is missing ${label}: ${missing.join(",")}`);
  }
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw new DomainError("CONFIGURATION_INVALID", `${label} is required`);
  return value.trim();
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("CONFIGURATION_INVALID", `${label} must be a string`);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function token(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new DomainError("CONFIGURATION_INVALID", `${label} must be an integer`);
  return integerUnknown(Number(value), minimum, maximum, label);
}

function integerUnknown(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function enumValue<T extends string>(value: string, label: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  return value as T;
}

function enumUnknown<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} is invalid`);
  }
  return value as T;
}

function resolveProductPath(value: string, productRoot: string): string {
  if (value === ":memory:") return value;
  return isAbsolute(value) ? value : resolve(productRoot, value);
}
