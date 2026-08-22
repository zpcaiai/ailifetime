import { buildIntegrationGateway } from "./bootstrap.js";
import { loadIntegrationGatewayConfiguration } from "./config.js";
import { createIntegrationGatewayServer } from "./gateway.js";

let cleanup: (() => Promise<void>) | undefined;

try {
  const configuration = loadIntegrationGatewayConfiguration(process.env);
  const built = await buildIntegrationGateway(configuration);
  cleanup = built.close;
  const server = createIntegrationGatewayServer({
    ...built.options,
    logger(entry) {
      process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
    },
  });
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: "gateway.stopping", signal })}\n`);
    server.close((error) => {
      void built.close().finally(() => {
        if (error !== undefined) process.exitCode = 1;
      });
    });
    setTimeout(() => {
      server.closeAllConnections();
      void built.close();
      process.exitCode = 1;
    }, 10_000).unref();
  };
  server.on("error", (error) => {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: "gateway.error", error: error.name })}\n`);
    if (!server.listening) {
      void built.close();
      process.exitCode = 1;
    }
  });
  server.listen(configuration.port, configuration.host, () => {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "gateway.started",
      host: configuration.host,
      port: configuration.port,
      environment: configuration.appEnvironment,
    })}\n`);
  });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  if (cleanup !== undefined) await cleanup();
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "gateway.start_failed",
    error: error instanceof Error ? error.name : "UnknownError",
  })}\n`);
  process.exitCode = 1;
}
