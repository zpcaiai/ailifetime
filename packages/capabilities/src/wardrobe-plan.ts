import { createHash } from "node:crypto";
import { bindTimelineResultManifest, DomainError, parseTimelineImageAsset, type ActorContext, type LifeTimeMachineRuntimePort } from "@ltm/core";
import type { JsonObject, JsonValue } from "./registry.js";
import { buildAgeGenerationPlan } from "./age-generation-plan.js";

type WardrobeStyle = Readonly<{ id: string; label: string; instruction: string; seriesId?: string; seriesLabel?: string; minAge?: number; maxAge?: number; minPeople?: number }>;
// IDs and instructions are immutable: signed jobs and recovery bind these exact IDs.
const series = (id: string, label: string, looks: Array<[string, string, string, number?, number?]>): WardrobeStyle[] => looks.map(([key, name, instruction, minAge = 0, minPeople = 1]) => Object.freeze({
  id: `${id}-${key}-v1`, label: name, seriesId: id, seriesLabel: label, minAge, maxAge: 100, minPeople,
  instruction: `${instruction}. Natural fabric texture, believable seams, folds and fit. Preserve gender presentation; use modest infant/child garments at young ages. Clothing only; do not add props, change background or apply a photo filter.`,
}));
export const WARDROBE_STYLES: readonly WardrobeStyle[] = Object.freeze([
  { id: "casual", label: "日常", instruction: "plain comfortable everyday clothing, natural fabric and fit" },
  { id: "formal", label: "正装", instruction: "neat formal portrait clothing, tailored appropriately to the subject's age" },
  { id: "traditional", label: "中式", instruction: "modest Chinese-style portrait clothing with age-appropriate fabric, coverage and fit" },
  ...series("east", "新中式 · 东方岁月", [
    ["pankou", "素雅盘扣", "Understated Chinese mandarin-collar clothing with delicate knotted buttons and matte cotton"],
    ["song", "宋风日常", "Simple Song-inspired everyday layered robes, restrained cross collars and soft natural fabric"],
    ["qipao", "旗袍长衫", "Classic modest qipao or long Chinese changshan matching the source gender presentation, non-revealing cut"],
    ["hanfu", "改良汉服", "Modernized hanfu, practical cross-collar layers and subtle woven texture"],
  ]),
  ...series("retro", "复古 · 时光照相馆", [
    ["eighties", "八十年代衣着", "1980s everyday cotton shirt or jacket, period collar and restrained earthy colors"],
    ["hongkong", "九十年代港风", "1990s Hong Kong-inspired relaxed blazer and understated shirt, period-appropriate tailoring"],
    ["denim", "千禧牛仔", "Early-2000s classic denim jacket with a simple covered inner shirt, authentic denim weave"],
    ["white", "经典白衬衫", "Vintage classic white cotton shirt, relaxed period collar and natural creases"],
  ]),
  ...series("together", "情侣 · 陪你到白头", [
    ["knit", "同色针织", "Coordinated couple knitwear in the same muted color family, distinct correctly fitted garments", 18, 2],
    ["white", "白衬衫", "Coordinated couple white cotton shirts with complementary simple cuts", 18, 2],
    ["trench", "经典风衣", "Coordinated couple classic trench coats with realistic lapels and belts", 18, 2],
    ["silver", "银发对服", "Elegant coordinated senior couple clothing, comfortable soft knit and tailored layers; do not change hair", 50, 2],
  ]),
  ...series("daily", "简约 · 质感日常", [
    ["white", "白衬衫", "Modern clean white cotton shirt, minimal collar and crisp natural folds"],
    ["cream", "奶油针织", "Cream-colored fine knit sweater with visible soft yarn and modest neckline"],
    ["linen", "亚麻衬衣", "Neutral linen shirt with realistic fine slub weave and softly relaxed fit"],
    ["suit", "简约西装", "Minimal tailored suit with plain covered inner layer, age-appropriate formal sizing"],
  ]),
  ...series("wedding", "婚礼 · 周年纪念", [
    ["simple", "简约婚纱西装", "Minimal wedding gown or formal wedding suit matching source gender presentation; elegant opaque fabric", 18],
    ["vintage", "复古婚礼", "Vintage wedding gown or classic wedding suit matching source gender presentation, restrained lace or wool detail", 18],
    ["chinese", "中式礼服", "Formal Chinese wedding attire, modest embroidered red silk jacket or dress with subtle gold details", 18],
    ["anniversary", "银婚金婚", "Silver or golden anniversary formal clothing, refined champagne fabric and restrained embroidery; do not alter age", 50],
  ]),
  ...series("milestone", "人生 · 重要时刻", [
    ["graduation", "毕业纪念", "Modest graduation gown over a plain shirt, no cap, diploma or added props", 16],
    ["career", "初入职场", "Approachable professional office shirt and jacket, natural tailored fit", 18],
    ["birthday", "生日礼服", "Age-appropriate birthday occasion clothing, tasteful covered celebration dress or formal set"],
    ["retirement", "退休纪念", "Comfortable refined retirement occasion jacket and shirt, understated warm colors", 50],
  ]),
  ...series("winter", "冬日衣橱", [
    ["wool", "毛呢", "Warm wool coat with believable soft nap, thickness and structured seams"],
    ["scarf", "围巾", "Comfortable winter jacket and softly draped scarf, preserve face and hair visibility"],
    ["knit", "针织", "Warm cable-knit sweater with realistic knitted loops and natural fit"],
    ["puffer", "羽绒", "Modest winter puffer jacket, believable quilted chambers and matte outer fabric"],
  ]),
  ...series("newyear", "新年团圆", [
    ["chinese", "喜庆中式", "Festive Chinese red mandarin-collar clothing with restrained embroidery and knotted buttons"],
    ["red", "红色针织", "Warm festive red knit sweater, natural yarn and modest neckline"],
    ["pair", "情侣对服", "Coordinated adult couple festive red outfits with complementary cuts and restrained details", 18, 2],
  ]),
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const invalid = (message: string): never => { throw new DomainError("VALIDATION_FAILED", message); };
function object(value: JsonValue | undefined, keys: string[], label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) return invalid(`invalid closed ${label}`);
  return value;
}
function identifier(value: JsonValue | undefined): string { return typeof value === "string" && ID.test(value) ? value : invalid("wardrobe identifier invalid"); }
export function parseWardrobeEdit(value: JsonValue | undefined): JsonObject {
  const edit = object(value, ["schemaVersion", "sourceRootCommandId", "sourceCommandId", "targetAge", "sourceImage", "selections"], "wardrobe edit");
  if (edit.schemaVersion !== "ltm.wardrobe-edit.v1" || typeof edit.targetAge !== "number" || !Number.isInteger(edit.targetAge) || edit.targetAge < 0 || edit.targetAge > 100 ||
      !Array.isArray(edit.selections) || edit.selections.length < 1 || edit.selections.length > 2) return invalid("wardrobe version, age or selection count invalid");
  const selections = edit.selections.map(entry => {
    const selection = object(entry, ["participantId", "styleId"], "wardrobe selection");
    const style = WARDROBE_STYLES.find(style => style.id === selection.styleId);
    if (!style) return invalid("unknown wardrobe style");
    if ((edit.targetAge as number) < (style.minAge ?? 0) || (edit.targetAge as number) > (style.maxAge ?? 100) || (edit.selections as JsonValue[]).length < (style.minPeople ?? 1)) return invalid("wardrobe style incompatible with target age or participant count");
    return { participantId: identifier(selection.participantId), styleId: selection.styleId! };
  });
  if (new Set(selections.map(s => s.participantId)).size !== selections.length) return invalid("duplicate wardrobe participant");
  return { schemaVersion: edit.schemaVersion, sourceRootCommandId: identifier(edit.sourceRootCommandId), sourceCommandId: identifier(edit.sourceCommandId),
    targetAge: edit.targetAge, sourceImage: parseTimelineImageAsset(edit.sourceImage) as unknown as JsonObject, selections };
}
export function wardrobeBinding(editValue: JsonValue | undefined): JsonObject {
  const edit = parseWardrobeEdit(editValue), image = edit.sourceImage as JsonObject;
  return { schemaVersion: "ltm.wardrobe-binding.v1", sourceRootCommandId: edit.sourceRootCommandId!, sourceCommandId: edit.sourceCommandId!,
    sourceImageId: image.id!, sourceImageSha256: image.sha256!, targetAge: edit.targetAge!,
    selectionsSha256: createHash("sha256").update(JSON.stringify(edit.selections)).digest("hex") };
}
export function parseWardrobeBinding(value: JsonValue | undefined): JsonObject {
  const binding = object(value, ["schemaVersion", "sourceRootCommandId", "sourceCommandId", "sourceImageId", "sourceImageSha256", "targetAge", "selectionsSha256"], "wardrobe binding");
  if (binding.schemaVersion !== "ltm.wardrobe-binding.v1" || !/^[a-f0-9]{64}$/.test(String(binding.sourceImageSha256)) || !/^[a-f0-9]{64}$/.test(String(binding.selectionsSha256)) ||
      typeof binding.targetAge !== "number" || !Number.isInteger(binding.targetAge) || binding.targetAge < 0 || binding.targetAge > 100) return invalid("wardrobe binding version, hash or age invalid");
  return { schemaVersion: binding.schemaVersion, sourceRootCommandId: identifier(binding.sourceRootCommandId), sourceCommandId: identifier(binding.sourceCommandId),
    sourceImageId: identifier(binding.sourceImageId), sourceImageSha256: binding.sourceImageSha256!, targetAge: binding.targetAge, selectionsSha256: binding.selectionsSha256! };
}
export function buildWardrobePlan(input: { sourceAssetId: string; participantIds: string[]; targetAges: number[]; seed: string; promptPolicyVersion: string; wardrobeEdit: JsonObject }): JsonObject {
  const edit = parseWardrobeEdit(input.wardrobeEdit), age = edit.targetAge as number;
  const selections = edit.selections as JsonObject[];
  if (input.targetAges.length !== 1 || input.targetAges[0] !== age || input.participantIds.length !== selections.length || input.participantIds.some((id,i) => id !== selections[i]!.participantId)) return invalid("wardrobe must retain exact source age and ordered participants");
  const plan = buildAgeGenerationPlan({ ...input, currentAge: age, timelineProfile: input.participantIds.length === 2 ? "single-age-couple-v1" : "single-age-v1", ...(input.participantIds.length === 2 ? { participantAges: [age,age] } : {}) });
  const binding = wardrobeBinding(edit);
  const node = (plan.nodes as JsonObject[])[0]!;
  return { ...plan, profile: "wardrobe-edit-v1", operation: "wardrobe-edit", editSource: edit.sourceImage!, wardrobeBinding: binding,
    wardrobePolicy: { version: "wardrobe-only.v1", editableRegion: "clothing_only", instruction: "Change only the selected clothing. Preserve every person's identity, exact displayed age, face, hair, body shape, pose, background, lighting and person-to-position mapping. No nudity, sexualization, body reshaping or adult styling of children. Use infant/child sizing and coverage for young ages.",
      selections: selections.map(s => ({ ...s, instruction: WARDROBE_STYLES.find(style => style.id === s.styleId)!.instruction })) },
    nodes: [{ ...node, ageInstruction: `Keep the existing age ${age}; do not perform an age transformation.`,
      seed: createHash("sha256").update(JSON.stringify([node.seed, binding])).digest("hex"),
      requiredQualityDimensions: [...node.requiredQualityDimensions as JsonValue[], "garmentMatch", "regionPreservation"] }] };
}
/** Uses stored signed delivery and current consent, never caller assertions about a preview. */
export async function requireWardrobeSource(runtime: LifeTimeMachineRuntimePort, actor: ActorContext, data: JsonObject): Promise<void> {
  const edit = parseWardrobeEdit(data.wardrobeEdit), participants = data.participantIds;
  if (actor.purpose !== "age_transformation" || !Array.isArray(participants) || participants.some(id => typeof id !== "string")) return invalid("wardrobe actor purpose or participants invalid");
  const root = await runtime.getRecord(actor, "generation.timeline-commands", edit.sourceRootCommandId as string);
  const parent = root.id === edit.sourceCommandId ? root : await runtime.getRecord(actor, "generation.timeline-commands", edit.sourceCommandId as string);
  for (const record of [root,parent]) {
    if (record.ownerActorId !== actor.actorId || record.data.batchId !== "B14" || record.data.operation !== "createTimeline" || record.data.wardrobeEdit !== undefined ||
        record.data.sourceAssetId !== data.sourceAssetId || record.data._externalDecisionState === "frozen" || record.data._externalReconciliationState === "reconciliation_required") return invalid("wardrobe source is not an owned unfrozen age photo");
  }
  if (root.data.retryOfCommandId !== undefined || (parent.id !== root.id && parent.data.retryOfCommandId !== root.id) || parent.data.commandState !== "succeeded" ||
      typeof parent.data.lastEvidenceId !== "string" || parent.data.lastProvider !== "generation-engine" || !Array.isArray(root.data.participantIds) ||
      JSON.stringify(root.data.participantIds) !== JSON.stringify(participants) || JSON.stringify((edit.selections as JsonObject[]).map(s => s.participantId)) !== JSON.stringify(participants)) return invalid("wardrobe source delivery, participant order or lineage invalid");
  const parentPlan = parent.data.generationPlan as JsonObject;
  const manifest = bindTimelineResultManifest(parent.data.resultManifest, { sourceAssetId: data.sourceAssetId, targetAges: parent.data.targetAges, planVersion: parentPlan?.schemaVersion });
  const node = manifest.nodes.find(n => n.targetAge === edit.targetAge);
  if (node?.status !== "ready" || JSON.stringify(node.asset) !== JSON.stringify(edit.sourceImage) || !Array.isArray(data.targetAges) || data.targetAges.length !== 1 || data.targetAges[0] !== node.targetAge) return invalid("wardrobe requires the exact accepted source image and age");
  await runtime.assertConsent(actor, { participantIds: participants as string[], purpose: "age_transformation", scope: { resource: `media.asset:${data.sourceAssetId}`, action: "transform" } });
  await runtime.assertConsent(actor, { participantIds: participants as string[], purpose: "age_transformation", scope: { resource: `media.asset:${data.sourceAssetId}`, action: "wardrobe" } });
}
