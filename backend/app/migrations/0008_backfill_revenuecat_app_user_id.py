"""Backfill `User.revenuecat_app_user_id` for every row where it is NULL.

The field was added in 0002 as nullable. Two things followed from that:

1. `services/revenuecat.get_customer_portal_url()` grew a null branch that read
   `user.uuid` — an attribute `User` does not have (`AbstractUser`'s PK is
   `AbstractUser.id`, an AutoField). Any row with a NULL id therefore returned
   HTTP 500 from `GET /subscription/manage/`.
2. A NULL id is an unusable RevenueCat App User ID: the polling sync
   (`sync_entitlements`) skips those users, so they can never acquire an
   entitlement.

`0002` shipped a `uuid4()` default, which is why neither was visible on any
account created after it. Both only ever affected rows predating the field.

Backfill rather than delete-and-recreate: the id is the join key against
RevenueCat's own subscriber records, and a user who bought Pro before this
migration must keep the identity their purchase is attached to. Minting a fresh
uuid4 for a null row cannot collide with a real remote customer, because a null
row has never been sent to RevenueCat.

Deliberately separate from the `AlterField` in 0009. In a single migration the
two would be ordered by declaration, which works, but a reviewer then cannot run
the backfill on its own, and `migrate app 0008` is the safe way to re-apply it.
"""
import uuid

from django.db import migrations

# Rows updated per statement batch. The list of primary keys is materialised in
# full first (see `backfill`), so this bounds write batching, not memory.
BATCH_SIZE = 500


def backfill(apps, schema_editor):
    """Assign a distinct uuid4 to every user whose App User ID is NULL.

    Uses the *historical* model from `apps`, which is what a data migration
    must do: the real `User` model's methods and managers are not available, and
    using them would make the migration depend on code that can change later.

    The PK list is materialised before any write, and each row is then updated
    individually. Iterating a live queryset while mutating the same table is not
    safe under Postgres: rows leave the result set as they are updated, and a
    server-side cursor can skip past them. A per-row `uuid4()` is required in any
    case — a bulk `update()` would stamp one shared value across the batch.
    """
    User = apps.get_model("app", "User")

    null_pks = list(
        User.objects.filter(revenuecat_app_user_id__isnull=True).values_list(
            "id", flat=True
        )
    )
    if not null_pks:
        return

    for offset in range(0, len(null_pks), BATCH_SIZE):
        for pk in null_pks[offset : offset + BATCH_SIZE]:
            User.objects.filter(id=pk).update(revenuecat_app_user_id=uuid.uuid4())

    print(
        f"backfilled revenuecat_app_user_id for {len(null_pks)} user(s); "
        f"{User.objects.filter(revenuecat_app_user_id__isnull=True).count()} "
        "remain null"
    )


def noop(apps, schema_editor):
    """Reverse is intentionally empty.

    A backfilled uuid4 is indistinguishable from one assigned at row creation,
    so there is no state to restore and nothing meaningful to roll back to.
    Reversing 0009 (dropping NOT NULL) is the only useful reverse here.
    """
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0007_alter_consentaudit_user_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
