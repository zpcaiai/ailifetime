import { createHash } from "node:crypto";
import { requireWardrobeSource } from "@ltm/capabilities";
import { bindTimelineResultManifest, DomainError, type ActorContext, type JsonObject, type LifeTimeMachineRuntimePort, type RecordEnvelope, type TimelineImageAsset, type TimelineResultNode } from "@ltm/core";

const COLLECTION = "generation.timeline-commands";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "compensated"]);
const identifier = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new DomainError("VALIDATION_FAILED", "timeline command ID is invalid"); return value; };
export function timelineRetryId(root: string, age: number, attempt: number): string {
  return `retry-${createHash("sha256").update(JSON.stringify([root, age, attempt])).digest("hex")}`;
}
export interface TimelineDeliveryNode {
  nodeId: string; targetAge: number; status: "pending" | "ready" | "failed" | "review" | "retrying" | "reconciliation_required";
  attempts: number; canRetry: boolean; errorCode: string | null; commandId: string; asset?: TimelineImageAsset;
}
export class TimelineDeliveryService {
  constructor(private readonly runtime: LifeTimeMachineRuntimePort) {}
  private async root(actor: ActorContext, commandId: string): Promise<RecordEnvelope> {
    if (actor.purpose !== "age_transformation") throw new DomainError("PURPOSE_REQUIRED", "timeline requires age_transformation purpose");
    const record = await this.runtime.getRecord(actor, COLLECTION, identifier(commandId));
    if (record.data.batchId !== "B14" || record.data.operation !== "createTimeline" || record.data.retryOfCommandId !== undefined || !Array.isArray(record.data.targetAges)) throw new DomainError("VALIDATION_FAILED", "command is not an original age timeline");
    if (record.data.wardrobeEdit !== undefined) await requireWardrobeSource(this.runtime, actor, record.data);
    return record;
  }
  private async child(actor: ActorContext, root: RecordEnvelope, age: number, attempt: number): Promise<RecordEnvelope | undefined> {
    try {
      const result = await this.runtime.getRecord(actor, COLLECTION, timelineRetryId(root.id, age, attempt));
      if (result.data.retryOfCommandId !== root.id || result.data.retryTargetAge !== age || result.data.retryAttempt !== attempt || result.data.sourceAssetId !== root.data.sourceAssetId) throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "retry binding changed");
      return result;
    } catch (error) { if (error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND") return undefined; throw error; }
  }
  private node(record: RecordEnvelope, age: number): TimelineResultNode | undefined {
    if (record.data.resultManifest === undefined || typeof record.data.lastEvidenceId !== "string" || record.data.lastProvider !== "generation-engine") return undefined;
    const plan = record.data.generationPlan as JsonObject | undefined;
    return bindTimelineResultManifest(record.data.resultManifest, { sourceAssetId: record.data.sourceAssetId, targetAges: record.data.targetAges, planVersion: plan?.schemaVersion }).nodes.find(node => node.targetAge === age);
  }
  async get(actor: ActorContext, commandId: string) {
    const root = await this.root(actor, commandId);
    const nodes: TimelineDeliveryNode[] = [];
    for (const age of [...root.data.targetAges as number[]].sort((a,b) => a-b)) {
      let latest = root, attempts = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const child = await this.child(actor, root, age, attempt);
        if (child === undefined) break;
        latest = child; attempts = attempt;
      }
      const result = this.node(latest, age);
      const frozen = [root, latest].some(record => record.data._externalDecisionState === "frozen" || record.data._externalReconciliationState === "reconciliation_required");
      const terminal = TERMINAL.has(String(latest.data.commandState));
      const uncertain = latest.data.commandState === "succeeded" && result === undefined;
      const status: TimelineDeliveryNode["status"] = frozen || uncertain ? "reconciliation_required" :
        !terminal ? attempts > 0 ? "retrying" : "pending" : result?.status ?? (latest.data.commandState === "compensated" ? "review" : "failed");
      const errorCode = frozen || uncertain ? "RESULT_RECONCILIATION_REQUIRED" : result?.errorCode ?? (status === "failed" ? "PROVIDER_TRANSIENT" : null);
      nodes.push({ nodeId: `age-${age}`, targetAge: age, status, attempts,
        canRetry: status === "failed" && attempts < 3 && errorCode !== "POLICY_BLOCKED",
        errorCode, commandId: latest.id, ...(status === "ready" && result?.asset ? { asset: result.asset } : {}) });
    }
    const ready = nodes.filter(node => node.status === "ready").length;
    const edit = root.data.wardrobeEdit as JsonObject | undefined;
    return { commandId: root.id, sourceAssetId: root.data.sourceAssetId, commandState: root.data.commandState,
      creationKind: edit === undefined ? "age" : "wardrobe", wardrobeSource: edit === undefined ? null : { sourceRootCommandId: edit.sourceRootCommandId, targetAge: edit.targetAge, selections: edit.selections },
      reconciliationState: root.data._externalReconciliationState ?? "clear", state: ready === nodes.length ? "ready" : ready > 0 ? "partial" : nodes.some(node => node.status === "pending" || node.status === "retrying") ? "pending" : "blocked",
      expectedCount: nodes.length, readyCount: ready, missingAges: nodes.filter(node => node.status !== "ready").map(node => node.targetAge),
      aiLabel: "AI 年龄创作 · 非真实容貌预测", nodes };
  }
  async retry(actor: ActorContext, commandId: string, age: number, attempt: number) {
    if (!Number.isInteger(age) || age < 0 || age > 100 || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new DomainError("VALIDATION_FAILED", "retry age/attempt is invalid");
    const root = await this.root(actor, commandId);
    const view = await this.get(actor, commandId), node = view.nodes.find(node => node.targetAge === age);
    if (!node) throw new DomainError("VALIDATION_FAILED", "retry age is not in the original plan");
    const existing = await this.child(actor, root, age, attempt);
    if (existing) return { commandId: existing.id, attempt, reused: true };
    if (!node.canRetry || attempt !== node.attempts + 1) throw new DomainError("VERSION_CONFLICT", "retry is active, uncertain, disallowed or exhausted; refresh its original status");
    const id = timelineRetryId(root.id, age, attempt), originalPlan = root.data.generationPlan as JsonObject;
    const seed = createHash("sha256").update(JSON.stringify([root.data.seed, age, attempt])).digest("hex");
    const data: JsonObject = { batchId: "B14", skill: "building-age-media-pipeline", operation: "createTimeline", operationMode: "external-command",
      jobId: id, sourceAssetId: root.data.sourceAssetId!, participantIds: Array.isArray(originalPlan.participantIds) ? [...originalPlan.participantIds] : [...root.participantIds], targetAges: [age],
      seed, promptPolicyVersion: root.data.promptPolicyVersion!, illustrativeLabel: true,
      ...(root.data.wardrobeEdit === undefined ? {} : { wardrobeEdit: root.data.wardrobeEdit }),
      generationPlan: { ...originalPlan, profile: "single-node-recovery-v1", expectedImageCount: 1,
        nodes: (originalPlan.nodes as JsonObject[]).filter(node => node.targetAge === age).map(node => ({ ...node, seed })) },
      retryOfCommandId: root.id, retryTargetAge: age, retryAttempt: attempt };
    const created = await this.runtime.createExternalCommand(actor, { record: { collection: COLLECTION, id,
      data, processingPurpose: "age_transformation", ownerActorId: root.ownerActorId, participantIds: [...root.participantIds], containsMinor: root.containsMinor },
      commandId: id, batchId: "B14", operation: "createTimeline", details: { retryOfCommandId: root.id, targetAge: age, attempt }, idempotencyKey: `timeline-retry:${id}` });
    return { commandId: created.value.command.commandId, attempt, reused: created.replayed };
  }
}
