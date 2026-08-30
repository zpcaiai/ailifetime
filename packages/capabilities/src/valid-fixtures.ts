// Generated from every batch-specific validator and reviewed invariants.
// Keep this closed catalog explicit: one valid schema-path input for B00-B127.
import type { JsonObject, JsonValue } from "./registry.js";

export const CANONICAL_CAPABILITY_BATCH_IDS = [
  "B00",
  "B01",
  "B02",
  "B03",
  "B04",
  "B05",
  "B06",
  "B07",
  "B08",
  "B09",
  "B10",
  "B11",
  "B12",
  "B13",
  "B14",
  "B15",
  "B16",
  "B17",
  "B18",
  "B19",
  "B20",
  "B21",
  "B22",
  "B23",
  "B24",
  "B25",
  "B26",
  "B27",
  "B28",
  "B29",
  "B30",
  "B31",
  "B32",
  "B33",
  "B34",
  "B35",
  "B36",
  "B37",
  "B38",
  "B39",
  "B40",
  "B41",
  "B42",
  "B43",
  "B44",
  "B45",
  "B46",
  "B47",
  "B48",
  "B49",
  "B50",
  "B51",
  "B52",
  "B53",
  "B54",
  "B55",
  "B56",
  "B57",
  "B58",
  "B59",
  "B60",
  "B61",
  "B62",
  "B63",
  "B64",
  "B65",
  "B66",
  "B67",
  "B68",
  "B69",
  "B70",
  "B71",
  "B72",
  "B73",
  "B74",
  "B75",
  "B76",
  "B77",
  "B78",
  "B79",
  "B80",
  "B81",
  "B82",
  "B83",
  "B84",
  "B85",
  "B86",
  "B87",
  "B88",
  "B89",
  "B90",
  "B91",
  "B92",
  "B93",
  "B94",
  "B95",
  "B96",
  "B97",
  "B98",
  "B99",
  "B100",
  "B101",
  "B102",
  "B103",
  "B104",
  "B105",
  "B106",
  "B107",
  "B108",
  "B109",
  "B110",
  "B111",
  "B112",
  "B113",
  "B114",
  "B115",
  "B116",
  "B117",
  "B118",
  "B119",
  "B120",
  "B121",
  "B122",
  "B123",
  "B124",
  "B125",
  "B126",
  "B127"
] as const;

export type CanonicalCapabilityBatchId = typeof CANONICAL_CAPABILITY_BATCH_IDS[number];

