package com.ailifetime.sdk;

import java.util.Objects;

public record ClientSession(String accessToken, String purpose) {
    public ClientSession {
        Objects.requireNonNull(accessToken, "accessToken");
        Objects.requireNonNull(purpose, "purpose");
        if (accessToken.isBlank()
            || accessToken.length() > 8192
            || accessToken.chars().anyMatch(Character::isWhitespace)
            || purpose.isBlank()
            || purpose.length() > 120
            || purpose.chars().anyMatch(character -> character < 32 || character == 127)) {
            throw new IllegalArgumentException("access token and purpose cannot be blank");
        }
    }
}
