"""E3 Real Middleware Verification Tests (PostgreSQL 17 + S3 HTTP + Outbox Queue + FORCE RLS)."""

from __future__ import annotations

import unittest

from services.timecapsule.e3_postgres_s3_runtime import (
    E3MiddlewareVerificationSuite,
    find_postgres_bin_dir,
)


class TestE3PostgresS3Outbox(unittest.TestCase):
    def test_e3_real_postgresql_17_force_rls_s3_and_outbox_restart_recovery(self) -> None:
        pg_bin = find_postgres_bin_dir()
        self.assertIsNotNone(pg_bin, "Expected PostgreSQL 17 initdb/pg_ctl binaries on host")

        suite = E3MiddlewareVerificationSuite()
        report = suite.run_verification()

        self.assertEqual(report["status"], "PASS")
        self.assertTrue(str(report["postgres_version"]).startswith("17"))
        self.assertGreater(report["initial_postmaster_pid"], 0)
        self.assertGreater(report["restarted_postmaster_pid"], 0)
        self.assertNotEqual(report["initial_postmaster_pid"], report["restarted_postmaster_pid"])
        self.assertEqual(len(report["backend_pids"]), 2)
        self.assertTrue(report["force_rls_verified"])
        self.assertTrue(report["concurrent_idempotency_20x_verified"])
        self.assertTrue(report["outbox_skip_locked_verified"])
        self.assertEqual(len(report["purged_orphan_keys"]), 1)
        self.assertEqual(report["s3_head_after_deletion"], 404)
        self.assertEqual(len(report["deletion_post_image_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
