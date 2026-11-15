import { createHash } from "node:crypto";
import { DomainError, type ActorContext, type JsonObject, type JsonValue, type LifeTimeMachineRuntimePort } from "@ltm/core";
import { parseWardrobeEdit, wardrobeStylesForCatalog, wardrobeSeriesForCatalog, WARDROBE_CATALOG_VERSION, type CapabilityRegistry } from "@ltm/capabilities";
import { TimelineDeliveryService } from "./timeline-delivery.js";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";

// Display copy lives outside the immutable catalog used by quotes and generation.
const classicDescriptions: Readonly<Record<string, string>> = Object.freeze({
  "east-pankou-v1": "哑光棉布 · 中式小立领 · 细盘扣",
  "east-song-v1": "柔软织物 · 素色交领 · 内外叠穿",
  "east-qipao-v1": "挺括衣身 · 包覆式立领 · 旗袍或长衫剪裁",
  "east-hanfu-v1": "细纹织物 · 轻松交领 · 叠襟宽袖",
  "retro-eighties-v1": "低饱和大地色棉布 · 复古翻领 · 日常衬衣或夹克",
  "retro-hongkong-v1": "哑光西服面料 · 松量西装剪裁 · 素色衬衣内搭",
  "retro-denim-v1": "靛蓝牛仔斜纹 · 短夹克剪裁 · 简洁内衫",
  "retro-white-v1": "白色棉布 · 宽松复古衬领 · 自然褶皱",
  "together-knit-v1": "低饱和同色毛线 · 柔软针织 · 两人各自合身",
  "together-white-v1": "白色棉布 · 两件简洁衬衣 · 互补剪裁",
  "together-trench-v1": "挺括风衣面料 · 经典驳领 · 两件束腰风衣",
  "together-silver-v1": "柔软针织 · 合身外套叠搭 · 柔和同色系",
  "daily-white-v1": "白色棉布 · 简洁衬领 · 挺爽自然褶",
  "daily-cream-v1": "奶油色细纱 · 包覆式领口 · 柔软针目",
  "daily-linen-v1": "中性色亚麻 · 细竹节纹 · 松身衬衣",
  "daily-suit-v1": "素色西服衣料 · 利落驳领 · 朴素内衫",
  "wedding-simple-v1": "包覆式礼服面料 · 简洁剪裁 · 婚纱或礼服西装",
  "wedding-vintage-v1": "含蓄蕾丝或羊毛 · 复古礼服剪裁 · 细致织纹",
  "wedding-chinese-v1": "红色丝织 · 中式礼服剪裁 · 细金色刺绣",
  "wedding-anniversary-v1": "香槟色衣料 · 纪念礼服剪裁 · 含蓄绣纹",
  "milestone-graduation-v1": "深色袍身 · 宽松肩袖 · 素衬衣叠领",
  "milestone-career-v1": "素色通勤衣料 · 自然肩线 · 衬衣与外套",
  "milestone-birthday-v1": "柔和礼服衣料 · 合龄包覆剪裁 · 裙装或正装",
  "milestone-retirement-v1": "低饱和暖色 · 舒展肩袖 · 衬衣叠搭外套",
  "winter-wool-v1": "温暖厚毛呢 · 清晰结构缝 · 柔软呢面绒",
  "winter-scarf-v1": "保暖夹克面料 · 围巾自然垂坠 · 领口柔软叠搭",
  "winter-knit-v1": "厚实毛线 · 立体麻花针法 · 自然合身",
  "winter-puffer-v1": "哑光外层 · 分段绗缝 · 保暖包覆剪裁",
  "newyear-chinese-v1": "节庆红衣料 · 中式立领与盘扣 · 低调绣纹",
  "newyear-red-v1": "暖红毛线 · 自然针织纹 · 包覆式领口",
  "newyear-pair-v1": "同系节庆红 · 双人互补剪裁 · 收敛衣缘细节",
});

export function wardrobeCommandId(actor: ActorContext, rootId: string, age: number, key: string): string {
  return `wardrobe-${createHash("sha256").update(JSON.stringify([actor.tenantId,actor.actorId,rootId,age,key])).digest("hex")}`;
}

export class WardrobeService {
  constructor(private readonly runtime: LifeTimeMachineRuntimePort, private readonly registry: CapabilityRegistry, private readonly artifacts?: TimelineArtifactReader) {}
  async context(actor: ActorContext, rootId: string, age: number, catalogVersion: unknown = "lifetime-wardrobe.v3") {
    if (!Number.isInteger(age) || age < 0 || age > 100) throw new DomainError("VALIDATION_FAILED", "wardrobe age invalid");
    if (catalogVersion !== "lifetime-wardrobe.v3" && catalogVersion !== WARDROBE_CATALOG_VERSION) throw new DomainError("VALIDATION_FAILED", "unknown wardrobe discovery catalog");
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
      catalogVersion,
      series: wardrobeSeriesForCatalog(catalogVersion),
      styles: wardrobeStylesForCatalog(catalogVersion).map(style => {
        const minAge = style.minAge ?? 0, maxAge = style.maxAge ?? 100, minPeople = style.minPeople ?? 1;
        const unavailableReason = ids.length < minPeople ? "需双人照片" : age < minAge || age > maxAge ? `适用 ${minAge}–${maxAge} 岁` : "";
        return { id: style.id, label: style.label, description: style.description ?? classicDescriptions[style.id] ?? style.label, seriesId: style.seriesId ?? "legacy", seriesLabel: style.seriesLabel ?? "原有基础款", minAge, maxAge, minPeople,
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
    const bytes = await this.artifacts.read(context.sourceNode.asset!, actor);
    if (bytes.byteLength !== context.sourceNode.asset!.byteLength || createHash("sha256").update(bytes).digest("hex") !== context.sourceNode.asset!.sha256) throw new DomainError("DEPENDENCY_UNAVAILABLE", "wardrobe source bytes changed");
    const jobId = wardrobeCommandId(actor, rootId, age, key);
    const result = await this.registry.execute(this.runtime, "B14", { actor, idempotencyKey: `wardrobe:${key}`, input: {
      jobId, sourceAssetId: context.sourceAssetId, participantIds: context.participants.map(p => p.participantId), targetAges: [age], wardrobeEdit,
      timelineProfile: "wardrobe-edit-v1", seed: jobId, promptPolicyVersion: "wardrobe-only.v1", illustrativeLabel: true,
    } });
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.externalCommandId !== "string") throw new DomainError("DEPENDENCY_UNAVAILABLE", "wardrobe command receipt invalid");
    return { commandId: result.externalCommandId, replayed: result.replayed === true };
  }
}
