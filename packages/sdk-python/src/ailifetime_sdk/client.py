from __future__ import annotations

import ipaddress
import json
import math
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Generic, Mapping, TypeVar
from urllib.parse import SplitResult, urlsplit, urlunsplit

BATCH_ID = re.compile(r"^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$")
OPERATION = re.compile(r"^[a-z][a-z0-9.-]*$")
DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_TIMEOUT_SECONDS = 120.0
T = TypeVar("T")


@dataclass(frozen=True)
class ClientSession:
    access_token: str
    purpose: str


@dataclass(frozen=True)
class DispatchMeta:
    request_id: str
    batch_id: str | None = None
    command: str | None = None
    query: str | None = None


@dataclass(frozen=True)
class DispatchEnvelope(Generic[T]):
    data: T
    meta: DispatchMeta


class ApiError(RuntimeError):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: str | None = None,
        retryable: bool = False,
        details: Mapping[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retryable = retryable
        self.details = dict(details or {})


class TransportError(RuntimeError):
    def __init__(self, code: str, message: str, cause: BaseException):
        super().__init__(message)
        self.code = code
        self.cause = cause


Transport = Callable[[urllib.request.Request, float, int], tuple[int, Mapping[str, str], bytes]]


class LifeTimeMachineClient:
    def __init__(
        self,
        base_url: str,
        session: ClientSession,
        timeout: float = 10.0,
        max_retries: int = 2,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        max_retry_delay: float = 5.0,
        transport: Transport | None = None,
    ) -> None:
        self._base_url = _validate_base_url(base_url)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= MAX_TIMEOUT_SECONDS
            or isinstance(max_retries, bool)
            or not isinstance(max_retries, int)
            or not 0 <= max_retries <= 5
        ):
            raise ValueError("invalid timeout or retry bound")
        if isinstance(max_response_bytes, bool) or not isinstance(max_response_bytes, int) or not 1 <= max_response_bytes <= MAX_RESPONSE_BYTES:
            raise ValueError("max_response_bytes must be from 1 through 16777216")
        if (
            isinstance(max_retry_delay, bool)
            or not isinstance(max_retry_delay, (int, float))
            or not math.isfinite(max_retry_delay)
            or not 0 <= max_retry_delay <= 60
        ):
            raise ValueError("max_retry_delay must be from 0 through 60 seconds")
        _validate_header_value(session.access_token, "bearer access token", 8192, forbid_whitespace=True)
        _validate_header_value(session.purpose, "request purpose", 120, forbid_whitespace=False)
        self._session = session
        self._timeout = timeout
        self._max_retries = max_retries
        self._max_response_bytes = max_response_bytes
        self._max_retry_delay = max_retry_delay
        self._transport = transport or self._urlopen_transport

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health/ready", None, None, retry_safe=True, accepted_statuses={503})

    def list_capabilities(self) -> list[dict[str, Any]]:
        body = self._request("GET", "/v1/capabilities", None, None, retry_safe=True)
        capabilities = body.get("capabilities")
        if not isinstance(capabilities, list) or not all(isinstance(item, dict) for item in capabilities):
            raise _invalid_response("capability response is malformed")
        return capabilities

    def execute(self, batch_id: str, payload: dict[str, Any], idempotency_key: str) -> Any:
        return self.execute_envelope(batch_id, payload, idempotency_key).data

    def execute_envelope(self, batch_id: str, payload: dict[str, Any], idempotency_key: str) -> DispatchEnvelope[Any]:
        if not BATCH_ID.fullmatch(batch_id):
            raise ValueError("batch_id must be B00 through B127")
        _validate_input(payload)
        _validate_idempotency_key(idempotency_key)
        return self._dispatch(
            f"/v1/capabilities/{batch_id}",
            payload,
            idempotency_key,
            expected=("batchId", batch_id),
        )

    def command(self, command: str, payload: dict[str, Any], idempotency_key: str) -> Any:
        return self.command_envelope(command, payload, idempotency_key).data

    def command_envelope(self, command: str, payload: dict[str, Any], idempotency_key: str) -> DispatchEnvelope[Any]:
        _validate_operation(command, "command")
        _validate_input(payload)
        _validate_idempotency_key(idempotency_key)
        return self._dispatch(
            "/v1/commands",
            {"command": command, "input": payload},
            idempotency_key,
            expected=("command", command),
        )

    def query(self, query: str, payload: dict[str, Any] | None = None) -> Any:
        return self.query_envelope(query, payload).data

    def query_envelope(self, query: str, payload: dict[str, Any] | None = None) -> DispatchEnvelope[Any]:
        _validate_operation(query, "query")
        input_value = {} if payload is None else payload
        _validate_input(input_value)
        return self._dispatch(
            "/v1/queries",
            {"query": query, "input": input_value},
            None,
            expected=("query", query),
        )

    def _dispatch(
        self,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str | None,
        expected: tuple[str, str],
    ) -> DispatchEnvelope[Any]:
        body = self._request("POST", path, payload, idempotency_key, retry_safe=True)
        if "data" not in body or not isinstance(body.get("meta"), dict):
            raise _invalid_response("dispatch response must contain data and meta")
        meta = body["meta"]
        assert isinstance(meta, dict)
        request_id = _required_string(meta.get("requestId"), "dispatch meta.requestId")
        field, expected_value = expected
        if meta.get(field) != expected_value:
            raise _invalid_response(f"dispatch meta.{field} does not match the request", request_id)
        return DispatchEnvelope(
            data=body["data"],
            meta=DispatchMeta(
                request_id=request_id,
                batch_id=_optional_string(meta.get("batchId")),
                command=_optional_string(meta.get("command")),
                query=_optional_string(meta.get("query")),
            ),
        )

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        idempotency_key: str | None,
        *,
        retry_safe: bool,
        accepted_statuses: set[int] | None = None,
    ) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._session.access_token}",
            "X-Purpose": self._session.purpose,
            "X-Sdk-Version": "python/1.0.0",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        accepted = accepted_statuses or set()
        for attempt in range(self._max_retries + 1):
            request = urllib.request.Request(self._base_url + path, data=data, headers=headers, method=method)
            try:
                status, response_headers_raw, raw = self._transport(request, self._timeout, self._max_response_bytes)
            except (OSError, urllib.error.URLError) as error:
                code = "REQUEST_TIMEOUT" if _is_timeout(error) else "NETWORK_ERROR"
                if retry_safe and attempt < self._max_retries:
                    time.sleep(_retry_delay(None, attempt, self._max_retry_delay))
                    continue
                raise TransportError(code, "request timed out" if code == "REQUEST_TIMEOUT" else "network request failed", error) from error
            if len(raw) > self._max_response_bytes:
                raise _invalid_response("response body exceeds max_response_bytes")
            response_headers = {key.lower(): value for key, value in response_headers_raw.items()}
            body = _parse_json_object(raw)
            if 200 <= status < 300 or status in accepted:
                return body
            error = _parse_error_envelope(status, body, response_headers.get("x-request-id"))
            if retry_safe and attempt < self._max_retries and _is_retryable_status(status) and error.retryable:
                time.sleep(_retry_delay(response_headers.get("retry-after"), attempt, self._max_retry_delay))
                continue
            raise error
        raise RuntimeError("bounded retry loop ended unexpectedly")

    @staticmethod
    def _urlopen_transport(request: urllib.request.Request, timeout: float, max_bytes: int) -> tuple[int, Mapping[str, str], bytes]:
        opener = urllib.request.build_opener(_NoRedirectHandler())
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, dict(response.headers.items()), _read_bounded(response, max_bytes)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, dict(error.headers.items()), _read_bounded(error, max_bytes)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _validate_base_url(value: str) -> str:
    if not isinstance(value, str) or value != value.strip() or "?" in value or "#" in value:
        raise ValueError("base_url must not contain whitespace, a query, or a fragment")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as error:
        raise ValueError("base_url must be an absolute HTTP or HTTPS URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base_url must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("base_url must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url must not contain a query or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("base_url must identify an origin without a path")
    if parsed.scheme == "http" and not _is_loopback(parsed.hostname):
        raise ValueError("unencrypted HTTP is permitted only for loopback development endpoints")
    origin = SplitResult(parsed.scheme, parsed.netloc, "", "", "")
    return urlunsplit(origin)


def _is_loopback(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _validate_header_value(value: str, label: str, maximum: int, *, forbid_whitespace: bool) -> None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"a valid {label} is required")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f"a valid {label} is required")
    if forbid_whitespace and any(character.isspace() for character in value):
        raise ValueError(f"a valid {label} is required")
    if not forbid_whitespace and not value.strip():
        raise ValueError(f"a valid {label} is required")


