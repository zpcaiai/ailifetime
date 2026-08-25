package com.ailifetime.sdk;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

public final class LifeTimeMachineClient {
    private static final Pattern BATCH_ID = Pattern.compile("B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])");
    private static final Pattern OPERATION = Pattern.compile("[a-z][A-Za-z0-9.-]*");
    private static final int DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final Duration DEFAULT_MAX_RETRY_DELAY = Duration.ofSeconds(5);
    private static final Duration MAX_TIMEOUT = Duration.ofSeconds(120);

    private final URI baseUri;
    private final ClientSession session;
    private final Duration timeout;
    private final int maxRetries;
    private final int maxResponseBytes;
    private final Duration maxRetryDelay;
    private final HttpClient http;

    public LifeTimeMachineClient(URI baseUri, ClientSession session, Duration timeout, int maxRetries) {
        this(baseUri, session, timeout, maxRetries, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RETRY_DELAY);
    }

    public LifeTimeMachineClient(
        URI baseUri,
        ClientSession session,
        Duration timeout,
        int maxRetries,
        int maxResponseBytes,
        Duration maxRetryDelay
    ) {
        this.baseUri = validateBaseUri(Objects.requireNonNull(baseUri, "baseUri"));
        this.session = Objects.requireNonNull(session, "session");
        this.timeout = Objects.requireNonNull(timeout, "timeout");
        this.maxRetries = maxRetries;
        this.maxResponseBytes = maxResponseBytes;
        this.maxRetryDelay = Objects.requireNonNull(maxRetryDelay, "maxRetryDelay");
        if (timeout.isNegative() || timeout.isZero() || timeout.compareTo(MAX_TIMEOUT) > 0 || maxRetries < 0 || maxRetries > 5) {
            throw new IllegalArgumentException("invalid timeout or retry bound");
        }
        if (maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
            throw new IllegalArgumentException("maxResponseBytes must be from 1 through 16777216");
        }
        if (maxRetryDelay.isNegative() || maxRetryDelay.compareTo(Duration.ofSeconds(60)) > 0) {
            throw new IllegalArgumentException("maxRetryDelay must be from zero through 60 seconds");
        }
        this.http = HttpClient.newBuilder()
            .connectTimeout(timeout)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    }

    public String health() throws IOException, InterruptedException {
        return Json.stringify(send("/health/ready", "GET", null, null, true, Set.of(503)));
    }

    public AuthenticatedSessionResponse getSession() throws IOException, InterruptedException {
        AuthenticatedSessionResponse response = parseAuthenticatedSessionResponse(
            send("/v1/session", "GET", null, null, true, Set.of())
        );
        if (!session.purpose().equals(response.session().purpose())) {
            throw invalidResponse("authenticated session purpose does not match the request", response.requestId());
        }
        return response;
    }

    public VisibleCapabilityManifest getVisibleCapabilityManifest() throws IOException, InterruptedException {
        return parseVisibleCapabilityManifest(send("/v1/capabilities/visible", "GET", null, null, true, Set.of()));
    }

    public List<CapabilitySummary> listCapabilities() throws IOException, InterruptedException {
        return parseCapabilityCatalog(send("/v1/capabilities", "GET", null, null, true, Set.of()));
    }

    public String execute(String batchId, String jsonBody, String idempotencyKey) throws IOException, InterruptedException {
        return executeEnvelope(batchId, jsonBody, idempotencyKey).dataJson();
    }

    public DispatchEnvelope executeEnvelope(String batchId, String jsonBody, String idempotencyKey) throws IOException, InterruptedException {
        if (batchId == null || !BATCH_ID.matcher(batchId).matches()) {
            throw new IllegalArgumentException("batchId must be B00 through B127");
        }
        validateIdempotencyKey(idempotencyKey);
        Map<String, Object> input = parseInput(jsonBody);
        return dispatch("/v1/capabilities/" + batchId, Json.stringify(input), idempotencyKey, "batchId", batchId);
    }

    public String command(String command, String inputJson, String idempotencyKey) throws IOException, InterruptedException {
        return commandEnvelope(command, inputJson, idempotencyKey).dataJson();
    }

