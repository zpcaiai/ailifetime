import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityRegistry } from "@ltm/capabilities";
import { DomainError, LifeTimeMachineRuntime } from "@ltm/core";
import { StaticTokenAuthenticator } from "./auth.js";
import { createApiServer, type ApiLogEntry } from "./server.js";

const PRODUCT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function configuredAuthenticator(): StaticTokenAuthenticator {
  const mode = process.env.LTM_AUTH_MODE?.trim() || "configured-tokens";
  if (mode === "local-synthetic-only") {
    return StaticTokenAuthenticator.localSynthetic(process.env.APP_ENV);
  }
  if (mode !== "configured-tokens") {
    throw new DomainError("VALIDATION_FAILED", "LTM_AUTH_MODE must be configured-tokens or local-synthetic-only");
  }
  return StaticTokenAuthenticator.fromEnvironment(process.env.LTM_API_TOKENS_JSON);
}

function staticDirectory(): string | null | undefined {
  const configured = process.env.LTM_STATIC_DIR?.trim();
  if (configured === undefined || configured.length === 0) return undefined;
  return configured === "disabled" ? null : resolve(PRODUCT_ROOT, configured);
}

function log(entry: ApiLogEntry): void {
  const target = entry.level === "error" ? process.stderr : process.stdout;
  target.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

const databasePath = resolve(PRODUCT_ROOT, process.env.LTM_DATABASE_PATH?.trim() || ".data/ltm-local.sqlite");
const runtime = new LifeTimeMachineRuntime({ databasePath });

try {
  const authMode = process.env.LTM_AUTH_MODE?.trim() || "configured-tokens";
  const configuredStaticDirectory = staticDirectory();
  const appEnvironment = process.env.APP_ENV;
  const server = createApiServer({
    runtime,
    authenticator: configuredAuthenticator(),
    capabilityRegistry: createCapabilityRegistry(),
    bodyLimitBytes: integerEnvironment("LTM_BODY_LIMIT_BYTES", 256 * 1024, 1_024, 10 * 1024 * 1024),
    allowSandboxStepUpHeader:
      authMode === "local-synthetic-only" && process.env.LTM_SANDBOX_STEP_UP_HEADER === "true",
    ...(appEnvironment === undefined ? {} : { appEnvironment }),
    ...(configuredStaticDirectory === undefined ? {} : { staticDirectory: configuredStaticDirectory }),
    logger: log,
  });
  const port = integerEnvironment("PORT", 8_080, 1, 65_535);
  const host = process.env.HOST?.trim() || "127.0.0.1";
  server.listen(port, host, () => {
    log({
      level: "info",
      event: "server.started",
      requestId: "startup",
      path: `http://${host}:${port}`,
    });
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log({ level: "info", event: "server.stopping", requestId: signal });
    server.close((error) => {
      runtime.close();
      if (error !== undefined) {
        log({ level: "error", event: "server.stop_failed", requestId: signal, error: error.message });
        process.exitCode = 1;
      }
    });
    setTimeout(() => {
      server.closeAllConnections();
      runtime.close();
      process.exitCode = 1;
    }, 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  runtime.close();
  const message = error instanceof Error ? error.message : "Unknown startup error";
  log({ level: "error", event: "server.start_failed", requestId: "startup", error: message });
  process.exitCode = 1;
}
