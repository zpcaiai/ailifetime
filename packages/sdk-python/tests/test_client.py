from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ailifetime_sdk import (
    ApiError,
    ClientSession,
    ConsentGrantRequest,
    ConsentScope,
    LifeTimeMachineClient,
    RightsRequestSubmission,
    RightsReviewRequest,
    TransportError,
)


class _ContractHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []
    logs: list[str] = []

    def do_GET(self) -> None:
        self.requests.append({"path": self.path, "headers": dict(self.headers.items()), "body": None})
        if self.path == "/v1/session":
            self._json({
                "session": {
                    "actorId": "actor-1",
                    "tenantId": "tenant-1",
                    "roles": ["consumer"],
                    "purpose": "product_operation",
                    "stepUp": False,
                    "guardianVerified": False,
                    "authenticationState": "server_verified",
                },
                "requestId": "req-session-1",
            })
        elif self.path == "/v1/capabilities/visible":
            self._json({
                "schemaVersion": "ltm.visible-capability-manifest.v1",
                "capabilities": [{
                    "batchId": "B14",
                    "skill": "building-age-media-pipeline",
                    "operation": "createTimeline",
                    "permission": "record:create",
                    "portalId": "consumer",
                    "mode": "external-command",
                    "requirements": ["B14-R01", "B14-R02", "B14-R03", "B14-R04", "B14-R05"],
                    "requiresExternalEvidence": False,
                }],
                "portals": [{
                    "id": "consumer",
                    "skills": ["building-age-media-pipeline"],
                    "capabilityCount": 1,
                }],
                "count": 1,
                "requestId": "req-visible-1",
            })
        elif self.path == "/v1/capabilities":
            self._json({
                "capabilities": [{
                    "batchId": "B14",
                    "skill": "building-age-media-pipeline",
                    "operation": "createTimeline",
                    "permission": "record:create",
                    "portalId": "consumer",
                    "mode": "external-command",
                    "requirements": ["B14-R01", "B14-R02", "B14-R03", "B14-R04", "B14-R05"],
                    "requiresExternalEvidence": False,
                }],
                "count": 1,
                "requestId": "req-catalog-1",
            })
        else:
            self._json({"error": {"code": "NOT_FOUND", "message": "missing", "retryable": False, "details": {}}, "requestId": "req-404"}, status=404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.requests.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
        if self.path == "/v1/capabilities/B14":
            self._json({"data": {"id": "timeline-1"}, "meta": {"requestId": "req-execute", "batchId": "B14"}}, "req-execute")
        elif self.path == "/v1/commands":
            command = body["command"]
            self._json({"data": {"id": "record-1"}, "meta": {"requestId": "req-command", "command": command}})
        elif self.path == "/v1/queries":
            self._json({"data": [{"id": "record-1"}], "meta": {"requestId": "req-query", "query": "record.list"}})
        else:
            self._json({"error": {"code": "NOT_FOUND", "message": "missing", "retryable": False, "details": {}}, "requestId": "req-404"}, status=404)

    def _json(self, value: object, request_id: str | None = None, status: int = 200) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if request_id:
            self.send_header("X-Request-Id", request_id)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        message = _format % _args if _args else _format
        self.logs.append(message)


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.session = ClientSession("synthetic-access-token", "product_operation")

    def test_typed_session_and_visible_manifest_validate_server_projection(self) -> None:
        _ContractHandler.requests = []
        server, base_url = self._server(_ContractHandler)
        try:
            client = LifeTimeMachineClient(base_url, self.session)
            authenticated = client.get_session()
            manifest = client.get_visible_capability_manifest()
            catalog = client.list_capabilities()
            self.assertEqual(authenticated.session.authentication_state, "server_verified")
            self.assertEqual(authenticated.session.roles, ("consumer",))
            self.assertEqual(manifest.schema_version, "ltm.visible-capability-manifest.v1")
            self.assertEqual(manifest.capabilities[0].operation, "createTimeline")
            self.assertEqual(manifest.portals[0].capability_count, 1)
            self.assertEqual(catalog[0].operation, "createTimeline")
            self.assertNotIsInstance(catalog[0], dict)
            self.assertEqual(
                [request["path"] for request in _ContractHandler.requests],
                ["/v1/session", "/v1/capabilities/visible", "/v1/capabilities"],
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_session_purpose_and_visible_manifest_cross_references_fail_closed(self) -> None:
        wrong_purpose = json.dumps({
            "session": {
                "actorId": "actor-1", "tenantId": "tenant-1", "roles": ["consumer"], "purpose": "wrong",
                "stepUp": False, "guardianVerified": False, "authenticationState": "server_verified",
            },
            "requestId": "req-session-bad",
        }).encode()
        client = LifeTimeMachineClient(
            "http://127.0.0.1:8080", self.session, max_retries=0,
            transport=lambda _request, _timeout, _maximum: (200, {}, wrong_purpose),
        )
        with self.assertRaises(ApiError) as caught:
            client.get_session()
        self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

    def test_catalog_is_typed_counted_and_closed(self) -> None:
        base = {
            "capabilities": [{
                "batchId": "B14", "skill": "building-age-media-pipeline", "operation": "createTimeline",
                "permission": "record:create", "portalId": "consumer", "mode": "external-command",
                "requirements": ["B14-R01", "B14-R02", "B14-R03", "B14-R04", "B14-R05"],
                "requiresExternalEvidence": False,
            }],
            "count": 1,
            "requestId": "req-catalog",
        }
        for mutation in ({"count": 2}, {"authority": "caller"}):
            body = json.dumps({**base, **mutation}).encode()
            client = LifeTimeMachineClient(
                "http://127.0.0.1:8080", self.session, max_retries=0,
                transport=lambda _request, _timeout, _maximum, body=body: (200, {}, body),
            )
            with self.assertRaises(ApiError) as caught:
                client.list_capabilities()
            self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

        invalid_manifest = json.dumps({
            "schemaVersion": "ltm.visible-capability-manifest.v1",
            "capabilities": [{
                "batchId": "B14", "skill": "building-age-media-pipeline", "operation": "createTimeline",
                "permission": "record:create", "portalId": "consumer", "mode": "external-command",
                "requirements": ["B14-R01", "B14-R02", "B14-R03", "B14-R04", "B14-R05"],
                "requiresExternalEvidence": False,
            }],
            "portals": [{"id": "consumer", "skills": ["building-age-media-pipeline"], "capabilityCount": 2}],
            "count": 1,
            "requestId": "req-visible-bad",
        }).encode()
        client = LifeTimeMachineClient(
            "http://127.0.0.1:8080", self.session, max_retries=0,
            transport=lambda _request, _timeout, _maximum: (200, {}, invalid_manifest),
        )
        with self.assertRaises(ApiError) as caught:
            client.get_visible_capability_manifest()
        self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

    def test_real_http_contract_sends_exact_envelopes_and_unwraps_data(self) -> None:
        _ContractHandler.requests = []
        server, base_url = self._server(_ContractHandler)
        try:
            client = LifeTimeMachineClient(base_url, self.session)
            self.assertEqual(client.execute("B14", {"targetAges": [25, 50]}, "idem-execute-1"), {"id": "timeline-1"})
            self.assertEqual(client.command("record.create", {"collection": "projects", "data": {}}, "idem-command-1"), {"id": "record-1"})
            envelope = client.query_envelope("record.list", {"collection": "projects"})
            self.assertEqual(envelope.data, [{"id": "record-1"}])
            self.assertEqual(envelope.meta.request_id, "req-query")

            requests = _ContractHandler.requests
            self.assertEqual([request["path"] for request in requests], ["/v1/capabilities/B14", "/v1/commands", "/v1/queries"])
            self.assertEqual(requests[0]["body"], {"targetAges": [25, 50]})
            self.assertEqual(requests[1]["body"], {"command": "record.create", "input": {"collection": "projects", "data": {}}})
            self.assertEqual(requests[2]["body"], {"query": "record.list", "input": {"collection": "projects"}})
            for request in requests:
                normalized = {key.lower(): value for key, value in request["headers"].items()}
                self.assertEqual(normalized["authorization"], "Bearer synthetic-access-token")
                self.assertEqual(normalized["x-purpose"], "product_operation")
                self.assertNotIn("x-tenant-id", normalized)
                self.assertNotIn("x-actor-id", normalized)
                self.assertNotIn("x-actor-role", normalized)
                self.assertNotIn("x-permissions", normalized)
            self.assertEqual({key.lower(): value for key, value in requests[0]["headers"].items()}["idempotency-key"], "idem-execute-1")
            self.assertNotIn("idempotency-key", {key.lower(): value for key, value in requests[2]["headers"].items()})
        finally:
            server.shutdown()
            server.server_close()

    def test_typed_consent_grant_omits_client_location_and_optional_evidence(self) -> None:
        _ContractHandler.requests = []
        server, base_url = self._server(_ContractHandler)
        try:
            client = LifeTimeMachineClient(base_url, self.session)
            client.grant_consent(
                ConsentGrantRequest(
                    participant_id="participant-1",
                    grantor_capacity="self",
                    purpose="sharing",
                    scope=ConsentScope(resource="work:work-1", actions=("share",)),
                    policy_version="sharing-v1",
                ),
                "idem-consent-1",
            )
            request = _ContractHandler.requests[0]
            self.assertEqual(request["path"], "/v1/commands")
            self.assertEqual(request["body"], {
                "command": "consent.grant",
                "input": {
                    "participantId": "participant-1",
                    "grantorCapacity": "self",
                    "purpose": "sharing",
                    "scope": {"resource": "work:work-1", "actions": ["share"]},
                    "policyVersion": "sharing-v1",
                    "expiresAt": None,
                },
            })
            self.assertNotIn("jurisdiction", request["body"]["input"])
            self.assertNotIn("locale", request["body"]["input"])
            self.assertNotIn("evidenceHash", request["body"]["input"])
        finally:
            server.shutdown()
            server.server_close()

    def test_typed_rights_requests_emit_closed_subject_and_review_inputs(self) -> None:
        _ContractHandler.requests = []
        server, base_url = self._server(_ContractHandler)
        try:
            client = LifeTimeMachineClient(base_url, ClientSession("synthetic-access-token", "privacy_rights"))
            client.submit_rights_request(
                RightsRequestSubmission(
                    participant_id="participant-1",
                    request_type="correction",
                    requested_processing_purpose="profile",
                    request_id="rights-1",
                    correction_fields=("profile.display_name",),
                    correction_payload_sha256="a" * 64,
                ),
                "rights-submit-1",
            )
            client.review_rights_request(
                RightsReviewRequest(
                    request_id="rights-1",
                    decision="approve",
                    reason_code="VERIFIED_COMPLETE",
                    case_reference="privacy-case-1",
                ),
                "rights-review-1",
            )
            inputs = [request["body"] for request in _ContractHandler.requests]
            self.assertEqual([value["command"] for value in inputs], [
                "rights-request.submit", "rights-request.review",
            ])
            self.assertEqual(set(inputs[0]["input"]), {
                "participantId", "requestType", "requestedProcessingPurpose", "requestId",
                "correctionFields", "correctionPayloadSha256",
            })
            self.assertNotIn("ownerActorId", inputs[0]["input"])
            self.assertNotIn("participantIds", inputs[0]["input"])
        finally:
            server.shutdown()
            server.server_close()

    def test_base_url_rejects_credentials_query_fragment_and_cleartext_remote(self) -> None:
        for base_url in (
            "http://example.com",
            "http://10.0.0.1:8080",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com?",
            "https://example.com#fragment",
            "https://example.com#",
            "https://example.com/api",
        ):
            with self.subTest(base_url=base_url), self.assertRaises(ValueError):
                LifeTimeMachineClient(base_url, self.session)
        LifeTimeMachineClient("http://127.9.8.7:8080", self.session)
        LifeTimeMachineClient("http://[::1]:8080", self.session)
        LifeTimeMachineClient("https://api.example.com", self.session)

    def test_malformed_success_and_oversized_response_fail_closed(self) -> None:
        malformed = LifeTimeMachineClient(
            "http://127.0.0.1:8080",
            self.session,
            max_retries=0,
            transport=lambda _request, _timeout, _maximum: (200, {}, b'{"id":"not-an-envelope"}'),
        )
        with self.assertRaises(ApiError) as caught:
            malformed.execute("B14", {}, "idem-malformed-1")
        self.assertEqual((caught.exception.status, caught.exception.code), (502, "INVALID_RESPONSE"))

        oversized = LifeTimeMachineClient(
            "http://127.0.0.1:8080",
            self.session,
            max_retries=0,
            max_response_bytes=32,
            transport=lambda _request, _timeout, _maximum: (200, {}, b"x" * 33),
        )
        with self.assertRaises(ApiError) as caught:
            oversized.execute("B14", {}, "idem-large-1")
        self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

    def test_permanent_error_is_structured_from_exact_error_envelope(self) -> None:
        error_body = json.dumps({
            "error": {"code": "CONSENT_REQUIRED", "message": "missing", "retryable": False, "details": {"participantId": "p-1"}},
            "requestId": "req-error-1",
        }).encode()
        client = LifeTimeMachineClient(
            "http://127.0.0.1:8080",
            self.session,
            max_retries=0,
            transport=lambda _request, _timeout, _maximum: (403, {"X-Request-Id": "req-error-1"}, error_body),
        )
        with self.assertRaises(ApiError) as caught:
            client.command("record.create", {}, "idem-error-1")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "CONSENT_REQUIRED")
        self.assertEqual(caught.exception.request_id, "req-error-1")
        self.assertEqual(caught.exception.details, {"participantId": "p-1"})

    def test_retry_after_is_capped_and_idempotency_is_stable(self) -> None:
        attempts = 0
        keys: list[str] = []
        started = time.monotonic()

        def transport(request, _timeout, _maximum):
            nonlocal attempts
            attempts += 1
            keys.append(request.get_header("Idempotency-key"))
            if attempts == 1:
                return 429, {"Retry-After": "3600"}, json.dumps({
                    "error": {"code": "RATE_LIMITED", "message": "later", "retryable": True, "details": {}},
                    "requestId": "req-rate-1",
                }).encode()
            return 200, {}, b'{"data":{"id":"record-2"},"meta":{"requestId":"req-rate-2","command":"record.create"}}'

        client = LifeTimeMachineClient(
            "http://127.0.0.1:8080", self.session, max_retries=1, max_retry_delay=0.002, transport=transport
        )
        self.assertEqual(client.command("record.create", {}, "idem-retry-1"), {"id": "record-2"})
        self.assertEqual(attempts, 2)
        self.assertEqual(keys, ["idem-retry-1", "idem-retry-1"])
        self.assertLess(time.monotonic() - started, 0.5)

    def test_timeout_and_io_failures_are_typed_and_bounded(self) -> None:
        attempts = 0

        def transport(_request, _timeout, _maximum):
            nonlocal attempts
            attempts += 1
            raise OSError("connection reset")

        client = LifeTimeMachineClient(
            "http://127.0.0.1:8080", self.session, max_retries=1, max_retry_delay=0, transport=transport
        )
        with self.assertRaises(TransportError) as caught:
            client.query("record.list")
        self.assertEqual(caught.exception.code, "NETWORK_ERROR")
        self.assertEqual(attempts, 2)

        timeout_client = LifeTimeMachineClient(
            "http://127.0.0.1:8080",
            self.session,
            max_retries=0,
            transport=lambda _request, _timeout, _maximum: (_ for _ in ()).throw(TimeoutError("timed out")),
        )
        with self.assertRaises(TransportError) as caught:
            timeout_client.query("record.list")
        self.assertEqual(caught.exception.code, "REQUEST_TIMEOUT")

    def test_non_idempotent_dispatch_never_reaches_transport_without_key(self) -> None:
        attempts = 0

        def transport(_request, _timeout, _maximum):
            nonlocal attempts
            attempts += 1
            return 200, {}, b"{}"

        client = LifeTimeMachineClient("http://127.0.0.1:8080", self.session, transport=transport)
        with self.assertRaises(ValueError):
            client.command("record.create", {}, "")
        with self.assertRaises(ValueError):
            client.execute("B14", {}, "x" * 201)
        self.assertEqual(attempts, 0)

    @staticmethod
    def _server(handler: type[BaseHTTPRequestHandler]) -> tuple[ThreadingHTTPServer, str]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, f"http://127.0.0.1:{server.server_address[1]}"


if __name__ == "__main__":
    unittest.main()
