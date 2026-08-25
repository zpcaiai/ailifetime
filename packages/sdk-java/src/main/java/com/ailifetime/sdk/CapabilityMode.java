package com.ailifetime.sdk;

public enum CapabilityMode {
    RESOURCE("resource"),
    STATE_TRANSITION("state-transition"),
    CONSENT_WRITE("consent-write"),
    LEDGER_POST("ledger-post"),
    PARTNER_SETTLEMENT_LEDGER("partner-settlement-ledger"),
    INBOX_EVENT("inbox-event"),
    EXTERNAL_COMMAND("external-command"),
    ATTESTATION("attestation");

    private final String wireValue;

    CapabilityMode(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    static CapabilityMode fromWire(String value) {
        for (CapabilityMode mode : values()) if (mode.wireValue.equals(value)) return mode;
        throw new IllegalArgumentException("unknown capability mode");
    }
}
