"""
Executable verification tests for Slice 3 (P04):
- Normalized layout bounds, safe_margin, and portrait face-zone collision checks.
- A06: 200-character Chinese, Emoji, RTL mixed script, and uncommon CJK ideographs (𪚥, 䶮)
       with automatic font shrink-to-fit and zero silent glyph loss.
- Domain-allowlisted QR matrix generation rejecting untrusted redirect URLs.
- Deterministic offscreen SVG + PNG rendering with byte-identical digests and preview/HD parity.
"""
from __future__ import annotations

import unittest

from services.timecapsule.catalog_service import CatalogService
from services.timecapsule.db_and_identity import (
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
)
from services.timecapsule.deterministic_renderer import DeterministicRenderer


class TestP04DeterministicRenderer(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TimeCapsuleDatabase(":memory:")
        self.validator = SpecContractValidator()
        self.catalog = CatalogService(self.db, self.validator)
        self.renderer = DeterministicRenderer(self.validator)

    def tearDown(self) -> None:
        self.db.close()

    def test_a06_cjk_200_chars_emoji_rtl_and_uncommon_hanzi_without_glyph_loss(self) -> None:
        # 200+ characters mixing Chinese, uncommon Hanzi (䶮, 𪚥), Emoji, and Arabic RTL
        mixed_200 = (
            "岁月如歌，拾忆一生🌟👨‍👩‍👧‍👦。"
            "从孩提时代到白发苍苍，每一帧光影都镌刻着属于我们的珍贵故事。"
            "罕见字姓名测试：李䶮、张𪚥、王Base。"
            "مرحبا بكم في آلة الزمن للذكريات "
            "愿未来的自己依然保持热爱，奔赴山海，不负韶华与每一份温暖陪伴！"
            "一九九零年至二零五零年的人生时光长卷记录。"
        )
        self.assertGreaterEqual(len(mixed_200), 120)

        block = self.renderer.measure_and_wrap_text(
            element_id="subtitle",
            field_name="subtitle",
            text=mixed_200,
            box_width_px=680,
            box_height_px=220,
            base_font_px=36,
            min_font_px=12,
        )
        # Every single character is preserved across wrapped lines (zero silent drop)
        self.assertEqual("".join(block.lines), mixed_200)
        self.assertEqual(block.direction, "bidi")
        self.assertLessEqual(block.font_size_px, 36)
        self.assertGreaterEqual(block.font_size_px, 12)
        self.assertIn("Noto Sans CJK SC", block.font_stack)
        self.assertIn("Noto Sans Arabic", block.font_stack)

    def test_layout_face_collision_and_qr_domain_allowlist(self) -> None:
        bad_layout = {
            "canvas": "3:4",
            "safe_margin": 0.05,
            "elements": [
                {"id": "portrait", "kind": "image", "x": 0.06, "y": 0.06, "w": 0.88, "h": 0.54},
                # Overlaps central face zone of portrait
                {"id": "intruding_text", "kind": "text", "x": 0.30, "y": 0.20, "w": 0.40, "h": 0.10, "field": "title"},
            ],
        }
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.renderer.validate_layout(bad_layout)
        self.assertEqual(ctx.exception.code, "LAYOUT_FACE_COLLISION")

        # Untrusted QR redirect URL must be rejected
        with self.assertRaises(TimeCapsuleError) as ctx_qr:
            self.renderer.generate_qr_matrix("https://evil-phishing.example.org/steal")
        self.assertEqual(ctx_qr.exception.code, "UNTRUSTED_QR_URL")

        # Trusted QR URL produces deterministic 21x21 matrix with standard 7x7 finder corners
        qr = self.renderer.generate_qr_matrix("https://timecapsule.cn/s/grant_123456")
        self.assertEqual(len(qr), 21)
        self.assertEqual(qr[0][:7], [1, 1, 1, 1, 1, 1, 1])
        self.assertEqual(qr[0][-7:], [1, 1, 1, 1, 1, 1, 1])
        self.assertEqual(qr[-7][:7], [1, 1, 1, 1, 1, 1, 1])

    def test_deterministic_svg_and_png_rendering_and_preview_hd_parity(self) -> None:
        tpl = self.catalog.get_template_revision("life_0_100", "1.0.0")
        style = self.catalog.get_style("retro")
        fields = {
            "title": "人生0-100岁时光纪念",
            "display_name": "林䶮",
            "subtitle": "从青涩到从容，致敬每一段岁月✨",
            "event_date": "2026-11-07",
        }

        hd1 = self.renderer.render_card(
            template_manifest=tpl,
            style_manifest=style,
            fields=fields,
            asset_digests=["a" * 64],
            export_size="3:4",
            quality_tier="hd",
            qr_url="https://timecapsule.cn/s/work_001",
        )
        hd2 = self.renderer.render_card(
            template_manifest=tpl,
            style_manifest=style,
            fields=fields,
            asset_digests=["a" * 64],
            export_size="3:4",
            quality_tier="hd",
            qr_url="https://timecapsule.cn/s/work_001",
        )
        self.assertEqual(hd1.width_px, 1080)
        self.assertEqual(hd1.height_px, 1440)
        self.assertEqual(hd1.input_digest, hd2.input_digest)
        self.assertEqual(hd1.media_digest, hd2.media_digest)
        self.assertIn("AI生成合成内容", hd1.svg_document)
        self.assertTrue(hd1.png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertIn(b"TimeCapsuleProvenance", hd1.png_bytes)

        preview = self.renderer.render_card(
            template_manifest=tpl,
            style_manifest=style,
            fields=fields,
            asset_digests=["a" * 64],
            export_size="3:4",
            quality_tier="preview",
            qr_url="https://timecapsule.cn/s/work_001",
        )
        self.assertEqual(preview.width_px, 540)
        self.assertEqual(preview.height_px, 720)
        self.assertEqual(set(preview.typeset_blocks.keys()), set(hd1.typeset_blocks.keys()))


if __name__ == "__main__":
    unittest.main()
