"""
TimeCapsule Domain Package — P02:
Template Catalog, Style Token System, Pricing Snapshot Seeding, Field Contract Compiler,
and Versioned Template Lifecycle (ACTIVE / RETIRED / Historical Revision Pinning for A12).
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any
import uuid

from services.timecapsule.db_and_identity import (
    SPEC_ROOT,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    utc_now_iso,
)


class CatalogService:
    """
    P02: Manages the 12 categories, 20 templates, 5 styles (100 combinations),
    and server-side immutable product price snapshots.
    """

    def __init__(
        self,
        db: TimeCapsuleDatabase,
        validator: SpecContractValidator | None = None,
        spec_root: Path = SPEC_ROOT,
    ) -> None:
        self.db = db
        self.validator = validator or SpecContractValidator(spec_root)
        self.spec_root = spec_root
        self._categories: list[dict[str, Any]] = []
        self._styles: dict[str, dict[str, Any]] = {}
        self._pricing_meta: dict[str, Any] = {}
        self.seed_from_spec()

    def seed_from_spec(self, now: datetime | None = None) -> dict[str, int]:
        now_str = utc_now_iso(now)
        categories = json.loads((self.spec_root / "catalog" / "categories.json").read_text(encoding="utf-8"))
        styles = json.loads((self.spec_root / "catalog" / "styles.json").read_text(encoding="utf-8"))
        templates = json.loads((self.spec_root / "catalog" / "templates.json").read_text(encoding="utf-8"))
        pricing = json.loads((self.spec_root / "catalog" / "pricing-experiments.json").read_text(encoding="utf-8"))

        if len(categories) != 12:
            raise TimeCapsuleError("CATALOG_INVALID", f"Expected 12 categories, got {len(categories)}", 500)
        if len(styles) != 5:
            raise TimeCapsuleError("CATALOG_INVALID", f"Expected 5 styles, got {len(styles)}", 500)
        if len(templates) != 20:
            raise TimeCapsuleError("CATALOG_INVALID", f"Expected 20 templates, got {len(templates)}", 500)

        valid_cat_ids = {c["id"] for c in categories}
        self._categories = categories
        self._styles = {s["id"]: s for s in styles}
        self._pricing_meta = pricing

        with self.db.transaction() as conn:
            for tpl in templates:
                self._validate_template_manifest(tpl, valid_cat_ids)
                existing = conn.execute(
                    "SELECT status FROM template_revision WHERE template_id = ? AND revision = ?",
                    (tpl["id"], tpl["version"]),
                ).fetchone()
                if existing is None:
                    conn.execute(
                        """
                        INSERT INTO template_revision (template_id, revision, manifest, status, created_at, version)
                        VALUES (?, ?, ?, 'ACTIVE', ?, 1)
                        """,
                        (
                            tpl["id"],
                            tpl["version"],
                            json.dumps(tpl, ensure_ascii=False, sort_keys=True),
                            now_str,
                        ),
                    )

            # Seed server-side product prices (free, single, bundle) using authoritative snapshot amounts
            default_prices = {
                "free": 0,
                "single": 990,
                "bundle": 2990,
            }
            for plan in pricing.get("plans", []):
                pid = str(plan["id"])
                min_fen = int(plan["min_fen"])
                max_fen = int(plan["max_fen"])
                chosen_fen = default_prices.get(pid, min_fen)
                if not (min_fen <= chosen_fen <= max_fen):
                    chosen_fen = min_fen
                existing_price = conn.execute(
                    "SELECT id FROM product_price WHERE id = ?",
                    (pid,),
                ).fetchone()
                if existing_price is None:
                    conn.execute(
                        "INSERT INTO product_price (id, currency, amount_fen, version) VALUES (?, ?, ?, 1)",
                        (pid, str(pricing.get("currency", "CNY")), chosen_fen),
                    )

        return {
            "categories": len(self._categories),
            "styles": len(self._styles),
            "templates": len(templates),
            "combinations": len(templates) * len(self._styles),
        }

    def _validate_template_manifest(self, manifest: dict[str, Any], valid_cat_ids: set[str] | None = None) -> None:
        self.validator.validate("template", manifest)
        cats = valid_cat_ids or {c["id"] for c in self._categories}
        if manifest["category"] not in cats:
            raise TimeCapsuleError(
                "INVALID_TEMPLATE_CATEGORY",
                f"Template '{manifest['id']}' references unknown category '{manifest['category']}'",
                400,
            )
        if manifest["ai_mode"] != "none" and manifest["label_policy"] != "ai_required":
            raise TimeCapsuleError(
                "AI_LABEL_POLICY_VIOLATION",
                f"Template '{manifest['id']}' uses ai_mode='{manifest['ai_mode']}' and must enforce label_policy='ai_required'",
                400,
            )
        field_names = [f["name"] for f in manifest["fields"]]
        if len(field_names) != len(set(field_names)):
            raise TimeCapsuleError(
                "DUPLICATE_TEMPLATE_FIELDS",
                f"Template '{manifest['id']}' has duplicate field names",
                400,
            )

    def list_catalog(self, *, category: str | None = None, include_retired: bool = False) -> dict[str, Any]:
        sql = "SELECT template_id, revision, manifest, status, created_at FROM template_revision"
        params: list[Any] = []
        if not include_retired:
            sql += " WHERE status = 'ACTIVE'"
        sql += " ORDER BY template_id ASC, revision DESC"
        rows = self.db.query_all(sql, tuple(params))

        templates_out: list[dict[str, Any]] = []
        for row in rows:
            manifest = json.loads(str(row["manifest"]))
            if category and manifest.get("category") != category:
                continue
            templates_out.append(
                {
                    **manifest,
                    "status": str(row["status"]),
                    "created_at": str(row["created_at"]),
                }
            )
        return {
            "categories": list(self._categories),
            "styles": list(self._styles.values()),
            "templates": templates_out,
            "combination_count": len(templates_out) * len(self._styles),
        }

    def get_template_revision(
        self,
        template_id: str,
        revision: str | None = None,
        *,
        allow_retired: bool = False,
    ) -> dict[str, Any]:
        """
        P02 & A12: Resolves a template manifest.
        New jobs require status == 'ACTIVE', whereas historical work re-rendering (A12) sets allow_retired=True
        to load the exact pinned revision manifest even after admin retirement or version upgrade.
        """
        if revision:
            row = self.db.query_one(
                "SELECT template_id, revision, manifest, status FROM template_revision WHERE template_id = ? AND revision = ?",
                (template_id, revision),
            )
        else:
            row = self.db.query_one(
                "SELECT template_id, revision, manifest, status FROM template_revision WHERE template_id = ? AND status = 'ACTIVE' ORDER BY revision DESC LIMIT 1",
                (template_id,),
            )
        if row is None:
            raise TimeCapsuleError(
                "TEMPLATE_NOT_FOUND",
                f"Template '{template_id}' (revision={revision or 'latest'}) not found",
                404,
            )
        if not allow_retired and str(row["status"]) != "ACTIVE":
            raise TimeCapsuleError(
                "TEMPLATE_RETIRED",
                f"Template '{template_id}@{row['revision']}' is {row['status']} and cannot accept new jobs",
                409,
            )
        manifest = json.loads(str(row["manifest"]))
        return {**manifest, "status": str(row["status"])}

    def publish_template_revision(
        self,
        *,
        admin_actor_id: str,
        manifest: dict[str, Any],
        retire_previous: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        self._validate_template_manifest(manifest)
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            if retire_previous:
                conn.execute(
                    "UPDATE template_revision SET status = 'RETIRED', version = version + 1 WHERE template_id = ? AND status = 'ACTIVE'",
                    (manifest["id"],),
                )
            conn.execute(
                """
                INSERT INTO template_revision (template_id, revision, manifest, status, created_at, version)
                VALUES (?, ?, ?, 'ACTIVE', ?, 1)
                """,
                (
                    manifest["id"],
                    manifest["version"],
                    json.dumps(manifest, ensure_ascii=False, sort_keys=True),
                    now_str,
                ),
            )
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, 'PUBLISH_TEMPLATE_REVISION', ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    admin_actor_id,
                    f"{manifest['id']}@{manifest['version']}",
                    json.dumps({"retire_previous": retire_previous}),
                    now_str,
                ),
            )
        return {**manifest, "status": "ACTIVE", "created_at": now_str}

    def retire_template_revision(
        self,
        *,
        admin_actor_id: str,
        template_id: str,
        revision: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        now_str = utc_now_iso(now)
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT version FROM template_revision WHERE template_id = ? AND revision = ?",
                (template_id, revision),
            ).fetchone()
            if row is None:
                raise TimeCapsuleError("TEMPLATE_NOT_FOUND", f"Unknown template {template_id}@{revision}", 404)
            cur = conn.execute(
                "UPDATE template_revision SET status = 'RETIRED', version = version + 1 WHERE template_id = ? AND revision = ? AND version = ?",
                (template_id, revision, int(row["version"])),
            )
            if cur.rowcount != 1:
                raise TimeCapsuleError("CONCURRENT_MODIFICATION", "Template status optimistic lock conflict", 409)
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, action, target_id, details_json, created_at) VALUES (?, ?, 'RETIRE_TEMPLATE_REVISION', ?, '{}', ?)",
                (str(uuid.uuid4()), admin_actor_id, f"{template_id}@{revision}", now_str),
            )
        return {"template_id": template_id, "revision": revision, "status": "RETIRED"}

    def get_style(self, style_id: str) -> dict[str, Any]:
        if style_id not in self._styles:
            raise TimeCapsuleError("STYLE_NOT_FOUND", f"Unknown visual style '{style_id}'", 400)
        return dict(self._styles[style_id])

    def validate_render_request(
        self,
        render_request: dict[str, Any],
        *,
        allow_retired: bool = False,
    ) -> dict[str, Any]:
        """Validates a RenderRequest against render-request.schema.json, style catalog, and template field rules."""
        self.validator.validate("render-request", render_request)
        template = self.get_template_revision(
            render_request["template_id"],
            render_request["template_version"],
            allow_retired=allow_retired,
        )
        style = self.get_style(render_request["style_id"])

        export_size = render_request["export_size"]
        if export_size not in template["sizes"]:
            raise TimeCapsuleError(
                "UNSUPPORTED_EXPORT_SIZE",
                f"Template '{template['id']}' does not support size '{export_size}'; supported: {template['sizes']}",
                400,
            )

        asset_ids = render_request["asset_ids"]
        max_slots = int(template["image_slots"])
        if len(asset_ids) == 0 or len(asset_ids) > max_slots:
            raise TimeCapsuleError(
                "INVALID_ASSET_SLOT_COUNT",
                f"Template '{template['id']}' requires 1..{max_slots} assets, got {len(asset_ids)}",
                400,
            )

        fields_input: dict[str, Any] = render_request.get("fields", {})
        field_specs = {f["name"]: f for f in template["fields"]}
        unknown_fields = set(fields_input.keys()) - set(field_specs.keys())
        if unknown_fields:
            raise TimeCapsuleError(
                "UNKNOWN_TEMPLATE_FIELDS",
                f"Unknown fields for template '{template['id']}': {sorted(unknown_fields)}",
                400,
            )

        for fname, fspec in field_specs.items():
            val = fields_input.get(fname)
            if fspec.get("required") and (val is None or (isinstance(val, str) and not val.strip())):
                raise TimeCapsuleError(
                    "MISSING_REQUIRED_FIELD",
                    f"Field '{fname}' is required for template '{template['id']}'",
                    400,
                )
            if val is None:
                continue
            ftype = fspec["type"]
            if ftype == "text":
                if not isinstance(val, str):
                    raise TimeCapsuleError("INVALID_FIELD_TYPE", f"Field '{fname}' must be text", 400)
                max_len = fspec.get("maxLength")
                if max_len is not None and len(val) > int(max_len):
                    raise TimeCapsuleError(
                        "FIELD_TOO_LONG",
                        f"Field '{fname}' length {len(val)} exceeds maxLength {max_len}",
                        400,
                    )
            elif ftype == "date":
                if not isinstance(val, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", val) is None:
                    raise TimeCapsuleError(
                        "INVALID_DATE_FIELD",
                        f"Field '{fname}' must be YYYY-MM-DD",
                        400,
                    )
            elif ftype == "boolean" and not isinstance(val, bool):
                raise TimeCapsuleError("INVALID_FIELD_TYPE", f"Field '{fname}' must be boolean", 400)
            elif ftype == "number" and (not isinstance(val, (int, float)) or isinstance(val, bool)):
                raise TimeCapsuleError("INVALID_FIELD_TYPE", f"Field '{fname}' must be number", 400)

        return {
            "template": template,
            "style": style,
            "validated_fields": dict(fields_input),
        }

    def get_product_price(self, product_id: str) -> dict[str, Any]:
        row = self.db.query_one(
            "SELECT id, currency, amount_fen, version FROM product_price WHERE id = ?",
            (product_id,),
        )
        if row is None:
            raise TimeCapsuleError("UNKNOWN_PRODUCT", f"Product '{product_id}' is not in price catalog", 404)
        return {
            "id": str(row["id"]),
            "currency": str(row["currency"]),
            "amount_fen": int(row["amount_fen"]),
            "version": int(row["version"]),
        }
