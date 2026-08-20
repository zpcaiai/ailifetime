package com.ailifetime.sdk;

import java.util.Objects;

public record ClientSession(String accessToken, String purpose) {
    public ClientSession {
        Objects.requireNonNull(accessToken, "accessToken");
        Objects.requireNonNull(purpose, "purpose");
        if (accessToken.isBlank() || accessToken.chars().anyMatch(Character::isWhitespace) || purpose.isBlank()) {
            throw new IllegalArgumentException("access token and purpose cannot be blank");
        }
    }
}
