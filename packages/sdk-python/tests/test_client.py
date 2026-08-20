from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ailifetime_sdk import ApiError, ClientSession, LifeTimeMachineClient


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.session = ClientSession("synthetic-access-token", "product")

    def test_execute_sends_auth_context_without_asserting_identity(self) -> None:
        captured = {}

        def transport(request, timeout):
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return 200, {}, json.dumps({"id": "record-1"}).encode()

        client = LifeTimeMachineClient("http://localhost:8080/", self.session, transport=transport)
        self.assertEqual(client.execute("B14", {"targetAges": [25]}, "idem-1"), {"id": "record-1"})
        self.assertEqual(captured["headers"]["Authorization"], "Bearer synthetic-access-token")
        self.assertEqual(captured["headers"]["X-purpose"], "product")
        self.assertNotIn("X-tenant-id", captured["headers"])
        self.assertNotIn("X-actor-id", captured["headers"])
        self.assertEqual(captured["headers"]["Idempotency-key"], "idem-1")

    def test_transient_failure_is_bounded_and_then_succeeds(self) -> None:
        attempts = 0

        def transport(_request, _timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return 503, {}, b'{"error":{"code":"BUSY"}}'
            return 200, {}, b'{"capabilities":[]}'

        client = LifeTimeMachineClient("http://localhost:8080", self.session, max_retries=1, transport=transport)
        self.assertEqual(client.list_capabilities(), [])
        self.assertEqual(attempts, 2)

    def test_permanent_error_is_structured(self) -> None:
        client = LifeTimeMachineClient(
            "http://localhost:8080",
            self.session,
            transport=lambda _request, _timeout: (403, {"x-request-id": "req-1"}, b'{"error":{"code":"CONSENT_REQUIRED","message":"missing"}}'),
        )
        with self.assertRaises(ApiError) as caught:
            client.execute("B14", {}, "idem-2")
        self.assertEqual(caught.exception.code, "CONSENT_REQUIRED")
        self.assertEqual(caught.exception.request_id, "req-1")


if __name__ == "__main__":
    unittest.main()
