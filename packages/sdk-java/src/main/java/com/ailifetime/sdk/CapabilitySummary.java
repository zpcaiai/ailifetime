package com.ailifetime.sdk;

import java.util.List;
import java.util.Objects;

public record CapabilitySummary(
    String batchId,
    String skill,
    String operation,
    String permission,
    CapabilityPortalId portalId,
    CapabilityMode mode,
    List<String> requirements,
    boolean requiresExternalEvidence
) {
    public CapabilitySummary {
        Objects.requireNonNull(batchId, "batchId");
        Objects.requireNonNull(skill, "skill");
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(permission, "permission");
        Objects.requireNonNull(portalId, "portalId");
        Objects.requireNonNull(mode, "mode");
        requirements = List.copyOf(Objects.requireNonNull(requirements, "requirements"));
    }
}
