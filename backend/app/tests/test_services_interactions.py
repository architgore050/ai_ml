"""Service-layer tests for backend.app.services.interactions.

Stage 3 boundary: every write to UserInteraction flows through these
functions. As of the 2026-09 metrics rewrite, the F() side-effect
on AudioClip has been removed; the tests below assert the new
event-driven pipeline (Redis INCRBY + flush_counters_to_pg) and
the new user-interaction row shape (no synchronous row write in
record_skip, the row is materialized by the flusher).

These tests verify:
  - record_like_toggle / record_share counter semantics are preserved
    (Redis INCRBY, no F())
  - record_skip writes the completion sample + counter to Redis;
    the flusher materializes the UserInteraction row
  - record_telemetry prefers the Redis Stream (XADD) over the LIST (RPUSH)
  - record_telemetry falls back to a Redis counter-store write on
    Redis failure (the third-tier safety net)
  - record_telemetry emits an event_id for downstream dedup
"""
import json
from unittest.mock import patch, MagicMock

import pytest


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# toggle-like
# ---------------------------------------------------------------------------
class TestRecordLikeToggle:
    def test_first_call_creates_active_row(self, user, ready_clip):
        from backend.app.services.interactions import record_like_toggle

        ready_clip.refresh_from_db()
        assert ready_clip.likes == 0

        interaction, created = record_like_toggle(user, ready_clip)

        assert created is True
        assert interaction.is_active is True
        # AudioClip.likes is NOT bumped synchronously anymore;
        # the counter_store.increment() fires from save(), and
        # the flush_counters_to_pg task applies the delta to PG.
        ready_clip.refresh_from_db()
        assert ready_clip.likes == 0

    def test_second_call_toggles_off(self, user, ready_clip):
        from backend.app.services.interactions import record_like_toggle

        record_like_toggle(user, ready_clip)
        record_like_toggle(user, ready_clip)

        # Net delta after the two calls is 0; the flusher would
        # observe likes unchanged. We assert the row state instead
        # of the counter, since the F() is gone.
        from backend.app.models import UserInteraction
        row = UserInteraction.objects.get(
            user=user, clip=ready_clip, interaction_type='like',
        )
        assert row.is_active is False

    def test_third_call_toggles_back_on(self, user, ready_clip):
        from backend.app.services.interactions import record_like_toggle

        record_like_toggle(user, ready_clip)
        interaction, _ = record_like_toggle(user, ready_clip)
        interaction, _ = record_like_toggle(user, ready_clip)

        assert interaction.is_active is True


# ---------------------------------------------------------------------------
# register-skip — completion sample + skips counter to Redis; the
# flusher materializes the UserInteraction row.
# ---------------------------------------------------------------------------
class TestRecordSkip:
    def test_writes_completion_sample_to_redis(self, user, ready_clip):
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_skip
        from django.test import TestCase

        counter_store._reset_backend_for_tests()

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(user, ready_clip, listen_duration_ms=15_000, reel_position_ms=30_000)

        drained = counter_store.drain()
        # 15000 / 60000 (ready_clip.duration_ms) = 0.25.
        # Was 15000/30000 = 0.5, i.e. listen/reel_position — a divisor the
        # caller controls. See _completion_rate in services/interactions.py.
        assert drained['completion'][(str(ready_clip.id), str(user.id))][
            'completion_sum'
        ] == pytest.approx(0.25)
        assert drained['counters'][str(ready_clip.id)] == {'skips': 1}

    def test_no_synchronous_userinteraction_row(self, user, ready_clip):
        """record_skip no longer writes a UserInteraction row
        synchronously. The flusher materializes one per beat.
        """
        from backend.app.models import UserInteraction
        from backend.app.services.interactions import record_skip
        from django.test import TestCase

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(user, ready_clip, listen_duration_ms=5_000, reel_position_ms=30_000)

        assert not UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='skip',
        ).exists()

    def test_repeated_skips_aggregate_completion(self, user, ready_clip):
        """Two record_skip calls in the same beat accumulate into a
        single drained bucket with mean completion_rate.
        """
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_skip
        from django.test import TestCase

        counter_store._reset_backend_for_tests()

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(user, ready_clip, listen_duration_ms=10_000, reel_position_ms=20_000)
            record_skip(user, ready_clip, listen_duration_ms=20_000, reel_position_ms=20_000)

        drained = counter_store.drain()
        # 10000/60000 + 20000/60000 = 1/6 + 1/3 = 0.5 sum, count 2.
        # Was 0.5 + 1.0 = 1.5: the second sample reported a perfect completion
        # for having listened to a third of the clip, because the divisor was
        # the client-sent reel_position_ms.
        slot = drained['completion'][(str(ready_clip.id), str(user.id))]
        assert slot['completion_sum'] == pytest.approx(0.5)
        assert slot['completion_count'] == 2
        # Skips counter accumulates.
        assert drained['counters'][str(ready_clip.id)] == {'skips': 2}


