from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

BATCH_ID = re.compile(r"^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$")


@dataclass(frozen=True)
class ClientSession:
    access_token: str
    purpose: str


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


Transport = Callable[[urllib.request.Request, float], tuple[int, dict[str, str], bytes]]


class LifeTimeMachineClient:
    def __init__(
        self,
        base_url: str,
        session: ClientSession,
        timeout: float = 10.0,
        max_retries: int = 2,
        transport: Transport | None = None,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must use HTTP or HTTPS")
        if timeout <= 0 or not 0 <= max_retries <= 5:
            raise ValueError("invalid timeout or retry bound")
        self._base_url = base_url.rstrip("/")
        if not session.access_token or any(character.isspace() for character in session.access_token):
            raise ValueError("a bearer access token is required")
        if not session.purpose.strip():
            raise ValueError("a request purpose is required")
        self._session = session
        self._timeout = timeout
        self._max_retries = max_retries
        self._transport = transport or self._urlopen_transport

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health/ready", None, None)

    def list_capabilities(self) -> list[dict[str, Any]]:
        body = self._request("GET", "/v1/capabilities", None, None)
        capabilities = body.get("capabilities")
        if not isinstance(capabilities, list):
            raise ApiError(502, "INVALID_RESPONSE", "capability response is malformed")
        return capabilities

    def execute(self, batch_id: str, payload: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        if not BATCH_ID.fullmatch(batch_id):
            raise ValueError("batch_id must be B00 through B127")
        if not idempotency_key or len(idempotency_key) > 128:
            raise ValueError("a bounded idempotency key is required")
        return self._request("POST", f"/v1/capabilities/{batch_id}", payload, idempotency_key)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None, idempotency_key: str | None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._session.access_token}",
            "X-Purpose": self._session.purpose,
            "X-Sdk-Version": "python/1.0.0",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        for attempt in range(self._max_retries + 1):
            request = urllib.request.Request(self._base_url + path, data=data, headers=headers, method=method)
            status, response_headers, raw = self._transport(request, self._timeout)
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError as exc:
                raise ApiError(502, "INVALID_RESPONSE", "server returned non-JSON data") from exc
            if 200 <= status < 300:
                if not isinstance(body, dict):
                    raise ApiError(502, "INVALID_RESPONSE", "server returned a non-object response")
                return body
            if attempt < self._max_retries and (status == 429 or status >= 500):
                time.sleep(0.025 * (2**attempt))
                continue
            error = body.get("error", {}) if isinstance(body, dict) else {}
            raise ApiError(status, str(error.get("code", "HTTP_ERROR")), str(error.get("message", "request failed")), response_headers.get("x-request-id"))
        raise ApiError(500, "INTERNAL_ERROR", "retry loop ended unexpectedly")

    @staticmethod
    def _urlopen_transport(request: urllib.request.Request, timeout: float) -> tuple[int, dict[str, str], bytes]:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, {key.lower(): value for key, value in response.headers.items()}, response.read()
        except urllib.error.HTTPError as error:
            return error.code, {key.lower(): value for key, value in error.headers.items()}, error.read()
