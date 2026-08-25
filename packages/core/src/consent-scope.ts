import { canonicalJson, sha256 } from "./canonical.js";
import { DomainError } from "./errors.js";
import type {
  ConsentRequirementScope,
  ConsentScope,
  JsonObject,
  ParticipantAuthorityCapacity,
  ParticipantMinorStatus,
} from "./types.js";

const RESOURCE = /^[a-z][a-z0-9_.-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ACTION = /^[a-z][a-z0-9_.:-]{0,79}$/;

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new DomainError("VALIDATION_FAILED", `${label} must use the closed resource/action schema`);
  }
}

function resource(value: unknown, label: string): string {
  if (typeof value !== "string" || !RESOURCE.test(value) || value.includes("*")) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an exact canonical resource`);
  }
  return value;
}

function action(value: unknown, label: string): string {
  if (typeof value !== "string" || !ACTION.test(value) || value.includes("*")) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an exact canonical action`);
  }
  return value;
}

/** Normalize a stored grant/authority scope. Unknown fields and wildcard expansion fail closed. */
export function normalizeConsentScope(value: JsonObject, label = "consent scope"): ConsentScope {
  exactKeys(value, ["resource", "actions"], label);
  const normalizedResource = resource(value.resource, `${label}.resource`);
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 32) {
    throw new DomainError("VALIDATION_FAILED", `${label}.actions must contain between 1 and 32 exact actions`);
  }
  const actions = value.actions.map((entry, index) => action(entry, `${label}.actions[${index}]`));
  if (new Set(actions).size !== actions.length) {
    throw new DomainError("VALIDATION_FAILED", `${label}.actions must not contain duplicates`);
  }
  return { resource: normalizedResource, actions: [...actions].sort() };
}

/** Normalize the exact scope checked at the point of use. */
export function normalizeConsentRequirementScope(
  value: ConsentRequirementScope,
  label = "consent requirement scope",
): ConsentRequirementScope {
  const object = value as unknown as JsonObject;
  exactKeys(object, ["resource", "action"], label);
  return {
    resource: resource(value.resource, `${label}.resource`),
    action: action(value.action, `${label}.action`),
  };
}

export function consentScopeAllows(scope: ConsentScope, requirement: ConsentRequirementScope): boolean {
  const normalized = normalizeConsentScope(scope as unknown as JsonObject, "stored consent scope");
  const requested = normalizeConsentRequirementScope(requirement);
  return normalized.resource === requested.resource && normalized.actions.includes(requested.action);
}

export function authorityScopeCoversConsent(authority: ConsentScope, consent: ConsentScope): boolean {
  const normalizedAuthority = normalizeConsentScope(authority as unknown as JsonObject, "stored authority scope");
  const normalizedConsent = normalizeConsentScope(consent as unknown as JsonObject, "stored consent scope");
  return normalizedAuthority.resource === normalizedConsent.resource &&
    normalizedConsent.actions.every((entry) => normalizedAuthority.actions.includes(entry));
}

export type RecordConsentAccess = "create" | "read" | "update" | "delete";

function boundResource(prefix: string, value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", `${label} is required to derive the consent scope`);
  }
  return resource(`${prefix}:${value}`, label);
}

/**
 * Canonical record-to-consent binding. Known cross-record media/share flows bind
 * to their actual source/work subject; every other collection binds to its exact
 * record identity and access action.
 */
export function deriveRecordConsentRequirementScope(
  collection: string,
  id: string,
  data: JsonObject,
  access: RecordConsentAccess,
): ConsentRequirementScope {
  if (collection === "media.intake-results") {
    return {
      resource: boundResource("media.asset", data.assetId ?? id, "media asset consent resource"),
      action: access === "create" ? "ingest" : access === "delete" ? "delete" : "transform",
    };
  }
  if (collection === "consumer.composition-drafts" || collection === "generation.timeline-commands") {
    return {
      resource: boundResource("media.asset", data.sourceAssetId, "source media consent resource"),
      action: access === "delete" ? "delete" : "transform",
    };
  }
  if (collection === "sharing.export-commands") {
    return {
      resource: boundResource("work", data.workId, "shared work consent resource"),
      action: "share",
    };
  }
  return normalizeConsentRequirementScope({
    resource: boundResource(collection, id, "record consent resource"),
    action: access === "delete" ? "delete" : "process",
  });
}

export type ParticipantEvidenceMutation =
  | {
      readonly operation: "participant.register";
      readonly tenantId: string;
      readonly participantId: string;
      readonly ownerActorId: string;
      readonly minorStatus: ParticipantMinorStatus;
      readonly expiresAt: string;
      readonly expectedVersion: number | null;
    }
  | {
      readonly operation: "participant.revoke";
      readonly tenantId: string;
      readonly participantId: string;
      readonly expectedVersion: number;
      readonly reason: string;
    }
  | {
      readonly operation: "participant-authority.grant";
      readonly tenantId: string;
      readonly authorizationId: string;
      readonly authorizedActorId: string;
      readonly participantId: string;
      readonly capacity: ParticipantAuthorityCapacity;
      readonly scope: ConsentScope;
      readonly expiresAt: string;
    }
  | {
      readonly operation: "participant-authority.revoke";
      readonly tenantId: string;
      readonly authorizationId: string;
      readonly capacity: ParticipantAuthorityCapacity;
      readonly expectedVersion: number;
      readonly reason: string;
    };

/** Exact digest-bound scope signed by the configured identity/authority evidence issuer. */
export function participantEvidenceScope(mutation: ParticipantEvidenceMutation): string {
  return `identity.${mutation.operation}:v1:${sha256(canonicalJson(mutation))}`;
}
