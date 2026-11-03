import { createHash } from "node:crypto";
import { DomainError, parseTimelineImageAsset, type ActorContext, type TimelineImageAsset } from "@ltm/core";
import { BrokerClient } from "./client-integrations.js";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";

/** Only accepted B07 metadata is supplied by the generation service, never a client URL. */
export class BrokerTimelineSourceReader implements TimelineArtifactReader {
  constructor(private readonly broker: BrokerClient) {}
  async read(value: TimelineImageAsset, actor?: Pick<ActorContext,"tenantId"|"actorId">): Promise<Uint8Array> {
    const asset = parseTimelineImageAsset(value);
    if (!actor || asset.mimeType !== "image/jpeg") throw new DomainError("AUTH_FORBIDDEN", "approved source owner and JPEG are required");
    const context: ActorContext = { ...actor, roles: ["consumer"], purpose: "age_transformation", requestId: "seedream-source-read" };
    const key = createHash("sha256").update(JSON.stringify([actor.tenantId,actor.actorId,asset])).digest("hex");
    const result = await this.broker.json("POST", `/v1/media/assets/${encodeURIComponent(asset.id)}/download-authorizations`, {
      principal: { ...actor, roles: context.roles, purpose: context.purpose }, audience: actor.actorId,
      purpose: context.purpose, ttlSeconds: 60,
    }, `seedream-source:${key}`, context.requestId) as Record<string,unknown>;
    if (result === null || typeof result !== "object" || typeof result.token !== "string" ||
        typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "source download authorization is invalid");
    }
    return this.broker.authorizedImage(result.token, context, asset);
  }
}
