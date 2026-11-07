"""
Executable verification tests for Slice 1 (P00 & P01):
- P00: MANIFEST.sha256.json integrity, JSON Schema validation, ACID SQLite migration.
- P01: Session login, A01 expired session refresh without losing editor draft,
       Consent recording & minor guardian enforcement, A07 mid-flight consent revocation,
       A10 cross-user 403 isolation & admin break-glass audit, and Deletion cascade proof.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from services.timecapsule.db_and_identity import (
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
)


class TestP00AndP01IdentityConsent(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TimeCapsuleDatabase(":memory:")
        self.validator = SpecContractValidator()
        self.identity = IdentityConsentService(self.db, self.validator)

    def tearDown(self) -> None:
        self.db.close()

    def test_p00_manifest_and_schema_validation(self) -> None:
        report = self.validator.verify_package_manifest()
        self.assertEqual(report["verified_file_count"], 43)
        self.assertEqual(report["version"], "1.0.0")

        with self.assertRaises(TimeCapsuleError) as ctx:
            self.validator.validate("consent", {"subject_id": "sub_1"})
        self.assertEqual(ctx.exception.code, "SCHEMA_VALIDATION_FAILED")

    def test_a01_expired_login_session_refresh_preserves_draft(self) -> None:
        t0 = datetime(2026, 11, 7, 6, 0, 0, tzinfo=timezone.utc)
        s1 = self.identity.login_or_refresh_session(
            wechat_code="wx_code_user_alpha",
            draft={
                "template_id": "life_0_100",
                "style_id": "retro",
                "fields": {"title": "我的时光档案", "display_name": "小忆"},
            },
            ttl_seconds=60,
            now=t0,
        )
        self.assertEqual(s1.restored_draft["template_id"], "life_0_100")

        # Advance past expiry (t0 + 120s)
        t_expired = t0 + timedelta(seconds=120)
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.identity.authenticate(s1.token, now=t_expired)
        self.assertEqual(ctx.exception.code, "SESSION_EXPIRED")

        # Refresh session with previous token; draft must be preserved intact (A01)
        s2 = self.identity.login_or_refresh_session(
            wechat_code="wx_code_user_alpha",
            previous_token=s1.token,
            ttl_seconds=3600,
            now=t_expired,
        )
        self.assertEqual(s2.user_id, s1.user_id)
        self.assertIsNotNone(s2.restored_draft)
        self.assertEqual(s2.restored_draft["template_id"], "life_0_100")
        self.assertEqual(s2.restored_draft["fields"]["title"], "我的时光档案")

    def test_p01_minor_consent_requires_guardian_and_a07_revocation_cancels_inflight(self) -> None:
        session = self.identity.login_or_refresh_session(wechat_code="wx_code_parent_01")

        # Minor consent without guardian_evidence_ref must fail closed
        with self.assertRaises(TimeCapsuleError) as ctx:
            self.identity.record_consent(
                actor_user_id=session.user_id,
                subject_id="child_01",
                purpose="minor_guardian",
                policy_revision="2026.11-v1",
                evidence_ref="ev_self_01",
                guardian_evidence_ref=None,
                is_minor=True,
            )
        self.assertEqual(ctx.exception.code, "GUARDIAN_CONSENT_REQUIRED")

        consent = self.identity.record_consent(
            actor_user_id=session.user_id,
            subject_id="child_01",
            purpose="portrait_generation",
            policy_revision="2026.11-v1",
            evidence_ref="ev_portrait_01",
            guardian_evidence_ref="ev_guardian_signed_01",
            is_minor=True,
        )
        verified = self.identity.require_active_consent(
            actor_user_id=session.user_id,
            consent_id=consent["id"],
            required_purpose="portrait_generation",
        )
        self.assertEqual(verified["status"], "GRANTED")

        # Seed a template revision and an in-flight RUNNING job to verify A07
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO template_revision (template_id, revision, manifest, status, created_at, version) VALUES ('life_0_100', '1.0.0', '{}', 'ACTIVE', '2026-11-07T00:00:00Z', 1)"
            )
            conn.execute(
                """
                INSERT INTO generation_job (
                    id, user_id, template_id, template_revision, consent_id,
                    state, idempotency_key, request_sha256, created_at, updated_at, version
                ) VALUES ('job_inflight_1', ?, 'life_0_100', '1.0.0', ?, 'RUNNING', 'idem_job_1', ?, '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z', 1)
                """,
                (session.user_id, consent["id"], "a" * 64),
            )

        revoked = self.identity.revoke_consent(
            actor_user_id=session.user_id,
            consent_id=consent["id"],
        )
        self.assertEqual(revoked["status"], "REVOKED")
        self.assertIn("job_inflight_1", revoked["cancelled_job_ids"])

        job_row = self.db.query_one("SELECT state, error_code FROM generation_job WHERE id = 'job_inflight_1'")
        self.assertEqual(job_row["state"], "CANCELLED")
        self.assertEqual(job_row["error_code"], "CONSENT_REVOKED_ABORT")

    def test_a10_cross_user_isolation_and_deletion_cascade(self) -> None:
        u_a = self.identity.login_or_refresh_session(wechat_code="wx_user_alice")
        u_b = self.identity.login_or_refresh_session(wechat_code="wx_user_bob")

        with self.assertRaises(TimeCapsuleError) as ctx:
            self.identity.assert_owner_access(
                actor_user_id=u_a.user_id,
                owner_user_id=u_b.user_id,
                resource_type="media_asset",
                resource_id="asset_bob_1",
            )
        self.assertEqual(ctx.exception.status_code, 403)

        # Admin break-glass with explicit reason logs to audit_log
        self.identity.assert_owner_access(
            actor_user_id="admin_sec_01",
            owner_user_id=u_b.user_id,
            resource_type="order",
            resource_id="ord_bob_1",
            is_admin=True,
            admin_audit_reason="Customer refund reconciliation ticket #9012",
        )
        audit = self.db.query_one("SELECT action, target_id FROM audit_log WHERE actor_id = 'admin_sec_01'")
        self.assertEqual(audit["action"], "ADMIN_BREAK_GLASS_ORDER")

        # Insert media asset for Bob and execute deletion request
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO media_asset (id, user_id, storage_key, sha256, media_type, state, created_at, version)
                VALUES ('asset_bob_1', ?, 'private/bob/1.jpg', ?, 'image/jpeg', 'READY', '2026-11-07T00:00:00Z', 1)
                """,
                (u_b.user_id, "b" * 64),
            )
        receipt = self.identity.request_deletion(actor_user_id=u_b.user_id)
        self.assertEqual(receipt["state"], "COMPLETED")
        self.assertEqual(receipt["deleted_asset_count"], 1)
        self.assertTrue(receipt["evidence_ref"].startswith("del_proof_"))

        asset_row = self.db.query_one("SELECT state FROM media_asset WHERE id = 'asset_bob_1'")
        self.assertEqual(asset_row["state"], "DELETED")


if __name__ == "__main__":
    unittest.main()
