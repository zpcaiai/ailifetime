import { DomainError } from "./errors.js";

export interface TimelineImageAsset {
  readonly id: string; readonly sha256: string; readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number; readonly height: number; readonly byteLength: number;
}
export interface TimelineResultNode {
  readonly nodeId: string; readonly targetAge: number; readonly status: "ready" | "failed" | "review";
  readonly asset?: TimelineImageAsset; readonly qualityResultId?: string; readonly safetyResultId?: string;
  readonly qualityControlKey?: string;
  readonly errorCode?: "PROVIDER_TRANSIENT" | "QUALITY_REJECTED" | "POLICY_BLOCKED" | "CANCELLED";
}
export interface TimelineResultManifest {
  readonly schemaVersion: "ltm.timeline-results.v1"; readonly sourceAssetId: string;
  readonly planVersion: string; readonly aiLabel: true; readonly nodes: readonly TimelineResultNode[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function invalid(message: string): never { throw new DomainError("VALIDATION_FAILED", message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("timeline object required");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) return invalid("unknown timeline result field");
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) return invalid("timeline identifier is invalid");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid("timeline integer is invalid");
  return value;
}
export function parseTimelineImageAsset(value: unknown): TimelineImageAsset {
  const asset = object(value, ["id", "sha256", "mimeType", "width", "height", "byteLength"]);
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      (asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png")) return invalid("timeline asset digest or MIME is invalid");
  return { id: identifier(asset.id), sha256: asset.sha256, mimeType: asset.mimeType,
    width: integer(asset.width, 1, 8192), height: integer(asset.height, 1, 8192), byteLength: integer(asset.byteLength, 1, 25 * 1024 * 1024) };
}
/** Metadata only. A generator's ready claim is not a quality/safety publication grant. */
export function parseTimelineResultManifest(value: unknown): TimelineResultManifest {
  const manifest = object(value, ["schemaVersion", "sourceAssetId", "planVersion", "aiLabel", "nodes"]);
  if (manifest.schemaVersion !== "ltm.timeline-results.v1" || manifest.aiLabel !== true ||
      !Array.isArray(manifest.nodes) || manifest.nodes.length < 1 || manifest.nodes.length > 101) return invalid("timeline manifest version, label or node count is invalid");
  const nodes: TimelineResultNode[] = manifest.nodes.map((entry) => {
    const node = object(entry, ["nodeId", "targetAge", "status", "asset", "qualityResultId", "safetyResultId", "errorCode", "qualityControlKey"]);
    const targetAge = integer(node.targetAge, 0, 100);
    if (node.nodeId !== `age-${targetAge}`) return invalid("timeline node ID must match its age");
    if (node.status === "ready") {
      if (node.errorCode !== undefined) return invalid("ready timeline node cannot have an error");
      return { nodeId: node.nodeId, targetAge, status: "ready", asset: parseTimelineImageAsset(node.asset),
        qualityResultId: identifier(node.qualityResultId), safetyResultId: identifier(node.safetyResultId),...(node.qualityControlKey===undefined?{}:{qualityControlKey:identifier(node.qualityControlKey)}) };
    }
    if ((node.status !== "failed" && node.status !== "review") || node.asset !== undefined ||
        node.qualityResultId !== undefined || node.safetyResultId !== undefined || node.qualityControlKey !== undefined ||
        !["PROVIDER_TRANSIENT", "QUALITY_REJECTED", "POLICY_BLOCKED", "CANCELLED"].includes(String(node.errorCode))) return invalid("non-ready timeline node must contain a closed error and no image");
    return { nodeId: node.nodeId as string, targetAge, status: node.status,
      errorCode: node.errorCode as TimelineResultNode["errorCode"] } as TimelineResultNode;
  });
  for (const values of [nodes.map((node) => node.targetAge), nodes.filter((node) => node.asset).map((node) => node.asset!.id), nodes.filter((node) => node.asset).map((node) => node.asset!.sha256)]) {
    if (new Set<string | number>(values).size !== values.length) return invalid("timeline ages, asset IDs and image digests must be unique");
  }
  return { schemaVersion: "ltm.timeline-results.v1", sourceAssetId: identifier(manifest.sourceAssetId),
    planVersion: identifier(manifest.planVersion), aiLabel: true, nodes };
}
export function bindTimelineResultManifest(value: unknown, plan: { sourceAssetId: unknown; targetAges: unknown; planVersion: unknown }): TimelineResultManifest {
  const manifest = parseTimelineResultManifest(value);
  if (manifest.sourceAssetId !== plan.sourceAssetId || manifest.planVersion !== plan.planVersion ||
      !Array.isArray(plan.targetAges) || manifest.nodes.length !== plan.targetAges.length ||
      manifest.nodes.some((node) => !(plan.targetAges as unknown[]).includes(node.targetAge))) return invalid("timeline manifest does not match the original plan source, version and exact ages");
  return manifest;
}
