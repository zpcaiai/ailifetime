import { createHash } from "node:crypto";
import { DomainError } from "@ltm/core";
import type { JsonObject } from "./registry.js";

export const LIFESPAN_AGES = Object.freeze(Array.from({ length: 21 }, (_, index) => index * 5));
export const AGE_PLAN_VERSION = "age-portrait-plan.v1";

/** A replayable request policy, not evidence that a provider produced or passed an image. */
export function buildAgeGenerationPlan(input: {
  sourceAssetId: string;
  participantIds: readonly string[];
  targetAges: readonly number[];
  seed: string;
  promptPolicyVersion: string;
  currentAge?: number;
  timelineProfile?: string;
  templateId?: string;
  participantAges?: readonly number[];
}): JsonObject {
  const profile = input.timelineProfile;
  const couple = profile === "lifespan-21-couple-v1" || profile === "single-age-couple-v1";
  const singleAge = profile === "single-age-v1" || profile === "single-age-couple-v1";
  if (profile !== undefined && !["lifespan-21-v1", "lifespan-21-couple-v1", "single-age-v1", "single-age-couple-v1"].includes(profile)) {
    throw new DomainError("VALIDATION_FAILED", "unknown timeline profile");
  }
  if (input.targetAges.length < 1 || input.targetAges.length > 101 || new Set(input.targetAges).size !== input.targetAges.length ||
      input.targetAges.some(age => !Number.isInteger(age) || age < 0 || age > 100)) throw new DomainError("VALIDATION_FAILED", "timeline profile target ages must be unique integer ages from zero through 100");
  if (input.currentAge !== undefined && (!Number.isInteger(input.currentAge) || input.currentAge < 0 || input.currentAge > 100)) {
    throw new DomainError("VALIDATION_FAILED", "currentAge must be an integer from zero through 100");
  }
  if (singleAge && (input.targetAges.length !== 1 || input.currentAge === undefined || input.participantIds.length !== (couple ? 2 : 1))) {
    throw new DomainError("VALIDATION_FAILED", "single-age profile requires one age node and the exact participant count with currentAge");
  }
  if (couple && (input.participantIds.length !== 2 || new Set(input.participantIds).size !== 2 ||
      !Array.isArray(input.participantAges) || input.participantAges.length !== 2 ||
      input.participantAges.some(age => !Number.isInteger(age) || age < 0 || age > 100) || input.participantAges[0] !== input.currentAge ||
      (!singleAge && (input.targetAges.length !== 21 || input.targetAges.some((age, i) => age !== LIFESPAN_AGES[i]))))) {
    throw new DomainError("VALIDATION_FAILED", "couple profile requires two distinct participants and their ordered source ages; lifespan ages must be the exact 21 nodes");
  }
  if (!couple && input.participantAges !== undefined) throw new DomainError("VALIDATION_FAILED", "participantAges requires an explicit couple profile");
  if (input.timelineProfile === "lifespan-21-v1" &&
      (input.participantIds.length !== 1 || input.currentAge === undefined ||
       input.targetAges.length !== LIFESPAN_AGES.length ||
       input.targetAges.some((age, index) => age !== LIFESPAN_AGES[index]))) {
    throw new DomainError("VALIDATION_FAILED", "lifespan-21-v1 requires one participant, currentAge and ordered ages 0..100 every five years");
  }
  return {
    schemaVersion: AGE_PLAN_VERSION,
    profile: input.timelineProfile ?? "custom",
    sourceAssetId: input.sourceAssetId,
    participantIds: [...input.participantIds],
    ...(couple ? { subjectMode: "couple", participantAges: [...input.participantAges!],
      participantReferences: input.participantIds.map((participantId, index) => ({ participantId, position: index === 0 ? "left" : "right", sourceAge: input.participantAges![index]!, mappingState: "must_match_verified_source_mapping" })) } : {}),
    currentAge: input.currentAge ?? null,
    sourceAgeState: input.currentAge === undefined ? "not_provided" : "user_declared_not_age_verification",
    expectedImageCount: input.targetAges.length,
    promptPolicyVersion: input.promptPolicyVersion,
    templateId: input.templateId ?? "timeline-classic-v1",
    identityPolicy: {
      version: "original-reference.v1",
      anchor: "original_source_for_every_node",
      instruction: couple ? "Preserve BOTH original people separately, with the verified participant-to-face mapping and stable left/right positions. Never merge, swap, replace or beautify away either identity. Apply the target age separately to both people, anchored to the original source at every node." : "Preserve the reference person's distinctive facial traits and visible skin tone. Adapt facial proportions plausibly to the target age. Do not substitute a generic face or beautify away identifying traits.",
    },
    compositionPolicy: {
      version: "comparable-portrait.v1",
      framing: couple ? "two front-facing people side by side in one comparable portrait, keeping both original faces visible and their positions stable" : "single front-facing head-and-shoulders portrait",
      pose: "neutral expression, eye-level camera",
      background: "consistent plain neutral background",
      lighting: "consistent soft photographic light",
      wardrobe: "plain age-appropriate clothing",
      ...(couple ? { interaction: "neutral age-appropriate portrait only; no romantic or sexualized posing, especially for infant, child or adolescent targets" } : {}),
    },
    negativePolicy: {
      version: "photographic-defects.v1",
      instruction: "Avoid plastic skin, beauty filters, cartoon style, exaggerated wrinkles, distorted eyes or teeth, extra features, and changes to the subject's identity. Retain natural age-appropriate skin texture.",
    },
    illustrativeLabel: true,
    nodes: input.targetAges.map((targetAge) => ({
      nodeId: `age-${targetAge}`,
      targetAge,
      sourceAssetId: input.sourceAssetId,
      seed: createHash("sha256").update(JSON.stringify([
        AGE_PLAN_VERSION, input.sourceAssetId, input.participantIds, input.seed, input.promptPolicyVersion,
        input.templateId ?? "timeline-classic-v1", targetAge,
        ...(couple ? [profile, input.participantAges] : []),
      ])).digest("hex"),
      ageInstruction: ageInstruction(targetAge),
      creativeBackcast: input.currentAge === undefined ? null : targetAge < input.currentAge,
      ...(couple ? { participantTargets: input.participantIds.map((participantId, index) => ({ participantId, position: index === 0 ? "left" : "right", targetAge, sourceAge: input.participantAges![index]!, creativeBackcast: targetAge < input.participantAges![index]! })) } : {}),
      requiredQualityDimensions: ["identity", "ageRange", "facialDrift", "pose", "artifacts", "clarity", "background", "handsTeethEyes", "photorealism"],
    })),
  };
}

function ageInstruction(age: number): string {
  if (age === 0) return "Newborn infant: infant craniofacial proportions, soft tissue and fine hair; a creative identity interpretation, not a reconstruction of the person's actual infancy.";
  if (age < 15) return `Age ${age}: age-appropriate childhood facial proportions and dentition; do not use a shrunken adult face.`;
  if (age < 25) return `Age ${age}: age-appropriate adolescent or young-adult facial development and natural skin texture.`;
  if (age < 50) return `Age ${age}: mature facial proportions with subtle plausible soft-tissue and skin changes; preserve individual traits.`;
  if (age < 75) return `Age ${age}: plausible skin texture, soft-tissue aging and hair changes; do not age the face only by adding wrinkles.`;
  return `Age ${age}: plausible advanced aging in facial volume, skin, eyelids and hair while preserving identity; avoid caricature. This is an artistic simulation, not a forecast.`;
}