# ---------------------------------------------------------------------------
# record-telemetry (Redis Stream primary, LIST fallback, sync last-resort)
# ---------------------------------------------------------------------------
class TestRecordTelemetry:
    def test_primary_path_calls_xadd(self, user, ready_clip):
        from backend.app.services.interactions import record_telemetry, STREAM_KEY

        fake_client = MagicMock()
        with patch('backend.app.services.interactions.cache') as fake_cache:
            fake_cache.client.get_client.return_value = fake_client
            event = record_telemetry(user, ready_clip, action_type='view', watch_time_ms=5_000)

        assert fake_client.xadd.called
        call_kwargs = fake_client.xadd.call_args.kwargs
        assert call_kwargs['maxlen'] == 50_000
        assert call_kwargs['approximate'] is True
        # Stream key
        args = fake_client.xadd.call_args.args
        assert args[0] == STREAM_KEY
        # Event has the fields the consumer expects
        fields = args[1]
        assert 'event_id' in fields
        assert fields['schema_version'] == '1.0.0'
        # The returned dict includes the same event_id we put in the stream
        assert event['event_id'] == fields['event_id']
        # LIST fallback NOT used
        assert not fake_client.rpush.called

    def test_falls_back_to_list_when_xadd_raises(self, user, ready_clip):
        from backend.app.services.interactions import record_telemetry

        fake_client = MagicMock()
        fake_client.xadd.side_effect = ConnectionError('redis down')
        with patch('backend.app.services.interactions.cache') as fake_cache:
            fake_cache.client.get_client.return_value = fake_client
            event = record_telemetry(user, ready_clip, action_type='view', watch_time_ms=5_000)

        assert fake_client.xadd.called
        assert fake_client.rpush.called
        rpush_arg = fake_client.rpush.call_args.args[1]
        assert json.loads(rpush_arg)['event_id'] == event['event_id']

    def test_falls_back_to_counter_store_on_full_redis_failure(self, user, ready_clip):
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_telemetry
        from django.test import TestCase

        counter_store._reset_backend_for_tests()

        fake_client = MagicMock()
        fake_client.xadd.side_effect = ConnectionError('xadd down')
        fake_client.rpush.side_effect = ConnectionError('rpush down')
        with patch('backend.app.services.interactions.cache') as fake_cache:
            fake_cache.client.get_client.return_value = fake_client
            with TestCase.captureOnCommitCallbacks(execute=True):
                record_telemetry(
                    user, ready_clip, action_type='view', watch_time_ms=5_000,
                )

        # The synchronous UserInteraction row is no longer written.
        # Instead, the completion sample lives in the counter store.
        from backend.app.models import UserInteraction
        assert not UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='view',
        ).exists()
        drained = counter_store.drain()
        # 5000 / 60000 (max(60000, 1)) = ~0.0833 completion_rate
        slot = drained['completion'][(str(ready_clip.id), str(user.id))]
        assert slot['completion_count'] == 1
        assert slot['completion_sum'] > 0

    def test_env_flag_off_uses_list_path(self, user, ready_clip, monkeypatch):
        from backend.app.services.interactions import record_telemetry

        monkeypatch.setenv('ECHOFLOW_TELEMETRY_STREAM', 'off')
        fake_client = MagicMock()
        with patch('backend.app.services.interactions.cache') as fake_cache:
            fake_cache.client.get_client.return_value = fake_client
            record_telemetry(user, ready_clip, action_type='view', watch_time_ms=5_000)

        assert not fake_client.xadd.called
        assert fake_client.rpush.called

    def test_event_id_is_unique_per_call(self, user, ready_clip):
        from backend.app.services.interactions import record_telemetry

        fake_client = MagicMock()
        events = []
        with patch('backend.app.services.interactions.cache') as fake_cache:
            fake_cache.client.get_client.return_value = fake_client
            for _ in range(5):
                events.append(record_telemetry(user, ready_clip, action_type='view', watch_time_ms=1_000))

        ids = {e['event_id'] for e in events}
        assert len(ids) == 5, 'event_id must be unique per call (UUID4)'


