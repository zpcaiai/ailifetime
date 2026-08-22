package com.ailifetime.sdk;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

public final class ContractTest {
    private static final ClientSession SESSION = new ClientSession("synthetic-access-token", "product_operation");
    private final List<CapturedRequest> requests = new ArrayList<>();
    private final AtomicInteger retryAttempts = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        ContractTest test = new ContractTest();
        test.run();
        System.out.println("Java SDK contract tests: 7 passed");
    }

    private void run() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
        URI baseUri = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        try {
            exactRealHttpContract(baseUri);
            secureBaseUris();
            malformedAndOversizedResponses(baseUri);
            structuredError(baseUri);
            boundedRetryAfter(baseUri);
            timeoutAndIoAreTyped(baseUri);
            missingIdempotencyNeverReachesNetwork(baseUri);
        } finally {
            server.stop(0);
        }
    }

    private void exactRealHttpContract(URI baseUri) throws Exception {
        requests.clear();
        LifeTimeMachineClient client = new LifeTimeMachineClient(baseUri, SESSION, Duration.ofSeconds(2), 0);
        assertEquals("{\"id\":\"timeline-1\"}", client.execute("B14", "{\"targetAges\":[25,50]}", "idem-execute-1"));
        assertEquals("{\"id\":\"record-1\"}", client.command("record.create", "{\"collection\":\"projects\",\"data\":{}}", "idem-command-1"));
        DispatchEnvelope envelope = client.queryEnvelope("record.list", "{\"collection\":\"projects\"}");
        assertEquals("[{\"id\":\"record-1\"}]", envelope.dataJson());
        assertEquals("req-query", envelope.meta().requestId());
        assertEquals(3, requests.size());
        assertEquals("/v1/capabilities/B14", requests.get(0).path());
        assertEquals("{\"targetAges\":[25,50]}", requests.get(0).body());
        assertEquals("{\"command\":\"record.create\",\"input\":{\"collection\":\"projects\",\"data\":{}}}", requests.get(1).body());
        assertEquals("{\"query\":\"record.list\",\"input\":{\"collection\":\"projects\"}}", requests.get(2).body());
        for (CapturedRequest request : requests) {
            assertEquals("Bearer synthetic-access-token", request.authorization());
            assertEquals("product_operation", request.purpose());
            assertEquals(null, request.tenant());
            assertEquals(null, request.actor());
            assertEquals(null, request.role());
        }
        assertEquals("idem-execute-1", requests.get(0).idempotencyKey());
        assertEquals("idem-command-1", requests.get(1).idempotencyKey());
        assertEquals(null, requests.get(2).idempotencyKey());
    }

    private void secureBaseUris() {
        for (String value : List.of(
            "http://example.com",
            "http://10.0.0.1:8080",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com#fragment",
            "https://example.com/api"
        )) {
            assertThrows(IllegalArgumentException.class, () -> new LifeTimeMachineClient(URI.create(value), SESSION, Duration.ofSeconds(1), 0));
        }
        new LifeTimeMachineClient(URI.create("http://127.9.8.7:8080"), SESSION, Duration.ofSeconds(1), 0);
        new LifeTimeMachineClient(URI.create("http://[::1]:8080"), SESSION, Duration.ofSeconds(1), 0);
        new LifeTimeMachineClient(URI.create("https://api.example.com"), SESSION, Duration.ofSeconds(1), 0);
    }

    private void malformedAndOversizedResponses(URI baseUri) throws Exception {
        LifeTimeMachineClient client = new LifeTimeMachineClient(baseUri, SESSION, Duration.ofSeconds(2), 0);
        ApiException malformed = assertThrows(ApiException.class, () -> client.command("malformed.operation", "{}", "idem-malformed-1"));
        assertEquals(502, malformed.status());
        assertEquals("INVALID_RESPONSE", malformed.code());

        LifeTimeMachineClient bounded = new LifeTimeMachineClient(
            baseUri, SESSION, Duration.ofSeconds(2), 0, 32, Duration.ZERO
        );
        ApiException oversized = assertThrows(ApiException.class, () -> bounded.command("large.operation", "{}", "idem-large-1"));
        assertEquals("INVALID_RESPONSE", oversized.code());
    }

    private void structuredError(URI baseUri) throws Exception {
        LifeTimeMachineClient client = new LifeTimeMachineClient(baseUri, SESSION, Duration.ofSeconds(2), 0);
        ApiException error = assertThrows(ApiException.class, () -> client.command("error.operation", "{}", "idem-error-1"));
        assertEquals(403, error.status());
        assertEquals("CONSENT_REQUIRED", error.code());
        assertEquals("req-error-1", error.requestId());
        assertEquals("{\"participantId\":\"p-1\"}", error.detailsJson());
    }

    private void boundedRetryAfter(URI baseUri) throws Exception {
        retryAttempts.set(0);
        long started = System.nanoTime();
        LifeTimeMachineClient client = new LifeTimeMachineClient(
            baseUri, SESSION, Duration.ofSeconds(2), 1, 2048, Duration.ofMillis(2)
        );
        assertEquals("{\"id\":\"record-2\"}", client.command("retry.operation", "{}", "idem-retry-1"));
        assertEquals(2, retryAttempts.get());
        assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 500, "Retry-After must be capped");
        List<CapturedRequest> retryRequests = requests.stream().filter(request -> request.body().contains("retry.operation")).toList();
        assertEquals(2, retryRequests.size());
        assertEquals("idem-retry-1", retryRequests.get(0).idempotencyKey());
        assertEquals("idem-retry-1", retryRequests.get(1).idempotencyKey());
    }

    private void timeoutAndIoAreTyped(URI baseUri) throws Exception {
        LifeTimeMachineClient timeoutClient = new LifeTimeMachineClient(baseUri, SESSION, Duration.ofMillis(10), 0);
        TransportException timeout = assertThrows(TransportException.class, () -> timeoutClient.query("delay.operation", "{}"));
        assertEquals("REQUEST_TIMEOUT", timeout.code());

        int unusedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            unusedPort = socket.getLocalPort();
        }
        LifeTimeMachineClient ioClient = new LifeTimeMachineClient(
            URI.create("http://127.0.0.1:" + unusedPort), SESSION, Duration.ofMillis(100), 1, 2048, Duration.ZERO
        );
        TransportException io = assertThrows(TransportException.class, () -> ioClient.query("record.list", "{}"));
        assertEquals("NETWORK_ERROR", io.code());
    }

    private void missingIdempotencyNeverReachesNetwork(URI baseUri) {
        int before = requests.size();
        LifeTimeMachineClient client = new LifeTimeMachineClient(baseUri, SESSION, Duration.ofSeconds(1), 2);
        assertThrows(IllegalArgumentException.class, () -> client.command("record.create", "{}", ""));
        assertThrows(IllegalArgumentException.class, () -> client.execute("B14", "{}", "x".repeat(201)));
        assertEquals(before, requests.size());
    }

    private void handle(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        requests.add(new CapturedRequest(
            exchange.getRequestURI().getPath(),
            body,
            exchange.getRequestHeaders().getFirst("Authorization"),
            exchange.getRequestHeaders().getFirst("X-Purpose"),
            exchange.getRequestHeaders().getFirst("Idempotency-Key"),
            exchange.getRequestHeaders().getFirst("X-Tenant-Id"),
            exchange.getRequestHeaders().getFirst("X-Actor-Id"),
            exchange.getRequestHeaders().getFirst("X-Actor-Role")
        ));
        String path = exchange.getRequestURI().getPath();
        if ("/v1/capabilities/B14".equals(path)) {
            respond(exchange, 200, "{\"data\":{\"id\":\"timeline-1\"},\"meta\":{\"requestId\":\"req-execute\",\"batchId\":\"B14\"}}", "req-execute", null);
            return;
        }
        if ("/v1/queries".equals(path)) {
            if (body.contains("delay.operation")) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
            respond(exchange, 200, "{\"data\":[{\"id\":\"record-1\"}],\"meta\":{\"requestId\":\"req-query\",\"query\":" + (body.contains("delay.operation") ? "\"delay.operation\"" : "\"record.list\"") + "}}", null, null);
            return;
        }
        if (body.contains("malformed.operation")) {
            respond(exchange, 200, "{\"id\":\"not-an-envelope\"}", null, null);
        } else if (body.contains("large.operation")) {
            respond(exchange, 200, "{\"data\":\"" + "x".repeat(100) + "\",\"meta\":{\"requestId\":\"req-large\",\"command\":\"large.operation\"}}", null, null);
        } else if (body.contains("error.operation")) {
            respond(exchange, 403, "{\"error\":{\"code\":\"CONSENT_REQUIRED\",\"message\":\"missing\",\"retryable\":false,\"details\":{\"participantId\":\"p-1\"}},\"requestId\":\"req-error-1\"}", "req-error-1", null);
        } else if (body.contains("retry.operation") && retryAttempts.incrementAndGet() == 1) {
            respond(exchange, 429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"later\",\"retryable\":true,\"details\":{}},\"requestId\":\"req-rate-1\"}", null, "3600");
        } else if (body.contains("retry.operation")) {
            respond(exchange, 200, "{\"data\":{\"id\":\"record-2\"},\"meta\":{\"requestId\":\"req-rate-2\",\"command\":\"retry.operation\"}}", null, null);
        } else {
            respond(exchange, 200, "{\"data\":{\"id\":\"record-1\"},\"meta\":{\"requestId\":\"req-command\",\"command\":\"record.create\"}}", null, null);
        }
    }

    private static void respond(HttpExchange exchange, int status, String value, String requestId, String retryAfter) throws IOException {
        byte[] body = value.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        if (requestId != null) exchange.getResponseHeaders().set("X-Request-Id", requestId);
        if (retryAfter != null) exchange.getResponseHeaders().set("Retry-After", retryAfter);
        try {
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
        } finally {
            exchange.close();
        }
    }

    private static void assertEquals(Object expected, Object actual) {
        if (!java.util.Objects.equals(expected, actual)) {
            throw new AssertionError("expected " + expected + " but was " + actual);
        }
    }

    private static void assertTrue(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static <T extends Throwable> T assertThrows(Class<T> type, ThrowingRunnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) return type.cast(error);
            throw new AssertionError("expected " + type.getSimpleName() + " but caught " + error, error);
        }
        throw new AssertionError("expected " + type.getSimpleName());
    }

    private record CapturedRequest(
        String path,
        String body,
        String authorization,
        String purpose,
        String idempotencyKey,
        String tenant,
        String actor,
        String role
    ) {}

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
