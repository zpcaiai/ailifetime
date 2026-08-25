package com.ailifetime.sdk;

import java.util.Set;

public record RightsReviewRequest(
    String requestId,
    String decision,
    String reasonCode,
    String caseReference
) {
    public RightsReviewRequest {
        if (requestId == null || requestId.isBlank() || caseReference == null || caseReference.isBlank()) {
            throw new IllegalArgumentException("requestId and caseReference are required");
        }
        if (!Set.of("approve", "deny").contains(decision)) throw new IllegalArgumentException("decision is invalid");
        if (reasonCode == null || !reasonCode.matches("[A-Z][A-Z0-9_]{1,79}")) {
            throw new IllegalArgumentException("reasonCode is invalid");
        }
    }
}
