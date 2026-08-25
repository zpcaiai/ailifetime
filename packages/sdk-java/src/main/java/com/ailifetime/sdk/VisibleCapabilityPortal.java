package com.ailifetime.sdk;

import java.util.List;
import java.util.Objects;

public record VisibleCapabilityPortal(CapabilityPortalId id, List<String> skills, int capabilityCount) {
    public VisibleCapabilityPortal {
        Objects.requireNonNull(id, "id");
        skills = List.copyOf(Objects.requireNonNull(skills, "skills"));
    }
}
