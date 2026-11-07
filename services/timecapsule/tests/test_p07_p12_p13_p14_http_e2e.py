"""
Executable verification tests for Slice 7 (P07, P12, P13, P14 & OpenAPI v1 HTTP Server):
- Real TCP/HTTP socket end-to-end journey across `/v1/sessions`, `/v1/templates`, `/v1/consents`,
  `/v1/uploads/intents`, `/v1/uploads/{assetId}`, `/v1/jobs`, `/v1/orders`, `/v1/payments/webhook`,
  `/v1/exports`, `/v1/albums`, `/v1/surface/{platform}/{page}`, `/v1/metrics/slo`, and `/v1/privacy/deletion-requests`.
- P07: All 6 WeChat Mini-Program launch pages (`home`, `catalog`, `editor`, `history`, `orders`, `settings`),
       accessibility large-font & colorblind contrast tokens, and frontend privilege-escalation rejection.
- P13: H5 adapter behavioral equivalence & platform-specific capability bindings.
- P14: Memorial bundle multi-frame album & captioned video asynchronous composition.
- P12: OpenTelemetry-compatible SLO metrics, unit economics, and PII redaction guard.
"""
from __future__ import annotations

import base64
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from services.timecapsule.db_and_identity import TimeCapsuleError, sha256_hex
from services.timecapsule.http_server import TimeCapsuleApplication, create_http_server
from services.timecapsule.tests.test_p02_p03_catalog_media import build_test_png


