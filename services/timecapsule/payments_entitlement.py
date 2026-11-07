"""
TimeCapsule Domain Package — P09:
Server-Priced Orders, WeChat Pay Signature Verification, 100x Duplicate/Out-of-Order
Callback Idempotency (A08), Active Merchant Query Fallback, Double-Entry Ledger,
Single Entitlement Grant Invariant, and Refund Lifecycle.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any
import uuid

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    SPEC_ROOT,
    IdentityConsentService,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    utc_now_iso,
)


class PaymentEntitlementService:
    """
    P09: Enforces server-authoritative order pricing, `contracts/state-machines.json` order graph,
    cryptographic webhook verification, 100x replay deduplication (A08), and refund revocation.
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        identity: IdentityConsentService,
        catalog: CatalogService,
        *,
        webhook_secret: str = "wechatpay-v3-merchant-webhook-secret-local",
        spec_root: Path = SPEC_ROOT,
    ) -> None:
        self.db = db
        self.identity = identity
        self.catalog = catalog
        self._webhook_secret = webhook_secret.encode("utf-8")
        state_machines = json.loads((spec_root / "contracts" / "state-machines.json").read_text(encoding="utf-8"))
        self._order_graph: dict[str, list[str]] = state_machines["order"]

    def create_order(
        self,
        *,
        actor_user_id: str,
        product_id: str,
        client_supplied_amount_fen: int | None = None,
        client_supplied_user_id: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P09: Creates a server-priced order in CREATED -> PENDING state.
        Strictly rejects client-supplied price or user_id overrides (AGENTS.md invariant).
        """
        if client_supplied_user_id is not None and client_supplied_user_id != actor_user_id:
            raise TimeCapsuleError(
                "CLIENT_USER_ID_FORBIDDEN",
                "Client-supplied user_id cannot override authenticated session actor",
                403,
            )
        if client_supplied_amount_fen is not None:
            raise TimeCapsuleError(
                "CLIENT_PRICE_FORBIDDEN",
                "Client-supplied order price is forbidden; server resolves immutable product_price snapshot",
                400,
            )

        price_snap = self.catalog.get_product_price(product_id)
        now_str = utc_now_iso(now)
        order_id = str(uuid.uuid4())
        merchant_order_no = f"mch_{order_id.replace('-', '')[:24]}"

        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO customer_order (
                    id, user_id, product_id, amount_fen, currency,
                    price_version, merchant_order_no, state, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, 1)
                """,
                (
                    order_id,
                    actor_user_id,
                    price_snap["id"],
                    price_snap["amount_fen"],
                    price_snap["currency"],
                    price_snap["version"],
                    merchant_order_no,
                    now_str,
                ),
            )
            self._transition_order_in_tx(conn, order_id=order_id, target_state="PENDING")

        return self.get_order(actor_user_id=actor_user_id, order_id=order_id)

    def get_order(self, *, actor_user_id: str, order_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM customer_order WHERE id = ?", (order_id,))
        if row is None:
            raise TimeCapsuleError("ORDER_NOT_FOUND", f"Order {order_id} not found", 404)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="customer_order",
            resource_id=order_id,
        )
        grant = self.db.query_one(
            "SELECT id, feature, remaining_uses, granted_at, revoked_at FROM entitlement_grant WHERE order_id = ?",
            (order_id,),
        )
        return {
            "id": str(row["id"]),
            "user_id": str(row["user_id"]),
            "product_id": str(row["product_id"]),
            "amount_fen": int(row["amount_fen"]),
            "currency": str(row["currency"]),
            "price_version": int(row["price_version"]),
            "merchant_order_no": str(row["merchant_order_no"]),
            "state": str(row["state"]),
            "created_at": str(row["created_at"]),
            "entitlement": dict(grant) if grant is not None else None,
        }

    def sign_webhook(
        self,
        *,
        provider_event_id: str,
        merchant_order_no: str,
        amount_fen: int,
        currency: str,
        event_type: str,
        timestamp: str,
        nonce: str,
    ) -> str:
        canonical = f"{provider_event_id}|{merchant_order_no}|{amount_fen}|{currency}|{event_type}|{timestamp}|{nonce}"
        return hmac.new(self._webhook_secret, canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    def handle_payment_webhook(
        self,
        payload: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P09 & A08: Verifies merchant webhook signature, enforces idempotency across 100x
        duplicate or out-of-order notifications, posts double-entry ledger records,
        and grants entitlement at most once per order.
        """
        required_fields = (
            "provider_event_id",
            "merchant_order_no",
            "amount_fen",
            "currency",
            "event_type",
            "timestamp",
            "nonce",
            "signature",
        )
        for field in required_fields:
            if field not in payload:
                raise TimeCapsuleError("MISSING_WEBHOOK_FIELD", f"Webhook missing '{field}'", 400)

        expected_sig = self.sign_webhook(
            provider_event_id=str(payload["provider_event_id"]),
            merchant_order_no=str(payload["merchant_order_no"]),
            amount_fen=int(payload["amount_fen"]),
            currency=str(payload["currency"]),
            event_type=str(payload["event_type"]),
            timestamp=str(payload["timestamp"]),
            nonce=str(payload["nonce"]),
        )
        if not hmac.compare_digest(expected_sig, str(payload["signature"])):
            raise TimeCapsuleError("INVALID_WEBHOOK_SIGNATURE", "Payment webhook signature verification failed", 401)

        event_id = str(payload["provider_event_id"])
        merchant_order_no = str(payload["merchant_order_no"])
        event_type = str(payload["event_type"])
        now_str = utc_now_iso(now)

        order_row = self.db.query_one(
            "SELECT * FROM customer_order WHERE merchant_order_no = ?",
            (merchant_order_no,),
        )
        if order_row is None:
            raise TimeCapsuleError("ORDER_NOT_FOUND", f"Unknown merchant_order_no '{merchant_order_no}'", 404)

        order_id = str(order_row["id"])
        if int(payload["amount_fen"]) != int(order_row["amount_fen"]) or str(payload["currency"]) != str(order_row["currency"]):
            raise TimeCapsuleError(
                "ORDER_AMOUNT_MISMATCH",
                "Webhook amount or currency does not match server-priced order snapshot",
                409,
            )

        # Check if this exact provider_event_id was already processed (A08)
        existing_ev = self.db.query_one(
            "SELECT provider_event_id FROM payment_event WHERE provider_event_id = ?",
            (event_id,),
        )
        if existing_ev is not None:
            current_order = self.db.query_one("SELECT state FROM customer_order WHERE id = ?", (order_id,))
            grant = self.db.query_one("SELECT id FROM entitlement_grant WHERE order_id = ?", (order_id,))
            return {
                "provider_event_id": event_id,
                "order_id": order_id,
                "state": str(current_order["state"]) if current_order else "UNKNOWN",
                "entitlement_id": str(grant["id"]) if grant else None,
                "deduplicated": True,
            }

        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO payment_event (provider_event_id, order_id, event_type, verified, received_at) VALUES (?, ?, ?, 1, ?)",
                (event_id, order_id, event_type, now_str),
            )
            fresh_order = conn.execute("SELECT * FROM customer_order WHERE id = ?", (order_id,)).fetchone()
            assert fresh_order is not None
            current_state = str(fresh_order["state"])

            if event_type == "PAID":
                if current_state == "PENDING":
                    self._settle_paid_order_in_tx(conn, order_row=fresh_order, event_id=event_id, now_str=now_str)
                # If already PAID, FULFILLED, REFUNDING, or REFUNDED (duplicate or late callback with new event_id),
                # preserve state and never issue a second entitlement!
            elif event_type == "CLOSED":
                # Out-of-order protection (A08): if order is already PAID/FULFILLED/REFUNDED, ignore late CLOSED
                if current_state in ("CREATED", "PENDING"):
                    self._transition_order_in_tx(conn, order_id=order_id, target_state="CLOSED")
            elif event_type == "REFUNDED":
                if current_state in ("PAID", "FULFILLED"):
                    self._transition_order_in_tx(conn, order_id=order_id, target_state="REFUNDING")
                    current_state = "REFUNDING"
                if current_state == "REFUNDING":
                    self._complete_refund_in_tx(conn, order_row=fresh_order, event_id=event_id, now_str=now_str)
            else:
                raise TimeCapsuleError("UNSUPPORTED_WEBHOOK_EVENT", f"Unsupported event_type '{event_type}'", 400)

        after_order = self.db.query_one("SELECT state FROM customer_order WHERE id = ?", (order_id,))
        grant_after = self.db.query_one("SELECT id FROM entitlement_grant WHERE order_id = ?", (order_id,))
        return {
            "provider_event_id": event_id,
            "order_id": order_id,
            "state": str(after_order["state"]) if after_order else "UNKNOWN",
            "entitlement_id": str(grant_after["id"]) if grant_after else None,
            "deduplicated": False,
        }

    def reconcile_order_with_merchant_query(
        self,
        *,
        order_id: str,
        merchant_reported_status: str,
        merchant_query_id: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P09 Runbook: When webhook notification is delayed, actively queries merchant order status
        and reconciles order + entitlement + ledger idempotently.
        """
        order_row = self.db.query_one("SELECT * FROM customer_order WHERE id = ?", (order_id,))
        if order_row is None:
            raise TimeCapsuleError("ORDER_NOT_FOUND", f"Order {order_id} not found", 404)
        ts = utc_now_iso(now)
        sig = self.sign_webhook(
            provider_event_id=merchant_query_id,
            merchant_order_no=str(order_row["merchant_order_no"]),
            amount_fen=int(order_row["amount_fen"]),
            currency=str(order_row["currency"]),
            event_type=merchant_reported_status,
            timestamp=ts,
            nonce=f"reconcile_{order_id[:8]}",
        )
        return self.handle_payment_webhook(
            {
                "provider_event_id": merchant_query_id,
                "merchant_order_no": str(order_row["merchant_order_no"]),
                "amount_fen": int(order_row["amount_fen"]),
                "currency": str(order_row["currency"]),
                "event_type": merchant_reported_status,
                "timestamp": ts,
                "nonce": f"reconcile_{order_id[:8]}",
                "signature": sig,
            },
            now=now,
        )

    def request_refund(
        self,
        *,
        actor_user_id: str,
        order_id: str,
        simulate_gateway_failure: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """
        P09: Transitions PAID/FULFILLED/REFUND_FAILED -> REFUNDING -> REFUNDED (or REFUND_FAILED),
        revoking the user's entitlement grant and posting reversing double-entry ledger entries.
        """
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM customer_order WHERE id = ?", (order_id,)).fetchone()
            if row is None:
                raise TimeCapsuleError("ORDER_NOT_FOUND", f"Order {order_id} not found", 404)
            self.identity.assert_owner_access(
                actor_user_id=actor_user_id,
                owner_user_id=str(row["user_id"]),
                resource_type="customer_order",
                resource_id=order_id,
            )
            current = str(row["state"])
            if current == "REFUNDED":
                return self.get_order(actor_user_id=actor_user_id, order_id=order_id)
            if current in ("PAID", "FULFILLED", "REFUND_FAILED"):
                self._transition_order_in_tx(conn, order_id=order_id, target_state="REFUNDING")
            elif current != "REFUNDING":
                raise TimeCapsuleError(
                    "INVALID_ORDER_STATE_TRANSITION",
                    f"Order in state '{current}' cannot enter refund",
                    409,
                )

            if simulate_gateway_failure:
                self._transition_order_in_tx(conn, order_id=order_id, target_state="REFUND_FAILED")
            else:
                self._complete_refund_in_tx(
                    conn,
                    order_row=row,
                    event_id=f"rf_evt_{order_id}",
                    now_str=now_str,
                )
        return self.get_order(actor_user_id=actor_user_id, order_id=order_id)

    def require_active_entitlement(
        self,
        *,
        actor_user_id: str,
        entitlement_id: str,
        required_feature_prefix: str = "hd_export",
    ) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM entitlement_grant WHERE id = ?", (entitlement_id,))
        if row is None:
            raise TimeCapsuleError("ENTITLEMENT_NOT_FOUND", f"Entitlement {entitlement_id} not found", 403)
        self.identity.assert_owner_access(
            actor_user_id=actor_user_id,
            owner_user_id=str(row["user_id"]),
            resource_type="entitlement_grant",
            resource_id=entitlement_id,
        )
        if row["revoked_at"] is not None:
            raise TimeCapsuleError("ENTITLEMENT_REVOKED", "Entitlement was revoked due to refund", 403)
        if int(row["remaining_uses"]) <= 0:
            raise TimeCapsuleError("ENTITLEMENT_EXHAUSTED", "Entitlement has no remaining uses", 403)
        feature = str(row["feature"])
        if not (feature.startswith(required_feature_prefix) or feature == "memorial_bundle_all"):
            raise TimeCapsuleError(
                "ENTITLEMENT_FEATURE_MISMATCH",
                f"Entitlement feature '{feature}' does not cover '{required_feature_prefix}'",
                403,
            )
        return dict(row)

    def consume_entitlement_and_fulfill_order(
        self,
        *,
        actor_user_id: str,
        entitlement_id: str,
    ) -> dict[str, Any]:
        grant = self.require_active_entitlement(actor_user_id=actor_user_id, entitlement_id=entitlement_id)
        order_id = str(grant["order_id"])
        with self.db.transaction() as conn:
            cur = conn.execute(
                "UPDATE entitlement_grant SET remaining_uses = remaining_uses - 1, version = version + 1 WHERE id = ? AND version = ? AND remaining_uses > 0",
                (entitlement_id, int(grant["version"])),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Entitlement optimistic lock conflict", 409)
            ord_row = conn.execute("SELECT state FROM customer_order WHERE id = ?", (order_id,)).fetchone()
            if ord_row and str(ord_row["state"]) == "PAID":
                self._transition_order_in_tx(conn, order_id=order_id, target_state="FULFILLED")
        return self.get_order(actor_user_id=actor_user_id, order_id=order_id)

    def reconcile_ledger(self) -> dict[str, Any]:
        """Verifies double-entry accounting invariants and 1:1 paid-order-to-entitlement mapping."""
        paid_orders = self.db.query_all(
            "SELECT id, amount_fen, state FROM customer_order WHERE state IN ('PAID','FULFILLED')"
        )
        grants = self.db.query_all(
            "SELECT order_id FROM entitlement_grant WHERE revoked_at IS NULL"
        )
        paid_ids = {str(r["id"]) for r in paid_orders}
        active_grant_order_ids = {str(r["order_id"]) for r in grants}
        ledger_rows = self.db.query_all("SELECT debit_account, credit_account, amount_fen FROM ledger_entry")
        net_clearing_fen = 0
        for row in ledger_rows:
            amt = int(row["amount_fen"])
            if str(row["debit_account"]) == "asset:wechat_pay_clearing":
                net_clearing_fen += amt
            if str(row["credit_account"]) == "asset:wechat_pay_clearing":
                net_clearing_fen -= amt
        expected_net_fen = sum(int(r["amount_fen"]) for r in paid_orders)
        return {
            "balanced": (paid_ids == active_grant_order_ids) and (net_clearing_fen == expected_net_fen),
            "active_paid_orders": len(paid_ids),
            "active_entitlements": len(active_grant_order_ids),
            "net_clearing_fen": net_clearing_fen,
            "expected_net_fen": expected_net_fen,
        }

    def _settle_paid_order_in_tx(self, conn: Any, *, order_row: Any, event_id: str, now_str: str) -> None:
        order_id = str(order_row["id"])
        user_id = str(order_row["user_id"])
        product_id = str(order_row["product_id"])
        amount_fen = int(order_row["amount_fen"])
        currency = str(order_row["currency"])

        self._transition_order_in_tx(conn, order_id=order_id, target_state="PAID")

        feature = "memorial_bundle_all" if product_id == "bundle" else "hd_export_single"
        uses = 12 if product_id == "bundle" else 1
        grant_id = str(uuid.uuid5(uuid.NAMESPACE_OID, f"entitlement:{order_id}"))
        conn.execute(
            """
            INSERT OR IGNORE INTO entitlement_grant (
                id, order_id, user_id, feature, remaining_uses, granted_at, revoked_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
            """,
            (grant_id, order_id, user_id, feature, uses, now_str),
        )
        conn.execute(
            """
            INSERT INTO ledger_entry (
                id, order_id, event_id, debit_account, credit_account, amount_fen, currency, created_at
            ) VALUES (?, ?, ?, 'asset:wechat_pay_clearing', 'liability:deferred_revenue', ?, ?, ?)
            """,
            (str(uuid.uuid4()), order_id, event_id, amount_fen, currency, now_str),
        )

    def _complete_refund_in_tx(self, conn: Any, *, order_row: Any, event_id: str, now_str: str) -> None:
        order_id = str(order_row["id"])
        amount_fen = int(order_row["amount_fen"])
        currency = str(order_row["currency"])

        self._transition_order_in_tx(conn, order_id=order_id, target_state="REFUNDED")
        conn.execute(
            "UPDATE entitlement_grant SET revoked_at = ?, remaining_uses = 0, version = version + 1 WHERE order_id = ? AND revoked_at IS NULL",
            (now_str, order_id),
        )
        conn.execute(
            """
            INSERT INTO ledger_entry (
                id, order_id, event_id, debit_account, credit_account, amount_fen, currency, created_at
            ) VALUES (?, ?, ?, 'liability:deferred_revenue', 'asset:wechat_pay_clearing', ?, ?, ?)
            """,
            (str(uuid.uuid4()), order_id, event_id, amount_fen, currency, now_str),
        )

    def _transition_order_in_tx(self, conn: Any, *, order_id: str, target_state: str) -> None:
        row = conn.execute("SELECT state, version FROM customer_order WHERE id = ?", (order_id,)).fetchone()
        if row is None:
            raise TimeCapsuleError("ORDER_NOT_FOUND", f"Order {order_id} not found", 404)
        current = str(row["state"])
        allowed = self._order_graph.get(current, [])
        if target_state not in allowed:
            raise TimeCapsuleError(
                "INVALID_ORDER_STATE_TRANSITION",
                f"Illegal order state transition {current} -> {target_state}; allowed: {allowed}",
                409,
            )
        cur = conn.execute(
            "UPDATE customer_order SET state = ?, version = version + 1 WHERE id = ? AND version = ?",
            (target_state, order_id, int(row["version"])),
        )
        if cur.rowcount != 1:
            raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Order optimistic lock conflict", 409)
