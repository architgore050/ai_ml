"""Tests for the `revenuecat_app_user_id` backfill and NOT NULL constraint.

Migrations 0008 (backfill) and 0009 (NOT NULL) are the load-bearing part of the
identity fix, and neither is observable from the current model: once 0009 has run,
the database cannot hold a NULL App User ID, so every ordinary test in
`test_revenuecat.py` sees a perfectly healthy column and proves nothing about
whether legacy rows were repaired.

So these tests move the schema backwards to create the broken state, then migrate
forwards and assert the repair. That is the only way to test a data migration
against the state it exists to fix.

`TransactionTestCase`, not `TestCase`: the default test wrapper runs each test in
a transaction that is rolled back, and DDL (`ALTER TABLE ... SET NOT NULL`)
cannot run inside one. `TransactionTestCase` commits, so the migration state
change is visible — and, importantly, this class migrates back to the *latest*
state when it finishes, so the schema is correct for whatever runs next.
"""
import uuid

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

APP = "app"
BEFORE_BACKFILL = "0007_alter_consentaudit_user_and_more"
BACKFILL = "0008_backfill_revenuecat_app_user_id"
NOT_NULL = "0009_alter_user_revenuecat_app_user_id"
LATEST = "0010_audioclip_moderation_evidence"


class RevenueCatAppUserIdMigrationTest(TransactionTestCase):
    """Rewind to 0007, manufacture legacy null rows, migrate forward."""

    # TransactionTestCase flushes tables between tests. Re-running migrations
    # that operate on a flushed table is fine, but the executor's plan cache is
    # not, so it is rebuilt per test.
    def _migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([(APP, target)])
        return executor.loader.project_state([(APP, target)]).apps

    def tearDown(self):
        # These tests intentionally rewind the schema to exercise historical
        # states. Always restore the current tip before the next test module;
        # otherwise a later AudioClip test runs against the pre-moderation
        # schema and fails with a misleading missing-column error.
        self._migrate(LATEST)
        super().tearDown()

    def _create_legacy_user(self, apps, username, with_id):
        """Create a user against the historical model, as it looked at 0007.

        `with_id=None` means "a row that predates the field". It CANNOT be
        produced by omitting the argument: `0002` added the column with
        `default=uuid.uuid4`, and because it was nullable Django did not backfill
        the rows that already existed. So a real legacy row is NULL only because
        it predates 0002 — and any row created through the ORM afterwards is
        auto-filled. The NULL therefore has to be written explicitly, or the
        "legacy row" this test manufactures is not legacy at all and the
        backfill assertions pass vacuously.
        """
        User = apps.get_model(APP, "User")
        user = User.objects.create(
            username=username,
            email=f"{username}@example.com",
            password="not-a-real-hash",
            is_active=True,
        )
        if with_id is None:
            User.objects.filter(id=user.id).update(revenuecat_app_user_id=None)
            user.refresh_from_db()
            assert user.revenuecat_app_user_id is None, (
                "the fixture is not actually a legacy null row — the backfill "
                "tests would be asserting nothing"
            )
        else:
            User.objects.filter(id=user.id).update(
                revenuecat_app_user_id=with_id
            )
            user.refresh_from_db()
        return user

    def test_existing_null_rows_are_backfilled(self):
        """The whole point: rows that predate the field must be repaired.

        0007 is the state before the backfill, where the column is nullable.
        Three rows are created there — two null, one already carrying an id —
        and the existing id is the load-bearing part of this test: a backfill
        that overwrites everything would orphan a real RevenueCat purchase.
        """
        legacy_apps = self._migrate(BEFORE_BACKFILL)

        keep = uuid.uuid4()
        survivor = self._create_legacy_user(legacy_apps, "survivor", keep)
        null_a = self._create_legacy_user(legacy_apps, "legacy-a", None)
        null_b = self._create_legacy_user(legacy_apps, "legacy-b", None)

        for u in (survivor, null_a, null_b):
            u.refresh_from_db()
        self.assertIsNone(null_a.revenuecat_app_user_id)
        self.assertIsNone(null_b.revenuecat_app_user_id)
        self.assertEqual(survivor.revenuecat_app_user_id, keep)

        # Forward through the backfill only — the constraint is 0009.
        self._migrate(BACKFILL)

        for u in (survivor, null_a, null_b):
            u.refresh_from_db()

        self.assertIsNotNone(
            null_a.revenuecat_app_user_id, "migration 0008 did not repair the row"
        )
        self.assertIsNotNone(null_b.revenuecat_app_user_id)
        self.assertNotEqual(
            null_a.revenuecat_app_user_id,
            null_b.revenuecat_app_user_id,
            "both null rows were given the SAME id — they would collide as "
            "RevenueCat App User IDs and merge two customers into one",
        )
        self.assertEqual(
            survivor.revenuecat_app_user_id,
            keep,
            "the backfill overwrote a row that already had an id; that user's "
            "purchase would be orphaned on RevenueCat's side",
        )

    def test_backfill_is_idempotent(self):
        """Re-running the migration must not re-roll an existing id.

        `migrate app 0008` is the documented way to re-apply a data migration,
        and `backfill`'s reverse is a deliberate noop, so forward-then-backward
        must leave assigned ids alone.
        """
        legacy_apps = self._migrate(BEFORE_BACKFILL)
        row = self._create_legacy_user(legacy_apps, "idempotent", None)

        self._migrate(BACKFILL)
        row.refresh_from_db()
        assigned = row.revenuecat_app_user_id
        self.assertIsNotNone(assigned)

        # Back to 0007, then forward again.
        self._migrate(BEFORE_BACKFILL)
        self._migrate(BACKFILL)
        row.refresh_from_db()

        self.assertEqual(
            row.revenuecat_app_user_id,
            assigned,
            "a second pass re-rolled a populated id, so the identity is not "
            "stable across migrations",
        )

    def test_no_null_rows_survive_the_backfill(self):
        """The sweep is a query over the whole table, not a bounded page."""
        legacy_apps = self._migrate(BEFORE_BACKFILL)
        for i in range(12):
            self._create_legacy_user(legacy_apps, f"bulk-{i}", None)

        self._migrate(BACKFILL)

        User = legacy_apps.get_model(APP, "User")
        remaining = User.objects.filter(revenuecat_app_user_id__isnull=True).count()
        self.assertEqual(
            remaining, 0, f"{remaining} row(s) still have a NULL App User ID"
        )

    def test_the_backfill_noop_reverse_does_not_raise(self):
        """Reversing 0008 is intentionally empty; prove it is callable."""
        from importlib import import_module

        mod = import_module(f"backend.app.migrations.{BACKFILL}")
        self.assertIsNone(mod.noop(None, None))
        # And the forward function is importable and named, which is what the
        # production migrate call invokes.
        self.assertTrue(callable(mod.backfill))

    def test_not_null_constraint_is_real(self):
        """After 0009 the database itself refuses a NULL id.

        This is the difference between "the backfill ran once" and "the state
        cannot come back". A model-level `null=True` with a NOT NULL column (or
        the reverse) is exactly the drift this catches.
        """
        from django.db import IntegrityError, transaction

        self._migrate(NOT_NULL)
        from backend.app.models import User

        u = User.objects.create_user(
            username="post-constraint", email="post-constraint@example.com",
            password="test-pass-1234",
        )
        self.assertIsNotNone(u.revenuecat_app_user_id)

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                User.objects.filter(id=u.id).update(revenuecat_app_user_id=None)
