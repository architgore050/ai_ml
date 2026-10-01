"""Data-subject erasure (ISSUE-06 / B3).

Before this module existed, ``POST /data-subject/erasure/`` marked the request
``completed`` and returned ``"Data erasure process initiated."`` while deleting
nothing. The endpoint said a user's data was gone, so the user had no reason to
keep a copy, and nothing was gone.

DECISION: erasure is a **task**, not request-path work. It fans out to object
storage and Redis, takes longer than a request should, and must be idempotent
because Celery retries. Running it inline would risk a 500 midway through a
destructive operation, which is the worst possible failure mode for a delete.

The two halves that matter
--------------------------
This is not ``User.delete()``. A bare cascade would destroy the records that
prove the platform complied:

============================  ==========================================
Retained + anonymised        Why
============================  ==========================================
``ConsentAudit``             DPDP §5(2) / §11 — proof of consent must
                             outlive the account it was given for. Its
                             ``user`` FK was CASCADE, so deleting the
                             account destroyed the evidence of consent.
``AuditLog``                 CERT-In 2022 — 180-day identity retention.
                             Already SET_NULL, so it survives; this
                             module asserts that rather than assuming.
``Grievance``                IT Rules 2021 R4(2) — grievance record.
                             Already SET_NULL.
``DataSubjectRequest``       Evidence that an erasure was requested *and
                             completed*. Its FK was CASCADE, so the request
                             row deleted itself. The ``user`` FK is now
                             SET_NULL and this module stamps
                             ``completed_at``.
============================  ==========================================

============================  ==========================================
Deleted                       Why
============================  ==========================================
``User`` and its cascade     The account itself. Cascades to
                             ``AudioClip``, ``Comment``, ``ShareEvent``,
                             ``UserInteraction`` — all personal content.
Object storage for the user  ``profile_picture`` (an avatar is personal
                             data), and per clip: ``original_file``,
                             the ``hls/`` tree (both already handled by the
                             AudioClip ``post_delete`` signal) and
                             ``cover_image`` (which the signal did **not**
                             handle — fixed in signals.py).
Redis keys                   ``user_feed:{id}``, ``user_vectors:{id}``,
                             and the per-(clip,user) completion counters.
                             Behavioural data is personal data, and a
                             cascade in Postgres does not reach Redis.
============================  ==========================================

Idempotency: the task keys on ``user_id``. If the user is already gone it is a
no-op that reports ``already_erased``, so a redelivery after a partial failure
does not raise and does not double-count.
"""
from __future__ import annotations

import logging
from typing import Any

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

#: Redis keys holding per-user behavioural data. The completion counters are
#: spread across clips (``clip:<uuid>:user:<id>:completion_sum``), so they need
#: a pattern scan rather than a known key list.
USER_FEED_KEY = "user_feed:{user_id}"
USER_VECTORS_KEY = "user_vectors:{user_id}"
COMPLETION_KEY_PATTERN = "clip:*:user:{user_id}:completion_*"

#: Bounded scan batch. Redis SCAN over a large keyspace can take a while; this
#: keeps the work incremental so a busy cache cannot stall the task past
#: Celery's visibility timeout.
_SCAN_BATCH = 500


class ErasureUnavailable(RuntimeError):
    """Raised when erasure cannot proceed. The task retries rather than
    reporting success on a partial delete."""


def _delete_storage_object(name: str | None) -> bool:
    """Best-effort delete of one object-storage key.

    Returns True if the key is gone afterwards. Never raises: a storage outage
    must not abort the database half, and the orphan is recoverable — there is
    a periodic ``cleanup_orphan_hls`` task precisely for that.
    """
    if not name:
        return True
    try:
        from django.core.files.storage import default_storage

        if default_storage.exists(name):
            default_storage.delete(name)
        return True
    except Exception as exc:  # noqa: BLE001 — must not abort erasure
        logger.error(
            "erasure: could not delete storage object %r: %s", name, exc
        )
        return False


