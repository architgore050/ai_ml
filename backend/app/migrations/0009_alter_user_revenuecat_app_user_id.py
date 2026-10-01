"""Make `User.revenuecat_app_user_id` NOT NULL.

Depends on 0008 rather than running alongside it: the backfill must be
completable and reviewable on its own, and applying the constraint while any row
is still NULL would fail the migration outright (which is the correct outcome,
but an unhelpful way to learn that a backfill was needed).

After this migration the database refuses to store a NULL App User ID. The
runtime `services.revenuecat._app_user_id()` null tolerance remains as
defence-in-depth, but it is no longer reachable through a real `User` row.
"""
from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0008_backfill_revenuecat_app_user_id"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="revenuecat_app_user_id",
            field=models.UUIDField(default=uuid.uuid4),
        ),
    ]
