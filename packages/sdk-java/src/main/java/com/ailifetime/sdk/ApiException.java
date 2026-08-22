package com.ailifetime.sdk;

public final class ApiException extends RuntimeException {
    private static final long serialVersionUID = 1L;
    private final int status;
    private final String code;
    private final String requestId;
    private final boolean retryable;
    private final String detailsJson;

    public ApiException(int status, String code, String message, String requestId, boolean retryable, String detailsJson) {
        super(message);
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        this.retryable = retryable;
        this.detailsJson = detailsJson;
    }

    public int status() { return status; }
    public String code() { return code; }
    public String requestId() { return requestId; }
    public boolean retryable() { return retryable; }
    public String detailsJson() { return detailsJson; }
}
