package com.ailifetime.sdk;

public enum AuthenticatedRole {
    CONSUMER("consumer"),
    HOUSEHOLD_ADMIN("household_admin"),
    GUARDIAN("guardian"),
    PARTNER_EMPLOYEE("partner_employee"),
    PARTNER_ADMIN("partner_admin"),
    STUDIO_OPERATOR("studio_operator"),
    SUPPORT_AGENT("support_agent"),
    MODERATOR("moderator"),
    PRIVACY_OFFICER("privacy_officer"),
    FINANCE_OPERATOR("finance_operator"),
    PLATFORM_ADMIN("platform_admin"),
    AUDITOR("auditor"),
    SERVICE_ACCOUNT("service_account");

    private final String wireValue;

    AuthenticatedRole(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    static AuthenticatedRole fromWire(String value) {
        for (AuthenticatedRole role : values()) if (role.wireValue.equals(value)) return role;
        throw new IllegalArgumentException("unknown authenticated role");
    }
}
