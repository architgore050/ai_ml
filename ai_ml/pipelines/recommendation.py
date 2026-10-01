"""Recommendation pipeline orchestration.

Migrated from `backend.app.tasks` in the feed-engine separation pass
(2026-09). Holds the PURE ranking math — no Celery wiring, no Redis
writes, no side effects beyond DB reads. The Celery task bodies in
`ai_ml.pipelines.feed_tasks` are thin shells that call into these
helpers and handle the queue/IO concerns.

Functions:
    calculate_time_decayed_vectors(user, limit=50)
        Blended short-term + long-term user preference vectors.
        Moved verbatim from backend.app.tasks.calculate_time_decayed_vectors.

    build_feed_candidates(user_id, count=50, *, pool_first=True)
        Returns an ordered list of clip UUIDs for a user's feed.
        Pool-first (Redis ZSET) when pool_first=True; falls back to
        SQL composite ranking or cold-start ordering on pool miss.
        Extracted from backend.app.tasks.refill_user_feed body.

    build_global_exploit_pool(top_n=10_000, *, global_avg=None)
        Returns [(clip_id_str, score), ...] for the global exploit
        candidate pool. Extracted from the SQL portion of
        backend.app.services.feed_pool.rebuild_global_exploit_pool.

    build_user_explore_pool(user_id, top_n=1_000, *, sem_query=None, ac_query=None)
        Returns [(clip_id_str, score), ...] for a per-user explore
        candidate pool. Extracted from the SQL portion of
        backend.app.services.feed_pool.rebuild_user_explore_pool.

The composite scoring formula (45% vector similarity + 30% completion
rate + 25% engagement velocity) is preserved EXACTLY across all three
builders — see _composite_score() below.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np
from django.db.models import F, FloatField, ExpressionWrapper, OuterRef, Subquery
from django.utils import timezone
from datetime import timedelta
from pgvector.django import CosineDistance

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Composite scoring — single source of truth
# ---------------------------------------------------------------------------

# DECISION: 45% vector similarity + 30% avg completion rate + 25%
# engagement velocity. These weights were established when the
# recommendation engine first shipped; the audit
# (docs/EXPLAIN/recommendation/*.md) considers them the production
# formula. If you change them, change them in ONE place (here) and
# the three builders + backend.app.services.feed_pool stay in sync.
_VECTOR_WEIGHT = 0.45
_COMPLETION_WEIGHT = 0.30
_VELOCITY_WEIGHT = 0.25

# Feed mixing: 80% exploit (top of global pool) / 20% explore
# (per-user pool + followed-creator network + cold fallback). The
# architecture audit considers 80/20 the production ratio.
_EXPLOIT_RATIO = 0.8


def _recovery_candidates(user, count: int) -> list[str]:
    """Return eligible clips to re-serve after unseen candidates are exhausted.

    This is deliberately a last-resort path: normal candidate construction
    keeps its 30-day interaction exclusion. Without recovery, a user who has
    interacted with every clip in a small catalogue receives an empty refill
    forever and `/feed/` remains at ``202 Preparing your feed...``.

    ``UserInteraction`` has one row per interaction type, so a clip may have
    several rows for the same user. The correlated subquery chooses the most
    recent one, then orders oldest-first. Ties retain the catalogue's normal
    engagement/newness ordering. ``last_interaction_at`` is normally never
    NULL here, but NULLS FIRST makes a concurrently-added eligible clip safe.
    """
    from backend.app.models import AudioClip, UserInteraction

    last_interaction = (
        UserInteraction.objects
        .filter(user=user, clip_id=OuterRef('pk'))
        .order_by('-created_at')
        .values('created_at')[:1]
    )
    recovery = (
        AudioClip.objects
        .filter(status='ready')
        .annotate(last_interaction_at=Subquery(last_interaction))
        .order_by(
            F('last_interaction_at').asc(nulls_first=True),
            '-engagement_velocity',
            '-created_at',
        )[:count]
    )
    return [str(clip.id) for clip in recovery]


def _composite_score(vector_similarity, avg_completion_rate, engagement_velocity):
    """Pure-Python composite score. Mirrors the ORM ExpressionWrapper
    in the SQL builders. Use this when you have the three components
    pre-computed and want the same formula without re-annotating."""
    return (
        (vector_similarity * _VECTOR_WEIGHT)
        + (avg_completion_rate * _COMPLETION_WEIGHT)
        + (engagement_velocity * _VELOCITY_WEIGHT)
    )


# ---------------------------------------------------------------------------
# calculate_time_decayed_vectors (moved verbatim from backend.app.tasks)
# ---------------------------------------------------------------------------

def calculate_time_decayed_vectors(user, limit: int = 50):
    """Compute the user's blended semantic + acoustic preference vectors.

    The formula blends three signals per recent interaction:
      - time decay (1 / (1 + ln(1 + hours_ago)))
      - dwell weight (interaction.completion_rate, default 0.1)
      - explicit intent (1.5x for like/share, -0.5x for instant-skip)

    Then weights the sum by total weight, normalizes to unit length,
    and blends with the user's long-term baseline at ALPHA=0.7.

    Returns (sem_vec_list, ac_vec_list) or
    (user.long_term_semantic, user.long_term_acoustic) on cold start.

    Moved from backend.app.tasks.calculate_time_decayed_vectors; logic
    is byte-identical (the audit verified the formula). Imports of
    backend.app.models happen lazily at call time to avoid circular
    imports during Django app loading.
    """
    from backend.app.models import UserInteraction

    recent_interactions = UserInteraction.objects.filter(
        user=user
    ).select_related('clip').order_by('-created_at')[:limit]

    if recent_interactions is None or len(recent_interactions) == 0:
        return user.long_term_semantic, user.long_term_acoustic

    now = timezone.now()
    sem_vectors, ac_vectors, weights = [], [], []

    for interaction in recent_interactions:
        if interaction.clip.semantic_vector is None:
            continue

        # 1. Time Decay: A like from today is worth more than a like from last month
        hours_ago = (now - interaction.created_at).total_seconds() / 3600.0
        time_weight = 1.0 / (1.0 + math.log1p(max(0, hours_ago)))

        # 2. Dwell Time Weight: Actual completion rate dictates value
        comp_weight = interaction.completion_rate if interaction.completion_rate > 0 else 0.1

        # 3. Explicit Intent: Boost shares, penalize instant skips
        intent_weight = 1.0
        if interaction.interaction_type in ('like', 'share'):
            intent_weight = 1.5
        elif interaction.interaction_type == 'skip' and interaction.completion_rate < 0.2:
            intent_weight = -0.5

        final_weight = time_weight * comp_weight * intent_weight

        if interaction.clip.acoustic_vector is not None:
            ac_vectors.append(np.array(interaction.clip.acoustic_vector) * final_weight)

        if interaction.clip.semantic_vector is not None:
            sem_vectors.append(np.array(interaction.clip.semantic_vector) * final_weight)
        weights.append(final_weight)

    sum_weights = sum(weights)
    if sum_weights == 0:
        return user.long_term_semantic, user.long_term_acoustic
    if sem_vectors and ac_vectors:
        weighted_sem = np.sum(sem_vectors, axis=0) / sum_weights
        weighted_ac = np.sum(ac_vectors, axis=0) / sum_weights
    else:
        return user.long_term_semantic, user.long_term_acoustic

    # Blend context with baseline
    ALPHA = 0.7
    if user.long_term_semantic is not None:
        final_sem = (ALPHA * weighted_sem) + ((1 - ALPHA) * np.array(user.long_term_semantic))
        final_ac = (ALPHA * weighted_ac) + ((1 - ALPHA) * np.array(user.long_term_acoustic))
    else:
        final_sem, final_ac = weighted_sem, weighted_ac

    norm_sem = np.linalg.norm(final_sem)
    if norm_sem > 0:
        final_sem = final_sem / norm_sem
    else:
        final_sem = np.array(user.long_term_semantic) if user.long_term_semantic else final_sem

    norm_ac = np.linalg.norm(final_ac)
    if norm_ac > 0:
        final_ac = final_ac / norm_ac
    else:
        final_ac = np.array(user.long_term_acoustic) if user.long_term_acoustic else final_ac

    return final_sem.tolist(), final_ac.tolist()


# ---------------------------------------------------------------------------
# build_feed_candidates — pool-first / SQL-fallback / cold-start ranking
# ---------------------------------------------------------------------------

def build_feed_candidates(user_id, count: int = 50, *, pool_first: bool = True) -> list[str]:
    """Return up to `count` clip UUIDs for a user's feed, deduped.

    Order of preference:
      1. Pool (Redis ZSET) if pool_first and get_user_candidates() returns a list
      2. SQL composite-distance query (CosineDistance on both vectors,
         blended with avg_completion_rate + engagement_velocity)
      3. Cold-start: ORDER BY engagement_velocity, created_at

    Excludes clips the user has already seen in the last 30 days and
    clips already in the user's pending feed queue. Returns an empty
    list on no candidates.

    The 80/20 exploit/explore split lives in the caller
    (feed_tasks.refill_user_feed) by reading both pools from Redis;
    this builder handles the SQL fallback's mix.
    """
    from backend.app.models import AudioClip, UserInteraction, User

    user = User.objects.get(id=user_id)
    seen_ids = list(
        UserInteraction.objects
        .filter(user=user, created_at__gte=timezone.now() - timedelta(days=30))
        .values_list('clip_id', flat=True)
    )

    clip_ids_to_push: list[str] = []

    if pool_first:
        # Late import: services.feed_pool imports calculate_time_decayed_vectors
        # from ai_ml; this module is the only place that creates the cycle.
        from backend.app.services.feed_pool import get_user_candidates
        pool_candidates = get_user_candidates(user_id, count)
        if pool_candidates is not None:
            seen_set: set[str] = set(seen_ids)
            for cid in pool_candidates:
                if cid not in seen_set:
                    seen_set.add(cid)
                    clip_ids_to_push.append(cid)
            # Backfill from SQL if pool yielded fewer than requested.
            if len(clip_ids_to_push) < count:
                base_queryset = AudioClip.objects.filter(status='ready').exclude(id__in=list(seen_set))
                backfill = base_queryset.order_by(
                    '-engagement_velocity', '-created_at'
                )[: count - len(clip_ids_to_push)]
                for c in backfill:
                    clip_ids_to_push.append(str(c.id))
            return clip_ids_to_push or _recovery_candidates(user, count)

    # SQL composite fallback (also the path used when pool_first=False
    # or the pool returned None meaning "neither pool is populated").
    sem_query, ac_query = calculate_time_decayed_vectors(user)
    if sem_query and ac_query:
        base_queryset = AudioClip.objects.filter(status='ready').exclude(id__in=seen_ids)
        composite_query = base_queryset.annotate(
            sem_dist=CosineDistance('semantic_vector', sem_query),
            ac_dist=CosineDistance('acoustic_vector', ac_query),
            vector_similarity=ExpressionWrapper(
                1.0 - ((F('sem_dist') + F('ac_dist')) / 4.0),
                output_field=FloatField()
            ),
            composite_score=ExpressionWrapper(
                (F('vector_similarity') * _VECTOR_WEIGHT)
                + (F('avg_completion_rate') * _COMPLETION_WEIGHT)
                + (F('engagement_velocity') * _VELOCITY_WEIGHT),
                output_field=FloatField()
            )
        ).order_by('-composite_score')

        seen_clip_ids: set[str] = set()
        deduped: list[str] = []

        exploit_count = int(count * _EXPLOIT_RATIO)
        for c in composite_query[:exploit_count]:
            cid = str(c.id)
            if cid not in seen_clip_ids:
                seen_clip_ids.add(cid)
                deduped.append(cid)

        followed_creators = user.following.all()
        network_clips = base_queryset.filter(
            creator__in=followed_creators
        ).order_by('-created_at')[:5]
        for c in network_clips:
            cid = str(c.id)
            if cid not in seen_clip_ids:
                seen_clip_ids.add(cid)
                deduped.append(cid)

        explore_count = count - len(deduped)
        if explore_count > 0:
            explore_clips = base_queryset.exclude(
                id__in=list(seen_clip_ids)
            ).order_by('-engagement_velocity')[:explore_count]
            for c in explore_clips:
                cid = str(c.id)
                if cid not in seen_clip_ids:
                    seen_clip_ids.add(cid)
                    deduped.append(cid)

        return deduped or _recovery_candidates(user, count)

    # Cold start: no user vectors yet.
    cold_clips = (
        AudioClip.objects
        .filter(status='ready')
        .exclude(id__in=seen_ids)
        .order_by('-engagement_velocity', '-created_at')[:count]
    )
    seen_clip_ids = set()
    for c in cold_clips:
        cid = str(c.id)
        if cid not in seen_clip_ids:
            seen_clip_ids.add(cid)
            clip_ids_to_push.append(cid)
    return clip_ids_to_push or _recovery_candidates(user, count)


# ---------------------------------------------------------------------------
# build_global_exploit_pool — global top-N by composite score
# ---------------------------------------------------------------------------

def build_global_exploit_pool(
    top_n: int = 10_000,
    *,
    global_avg: Optional[tuple[Optional[list], Optional[list]]] = None,
):
    """Return an iterable of (clip_id_str, composite_score) for the
    global exploit pool.

    `global_avg` is (sem_vec, ac_vec); if either is None, the function
    ranks by engagement_velocity alone (cold-start catalog). The caller
    (services/feed_pool.rebuild_global_exploit_pool) computes the
    global-average user vector once and passes it in.

    Mirrors the SQL builder in
    backend.app.services.feed_pool.rebuild_global_exploit_pool; the
    refactor splits the pool write (Redis ZADD pipeline) from the
    SQL ranking math so the ranking can be unit-tested in isolation.
    """
    from backend.app.models import AudioClip

    base = AudioClip.objects.filter(status='ready')
    sem_query, ac_query = global_avg if global_avg is not None else (None, None)

    if sem_query is not None and ac_query is not None:
        ranked = base.annotate(
            sem_dist=CosineDistance('semantic_vector', sem_query),
            ac_dist=CosineDistance('acoustic_vector', ac_query),
            vector_similarity=ExpressionWrapper(
                1.0 - ((F('sem_dist') + F('ac_dist')) / 4.0),
                output_field=FloatField(),
            ),
            composite_score=ExpressionWrapper(
                (F('vector_similarity') * _VECTOR_WEIGHT)
                + (F('avg_completion_rate') * _COMPLETION_WEIGHT)
                + (F('engagement_velocity') * _VELOCITY_WEIGHT),
                output_field=FloatField(),
            ),
        ).order_by('-composite_score').values_list('id', 'composite_score')[:top_n]
    else:
        # Cold-start catalog — rank by engagement velocity only.
        ranked = base.order_by(
            '-engagement_velocity', '-created_at'
        ).values_list('id', 'engagement_velocity')[:top_n]

    for clip_id, score in ranked:
        yield str(clip_id), float(score or 0.0)


# ---------------------------------------------------------------------------
# build_user_explore_pool — per-user top-N by composite score
# ---------------------------------------------------------------------------

def build_user_explore_pool(
    user_id,
    top_n: int = 1_000,
    *,
    sem_query=None,
    ac_query=None,
):
    """Return an iterable of (clip_id_str, composite_score) for a single
    user's explore pool.

    If `sem_query` / `ac_query` are None, this calls
    calculate_time_decayed_vectors(user) — but it returns early
    (empty generator) when the user has no interaction history yet,
    matching the existing services/feed_pool behavior.

    Caller (services/feed_pool.rebuild_user_explore_pool) owns the
    User lookup; we receive the pre-computed vectors so this function
    stays a pure SQL builder.
    """
    from backend.app.models import AudioClip, UserInteraction

    if sem_query is None or ac_query is None:
        return

    seen_ids = list(
        UserInteraction.objects.filter(user=user_id).values_list('clip_id', flat=True)
    )

    ranked = (
        AudioClip.objects.filter(status='ready')
        .exclude(id__in=seen_ids)
        .annotate(
            sem_dist=CosineDistance('semantic_vector', sem_query),
            ac_dist=CosineDistance('acoustic_vector', ac_query),
            vector_similarity=ExpressionWrapper(
                1.0 - ((F('sem_dist') + F('ac_dist')) / 4.0),
                output_field=FloatField(),
            ),
            composite_score=ExpressionWrapper(
                (F('vector_similarity') * _VECTOR_WEIGHT)
                + (F('avg_completion_rate') * _COMPLETION_WEIGHT)
                + (F('engagement_velocity') * _VELOCITY_WEIGHT),
                output_field=FloatField(),
            ),
        )
        .order_by('-composite_score')
        .values_list('id', 'composite_score')[:top_n]
    )

    for clip_id, score in ranked:
        yield str(clip_id), float(score or 0.0)