# ---------------------------------------------------------------------------
# record-share (counter only; ShareEvent is the share-send view's job)
# ---------------------------------------------------------------------------
class TestRecordShare:
    def test_creates_interaction_row(self, user, ready_clip):
        from backend.app.services.interactions import record_share

        record_share(user, ready_clip)
        # The interaction row is created; the counter is bumped
        # via Redis INCRBY (no F() side-effect on AudioClip.shares).
        from backend.app.models import UserInteraction
        assert UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='share',
        ).exists()

    def test_idempotent_for_repeat_shares(self, user, ready_clip):
        from backend.app.models import UserInteraction
        from backend.app.services.interactions import record_share

        record_share(user, ready_clip)
        record_share(user, ready_clip)
        record_share(user, ready_clip)

        rows = UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='share',
        )
        assert rows.count() == 1


# ---------------------------------------------------------------------------
# Group B item 10: cache invalidation wiring
# Verifies that record_like_toggle and record_skip invalidate the
# user_vectors cache so the next /suggestions/ request recomputes
# from current state.
# ---------------------------------------------------------------------------
class TestCacheInvalidation:
    def test_record_like_toggle_invalidates_user_vectors_cache(
        self, user, ready_clip,
    ):
        from django.core.cache import cache
        from django.test import TestCase
        from backend.app.services.interactions import record_like_toggle

        cache_key = f'user_vectors:{user.id}'
        cache.set(cache_key, ('sem-stale', 'ac-stale'), timeout=900)
        assert cache.get(cache_key) is not None

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_like_toggle(user, ready_clip)

        assert cache.get(cache_key) is None

    def test_record_skip_invalidates_user_vectors_cache(
        self, user, ready_clip,
    ):
        from django.core.cache import cache
        from django.test import TestCase
        from backend.app.services.interactions import record_skip

        cache_key = f'user_vectors:{user.id}'
        cache.set(cache_key, ('sem-stale', 'ac-stale'), timeout=900)

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_skip(
                user, ready_clip,
                listen_duration_ms=5000, reel_position_ms=30000,
            )

        assert cache.get(cache_key) is None

    def test_invalidation_deferred_until_commit(
        self, user, ready_clip,
    ):
        # If the surrounding transaction rolls back, the cache key
        # must NOT be invalidated (the user's state didn't actually
        # change). The on_commit deferral guarantees this.
        from django.core.cache import cache
        from django.db import transaction, IntegrityError
        from django.test import TestCase
        from backend.app.services.interactions import record_like_toggle

        cache_key = f'user_vectors:{user.id}'
        cache.set(cache_key, ('sem-stale', 'ac-stale'), timeout=900)

        with pytest.raises(IntegrityError):
            with transaction.atomic():
                with TestCase.captureOnCommitCallbacks(execute=False) as callbacks:
                    record_like_toggle(user, ready_clip)
                # atomic rollback discards on_commit hooks
                raise IntegrityError('simulated rollback')

        # on_commit hooks were cleared by the rollback; cache untouched
        assert cache.get(cache_key) == ('sem-stale', 'ac-stale')

    def test_helper_is_exported_from_both_locations(
        self, user, ready_clip,
    ):
        # Single source of truth: services.interactions owns it;
        # views.feed re-exports it for backwards-compat (the audit
        # doc references views.feed:50 as the definition site).
        from backend.app.services.interactions import (
            invalidate_user_vectors_cache as svc_helper,
        )
        from backend.app.views.feed import (
            invalidate_user_vectors_cache as view_helper,
        )
        assert svc_helper is view_helper

    def test_record_share_invalidates_user_vectors_cache(
        self, user, ready_clip,
    ):
        # A3 Part 1: record_share mutates the user's interaction
        # history (a share is a strong signal for /suggestions/).
        # The cache must be invalidated so the next recompute sees
        # the new row.
        from django.core.cache import cache
        from django.test import TestCase
        from backend.app.services.interactions import record_share

        cache_key = f'user_vectors:{user.id}'
        cache.set(cache_key, ('sem-stale', 'ac-stale'), timeout=900)
        assert cache.get(cache_key) is not None

        with TestCase.captureOnCommitCallbacks(execute=True):
            record_share(user, ready_clip)

        assert cache.get(cache_key) is None

    def test_record_telemetry_counter_store_fallback_invalidates_cache(
        self, user, ready_clip, monkeypatch,
    ):
        # A3 Part 1: when Redis is fully unavailable, record_telemetry
        # falls back to a Redis counter-store write. That write
        # changes the user's state, so the cache must be invalidated.
        # (The stream-success path is covered by the consumer test
        # in test_task_publisher.py::TestFlushTelemetryInvalidation.)
        from django.core.cache import cache
        from django.test import TestCase

        cache_key = f'user_vectors:{user.id}'
        cache.set(cache_key, ('sem-stale', 'ac-stale'), timeout=900)

        # Force the counter-store fallback by stubbing both Redis paths
        # to return failure. xadd returns False (treated as failure);
        # rpush raises (caught by the outer try/except, then counter
        # fallback runs).
        monkeypatch.setattr(
            'backend.app.services.interactions._xadd_telemetry',
            lambda _event: False,
        )
        monkeypatch.setattr(
            'backend.app.services.interactions._rpush_telemetry',
            lambda _event: (_ for _ in ()).throw(ConnectionError('redis down')),
        )

        with TestCase.captureOnCommitCallbacks(execute=True):
            from backend.app.services.interactions import record_telemetry
            record_telemetry(user, ready_clip, action_type='view', watch_time_ms=5_000)

        # Cache was invalidated by the fallback path.
        assert cache.get(cache_key) is None


