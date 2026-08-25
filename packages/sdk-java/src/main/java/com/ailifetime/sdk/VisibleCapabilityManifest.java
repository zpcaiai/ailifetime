package com.ailifetime.sdk;

import java.util.List;
import java.util.Objects;

public record VisibleCapabilityManifest(
    String schemaVersion,
    List<CapabilitySummary> capabilities,
    List<VisibleCapabilityPortal> portals,
    int count,
    String requestId
) {
    public VisibleCapabilityManifest {
        if (!"ltm.visible-capability-manifest.v1".equals(schemaVersion)) {
            throw new IllegalArgumentException("unsupported visible capability manifest schema");
        }
        capabilities = List.copyOf(Objects.requireNonNull(capabilities, "capabilities"));
        portals = List.copyOf(Objects.requireNonNull(portals, "portals"));
        Objects.requireNonNull(requestId, "requestId");
    }
}
