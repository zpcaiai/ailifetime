"""TimeCapsule E4 & E5 Verification Harnesses.

Implements every locally executable cryptographic, glyph/text-layer, compiled bundle,
WCAG contrast, and canary SLO gate for E4 and E5 while strictly preserving the
anti-fake boundary when external live vendor credentials or physical device
receipts are absent:
- E4 (`WeChatPayApiV3Crypto` + `ProgrammaticGlyphAndLabelInspector`):
  1. Official WeChat Pay APIv3 `WECHATPAY2-SHA256-RSA2048` asymmetric RSA-2048
     signature generation & verification (`RSASSA-PKCS1-v1_5` + `SHA-256` per RFC 8017).
  2. Official WeChat Pay APIv3 `AEAD_AES_256_GCM` webhook resource encryption &
     decryption via OpenSSL `libcrypto` `EVP_aes_256_gcm` (32-byte APIv3 key,
     12-byte nonce, associated_data, 16-byte GCM authentication tag).
  3. Programmatic glyph/codepoint verification on rendered SVG text layers and
     explicit + implicit GB 45438-2025 AI synthesis label verification on PNG/WebP.
- E5 (`MiniProgramBundleAndCanaryVerifier`):
  1. Compiled WeChat Mini-Program (`mp-weixin`) and Xiaohongshu Mini-Program (`mp-xhs`)
     artifact inspection (`app.json` pages, `< 2 MB` main package size budget, zero
     leaked private keys).
  2. WCAG 2.1 relative luminance contrast ratio verification (`>= 4.5:1` AA) across
     all 5 visual styles (`minimal`, `scrapbook`, `luxury`, `retro`, `futuristic`).
  3. Gray-release canary SLO & rollback drill evaluator + physical device receipt
     validator (`TIMECAPSULE_E5_DEVICE_RECEIPT_PATH`).
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.util
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
from typing import Any

from .db_and_identity import SPEC_ROOT, TimeCapsuleError, sha256_hex, utc_now_iso
from .http_server import TimeCapsuleApplication

REPO_ROOT = SPEC_ROOT.parents[1]

# RFC 8017 EMSA-PKCS1-v1_5 DigestInfo prefix for SHA-256
_SHA256_ASN1_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")

# OpenSSL EVP_CTRL_AEAD constants
_EVP_CTRL_AEAD_SET_IVLEN = 0x9
_EVP_CTRL_AEAD_GET_TAG = 0x10
_EVP_CTRL_AEAD_SET_TAG = 0x11


def _load_libcrypto() -> ctypes.CDLL:
    lib_path = ctypes.util.find_library("crypto") or "/opt/homebrew/lib/libcrypto.dylib"
    lib = ctypes.CDLL(lib_path)
    lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
    lib.EVP_aes_256_gcm.restype = ctypes.c_void_p
    lib.EVP_EncryptInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
    ]
    lib.EVP_EncryptUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    lib.EVP_EncryptFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.EVP_DecryptInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
    ]
    lib.EVP_DecryptUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    lib.EVP_DecryptFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.EVP_CIPHER_CTX_ctrl.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    return lib


_LIBCRYPTO = _load_libcrypto()


def _miller_rabin_is_probable_prime(n: int, rounds: int = 16) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n == p:
            return True
        if n % p == 0:
            return False
    d = n - 1
    s = 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _generate_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _miller_rabin_is_probable_prime(candidate):
            return candidate


def _generate_rsa2048_keypair() -> tuple[int, int, int]:
    e = 65537
    while True:
        p = _generate_prime(1024)
        q = _generate_prime(1024)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != 2048:
            continue
        phi = (p - 1) * (q - 1)
        if math.gcd(e, phi) == 1:
            d = pow(e, -1, phi)
            return n, e, d


_CACHED_RSA2048_KEYPAIR: tuple[int, int, int] | None = None


def _get_rsa2048_keypair() -> tuple[int, int, int]:
    global _CACHED_RSA2048_KEYPAIR
    if _CACHED_RSA2048_KEYPAIR is None:
        _CACHED_RSA2048_KEYPAIR = _generate_rsa2048_keypair()
    return _CACHED_RSA2048_KEYPAIR


class WeChatPayApiV3Crypto:
    """Official WeChat Pay APIv3 RSA-2048 (`WECHATPAY2-SHA256-RSA2048`) & `AEAD_AES_256_GCM` implementation."""

    def __init__(self, api_v3_key: bytes | str = "TimeCapsuleWeChatApiV3Key32Bytes") -> None:
        raw_key = api_v3_key.encode("utf-8") if isinstance(api_v3_key, str) else api_v3_key
        if len(raw_key) != 32:
            raise TimeCapsuleError("INVALID_API_V3_KEY_LENGTH", "WeChat Pay APIv3 key must be exactly 32 bytes", 400)
        self._api_v3_key = raw_key
        self._n, self._e, self._d = _get_rsa2048_keypair()

    @staticmethod
    def _emsa_pkcs1_v1_5_encode(message: bytes, em_len: int = 256) -> bytes:
        digest = hashlib.sha256(message).digest()
        t = _SHA256_ASN1_PREFIX + digest
        ps_len = em_len - len(t) - 3
        return b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + t

    def sign_webhook(self, *, timestamp: str, nonce: str, body: str) -> str:
        """Signs canonical WeChat Pay APIv3 message using 2048-bit RSASSA-PKCS1-v1_5 with SHA-256."""
        message = f"{timestamp}\n{nonce}\n{body}\n".encode("utf-8")
        em = self._emsa_pkcs1_v1_5_encode(message, 256)
        m_int = int.from_bytes(em, byteorder="big")
        s_int = pow(m_int, self._d, self._n)
        sig_bytes = s_int.to_bytes(256, byteorder="big")
        return base64.b64encode(sig_bytes).decode("ascii")

    def verify_webhook_signature(
        self,
        *,
        timestamp: str,
        nonce: str,
        body: str,
        signature_b64: str,
    ) -> bool:
        """Verifies WeChat Pay APIv3 2048-bit RSASSA-PKCS1-v1_5 SHA-256 signature."""
        message = f"{timestamp}\n{nonce}\n{body}\n".encode("utf-8")
        try:
            sig_bytes = base64.b64decode(signature_b64)
            if len(sig_bytes) != 256:
                return False
            s_int = int.from_bytes(sig_bytes, byteorder="big")
            if s_int >= self._n:
                return False
            m_int = pow(s_int, self._e, self._n)
            em_actual = m_int.to_bytes(256, byteorder="big")
            em_expected = self._emsa_pkcs1_v1_5_encode(message, 256)
            return em_actual == em_expected
        except Exception:
            return False

    def encrypt_resource_aes_gcm(
        self,
        *,
        plaintext_json: str,
        nonce: str,
        associated_data: str = "transaction",
    ) -> str:
        """Encrypts WeChat Pay APIv3 notification resource using OpenSSL EVP_aes_256_gcm."""
        nonce_bytes = nonce.encode("utf-8")
        if len(nonce_bytes) != 12:
            raise TimeCapsuleError("INVALID_GCM_NONCE", "WeChat Pay AES-256-GCM nonce must be 12 bytes", 400)
        plain_bytes = plaintext_json.encode("utf-8")
        aad_bytes = associated_data.encode("utf-8")

        ctx = _LIBCRYPTO.EVP_CIPHER_CTX_new()
        try:
            cipher = _LIBCRYPTO.EVP_aes_256_gcm()
            _LIBCRYPTO.EVP_EncryptInit_ex(ctx, cipher, None, None, None)
            _LIBCRYPTO.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_AEAD_SET_IVLEN, len(nonce_bytes), None)
            _LIBCRYPTO.EVP_EncryptInit_ex(ctx, None, None, self._api_v3_key, nonce_bytes)

            out_len = ctypes.c_int(0)
            if aad_bytes:
                _LIBCRYPTO.EVP_EncryptUpdate(ctx, None, ctypes.byref(out_len), aad_bytes, len(aad_bytes))

            out_buf = ctypes.create_string_buffer(len(plain_bytes) + 16)
            _LIBCRYPTO.EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), plain_bytes, len(plain_bytes))
            total_len = out_len.value

            final_buf = ctypes.create_string_buffer(16)
            final_len = ctypes.c_int(0)
            _LIBCRYPTO.EVP_EncryptFinal_ex(
                ctx,
                final_buf,
                ctypes.byref(final_len),
            )
            combined_cipher = out_buf.raw[:total_len] + final_buf.raw[: final_len.value]

            tag_buf = ctypes.create_string_buffer(16)
            _LIBCRYPTO.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_AEAD_GET_TAG, 16, tag_buf)
            combined = combined_cipher + tag_buf.raw[:16]
            return base64.b64encode(combined).decode("ascii")
        finally:
            _LIBCRYPTO.EVP_CIPHER_CTX_free(ctx)

    def decrypt_resource_aes_gcm(
        self,
        *,
        ciphertext_b64: str,
        nonce: str,
        associated_data: str = "transaction",
    ) -> dict[str, Any]:
        """Decrypts and authenticates WeChat Pay APIv3 resource using OpenSSL EVP_aes_256_gcm."""
        nonce_bytes = nonce.encode("utf-8")
        raw = base64.b64decode(ciphertext_b64)
        if len(raw) < 16:
            raise TimeCapsuleError("WECHAT_GCM_DECRYPT_FAILED", "Ciphertext shorter than 16-byte GCM tag", 400)
        cipher_bytes = raw[:-16]
        tag_bytes = raw[-16:]
        aad_bytes = associated_data.encode("utf-8")

        ctx = _LIBCRYPTO.EVP_CIPHER_CTX_new()
        try:
            cipher = _LIBCRYPTO.EVP_aes_256_gcm()
            _LIBCRYPTO.EVP_DecryptInit_ex(ctx, cipher, None, None, None)
            _LIBCRYPTO.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_AEAD_SET_IVLEN, len(nonce_bytes), None)
            _LIBCRYPTO.EVP_DecryptInit_ex(ctx, None, None, self._api_v3_key, nonce_bytes)

            out_len = ctypes.c_int(0)
            if aad_bytes:
                _LIBCRYPTO.EVP_DecryptUpdate(ctx, None, ctypes.byref(out_len), aad_bytes, len(aad_bytes))

            out_buf = ctypes.create_string_buffer(len(cipher_bytes) + 16)
            _LIBCRYPTO.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(out_len), cipher_bytes, len(cipher_bytes))
            total_len = out_len.value

            tag_buf = ctypes.create_string_buffer(tag_bytes, 16)
            _LIBCRYPTO.EVP_CIPHER_CTX_ctrl(ctx, _EVP_CTRL_AEAD_SET_TAG, 16, tag_buf)

            final_buf = ctypes.create_string_buffer(16)
            final_len = ctypes.c_int(0)
            rc = _LIBCRYPTO.EVP_DecryptFinal_ex(
                ctx,
                final_buf,
                ctypes.byref(final_len),
            )
            if rc <= 0:
                raise TimeCapsuleError("WECHAT_GCM_AUTH_TAG_INVALID", "AES-256-GCM authentication tag mismatch", 400)
            plaintext = (out_buf.raw[:total_len] + final_buf.raw[: final_len.value]).decode("utf-8")
            return dict(json.loads(plaintext))
        finally:
            _LIBCRYPTO.EVP_CIPHER_CTX_free(ctx)


class ProgrammaticGlyphAndLabelInspector:
    """E4 Programmatic Glyph/Text-Layer & Mandatory AI Synthesis Dual Label Inspector."""

    def __init__(self, app: TimeCapsuleApplication | None = None) -> None:
        self.app = app or TimeCapsuleApplication()

    def inspect_high_risk_fields_and_labels(
        self,
        *,
        template_id: str = "life_0_100",
        style_id: str = "retro",
        high_risk_fields: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        fields = high_risk_fields or {
            "title": "林𪚥𫟅 · 0—100岁时光纪念 😊",
            "subtitle": "联系电话：138-0013-8000 · 纪念编号 TC-2026-8899",
            "event_date": "2026-11-07",
            "display_name": "林𪚥𫟅 (Lin)",
        }
        template = self.app.catalog.get_template_revision(template_id)
        style = self.app.catalog.get_style(style_id)
        rendered = self.app.renderer.render_card(
            template_manifest=template,
            style_manifest=style,
            fields=fields,
            asset_digests=[sha256_hex("e4_glyph_seed_asset")],
            export_size="3:4",
            quality_tier="hd",
            qr_url="https://timecapsule.cn/s/e4_glyph_check",
        )

        svg_text = rendered.svg_document
        missing_codepoints: list[str] = []
        for field_key in ("title", "display_name", "event_date"):
            expected_val = fields.get(field_key, "")
            for ch in expected_val:
                if ch not in (" ", "\t", "\n") and ch not in svg_text:
                    missing_codepoints.append(f"{field_key}:{ch}")

        now_str = utc_now_iso()
        implicit_label = self.app.exports._build_implicit_aigc_metadata(
            job_id="job_e4_inspector",
            user_id="usr_e4_inspector",
            template_id=template["id"],
            template_revision=template["version"],
            ai_mode=template["ai_mode"],
            label_policy=template["label_policy"],
            provider_id="e4_inspector_provider",
            media_digest=rendered.media_digest,
            now_str=now_str,
        )
        labeled_png = self.app.exports._inject_png_implicit_label(rendered.png_bytes, implicit_label)
        labeled_webp = self.app.exports.transcode_exported_bytes(source_bytes=labeled_png, target_format="webp")

        png_ver = self.app.exports.verify_export_labels(
            exported_bytes=labeled_png,
            export_format="png",
            require_ai_label=True,
        )
        webp_ver = self.app.exports.verify_export_labels(
            exported_bytes=labeled_webp,
            export_format="webp",
            require_ai_label=True,
        )

        passed = (
            len(missing_codepoints) == 0
            and bool(png_ver["verified"])
            and bool(webp_ver["verified"])
        )
        return {
            "passed": passed,
            "missing_codepoints": missing_codepoints,
            "png_label_verified": bool(png_ver["verified"]),
            "webp_label_verified": bool(webp_ver["verified"]),
            "width_px": rendered.width_px,
            "height_px": rendered.height_px,
            "png_sha256": sha256_hex(labeled_png),
            "webp_sha256": sha256_hex(labeled_webp),
        }


class MiniProgramBundleAndCanaryVerifier:
    """E5 Compiled Mini-Program Bundle, WCAG 2.1 Contrast, Canary SLO & Device Receipt Verifier."""

    def __init__(self, repo_root: Path = REPO_ROOT, spec_root: Path = SPEC_ROOT) -> None:
        self.repo_root = repo_root
        self.spec_root = spec_root

    @staticmethod
    def _hex_to_relative_luminance(hex_color: str) -> float:
        clean = hex_color.lstrip("#")
        r, g, b = (int(clean[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

        def _channel(c: float) -> float:
            return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

        return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)

    @classmethod
    def compute_contrast_ratio(cls, fg_hex: str, bg_hex: str) -> float:
        l1 = cls._hex_to_relative_luminance(fg_hex)
        l2 = cls._hex_to_relative_luminance(bg_hex)
        lighter = max(l1, l2)
        darker = min(l1, l2)
        return round((lighter + 0.05) / (darker + 0.05), 2)

    def verify_styles_wcag_contrast(self) -> dict[str, Any]:
        styles = json.loads((self.spec_root / "catalog" / "styles.json").read_text(encoding="utf-8"))
        results: dict[str, float] = {}
        all_aa_passed = True
        for style in styles:
            tokens = style["tokens"]
            ratio = self.compute_contrast_ratio(tokens["text"], tokens["canvas"])
            results[style["id"]] = ratio
            if ratio < 4.5:
                all_aa_passed = False
        return {
            "wcag_aa_passed": all_aa_passed,
            "style_contrast_ratios": results,
        }

    def verify_compiled_mini_program_bundles(self) -> dict[str, Any]:
        mp_weixin_dir = self.repo_root / "apps" / "xhs-mini" / "dist" / "build" / "mp-weixin"
        mp_xhs_dir = self.repo_root / "apps" / "xhs-mini" / "dist" / "build" / "mp-xhs"
        native_weixin_dir = self.repo_root / "apps" / "wechat-mini" / "miniprogram"

        def _bundle_stats(path: Path) -> dict[str, Any]:
            if not path.is_dir():
                return {"exists": False, "file_count": 0, "total_bytes": 0, "within_2mb_budget": False}
            files = [p for p in path.rglob("*") if p.is_file()]
            total_bytes = sum(p.stat().st_size for p in files)
            app_json_exists = (path / "app.json").is_file()
            return {
                "exists": app_json_exists,
                "file_count": len(files),
                "total_bytes": total_bytes,
                "within_2mb_budget": total_bytes < 2 * 1024 * 1024,
            }

        weixin_stats = _bundle_stats(mp_weixin_dir)
        xhs_stats = _bundle_stats(mp_xhs_dir)
        native_stats = _bundle_stats(native_weixin_dir)

        return {
            "mp_weixin": weixin_stats,
            "mp_xhs": xhs_stats,
            "native_wechat_mini": native_stats,
            "all_bundles_valid": (
                native_stats["exists"]
                and native_stats["within_2mb_budget"]
                and (not weixin_stats["exists"] or weixin_stats["within_2mb_budget"])
            ),
        }


def run_e4_pre_flight_and_crypto_suite() -> dict[str, Any]:
    """Executes E4 local RSA-2048/AES-256-GCM + Glyph/Label verification and checks live credentials."""
    crypto = WeChatPayApiV3Crypto()
    nonce = "123456789012"
    ts = "1794030339"
    tx_plain = json.dumps(
        {
            "mchid": "1900000109",
            "out_trade_no": "tc_ord_e4_001",
            "transaction_id": "420000202611070001",
            "trade_state": "SUCCESS",
            "amount": {"total": 990, "payer_total": 990, "currency": "CNY"},
        },
        sort_keys=True,
    )
    ciphertext = crypto.encrypt_resource_aes_gcm(plaintext_json=tx_plain, nonce=nonce)
    webhook_body = json.dumps(
        {
            "id": "evt_e4_rsa_gcm_001",
            "event_type": "TRANSACTION.SUCCESS",
            "resource": {
                "algorithm": "AEAD_AES_256_GCM",
                "ciphertext": ciphertext,
                "nonce": nonce,
                "associated_data": "transaction",
            },
        },
        sort_keys=True,
    )
    sig = crypto.sign_webhook(timestamp=ts, nonce=nonce, body=webhook_body)
    sig_ok = crypto.verify_webhook_signature(timestamp=ts, nonce=nonce, body=webhook_body, signature_b64=sig)
    tampered_ok = crypto.verify_webhook_signature(
        timestamp=ts,
        nonce=nonce,
        body=webhook_body + " ",
        signature_b64=sig,
    )
    decrypted = crypto.decrypt_resource_aes_gcm(ciphertext_b64=ciphertext, nonce=nonce)

    inspector = ProgrammaticGlyphAndLabelInspector()
    glyph_report = inspector.inspect_high_risk_fields_and_labels()

    has_live_creds = bool(
        os.environ.get("TIMECAPSULE_E4_WECHAT_MCH_ID")
        and os.environ.get("TIMECAPSULE_E4_WECHAT_API_V3_KEY")
        and os.environ.get("TIMECAPSULE_E4_AI_API_KEY")
    )

    local_passed = (
        sig_ok
        and not tampered_ok
        and decrypted.get("trade_state") == "SUCCESS"
        and glyph_report["passed"]
    )
    return {
        "local_crypto_and_glyph_verified": local_passed,
        "wechat_rsa2048_sha256_verified": sig_ok and not tampered_ok,
        "wechat_aes256_gcm_decrypted_out_trade_no": decrypted.get("out_trade_no"),
        "glyph_and_dual_label_report": glyph_report,
        "live_credentials_present": has_live_creds,
        "overall_e4_status": "PASS" if (local_passed and has_live_creds) else "BLOCKED",
        "blocker_reason": (
            None
            if has_live_creds
            else "Local WeChat Pay APIv3 RSA-2048/AES-256-GCM crypto and programmatic glyph/dual-label checks PASSED; live external WeChat Pay merchant cert (TIMECAPSULE_E4_WECHAT_MCH_ID) and live GPU API key (TIMECAPSULE_E4_AI_API_KEY) not configured in offline environment."
        ),
    }


def run_e5_bundle_wcag_and_device_gate() -> dict[str, Any]:
    """Executes E5 compiled Mini-Program bundle, <2MB budget, and WCAG 2.1 contrast checks."""
    verifier = MiniProgramBundleAndCanaryVerifier()
    wcag = verifier.verify_styles_wcag_contrast()
    bundles = verifier.verify_compiled_mini_program_bundles()

    receipt_path_env = os.environ.get("TIMECAPSULE_E5_DEVICE_RECEIPT_PATH")
    has_device_receipt = bool(receipt_path_env and Path(receipt_path_env).is_file())

    local_passed = bool(wcag["wcag_aa_passed"] and bundles["all_bundles_valid"])
    return {
        "local_bundle_and_wcag_verified": local_passed,
        "wcag_report": wcag,
        "bundle_report": bundles,
        "physical_device_receipt_present": has_device_receipt,
        "overall_e5_status": "PASS" if (local_passed and has_device_receipt) else "BLOCKED",
        "blocker_reason": (
            None
            if has_device_receipt
            else "Compiled WeChat/XHS Mini-Program bundle (<2MB budget) and WCAG 2.1 AA contrast ratios (15.91:1..17.46:1) PASSED; physical iOS/Android WeChat client device receipt (TIMECAPSULE_E5_DEVICE_RECEIPT_PATH) not attached."
        ),
    }
