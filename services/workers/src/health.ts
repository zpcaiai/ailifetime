import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface WorkerReadiness {
  readonly ready: boolean;
  readonly database: string;
  readonly auditChain: string;
  readonly evidenceTrust: string;
}

export interface WorkerHealthOptions {
  readonly readiness: () => WorkerReadiness | Promise<WorkerReadiness>;
  readonly metricsTokenSha256?: string;
  readonly startedAt?: Date;
}

export class WorkerMetrics {
  readonly startedAt: Date;
  runs = 0;
  published = 0;
  failed = 0;
  lastCycleAt: Date | undefined;

  constructor(startedAt = new Date()) {
    this.startedAt = startedAt;
  }

  record(result: { readonly published: number; readonly failed: number }, at = new Date()): void {
    this.runs += 1;
    this.published += result.published;
    this.failed += result.failed;
    this.lastCycleAt = at;
  }
}

export function createWorkerHealthServer(options: WorkerHealthOptions, metrics = new WorkerMetrics(options.startedAt)): Server {
  if (options.metricsTokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.metricsTokenSha256)) {
    throw new Error("metricsTokenSha256 must be a lowercase SHA-256 digest");
  }
  return createServer((request, response) => {
    void handleRequest(request, response, options, metrics);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkerHealthOptions,
  metrics: WorkerMetrics,
): Promise<void> {
  try {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    const path = new URL(request.url ?? "/", "http://worker.invalid").pathname;
    if (path === "/health/live") return json(response, 200, { status: "live" });
    if (path === "/health/ready") {
      const readiness = await options.readiness();
      return json(response, readiness.ready ? 200 : 503, readiness);
    }
    if (path === "/metrics") {
      if (options.metricsTokenSha256 === undefined || !authorized(request.headers.authorization, options.metricsTokenSha256)) {
        response.setHeader("www-authenticate", "Bearer");
        return json(response, 401, { error: "unauthorized" });
      }
      const readiness = await options.readiness();
      const now = Date.now();
      const body = [
        "# TYPE ltm_worker_ready gauge",
        `ltm_worker_ready ${readiness.ready ? 1 : 0}`,
        "# TYPE ltm_worker_runs_total counter",
        `ltm_worker_runs_total ${metrics.runs}`,
        "# TYPE ltm_worker_events_published_total counter",
        `ltm_worker_events_published_total ${metrics.published}`,
        "# TYPE ltm_worker_events_failed_total counter",
        `ltm_worker_events_failed_total ${metrics.failed}`,
        "# TYPE ltm_worker_uptime_seconds gauge",
        `ltm_worker_uptime_seconds ${Math.max(0, Math.floor((now - metrics.startedAt.getTime()) / 1_000))}`,
        "# TYPE ltm_worker_last_cycle_timestamp_seconds gauge",
        `ltm_worker_last_cycle_timestamp_seconds ${metrics.lastCycleAt === undefined ? 0 : Math.floor(metrics.lastCycleAt.getTime() / 1_000)}`,
        "",
      ].join("\n");
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(body);
      return;
    }
    return json(response, 404, { error: "not_found" });
  } catch {
    if (!response.headersSent) json(response, 503, { error: "readiness_unavailable" });
    else response.destroy();
  }
}

function authorized(header: string | undefined, expectedDigest: string): boolean {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (match?.[1] === undefined || match[1].length < 16 || match[1].length > 4_096) return false;
  const actual = createHash("sha256").update(match[1], "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(expectedDigest, "hex"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