class TestCompletionRateIsNotClientControlled:
    """REGRESSION: `completion_rate` was fully client-writable, and it is 30%
    of the recommendation composite score (feed_pool.py:152, :225).

    `record_skip` computed:

        expected_duration = reel_position_ms if reel_position_ms > 0 else 60000
        completion_rate = min(listen_duration_ms / expected_duration, 1.0)

    Both operands are request-body integers. The shipped web client sends them
    EQUAL — `player.tsx` posts `listen_duration_ms == reel_position_ms ==
    currentTime * 1000` — so the ratio was exactly 1.0 on *every* skip, with
    no manipulation required beyond pressing "Next". A client could also send
    any pair it liked (`listen=999999, reel=1`) and hit the cap directly.

    Then `flush_counters_to_pg` did `.update(avg_completion_rate=mean)` — a
    full replace with just that beat's samples — so one sample became the
    entire global value.

    The divisor is now `clip.duration_ms` and the write blends. These tests
    pin the *behaviour that was exploitable*, not the arithmetic, so they
    stay meaningful if the formula is later rewritten.
    """

    def _rate(self, user, clip, **kwargs):
        from backend.app.services import counter_store
        from backend.app.services.interactions import record_skip
        from django.test import TestCase

        counter_store._reset_backend_for_tests()
        with TestCase.captureOnCommitCallbacks(execute=True):
            result = record_skip(user, clip, **kwargs)
        return result['completion_rate']

    def test_listen_equals_position_does_not_yield_a_perfect_score(self, user, ready_clip):
        """The exact shape the shipped client sends. Was 1.0."""
        rate = self._rate(
            user, ready_clip,
            listen_duration_ms=30_000, reel_position_ms=30_000,
        )
        assert rate == pytest.approx(0.5), (
            f"listen==reel_position gave {rate}; a caller must not be able to "
            "reach 1.0 by sending two equal numbers."
        )

    def test_early_skip_cannot_claim_full_completion(self, user, ready_clip):
        """Pressing Next 5s into a 60s clip."""
        rate = self._rate(
            user, ready_clip,
            listen_duration_ms=5_000, reel_position_ms=5_000,
        )
        assert rate < 0.2, f"5s of a 60s clip scored {rate}"

    def test_inflating_the_position_does_not_inflate_the_score(self, user, ready_clip):
        """Seek to the end, then skip: reel_position is large, listen is not.

        The client can still report whatever it likes for `listen_duration_ms`
        — the true measure of watch time lives in the player, and the
        client-side fix is tracked separately. What must not happen is the
        score being derived from the position.
        """
        rate = self._rate(
            user, ready_clip,
            listen_duration_ms=5_000, reel_position_ms=60_000,
        )
        assert rate == pytest.approx(5_000 / 60_000)

    def test_listening_longer_than_the_clip_is_capped(self, user, ready_clip):
        """A *small* over-run is still 1.0; a gross one is not a measurement.

        Was: `listen_duration_ms=10_000_000` against a 60s clip asserted
        1.0, because the old clamp was `min(listen, clip.duration_ms)` — so
        the maximum of the 30% term was one oversized integer away. The
        clamp is still right for a genuine over-run, which is what the first
        half pins; the second half is the forged case now rejected outright
        (see `test_ranking_exploit_cap.py::TestOverLongListenDurationIsRejected`
        for the tolerance and the reasoning).
        """
        rate = self._rate(
            user, ready_clip,
            listen_duration_ms=60_000 + 5_000, reel_position_ms=60_000,
        )
        assert rate == 1.0, "Watching a few seconds past the end is 1.0, not more."

        from backend.app.services.interactions import _completion_rate

        assert _completion_rate(10_000_000, ready_clip) is None, (
            "10,000,000ms of watch time on a 60s clip is a forged sample, not "
            "a capped one; the clamp turned it into the best possible input "
            "to the term"
        )

    def test_the_divisor_is_the_clip_duration_not_the_request(self, user, ready_clip):
        """Directly: the same listen value scores differently on clips of
        different length. Under the old formula it could not — the divisor
        came from the request."""
        from backend.app.models import AudioClip

        short = AudioClip.objects.create(
            creator=user, title='short', category='comedy', status='ready',
            duration_ms=10_000, semantic_vector=[0.1] * 384,
            acoustic_vector=[0.1] * 128,
        )
        assert self._rate(user, short, listen_duration_ms=5_000, reel_position_ms=5_000) \
            == pytest.approx(0.5)
        assert self._rate(user, ready_clip, listen_duration_ms=5_000, reel_position_ms=5_000) \
            == pytest.approx(5_000 / 60_000)

    def test_negative_and_zero_listen_times_are_rejected_by_the_formula(self, user, ready_clip):
        for bogus in (-1, 0):
            rate = self._rate(
                user, ready_clip,
                listen_duration_ms=bogus, reel_position_ms=30_000,
            )
            assert 0.0 <= rate <= 1.0, f"listen={bogus} produced {rate}"


