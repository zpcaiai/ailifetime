import { createHash } from "node:crypto";
import { DomainError, type ActorContext, type JsonObject, type JsonValue, type LifeTimeMachineRuntimePort } from "@ltm/core";
import { parseWardrobeEdit, WARDROBE_STYLES, type CapabilityRegistry } from "@ltm/capabilities";
import { TimelineDeliveryService } from "./timeline-delivery.js";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";

export class WardrobeService {
  constructor(private readonly runtime: LifeTimeMachineRuntimePort, private readonly registry: CapabilityRegistry, private readonly artifacts?: TimelineArtifactReader) {}
  async context(actor: ActorContext, rootId: string, age: number) {
    if (!Number.isInteger(age) || age < 0 || age > 100) throw new DomainError("VALIDATION_FAILED", "wardrobe age invalid");
    const view = await new TimelineDeliveryService(this.runtime).get(actor, rootId);
    const root = await this.runtime.getRecord(actor, "generation.timeline-commands", rootId);
    if (root.data.wardrobeEdit !== undefined) throw new DomainError("VALIDATION_FAILED", "choose the original age photo for another wardrobe edit");
    const node = view.nodes.find(n => n.targetAge === age);
    if (node?.status !== "ready" || !node.asset) throw new DomainError("VERSION_CONFLICT", "wardrobe requires an accepted age photo");
    const ids = root.data.participantIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || ids.some(id => typeof id !== "string")) throw new DomainError("VALIDATION_FAILED", "wardrobe requires one or two ordered participants");
    const participants = await Promise.all((ids as string[]).map(async (participantId, index) => {
      let authorized = false;
      try { await this.runtime.assertConsent(actor, { participantIds: [participantId], purpose: "age_transformation", scope: { resource: `media.asset:${view.sourceAssetId}`, action: "wardrobe" } }); authorized = true; }
      catch (error) { if (!(error instanceof DomainError) || !error.code.startsWith("CONSENT_")) throw error; }
      return { participantId, position: ids.length === 1 ? "single" : index === 0 ? "left" : "right", authorized };
    }));
    return { sourceAssetId: view.sourceAssetId as string, sourceRootCommandId: rootId, sourceCommandId: node.commandId, targetAge: age,
      sourceNode: { ...node, downloadPath: this.artifacts ? `/v1/timelines/${rootId}/nodes/${age}/image` : null }, participants,
      catalogVersion: "lifetime-wardrobe.v1",
      styles: WARDROBE_STYLES.map(style => {
        const minAge = style.minAge ?? 0, maxAge = style.maxAge ?? 100, minPeople = style.minPeople ?? 1;
        const unavailableReason = ids.length < minPeople ? "需双人照片" : age < minAge || age > maxAge ? `适用 ${minAge}–${maxAge} 岁` : "";
        return { id: style.id, label: style.label, seriesId: style.seriesId ?? "legacy", seriesLabel: style.seriesLabel ?? "原有基础款", minAge, maxAge, minPeople,
          available: unavailableReason === "", unavailableReason, legacy: !style.seriesId };
      }), policyVersion: "wardrobe-edit-consent-v1" };
  }
  async create(actor: ActorContext, rootId: string, age: number, input: Readonly<Record<string, unknown>>, key: string) {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "selections")) throw new DomainError("VALIDATION_FAILED", "wardrobe accepts only per-person selections");
    const context = await this.context(actor, rootId, age);
    const wardrobeEdit = parseWardrobeEdit({ schemaVersion: "ltm.wardrobe-edit.v1", sourceRootCommandId: rootId, sourceCommandId: context.sourceCommandId,
      targetAge: age, sourceImage: context.sourceNode.asset! as unknown as JsonObject, selections: input.selections as JsonValue });
    if (!context.participants.every(p => p.authorized)) throw new DomainError("CONSENT_REQUIRED", "each participant must independently authorize wardrobe editing");
    if (!this.artifacts) throw new DomainError("DEPENDENCY_UNAVAILABLE", "wardrobe source image reader is not configured");
    const bytes = await this.artifacts.read(context.sourceNode.asset!);
    if (bytes.byteLength !== context.sourceNode.asset!.byteLength || createHash("sha256").update(bytes).digest("hex") !== context.sourceNode.asset!.sha256) throw new DomainError("DEPENDENCY_UNAVAILABLE", "wardrobe source bytes changed");
    const jobId = `wardrobe-${createHash("sha256").update(JSON.stringify([actor.tenantId,actor.actorId,rootId,age,key])).digest("hex")}`;
    const result = await this.registry.execute(this.runtime, "B14", { actor, idempotencyKey: `wardrobe:${key}`, input: {
      jobId, sourceAssetId: context.sourceAssetId, participantIds: context.participants.map(p => p.participantId), targetAges: [age], wardrobeEdit,
      timelineProfile: "wardrobe-edit-v1", seed: jobId, promptPolicyVersion: "wardrobe-only.v1", illustrativeLabel: true,
    } });
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.externalCommandId !== "string") throw new DomainError("DEPENDENCY_UNAVAILABLE", "wardrobe command receipt invalid");
    return { commandId: result.externalCommandId, replayed: result.replayed === true };
  }
}
