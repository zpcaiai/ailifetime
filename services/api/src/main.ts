import { fileURLToPath } from "node:url";
import { createCapabilityRegistry, externalBusinessEventReducerRegistry } from "@ltm/capabilities";
import {
  isDomainError,
  LifeTimeMachineRuntime,
  PostgresLifeTimeMachineRuntime,
  type LifeTimeMachineRuntimePort,
} from "@ltm/core";
import { loadApiConfiguration } from "./config.js";
import { createApiServer, type ApiLogEntry } from "./server.js";
import { ProductionDomainRuntime } from "./domain-runtime.js";
import { configuredTimelineArtifacts } from "./timeline-artifacts.js";

const PRODUCT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function log(entry: ApiLogEntry): void {
  const target = entry.level === "error" ? process.stderr : process.stdout;
  target.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

let runtimeForCleanup: LifeTimeMachineRuntimePort | undefined;
let domainRuntimeForCleanup: ProductionDomainRuntime | undefined;

async function run(): Promise<void> {
  const configuration = loadApiConfiguration(process.env, PRODUCT_ROOT);
  const runtime: LifeTimeMachineRuntimePort = configuration.deploymentProfile === "distributed"
    ? await PostgresLifeTimeMachineRuntime.connect(
        configuration.postgresRuntimeOptions ?? (() => {
          throw new Error("PostgreSQL runtime configuration is missing");
        })(),
      )
    : new LifeTimeMachineRuntime(configuration.runtimeOptions);
  runtimeForCleanup = runtime;
  const domainRuntime = configuration.deploymentProfile === "distributed"
    ? new ProductionDomainRuntime(configuration.postgresRuntimeOptions?.connectionString ?? (() => { throw new Error("PostgreSQL domain connection is missing"); })(), {
      applicationName: "ltm-api-domain-runtime",
      ...(configuration.postgresRuntimeOptions?.poolMax === undefined ? {} : { poolMax: configuration.postgresRuntimeOptions.poolMax }),
    })
    : undefined;
  domainRuntimeForCleanup = domainRuntime;
  const timelineArtifacts = configuredTimelineArtifacts(process.env, configuration.appEnvironment);
  const server = createApiServer({
    runtime,
    authenticator: configuration.authenticator,
    capabilityRegistry: createCapabilityRegistry(),
    externalBusinessEventReducerRegistry,
    bodyLimitBytes: configuration.bodyLimitBytes,
    allowSandboxStepUpHeader: configuration.allowSandboxStepUpHeader,
    appEnvironment: configuration.appEnvironment,
    clientIntegrations: configuration.clientIntegrations,
    ...(timelineArtifacts === undefined ? {} : { timelineArtifacts }),
    ...(domainRuntime === undefined ? {} : { domainRuntime }),
    ...(configuration.browserOidcConfiguration === undefined
      ? {}
      : { browserOidcConfiguration: configuration.browserOidcConfiguration }),
    ...(configuration.staticDirectory === undefined ? {} : { staticDirectory: configuration.staticDirectory }),
    ...(configuration.metricsTokenSha256 === undefined
      ? {}
      : { metricsTokenSha256: configuration.metricsTokenSha256 }),
    logger: log,
  });
  let closing = false;
  server.on("error", (error) => {
    log({ level: "error", event: "server.runtime_error", requestId: "server", error: error.name });
    if (!server.listening) {
      closing = true;
      void Promise.resolve(runtime.close());
      void domainRuntime?.close();
      process.exitCode = 1;
    }
  });
  server.listen(configuration.port, configuration.host, () => {
    log({
      level: "info",
      event: "server.started",
      requestId: "startup",
      path: `http://${configuration.host}:${configuration.port}`,
    });
  });

  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log({ level: "info", event: "server.stopping", requestId: signal });
    server.close((error) => {
      void Promise.resolve(runtime.close());
      void domainRuntime?.close();
      if (error !== undefined) {
        log({ level: "error", event: "server.stop_failed", requestId: signal, error: error.name });
        process.exitCode = 1;
      }
    });
    setTimeout(() => {
      server.closeAllConnections();
      void Promise.resolve(runtime.close());
      void domainRuntime?.close();
      process.exitCode = 1;
    }, 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void run().catch(async (error: unknown) => {
  if (runtimeForCleanup !== undefined) {
    await Promise.resolve(runtimeForCleanup.close()).catch(() => undefined);
  }
  if (domainRuntimeForCleanup !== undefined) await domainRuntimeForCleanup.close().catch(() => undefined);
  log({
    level: "error",
    event: "server.start_failed",
    requestId: "startup",
    error: isDomainError(error) ? error.code : error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