    public String grantConsent(ConsentGrantRequest input, String idempotencyKey) throws IOException, InterruptedException {
        Objects.requireNonNull(input, "input");
        Map<String, Object> scope = new LinkedHashMap<>();
        scope.put("resource", input.scope().resource());
        scope.put("actions", input.scope().actions());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("participantId", input.participantId());
        payload.put("grantorCapacity", input.grantorCapacity());
        payload.put("purpose", input.purpose());
        payload.put("scope", scope);
        payload.put("policyVersion", input.policyVersion());
        if (input.evidenceHash() != null) payload.put("evidenceHash", input.evidenceHash());
        if (input.id() != null) payload.put("id", input.id());
        if (input.expiresAt() != null) payload.put("expiresAt", input.expiresAt());
        return command("consent.grant", Json.stringify(payload), idempotencyKey);
    }

    public String submitRightsRequest(RightsRequestSubmission input, String idempotencyKey)
        throws IOException, InterruptedException {
        Objects.requireNonNull(input, "input");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("participantId", input.participantId());
        payload.put("requestType", input.requestType());
        payload.put("requestedProcessingPurpose", input.requestedProcessingPurpose());
        if (input.requestId() != null) payload.put("requestId", input.requestId());
        if (input.correctionFields() != null) payload.put("correctionFields", input.correctionFields());
        if (input.correctionPayloadSha256() != null) payload.put("correctionPayloadSha256", input.correctionPayloadSha256());
        if (input.parentRequestId() != null) payload.put("parentRequestId", input.parentRequestId());
        return command("rights-request.submit", Json.stringify(payload), idempotencyKey);
    }

    public String recordRightsTaskReceipt(RightsTaskReceiptRequest input, String idempotencyKey)
        throws IOException, InterruptedException {
        Objects.requireNonNull(input, "input");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", input.requestId());
        payload.put("taskId", input.taskId());
        payload.put("outcome", input.outcome());
        payload.put("resultSha256", input.resultSha256());
        payload.put("providerOccurredAt", input.providerOccurredAt());
        payload.put("evidenceId", input.evidenceId());
        if (input.errorCode() != null) payload.put("errorCode", input.errorCode());
        return command("rights-request.task-receipt", Json.stringify(payload), idempotencyKey);
    }

    public String reviewRightsRequest(RightsReviewRequest input, String idempotencyKey)
        throws IOException, InterruptedException {
        Objects.requireNonNull(input, "input");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", input.requestId());
        payload.put("decision", input.decision());
        payload.put("reasonCode", input.reasonCode());
        payload.put("caseReference", input.caseReference());
        return command("rights-request.review", Json.stringify(payload), idempotencyKey);
    }

