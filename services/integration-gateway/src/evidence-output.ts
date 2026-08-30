import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
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

export interface EvidenceSinkPermissionPreflight {
  readonly actorId: string;
  readonly tenantId: string;
  readonly permissions: readonly ["evidence:register", "external-event:apply"];
}

/**
 * Authenticated API output for both atomic provider business events and direct
 * signed evidence registration. The callback lease keeps the exact envelope
 * durable across transient API failures.
 */
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
    const businessEvent = input.businessEvent;
    if (businessEvent === undefined &&
        (evidence.canonicalClaimsSha256 !== undefined || evidence.businessEventSha256 !== undefined)) {
      throw new ProductionIntegrationError(
        "PROVIDER_RESPONSE_INVALID",
        "direct evidence registration cannot contain an unattached business event digest",
      );
    }
    const command = businessEvent === undefined ? "evidence.register" : "external-event.apply";
    const body = Buffer.from(JSON.stringify(businessEvent === undefined
      ? { command, input: { evidence } }
      : { command, input: { evidence, event: businessEvent } }), "utf8");
    const token = await this.tokens.getToken();
    const response = await this.transport.request({
      url: this.options.endpoint,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": businessEvent?.eventId ?? directEvidenceSemanticIdempotencyKey(
          input.evidence,
          input.providerEventId,
        ),
        "x-purpose": this.options.purpose,
      },
      body,
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
      acceptedStatuses: [200],
    });
    const receipt = parseJsonObject(response.body, "evidence API response");
    const meta = objectField(receipt.meta, "evidence API response meta");
    if (meta.command !== command) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "evidence API response command binding is invalid");
    }
    const data = objectField(receipt.data, "evidence API response data");
    const value = objectField(data.value, "evidence API response value");
    if (businessEvent === undefined) {
      if (requiredString(value.evidenceId, "registered evidenceId", 128) !== input.evidence.evidenceId) {
        throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "evidence API registered a different evidence ID");
      }
    } else if (requiredString(value.eventId, "applied eventId", 128) !== businessEvent.eventId) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "external event API applied a different event ID");
    }
  }

  /** Proves that this exact rotating bearer identity owns both sink permissions. */
  async preflightPermissions(): Promise<EvidenceSinkPermissionPreflight> {
    const token = await this.tokens.getToken();
    const endpoint = new URL("/v1/integrations/evidence-sink/preflight", this.options.endpoint);
    const response = await this.transport.request({
      url: endpoint,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-purpose": this.options.purpose,
      },
      body: Buffer.from("{}", "utf8"),
      timeoutMs: 10_000,
      maximumResponseBytes: 16_384,
      acceptedStatuses: [200],
    });
    const receipt = parseJsonObject(response.body, "evidence sink preflight response");
    if (receipt.schemaVersion !== "ltm.evidence-sink-preflight.v1" ||
        !Array.isArray(receipt.permissions) || receipt.permissions.length !== 2 ||
        receipt.permissions[0] !== "evidence:register" || receipt.permissions[1] !== "external-event:apply") {
      throw new ProductionIntegrationError(
        "PROVIDER_RESPONSE_INVALID",
        "evidence sink preflight did not prove both required permissions",
      );
    }
    const principal = objectField(receipt.principal, "evidence sink preflight principal");
    return {
      actorId: requiredString(principal.actorId, "evidence sink principal actorId", 128),
      tenantId: requiredString(principal.tenantId, "evidence sink principal tenantId", 128),
      permissions: ["evidence:register", "external-event:apply"],
    };
  }
}

/**
 * One provider decision event has one permanent API idempotency identity,
 * independent of a newly generated LTM evidenceId or webhook nonce.
 */
export function directEvidenceSemanticIdempotencyKey(
  evidence: Parameters<EvidenceOutput["publish"]>[0]["evidence"],
  providerEventId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerEventId)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "direct evidence provider event ID is invalid");
  }
  const values = [
    evidence.tenantId,
    evidence.binding.batchId,
    evidence.binding.operation,
    evidence.provider,
    providerEventId,
  ];
  const canonical = values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function objectField(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
