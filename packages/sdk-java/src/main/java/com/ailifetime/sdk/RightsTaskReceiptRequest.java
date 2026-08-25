package com.ailifetime.sdk;

import java.util.Set;

public record RightsTaskReceiptRequest(
    String requestId,
    String taskId,
    String outcome,
    String resultSha256,
    String providerOccurredAt,
    String evidenceId,
    String errorCode
) {
    public RightsTaskReceiptRequest {
        for (String value : new String[]{requestId, taskId, providerOccurredAt, evidenceId}) {
            if (value == null || value.isBlank() || !value.equals(value.trim())) {
                throw new IllegalArgumentException("rights receipt identifiers and timestamp are required");
            }
        }
        if (!Set.of("succeeded", "blocked", "failed").contains(outcome)) {
            throw new IllegalArgumentException("outcome is invalid");
        }
        if (resultSha256 == null || !resultSha256.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("resultSha256 must be a lowercase SHA-256 digest");
        }
        if (errorCode != null && !errorCode.matches("[A-Z][A-Z0-9_]{1,79}")) {
            throw new IllegalArgumentException("errorCode is invalid");
        }
    }
}
