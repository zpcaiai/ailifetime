import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  isDomainError,
  LifeTimeMachineRuntime,
  PostgresLifeTimeMachineRuntime,
  type LifeTimeMachineRuntimePort,
} from "@ltm/core";
import {
  AwsSecretsManagerResolver,
  SignedPartnerCommandAdapter,
  preflightPartnerCommandAdapterCredentials,
} from "@ltm/providers";
import { loadWorkerConfiguration } from "./config.js";
import { createWorkerHealthServer, WorkerMetrics } from "./health.js";
import { DurableOutboxWorker, ProductionRoutePublisher, type ExternalCommandSenders, type WorkerPublishers } from "./index.js";

const PRODUCT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
let runtime: LifeTimeMachineRuntimePort | undefined;
let healthServerForCleanup: Server | undefined;

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const target = level === "error" ? process.stderr : process.stdout;
  target.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details })}\n`);
}

async function run(): Promise<void> {
  const configuration = loadWorkerConfiguration(process.env, PRODUCT_ROOT);
  const secrets = new AwsSecretsManagerResolver();
  const configuredAdapters = [
    ...Object.values(configuration.externalCommandAdapters),
    ...Object.values(configuration.routeAdapters),
  ];
  const uniqueAdapters = new Map(configuredAdapters.map((adapter) => [
    `${adapter.signingSecretReference}\n${adapter.responseVerificationKeyReference}\n${adapter.responseSignatureScheme}`,
    adapter,
  ]));
  for (const adapter of uniqueAdapters.values()) {
    await preflightPartnerCommandAdapterCredentials(adapter, secrets);
  }
  const externalCommandSenders: Record<`B${string}`, SignedPartnerCommandAdapter> = {};
  for (const [batchId, adapter] of Object.entries(configuration.externalCommandAdapters)) {
    externalCommandSenders[batchId as `B${string}`] = new SignedPartnerCommandAdapter(adapter, secrets);
  }
  runtime = configuration.deploymentProfile === "distributed"
    ? await PostgresLifeTimeMachineRuntime.connect(
        configuration.postgresRuntimeOptions ?? (() => {
          throw new Error("PostgreSQL worker configuration is missing");
        })(),
      )
    : new LifeTimeMachineRuntime(configuration.runtimeOptions);
  const actor = { ...configuration.actor, requestId: `worker:${randomUUID()}` };
  const publishers: Partial<Record<keyof typeof configuration.routeAdapters, ProductionRoutePublisher>> = {};
  for (const [route, adapter] of Object.entries(configuration.routeAdapters)) {
    publishers[route as keyof typeof configuration.routeAdapters] = new ProductionRoutePublisher(
      runtime,
      actor,
      externalCommandSenders satisfies ExternalCommandSenders,
      new SignedPartnerCommandAdapter(adapter, secrets),
    );
  }
  const worker = new DurableOutboxWorker(
    runtime,
    actor,
    publishers satisfies WorkerPublishers,
    configuration.workerOptions,
  );
  const controller = new AbortController();
  const metrics = new WorkerMetrics();
  const healthServer = createWorkerHealthServer({
    readiness: () => runtime?.readiness() ?? {
      ready: false,
      database: "error",
      auditChain: "error",
      evidenceTrust: "error",
      consentPolicy: "error",
    },
    ...(configuration.metricsTokenSha256 === undefined ? {} : { metricsTokenSha256: configuration.metricsTokenSha256 }),
  }, metrics);
  healthServerForCleanup = healthServer;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    healthServer.once("error", rejectPromise);
    healthServer.listen(configuration.healthPort, configuration.healthHost, () => {
      healthServer.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const shutdown = (signal: string): void => {
    log("info", "worker.stopping", { signal });
    controller.abort();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  log("info", "worker.started", {
    environment: configuration.appEnvironment,
    deploymentProfile: configuration.deploymentProfile,
    runtimeBackend: runtime.backend,
    workerId: configuration.workerOptions.workerId,
    tenantId: actor.tenantId,
    health: `http://${configuration.healthHost}:${configuration.healthPort}`,
    routes: Object.keys(publishers).sort(),
    externalCommandAdapters: Object.keys(externalCommandSenders).sort(),
  });
  await worker.runUntilAborted(controller.signal, (result) => metrics.record(result));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    healthServer.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  });
  healthServerForCleanup = undefined;
  await Promise.resolve(runtime.close());
  runtime = undefined;
  log("info", "worker.stopped");
}

void run().catch(async (error: unknown) => {
  healthServerForCleanup?.closeAllConnections();
  healthServerForCleanup?.close();
  if (runtime !== undefined) await Promise.resolve(runtime.close()).catch(() => undefined);
  log("error", "worker.start_failed", {
    error: isDomainError(error) ? error.code : error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
