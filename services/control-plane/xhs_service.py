"""
AI Life Time Machine - Control Plane Xiaohongshu & Mini-Program Domain Service
Implements B70-R01..R05, B71-R01..R05, and B72-R01..R05 server-side invariants:
1. Platform-scoped code2Session exchange (`mp-xhs` and `mp-weixin`) that derives a
   pseudonymous actor ID via HMAC-SHA256 instead of exposing raw `openid` as a
   cross-entity identity (B70-R01).
2. Server-priced order & Xiaohongshu guaranteed-payment callback verification with
   HMAC-SHA256 signature verification, replay/duplicate `event_id` deduplication,
   amount tamper rejection, and immutable double-entry ledger posting (B71-R01, B71-R02).
3. Compliant Xiaohongshu Note Mount card generation (`POST /v1/xhs/note-mounts`)
   enforcing mandatory `AI生成·艺术示意非真实预测` watermark, revocable share grant binding,
   and fail-closed child/minor public-share blocking (B21, B71-R03).
4. Review account sandbox tenant isolation guard (B72-R04).
"""
from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


AI_WATERMARK_BADGE = "AI生成·艺术示意非真实预测"


class ControlPlaneError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class MiniProgramSessionRecord:
    session_id: str
    actor_pseudonym: str
    platform: str
    tenant_id: str
    access_token: str
    expires_at: str
    is_review_sandbox: bool = False


@dataclass
class OrderRecord:
    order_id: str
    checkout_id: str
    amount_minor: int
    currency: str
    state: str = "pending"
    version: int = 1
    xhs_trade_no: str | None = None


@dataclass(frozen=True)
class LedgerEntry:
    entry_id: str
    event_id: str
    order_id: str
    debit_account: str
    credit_account: str
    amount_minor: int
    currency: str
    created_at: str


@dataclass
class ShareGrantRecord:
    share_id: str
    artifact_ids: list[str]
    participant_consent_refs: list[str]
    status: str
    expires_at: str
    contains_minor: bool = False


@dataclass(frozen=True)
class XhsNoteMountRecord:
    mount_id: str
    share_id: str
    xhs_path: str
    enforced_title: str
    ai_watermark_badge: str
    topic_tags: list[str]
    expires_at: str


