package com.ailifetime.sdk;

public enum CapabilityPortalId {
    CONSUMER("consumer"),
    FAMILY("family"),
    PARTNER("partner"),
    STUDIO("studio"),
    OPERATIONS("operations"),
    SUPPORT("support"),
    DEVELOPER("developer");

    private final String wireValue;

    CapabilityPortalId(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    static CapabilityPortalId fromWire(String value) {
        for (CapabilityPortalId portal : values()) if (portal.wireValue.equals(value)) return portal;
        throw new IllegalArgumentException("unknown capability portal");
    }
}
