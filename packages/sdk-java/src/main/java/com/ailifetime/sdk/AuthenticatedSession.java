package com.ailifetime.sdk;

import java.util.List;
import java.util.Objects;

public record AuthenticatedSession(
    String actorId,
    String tenantId,
    List<AuthenticatedRole> roles,
    String purpose,
    boolean stepUp,
    boolean guardianVerified,
    String authenticationState
) {
    public AuthenticatedSession {
        Objects.requireNonNull(actorId, "actorId");
        Objects.requireNonNull(tenantId, "tenantId");
        roles = List.copyOf(Objects.requireNonNull(roles, "roles"));
        Objects.requireNonNull(purpose, "purpose");
        if (!"server_verified".equals(authenticationState)) {
            throw new IllegalArgumentException("authenticationState must be server_verified");
        }
    }
}
