"""Tests for the Redis counter store and batched flusher.

The counter_store module is the architectural fix for the audit
finding that the legacy `update_global_metrics` task performed a
correlated subquery on `userinteraction` for every AudioClip row
every 5 minutes. The migration moves counter writes to O(1) Redis
operations and pushes Postgres updates into a periodic flusher that
touches only dirty rows.

API surface tested here:
  * `increment()` — simple clip-global counter (likes/shares/skips)
  * `add_completion()` — per-(user,clip) completion accumulator
  * `drain()` — atomic read-and-reset; returns counters + completion
  * `clear()` — test-only reset helper
  * `dual_write_enabled()` — transitional flag; always False

The flusher tests live in `TestFlushCountersToPg` and assert the
three responsibilities: counter deltas, avg_completion_rate, and
UserInteraction row materialization.
"""
import os
import uuid
from unittest.mock import patch

import pytest


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# In-memory backend tests — simple counters
# ---------------------------------------------------------------------------
class TestInMemoryBackend:
    def test_increment_returns_new_value(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()

        v1 = counter_store.increment(clip_id, 'likes', 1)
        v2 = counter_store.increment(clip_id, 'likes', 1)
        v3 = counter_store.increment(clip_id, 'likes', 1)

        assert v1 == 1
        assert v2 == 2
        assert v3 == 3

    def test_increment_separate_clips_have_separate_counters(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_a = uuid.uuid4()
        clip_b = uuid.uuid4()

        counter_store.increment(clip_a, 'likes', 1)
        counter_store.increment(clip_b, 'likes', 1)
        counter_store.increment(clip_b, 'likes', 1)

        drained = counter_store.drain()
        assert drained['counters'][str(clip_a)] == {'likes': 1}
        assert drained['counters'][str(clip_b)] == {'likes': 2}

    def test_drain_returns_zero_after_drain(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        counter_store.increment(clip_id, 'likes', 5)

        first = counter_store.drain()
        assert first['counters'][str(clip_id)] == {'likes': 5}

        # Second drain is empty (atomic read-and-reset)
        second = counter_store.drain()
        assert second == {'counters': {}, 'completion': {}}

    def test_drain_does_not_lose_concurrent_increment(self):
        # The atomic-drain guarantee: if increment() lands between
        # the read and reset, the increment is preserved (next drain
        # sees it). For the in-memory backend this is enforced by
        # the lock; for the Redis backend by Lua.
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        counter_store.increment(clip_id, 'likes', 3)

        first = counter_store.drain()
        counter_store.increment(clip_id, 'likes', 2)  # between drains
        second = counter_store.drain()

        assert first['counters'][str(clip_id)] == {'likes': 3}
        assert second['counters'][str(clip_id)] == {'likes': 2}

    def test_increment_raises_on_unknown_counter_type(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        with pytest.raises(ValueError):
            counter_store.increment(uuid.uuid4(), 'views', 1)

    def test_clear_removes_specific_counter(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        counter_store.increment(clip_id, 'likes', 5)
        counter_store.increment(clip_id, 'shares', 3)

        counter_store.clear(clip_id, 'likes')
        drained = counter_store.drain()
        assert drained['counters'][str(clip_id)] == {'shares': 3}

    def test_clear_without_type_removes_all(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        counter_store.increment(clip_id, 'likes', 1)
        counter_store.increment(clip_id, 'shares', 1)
        counter_store.increment(clip_id, 'skips', 1)

        counter_store.clear(clip_id)
        assert counter_store.drain() == {'counters': {}, 'completion': {}}


# ---------------------------------------------------------------------------
# In-memory backend tests — per-(user,clip) completion accumulator
# ---------------------------------------------------------------------------
class TestCompletionAccumulator:
    def test_add_completion_increments_sum_and_count(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        user_id = '42'

        counter_store.add_completion(str(clip_id), user_id, 0.5)
        counter_store.add_completion(str(clip_id), user_id, 0.5)

        drained = counter_store.drain()
        assert drained['completion'][(str(clip_id), user_id)] == {
            'completion_sum': 1.0,
            'completion_count': 2,
        }

    def test_separate_users_have_separate_completions(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        user_a = '1'
        user_b = '2'

        counter_store.add_completion(str(clip_id), user_a, 0.4)
        counter_store.add_completion(str(clip_id), user_b, 0.8)
        counter_store.add_completion(str(clip_id), user_b, 0.8)

        drained = counter_store.drain()
        assert drained['completion'][(str(clip_id), user_a)] == {
            'completion_sum': 0.4,
            'completion_count': 1,
        }
        assert drained['completion'][(str(clip_id), user_b)] == {
            'completion_sum': 1.6,
            'completion_count': 2,
        }

    def test_drain_combines_counters_and_completion(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        user_id = '7'

        counter_store.increment(clip_id, 'likes', 2)
        counter_store.add_completion(str(clip_id), user_id, 0.75)

        drained = counter_store.drain()
        assert drained['counters'][str(clip_id)] == {'likes': 2}
        assert drained['completion'][(str(clip_id), user_id)] == {
            'completion_sum': 0.75,
            'completion_count': 1,
        }

    def test_completion_rate_clamped_to_unit_interval(self):
        from backend.app.services import counter_store
        counter_store._reset_backend_for_tests()
        clip_id = uuid.uuid4()
        user_id = '1'

        # Out-of-range inputs are clamped. The upstream computation
        # already enforces [0, 1] but the safety net must hold.
        counter_store.add_completion(str(clip_id), user_id, 1.5)
        counter_store.add_completion(str(clip_id), user_id, -0.2)

        drained = counter_store.drain()
        assert drained['completion'][(str(clip_id), user_id)] == {
            'completion_sum': 1.0,  # 1.0 (clamped) + 0.0 (clamped)
            'completion_count': 2,
        }


# ---------------------------------------------------------------------------
# Dual-write flag — kept for backward compat, always False
# ---------------------------------------------------------------------------
class TestDualWriteFlag:
    def test_default_is_false(self, monkeypatch):
        monkeypatch.delenv('ECHOFLOW_DUAL_WRITE_COUNTERS', raising=False)
        from backend.app.services import counter_store
        assert counter_store.dual_write_enabled() is False

    def test_explicit_true_still_returns_false(self, monkeypatch):
        # ECHOFLOW_DUAL_WRITE_COUNTERS=true is now ignored — the F()
        # side-effect has been removed and the flag is retained as a
        # no-op. Production deployments can leave the env var set
        # without harm.
        monkeypatch.setenv('ECHOFLOW_DUAL_WRITE_COUNTERS', 'true')
        from backend.app.services import counter_store
        assert counter_store.dual_write_enabled() is False

    def test_explicit_false(self, monkeypatch):
        monkeypatch.setenv('ECHOFLOW_DUAL_WRITE_COUNTERS', 'false')
        from backend.app.services import counter_store
        assert counter_store.dual_write_enabled() is False

    def test_off_disables(self, monkeypatch):
        monkeypatch.setenv('ECHOFLOW_DUAL_WRITE_COUNTERS', 'off')
        from backend.app.services import counter_store
        assert counter_store.dual_write_enabled() is False


# ---------------------------------------------------------------------------
# Flusher task tests — three responsibilities
# ---------------------------------------------------------------------------
class TestFlushCountersToPg:
    def test_empty_drain_is_noop(self, ready_clip, monkeypatch):
        from backend.app.tasks import flush_counters_to_pg

        before_likes = ready_clip.likes

        result = flush_counters_to_pg.run()

        assert result == {
            'drained': 0,
            'applied_counters': 0,
            'applied_completion': 0,
            'applied_velocity': 0,
            'materialized_rows': 0,
        }
        ready_clip.refresh_from_db()
        assert ready_clip.likes == before_likes

    def test_counter_deltas_apply_one_f_per_clip(self, ready_clip, monkeypatch):
        """A clip with likes+shares+skips deltas gets ONE UPDATE
        (one row lock), not three. This is the row-lock optimization
        the audit called out.
        """
        from backend.app.services import counter_store
        from backend.app.tasks import flush_counters_to_pg

        counter_store._reset_backend_for_tests()

        counter_store.increment(ready_clip.id, 'likes', 5)
        counter_store.increment(ready_clip.id, 'shares', 2)
        counter_store.increment(ready_clip.id, 'skips', 3)

        result = flush_counters_to_pg.run()

        assert result['applied_counters'] == 1
        ready_clip.refresh_from_db()
        assert ready_clip.likes == 5
        assert ready_clip.shares == 2
        assert ready_clip.skips == 3

    def test_completion_deltas_apply_avg_completion_rate(
        self, ready_clip, monkeypatch,
    ):
        from backend.app.services import counter_store
        from backend.app.tasks import flush_counters_to_pg

        counter_store._reset_backend_for_tests()

        # Two users, completion rates 0.4 and 0.8 for the same clip.
        # Weighted mean = (0.4 + 0.8) / 2 = 0.6.
        counter_store.add_completion(str(ready_clip.id), '11', 0.4)
        counter_store.add_completion(str(ready_clip.id), '22', 0.8)

        result = flush_counters_to_pg.run()

        assert result['applied_completion'] == 1
        ready_clip.refresh_from_db()
        # 0.6, blended against the stored prior with weight 10:
        # (0.0 * 10 + 1.2) / (10 + 2) = 0.1. This asserted exactly 0.6 before,
        # because the flusher replaced the value outright — which meant one
        # beat's samples *were* the whole global value, and a single sample
        # could pin the term that is 30% of the recommendation score.
        assert ready_clip.avg_completion_rate == pytest.approx(0.1)

    def test_completion_deltas_materialize_userinteraction_rows(
        self, user, other_user, ready_clip, monkeypatch,
    ):
        """The flusher writes one UserInteraction(interaction_type='view')
        row per drained (user, clip) tuple, with the aggregated
        completion_rate. This preserves the row shape that downstream
        consumers used to read synchronously from record_skip /
        record_telemetry sync-fallback.
        """
        from backend.app.models import UserInteraction
        from backend.app.services import counter_store
        from backend.app.tasks import flush_counters_to_pg

        counter_store._reset_backend_for_tests()

        # Two completion samples for `user` -> one row with mean 0.5.
        counter_store.add_completion(str(ready_clip.id), str(user.id), 0.5)
        counter_store.add_completion(str(ready_clip.id), str(user.id), 0.5)
        # One sample for `other_user`.
        counter_store.add_completion(str(ready_clip.id), str(other_user.id), 0.25)

        result = flush_counters_to_pg.run()

        assert result['materialized_rows'] == 2

        user_row = UserInteraction.objects.get(
            user=user, clip=ready_clip, interaction_type='view',
        )
        assert user_row.completion_rate == pytest.approx(0.5)

        other_row = UserInteraction.objects.get(
            user=other_user, clip=ready_clip, interaction_type='view',
        )
        assert other_row.completion_rate == pytest.approx(0.25)

    def test_flush_is_idempotent_when_drain_already_consumed(
        self, ready_clip, monkeypatch,
    ):
        """Running the flusher twice with no new events: the second
        is a no-op. Drain already consumed the deltas; the second
        run sees nothing.
        """
        from backend.app.services import counter_store
        from backend.app.tasks import flush_counters_to_pg

        counter_store._reset_backend_for_tests()

        counter_store.increment(ready_clip.id, 'likes', 3)

        first = flush_counters_to_pg.run()
        second = flush_counters_to_pg.run()

        assert first['applied_counters'] == 1
        assert first['applied_velocity'] == 1
        assert second == {
            'drained': 0,
            'applied_counters': 0,
            'applied_completion': 0,
            'applied_velocity': 0,
            'materialized_rows': 0,
        }
        ready_clip.refresh_from_db()
        assert ready_clip.likes == 3

    def test_flusher_skips_clips_missing_from_db(self, user, monkeypatch):
        """A drain containing a clip_id that no longer exists in
        AudioClip must not error; the flusher logs and moves on."""
        from backend.app.services import counter_store
        from backend.app.tasks import flush_counters_to_pg

        counter_store._reset_backend_for_tests()

        counter_store.increment(uuid.uuid4(), 'likes', 5)

        result = flush_counters_to_pg.run()
        # F() on missing row updates 0 rows but does not raise.
        assert result['applied_counters'] == 1


# ---------------------------------------------------------------------------
# Integration: service layer writes to the counter store
# ---------------------------------------------------------------------------
class TestServiceLayerIntegration:
    def test_record_like_toggle_writes_to_redis_only(
        self, user, ready_clip, monkeypatch,
    ):
        """After the F() removal, the synchronous Postgres path no
        longer runs. The Redis counter holds the delta; the flusher
        is the only path to Postgres.
        """
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_like_toggle
        from django.test import TestCase

        counter_store._reset_backend_for_tests()
        before = ready_clip.likes

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_like_toggle(user, ready_clip)

        # No synchronous F() bump anymore.
        ready_clip.refresh_from_db()
        assert ready_clip.likes == before
        # Redis has the delta.
        deltas = counter_store.drain()
        assert deltas['counters'][str(ready_clip.id)] == {'likes': 1}

    def test_record_skip_writes_to_redis_only(
        self, user, ready_clip, monkeypatch,
    ):
        """record_skip no longer writes a UserInteraction row
        synchronously. The completion sample + skips counter go
        to Redis; the flusher materializes the row.
        """
        from backend.app.models import UserInteraction
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_skip
        from django.test import TestCase

        counter_store._reset_backend_for_tests()
        before_skips = ready_clip.skips

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(
                user, ready_clip,
                listen_duration_ms=15000, reel_position_ms=30000,
            )

        # No synchronous UserInteraction row.
        assert not UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='skip',
        ).exists()
        # No synchronous F() bump.
        ready_clip.refresh_from_db()
        assert ready_clip.skips == before_skips
        # Redis has the completion sample and the skip counter.
        deltas = counter_store.drain()
        assert deltas['counters'][str(ready_clip.id)] == {'skips': 1}
        # 15000 / 60000 (ready_clip.duration_ms) = 0.25. Was 0.5, computed as
        # listen/reel_position — a divisor the caller controls. See
        # _completion_rate in services/interactions.py.
        assert deltas['completion'][(str(ready_clip.id), str(user.id))][
            'completion_sum'
        ] == pytest.approx(0.25)
        assert deltas['completion'][(str(ready_clip.id), str(user.id))][
            'completion_count'
        ] == 1

    def test_full_pipeline_record_skip_then_flush(
        self, user, ready_clip, monkeypatch,
    ):
        """End-to-end: record_skip writes to Redis, flush_counters_to_pg
        materializes the UserInteraction row, the skips counter advances,
        and avg_completion_rate is set on the AudioClip.
        """
        from backend.app.models import UserInteraction
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_skip
        from backend.app.tasks import flush_counters_to_pg
        from django.test import TestCase

        counter_store._reset_backend_for_tests()
        before_skips = ready_clip.skips

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(
                user, ready_clip,
                listen_duration_ms=30000, reel_position_ms=30000,
            )

        # Before flush: nothing in Postgres.
        ready_clip.refresh_from_db()
        assert ready_clip.skips == before_skips
        assert not UserInteraction.objects.filter(
            user=user, clip=ready_clip,
        ).exists()

        # Flush.
        result = flush_counters_to_pg.run()
        assert result['applied_counters'] == 1
        assert result['applied_completion'] == 1
        assert result['materialized_rows'] == 1

        # After flush: counter advanced, row materialized, ACR set.
        ready_clip.refresh_from_db()
        assert ready_clip.skips == before_skips + 1
        # listen 30000 / duration 60000 = 0.5, then blended against the
        # prior with weight 10: (0.0*10 + 0.5) / 11 = 0.04545. Previously
        # this asserted 1.0, because the divisor was reel_position_ms and the
        # flusher *replaced* the value instead of blending it.
        assert ready_clip.avg_completion_rate == pytest.approx(0.5 / 11)
        # The materialized per-user row is still the raw sample, not blended:
        # the blend is a property of the clip-global aggregate only.
        row = UserInteraction.objects.get(
            user=user, clip=ready_clip, interaction_type='view',
        )
        assert row.completion_rate == pytest.approx(0.5)
