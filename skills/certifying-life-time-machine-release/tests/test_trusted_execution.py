from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from trusted_execution import TrustError, parse_command, repository_path  # noqa: E402


class TrustedExecutionPolicyTests(unittest.TestCase):
    def test_acceptance_commands_are_shell_free_allowlisted_argv(self) -> None:
        self.assertEqual(parse_command('["python3","tests/test.py"]'), ["python3", "tests/test.py"])
        self.assertEqual(parse_command("pnpm test"), ["pnpm", "test"])
        for command in (
            '["sh","-c","true"]',
            '["python3","-c","print(1)"]',
            '["node","--eval","process.exit(0)"]',
            '["pnpm","dlx","unknown-package"]',
            '["git","checkout","main"]',
            '["/usr/bin/python3","tests/test.py"]',
        ):
            with self.subTest(command=command):
                with self.assertRaises(TrustError):
                    parse_command(command)

    def test_repository_evidence_rejects_traversal_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ltm-path-policy-") as value:
            root = Path(value).resolve()
            (root / "evidence").mkdir()
            (root / "evidence/real.json").write_text("{}\n", encoding="utf-8")
            (root / "evidence/link.json").symlink_to(root / "evidence/real.json")
            with self.assertRaises(TrustError):
                repository_path(root, "../outside", "evidence", must_exist=False)
            with self.assertRaises(TrustError):
                repository_path(root, "evidence/link.json", "evidence", regular_file=True)


if __name__ == "__main__":
    unittest.main()
