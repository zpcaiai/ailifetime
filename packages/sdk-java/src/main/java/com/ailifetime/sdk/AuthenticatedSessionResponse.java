package com.ailifetime.sdk;

import java.util.Objects;

public record AuthenticatedSessionResponse(AuthenticatedSession session, String requestId) {
    public AuthenticatedSessionResponse {
        Objects.requireNonNull(session, "session");
        Objects.requireNonNull(requestId, "requestId");
    }
}
