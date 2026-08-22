import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  FetchHttpTransport,
  ProductionIntegrationError,
  assertProductionEndpoint,
  parseJsonObject,
  requiredString,
  toRuntimeExternalEvidence,
  type HttpTransport,
} from "@ltm/providers";
import type { EvidenceOutput } from "./gateway.js";

export interface BearerTokenProvider {
  /** Return a short-lived workload token. Implementations must not cache beyond provider rotation policy. */
  getToken(): Promise<string>;
}

/** Re-reads a projected workload-identity token file for every request so rotation is honored. */
export class RotatingFileBearerTokenProvider implements BearerTokenProvider {
  constructor(private readonly path: string) {
    if (!isAbsolute(path) || path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "API bearer token file must be an absolute path");
    }
  }

  async getToken(): Promise<string> {
    let metadata;
    let bytes: Buffer;
    try {
      metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size < 32 || metadata.size > 16_384 || (metadata.mode & 0o022) !== 0) {
        throw new Error("unsafe token file");
      }
      bytes = await readFile(this.path);
    } catch {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "workload identity token file is unavailable or unsafe", true);
    }
    try {
      const token = bytes.toString("utf8").trim();
      if (token.length < 32 || token.length > 16_384 || /[\u0000-\u0020\u007f]/.test(token)) {
        throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "workload identity token is invalid", true);
      }
      return token;
    } finally {
      bytes.fill(0);
    }
  }
}

export interface ApiEvidenceOutputOptions {
  readonly endpoint: URL;
  readonly purpose: string;
}

/** Direct, authenticated atomic external-event.apply adapter for the LTM API command surface. */
export class ApiExternalBusinessEventOutput implements EvidenceOutput {
  constructor(
    private readonly options: ApiEvidenceOutputOptions,
    private readonly tokens: BearerTokenProvider,
    private readonly transport: HttpTransport = new FetchHttpTransport(),
  ) {
    assertProductionEndpoint(options.endpoint);
    if (options.endpoint.pathname !== "/v1/commands" || options.endpoint.search !== "") {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "external event API endpoint must be the exact /v1/commands path");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(options.purpose)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence API purpose is invalid");
    }
  }

  async publish(input: Parameters<EvidenceOutput["publish"]>[0]): Promise<void> {
    const evidence = toRuntimeExternalEvidence(input.evidence);
    const body = Buffer.from(JSON.stringify({
      command: "external-event.apply",
      input: { evidence, event: input.businessEvent },
    }), "utf8");
    const token = await this.tokens.getToken();
    const response = await this.transport.request({
      url: this.options.endpoint,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": input.businessEvent.eventId,
        "x-purpose": this.options.purpose,
      },
      body,
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
      acceptedStatuses: [200],
    });
    const receipt = parseJsonObject(response.body, "external event API response");
    const meta = objectField(receipt.meta, "external event API response meta");
    if (meta.command !== "external-event.apply") {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "external event API response command binding is invalid");
    }
    const data = objectField(receipt.data, "external event API response data");
    const value = objectField(data.value, "external event API response value");
    if (requiredString(value.eventId, "applied eventId", 128) !== input.businessEvent.eventId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "external event API applied a different event ID");
    }
  }
}

function objectField(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
