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
    # Actual 57 migration files are checked out in CI; hashes are not mocked,
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
        "completed_migrations": len(names),
        "unfinished_migrations": 0,
        "editorial_migrations": {m: status for m in readiness.MIGRATIONS},
        "managed_draft_column": status == "APPLIED",
        "editorial_receipts": status == "APPLIED",
        "enabled_max_integrations": 1,
        "editorial_test_target": {
            "match_count": 1, "single_enabled": True,
            "identities": [{
                "organization_id": "org-test",
                "integration_id": "int-test",
                "provider": "max",
                "posting_times_utc_minutes": '[{"time":300},{"time":600},{"time":1020}]',
            }],
        },
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
        self.assertTrue(result["inventory"]["editorial_test_target_identified"])
        self.assertEqual(result["inventory"]["editorial_test_target"], {
            "match_count": 1, "single_enabled": True,
        })
        serialized = json.dumps(result)
        self.assertNotIn("org-test", serialized)
        self.assertNotIn("int-test", serialized)
        self.assertNotIn("posting_times_utc_minutes", serialized)
        self.assertFalse(result["approved_to_deploy"])
        self.assertEqual(result["prisma_migration_checksum_audit"]["status"], "MATCHED")
        self.assertEqual(result["prisma_migration_checksum_audit"]["applied_count"], 44)
        self.assertNotIn("prisma_ledger", result["inventory"])

    def test_installed_schema_is_not_approval_or_live_integration(self):
        row = fake_inventory("APPLIED", completed_migrations=57, active_campaigns=1)
        result = self.run_inventory(row)
        self.assertTrue(result["inventory"]["schema_installed"])
        self.assertEqual(result["runtime_module_activation"], "NOT_VERIFIED")
        self.assertEqual(result["editorial_connection"], "NOT_VERIFIED")
        self.assertFalse(result["approved_to_deploy"])

    def test_historical_53_migrations_match_but_do_not_claim_text_install(self):
        row = fake_inventory()
        files = sorted(readiness.MIGRATION_ROOT.glob("*/migration.sql"))
        row["prisma_ledger"] = [
            {"name": p.parent.name,
             "checksum": hashlib.sha256(p.read_bytes()).hexdigest(),
             "finished": True, "rolled_back": False}
            for p in files[:53]
        ]
        row["completed_migrations"] = 53
        row["editorial_migrations"] = {
            name: ("APPLIED" if i < 53 - 44 else "NOT_APPLIED")
            for i, name in enumerate(readiness.MIGRATIONS)
        }
        row["managed_draft_column"] = True
        row["editorial_receipts"] = True
        result = self.run_inventory(row)
        self.assertFalse(result["inventory"]["schema_installed"])
        self.assertEqual(result["prisma_migration_checksum_audit"]["applied_count"], 53)

    def test_52_migrations_do_not_claim_new_reservation_installed(self):
        # Historical production 52-migration DB remains a valid checksum
        # baseline, but the new delivery reservation is explicitly NOT ready.
        row = fake_inventory()
        paths = sorted(readiness.MIGRATION_ROOT.glob("*/migration.sql"))
        row["prisma_ledger"] = [
            {"name": f.parent.name,
             "checksum": hashlib.sha256(f.read_bytes()).hexdigest(),
             "finished": True, "rolled_back": False}
            for f in paths[:52]
        ]
        row["completed_migrations"] = 52
        row["editorial_migrations"] = {
            name: ("APPLIED" if i < 52 - 44 else "NOT_APPLIED")
            for i, name in enumerate(readiness.MIGRATIONS)
        }
        row["managed_draft_column"] = True
        row["editorial_receipts"] = True
        result = self.run_inventory(row)
        self.assertFalse(result["inventory"]["schema_installed"])
        self.assertEqual(result["prisma_migration_checksum_audit"]["applied_count"], 52)

    def test_historical_56_matches_but_image_import_not_installed(self):
        row = fake_inventory("APPLIED")
        row["prisma_ledger"].pop()
        row["completed_migrations"] = 56
        row["editorial_migrations"][readiness.MIGRATIONS[-1]] = "NOT_APPLIED"
        result = self.run_inventory(row)
        self.assertEqual(result["prisma_migration_checksum_audit"]["applied_count"], 56)
        self.assertEqual(result["prisma_migration_checksum_audit"]["source_file_count"], 57)
        self.assertFalse(result["inventory"]["schema_installed"])
        self.assertFalse(result["approved_to_deploy"])

    def test_contradictory_image_inventory_refused(self):
        row = fake_inventory("APPLIED")
        row["prisma_ledger"].pop()
        row["completed_migrations"] = 56
        with self.assertRaisesRegex(readiness.Refused, "disagrees with verified ledger"):
            self.run_inventory(row)

    def test_missing_or_duplicate_test_channel_never_becomes_verified(self):
        missing = fake_inventory(editorial_test_target={
            "match_count": 0, "single_enabled": False, "identities": []
        })
        result = self.run_inventory(missing)
        self.assertFalse(result["inventory"]["editorial_test_target_identified"])
        self.assertFalse(result["approved_to_deploy"])

        duplicate = fake_inventory(editorial_test_target={
            "match_count": 2, "single_enabled": False,
            "identities": [
                {"organization_id": "org-a", "integration_id": "int-a", "provider": "max"},
                {"organization_id": "org-b", "integration_id": "int-b", "provider": "max"},
            ],
        })
        self.assertFalse(
            self.run_inventory(duplicate)["inventory"]["editorial_test_target_identified"]
        )

    def test_malformed_target_inventory_fails_closed(self):
        wrong = fake_inventory(editorial_test_target={
            "match_count": 1, "single_enabled": True, "identities": [{
                "organization_id": "org", "integration_id": "int", "provider": "telegram"
            }],
        })
        with self.assertRaisesRegex(readiness.Refused, "malformed read-only exact MAX target"):
            self.run_inventory(wrong)

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
