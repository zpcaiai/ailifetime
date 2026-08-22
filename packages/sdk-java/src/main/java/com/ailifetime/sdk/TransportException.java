package com.ailifetime.sdk;

import java.io.IOException;

public final class TransportException extends IOException {
    private static final long serialVersionUID = 1L;
    private final String code;

    public TransportException(String code, String message, IOException cause) {
        super(message, cause);
        this.code = code;
    }

    public String code() { return code; }
}