    public String escalateRightsRequest(String requestId, String reasonCode, String idempotencyKey)
        throws IOException, InterruptedException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", requestId);
        payload.put("reasonCode", reasonCode);
        return command("rights-request.escalate", Json.stringify(payload), idempotencyKey);
    }

    public String getRightsRequest(String requestId) throws IOException, InterruptedException {
        return query("rights-request.get", Json.stringify(Map.of("requestId", requestId)));
    }

    public String listRightsRequests(Integer limit, String cursor) throws IOException, InterruptedException {
        Map<String, Object> payload = new LinkedHashMap<>();
        if (limit != null) payload.put("limit", limit);
        if (cursor != null) payload.put("cursor", cursor);
        return query("rights-request.list", Json.stringify(payload));
    }

    public DispatchEnvelope commandEnvelope(String command, String inputJson, String idempotencyKey) throws IOException, InterruptedException {
        validateOperation(command, "command");
        validateIdempotencyKey(idempotencyKey);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("command", command);
        request.put("input", parseInput(inputJson));
        return dispatch("/v1/commands", Json.stringify(request), idempotencyKey, "command", command);
    }

    public String query(String query, String inputJson) throws IOException, InterruptedException {
        return queryEnvelope(query, inputJson).dataJson();
    }

    public DispatchEnvelope queryEnvelope(String query, String inputJson) throws IOException, InterruptedException {
        validateOperation(query, "query");
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("query", query);
        request.put("input", parseInput(inputJson));
        return dispatch("/v1/queries", Json.stringify(request), null, "query", query);
    }

    private DispatchEnvelope dispatch(
        String path,
        String jsonBody,
        String idempotencyKey,
        String expectedField,
        String expectedValue
    ) throws IOException, InterruptedException {
        Map<String, Object> response = send(path, "POST", jsonBody, idempotencyKey, true, Set.of());
        if (!response.containsKey("data") || !(response.get("meta") instanceof Map<?, ?> rawMeta)) {
            throw invalidResponse("dispatch response must contain data and meta", null);
        }
        Map<String, Object> meta = stringMap(rawMeta);
        String requestId = requiredString(meta.get("requestId"), "dispatch meta.requestId", null);
        if (!expectedValue.equals(meta.get(expectedField))) {
            throw invalidResponse("dispatch meta." + expectedField + " does not match the request", requestId);
        }
        DispatchMeta dispatchMeta = new DispatchMeta(
            requestId,
            optionalString(meta, "batchId", requestId),
            optionalString(meta, "command", requestId),
            optionalString(meta, "query", requestId)
        );
        return new DispatchEnvelope(Json.stringify(response.get("data")), dispatchMeta);
    }

    private static AuthenticatedSessionResponse parseAuthenticatedSessionResponse(Map<String, Object> response) {
        assertOnlyKeys(response, Set.of("session", "requestId"), "authenticated session response", null);
        String requestId = boundedResponseString(response.get("requestId"), "session requestId", 512, null);
        Map<String, Object> value = requiredObject(response.get("session"), "authenticated session response is missing session", requestId);
        assertOnlyKeys(
            value,
            Set.of("actorId", "tenantId", "roles", "purpose", "stepUp", "guardianVerified", "authenticationState"),
            "authenticated session",
            requestId
        );
        if (!(value.get("roles") instanceof List<?> rawRoles) || rawRoles.isEmpty() || rawRoles.size() > AuthenticatedRole.values().length) {
            throw invalidResponse("authenticated session roles are invalid", requestId);
        }
        List<AuthenticatedRole> roles = new ArrayList<>();
        for (Object item : rawRoles) {
            String wireValue = boundedResponseString(item, "authenticated session role", 40, requestId);
            try {
                roles.add(AuthenticatedRole.fromWire(wireValue));
            } catch (IllegalArgumentException error) {
                throw invalidResponse("authenticated session contains an unknown role", requestId);
            }
        }
        assertUnique(roles, "authenticated session roles", requestId);
        if (!"server_verified".equals(value.get("authenticationState"))) {
            throw invalidResponse("authenticated session is not server verified", requestId);
        }
        boolean stepUp = requiredBoolean(value.get("stepUp"), "authenticated session stepUp", requestId);
        boolean guardianVerified = requiredBoolean(value.get("guardianVerified"), "authenticated session guardianVerified", requestId);
        AuthenticatedSession authenticated = new AuthenticatedSession(
            boundedResponseString(value.get("actorId"), "session actorId", 512, requestId),
            boundedResponseString(value.get("tenantId"), "session tenantId", 512, requestId),
            roles,
            boundedResponseString(value.get("purpose"), "session purpose", 120, requestId),
            stepUp,
            guardianVerified,
            "server_verified"
        );
        return new AuthenticatedSessionResponse(authenticated, requestId);
    }

    private static VisibleCapabilityManifest parseVisibleCapabilityManifest(Map<String, Object> response) {
        assertOnlyKeys(response, Set.of("schemaVersion", "capabilities", "portals", "count", "requestId"), "visible capability manifest", null);
        String requestId = boundedResponseString(response.get("requestId"), "visible manifest requestId", 512, null);
        if (!"ltm.visible-capability-manifest.v1".equals(response.get("schemaVersion"))) {
            throw invalidResponse("visible capability manifest schema version is unsupported", requestId);
        }
        if (!(response.get("capabilities") instanceof List<?> rawCapabilities) || rawCapabilities.size() > 128) {
            throw invalidResponse("visible capability manifest capabilities are invalid", requestId);
        }
        if (!(response.get("portals") instanceof List<?> rawPortals) || rawPortals.size() > CapabilityPortalId.values().length) {
            throw invalidResponse("visible capability manifest portals are invalid", requestId);
        }
        int count = boundedInteger(response.get("count"), "visible capability manifest count", 0, 128, requestId);
        List<CapabilitySummary> capabilities = new ArrayList<>();
        for (int index = 0; index < rawCapabilities.size(); index++) {
            capabilities.add(parseCapabilitySummary(rawCapabilities.get(index), "capabilities[" + index + "]", requestId));
        }
        List<VisibleCapabilityPortal> portals = new ArrayList<>();
        for (int index = 0; index < rawPortals.size(); index++) {
            portals.add(parseVisiblePortal(rawPortals.get(index), "portals[" + index + "]", requestId));
        }
        if (count != capabilities.size()) throw invalidResponse("visible capability manifest count is inconsistent", requestId);
        assertUnique(capabilities.stream().map(CapabilitySummary::batchId).toList(), "visible capability batch identifiers", requestId);
        assertUnique(portals.stream().map(VisibleCapabilityPortal::id).toList(), "visible capability portal identifiers", requestId);
        for (VisibleCapabilityPortal portal : portals) {
            List<CapabilitySummary> projected = capabilities.stream().filter(item -> item.portalId() == portal.id()).toList();
            if (projected.size() != portal.capabilityCount()) {
                throw invalidResponse("visible portal " + portal.id().wireValue() + " capability count is inconsistent", requestId);
            }
            Set<String> projectedSkills = new HashSet<>(projected.stream().map(CapabilitySummary::skill).toList());
            if (portal.skills().stream().anyMatch(skill -> !projectedSkills.contains(skill))
                || projected.stream().anyMatch(item -> !portal.skills().contains(item.skill()))) {
                throw invalidResponse("visible portal " + portal.id().wireValue() + " skills are inconsistent", requestId);
            }
        }
        Set<CapabilityPortalId> portalIds = new HashSet<>(portals.stream().map(VisibleCapabilityPortal::id).toList());
        if (capabilities.stream().anyMatch(item -> !portalIds.contains(item.portalId()))) {
            throw invalidResponse("visible capability references a missing portal", requestId);
        }
        return new VisibleCapabilityManifest("ltm.visible-capability-manifest.v1", capabilities, portals, count, requestId);
    }

    private static List<CapabilitySummary> parseCapabilityCatalog(Map<String, Object> response) {
        assertOnlyKeys(response, Set.of("capabilities", "count", "requestId"), "capability catalog response", null);
        String requestId = boundedResponseString(response.get("requestId"), "capability catalog requestId", 512, null);
        if (!(response.get("capabilities") instanceof List<?> rawCapabilities) || rawCapabilities.size() > 128) {
            throw invalidResponse("capability catalog capabilities are invalid", requestId);
        }
        int count = boundedInteger(response.get("count"), "capability catalog count", 0, 128, requestId);
        if (count != rawCapabilities.size()) throw invalidResponse("capability catalog count is inconsistent", requestId);
        List<CapabilitySummary> capabilities = new ArrayList<>();
        for (int index = 0; index < rawCapabilities.size(); index++) {
            capabilities.add(parseCapabilitySummary(rawCapabilities.get(index), "capabilities[" + index + "]", requestId));
        }
        assertUnique(capabilities.stream().map(CapabilitySummary::batchId).toList(), "capability batch identifiers", requestId);
        return List.copyOf(capabilities);
    }

    private static CapabilitySummary parseCapabilitySummary(Object raw, String label, String requestId) {
        Map<String, Object> value = requiredObject(raw, label + " must be an object", requestId);
        assertOnlyKeys(
            value,
            Set.of("batchId", "skill", "operation", "permission", "portalId", "mode", "requirements", "requiresExternalEvidence"),
            label,
            requestId
        );
        String batchId = boundedResponseString(value.get("batchId"), label + ".batchId", 4, requestId);
        if (!BATCH_ID.matcher(batchId).matches()) throw invalidResponse(label + ".batchId is invalid", requestId);
        String operation = boundedResponseString(value.get("operation"), label + ".operation", 160, requestId);
        if (!OPERATION.matcher(operation).matches()) throw invalidResponse(label + ".operation is invalid", requestId);
        CapabilityPortalId portalId;
        CapabilityMode mode;
        try {
            portalId = CapabilityPortalId.fromWire(boundedResponseString(value.get("portalId"), label + ".portalId", 32, requestId));
            mode = CapabilityMode.fromWire(boundedResponseString(value.get("mode"), label + ".mode", 40, requestId));
        } catch (IllegalArgumentException error) {
            throw invalidResponse(label + " has an unknown portal or mode", requestId);
        }
        if (!(value.get("requirements") instanceof List<?> rawRequirements) || rawRequirements.size() != 5) {
            throw invalidResponse(label + ".requirements must contain exactly five entries", requestId);
        }
        List<String> requirements = new ArrayList<>();
        for (int index = 0; index < rawRequirements.size(); index++) {
            requirements.add(boundedResponseString(rawRequirements.get(index), label + ".requirements[" + index + "]", 1024, requestId));
        }
        boolean external = requiredBoolean(value.get("requiresExternalEvidence"), label + ".requiresExternalEvidence", requestId);
        return new CapabilitySummary(
            batchId,
            boundedResponseString(value.get("skill"), label + ".skill", 256, requestId),
            operation,
            boundedResponseString(value.get("permission"), label + ".permission", 160, requestId),
            portalId,
            mode,
            requirements,
            external
        );
    }

    private static VisibleCapabilityPortal parseVisiblePortal(Object raw, String label, String requestId) {
        Map<String, Object> value = requiredObject(raw, label + " must be an object", requestId);
        assertOnlyKeys(value, Set.of("id", "skills", "capabilityCount"), label, requestId);
        CapabilityPortalId id;
        try {
            id = CapabilityPortalId.fromWire(boundedResponseString(value.get("id"), label + ".id", 32, requestId));
        } catch (IllegalArgumentException error) {
            throw invalidResponse(label + ".id is invalid", requestId);
        }
        if (!(value.get("skills") instanceof List<?> rawSkills) || rawSkills.isEmpty() || rawSkills.size() > 22) {
            throw invalidResponse(label + ".skills are invalid", requestId);
        }
        List<String> skills = new ArrayList<>();
        for (int index = 0; index < rawSkills.size(); index++) {
            skills.add(boundedResponseString(rawSkills.get(index), label + ".skills[" + index + "]", 256, requestId));
        }
        assertUnique(skills, label + ".skills", requestId);
        int capabilityCount = boundedInteger(value.get("capabilityCount"), label + ".capabilityCount", 1, 128, requestId);
        return new VisibleCapabilityPortal(id, skills, capabilityCount);
    }

    private static Map<String, Object> requiredObject(Object value, String message, String requestId) {
        if (!(value instanceof Map<?, ?> raw)) throw invalidResponse(message, requestId);
        return stringMap(raw);
    }

    private static void assertOnlyKeys(Map<String, Object> value, Set<String> allowed, String label, String requestId) {
        if (value.keySet().stream().anyMatch(key -> !allowed.contains(key))) {
            throw invalidResponse(label + " contains an unknown field", requestId);
        }
    }

    private static String boundedResponseString(Object value, String label, int maximum, String requestId) {
        if (!(value instanceof String string)
            || string.isEmpty()
            || string.length() > maximum
            || !string.equals(string.trim())
            || hasControl(string)) {
            throw invalidResponse(label + " must be a bounded non-empty string", requestId);
        }
        return string;
    }

    private static boolean requiredBoolean(Object value, String label, String requestId) {
        if (!(value instanceof Boolean bool)) throw invalidResponse(label + " must be boolean", requestId);
        return bool;
    }

    private static int boundedInteger(Object value, String label, int minimum, int maximum, String requestId) {
        if (!(value instanceof BigDecimal decimal)) throw invalidResponse(label + " must be an integer", requestId);
        try {
            int result = decimal.intValueExact();
            if (result < minimum || result > maximum) throw invalidResponse(label + " is outside allowed bounds", requestId);
            return result;
        } catch (ArithmeticException error) {
            throw invalidResponse(label + " must be an integer", requestId);
        }
    }

    private static void assertUnique(List<?> values, String label, String requestId) {
        if (new HashSet<>(values).size() != values.size()) throw invalidResponse(label + " must be unique", requestId);
    }

    private Map<String, Object> send(
        String path,
        String method,
        String jsonBody,
        String idempotencyKey,
        boolean retrySafe,
        Set<Integer> acceptedStatuses
    ) throws IOException, InterruptedException {
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest.Builder builder = HttpRequest.newBuilder(baseUri.resolve(path))
                    .timeout(timeout)
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + session.accessToken())
                    .header("X-Purpose", session.purpose())
                    .header("X-Sdk-Version", "java/1.0.0");
                if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
                if ("POST".equals(method)) {
                    builder.header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(Objects.requireNonNull(jsonBody), StandardCharsets.UTF_8));
                } else {
                    builder.GET();
                }
                HttpResponse<InputStream> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
                String responseBody;
                try (InputStream stream = response.body()) {
                    responseBody = readBounded(stream, response.headers(), maxResponseBytes);
                }
                Map<String, Object> body = parseResponse(responseBody);
                int status = response.statusCode();
                if ((status >= 200 && status < 300) || acceptedStatuses.contains(status)) return body;
                ApiException error = parseError(status, body, response.headers());
                if (retrySafe && attempt < maxRetries && isRetryableStatus(status) && error.retryable()) {
                    sleep(retryDelay(response.headers(), attempt));
                    continue;
                }
                throw error;
            } catch (HttpTimeoutException error) {
                if (retrySafe && attempt < maxRetries) {
                    sleep(retryDelay(null, attempt));
                    continue;
                }
                throw new TransportException("REQUEST_TIMEOUT", "request timed out", error);
            } catch (IOException error) {
                if (error instanceof TransportException) throw error;
                if (retrySafe && attempt < maxRetries) {
                    sleep(retryDelay(null, attempt));
                    continue;
                }
                throw new TransportException("NETWORK_ERROR", "network request failed", error);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw error;
            }
        }
        throw new IllegalStateException("bounded retry loop ended unexpectedly");
    }

    private static URI validateBaseUri(URI value) {
        String scheme = value.getScheme() == null ? "" : value.getScheme().toLowerCase(Locale.ROOT);
        if (!value.isAbsolute() || !("http".equals(scheme) || "https".equals(scheme)) || value.getHost() == null) {
            throw new IllegalArgumentException("baseUri must use HTTP or HTTPS");
        }
        if (value.getRawUserInfo() != null) throw new IllegalArgumentException("baseUri must not contain credentials");
        if (value.getRawQuery() != null || value.getRawFragment() != null) {
            throw new IllegalArgumentException("baseUri must not contain a query or fragment");
        }
        if (!value.getPath().isEmpty() && !"/".equals(value.getPath())) {
            throw new IllegalArgumentException("baseUri must identify an origin without a path");
        }
        if ("http".equals(scheme) && !isLoopback(value.getHost())) {
            throw new IllegalArgumentException("unencrypted HTTP is permitted only for loopback development endpoints");
        }
        String authority = value.getRawAuthority();
        return URI.create(scheme + "://" + authority);
    }

    private static boolean isLoopback(String rawHost) {
        String host = rawHost.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if ("localhost".equals(host) || "::1".equals(host) || "0:0:0:0:0:0:0:1".equals(host)) return true;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4 || !"127".equals(parts[0])) return false;
        for (String part : parts) {
            try {
                if (part.isEmpty() || Integer.parseInt(part) > 255) return false;
            } catch (NumberFormatException error) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, Object> parseInput(String jsonBody) {
        Objects.requireNonNull(jsonBody, "jsonBody");
        if (jsonBody.getBytes(StandardCharsets.UTF_8).length > DEFAULT_MAX_RESPONSE_BYTES) {
            throw new IllegalArgumentException("request JSON exceeds 2097152 bytes");
        }
        try {
            return Json.parseObject(jsonBody);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("input must be a valid JSON object", error);
        }
    }

    private static Map<String, Object> parseResponse(String body) {
        try {
            return Json.parseObject(body);
        } catch (IllegalArgumentException error) {
            throw invalidResponse("server returned malformed JSON", null);
        }
    }

    private static ApiException parseError(int status, Map<String, Object> body, HttpHeaders headers) {
        if (!(body.get("error") instanceof Map<?, ?> rawError)) throw invalidResponse("error response is missing error", null);
        Map<String, Object> error = stringMap(rawError);
        String requestId = requiredString(body.get("requestId"), "error requestId", null);
        String headerRequestId = headers.firstValue("x-request-id").orElse(null);
        if (headerRequestId != null && !headerRequestId.equals(requestId)) {
            throw invalidResponse("response request identifiers do not match", requestId);
        }
        if (!(error.get("retryable") instanceof Boolean retryable) || !(error.get("details") instanceof Map<?, ?> details)) {
            throw invalidResponse("error response has invalid retryable or details fields", requestId);
        }
        return new ApiException(
            status,
            requiredString(error.get("code"), "error code", requestId),
            requiredString(error.get("message"), "error message", requestId),
            requestId,
            retryable,
            Json.stringify(details)
        );
    }

    private static String readBounded(InputStream stream, HttpHeaders headers, int maximum) throws IOException {
        long declared = headers.firstValueAsLong("content-length").orElse(-1);
        if (declared > maximum) throw invalidResponse("response body exceeds maxResponseBytes", null);
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maximum, 8192));
        byte[] buffer = new byte[8192];
        int total = 0;
        while (true) {
            int read = stream.read(buffer);
            if (read < 0) break;
            total += read;
            if (total > maximum) throw invalidResponse("response body exceeds maxResponseBytes", null);
            output.write(buffer, 0, read);
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(output.toByteArray()))
                .toString();
        } catch (CharacterCodingException error) {
            throw invalidResponse("server returned malformed UTF-8", null);
        }
    }

    private long retryDelay(HttpHeaders headers, int attempt) {
        long requested = 25L << attempt;
        String retryAfter = headers == null ? null : headers.firstValue("retry-after").orElse(null);
        if (retryAfter != null) {
            try {
                double seconds = Double.parseDouble(retryAfter);
                if (Double.isFinite(seconds) && seconds >= 0) requested = (long) Math.ceil(seconds * 1000);
            } catch (NumberFormatException ignored) {
                try {
                    long target = ZonedDateTime.parse(retryAfter, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli();
                    requested = Math.max(0, target - System.currentTimeMillis());
                } catch (DateTimeParseException ignoredDate) {
                    // Use bounded exponential backoff for malformed Retry-After.
                }
            }
        }
        return Math.min(maxRetryDelay.toMillis(), Math.max(0, requested));
    }

    private static void sleep(long milliseconds) throws InterruptedException {
        if (milliseconds > 0) Thread.sleep(milliseconds);
    }

    private static void validateOperation(String value, String label) {
        if (value == null || value.length() > 160 || !OPERATION.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must be a bounded operation name");
        }
    }

    private static void validateIdempotencyKey(String value) {
        if (value == null || value.isBlank() || value.length() > 200 || !value.equals(value.trim()) || hasControl(value)) {
            throw new IllegalArgumentException("a bounded idempotency key is required");
        }
    }

    private static boolean hasControl(String value) {
        return value.chars().anyMatch(character -> character < 32 || character == 127);
    }

    private static boolean isRetryableStatus(int status) {
        return status == 429 || status >= 500;
    }

    private static ApiException invalidResponse(String message, String requestId) {
        return new ApiException(502, "INVALID_RESPONSE", message, requestId, false, "{}");
    }

    private static String requiredString(Object value, String label, String requestId) {
        if (!(value instanceof String string) || string.isEmpty()) throw invalidResponse(label + " must be a non-empty string", requestId);
        return string;
    }

    private static String optionalString(Map<String, Object> value, String field, String requestId) {
        Object item = value.get(field);
        if (item == null) return null;
        if (!(item instanceof String string)) throw invalidResponse("dispatch meta." + field + " must be a string", requestId);
        return string;
    }

    private static Map<String, Object> stringMap(Map<?, ?> raw) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) result.put((String) entry.getKey(), entry.getValue());
        return result;
    }
}
