import { DomainError } from "@ltm/core";
import type { PostgresGeneratedMedia } from "./generated-media.js";

export interface MediaCleanupLimits { maximumObjects?: number; timeBudgetMs?: number }
/** One fenced object at a time keeps each final in-flight operation bounded.
 * The150s budget leaves room for S3 deadlines and SQL before the300s function cap.
 */
export async function drainExpiredMedia(media: Pick<PostgresGeneratedMedia,"cleanup">, limits: MediaCleanupLimits = {}) {
  const maximumObjects = limits.maximumObjects ?? 1000, timeBudgetMs = limits.timeBudgetMs ?? 150_000;
  if (!Number.isInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 1000 ||
      !Number.isInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 150_000) {
    throw new DomainError("VALIDATION_FAILED","invalid media cleanup limits");
  }
  const started = performance.now();
  let claimed = 0, deleted = 0, retrying = 0;
  while (claimed < maximumObjects && performance.now()-started < timeBudgetMs) {
    const batch = await media.cleanup(1);
    claimed += batch.claimed; deleted += batch.deleted; retrying += batch.retrying;
    if (batch.claimed === 0) return { claimed, deleted, retrying, stopped: "empty" as const };
  }
  return { claimed, deleted, retrying, stopped: claimed >= maximumObjects ? "object_limit" as const : "time_budget" as const };
}