const FIXTURE_TEMPLATES: Record<CanonicalCapabilityBatchId, JsonObject> = {
  "B00": {
    "baseCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "inventoryHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "commandResults": {
      "build": "passed"
    },
    "repositoryId": "repositoryId-fixture",
    "repositoryKind": "monorepo",
    "inventory": {
      "fixture": true
    },
    "riskIds": [
      "riskIds-1"
    ]
  },
  "B01": {
    "repositoryId": "repositoryId-fixture",
    "stackProfile": "stackProfile-fixture",
    "boundedContexts": [
      "identity",
      "media"
    ],
    "healthChecks": [
      "liveness",
      "readiness"
    ],
    "ownershipRules": [
      "CODEOWNERS"
    ]
  },
  "B02": {
    "contractVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "aggregateTypes": [
      "participant"
    ],
    "compatibility": "backward",
    "sensitiveFieldsClassified": true
  },
  "B03": {},
  "B04": {
    "participantId": "fixture-actor",
    "scope": {
      "resource": "media.asset:asset-1",
      "actions": [
        "ingest"
      ]
    },
    "purpose": "age_transformation",
    "policyVersion": "1.0.0",
    "evidenceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "active",
    "grantorCapacity": "self"
  },
  "B05": {
    "assetId": "assetId-fixture",
    "classification": "raw",
    "retentionDays": 1,
    "encrypted": true,
    "deletionTargets": [
      "primary"
    ]
  },
  "B06": {
    "sessionId": "sessionId-fixture",
    "campaign": "campaign-fixture",
    "disclosureAccepted": true,
    "retentionHours": 1,
    "accessibilityMode": "standard"
  },
  "B07": {
    "sourceSha256": "1111111111111111111111111111111111111111111111111111111111111111",
    "canonicalSha256": "2222222222222222222222222222222222222222222222222222222222222222",
    "lineageSha256": "a4667a5852dafe5c635359a38aad3f908e7aecfc591461722b16389964bb1670",
    "qualityDimensions": {
      "width": 640,
      "height": 480
    },
    "assetId": "assetId-fixture",
    "mimeType": "image/jpeg",
    "byteLength": 1,
    "faceCount": 1,
    "participantIds": [
      "fixture-actor"
    ],
    "magicVerified": true,
    "metadataStripped": true,
    "malwareState": "clean",
    "scanEvidenceId": "scanEvidenceId-fixture",
    "scannerProvider": "scannerProvider-fixture",
    "scanAssessedAt": "@dynamic:future-60d",
    "participantMappingEvidenceId": "participantMappingEvidenceId-fixture",
    "participantMappingProvider": "participantMappingProvider-fixture",
    "participantMappingAssessedAt": "@dynamic:future-60d",
    "participantMapComplete": true
  },
  "B08": {
    "draftId": "draftId-fixture",
    "sourceAssetId": "assetId-fixture",
    "templateId": "templateId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "targetAges": [
      20,
      40
    ],
    "composition": {
      "fixture": true
    },
    "illustrativeLabel": true
  },
  "B09": {
    "fromState": "queued",
    "toState": "preflight",
    "milestones": [],
    "jobId": "jobId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "requestFingerprint": "requestFingerprint-fixture"
  },
  "B10": {
    "expiresAt": "@dynamic:future-7d",
    "containsMinor": false,
    "workId": "workId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "format": "single_image",
    "visibility": "private",
    "aiLabel": true,
    "provenanceId": "provenanceId-fixture",
    "revocable": true
  },
  "B11": {
    "ownerActorId": "fixture-actor",
    "libraryId": "libraryId-fixture",
    "resourceId": "resourceId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "action": "archive",
    "role": "owner",
    "quotaState": "available"
  },
  "B12": {
    "providerId": "providerId-fixture",
    "modelVersion": "1.0.0",
    "region": "region-fixture",
    "purpose": "age_transformation",
    "health": "healthy",
    "retentionPolicy": "zero_retention",
    "allowedForMinors": true,
    "isMinor": true
  },
  "B13": {
    "workflowId": "workflowId-fixture",
    "workflowType": "workflowType-fixture",
    "state": "planned",
    "activities": [
      "execute"
    ],
    "compensationPlan": {
      "fixture": true
    },
    "retryLimit": 1
  },
  "B14": {
    "targetAges": [
      20,
      40
    ],
    "jobId": "jobId-fixture",
    "sourceAssetId": "assetId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "seed": "seed-fixture",
    "promptPolicyVersion": "1.0.0",
    "illustrativeLabel": true
  },
  "B15": {
    "scores": {
      "identity": 0.9,
      "ageRange": 0.9,
      "facialDrift": 0.9,
      "pose": 0.9,
      "artifacts": 0.9,
      "clarity": 0.9
    },
    "thresholds": {
      "identity": 0.8,
      "ageRange": 0.8,
      "facialDrift": 0.8,
      "pose": 0.8,
      "artifacts": 0.8,
      "clarity": 0.8
    },
    "workId": "workId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "modelVersion": "1.0.0",
    "decision": "pass"
  },
  "B16": {
    "voiceCloning": false,
    "renderId": "renderId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "frameAssetIds": [
      "frame-1",
      "frame-2"
    ],
    "transition": "safe_fade",
    "continuityState": "passed",
    "aiLabel": true,
    "licenseIds": [
      "license-1"
    ]
  },
  "B17": {
    "workId": "workId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "inputSafety": "allowed",
    "outputSafety": "allowed",
    "subjectClass": "private_person",
    "enhancedAuthorization": true,
    "provenanceId": "provenanceId-fixture",
    "manifestSignature": "manifestSignature-fixture",
    "aiLabel": true
  },
  "B18": {
    "cacheScopeParticipantId": "fixture-actor",
    "reservationId": "reservationId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "estimatedMinor": 1,
    "budgetRemainingMinor": 1,
    "retryBudget": 1,
    "routeState": "eligible"
  },
  "B19": {
    "participantIds": [
      "fixture-actor",
      "fixture-participant-2"
    ],
    "familyId": "familyId-fixture",
    "relationship": "parent",
    "action": "invite",
    "containsMinor": true
  },
  "B20": {
    "participantIds": [
      "fixture-actor",
      "fixture-participant-2"
    ],
    "sceneId": "sceneId-fixture",
    "templateId": "templateId-fixture",
    "qualityDecision": "passed",
    "illustrativeLabel": true
  },
  "B21": {
    "safeguardId": "safeguardId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "containsMinor": true,
    "requestedFeature": "private_generation",
    "ageBand": "child",
    "guardianControlsVersion": "1.0.0"
  },
  "B22": {
    "narrativeId": "narrativeId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "format": "story",
    "themes": [
      "themes-1"
    ],
    "illustrativeDisclosure": true,
    "userAuthoredGoals": true
  },
  "B23": {
    "conversationId": "conversationId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "safetyPolicyVersion": "1.0.0",
    "riskState": "clear",
    "anthropomorphicDisclosure": true,
    "memoryConsent": true,
    "persona": {
      "fixture": true
    }
  },
  "B24": {
    "ritualId": "ritualId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "scheduledAt": "@dynamic:future-60d",
    "scheduleSource": "user_selected",
    "archivePolicyVersion": "1.0.0",
    "longTermMemoryConsent": true,
    "reminderConsent": true
  },
  "B25": {
    "sku": "sku-fixture",
    "priceMinor": 1,
    "currency": "USD",
    "region": "region-fixture",
    "quoteVersion": "1.0.0",
    "effectiveAt": "@dynamic:future-60d",
    "taxMode": "inclusive"
  },
  "B26": {
    "paymentState": "authorized",
    "checkoutId": "checkoutId-fixture",
    "quoteId": "quoteId-fixture",
    "quoteState": "active",
    "paymentAuthorizationId": "paymentAuthorizationId-fixture",
    "quotedMinor": 1,
    "authorizedMinor": 1,
    "currency": "USD"
  },
  "B27": {
    "entitlementId": "entitlementId-fixture",
    "customerId": "customerId-fixture",
    "kind": "subscription",
    "units": 1,
    "paymentState": "captured",
    "giftBound": true
  },
  "B28": {
    "fromState": "created",
    "toState": "paid",
    "orderId": "orderId-fixture",
    "paymentState": "captured",
    "deliverableIds": [
      "deliverableIds-1"
    ]
  },
  "B29": {
    "addressToken": "addr_fixture",
    "orderId": "orderId-fixture",
    "purchaseOrderId": "purchaseOrderId-fixture",
    "printAssetId": "printAssetId-fixture",
    "specificationVersion": "1.0.0",
    "quantity": 1,
    "proofState": "approved",
    "paymentState": "captured"
  },
  "B30": {
    "caseId": "caseId-fixture",
    "orderId": "orderId-fixture",
    "action": "refund",
    "reason": "reason-fixture",
    "ticketId": "ticketId-fixture",
    "paidMinor": 1,
    "actionMinor": 1,
    "paymentState": "captured"
  },
  "B31": {
    "partnerTenantId": "fixture-tenant",
    "partnerId": "partnerId-fixture",
    "region": "region-fixture",
    "isolationMode": "row_and_application",
    "permittedPurposes": [
      "permittedPurposes-1"
    ],
    "status": "active"
  },
  "B32": {
    "environment": "sandbox",
    "partnerId": "partnerId-fixture",
    "legalEntityId": "legalEntityId-fixture",
    "contractVersion": "1.0.0",
    "approvals": [
      "approvals-1"
    ],
    "dataPurposes": [
      "dataPurposes-1"
    ],
    "brandPolicy": {
      "fixture": true
    },
    "aiLabelLocked": true
  },
  "B33": {
    "apiVersion": "v1",
    "partnerRequestId": "partnerRequestId-fixture",
    "clientId": "clientId-fixture",
    "authState": "verified",
    "signatureState": "verified",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "sandbox": true
  },
  "B34": {
    "paymentState": "settled",
    "grossMinor": 100,
    "platformMinor": 20,
    "partnerMinor": 70,
    "refundMinor": 10,
    "currency": "USD",
    "settlementId": "settlementId-fixture",
    "partnerId": "partnerId-fixture",
    "contractVersion": "1.0.0",
    "period": "period-fixture",
    "meterState": "reconciled"
  },
  "B35": {
    "studioSessionId": "studioSessionId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "action": "upload",
    "actorCapacity": "customer",
    "deviceState": "registered",
    "aiLabelLocked": true,
    "containsMinor": true
  },
  "B36": {
    "channelOrderId": "channelOrderId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "subjectStatus": "living",
    "recipientClaimed": true,
    "authorizationEvidenceId": "authorizationEvidenceId-fixture",
    "interactionMode": "none",
    "paymentState": "captured"
  },
  "B37": {
    "facialDataTransferred": false,
    "experienceId": "experienceId-fixture",
    "scenario": "retirement_vision",
    "regulatedUse": "education_only",
    "photoOptional": true,
    "productRecommendationSeparated": true,
    "approvalEvidenceIds": [
      "approvalEvidenceIds-1"
    ],
    "assuranceProviderId": "assuranceProviderId-fixture",
    "providerEnvironment": "sandbox",
    "assuranceArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "B38": {
    "fields": [
      "name"
    ],
    "handoffId": "handoffId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "recipient": "recipient-fixture",
    "channel": "email",
    "expiresAt": "@dynamic:future-60d",
    "explicitOptIn": true,
    "suppressionState": "clear"
  },
  "B39": {
    "referralId": "referralId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "rewardType": "credit",
    "attributionState": "verified",
    "fraudState": "clear",
    "publicUgc": true,
    "publicDisplayConsent": true
  },
  "B40": {
    "messageId": "messageId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "messageClass": "transactional",
    "channel": "email",
    "scheduledAt": "@dynamic:future-60d",
    "dateSource": "user_selected",
    "subscriptionState": "subscribed",
    "containsMinor": true
  },
  "B41": {
    "eventId": "eventId-fixture",
    "eventType": "eventType-fixture",
    "schemaVersion": "1.0.0",
    "occurredAt": "@dynamic:future-60d",
    "receivedAt": "@dynamic:future-60d",
    "actorPseudonym": "actorPseudonym-fixture",
    "dimensions": {
      "fixture": true
    },
    "metricNames": [
      "metricNames-1"
    ]
  },
  "B42": {
    "state": "draft",
    "guardrails": [
      "consent",
      "child_safety",
      "ai_label",
      "price_transparency",
      "crisis_policy"
    ],
    "experimentId": "experimentId-fixture",
    "subjectKey": "subjectKey-fixture",
    "variant": "variant-fixture",
    "variables": [
      "variables-1"
    ],
    "features": [
      "features-1"
    ],
    "preregistered": true,
    "exposureRecorded": true
  },
  "B43": {
    "actionId": "actionId-fixture",
    "action": "view",
    "targetId": "targetId-fixture",
    "reason": "reason-fixture",
    "ticketId": "ticketId-fixture",
    "policyVersion": "1.0.0",
    "fraudState": "clear"
  },
  "B44": {
    "scans": [
      "sast",
      "dast",
      "sca",
      "secrets",
      "iac",
      "container",
      "sbom"
    ],
    "securityProviderId": "security-auditor",
    "unresolvedCritical": 0,
    "baselineId": "baselineId-fixture",
    "policyVersion": "1.0.0",
    "controlState": "passed",
    "externalEvidenceIds": [
      "fixture-evidence"
    ],
    "providerEnvironment": "sandbox",
    "baselineArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "dataMap": {
      "fixture": true
    }
  },
  "B45": {
    "objectiveId": "objective-1",
    "target": 0.99,
    "errorBudget": 0.01,
    "containsSensitivePayload": false,
    "service": "upload",
    "indicator": "indicator-fixture",
    "runbookId": "runbookId-fixture",
    "capacityPlan": {
      "fixture": true
    }
  },
  "B46": {
    "integrityChecks": [
      "database",
      "object_storage",
      "deletion_ledger",
      "audit_log",
      "backups"
    ],
    "drillId": "drillId-fixture",
    "recoveryState": "passed",
    "deletionReplayState": "verified",
    "externalEvidenceIds": [
      "fixture-evidence"
    ],
    "secondApproverId": "secondApproverId-fixture",
    "recoveryProviderId": "recoveryProviderId-fixture",
    "providerEnvironment": "sandbox",
    "recoveryArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "B47": {
    "fromEnvironment": "preview",
    "toEnvironment": "staging",
    "requiredChecks": [
      "build",
      "lint",
      "typecheck",
      "unit",
      "integration",
      "security",
      "privacy",
      "rollback"
    ],
    "releaseId": "releaseId-fixture",
    "artifactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provenanceId": "provenanceId-fixture",
    "gateState": "passed",
    "externalEvidenceIds": [
      "fixture-evidence"
    ],
    "releaseControlProviderId": "releaseControlProviderId-fixture",
    "providerEnvironment": "sandbox"
  },
  "B48": {
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2",
      "evidence-3",
      "evidence-4",
      "evidence-5"
    ],
    "loopEvidence": {
      "consumer": "passed",
      "familyGift": "passed",
      "studio": "passed",
      "educationCrm": "passed",
      "failureAbuse": "passed"
    },
    "certificationRunId": "certificationRunId-fixture",
    "environment": "isolated_staging",
    "abuseFixturesSynthetic": true,
    "auditorProviderId": "auditorProviderId-fixture",
    "providerEnvironment": "sandbox",
    "certificationArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "B49": {
    "reportHashes": {
      "B00": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B01": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B02": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B03": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B04": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B05": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B06": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B07": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B08": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B09": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B10": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B11": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B12": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B13": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B14": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B15": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B16": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B17": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B18": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B19": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B20": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B21": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B22": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B23": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B24": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B25": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B26": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B27": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B28": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B29": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B30": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B31": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B32": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B33": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B34": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B35": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B36": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B37": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B38": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B39": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B40": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B41": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B42": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B43": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B44": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B45": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B46": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B47": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B48": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B49": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "B50": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "unresolvedBlockers": [],
    "releaseId": "releaseId-fixture",
    "cleanRoomState": "passed",
    "reportBatchIds": [
      "B00",
      "B01",
      "B02",
      "B03",
      "B04",
      "B05",
      "B06",
      "B07",
      "B08",
      "B09",
      "B10",
      "B11",
      "B12",
      "B13",
      "B14",
      "B15",
      "B16",
      "B17",
      "B18",
      "B19",
      "B20",
      "B21",
      "B22",
      "B23",
      "B24",
      "B25",
      "B26",
      "B27",
      "B28",
      "B29",
      "B30",
      "B31",
      "B32",
      "B33",
      "B34",
      "B35",
      "B36",
      "B37",
      "B38",
      "B39",
      "B40",
      "B41",
      "B42",
      "B43",
      "B44",
      "B45",
      "B46",
      "B47",
      "B48",
      "B49",
      "B50"
    ],
    "externalEvidenceIds": [
      "fixture-evidence"
    ],
    "attestationState": "externally_verified",
    "releaseAuditorProviderId": "releaseAuditorProviderId-fixture",
    "providerEnvironment": "sandbox",
    "releaseArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "B50": {
    "orchestrationId": "orchestration-1",
    "batchId": "B01",
    "fromState": "planned",
    "toState": "ready",
    "dependencyBatchIds": [],
    "verifiedDependencyIds": [],
    "branch": "branch-fixture",
    "worktree": "worktree-fixture",
    "leaseExpiresAt": "@dynamic:future-60d",
    "evidenceIds": [
      "evidence-1"
    ]
  },
  "B51": {
    "northStarMetric": "durable_customer_value",
    "guardrails": [
      "safety",
      "quality",
      "cost",
      "revenue"
    ],
    "profileId": "profileId-fixture",
    "stackProfile": "stackProfile-fixture",
    "businessModel": "businessModel-fixture",
    "regions": [
      "regions-1"
    ],
    "locales": [
      "zh-CN",
      "en-US"
    ],
    "channels": [
      "channels-1"
    ],
    "selectedBatches": [
      "B00"
    ],
    "dependencyClosureVerified": true
  },
  "B52": {
    "personaTypes": [
      "consumer",
      "family"
    ],
    "includesMinorResearch": false,
    "journeys": [
      "onboarding",
      "purchase",
      "refund",
      "deletion"
    ],
    "researchId": "researchId-fixture",
    "failureJourneys": [
      "refund",
      "deletion"
    ],
    "sampleSize": 1,
    "anonymized": true
  },
  "B53": {
    "routes": [
      "home",
      "create"
    ],
    "objectTypes": [
      "project",
      "asset",
      "order"
    ],
    "manifestId": "manifestId-fixture",
    "version": "1.0.0",
    "serverSideAuthorization": true,
    "consentAware": true,
    "failClosedUnknownRoutes": true
  },
  "B54": {
    "components": [
      "button",
      "form",
      "dialog",
      "status"
    ],
    "accessibilityStates": [
      "keyboard",
      "screen_reader",
      "high_contrast"
    ],
    "version": "1.0.0",
    "tokens": {
      "fixture": true
    },
    "visualRegressionEnabled": true,
    "whiteLabelOverridesRestricted": true
  },
  "B55": {
    "locales": [
      "zh-CN",
      "zh-TW",
      "en"
    ],
    "channels": [
      "web",
      "mobile",
      "mini_program"
    ],
    "testSuites": [
      "pseudo_localization",
      "long_text",
      "accessibility"
    ],
    "policyId": "policyId-fixture",
    "timezoneStorage": "UTC",
    "wcagTarget": "AA"
  },
  "B56": {
    "releaseCandidate": "releaseCandidate-fixture",
    "baselineId": "baselineId-fixture",
    "assessmentProviderId": "assessmentProviderId-fixture",
    "providerEnvironment": "sandbox",
    "evaluationReportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reportPolicyVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B57": {
    "status": "draft",
    "customScripts": [],
    "pageId": "pageId-fixture",
    "version": "1.0.0",
    "canonicalUrl": "https://example.invalid/fixture",
    "components": [
      "components-1"
    ],
    "consentBeforeTracking": true,
    "sanitized": true
  },
  "B58": {
    "fromState": "draft",
    "toState": "review",
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "requiredLocales": [
      "zh-CN",
      "en"
    ],
    "completedLocales": [
      "zh-CN",
      "en"
    ],
    "contentId": "contentId-fixture",
    "approvalProviderId": "approvalProviderId-fixture",
    "providerEnvironment": "sandbox",
    "contentArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "contentType": "article",
    "version": "1.0.0",
    "approvals": [
      "approvals-1"
    ],
    "mediaValidationReportId": "mediaValidationReportId-fixture"
  },
  "B59": {
    "excludedFields": [
      "raw_media",
      "face_features",
      "minor_identity",
      "private_dialogue"
    ],
    "policyId": "policyId-fixture",
    "region": "region-fixture",
    "version": "1.0.0",
    "purposes": [
      "purposes-1"
    ],
    "enabledTags": [
      "enabledTags-1"
    ],
    "grantedPurposes": [
      "grantedPurposes-1"
    ],
    "withdrawalPropagation": true
  },
  "B60": {
    "state": "draft",
    "tokenEntropyBits": 128,
    "campaignId": "campaignId-fixture",
    "destinationUrl": "https://example.invalid/fixture",
    "channels": [
      "channels-1"
    ],
    "attributionWindowDays": 1,
    "consentEnforced": true
  },
  "B61": {
    "shareId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "assetKind": "card",
    "containsMinor": true,
    "guardianVerified": true,
    "aiLabelPresent": true,
    "tokenTtlSeconds": 1,
    "sourceMediaResolution": "derived"
  },
  "B62": {
    "documentId": "documentId-fixture",
    "assuranceProviderId": "assuranceProviderId-fixture",
    "providerEnvironment": "sandbox",
    "documentArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "documentType": "brand_asset",
    "implementationVersion": "1.0.0",
    "expiresAt": "@dynamic:future-60d",
    "approvals": [
      "approvals-1"
    ],
    "externalEvidenceIds": [
      "fixture-evidence"
    ],
    "claimVerificationReportId": "claimVerificationReportId-fixture"
  },
  "B63": {
    "allowedApiVersions": [
      "v1"
    ],
    "failClosedUnknownVersion": true,
    "appId": "appId-fixture",
    "platform": "ios",
    "manifestVersion": "1.0.0",
    "minimumClientVersion": "1.0.0",
    "secureTokenStorage": true,
    "offlineDataClasses": [
      "offlineDataClasses-1"
    ]
  },
  "B64": {
    "checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "uploadId": "uploadId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "mediaType": "image/heic",
    "chunkCount": 1,
    "exifRemoved": true,
    "serverRevalidation": true,
    "idempotentAssembly": true
  },
  "B65": {
    "conflictStrategy": "version_merge",
    "projectId": "projectId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "action": "edit",
    "authorizationState": "active",
    "progressSource": "server",
    "aiLabelPresent": true
  },
  "B66": {
    "accountId": "account-1",
    "transactionId": "transactionId-fixture",
    "provider": "app_store",
    "providerEnvironment": "sandbox",
    "productId": "productId-fixture",
    "receiptArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "amountMinor": 1,
    "currency": "USD",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B67": {
    "notificationId": "notificationId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "deviceId": "deviceId-fixture",
    "deviceOwnerActorId": "deviceOwnerActorId-fixture",
    "navigationRef": "navigationRef-fixture",
    "payload": {
      "fixture": true
    },
    "authorizationRechecked": true,
    "widgetDataMinimal": true
  },
  "B68": {
    "testDevices": [
      "iphone",
      "android"
    ],
    "testSuites": [
      "security",
      "privacy",
      "performance",
      "accessibility"
    ],
    "prohibitedSdkFlows": [],
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "networkCaptureReportId": "network-capture-1",
    "debugConfigurationReportId": "debug-config-1",
    "buildId": "buildId-fixture",
    "assuranceProviderId": "assuranceProviderId-fixture",
    "providerEnvironment": "sandbox",
    "assuranceArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "privacyManifestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "B69": {
    "passedGates": [
      "unit",
      "device",
      "security",
      "privacy",
      "iap",
      "cold_start"
    ],
    "criticalFindings": 0,
    "releaseId": "releaseId-fixture",
    "platform": "ios",
    "providerEnvironment": "sandbox",
    "artifactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "signingKeyReference": "signingKeyReference-fixture",
    "rolloutPercent": 1,
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B70": {
    "mediaUrlTtlSeconds": 60,
    "sessionId": "sessionId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "identityBinding": "provider_subject",
    "cacheNamespace": "cacheNamespace-fixture",
    "cacheClearedOnHide": true,
    "serverAuthorization": true
  },
  "B71": {
    "currency": "CNY",
    "paymentId": "paymentId-fixture",
    "providerEventId": "providerEventId-fixture",
    "providerEnvironment": "sandbox",
    "callbackArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "amountMinor": 1,
    "messageAuthorizationCount": 1,
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B72": {
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "unresolvedReviewIssues": 0,
    "reviewTenantId": "fixture-tenant",
    "releaseId": "releaseId-fixture",
    "subjectId": "subjectId-fixture",
    "privacyDeclarationHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "releaseArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "isolatedReviewTenant": true,
    "rollbackCompatible": true
  },
  "B73": {
    "purpose": "transactional",
    "status": "subscribed",
    "quietHoursStart": "22:00",
    "quietHoursEnd": "07:00",
    "preferenceId": "preferenceId-fixture",
    "subjectId": "subjectId-fixture",
    "channel": "email",
    "timezone": "timezone-fixture",
    "dailyLimit": 1,
    "policyVersion": "1.0.0",
    "mergePreservesOptOut": true
  },
  "B74": {
    "notificationId": "notificationId-fixture",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "channel": "email",
    "recipientRef": "recipientRef-fixture",
    "templateVersion": "1.0.0",
    "providerRoute": [
      "providerRoute-1"
    ],
    "eligibilityDecisionId": "eligibilityDecisionId-fixture",
    "callbackVerificationPolicyVersion": "1.0.0",
    "boundedRetries": 1
  },
  "B75": {
    "approvals": [
      "legal",
      "brand"
    ],
    "templateId": "templateId-fixture",
    "version": "1.0.0",
    "channel": "email",
    "locale": "zh-CN",
    "purpose": "age_transformation",
    "variables": {
      "fixture": true
    },
    "linksExpire": true,
    "htmlSanitized": true
  },
  "B76": {
    "state": "draft",
    "exitCriteria": [
      "consent_withdrawn",
      "unsubscribed",
      "refunded"
    ],
    "journeyId": "journeyId-fixture",
    "participantIds": [
      "fixture-actor"
    ],
    "purpose": "age_transformation",
    "version": "1.0.0",
    "triggerEvents": [
      "triggerEvents-1"
    ],
    "maxMessages": 1,
    "experimentGuardrailsApproved": true
  },
  "B77": {
    "authentication": [
      "spf",
      "dkim"
    ],
    "suppressionSources": [
      "complaints",
      "unsubscribes"
    ],
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "deliverabilityArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sendingIdentity": "sendingIdentity-fixture",
    "health": "healthy",
    "softBounceRetryLimit": 1,
    "complaintSuppressionPolicyVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B78": {
    "guardrailMetrics": [
      "unsubscribe",
      "complaint",
      "cost"
    ],
    "experimentId": "experimentId-fixture",
    "hypothesis": "hypothesis-fixture",
    "assignmentUnit": "account",
    "holdoutPercent": 1,
    "frequencyLimit": 1,
    "recordsActualExposure": true,
    "consentProtected": true
  },
  "B79": {
    "state": "draft",
    "searchVisible": false,
    "authorizationBypassAdvice": false,
    "sourceVersionCurrent": true,
    "articleId": "articleId-fixture",
    "locale": "zh-CN",
    "region": "region-fixture",
    "policyVersion": "1.0.0"
  },
  "B80": {
    "channel": "in_app",
    "severity": "P2",
    "queue": "consumer-support",
    "assignedRole": "support_agent",
    "privacySensitive": false,
    "ticketId": "ticketId-fixture",
    "dueAt": "@dynamic:future-60d",
    "dedupeKey": "dedupeKey-fixture"
  },
  "B81": {
    "promisedOutcome": false,
    "conversationId": "conversationId-fixture",
    "sourceArticleIds": [
      "sourceArticleIds-1"
    ],
    "toolMode": "read_only",
    "confidence": 1,
    "handoffAvailable": true,
    "toolTenantBound": true
  },
  "B82": {
    "maskedFields": [
      "payment_credential",
      "raw_media"
    ],
    "visibleFields": [
      "status",
      "timeline"
    ],
    "expiresAt": "@dynamic:future-30m",
    "sessionId": "sessionId-fixture",
    "caseId": "caseId-fixture",
    "reason": "reason-fixture",
    "sensitive": true,
    "customerNotice": true
  },
  "B83": {
    "actionId": "actionId-fixture",
    "ticketId": "ticketId-fixture",
    "actionType": "refund",
    "previewHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "approvalIds": [
      "approvalIds-1"
    ],
    "mutuallyExclusiveChecked": true,
    "duplicateRemedyChecked": true,
    "dataRightsPropagation": true,
    "amountMinor": 1,
    "currency": "USD"
  },
  "B84": {
    "opportunityId": "opportunityId-fixture",
    "partnerId": "partnerId-fixture",
    "stage": "qualified",
    "contactConsent": true,
    "quoteVersion": "1.0.0",
    "quoteExpiresAt": "@dynamic:future-60d",
    "amountMinor": 1,
    "currency": "USD",
    "duplicateOwnershipChecked": true
  },
  "B85": {
    "healthInputs": [
      "adoption",
      "support"
    ],
    "partnerId": "partnerId-fixture",
    "lifecycleState": "onboarding",
    "milestones": [
      "milestones-1"
    ],
    "platformIncidentAdjusted": true,
    "credentialsRevoked": true,
    "collectionDisabled": true
  },
  "B86": {
    "eligibleForSurvey": false,
    "unresolvedRefundFailure": true,
    "feedbackId": "feedbackId-fixture",
    "source": "csat",
    "dedupeKey": "dedupeKey-fixture",
    "rootCause": "rootCause-fixture",
    "sensitiveContentRedacted": true,
    "qualityReviewerCount": 1
  },
  "B87": {
    "journalId": "journalId-fixture",
    "legalEntityId": "legalEntityId-fixture",
    "sourceType": "sourceType-fixture",
    "sourceId": "sourceId-fixture",
    "currency": "USD",
    "period": "period-fixture",
    "periodState": "open",
    "lines": [
      {
        "accountCode": "cash",
        "direction": "debit",
        "amountMinor": 100,
        "currency": "USD"
      },
      {
        "accountCode": "revenue",
        "direction": "credit",
        "amountMinor": 100,
        "currency": "USD"
      }
    ]
  },
  "B88": {
    "crossCurrencyMatching": false,
    "exceptionTotalMinor": 0,
    "reconciliationId": "reconciliationId-fixture",
    "statementId": "statementId-fixture",
    "statementDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "currency": "USD",
    "statementTotalMinor": 1,
    "matchedTotalMinor": 1,
    "duplicateImportChecked": true
  },
  "B89": {
    "invoiceId": "invoiceId-fixture",
    "legalEntityId": "legalEntityId-fixture",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "invoiceType": "receipt",
    "taxProfileVersion": "1.0.0",
    "sequenceScope": "sequenceScope-fixture",
    "amountMinor": 1,
    "currency": "USD",
    "creditNotePolicyVersion": "1.0.0"
  },
  "B90": {
    "milestones": [
      {
        "recognitionDate": "@dynamic:future-60d",
        "amountMinor": 1
      }
    ],
    "scheduleId": "scheduleId-fixture",
    "contractId": "contractId-fixture",
    "obligationType": "digital",
    "totalMinor": 1,
    "currency": "USD",
    "historicalScheduleImmutable": true
  },
  "B91": {
    "disputeId": "disputeId-fixture",
    "providerCaseId": "providerCaseId-fixture",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "disputeArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "action": "accept",
    "amountMinor": 1,
    "currency": "USD",
    "responseDueAt": "@dynamic:future-60d",
    "evidenceIds": [
      "evidence-1"
    ],
    "reserveEntryId": "reserveEntryId-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B92": {
    "accountReference": "acct-ref",
    "approvalIds": [
      "finance-1",
      "finance-2"
    ],
    "payoutId": "payoutId-fixture",
    "partnerId": "partnerId-fixture",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "payoutArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "statementId": "statementId-fixture",
    "amountMinor": 1,
    "currency": "USD",
    "refundReconciliationId": "refundReconciliationId-fixture",
    "withholdingDocumentId": "withholdingDocumentId-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B93": {
    "allocationId": "allocationId-fixture",
    "costEventId": "costEventId-fixture",
    "costType": "ai",
    "amountMinor": 1,
    "currency": "USD",
    "allocationBasis": "allocationBasis-fixture",
    "allocationPercent": 1,
    "cacheHitDeduplicated": true,
    "paidOrdersProtected": true
  },
  "B94": {
    "checklist": [
      "trial_balance",
      "reconciliation",
      "tax_review",
      "approval"
    ],
    "approvalIds": [
      "finance-1",
      "finance-2"
    ],
    "closeId": "closeId-fixture",
    "period": "period-fixture",
    "legalEntityId": "legalEntityId-fixture",
    "erpProviderId": "erpProviderId-fixture",
    "providerEnvironment": "sandbox",
    "closeArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "trialBalanceMinor": 1,
    "exportControlTotalMinor": 1,
    "exportIdempotencyReference": "exportIdempotencyReference-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B95": {
    "dpi": 300,
    "bleedMm": 3,
    "preflightId": "preflightId-fixture",
    "productType": "photo_book",
    "templateVersion": "1.0.0",
    "assetHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "fontsEmbedded": true,
    "faceCropSafe": true,
    "colorProfile": "colorProfile-fixture",
    "specificationFrozen": true
  },
  "B96": {
    "status": "onboarding",
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "vendorId": "vendorId-fixture",
    "vendorProfileArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "contractVersion": "1.0.0",
    "capabilities": [
      "capabilities-1"
    ],
    "regions": [
      "regions-1"
    ],
    "priceBookVersion": "1.0.0",
    "capacityObservedAt": "@dynamic:future-60d",
    "dataAccessExpiresAt": "@dynamic:future-60d"
  },
  "B97": {
    "decision": "approved",
    "approvalId": "approvalId-fixture",
    "orderId": "orderId-fixture",
    "vendorId": "vendorId-fixture",
    "proofArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "proofVersion": "1.0.0",
    "proofHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "currentAssetHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "approverId": "approverId-fixture",
    "productionLockId": "productionLockId-fixture",
    "tokenVersionId": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B98": {
    "jobId": "jobId-fixture",
    "orderId": "orderId-fixture",
    "vendorId": "vendorId-fixture",
    "purchaseOrderId": "purchaseOrderId-fixture",
    "approvedProofHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "routeVersion": "1.0.0",
    "orderState": "approved_for_production",
    "priorJobDisposition": "none",
    "capacitySnapshotId": "capacitySnapshotId-fixture"
  },
  "B99": {
    "state": "label_created",
    "shipmentId": "shipmentId-fixture",
    "orderId": "orderId-fixture",
    "addressToken": "addressToken-fixture",
    "addressVersion": "1.0.0",
    "carrierId": "carrierId-fixture",
    "carrierEventId": "carrierEventId-fixture",
    "carrierEventArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "trackingToken": "trackingToken-fixture",
    "trackingViewPolicyVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B100": {
    "adjustmentId": "adjustmentId-fixture",
    "sku": "sku-fixture",
    "locationId": "locationId-fixture",
    "vendorId": "vendorId-fixture",
    "inventorySnapshotArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "sourceVersion": "1.0.0",
    "reason": "receipt",
    "quantityDelta": 1,
    "availableAfter": 1,
    "reservationLedgerVersion": "1.0.0",
    "sourceEventId": "sourceEventId-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B101": {
    "claimId": "claimId-fixture",
    "orderId": "orderId-fixture",
    "action": "return",
    "providerType": "vendor",
    "providerId": "providerId-fixture",
    "vendorId": "vendorId-fixture",
    "providerEnvironment": "sandbox",
    "evidenceReferences": [
      "evidenceReferences-1"
    ],
    "eligibilityDecisionId": "eligibilityDecisionId-fixture",
    "remedyLedgerReference": "remedyLedgerReference-fixture",
    "returnAddressToken": "returnAddressToken-fixture"
  },
  "B102": {
    "scorecardId": "scorecard-1",
    "vendorId": "vendorId-fixture",
    "scorecardArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerEnvironment": "sandbox",
    "period": "period-fixture",
    "metrics": {
      "fixture": true
    },
    "eligibleOrderCount": 1,
    "measuredOrderCount": 1,
    "complaintIds": [
      "complaintIds-1"
    ],
    "settlementId": "settlementId-fixture",
    "vendorState": "active",
    "settlementControlTotalId": "settlementControlTotalId-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B103": {
    "callbackUrls": [
      "https://example.invalid/callback"
    ],
    "portalVersion": "1.0.0",
    "apiVersion": "1.0.0",
    "openApiDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sandboxTenantId": "sandboxTenantId-fixture",
    "sampleDataSynthetic": true,
    "idempotencyDocumented": true
  },
  "B104": {
    "scopeTenantId": "fixture-tenant",
    "credentialId": "credentialId-fixture",
    "credentialType": "api_key",
    "scopes": [
      "scopes-1"
    ],
    "secretReference": "secretReference-fixture",
    "expiresAt": "@dynamic:future-60d",
    "rotationOverlapMinutes": 1,
    "revocationCachePurged": true
  },
  "B105": {
    "compatibilityTests": [
      "contract",
      "runtime"
    ],
    "sdkId": "sdkId-fixture",
    "language": "typescript",
    "version": "1.0.0",
    "contractVersion": "1.0.0",
    "artifactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "retryIdempotencyMiddleware": true,
    "examplesRedactSecrets": true
  },
  "B106": {
    "endpointId": "https://example.invalid/fixture",
    "endpointUrl": "https://example.invalid/fixture",
    "eventTypes": [
      "eventTypes-1"
    ],
    "signatureAlgorithm": "hmac-sha256",
    "signatureToleranceSeconds": 1,
    "replayEventId": "replayEventId-fixture",
    "replayReason": "replayReason-fixture",
    "consumerIdempotencyVerified": true,
    "tenantActive": true
  },
  "B107": {
    "status": "review",
    "requestedScopes": [
      "read"
    ],
    "previousScopes": [
      "read"
    ],
    "connectorId": "connectorId-fixture",
    "publisherId": "publisherId-fixture",
    "providerType": "crm",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "connectorArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "version": "1.0.0",
    "dataClasses": [
      "dataClasses-1"
    ],
    "scanReportId": "scanReportId-fixture",
    "credentialIsolationPolicyVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B108": {
    "adapterId": "adapterId-fixture",
    "systemType": "crm",
    "providerType": "crm",
    "providerId": "providerId-fixture",
    "providerEnvironment": "sandbox",
    "adapterArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "fieldMap": {
      "fixture": true
    },
    "sourceOfTruth": {
      "fixture": true
    },
    "exportedDataClasses": [
      "exportedDataClasses-1"
    ],
    "contactConsentReceiptIds": [
      "contactConsentReceiptIds-1"
    ],
    "deletionPropagationReceiptIds": [
      "deletionPropagationReceiptIds-1"
    ],
    "controlTotal": 1,
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B109": {
    "environment": "sandbox",
    "scenarios": [
      "duplicate",
      "out_of_order",
      "timeout",
      "revocation",
      "tenant_isolation"
    ],
    "criticalFailures": 0,
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "certificationId": "certificationId-fixture",
    "applicationId": "applicationId-fixture",
    "providerType": "crm",
    "providerId": "providerId-fixture",
    "certificationArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "apiVersion": "1.0.0",
    "callbackUrl": "https://example.invalid/callback",
    "syntheticDataOnly": true
  },
  "B110": {
    "compatibility": "additive",
    "migrationArtifacts": [
      "guide",
      "sdk"
    ],
    "changeId": "changeId-fixture",
    "surface": "api",
    "currentVersion": "1.0.0",
    "targetVersion": "1.0.0",
    "deprecationAt": "@dynamic:future-30d",
    "sunsetAt": "@dynamic:future-60d",
    "affectedPartners": [
      "affectedPartners-1"
    ],
    "contractTestPassed": true
  },
  "B111": {
    "requiredFields": [
      "eventId",
      "tenantId",
      "occurredAt"
    ],
    "forbiddenFields": [
      "raw_media",
      "face_features",
      "private_dialogue",
      "payment_credential"
    ],
    "schemaId": "schemaId-fixture",
    "eventName": "eventName-fixture",
    "version": "1.0.0",
    "producer": "producer-fixture",
    "dataClasses": [
      "dataClasses-1"
    ],
    "consentPurpose": "consentPurpose-fixture",
    "dedupeKey": "dedupeKey-fixture",
    "retentionDays": 1,
    "serverAuthoritative": true
  },
  "B112": {
    "layers": [
      "raw",
      "staging",
      "core",
      "mart"
    ],
    "controls": [
      "row_count",
      "amount_total",
      "freshness"
    ],
    "semanticMetrics": [
      "revenue",
      "orders",
      "refunds"
    ],
    "pipelineId": "pipelineId-fixture",
    "source": "source-fixture",
    "watermark": "watermark-fixture",
    "primaryKeys": [
      "primaryKeys-1"
    ],
    "replaySideEffectsDisabled": true,
    "deletionMarkersPreserved": true
  },
  "B113": {
    "metrics": [
      "revenue",
      "orders"
    ],
    "dashboardId": "dashboardId-fixture",
    "audienceRole": "audienceRole-fixture",
    "definitionsVersion": "1.0.0",
    "rowLevelTenantFilter": true,
    "columnMasking": true,
    "freshnessMinutes": 1,
    "drilldownDataClasses": [
      "drilldownDataClasses-1"
    ]
  },
  "B114": {
    "costComponents": [
      "refund",
      "partner_share",
      "ai",
      "support",
      "fulfillment"
    ],
    "modelId": "modelId-fixture",
    "method": "first_touch",
    "windowDays": 1,
    "cohortUnit": "account",
    "consentMissingFlagged": true,
    "refundsIncluded": true,
    "uncertaintyDocumented": true
  },
  "B115": {
    "revenueMinor": 100,
    "refundMinor": 10,
    "costComponents": [
      "ai_retry",
      "storage",
      "payment",
      "message",
      "fulfillment",
      "support",
      "partner_share"
    ],
    "costs": {
      "ai_retry": 1,
      "storage": 1,
      "payment": 1,
      "message": 1,
      "fulfillment": 1,
      "support": 1,
      "partner_share": 1
    },
    "modelId": "modelId-fixture",
    "grain": "order",
    "currency": "USD",
    "ledgerReconciled": true,
    "assumptionsSeparated": true
  },
  "B116": {
    "variants": [
      "control",
      "treatment"
    ],
    "guardrails": [
      "consent",
      "ai_label",
      "child_safety",
      "payment_truth",
      "deletion",
      "high_impact_ban"
    ],
    "approvalIds": [
      "product-approval",
      "risk-approval"
    ],
    "experimentId": "experimentId-fixture",
    "hypothesis": "hypothesis-fixture",
    "population": "population-fixture",
    "assignmentUnit": "account",
    "primaryMetric": "primaryMetric-fixture",
    "sampleSize": 1,
    "stopRule": "stopRule-fixture",
    "deterministicAssignment": true,
    "recordsActualExposure": true
  },
  "B117": {
    "classification": "restricted",
    "deletionTargets": [
      "business_store",
      "warehouse",
      "cache",
      "export",
      "connector"
    ],
    "qualityRules": [
      "schema",
      "freshness",
      "uniqueness",
      "completeness"
    ],
    "assetId": "assetId-fixture",
    "ownerId": "ownerId-fixture",
    "lineageUpstream": [
      "lineageUpstream-1"
    ],
    "lineageDownstream": [
      "lineageDownstream-1"
    ],
    "accessAuditEnabled": true,
    "exportControlled": true
  },
  "B118": {
    "cohorts": [
      "adult",
      "family",
      "minor",
      "regional"
    ],
    "metrics": [
      "safety",
      "fairness",
      "quality",
      "latency",
      "cost",
      "drift"
    ],
    "evaluationId": "evaluationId-fixture",
    "modelVersion": "1.0.0",
    "promptVersion": "1.0.0",
    "datasetId": "datasetId-fixture",
    "datasetAuthorization": "synthetic",
    "evaluationProviderId": "evaluationProviderId-fixture",
    "providerEnvironment": "sandbox",
    "evaluationReportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reportSchemaVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B119": {
    "environment": "local",
    "changeId": "changeId-fixture",
    "schemaVersion": "1.0.0",
    "secretReference": "secretReference-fixture",
    "changedFields": [
      "changedFields-1"
    ],
    "disabledControls": [
      "disabledControls-1"
    ],
    "approvalIds": [
      "approvalIds-1"
    ],
    "rollbackVersion": "1.0.0",
    "changeControlProviderId": "changeControlProviderId-fixture",
    "providerEnvironment": "sandbox",
    "changeReportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reportSchemaVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B120": {
    "originRegion": "us-east",
    "processingRegion": "us-east",
    "allowedRegions": [
      "us-east"
    ],
    "replicationRegions": [],
    "unknownPolicy": false,
    "policyId": "policyId-fixture",
    "cloudProviderId": "cloudProviderId-fixture",
    "providerEnvironment": "sandbox",
    "topologyArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "dataClass": "media",
    "policyVersion": "1.0.0",
    "cdnPolicyVersion": "1.0.0",
    "revocationProofId": "revocationProofId-fixture",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B121": {
    "scenarios": [
      "baseline",
      "peak",
      "burst",
      "soak",
      "dependency_degraded"
    ],
    "thresholds": {
      "p95Ms": 500,
      "errorRate": 0.01
    },
    "testRunId": "testRunId-fixture",
    "loadProfile": "loadProfile-fixture",
    "maxP95Ms": 1,
    "maxErrorRate": 1,
    "loadTestProviderId": "loadTestProviderId-fixture",
    "providerEnvironment": "sandbox",
    "capacityReportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reportSchemaVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B122": {
    "failoverRegion": "us-west",
    "allowedFailoverRegions": [
      "us-west"
    ],
    "exerciseId": "exerciseId-fixture",
    "faultType": "model",
    "targetRtoSeconds": 1,
    "targetRpoSeconds": 1,
    "resilienceProviderId": "resilienceProviderId-fixture",
    "providerEnvironment": "sandbox",
    "resilienceReportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reportSchemaVersion": "1.0.0",
    "externalEvidenceIds": [
      "fixture-evidence"
    ]
  },
  "B123": {
    "scans": [
      "secrets",
      "sast",
      "sca",
      "iac",
      "dast",
      "api"
    ],
    "criticalFindings": 0,
    "highFindings": 0,
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "assessmentId": "assessmentId-fixture",
    "pentestProviderId": "pentestProviderId-fixture",
    "providerEnvironment": "sandbox",
    "artifactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sbomDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "retestArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provenanceSignature": "provenanceSignature-fixture",
    "engagementId": "engagementId-fixture"
  },
  "B124": {
    "controls": [
      "privacy",
      "ai_label",
      "minor",
      "finance",
      "security"
    ],
    "artifactHashes": [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    ],
    "exportTenantId": "fixture-tenant",
    "approvalIds": [
      "compliance-approval",
      "risk-approval"
    ],
    "unresolvedControlFailures": 0,
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2"
    ],
    "assessmentId": "assessmentId-fixture",
    "complianceProviderId": "complianceProviderId-fixture",
    "providerEnvironment": "sandbox",
    "assessmentArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "profileVersion": "1.0.0",
    "region": "region-fixture",
    "evidenceExpiresAt": "@dynamic:future-60d"
  },
  "B125": {
    "policyVersions": [
      "privacy-v1",
      "security-v1",
      "finance-v1",
      "support-v1",
      "supply-v1",
      "operations-v1"
    ],
    "operationalDrills": [
      "support_escalation",
      "month_end_close",
      "incident_response",
      "refund",
      "vendor_failure"
    ],
    "providerChecks": [
      "payment",
      "messaging",
      "fulfillment",
      "cloud",
      "crm",
      "tax"
    ],
    "raciRoles": [
      "risk",
      "operations",
      "security",
      "finance"
    ],
    "stopConditions": [
      "p0",
      "financial_mismatch",
      "privacy_breach"
    ],
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2",
      "evidence-3",
      "evidence-4"
    ],
    "p0Blockers": 0,
    "p1Blockers": 0,
    "unresolvedLegalBlocks": 0,
    "unresolvedFinancialBlocks": 0,
    "readinessId": "readinessId-fixture",
    "auditorProviderId": "auditorProviderId-fixture",
    "providerEnvironment": "sandbox",
    "readinessArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "profileVersion": "1.0.0",
    "vendorContractRegisterId": "vendorContractRegisterId-fixture"
  },
  "B126": {
    "environment": "sandbox",
    "entrypoints": [
      "web",
      "api",
      "worker",
      "mobile"
    ],
    "scenarios": [
      "consent",
      "generation",
      "payment",
      "refund",
      "physical_fulfillment",
      "support",
      "finance_close",
      "deletion"
    ],
    "deletionProofTargets": [
      "connector",
      "cdn",
      "vendor",
      "warehouse",
      "application"
    ],
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2",
      "evidence-3",
      "evidence-4",
      "evidence-5"
    ],
    "financialControlTotalMinor": 100,
    "ledgerControlTotalMinor": 100,
    "criticalFailures": 0,
    "certificationId": "certificationId-fixture",
    "auditorProviderId": "auditorProviderId-fixture",
    "scenarioArtifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "entitlementReconciliationId": "entitlementReconciliationId-fixture"
  },
  "B127": {
    "repositoryCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "artifactCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "releaseGates": [
      "G0",
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8",
      "G9",
      "G10",
      "G11"
    ],
    "monitoringDomains": [
      "quality",
      "payment",
      "refund",
      "message",
      "support",
      "ledger",
      "supply",
      "privacy",
      "security",
      "cost",
      "slo"
    ],
    "approvalIds": [
      "risk-approval",
      "operations-approval"
    ],
    "changeApproverEvidenceIds": [
      "risk-evidence",
      "operations-evidence"
    ],
    "externalEvidenceIds": [
      "evidence-1",
      "evidence-2",
      "evidence-3",
      "evidence-4",
      "evidence-5"
    ],
    "activeGuardrailBreaches": 0,
    "launchId": "launchId-fixture",
    "releaseControlProviderId": "releaseControlProviderId-fixture",
    "providerEnvironment": "sandbox",
    "releaseManifestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sbomDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "wave": "global",
    "rolloutPercent": 100,
    "waveStartedAt": "@dynamic:past-1m",
    "rollbackExerciseId": "rollbackExerciseId-fixture",
    "automaticPausePolicyVersion": "1.0.0",
    "guardrailPolicySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "waveObservationSetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "rollbackForwardDrillSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "globalWaveObservationPath": "security/evidence/global-wave-observation.json",
    "globalWaveObservationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
};

const DYNAMIC_TIMESTAMP_OFFSETS: Readonly<Record<string, number>> = {
  "@dynamic:future-30m": 30 * 60_000,
  "@dynamic:future-7d": 7 * 86_400_000,
  "@dynamic:future-30d": 30 * 86_400_000,
  "@dynamic:future-60d": 60 * 86_400_000,
  "@dynamic:past-1m": -60_000,
};

function materialize(value: JsonValue, now: number): JsonValue {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(DYNAMIC_TIMESTAMP_OFFSETS, value)) {
    return new Date(now + DYNAMIC_TIMESTAMP_OFFSETS[value]!).toISOString();
  }
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, now));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry, now)]));
  }
  return value;
}

/** Return a fresh, time-valid input for every canonical capability validator. */
export function createCapabilityValidInputFixtures(now = Date.now()): Readonly<Record<CanonicalCapabilityBatchId, JsonObject>> {
  return Object.fromEntries(CANONICAL_CAPABILITY_BATCH_IDS.map((batchId) => [
    batchId,
    materialize(FIXTURE_TEMPLATES[batchId], now) as JsonObject,
  ])) as Record<CanonicalCapabilityBatchId, JsonObject>;
}