def _validate_idempotency_key(value: str) -> None:
    _validate_header_value(value, "idempotency key", 200, forbid_whitespace=False)
    if value != value.strip():
        raise ValueError("a valid idempotency key is required")


def _validate_operation(value: str, label: str) -> None:
    if not isinstance(value, str) or len(value) > 160 or not OPERATION.fullmatch(value):
        raise ValueError(f"{label} must be a bounded operation name")


def _validate_input(value: object) -> None:
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")


def _read_bounded(response: Any, maximum: int) -> bytes:
    content_length = response.headers.get("Content-Length")
    if content_length is not None and content_length.isdigit() and int(content_length) > maximum:
        raise _invalid_response("response body exceeds max_response_bytes")
    data = response.read(maximum + 1)
    if len(data) > maximum:
        raise _invalid_response("response body exceeds max_response_bytes")
    return data


def _parse_json_object(raw: bytes) -> dict[str, Any]:
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _invalid_response("server returned malformed JSON") from error
    if not isinstance(body, dict):
        raise _invalid_response("server returned a non-object response")
    return body


def _parse_error_envelope(status: int, body: dict[str, Any], header_request_id: str | None) -> ApiError:
    error = body.get("error")
    if not isinstance(error, dict):
        raise _invalid_response("error response is missing error")
    request_id = _required_string(body.get("requestId"), "error requestId")
    if header_request_id is not None and header_request_id != request_id:
        raise _invalid_response("response request identifiers do not match", request_id)
    retryable = error.get("retryable")
    details = error.get("details")
    if not isinstance(retryable, bool) or not isinstance(details, dict):
        raise _invalid_response("error response has invalid retryable or details fields", request_id)
    return ApiError(
        status=status,
        code=_required_string(error.get("code"), "error code"),
        message=_required_string(error.get("message"), "error message"),
        request_id=request_id,
        retryable=retryable,
        details=details,
    )


def _required_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise _invalid_response(f"{label} must be a non-empty string")
    return value


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _invalid_response(message: str, request_id: str | None = None) -> ApiError:
    return ApiError(502, "INVALID_RESPONSE", message, request_id)


def _is_timeout(error: BaseException) -> bool:
    value: BaseException | object = error
    if isinstance(value, urllib.error.URLError):
        value = value.reason
    return isinstance(value, (TimeoutError, socket.timeout))


def _is_retryable_status(status: int) -> bool:
    return status == 429 or status >= 500


def _retry_delay(retry_after: str | None, attempt: int, maximum: float) -> float:
    requested = 0.025 * (2**attempt)
    if retry_after is not None:
        try:
            seconds = float(retry_after)
            if seconds >= 0:
                requested = seconds
        except ValueError:
            try:
                target = parsedate_to_datetime(retry_after)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                requested = max(0.0, (target - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return min(maximum, max(0.0, requested))
