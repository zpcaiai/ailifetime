package com.ailifetime.sdk;

import java.util.Objects;
import java.util.Set;

public record ConsentGrantRequest(
    String participantId,
    String grantorCapacity,
    String purpose,
    ConsentScope scope,
    String policyVersion,
    String evidenceHash,
    String id,
    String expiresAt
) {
    private static final Set<String> CAPACITIES = Set.of("self", "guardian", "authorized_agent");

    public ConsentGrantRequest {
        requireBounded(participantId, "participantId", 128);
        requireBounded(grantorCapacity, "grantorCapacity", 32);
        requireBounded(purpose, "purpose", 120);
        Objects.requireNonNull(scope, "scope");
        requireBounded(policyVersion, "policyVersion", 128);
        if (!CAPACITIES.contains(grantorCapacity)) {
            throw new IllegalArgumentException("grantorCapacity is invalid");
        }
        if (evidenceHash != null && !evidenceHash.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("evidenceHash must be a lowercase SHA-256 digest");
        }
        if (id != null) requireBounded(id, "id", 128);
        if (expiresAt != null) requireBounded(expiresAt, "expiresAt", 64);
    }

    private static void requireBounded(String value, String label, int maximum) {
        Objects.requireNonNull(value, label);
        if (value.isBlank() || value.length() > maximum || !value.equals(value.trim())) {
            throw new IllegalArgumentException(label + " must be a bounded non-empty string");
        }
    }
}
