package com.ailifetime.sdk;

public final class ApiException extends RuntimeException {
    private final int status;
    private final String responseBody;

    public ApiException(int status, String responseBody) {
        super("AI Life Time Machine API request failed with status " + status);
        this.status = status;
        this.responseBody = responseBody;
    }

    public int status() { return status; }
    public String responseBody() { return responseBody; }
}