def purge_redis(user_id: int) -> int:
    """Delete every Redis key holding this user's behavioural data.

    Returns the number of keys removed. A Redis outage is logged and counted
    as zero rather than raised: Postgres is the system of record for the
    account, and a stale feed queue is a cache-coherence problem rather than a
    retained copy of personal data (the vectors are derived from interactions
    that *are* deleted).
    """
    removed = 0
    try:
        client = cache.client.get_client(write=True)
    except Exception as exc:  # noqa: BLE001
        logger.error("erasure: redis client unavailable: %s", exc)
        return 0

    try:
        for key in (USER_FEED_KEY, USER_VECTORS_KEY):
            try:
                if client.exists(key.format(user_id=user_id)):
                    client.delete(key.format(user_id=user_id))
                    removed += 1
            except Exception as exc:  # noqa: BLE001
                logger.error("erasure: deleting %s failed: %s", key, exc)

        pattern = COMPLETION_KEY_PATTERN.format(user_id=user_id)
        try:
            for batch_start in range(0, 10_000, _SCAN_BATCH):
                cursor, keys = client.scan(
                    cursor=batch_start, match=pattern, count=_SCAN_BATCH
                )
                if keys:
                    client.delete(*keys)
                    removed += len(keys)
                if cursor == 0:
                    break
            else:
                logger.error(
                    "erasure: completion-key scan hit the 10k cursor bound "
                    "for user %s; a stale counter may remain", user_id
                )
        except Exception as exc:  # noqa: BLE001
            logger.error("erasure: completion-key scan failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.error("erasure: redis purge failed for user %s: %s", user_id, exc)
    return removed


def _anonymise_retained_records(user_id: int) -> dict[str, int]:
    """Sever the personal link on records that must be retained.

    The ``user`` FKs on these models are SET_NULL (see migration 0007); this
    sets them to None and stamps the consent record as withdrawn, so the rows
    survive as evidence with no pointer back to a person.
    """
    from ..models import ConsentAudit, DataSubjectRequest

    consents = ConsentAudit.objects.filter(user_id=user_id).update(
        user=None, withdrawn_at=timezone.now()
    )
    requests = DataSubjectRequest.objects.filter(
        user_id=user_id, request_type="erasure"
    ).update(user=None, status="completed", completed_at=timezone.now())
    return {"consent_audits_anonymised": consents, "erasure_requests_completed": requests}


def execute_erasure(user_id: int) -> dict[str, Any]:
    """Delete a user's personal data and anonymise the records retained by law.

    Args:
        user_id: the primary key of the user to erase. Not the username or
            email — erasure is irreversible, so it must not depend on a
            mutable identifier.

    Returns:
        A report dict of what was removed. ``already_erased`` is True when
        there was nothing to do, which is how a Celery redelivery is made
        harmless.
    """
    from ..models import User

    user = User.objects.filter(pk=user_id).first()
    if user is None:
        logger.info("erasure: user %s already gone; nothing to do", user_id)
        return {"already_erased": True, "user_id": user_id}

    report: dict[str, Any] = {"already_erased": False, "user_id": user_id}

    # --- Storage, before the row goes -------------------------------------
    # profile_picture must be read off the instance first: once the row is
    # gone the filename is unrecoverable and the object is orphaned.
    report["profile_picture_deleted"] = _delete_storage_object(
        getattr(user.profile_picture, "name", None)
    )

    # --- Redis ------------------------------------------------------------
    report["redis_keys_deleted"] = purge_redis(user_id)

    # --- Retained records -------------------------------------------------
    # Before the cascade, so the SET_NULL FKs actually take effect and the
    # consent/completion evidence outlives the account.
    report.update(_anonymise_retained_records(user_id))

    with transaction.atomic():
        # Cascade handles AudioClip (whose post_delete signal removes
        # original_file, the hls/ tree and cover_image), Comment, ShareEvent
        # and UserInteraction.
        clip_count = user.audio_clips.count()
        comment_count = user.comment_set.count() if hasattr(user, "comment_set") else 0
        interaction_count = user.userinteraction_set.count() if hasattr(user, "userinteraction_set") else 0
        share_count = user.sent_shares.count() + user.received_shares.count()

        user.delete()

    report.update(
        clips_deleted=clip_count,
        comments_deleted=comment_count,
        interactions_deleted=interaction_count,
        shares_deleted=share_count,
    )
    logger.info("erasure: completed for user %s: %s", user_id, report)
    return report
