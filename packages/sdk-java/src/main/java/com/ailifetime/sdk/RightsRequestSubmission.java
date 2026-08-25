package com.ailifetime.sdk;

import java.util.List;
import java.util.Objects;
import java.util.Set;

public record RightsRequestSubmission(
    String participantId,
    String requestType,
    String requestedProcessingPurpose,
    String requestId,
    List<String> correctionFields,
    String correctionPayloadSha256,
    String parentRequestId
) {
    private static final Set<String> TYPES = Set.of(
        "access", "correction", "export", "withdraw", "delete", "restrict_processing", "appeal"
    );

    public RightsRequestSubmission {
        requireBounded(participantId, "participantId", 128);
        requireBounded(requestType, "requestType", 32);
        requireBounded(requestedProcessingPurpose, "requestedProcessingPurpose", 120);
        if (!TYPES.contains(requestType)) throw new IllegalArgumentException("requestType is invalid");
        if (requestId != null) requireBounded(requestId, "requestId", 128);
        correctionFields = correctionFields == null ? null : List.copyOf(correctionFields);
        if (correctionFields != null && correctionFields.size() > 50) {
            throw new IllegalArgumentException("correctionFields exceeds 50 entries");
        }
        if (correctionPayloadSha256 != null && !correctionPayloadSha256.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("correctionPayloadSha256 must be a lowercase SHA-256 digest");
        }
        if (parentRequestId != null) requireBounded(parentRequestId, "parentRequestId", 128);
    }

    private static void requireBounded(String value, String label, int maximum) {
        Objects.requireNonNull(value, label);
        if (value.isBlank() || value.length() > maximum || !value.equals(value.trim())) {
            throw new IllegalArgumentException(label + " must be a bounded non-empty string");
        }
    }
}
