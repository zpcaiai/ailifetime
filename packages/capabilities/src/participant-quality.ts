import { DomainError } from "@ltm/core";
import type { JsonObject, JsonValue } from "./registry.js";

const DIMENSIONS = ["identity", "ageRange", "facialDrift"] as const;
/** Per-person scores are never inferred from an image-wide average. */
export function participantQuality(value: JsonValue | undefined, participantIds: readonly string[], required: boolean, wardrobe = false) {
  const dimensions: readonly string[] = wardrobe ? [...DIMENSIONS, "garmentMatch"] : DIMENSIONS;
  const invalid = (message: string): never => { throw new DomainError("VALIDATION_FAILED", message); };
  if (value === undefined && !required) return { assessments: undefined, failedDimensions: [] as string[] };
  if (!Array.isArray(value) || value.length !== participantIds.length) return invalid("participant quality must cover every person exactly once");
  const seen = new Set<string>(), failedDimensions: string[] = [];
  const assessments = value.map(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 3 || Object.keys(entry).some(k => !["participantId", "scores", "thresholds"].includes(k)) ||
        typeof entry.participantId !== "string" || !participantIds.includes(entry.participantId) || seen.has(entry.participantId)) return invalid("participant quality identity binding is invalid");
    seen.add(entry.participantId);
    const scores = entry.scores, thresholds = entry.thresholds;
    if (!scores || typeof scores !== "object" || Array.isArray(scores) || !thresholds || typeof thresholds !== "object" || Array.isArray(thresholds) ||
        Object.keys(scores).length !== dimensions.length || Object.keys(thresholds).length !== dimensions.length ||
        Object.keys(scores).some(k => !dimensions.includes(k)) || Object.keys(thresholds).some(k => !dimensions.includes(k))) return invalid("participant quality requires the closed identity, ageRange, facialDrift and applicable garment scores");
    for (const dimension of dimensions) {
      const score = scores[dimension], threshold = thresholds[dimension];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 ||
          typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return invalid("participant quality scores and positive thresholds are invalid");
      if (score < threshold) failedDimensions.push(`participant:${entry.participantId}:${dimension}`);
    }
    return { participantId: entry.participantId, scores: { ...scores }, thresholds: { ...thresholds } } as JsonObject;
  });
  return { assessments, failedDimensions };
}
