import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { DomainError } from "./errors.js";
import type { JsonObject } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_SCOPE = /^ltm-evidence:v1:[a-f0-9]{64}$/;

export const DECISION_REQUEST_VERSION = "ltm.decision-request.v1" as const;

/**
 * Canonical request artifact presented to an independent decision authority.
 * The tenant is deliberately absent: tenant binding remains in the evidence
 * binding itself, while these bytes are portable across the callback boundary.
 */
export function decisionRequestSha256(
  batchId: string,
  operation: string,
  request: JsonObject,
): string {
  if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId) ||
      !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(operation)) {
    throw new DomainError("CONFIGURATION_INVALID", "Decision request route binding is invalid");
  }
  return createHash("sha256").update(canonicalJson({
    version: DECISION_REQUEST_VERSION,
    batchId,
    operation,
    request,
  })).digest("hex");
}

/** Preserve the opaque ltm-evidence:v1 digest shape while binding one request. */
export function requestBoundEvidenceScope(baseScope: string, requestSha256: string): string {
  if (!EVIDENCE_SCOPE.test(baseScope) || !SHA256.test(requestSha256)) {
    throw new DomainError("VALIDATION_FAILED", "Request-bound evidence scope is invalid");
  }
  const canonical = [
    "ltm-request-bound-evidence-v1",
    baseScope,
    requestSha256,
  ].map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `ltm-evidence:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertDecisionRequestSha256(value: string): string {
  if (!SHA256.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "decisionRequestSha256 must be a lowercase SHA-256 digest");
  }
  return value;
}
