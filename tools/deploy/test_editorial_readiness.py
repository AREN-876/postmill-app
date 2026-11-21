"""No Docker, socket or database access in these tests."""
import importlib.machinery
import importlib.util
import json
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name("editorial-readiness")
loader = importlib.machinery.SourceFileLoader("editorial_readiness", str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
readiness = importlib.util.module_from_spec(spec)
loader.exec_module(readiness)


def fake_inventory(status="NOT_APPLIED", **changes):
    # Actual 51 migration files are checked out in CI; hashes are not mocked,
    # but Docker/psql responses are. This catches SQL migration text changes.
    paths = sorted(readiness.MIGRATION_ROOT.glob("*/migration.sql"))
    names = paths if status == "APPLIED" else paths[:44]
    ledger = [
        {"name": p.parent.name, "checksum": hashlib.sha256(p.read_bytes()).hexdigest(),
         "finished": True, "rolled_back": False}
        for p in names
    ]
    row = {
        "prisma_ledger": ledger,
        "database": "postmill-db-local",
        "postgres_version": "17.12",
        "completed_migrations": 51 if status == "APPLIED" else 44,
        "unfinished_migrations": 0,
        "editorial_migrations": {m: status for m in readiness.MIGRATIONS},
        "managed_draft_column": status == "APPLIED",
        "editorial_receipts": status == "APPLIED",
        "enabled_max_integrations": 1,
        "active_campaigns": 0,
    }
    row.update(changes)
    return row


class ReadinessTests(unittest.TestCase):
    def run_inventory(self, row):
        calls = []

        def fake_run(args, *, sql=None):
            calls.append((args, sql))
            self.assertEqual(args[:2], ("docker", "--host=unix:///var/run/docker.sock"))
            if args[2] == "inspect":
                self.assertNotIn("{{json .}}", args)
                if args[4] == readiness.POSTMILL and args[3] == "--format":
                    pass
                return ("ghcr.io/aren-876/postmill-app@sha256:" + "a" * 64
                        if readiness.IMAGE_FORMAT in args
                        else "true|healthy")
            if args[2:5] == ("exec", "-i", "-u"):
                self.assertIn("BEGIN READ ONLY", sql)
                self.assertIn("ROLLBACK;", sql)
                self.assertNotIn("ALTER ROLE", sql)
                self.assertEqual(args[6], readiness.POSTGRES)
                return json.dumps(row)
            raise AssertionError(args)

        with patch.object(readiness, "invoke", fake_run):
            result = readiness.collect()
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(c[0][2] in ("inspect", "exec") for c in calls))
        return result

    def test_current_vps_not_ready_without_any_mutation(self):
        result = self.run_inventory(fake_inventory())
        self.assertEqual(result["mode"], "read_only")
        self.assertEqual(result["inventory"]["completed_migrations"], 44)
        self.assertFalse(result["inventory"]["schema_installed"])
        self.assertEqual(result["inventory"]["active_campaigns"], 0)
        self.assertFalse(result["approved_to_deploy"])
        self.assertEqual(result["prisma_migration_checksum_audit"]["status"], "MATCHED")
        self.assertEqual(result["prisma_migration_checksum_audit"]["applied_count"], 44)
        self.assertNotIn("prisma_ledger", result["inventory"])

    def test_installed_schema_is_not_approval_or_live_integration(self):
        row = fake_inventory("APPLIED", completed_migrations=51, active_campaigns=1)
        result = self.run_inventory(row)
        self.assertTrue(result["inventory"]["schema_installed"])
        self.assertEqual(result["runtime_module_activation"], "NOT_VERIFIED")
        self.assertEqual(result["editorial_connection"], "NOT_VERIFIED")
        self.assertFalse(result["approved_to_deploy"])

    def test_unfinished_migration_blocks_schema_ready(self):
        row = fake_inventory("APPLIED", unfinished_migrations=1)
        self.assertFalse(self.run_inventory(row)["inventory"]["schema_installed"])

    def test_unknown_migration_state_fails_closed(self):
        row = fake_inventory()
        row["editorial_migrations"][readiness.MIGRATIONS[0]] = "UNKNOWN"
        with self.assertRaisesRegex(readiness.Refused, "invalid editorial migration"):
            self.run_inventory(row)

    def test_wrong_checksum_fails_closed(self):
        row = fake_inventory()
        row["prisma_ledger"][0]["checksum"] = "0" * 64
        with self.assertRaisesRegex(readiness.Refused, "checksum mismatch"):
            self.run_inventory(row)

    def test_extra_or_unknown_migration_fails_closed(self):
        row = fake_inventory()
        row["prisma_ledger"][0]["name"] = "unexpected-migration"
        with self.assertRaisesRegex(readiness.Refused, "do not match"):
            self.run_inventory(row)

    def test_incomplete_record_fails_closed(self):
        row = fake_inventory()
        row["prisma_ledger"][0]["finished"] = False
        with self.assertRaisesRegex(readiness.Refused, "not successfully completed"):
            self.run_inventory(row)

    def test_duplicate_record_fails_closed(self):
        row = fake_inventory()
        row["prisma_ledger"][1]["name"] = row["prisma_ledger"][0]["name"]
        with self.assertRaisesRegex(readiness.Refused, "duplicate"):
            self.run_inventory(row)

    def test_wrong_database_fails_closed(self):
        with self.assertRaisesRegex(readiness.Refused, "unexpected database identity"):
            self.run_inventory(fake_inventory(database="editorial"))

    def test_missing_expected_migration_fails_closed(self):
        row = fake_inventory()
        row["editorial_migrations"].pop(readiness.MIGRATIONS[0])
        with self.assertRaisesRegex(readiness.Refused, "unexpected editorial migration"):
            self.run_inventory(row)


if __name__ == "__main__":
    unittest.main()