class XhsControlPlaneService:
    def __init__(
        self,
        actor_pepper: str = "ltm-actor-hmac-pepper-v1",
        xhs_webhook_secret: str = "xhs-guaranteed-pay-webhook-secret-v1",
    ) -> None:
        self._actor_pepper = actor_pepper.encode("utf-8")
        self._xhs_webhook_secret = xhs_webhook_secret.encode("utf-8")
        self._orders: dict[str, OrderRecord] = {}
        self._shares: dict[str, ShareGrantRecord] = {}
        self._processed_webhook_events: dict[str, dict[str, Any]] = {}
        self._session_idempotency: dict[str, tuple[str, MiniProgramSessionRecord]] = {}
        self._mount_idempotency: dict[str, tuple[str, XhsNoteMountRecord]] = {}
        self._ledger: list[LedgerEntry] = []

    def exchange_mini_program_session(
        self,
        *,
        platform: str,
        js_code: str,
        idempotency_key: str,
        is_review_account: bool = False,
        now: datetime | None = None,
    ) -> MiniProgramSessionRecord:
        """B70-R01 & B72-R04: Exchange login code for pseudonymous actor without exposing openid."""
        self._validate_idempotency_key(idempotency_key)
        clean_key = idempotency_key.strip()
        if platform not in ("mp-xhs", "mp-weixin"):
            raise ControlPlaneError("INVALID_PLATFORM", f"Unsupported platform: {platform}", 400)
        if not js_code or len(js_code.strip()) < 4:
            raise ControlPlaneError("INVALID_JS_CODE", "js_code must be at least 4 chars", 400)

        fingerprint = f"{platform}|{js_code.strip()}|{is_review_account}"
        if clean_key in self._session_idempotency:
            saved_fp, saved_record = self._session_idempotency[clean_key]
            if saved_fp != fingerprint:
                raise ControlPlaneError(
                    "IDEMPOTENCY_KEY_CONFLICT",
                    "Idempotency-Key reused with different session exchange parameters",
                    409,
                )
            return saved_record

        current_time = now or datetime.now(timezone.utc)
        raw_provider_subject = f"{platform}:{js_code.strip()}"
        pseudonym_digest = hmac.new(
            self._actor_pepper, raw_provider_subject.encode("utf-8"), hashlib.sha256
        ).hexdigest()[:24]

        tenant_id = "tenant_review_sandbox" if is_review_account else "tenant_cn_b2c"
        actor_pseudonym = f"act_{platform.replace('-', '_')}_{pseudonym_digest}"
        session_id = f"mps_{hashlib.sha256((clean_key + actor_pseudonym).encode('utf-8')).hexdigest()[:16]}"
        access_token = f"st_{hashlib.sha256((session_id + current_time.isoformat()).encode('utf-8')).hexdigest()[:32]}"
        expires_at = (current_time + timedelta(hours=2)).isoformat()

        record = MiniProgramSessionRecord(
            session_id=session_id,
            actor_pseudonym=actor_pseudonym,
            platform=platform,
            tenant_id=tenant_id,
            access_token=access_token,
            expires_at=expires_at,
            is_review_sandbox=is_review_account,
        )
        self._session_idempotency[clean_key] = (fingerprint, record)
        return record

    def assert_tenant_access(self, session: MiniProgramSessionRecord, target_tenant_id: str) -> None:
        """B72-R04: Prevent review accounts from accessing production customer tenants."""
        if session.is_review_sandbox and target_tenant_id != "tenant_review_sandbox":
            raise ControlPlaneError(
                "REVIEW_ACCOUNT_TENANT_FORBIDDEN",
                "Review account is strictly isolated to synthetic tenant_review_sandbox",
                403,
            )
        if session.tenant_id != target_tenant_id:
            raise ControlPlaneError("CROSS_TENANT_FORBIDDEN", "Cross-tenant access denied", 403)

    def register_server_priced_order(
        self,
        *,
        order_id: str,
        checkout_id: str,
        amount_minor: int,
        currency: str = "CNY",
    ) -> OrderRecord:
        """B71-R02: Server-authoritative order creation."""
        if amount_minor <= 0 or currency != "CNY":
            raise ControlPlaneError("INVALID_ORDER_AMOUNT", "Order amount must be positive CNY", 400)
        record = OrderRecord(
            order_id=order_id,
            checkout_id=checkout_id,
            amount_minor=amount_minor,
            currency=currency,
            state="pending",
            version=1,
        )
        self._orders[order_id] = record
        return record

    def sign_xhs_webhook_payload(
        self,
        *,
        event_id: str,
        out_trade_no: str,
        xhs_trade_no: str,
        amount_minor: int,
        currency: str,
        status: str,
        timestamp: str,
        nonce: str,
    ) -> str:
        canonical = f"{event_id}|{out_trade_no}|{xhs_trade_no}|{amount_minor}|{currency}|{status}|{timestamp}|{nonce}"
        return hmac.new(
            self._xhs_webhook_secret, canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def handle_xhs_payment_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        """B71-R01 & B87: Verify Xiaohongshu callback signature, deduplicate, and post ledger entry."""
        required = (
            "event_id",
            "out_trade_no",
            "xhs_trade_no",
            "amount_minor",
            "currency",
            "status",
            "timestamp",
            "nonce",
            "signature",
        )
        for key in required:
            if key not in payload:
                raise ControlPlaneError("MISSING_WEBHOOK_FIELD", f"Missing field: {key}", 400)

        expected_sig = self.sign_xhs_webhook_payload(
            event_id=str(payload["event_id"]),
            out_trade_no=str(payload["out_trade_no"]),
            xhs_trade_no=str(payload["xhs_trade_no"]),
            amount_minor=int(payload["amount_minor"]),
            currency=str(payload["currency"]),
            status=str(payload["status"]),
            timestamp=str(payload["timestamp"]),
            nonce=str(payload["nonce"]),
        )
        if not hmac.compare_digest(expected_sig, str(payload["signature"])):
            raise ControlPlaneError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature mismatch", 401)

        event_id = str(payload["event_id"])
        if event_id in self._processed_webhook_events:
            cached = dict(self._processed_webhook_events[event_id])
            cached["deduplicated"] = True
            return cached

        order_id = str(payload["out_trade_no"])
        order = self._orders.get(order_id)
        if order is None:
            raise ControlPlaneError("ORDER_NOT_FOUND", f"Unknown order: {order_id}", 404)

        if int(payload["amount_minor"]) != order.amount_minor or str(payload["currency"]) != order.currency:
            raise ControlPlaneError(
                "AMOUNT_MISMATCH",
                "Callback amount or currency does not match server-priced order",
                409,
            )

        status = str(payload["status"])
        now_iso = datetime.now(timezone.utc).isoformat()
        if status == "PAID":
            if order.state in ("paid", "refunded"):
                receipt = {
                    "event_id": event_id,
                    "order_id": order.order_id,
                    "state": order.state,
                    "deduplicated": order.state == "paid",
                    "ledger_entry_id": "noop_already_settled" if order.state == "paid" else "noop_already_refunded",
                }
                self._processed_webhook_events[event_id] = receipt
                return receipt
            order.state = "paid"
            order.version += 1
            order.xhs_trade_no = str(payload["xhs_trade_no"])
            entry = LedgerEntry(
                entry_id=f"led_{len(self._ledger) + 1:04d}",
                event_id=event_id,
                order_id=order.order_id,
                debit_account="asset:xhs_clearing_cash",
                credit_account="liability:deferred_revenue",
                amount_minor=order.amount_minor,
                currency=order.currency,
                created_at=now_iso,
            )
            self._ledger.append(entry)
            ledger_entry_id = entry.entry_id
        elif status == "REFUNDED":
            if order.state == "refunded":
                receipt = {
                    "event_id": event_id,
                    "order_id": order.order_id,
                    "state": order.state,
                    "deduplicated": True,
                    "ledger_entry_id": "noop_already_refunded",
                }
                self._processed_webhook_events[event_id] = receipt
                return receipt
            if order.state != "paid":
                raise ControlPlaneError(
                    "INVALID_ORDER_STATE_TRANSITION",
                    f"Cannot refund an order in '{order.state}' state",
                    409,
                )
            order.state = "refunded"
            order.version += 1
            entry = LedgerEntry(
                entry_id=f"led_{len(self._ledger) + 1:04d}",
                event_id=event_id,
                order_id=order.order_id,
                debit_account="liability:deferred_revenue",
                credit_account="asset:xhs_clearing_cash",
                amount_minor=order.amount_minor,
                currency=order.currency,
                created_at=now_iso,
            )
            self._ledger.append(entry)
            ledger_entry_id = entry.entry_id
        else:
            if order.state in ("paid", "refunded"):
                receipt = {
                    "event_id": event_id,
                    "order_id": order.order_id,
                    "state": order.state,
                    "deduplicated": False,
                    "ledger_entry_id": "noop_preserve_settled_state",
                }
                self._processed_webhook_events[event_id] = receipt
                return receipt
            order.state = "cancelled"
            order.version += 1
            ledger_entry_id = "noop_closed"

        receipt = {
            "event_id": event_id,
            "order_id": order.order_id,
            "state": order.state,
            "deduplicated": False,
            "ledger_entry_id": ledger_entry_id,
        }
        self._processed_webhook_events[event_id] = receipt
        return receipt

    def register_share_grant(self, grant: ShareGrantRecord) -> None:
        self._shares[grant.share_id] = grant

    def revoke_share_grant(self, share_id: str) -> ShareGrantRecord:
        grant = self._shares.get(share_id)
        if grant is None:
            raise ControlPlaneError("SHARE_NOT_FOUND", f"Unknown share: {share_id}", 404)
        grant.status = "revoked"
        return grant

    def create_xhs_note_mount(
        self,
        *,
        share_id: str,
        title: str,
        topic_tags: list[str],
        participant_consent_refs: list[str],
        contains_minor: bool = False,
        idempotency_key: str,
        now: datetime | None = None,
    ) -> XhsNoteMountRecord:
        """B71-R03 & B21: Create Xiaohongshu note mount card with mandatory AI badge and minor protection."""
        self._validate_idempotency_key(idempotency_key)
        clean_key = idempotency_key.strip()
        clean_title = title.strip()
        if not clean_title:
            raise ControlPlaneError("INVALID_TITLE", "Note mount title cannot be empty", 400)

        grant = self._shares.get(share_id)
        if grant is None:
            raise ControlPlaneError("SHARE_NOT_FOUND", f"Share grant not found: {share_id}", 404)
        if grant.status != "active":
            raise ControlPlaneError("SHARE_NOT_ACTIVE", f"Share grant is {grant.status}", 409)
        if contains_minor or grant.contains_minor:
            raise ControlPlaneError(
                "MINOR_PUBLIC_MOUNT_FORBIDDEN",
                "Works involving minors cannot be mounted to public Xiaohongshu notes",
                403,
            )
        if not participant_consent_refs or set(participant_consent_refs) != set(grant.participant_consent_refs):
            raise ControlPlaneError(
                "CONSENT_MISMATCH",
                "All participant consent references must match the active share grant",
                403,
            )

        current_time = now or datetime.now(timezone.utc)
        normalized_expires = grant.expires_at.replace("Z", "+00:00")
        if datetime.fromisoformat(normalized_expires) <= current_time:
            raise ControlPlaneError("SHARE_EXPIRED", "Share grant has expired", 409)

        fingerprint = f"{share_id}|{clean_title}|{','.join(topic_tags)}|{','.join(sorted(participant_consent_refs))}"
        if clean_key in self._mount_idempotency:
            saved_fp, saved_card = self._mount_idempotency[clean_key]
            if saved_fp != fingerprint:
                raise ControlPlaneError(
                    "IDEMPOTENCY_KEY_CONFLICT",
                    "Idempotency-Key reused with different note mount parameters",
                    409,
                )
            return saved_card

        enforced_title = (
            clean_title
            if "AI" in clean_title
            else f"【AI艺术示意】{clean_title}"
        )
        mount_id = f"mnt_{hashlib.sha256((clean_key + share_id).encode('utf-8')).hexdigest()[:16]}"
        xhs_path = f"/pages/index/index?share_id={share_id}&mount_id={mount_id}&ai_label=1"

        card = XhsNoteMountRecord(
            mount_id=mount_id,
            share_id=share_id,
            xhs_path=xhs_path,
            enforced_title=enforced_title,
            ai_watermark_badge=AI_WATERMARK_BADGE,
            topic_tags=list(topic_tags),
            expires_at=grant.expires_at,
        )
        self._mount_idempotency[clean_key] = (fingerprint, card)
        return card

    @property
    def ledger_entries(self) -> list[LedgerEntry]:
        return list(self._ledger)

    @staticmethod
    def _validate_idempotency_key(key: str) -> None:
        if not key or not (16 <= len(key.strip()) <= 128):
            raise ControlPlaneError(
                "INVALID_IDEMPOTENCY_KEY",
                "Idempotency-Key must be between 16 and 128 characters",
                400,
            )