class TestSingleSampleCannotPinTheGlobalScore:
    """The second half of the exploit: one sample became the whole value.

    Calls `_apply_completion_deltas` directly rather than driving it through
    `flush_counters_to_pg`. The flusher reads the shared counter store, and
    `_reset_backend_for_tests()` only drops the cached backend handle — it does
    not clear the data, so a test that goes through Redis inherits whatever
    earlier tests (or real dev telemetry) left behind. An earlier draft of this
    class asserted against a value contaminated exactly that way, and reported
    0.545 for a 0.5 baseline. The function is pure in its argument, so testing
    it directly is both simpler and deterministic.
    """

    @staticmethod
    def _apply(ready_clip, completion_sum, count):
        from backend.app.tasks import _apply_completion_deltas

        deltas = {
            (str(ready_clip.id), '99'): {
                'completion_sum': completion_sum,
                'completion_count': count,
            }
        }
        _apply_completion_deltas(deltas, 500)
        ready_clip.refresh_from_db()
        return ready_clip.avg_completion_rate

    def test_one_beat_cannot_set_the_score(self, ready_clip):
        ready_clip.avg_completion_rate = 0.5
        ready_clip.save(update_fields=['avg_completion_rate'])

        after = self._apply(ready_clip, 1.0, 1)

        assert after < 1.0, (
            "A single 1.0 sample set the global completion rate outright. "
            "avg_completion_rate is 30% of the recommendation score, so one "
            "user's one skip could promote a clip outright."
        )
        # (0.5 * 10 + 1.0) / 11 = 6/11 = 0.5454...
        assert after == pytest.approx(6.0 / 11)

    def test_many_samples_in_one_beat_still_cannot_exceed_one(self, ready_clip):
        ready_clip.avg_completion_rate = 0.5
        ready_clip.save(update_fields=['avg_completion_rate'])

        # 100 users all reporting a full completion in a single beat.
        after = self._apply(ready_clip, 100.0, 100)
        assert after <= 1.0
        assert after < 1.0, "Even 100 free samples must not reach a perfect score outright."

    def test_repeated_genuine_full_completions_still_converge_upward(self, ready_clip):
        """The blend must not become a permanent damper: a clip people really
        do finish has to be able to reach 1.0."""
        ready_clip.avg_completion_rate = 0.5
        ready_clip.save(update_fields=['avg_completion_rate'])

        for _ in range(200):
            after = self._apply(ready_clip, 1.0, 1)

        assert after == pytest.approx(1.0, abs=0.01), (
            "After 200 genuine full completions the score should be ~1.0, "
            "otherwise the metric stops tracking reality."
        )

    def test_a_low_score_is_recoverable(self, ready_clip):
        """The converse: a clip nobody finishes must be able to fall."""
        ready_clip.avg_completion_rate = 0.9
        ready_clip.save(update_fields=['avg_completion_rate'])

        for _ in range(200):
            after = self._apply(ready_clip, 0.0, 1)

        assert after == pytest.approx(0.0, abs=0.01)
