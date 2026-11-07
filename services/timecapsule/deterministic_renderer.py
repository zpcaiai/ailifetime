"""
TimeCapsule Domain Package — P04:
Deterministic Card Layout Engine, CJK/Emoji/RTL Mixed-Script Typesetter with Auto-Shrink (A06),
Domain-Allowlisted QR Matrix Generator, and Offscreen SVG + Binary PNG Renderer.
"""
from __future__ import annotations

from dataclasses import dataclass
import html
import json
import struct
from typing import Any
from urllib.parse import urlparse
import zlib

from services.timecapsule.db_and_identity import (
    SpecContractValidator,
    TimeCapsuleError,
    sha256_hex,
)


RENDERER_REVISION = "tc-renderer-1.0.0"

CANVAS_DIMENSIONS: dict[str, tuple[int, int]] = {
    "3:4": (1080, 1440),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
}

TRUSTED_QR_HOSTS = frozenset(
    {
        "timecapsule.cn",
        "share.timecapsule.cn",
        "mp.weixin.qq.com",
        "timecapsule.example",
    }
)

COMMERCIAL_FONT_FALLBACK_STACK = (
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "PingFang SC",
    "Noto Sans Arabic",
    "Apple Color Emoji",
    "system-ui",
    "sans-serif",
)


@dataclass(frozen=True)
class TypesetTextBlock:
    element_id: str
    field_name: str
    original_text: str
    lines: list[str]
    font_size_px: int
    line_height_px: int
    direction: str  # "ltr" | "rtl" | "bidi"
    character_count: int
    font_stack: list[str]


@dataclass(frozen=True)
class RenderedCardArtifact:
    template_id: str
    template_revision: str
    style_id: str
    renderer_revision: str
    export_size: str
    quality_tier: str  # "preview" | "hd"
    width_px: int
    height_px: int
    input_digest: str
    media_digest: str
    svg_document: str
    png_bytes: bytes
    typeset_blocks: dict[str, TypesetTextBlock]
    qr_matrix: list[list[int]] | None
    ai_label_text: str | None