class TestP07P12P13P14HttpE2E(unittest.TestCase):
    def setUp(self) -> None:
        self.app = TimeCapsuleApplication(":memory:")
        self.server = create_http_server(self.app, host="127.0.0.1", port=0)
        self.port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.close()

    def _http(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        token: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict]:
        req_headers = {"Content-Type": "application/json"}
        if token:
            req_headers["Authorization"] = f"Bearer {token}"
        if headers:
            req_headers.update(headers)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = Request(f"{self.base_url}{path}", data=data, headers=req_headers, method=method)
        try:
            with urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_full_http_openapi_e2e_miniapp_h5_album_and_slo(self) -> None:
        # 1. Login session via POST /v1/sessions
        st, session = self._http("POST", "/v1/sessions", {"wechat_code": "wx_e2e_user_001"})
        self.assertEqual(st, 201)
        token = session["token"]

        # 2. List catalog via GET /v1/templates
        st, cat = self._http("GET", "/v1/templates", token=token)
        self.assertEqual(st, 200)
        self.assertEqual(cat["combination_count"], 100)

        # 3. Record portrait consent via POST /v1/consents
        st, consent = self._http(
            "POST",
            "/v1/consents",
            {
                "subject_id": "self_001",
                "purpose": "portrait_generation",
                "policy_revision": "2026.11-v1",
                "evidence_ref": "ev_http_001",
            },
            token=token,
        )
        self.assertEqual(st, 201)

        # 4. Upload and sanitize portrait via POST /v1/uploads/intents + PUT /v1/uploads/{assetId}
        raw_png = build_test_png(48, 48, include_exif=True)
        st, intent = self._http(
            "POST",
            "/v1/uploads/intents",
            {
                "media_type": "image/png",
                "size_bytes": len(raw_png),
                "sha256": sha256_hex(raw_png),
            },
            token=token,
        )
        self.assertEqual(st, 201)

        st, uploaded = self._http(
            "PUT",
            f"/v1/uploads/{intent['asset_id']}",
            {"content_base64": base64.b64encode(raw_png).decode("ascii")},
            token=token,
        )
        self.assertEqual(st, 200)
        self.assertTrue(uploaded["exif_stripped"])

        # 5. Create two generation jobs via POST /v1/jobs (for P14 memorial album video)
        work_ids: list[str] = []
        for idx, tpl_id in enumerate(("life_0_100", "future_me"), start=1):
            idem = f"idem_http_e2e_job_{idx:02d}"
            st, job = self._http(
                "POST",
                "/v1/jobs",
                {
                    "consent_id": consent["id"],
                    "render_request": {
                        "template_id": tpl_id,
                        "template_version": "1.0.0",
                        "style_id": "retro",
                        "fields": {"title": f"人生篇章 {idx}", "display_name": "小忆"},
                        "asset_ids": [intent["asset_id"]],
                        "export_size": "3:4",
                        "idempotency_key": idem,
                    },
                },
                token=token,
                headers={"Idempotency-Key": idem},
            )
            self.assertEqual(st, 202)
            st, processed = self._http("POST", f"/v1/jobs/{job['id']}/process", {}, token=token)
            self.assertEqual(st, 200)
            self.assertEqual(processed["status"], "READY")

        works = self.app.timeline.list_user_works(actor_user_id=session["user_id"])
        self.assertEqual(len(works), 2)
        work_ids = [w["id"] for w in works]

        # 6. Create & pay a 'bundle' order via POST /v1/orders + POST /v1/payments/webhook
        st, order = self._http("POST", "/v1/orders", {"product_id": "bundle"}, token=token)
        self.assertEqual(st, 201)
        self.assertEqual(order["amount_fen"], 2990)

        ts = "2026-11-07T09:00:00Z"
        sig = self.app.payments.sign_webhook(
            provider_event_id="wx_bundle_evt_01",
            merchant_order_no=order["merchant_order_no"],
            amount_fen=2990,
            currency="CNY",
            event_type="PAID",
            timestamp=ts,
            nonce="nonce_bundle_01",
        )
        st, wh_res = self._http(
            "POST",
            "/v1/payments/webhook",
            {
                "provider_event_id": "wx_bundle_evt_01",
                "merchant_order_no": order["merchant_order_no"],
                "amount_fen": 2990,
                "currency": "CNY",
                "event_type": "PAID",
                "timestamp": ts,
                "nonce": "nonce_bundle_01",
                "signature": sig,
            },
        )
        self.assertEqual(st, 200)
        entitlement_id = wh_res["entitlement_id"]
        self.assertIsNotNone(entitlement_id)

        # 7. Export HD card with mandatory GB-45438 AI labeling via POST /v1/exports
        st, exp = self._http(
            "POST",
            "/v1/exports",
            {
                "job_id": works[0]["job_id"],
                "export_format": "png",
                "entitlement_id": entitlement_id,
            },
            token=token,
        )
        self.assertEqual(st, 202)
        self.assertTrue(exp["export_label_verified"])

        # 8. P14: Compose Memorial Bundle Album & Captioned Video via POST /v1/albums
        st, album = self._http(
            "POST",
            "/v1/albums",
            {
                "entitlement_id": entitlement_id,
                "work_ids": work_ids,
                "subtitles": ["第一幕：青春岁月", "第二幕：未来期许"],
            },
            token=token,
        )
        self.assertEqual(st, 202)
        self.assertEqual(album["state"], "READY")
        self.assertEqual(album["frame_count"], 2)
        self.assertIn("WEBVTT", album["webvtt"])

        # 9. P07 & P13: Verify all 6 WeChat Mini-Program pages & H5 adapter behavioral equivalence
        for page in ("home", "catalog", "editor", "history", "orders", "settings"):
            st_mp, vm_mp = self._http(
                "GET",
                f"/v1/surface/mp-weixin/{page}?a11y=large_font_colorblind",
                token=token,
            )
            st_h5, vm_h5 = self._http(
                "GET",
                f"/v1/surface/h5-web/{page}?a11y=large_font_colorblind",
                token=token,
            )
            self.assertEqual(st_mp, 200)
            self.assertEqual(st_h5, 200)
            self.assertEqual(vm_mp["data"], vm_h5["data"])
            self.assertEqual(vm_mp["accessibility"]["min_contrast_ratio"], 7.0)
            self.assertNotEqual(vm_mp["capabilities"]["payment_bridge"], vm_h5["capabilities"]["payment_bridge"])

        # Frontend self-certified payment privilege escalation is rejected with 403
        st_esc, _ = self._http(
            "GET",
            "/v1/surface/mp-weixin/orders?client_claimed_paid=true",
            token=token,
        )
        self.assertEqual(st_esc, 403)

        # 10. P12: Verify SLO report & PII telemetry redaction guard
        st_slo, slo = self._http("GET", "/v1/metrics/slo", token=token)
        self.assertEqual(st_slo, 200)
        self.assertTrue(slo["slo_healthy"])
        self.assertEqual(slo["duplicate_entitlement_grants"], 0)
        self.assertEqual(slo["delivered_work_count"], 2)

        with self.assertRaises(TimeCapsuleError) as ctx_pii:
            self.app.observability.record_event(
                trace_id="trc_1",
                request_id="req_1",
                event_name="bad_log",
                route="/v1/test",
                status_code=200,
                latency_ms=1.0,
                user_pseudonym="13812345678",  # Raw phone number must be blocked!
            )
        self.assertEqual(ctx_pii.exception.code, "TELEMETRY_PII_LEAK_BLOCKED")

        # 11. Request verifiable deletion via POST /v1/privacy/deletion-requests
        st_del, del_receipt = self._http("POST", "/v1/privacy/deletion-requests", {}, token=token)
        self.assertEqual(st_del, 202)
        self.assertEqual(del_receipt["state"], "COMPLETED")


if __name__ == "__main__":
    unittest.main()
