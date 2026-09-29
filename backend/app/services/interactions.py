"""Interaction service layer.

Stage 3 of the relational-to-event-driven plan: every write to
`UserInteraction` flows through these functions, never directly
through ORM in a view. As of the 2026-09 metrics rewrite, the
F() counter side-effect on AudioClip has been removed; all
counter writes go through Redis (counter_store) and the
flush_counters_to_pg task is the only path from Redis to
Postgres.

Behavior contract (preserved from pre-refactor views/interactions.py):
  * toggle_like: get_or_create + toggle is_active; the UserInteraction
    save() fires a Redis INCRBY via counter_store (no F()).
  * register_skip: writes a completion sample + skip counter to
    Redis. The flusher materializes a UserInteraction row per
    (user, clip) per beat.
  * record_telemetry: emits a JSON event to a Redis Stream (primary)
    with a Redis list as fallback. The stream consumer
    (tasks.flush_telemetry_stream) bulk-inserts UserInteraction rows
    AND invalidates each affected user's cached user_vectors.
    On Redis failure it falls back to a Redis counter-store write
    so the event is not lost.
  * record_share: get_or_create the share interaction. The
    UserInteraction save() fires a Redis INCRBY on shares.

STREAM DETAILS:
  Stream key:    stream:interaction.events
  Consumer grp:  cg:telemetry-flush
  Approx cap:    MAXLEN ~ 50000 (bounds RAM; messages are short-lived
                 telemetry, replay window only matters for at-least-once)
  Dedup key:     processed_event:{event_id} SETNX EX 86400
  DLQ stream:    stream:interaction.events:dlq
  Fallback list: telemetry:queue  (drained by flush_telemetry_legacy)
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from django.core.cache import cache
from django.db import transaction

from ..models import AudioClip, UserInteraction
from .sentry import capture_exception

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# User-vectors cache invalidation.
# Group B item 10 (N11 cache invalidation wiring).
#
# Background: get_user_vectors() in views/feed.py caches the
# time-decayed user vector for 15 min. The cache was previously only
# refreshed by TTL expiry — every state-changing interaction (like,
# skip) was silently leaving the cache stale for up to 15 min. The
# helper invalidate_user_vectors_cache() existed in views/feed.py
# but had zero callers (per the audit verification).
#
# This module re-exports the helper (kept in views/feed.py for the
# /suggestions/ endpoint to find without a circular import) AND owns
# the canonical key prefix. Services that mutate user state call
# invalidate_user_vectors_cache(user_id) here.
#
# DECISION: the helper lives in BOTH places to avoid a circular
# import. views/feed.py cannot import from this module without
# dragging in `calculate_time_decayed_vectors` (which is in
# tasks.py) and the service-layer machinery. This module CAN import
# the key constant from views/feed.py without cycles. The duplication
# is one constant and one function — minor cost for clean layering.
# ---------------------------------------------------------------------------
_USER_VECTORS_KEY = 'user_vectors:{user_id}'


def invalidate_user_vectors_cache(user_id: int) -> None:
    """Drop the cached user-vector pair so the next /suggestions/
    re-computes from current state.

    Idempotent. Safe to call when the key doesn't exist (cache.delete
    is a no-op). Safe to call from any state-changing service
    (record_like_toggle, record_skip, record_share, telemetry flush).
    """
    cache.delete(_USER_VECTORS_KEY.format(user_id=user_id))


STREAM_KEY = 'stream:interaction.events'
CONSUMER_GROUP = 'cg:telemetry-flush'
STREAM_MAXLEN = 50_000


def _use_stream() -> bool:
    """Env-gated feature flag. Set ECHOFLOW_TELEMETRY_STREAM=off to force LIST path."""
    return os.environ.get('ECHOFLOW_TELEMETRY_STREAM', 'on').lower() not in ('off', '0', 'false')


def _xadd_telemetry(event: dict) -> bool:
    """XADD a telemetry event. Returns True on success, False on any Redis error."""
    from .. import metrics
    try:
        client = cache.client.get_client()
        # DECISION: cache_get_set_duration_seconds times the XADD
        # operation. Result label is 'ok' (success) or 'error'
        # (Redis hiccup). The op label is 'set' because XADD is a
        # write.
        with metrics.time_cache(op='set') as timer:
            client.xadd(
                STREAM_KEY,
                {
                    'event_id': event['event_id'],
                    'schema_version': '1.0.0',
                    'payload': json.dumps(event),
                },
                maxlen=STREAM_MAXLEN,
                approximate=True,
            )
        return True
    except Exception as exc:
        logger.warning("telemetry: xadd failed (%s); will fall back to list", exc)
        capture_exception(exc, op='telemetry.xadd', clip_id=str(event.get('clip_id', '')))
        return False


def _rpush_telemetry(event: dict) -> None:
    """LIST fallback path. Raises on Redis failure so the caller can run the
    synchronous update_or_create last-resort fallback."""
    from .. import metrics
    with metrics.time_cache(op='set') as timer:
        cache.client.get_client().rpush('telemetry:queue', json.dumps(event))


def record_like_toggle(user, clip: AudioClip) -> tuple[UserInteraction, bool]:
    """Toggle the user's like on `clip`. Returns (interaction, created).

    The counter increment is O(1): the UserInteraction.save() hook
    (in models.py) calls counter_store.increment() (Redis INCRBY)
    on every state change. The flush_counters_to_pg task applies
    the deltas to AudioClip.likes once per beat.
    """
    from .. import metrics
    with metrics.time_toggle_like() as timer:
        interaction, created = UserInteraction.objects.get_or_create(
            user=user,
            clip=clip,
            interaction_type='like',
            defaults={'is_active': True},
        )
        if not created:
            interaction.is_active = not interaction.is_active
            interaction.save()
        # HACK: We can't easily detect "row-lock contention" from
        # inside this function — Postgres just makes the UPDATE
        # wait. So the race_lost label is rarely observed in
        # practice; it's a hook for future explicit contention
        # tracking if we add a "did I wait on a row lock?" check.
    # Group B item 10: invalidate the cached user vectors so the
    # next /suggestions/ request recomputes from the new state.
    # Defer to on_commit so a rolled-back transaction doesn't
    # leave a stale invalidation (next read would refetch the
    # then-current state anyway, so this is a defense-in-depth).
    transaction.on_commit(lambda: invalidate_user_vectors_cache(user.id))
    return interaction, created


def _completion_rate(listen_duration_ms: int, clip: AudioClip) -> float:
    """Fraction of the clip actually listened to, in [0, 1].

    The denominator is `clip.duration_ms` — server state. The numerator is
    still client-supplied, because the only true measure of watch time lives
    in the player; the client-side fix (measure elapsed playback, not media
    position) is tracked separately. Clamping the numerator to the clip
    duration means a client that reports listening longer than the clip is
    long is capped at 1.0 rather than producing a rate the `min()` would
    have produced anyway.

    Falls back to the reported position when `duration_ms` is unset. That is
    weaker than the clip duration but strictly better than a constant, and a
    clip with no recorded duration has no server-side answer available.
    """
    expected_duration = clip.duration_ms or 0
    if expected_duration <= 0:
        # No server-side duration to divide by. `reel_position_ms` is not
        # passed in here; callers that have a real duration use it.
        expected_duration = 60_000
    listened = max(0, min(int(listen_duration_ms or 0), expected_duration))
    return min(listened / expected_duration, 1.0)


def record_skip(
    user,
    clip: AudioClip,
    listen_duration_ms: int,
    reel_position_ms: int,
) -> dict:
    """Register a skip event.

    After the audit fix for O(N) `update_global_metrics` correlated
    subqueries, the synchronous UserInteraction write was moved off
    the request path. `record_skip` now:

      1. Computes the completion rate from listen/reel position.
      2. Pushes the completion sample into the Redis counter store
         under `clip:<uuid>:user:<int>:completion_sum|count`.
      3. Bumps the clip-global `skips` counter via INCRBY.
      4. Invalidates the user's cached user_vectors on commit.

    The `flush_counters_to_pg` task materializes a single
    `UserInteraction(interaction_type='skip')` row per (user, clip)
    per beat with the aggregated completion_rate, so downstream
    consumers reading the row table see the same shape they always
    did.

    SECURITY: the divisor is server-side. It used to be

        expected_duration = reel_position_ms if reel_position_ms > 0 else 60000
        completion_rate = min(listen_duration_ms / expected_duration, 1.0)

    which the caller fully controlled: `reel_position_ms` and
    `listen_duration_ms` are both request-body integers. The web client
    happens to send them equal (`player.tsx` sends
    `listen_duration_ms == reel_position_ms == currentTime * 1000`), so
    the ratio is exactly 1.0 on *every* skip — no manipulation required,
    just pressing "Next". A client could also send an arbitrary pair, e.g.
    `listen=999999, reel=1`, and hit the `min(...)` cap directly.

    `completion_rate` is 30% of the recommendation composite score
    (`feed_pool.py:152`, `:225`), so this was a ranking-integrity hole and
    not a metrics nit. The divisor is now `clip.duration_ms`, which the
    client cannot influence.
    """
    from . import counter_store

    completion_rate = _completion_rate(listen_duration_ms, clip)

    try:
        counter_store.add_completion(str(clip.id), str(user.id), completion_rate)
        counter_store.increment(str(clip.id), 'skips', 1)
    except Exception as exc:
        # SECURITY: never let a metrics/counter hook break the
        # user-facing write. The counter is observability; losing
        # a single skip sample degrades the per-clip ranking by a
        # negligible amount on the next beat.
        logger.warning(
            "record_skip: counter_store write failed for clip=%s user=%s: %s",
            clip.id, user.id, exc,
        )

    # Group B item 10: invalidate cached user vectors.
    transaction.on_commit(lambda: invalidate_user_vectors_cache(user.id))
    return {
        'clip_id': str(clip.id),
        'user_id': str(user.id),
        'completion_rate': completion_rate,
    }


def record_telemetry(
    user,
    clip: AudioClip,
    action_type: str,
    watch_time_ms: int,
) -> dict[str, Any]:
    """Buffer a telemetry event for async flush.

    Path priority:
      1. Redis Stream XADD (env-gated by ECHOFLOW_TELEMETRY_STREAM, default on)
      2. Redis list RPUSH (legacy)
      3. Redis counter-store write (last-resort; event must not be lost)

    Every event carries an `event_id` (UUID4) so the consumer can
    deduplicate via SETNX processed_event:{event_id} EX 86400.

    After the audit fix for O(N) `update_global_metrics` correlated
    subqueries, the synchronous UserInteraction write was removed
    from this fallback path. Tier 3 now writes the completion sample
    and the action counter directly to the Redis counter store. The
    flusher materializes the UserInteraction row from the next batch
    of drained values.
    """
    clip_duration = max(clip.duration_ms, 1)
    completion_rate = min(watch_time_ms / clip_duration, 1.0)
    event = {
        'event_id': str(uuid.uuid4()),
        'user_id': str(user.id),
        'clip_id': str(clip.id),
        'action_type': action_type,
        'watch_time_ms': watch_time_ms,
        'completion_rate': completion_rate,
    }
    try:
        if _use_stream():
            if _xadd_telemetry(event):
                return event
        _rpush_telemetry(event)
    except Exception as exc:
        logger.warning(
            "telemetry: redis enqueue failed (%s); falling back to counter store",
            exc,
        )
        # B13: surface this Redis-enqueue failure to Sentry so silent
        # telemetry drops are visible. The local logger.warning stays
        # for the dev/CI path (Sentry is unconfigured in tests).
        capture_exception(exc, op='telemetry.rpush_fallback', clip_id=str(clip.id))
        # A3 cache invalidation: a user state change happened
        # (their watch time advanced the recompute signal) so drop
        # the cached user_vectors. Tier 3 does NOT need to write
        # the UserInteraction row synchronously — the flusher will
        # materialize it from the next drained completion sample.
        from . import counter_store
        try:
            counter_store.add_completion(
                str(clip.id), str(user.id), completion_rate,
            )
            # Most telemetry action_types are 'view' (and not a
            # simple counter type); the simple INCRBY path is for
            # 'like' / 'share' / 'skip' which have their own
            # service entry points. The skips counter is the only
            # one that overlaps with this path; record_skip writes
            # it. We do not double-count here.
        except Exception as inner:
            logger.warning(
                "telemetry: counter_store fallback failed for clip=%s user=%s: %s",
                clip.id, user.id, inner,
            )
        transaction.on_commit(lambda: invalidate_user_vectors_cache(user.id))
    return event


def record_share(user, clip: AudioClip) -> UserInteraction:
    """Log a share interaction.

    Bumps AudioClip.shares via the Redis INCRBY fired inside
    UserInteraction.save() (counter_store.increment path). The
    flush_counters_to_pg task applies the delta to Postgres once
    per beat.

    Does NOT create a ShareEvent — that is the inbox fan-out, owned
    by the share-send view (callers do both: this function for the
    counter, ShareEvent.objects.create for the inbox).

    A3 cache invalidation: a share is a state change for the user
    (their share history is part of the recommendation signal). The
    shared clip's vector weight should influence the user's next
    /suggestions/ request. Defer to on_commit so a rolled-back
    transaction doesn't leave a stale invalidation.
    """
    interaction, _ = UserInteraction.objects.get_or_create(
        user=user, clip=clip, interaction_type='share',
    )
    transaction.on_commit(lambda: invalidate_user_vectors_cache(user.id))
    return interaction
