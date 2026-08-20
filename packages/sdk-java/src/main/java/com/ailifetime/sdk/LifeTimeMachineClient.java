package com.ailifetime.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Objects;
import java.util.regex.Pattern;

public final class LifeTimeMachineClient {
    private static final Pattern BATCH_ID = Pattern.compile("B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])");
    private final URI baseUri;
    private final ClientSession session;
    private final Duration timeout;
    private final int maxRetries;
    private final HttpClient http;

    public LifeTimeMachineClient(URI baseUri, ClientSession session, Duration timeout, int maxRetries) {
        this.baseUri = Objects.requireNonNull(baseUri, "baseUri");
        this.session = Objects.requireNonNull(session, "session");
        this.timeout = Objects.requireNonNull(timeout, "timeout");
        this.maxRetries = maxRetries;
        if (!("http".equals(baseUri.getScheme()) || "https".equals(baseUri.getScheme()))) {
            throw new IllegalArgumentException("baseUri must use HTTP or HTTPS");
        }
        if (timeout.isNegative() || timeout.isZero() || maxRetries < 0 || maxRetries > 5) {
            throw new IllegalArgumentException("invalid timeout or retry bound");
        }
        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    public String health() throws IOException, InterruptedException {
        return send("/health/ready", "GET", null, null);
    }

    public String listCapabilities() throws IOException, InterruptedException {
        return send("/v1/capabilities", "GET", null, null);
    }

    public String execute(String batchId, String jsonBody, String idempotencyKey) throws IOException, InterruptedException {
        if (!BATCH_ID.matcher(batchId).matches()) throw new IllegalArgumentException("batchId must be B00 through B127");
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 128) {
            throw new IllegalArgumentException("a bounded idempotency key is required");
        }
        return send("/v1/capabilities/" + batchId, "POST", Objects.requireNonNull(jsonBody, "jsonBody"), idempotencyKey);
    }

    private String send(String path, String method, String jsonBody, String idempotencyKey) throws IOException, InterruptedException {
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            HttpRequest.Builder builder = HttpRequest.newBuilder(baseUri.resolve(path)).timeout(timeout)
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + session.accessToken())
                .header("X-Purpose", session.purpose())
                .header("X-Sdk-Version", "java/1.0.0");
            if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
            if ("POST".equals(method)) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(jsonBody));
            else builder.GET();
            HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) return response.body();
            boolean transientFailure = response.statusCode() == 429 || response.statusCode() >= 500;
            if (!transientFailure || attempt == maxRetries) throw new ApiException(response.statusCode(), response.body());
            Thread.sleep(25L << attempt);
        }
        throw new IllegalStateException("bounded retry loop ended unexpectedly");
    }
}
