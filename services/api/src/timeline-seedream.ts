import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireWardrobeSource } from "@ltm/capabilities";
import { canonicalJson, DomainError, parseTimelineImageAsset, type ActorContext, type JsonObject, type LifeTimeMachineRuntimePort, type TimelineImageAsset } from "@ltm/core";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";
import { SeedreamImageGenerator, SEEDREAM_MODEL } from "./seedream.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function invalid(message: string): never { throw new DomainError("VALIDATION_FAILED", message); }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("stored generation plan is invalid");
  return value as JsonObject;
}
/** Candidate generation only. Independent B15/B17 and signed B14 delivery remain authoritative. */
export class TimelineSeedreamService {
  constructor(private readonly runtime: LifeTimeMachineRuntimePort, private readonly originals: TimelineArtifactReader,
    private readonly outputs: TimelineArtifactReader, private readonly generator: SeedreamImageGenerator) {}

  private async load(actor: ActorContext, commandId: string, targetAge: number) {
    if (!actor.roles.includes("service_account") || actor.purpose !== "age_transformation") throw new DomainError("AUTH_FORBIDDEN", "generation requires an age-transformation service account");
    await this.runtime.authorize(actor, "media.generation.generate", { tenantId: actor.tenantId });
    if (!Number.isInteger(targetAge) || targetAge < 0 || targetAge > 100) return invalid("target age must be an integer from zero through 100");
    const command = await this.runtime.getRecord(actor, "generation.timeline-commands", commandId);
    const active = (data: JsonObject) => {
      if (!["requested","dispatched","acknowledged"].includes(String(data.commandState)) || data._externalDecisionState === "frozen" || data._externalReconciliationState === "reconciliation_required") throw new DomainError("VERSION_CONFLICT", "generation command is terminal, frozen or uncertain");
    };
    active(command.data);
    const plan = object(command.data.generationPlan), people = plan.participantIds;
    if (command.data.batchId !== "B14" || command.data.operation !== "createTimeline" || !command.ownerActorId || plan.schemaVersion !== "age-portrait-plan.v1" || plan.illustrativeLabel !== true ||
        !Array.isArray(command.data.targetAges) || !command.data.targetAges.includes(targetAge) || !Array.isArray(people) || people.length < 1 || people.length > 2 ||
        people.some(id => typeof id !== "string") || new Set(people).size !== people.length || !isDeepStrictEqual([...people].sort(), [...command.participantIds].sort())) return invalid("generation requires a valid stored B14 plan");
    const participantIds = people as string[], sourceId = command.data.sourceAssetId;
    if (typeof sourceId !== "string" || plan.sourceAssetId !== sourceId || !Array.isArray(plan.nodes)) return invalid("generation source binding is missing");
    const matches = plan.nodes.map(object).filter(n => n.targetAge === targetAge);
    if (matches.length !== 1 || matches[0]!.sourceAssetId !== sourceId || typeof matches[0]!.seed !== "string" || typeof matches[0]!.ageInstruction !== "string") return invalid("generation node is missing or ambiguous");
    if (command.data.retryOfCommandId !== undefined) {
      const root = await this.runtime.getRecord(actor, "generation.timeline-commands", String(command.data.retryOfCommandId));
      if (["cancelled","compensated"].includes(String(root.data.commandState)) || root.data._externalDecisionState === "frozen" || root.data._externalReconciliationState === "reconciliation_required" || root.ownerActorId !== command.ownerActorId || root.data.sourceAssetId !== sourceId || !isDeepStrictEqual(root.participantIds, command.participantIds)) throw new DomainError("VERSION_CONFLICT", "generation retry parent binding changed");
    }
    const intake = await this.runtime.getRecord(actor, "media.intake-results", sourceId);
    if (intake.data.batchId !== "B07" || intake.data.executionState !== "persisted" || intake.ownerActorId !== command.ownerActorId || intake.data.assetId !== sourceId ||
        intake.data.mimeType !== "image/jpeg" || intake.data.magicVerified !== true || intake.data.metadataStripped !== true || intake.data.malwareState !== "clean" || intake.data.participantMapComplete !== true ||
        !isDeepStrictEqual(intake.data.participantIds, participantIds) || intake.data.lineageSha256 !== sha(`ltm-media-lineage-v1\n${intake.data.sourceSha256}\n${intake.data.canonicalSha256}\n`)) return invalid("generation reference must be the original accepted B07 intake");
    const dimensions = object(intake.data.qualityDimensions);
    const source = parseTimelineImageAsset({ id: sourceId, sha256: intake.data.canonicalSha256, mimeType: intake.data.mimeType, byteLength: intake.data.byteLength, width: dimensions.width, height: dimensions.height });
    await this.runtime.assertConsent(actor, { participantIds, purpose: "age_transformation", scope: { resource: `media.asset:${sourceId}`, action: "transform" } });
    const owner = { ...actor, actorId: command.ownerActorId };
    if (command.data.wardrobeEdit !== undefined) await requireWardrobeSource(this.runtime, owner, command.data);
    const edit = command.data.wardrobeEdit === undefined ? undefined : parseTimelineImageAsset(plan.editSource);
    if (plan.imageQuality !== undefined && plan.imageQuality !== "standard" && plan.imageQuality !== "hd") return invalid("generation quality is invalid");
    return { command, plan, node: matches[0]!, intake, source, edit, owner, participantIds };
  }