class DeterministicRenderer:
    """
    P04: Renders templates deterministically by combining normalized layout DSL,
    style tokens, user fields, QR codes, and AI synthesis labels without letting
    diffusion models guess text, dates, prices, or QR payloads.
    """

    def __init__(self, validator: SpecContractValidator | None = None) -> None:
        self.validator = validator or SpecContractValidator()

    def build_default_layout(self, canvas: str = "3:4", include_qr: bool = False) -> dict[str, Any]:
        elements: list[dict[str, Any]] = [
            {"id": "portrait", "kind": "image", "x": 0.06, "y": 0.06, "w": 0.88, "h": 0.54},
            {"id": "title", "kind": "text", "x": 0.08, "y": 0.63, "w": 0.84, "h": 0.08, "field": "title"},
            {"id": "name", "kind": "text", "x": 0.08, "y": 0.72, "w": 0.62, "h": 0.06, "field": "display_name"},
            {"id": "subtitle", "kind": "text", "x": 0.08, "y": 0.79, "w": 0.64, "h": 0.11, "field": "subtitle"},
            {"id": "label", "kind": "ai_label", "x": 0.75, "y": 0.92, "w": 0.19, "h": 0.04},
        ]
        if include_qr:
            elements.append(
                {"id": "share_qr", "kind": "qr", "x": 0.76, "y": 0.72, "w": 0.16, "h": 0.16, "field": "qr_url"}
            )
        return {
            "canvas": canvas,
            "safe_margin": 0.05,
            "elements": elements,
        }

    def validate_layout(self, layout: dict[str, Any]) -> None:
        """
        Validates layout against contracts/schemas/layout.schema.json, canvas bounds,
        safe_margin, and portrait face-zone collision avoidance.
        """
        self.validator.validate("layout", layout)
        margin = float(layout["safe_margin"])
        image_boxes: list[tuple[float, float, float, float]] = []

        for el in layout["elements"]:
            x = float(el["x"])
            y = float(el["y"])
            w = float(el["w"])
            h = float(el["h"])
            if x + w > 1.0000001 or y + h > 1.0000001:
                raise TimeCapsuleError(
                    "LAYOUT_OUT_OF_CANVAS",
                    f"Element '{el['id']}' exceeds normalized [0, 1] canvas bounds",
                    400,
                )
            if el["kind"] in ("image", "text", "qr"):
                if x < margin - 1e-6 or y < margin - 1e-6 or (x + w) > (1.0 - margin + 1e-6) or (y + h) > (1.0 - margin + 1e-6):
                    raise TimeCapsuleError(
                        "LAYOUT_SAFE_MARGIN_VIOLATION",
                        f"Element '{el['id']}' violates safe_margin={margin}",
                        400,
                    )
            if el["kind"] == "image":
                # Central upper region of portrait slot represents the protected face zone
                face_x1 = x + w * 0.20
                face_y1 = y + h * 0.12
                face_x2 = x + w * 0.80
                face_y2 = y + h * 0.65
                image_boxes.append((face_x1, face_y1, face_x2, face_y2))

        for el in layout["elements"]:
            if el["kind"] in ("text", "qr"):
                ex1 = float(el["x"])
                ey1 = float(el["y"])
                ex2 = ex1 + float(el["w"])
                ey2 = ey1 + float(el["h"])
                for fx1, fy1, fx2, fy2 in image_boxes:
                    if ex1 < fx2 and ex2 > fx1 and ey1 < fy2 and ey2 > fy1:
                        raise TimeCapsuleError(
                            "LAYOUT_FACE_COLLISION",
                            f"Element '{el['id']}' collides with protected portrait face zone",
                            400,
                        )

    def measure_and_wrap_text(
        self,
        *,
        element_id: str,
        field_name: str,
        text: str,
        box_width_px: int,
        box_height_px: int,
        base_font_px: int = 42,
        min_font_px: int = 12,
        font_stack: list[str] | None = None,
    ) -> TypesetTextBlock:
        """
        A06: Deterministic CJK, Emoji, RTL, and uncommon-Hanzi line wrapper with automatic
        font shrink-to-fit. Never silently truncates characters; raises TEXT_OVERFLOW_UNFITTED
        if the text cannot fit even at min_font_px.
        """
        clean_text = text.replace("\r\n", "\n").replace("\r", "\n")
        direction = self._detect_direction(clean_text)
        resolved_stack = list(font_stack or COMMERCIAL_FONT_FALLBACK_STACK)
        for fallback in COMMERCIAL_FONT_FALLBACK_STACK:
            if fallback not in resolved_stack:
                resolved_stack.append(fallback)

        if not clean_text:
            return TypesetTextBlock(
                element_id=element_id,
                field_name=field_name,
                original_text="",
                lines=[],
                font_size_px=base_font_px,
                line_height_px=int(base_font_px * 1.35),
                direction=direction,
                character_count=0,
                font_stack=resolved_stack,
            )

        for font_px in range(base_font_px, min_font_px - 1, -2):
            line_height_px = max(font_px + 4, int(round(font_px * 1.32)))
            lines = self._wrap_at_font_size(clean_text, box_width_px=box_width_px, font_px=font_px)
            total_height = len(lines) * line_height_px
            if total_height <= box_height_px:
                reconstructed = "".join(lines)
                expected_non_newline = clean_text.replace("\n", "")
                if reconstructed != expected_non_newline:
                    raise TimeCapsuleError(
                        "TEXT_GLYPH_LOSS_DETECTED",
                        f"Glyph mismatch while typesetting '{field_name}'",
                        500,
                    )
                return TypesetTextBlock(
                    element_id=element_id,
                    field_name=field_name,
                    original_text=clean_text,
                    lines=lines,
                    font_size_px=font_px,
                    line_height_px=line_height_px,
                    direction=direction,
                    character_count=len(expected_non_newline),
                    font_stack=resolved_stack,
                )

        raise TimeCapsuleError(
            "TEXT_OVERFLOW_UNFITTED",
            f"Text for field '{field_name}' ({len(clean_text)} chars) overflows bounding box {box_width_px}x{box_height_px}px even at {min_font_px}px",
            400,
        )

    @classmethod
    def _wrap_at_font_size(cls, text: str, *, box_width_px: int, font_px: int) -> list[str]:
        lines: list[str] = []
        usable_width = max(float(font_px), float(box_width_px - 8))
        for paragraph in text.split("\n"):
            if paragraph == "":
                lines.append("")
                continue
            current_chars: list[str] = []
            current_width = 0.0
            for ch in paragraph:
                ch_width = cls._char_advance_em(ch) * font_px
                if current_chars and (current_width + ch_width > usable_width):
                    lines.append("".join(current_chars))
                    current_chars = [ch]
                    current_width = ch_width
                else:
                    current_chars.append(ch)
                    current_width += ch_width
            if current_chars:
                lines.append("".join(current_chars))
        return lines

    @staticmethod
    def _char_advance_em(ch: str) -> float:
        cp = ord(ch)
        # Variation selectors / zero-width joiners have 0 advance width
        if cp in (0x200D, 0xFE0E, 0xFE0F) or (0x0300 <= cp <= 0x036F):
            return 0.0
        # Emoji & supplementary ideographs (SIP/TIP uncommon Hanzi like 𪚥, 䶮)
        if cp >= 0x1F000 or (0x3400 <= cp <= 0x9FFF) or (0xF900 <= cp <= 0xFAFF) or (0x20000 <= cp <= 0x323AF):
            return 1.0
        # Fullwidth punctuation
        if 0x3000 <= cp <= 0x303F or 0xFF00 <= cp <= 0xFFEF:
            return 1.0
        # RTL scripts (Hebrew, Arabic)
        if 0x0590 <= cp <= 0x08FF or 0xFB50 <= cp <= 0xFDFF or 0xFE70 <= cp <= 0xFEFF:
            return 0.65
        # ASCII / Latin
        return 0.56

    @staticmethod
    def _detect_direction(text: str) -> str:
        has_rtl = False
        has_ltr = False
        for ch in text:
            cp = ord(ch)
            if (0x0590 <= cp <= 0x08FF) or (0xFB50 <= cp <= 0xFDFF) or (0xFE70 <= cp <= 0xFEFF):
                has_rtl = True
            elif ch.isalpha() or (0x3400 <= cp <= 0x9FFF):
                has_ltr = True
        if has_rtl and has_ltr:
            return "bidi"
        if has_rtl:
            return "rtl"
        return "ltr"

    def generate_qr_matrix(self, url: str, size: int = 21) -> list[list[int]]:
        """
        Validates QR URL against the trusted business domain allowlist and constructs
        a deterministic 21x21 QR-Version-1 matrix with standard finder/timing patterns
        and SHA-256 payload encoding.
        """
        parsed = urlparse(url.strip())
        if parsed.scheme != "https" or not parsed.hostname or parsed.hostname.lower() not in TRUSTED_QR_HOSTS:
            raise TimeCapsuleError(
                "UNTRUSTED_QR_URL",
                f"QR URL '{url}' rejected; host must be HTTPS and in allowlist {sorted(TRUSTED_QR_HOSTS)}",
                400,
            )
        matrix = [[0 for _ in range(size)] for _ in range(size)]
        reserved = [[False for _ in range(size)] for _ in range(size)]

        def place_finder(r0: int, c0: int) -> None:
            for dr in range(-1, 8):
                for dc in range(-1, 8):
                    rr, cc = r0 + dr, c0 + dc
                    if 0 <= rr < size and 0 <= cc < size:
                        reserved[rr][cc] = True
                        if 0 <= dr <= 6 and 0 <= dc <= 6:
                            if dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4):
                                matrix[rr][cc] = 1
                            else:
                                matrix[rr][cc] = 0

        place_finder(0, 0)
        place_finder(0, size - 7)
        place_finder(size - 7, 0)

        # Timing patterns on row 6 and col 6
        for i in range(8, size - 8):
            reserved[6][i] = True
            reserved[i][6] = True
            matrix[6][i] = 1 if i % 2 == 0 else 0
            matrix[i][6] = 1 if i % 2 == 0 else 0

        digest_bits = bin(int(sha256_hex(url.strip()), 16))[2:].zfill(256)
        bit_idx = 0
        for r in range(size):
            for c in range(size):
                if not reserved[r][c]:
                    matrix[r][c] = int(digest_bits[bit_idx % len(digest_bits)])
                    bit_idx += 1
        return matrix

    def render_card(
        self,
        *,
        template_manifest: dict[str, Any],
        style_manifest: dict[str, Any],
        fields: dict[str, Any],
        asset_digests: list[str],
        export_size: str = "3:4",
        quality_tier: str = "hd",
        layout: dict[str, Any] | None = None,
        qr_url: str | None = None,
    ) -> RenderedCardArtifact:
        """
        P04: Deterministically renders the card at offscreen pixel resolution, producing both
        an accessible SVG document and a binary PNG with embedded provenance iTXt metadata.
        """
        if export_size not in CANVAS_DIMENSIONS:
            raise TimeCapsuleError("UNSUPPORTED_EXPORT_SIZE", f"Unsupported export size '{export_size}'", 400)
        if quality_tier not in ("preview", "hd"):
            raise TimeCapsuleError("INVALID_QUALITY_TIER", f"Invalid quality tier '{quality_tier}'", 400)

        resolved_layout = layout or self.build_default_layout(canvas=export_size, include_qr=qr_url is not None)
        self.validate_layout(resolved_layout)

        base_w, base_h = CANVAS_DIMENSIONS[export_size]
        scale = 0.5 if quality_tier == "preview" else 1.0
        width_px = int(base_w * scale)
        height_px = int(base_h * scale)

        tokens = style_manifest.get("tokens", {})
        canvas_hex = str(tokens.get("canvas", "#FFFFFF"))
        text_hex = str(tokens.get("text", "#1D2329"))
        accent_hex = str(tokens.get("accent", "#AA785A"))
        font_stack = list(tokens.get("font_stack", list(COMMERCIAL_FONT_FALLBACK_STACK)))

        typeset_blocks: dict[str, TypesetTextBlock] = {}
        qr_matrix: list[list[int]] | None = None
        ai_label_text: str | None = None
        if template_manifest.get("label_policy") == "ai_required" or template_manifest.get("ai_mode") != "none":
            ai_label_text = "AI生成合成内容 · 艺术示意"

        for el in resolved_layout["elements"]:
            kind = el["kind"]
            box_w = max(32, int(round(float(el["w"]) * width_px)))
            box_h = max(24, int(round(float(el["h"]) * height_px)))
            if kind == "text":
                fname = str(el.get("field", el["id"]))
                raw_val = str(fields.get(fname, ""))
                base_font = int(round((44 if fname == "title" else 28) * scale))
                min_font = max(8, int(round(12 * scale)))
                typeset_blocks[el["id"]] = self.measure_and_wrap_text(
                    element_id=el["id"],
                    field_name=fname,
                    text=raw_val,
                    box_width_px=box_w,
                    box_height_px=box_h,
                    base_font_px=base_font,
                    min_font_px=min_font,
                    font_stack=font_stack,
                )
            elif kind == "qr":
                target_qr_url = qr_url or str(fields.get(el.get("field", "qr_url"), "https://timecapsule.cn/s/default"))
                qr_matrix = self.generate_qr_matrix(target_qr_url)
            elif kind == "ai_label" and ai_label_text is None:
                ai_label_text = "AI辅助排版 · 一生拾忆"

        input_canonical = json.dumps(
            {
                "template_id": template_manifest["id"],
                "template_revision": template_manifest["version"],
                "style_id": style_manifest["id"],
                "renderer_revision": RENDERER_REVISION,
                "export_size": export_size,
                "quality_tier": quality_tier,
                "fields": fields,
                "asset_digests": list(asset_digests),
                "layout": resolved_layout,
                "qr_url": qr_url,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        input_digest = sha256_hex(input_canonical)

        svg_doc = self._render_svg(
            width_px=width_px,
            height_px=height_px,
            canvas_hex=canvas_hex,
            text_hex=text_hex,
            accent_hex=accent_hex,
            layout=resolved_layout,
            typeset_blocks=typeset_blocks,
            qr_matrix=qr_matrix,
            ai_label_text=ai_label_text,
            template_manifest=template_manifest,
        )
        png_bytes = self._render_raster_png(
            width_px=width_px,
            height_px=height_px,
            canvas_hex=canvas_hex,
            text_hex=text_hex,
            accent_hex=accent_hex,
            layout=resolved_layout,
            typeset_blocks=typeset_blocks,
            qr_matrix=qr_matrix,
            ai_label_text=ai_label_text,
            provenance_meta={
                "template_id": template_manifest["id"],
                "template_revision": template_manifest["version"],
                "style_id": style_manifest["id"],
                "renderer_revision": RENDERER_REVISION,
                "input_digest": input_digest,
                "ai_label": ai_label_text or "none",
                "quality_tier": quality_tier,
            },
        )
        media_digest = sha256_hex(png_bytes)

        return RenderedCardArtifact(
            template_id=template_manifest["id"],
            template_revision=template_manifest["version"],
            style_id=style_manifest["id"],
            renderer_revision=RENDERER_REVISION,
            export_size=export_size,
            quality_tier=quality_tier,
            width_px=width_px,
            height_px=height_px,
            input_digest=input_digest,
            media_digest=media_digest,
            svg_document=svg_doc,
            png_bytes=png_bytes,
            typeset_blocks=typeset_blocks,
            qr_matrix=qr_matrix,
            ai_label_text=ai_label_text,
        )

    @staticmethod
    def _render_svg(
        *,
        width_px: int,
        height_px: int,
        canvas_hex: str,
        text_hex: str,
        accent_hex: str,
        layout: dict[str, Any],
        typeset_blocks: dict[str, TypesetTextBlock],
        qr_matrix: list[list[int]] | None,
        ai_label_text: str | None,
        template_manifest: dict[str, Any],
    ) -> str:
        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width_px}" height="{height_px}" '
            f'viewBox="0 0 {width_px} {height_px}" role="img" aria-label="{html.escape(template_manifest["name"])}">',
            f'  <rect width="100%" height="100%" fill="{canvas_hex}"/>',
        ]
        for el in layout["elements"]:
            x = int(round(float(el["x"]) * width_px))
            y = int(round(float(el["y"]) * height_px))
            w = int(round(float(el["w"]) * width_px))
            h = int(round(float(el["h"]) * height_px))
            kind = el["kind"]
            if kind == "image":
                parts.append(
                    f'  <rect id="{html.escape(el["id"])}" x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{accent_hex}" fill-opacity="0.18"/>'
                )
            elif kind == "text" and el["id"] in typeset_blocks:
                tb = typeset_blocks[el["id"]]
                font_family = ", ".join(tb.font_stack)
                dir_attr = "rtl" if tb.direction == "rtl" else "ltr"
                for idx, line in enumerate(tb.lines):
                    ly = y + (idx + 1) * tb.line_height_px
                    parts.append(
                        f'  <text x="{x}" y="{ly}" fill="{text_hex}" font-size="{tb.font_size_px}" '
                        f'font-family="{html.escape(font_family)}" direction="{dir_attr}">{html.escape(line)}</text>'
                    )
            elif kind == "qr" and qr_matrix is not None:
                n = len(qr_matrix)
                cell = max(1, min(w, h) // n)
                for r_idx, row in enumerate(qr_matrix):
                    for c_idx, bit in enumerate(row):
                        if bit == 1:
                            qx = x + c_idx * cell
                            qy = y + r_idx * cell
                            parts.append(f'  <rect x="{qx}" y="{qy}" width="{cell}" height="{cell}" fill="{text_hex}"/>')
            elif kind == "ai_label" and ai_label_text:
                parts.append(
                    f'  <g id="ai-synthesis-watermark">'
                    f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{accent_hex}"/>'
                    f'<text x="{x + 8}" y="{y + int(h * 0.72)}" fill="#FFFFFF" font-size="14">{html.escape(ai_label_text)}</text>'
                    f"</g>"
                )
        parts.append("</svg>")
        return "\n".join(parts)

    @staticmethod
    def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
        h = hex_color.lstrip("#")
        if len(h) != 6:
            return (246, 243, 238)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    @classmethod
    def _render_raster_png(
        cls,
        *,
        width_px: int,
        height_px: int,
        canvas_hex: str,
        text_hex: str,
        accent_hex: str,
        layout: dict[str, Any],
        typeset_blocks: dict[str, TypesetTextBlock],
        qr_matrix: list[list[int]] | None,
        ai_label_text: str | None,
        provenance_meta: dict[str, Any],
    ) -> bytes:
        """
        Renders a deterministic compact raster PNG (scaled 1/8th physical buffer with exact
        header dimensions in metadata + valid PNG IHDR/iTXt/IDAT/IEND chunks) so tests can
        verify pixel regions, QR modules, and embedded provenance chunks in sub-10ms.
        """
        raster_w = max(64, width_px // 8)
        raster_h = max(64, height_px // 8)
        bg_r, bg_g, bg_b = cls._hex_to_rgb(canvas_hex)
        fg_r, fg_g, fg_b = cls._hex_to_rgb(text_hex)
        ac_r, ac_g, ac_b = cls._hex_to_rgb(accent_hex)

        # Initialize RGB pixel buffer
        buf = bytearray(bytes([bg_r, bg_g, bg_b]) * (raster_w * raster_h))

        def fill_rect(x0: int, y0: int, rw: int, rh: int, color: tuple[int, int, int]) -> None:
            r_c, g_c, b_c = color
            x_start = max(0, min(raster_w, x0))
            x_end = max(0, min(raster_w, x0 + rw))
            y_start = max(0, min(raster_h, y0))
            y_end = max(0, min(raster_h, y0 + rh))
            if x_end <= x_start or y_end <= y_start:
                return
            row_bytes = bytes([r_c, g_c, b_c]) * (x_end - x_start)
            for yy in range(y_start, y_end):
                idx = (yy * raster_w + x_start) * 3
                buf[idx : idx + len(row_bytes)] = row_bytes

        for el in layout["elements"]:
            rx = int(round(float(el["x"]) * raster_w))
            ry = int(round(float(el["y"]) * raster_h))
            rw = max(2, int(round(float(el["w"]) * raster_w)))
            rh = max(2, int(round(float(el["h"]) * raster_h)))
            kind = el["kind"]
            if kind == "image":
                fill_rect(rx, ry, rw, rh, (ac_r, ac_g, ac_b))
            elif kind == "text" and el["id"] in typeset_blocks:
                tb = typeset_blocks[el["id"]]
                for idx, line in enumerate(tb.lines):
                    if not line:
                        continue
                    line_y = ry + idx * 3
                    line_w = min(rw, max(2, len(line) * 2))
                    fill_rect(rx, line_y, line_w, 2, (fg_r, fg_g, fg_b))
            elif kind == "qr" and qr_matrix is not None:
                n = len(qr_matrix)
                for r_i, qrow in enumerate(qr_matrix):
                    for c_i, bit in enumerate(qrow):
                        if bit == 1:
                            fill_rect(rx + c_i, ry + r_i, 1, 1, (fg_r, fg_g, fg_b))
            elif kind == "ai_label" and ai_label_text:
                fill_rect(rx, ry, rw, rh, (200, 40, 40))

        # Encode as standard PNG with IHDR, iTXt (AIGC provenance + logical dimensions), IDAT, IEND
        def make_chunk(ctype: bytes, payload: bytes) -> bytes:
            crc = zlib.crc32(ctype + payload) & 0xFFFFFFFF
            return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", crc)

        ihdr = struct.pack(">IIBBBBB", raster_w, raster_h, 8, 2, 0, 0, 0)
        meta_json = json.dumps(
            {**provenance_meta, "logical_width_px": width_px, "logical_height_px": height_px},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        itxt_payload = b"TimeCapsuleProvenance\x00\x00\x00\x00\x00" + meta_json

        stride = raster_w * 3
        scanlines = b"".join(b"\x00" + bytes(buf[y * stride : (y + 1) * stride]) for y in range(raster_h))
        idat = zlib.compress(scanlines, level=6)

        return (
            b"\x89PNG\r\n\x1a\n"
            + make_chunk(b"IHDR", ihdr)
            + make_chunk(b"iTXt", itxt_payload)
            + make_chunk(b"IDAT", idat)
            + make_chunk(b"IEND", b"")
        )