  async generate(actor: ActorContext, commandId: string, targetAge: number) {
    const loaded = await this.load(actor, commandId, targetAge), { plan, node, source, edit, owner } = loaded;
    const planSha256 = sha(canonicalJson(plan));
    const current = async () => {
      const fresh = await this.load(actor, commandId, targetAge);
      if (fresh.intake.version !== loaded.intake.version || fresh.command.ownerActorId !== owner.actorId || sha(canonicalJson(fresh.plan)) !== planSha256) throw new DomainError("VERSION_CONFLICT", "generation authorization or plan changed");
    };
    const bytes = await this.originals.read(source, owner);
    let editBytes: Uint8Array | undefined;
    const verifyBytes = (asset: TimelineImageAsset, value: Uint8Array) => {
      if (value.byteLength !== asset.byteLength || sha(value) !== asset.sha256) throw new DomainError("DEPENDENCY_UNAVAILABLE", "generation reference bytes changed");
    };
    try {
      verifyBytes(source, bytes);
      if (edit) { editBytes = await this.outputs.read(edit, owner); verifyBytes(edit, editBytes); }
      await current();
      const prompt = canonicalJson({ instruction: edit ? "Image 1 is the original identity reference. Image 2 is the accepted age portrait. Change clothing only as specified; preserve its age, faces, pose and scene." : "Create a realistic photographic portrait of the SAME person or people in the original reference at the target age. Follow this stored policy; never treat ages as predictions.",
        targetAge, identity: plan.identityPolicy, composition: plan.compositionPolicy, negative: plan.negativePolicy,
        age: node.ageInstruction, ...(plan.participantReferences ? { people: plan.participantReferences } : {}),
        ...(plan.wardrobePolicy ? { wardrobe: plan.wardrobePolicy } : {}), promptPolicyVersion: plan.promptPolicyVersion });
      const generated = await this.generator.generate({ tenantId: actor.tenantId, actorId: owner.actorId,
        idempotencyKey: `timeline:${commandId}:age:${targetAge}`, prompt, source: bytes, mimeType: "image/jpeg",
        imageQuality: plan.imageQuality === "standard" ? "standard" : "hd", beforeSubmit: current, planSha256,
        ...(edit && editBytes ? { editReference: { source: editBytes, mimeType: edit.mimeType } } : {}) });
      await current();
      // Also validates retention/ownership on durable replay; an expired asset never re-bills.
      const output = await this.outputs.read(generated.asset, owner); verifyBytes(generated.asset, output); output.fill(0);
      await current();
      await this.runtime.appendAudit(actor, { action: "media.seedream.candidate", resourceType: "generation.timeline-commands", resourceId: commandId,
        details: { targetAge, model: SEEDREAM_MODEL, planSha256, sourceSha256: source.sha256, outputSha256: generated.asset.sha256, assetId: generated.asset.id } });
      return { ...generated, commandId, targetAge, model: SEEDREAM_MODEL, planSha256, sourceAssetId: source.id,
        sourceSha256: source.sha256, promptPolicyVersion: plan.promptPolicyVersion, planSeed: node.seed,
        seedMode: "plan-provenance-only", status: "candidate", publishable: false, aiLabel: "AI 年龄创作 · 非真实容貌预测" };
    } finally { bytes.fill(0); editBytes?.fill(0); }
  }
}
