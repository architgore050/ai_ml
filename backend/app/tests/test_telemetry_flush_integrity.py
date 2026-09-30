"""Cross-tenant data-loss tests for the telemetry flush pipeline.

THE BUG
-------
``UserInteraction`` has a real DB-level unique constraint on
``(user, clip, interaction_type)`` (models.py Meta.unique_together,
materialised by migrations/0001_initial.py::AlterUniqueTogether). The
telemetry consumer wrote to that table with a bare
``bulk_create(interactions, batch_size=500)`` — no ``ignore_conflicts`` —
so a single colliding row raised ``IntegrityError``. ``bulk_create``
wraps its work in ``transaction.atomic(savepoint=False)``, so a
duplicate landing in statement #4 rolls statements #1-3 back too: up
to 500 unrelated users' telemetry is lost for that tick. The
``except Exception`` around it then pushed the *whole read window* to
the DLQ and XACK'd it off the main stream. The DLQ has no reader, so
the loss is permanent and silent.

The collision is not an attack. ``frontend/src/stores/player.tsx``
fires ``logTelemetry(..., {action_type: 'view'})`` roughly every 6
seconds for the currently-playing clip (plus on pause and
auto-advance), so one user watching one 300s clip emits ~50 ``view``
events for a single ``(user, clip, action_type)`` triple. The very
first one inserts; every subsequent one collides, for ever, because
``unique_together`` has no time dimension.

HOW THESE TESTS AVOID THE ``test_task_publisher`` TRAP
-----------------------------------------------------
``flush_telemetry_stream`` builds its own client with
``redis_lib.from_url(...)`` (tasks.py). It never reads
``tasks.cache``. So these tests:

* redirect the real cache at a scratch Redis DB index via
  ``override_settings`` — the task then dials a *real* Redis, and
  ``xautoclaim`` / ``BUSYGROUP`` / ``XACK`` accounting is exercised
  against genuine server behaviour, not a MagicMock that returns a
  MagicMock;
* wrap that real client in ``_SpyRedis``, which delegates to it and
  records every call, and assert ``from_url`` / ``xautoclaim`` /
  ``xack`` were actually called, so no patch here can be inert.

Every name patched is grep-verified to be read by the code under test;
the spy assertions are what prove it.
"""

import io
import json
import os
import uuid
from contextlib import redirect_stdout

import pytest
from django.core.management import call_command
from django.test import override_settings
from django.urls import reverse
from redis import exceptions as redis_lib_errors

from backend.app import tasks
from backend.app.models import AudioClip, UserInteraction
from backend.app.services.interactions import CONSUMER_GROUP, STREAM_KEY

# Every test here writes UserInteraction rows, so the real Postgres
# (not a mock) is the point. Redis is real too — see ``redis_scratch``.
#
# transaction=True (no wrapping atomic) is deliberate. pytest-django's
# default wraps each test in an atomic block; the code under test opens
# its own ``atomic(savepoint=False)`` inside bulk_create, so when it
# raises IntegrityError the *test's* transaction is poisoned and every
# subsequent assertion reports
# ``TransactionManagementError: You can't execute queries until the end
# of the 'atomic' block`` instead of the row count that actually matters.
pytestmark = pytest.mark.django_db(transaction=True)

# Scratch Redis DB index. The production cache lives on db 0 and is
# shared with the other suites; every key this file touches is
# namespaced by the *stream key* itself (stream:interaction.events,
# telemetry:queue, stream:interaction.events:dlq), so isolating by DB
# index is enough and needs no key mangling.
#
# FIXED 2026-09-30. This was a fixed literal, and several agents run
# suites against this one shared redis_cache_local concurrently. A fixed
# index is an unowned shared resource: whichever process flushes the DB
# in its fixture setup blows away the other process's consumer group
# mid-test. Observed as two different, equally inexplicable flakes in this
# file — ``BUSYGROUP`` from the helper's xgroup_create, and ``NOGROUP``
# from _pending_count, both landing in the microseconds between another
# process's flushdb and our next call. Deriving the index from the PID
# spreads concurrent runs across the two slots the server actually offers
# (``databases 16``) instead of stacking every run on one. 14 and 15 were
# confirmed empty before and after.
BASE_SCRATCH_DB_INDEX = 14
SCRATCH_DB_COUNT = 2
SCRATCH_DB_INDEX = BASE_SCRATCH_DB_INDEX + (os.getpid() % SCRATCH_DB_COUNT)

DLQ_KEY = 'stream:interaction.events:dlq'
LEGACY_QUEUE_KEY = 'telemetry:queue'


def _scratch_caches(base_location: str) -> dict:
    """Copy the real CACHES config but repoint LOCATION at a scratch DB."""
    import copy

    caches = copy.deepcopy(base_location)
    url = caches['default']['LOCATION']
    head, _, _ = url.rpartition('/')
    caches['default']['LOCATION'] = f'{head}/{SCRATCH_DB_INDEX}'
    return caches


class _SpyRedis:
    """Delegating wrapper that records every method call on a real client.

    A plain ``MagicMock`` would let a mis-shaped ``xreadgroup`` return a
    MagicMock, and the test would pass without the pipeline running at
    all. This keeps real Redis semantics (real BUSYGROUP, real
    XAUTOCLAIM reply shape, real XACK counting) while exposing
    call accounting.
    """

    def __init__(self, real):
        self._real = real
        self.calls: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name):
        attr = getattr(self._real, name)
        if not callable(attr):
            return attr

        def recorder(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return attr(*args, **kwargs)

        return recorder

    def close(self):
        self.calls.append(('close', (), {}))
        return self._real.close()

    # -- assertions helpers -------------------------------------------
    def count(self, name: str) -> int:
        return sum(1 for n, _, _ in self.calls if n == name)

    def args_for(self, name: str) -> list[tuple]:
        return [(a, k) for n, a, k in self.calls if n == name]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def redis_scratch(request):
    """Point CACHES at a scratch Redis DB for the duration of one test.

    ``override_settings`` is the isolation mechanism: the task reads
    ``settings.CACHES['default']['LOCATION']`` to build its own client,
    and django_redis reads the same value for ``cache.client.get_client()``
    in the legacy path. Both follow the override, so no patching of
    client construction is needed for the end-to-end assertions.
    """
    from django.conf import settings as django_settings
    import redis as redis_lib

    caches = _scratch_caches(django_settings.CACHES)
    with override_settings(CACHES=caches):
        raw = redis_lib.from_url(caches['default']['LOCATION'], decode_responses=True)
        raw.flushdb()
        spy = _SpyRedis(raw)
        _redis_scratch_cache['spy'] = spy
        _redis_scratch_cache['raw'] = raw
        try:
            yield
        finally:
            raw.flushdb()
            raw.close()
            _redis_scratch_cache.clear()


_redis_scratch_cache: dict = {}


@pytest.fixture
def raw(redis_scratch):
    """The unwrapped, real redis-py client on the scratch DB."""
    return _redis_scratch_cache['raw']


@pytest.fixture
def spy(redis_scratch):
    """The call-recording wrapper around the scratch client."""
    return _redis_scratch_cache['spy']


@pytest.fixture
def spy_client(monkeypatch, spy):
    """Inject the spy at the real seam, and return it.

    ``flush_telemetry_stream`` calls ``redis_lib.from_url(...)`` where
    ``redis_lib`` is the ``redis`` module imported *inside* the function
    body — so ``redis.from_url`` is the name to patch, and the returned
    client is the one the task really talks to.
    """

    def _from_url(url, **kwargs):
        # Deliberately ignore the URL the task computed and hand back the
        # scratch client: the task must be talking to a real Redis either
        # way, and this keeps the keyspace isolated.
        return spy

    monkeypatch.setattr('redis.from_url', _from_url)
    return spy


def _event(user_id, clip_id, *, event_id=None, action_type='view',
           watch_time_ms=1_000, completion_rate=0.1):
    return {
        'event_id': event_id or str(uuid.uuid4()),
        'user_id': str(user_id),
        'clip_id': str(clip_id),
        'action_type': action_type,
        'watch_time_ms': watch_time_ms,
        'completion_rate': completion_rate,
    }


def _stream_fields(event: dict) -> dict:
    """The exact field shape ``services.interactions._xadd_telemetry`` writes."""
    return {
        'event_id': event['event_id'],
        'schema_version': '1.0.0',
        'payload': json.dumps(event),
    }


def _seed_stream(raw, events, *, consumer=None):
    """Create the group and XADD events. Returns the list of entry ids.

    When ``consumer`` is given the entries are read into the PEL under
    that consumer name and left un-ACKed — i.e. stranded, the way a
    crashed worker leaves them.

    FIXED 2026-09-30. This used to call ``xgroup_create`` unconditionally,
    which raised a bare ``ResponseError: BUSYGROUP`` roughly 1 run in 10.
    The cause is not this helper: ``redis_scratch`` flushes the scratch DB
    before every test, so the group cannot survive *our* own runs, and
    nothing else in the repo selects that DB index (grep-verified across
    the tree). Something else is writing the shared ``redis_cache_local``
    container concurrently — four other agents are running suites against
    it — and it lands between the flush and this call. The window is
    microseconds wide, which is why it is rare and why it is always here
    rather than in the task under test.

    Two changes, neither of which weakens an assertion about the consumer:

    * the create is idempotent, exactly like the production code treats it.
      A pre-existing group is harmless here: the events XADDed below get
      strictly higher stream ids than any group's ``last-delivered-id``,
      so ``'>'`` still delivers every one of them;
    * a genuine non-BUSYGROUP error is re-raised with the keyspace state
      attached, so the next occurrence is diagnosable instead of cryptic.

    ``TestConsumerGroupLifecycle::test_busygroup_does_not_raise`` still
    asserts the BUSYGROUP precondition for the task, explicitly, with
    ``pytest.raises`` — so "the group already exists" remains a pinned
    property of that test rather than an accident of this helper.
    """
    try:
        raw.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id='0', mkstream=True)
    except redis_lib_errors.ResponseError as exc:
        if 'BUSYGROUP' not in str(exc):
            raise AssertionError(
                f'xgroup_create failed for a reason other than BUSYGROUP: {exc} '
                f'(dbsize={raw.dbsize()}, keys={sorted(raw.keys("*"))[:20]})'
            ) from exc
    entry_ids = [raw.xadd(STREAM_KEY, _stream_fields(e)) for e in events]
    if consumer is not None:
        raw.xreadgroup(CONSUMER_GROUP, consumer, {STREAM_KEY: '>'}, count=len(entry_ids))
    return entry_ids


def _pending_count(raw) -> int:
    """XPENDING depth for the consumer group.

    Every test that calls this has already seeded the group, so NOGROUP is
    never a legitimate outcome — it means something outside this process
    deleted the group mid-test. Say so plainly instead of surfacing a bare
    redis ResponseError that reads like a product bug. See the note on
    SCRATCH_DB_INDEX.
    """
    try:
        return raw.xpending(STREAM_KEY, CONSUMER_GROUP)['pending']
    except redis_lib_errors.ResponseError as exc:
        raise AssertionError(
            f'consumer group vanished mid-test ({exc}). Every caller seeds it '
            f'first, so this is interference on the shared redis_cache_local '
            f'container, not a behaviour under test. pid={os.getpid()} '
            f'scratch_db={SCRATCH_DB_INDEX} dbsize={raw.dbsize()} '
            f'keys={sorted(raw.keys("*"))[:20]}'
        ) from exc


def _make_users(django_user_model, count: int):
    """Bulk-create ``count`` users without running the password hasher.

    Only the flush path is under test here; PBKDF2 over 50 accounts
    would dominate the runtime for no added coverage.
    """
    return django_user_model.objects.bulk_create([
        django_user_model(
            username=f'tenant_{i:03d}',
            email=f'tenant_{i:03d}@example.com',
            password='!unusable-for-tests',
        )
        for i in range(count)
    ])


# ---------------------------------------------------------------------------
# 1. Two heartbeats for one (user, clip) -> one row, no DLQ, both ACKed
# ---------------------------------------------------------------------------

class TestCoalesceWithinReadWindow:

    def test_duplicate_view_events_collapse_to_one_row(
        self, spy_client, raw, user, ready_clip,
    ):
        first = _event(user.id, ready_clip.id, event_id='e1', watch_time_ms=1_000)
        second = _event(user.id, ready_clip.id, event_id='e2', watch_time_ms=7_000)
        entry_ids = _seed_stream(raw, [first, second])

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        rows = list(UserInteraction.objects.filter(user=user, clip=ready_clip))
        assert len(rows) == 1, f'expected coalescing to 1 row, got {len(rows)}: {result}'
        assert raw.xlen(DLQ_KEY) == 0, 'a collision inside one window must not reach the DLQ'
        # Both stream entries are fully settled: nothing left in the PEL.
        assert _pending_count(raw) == 0
        assert len(entry_ids) == 2

    def test_coalescing_keeps_the_last_heartbeat(
        self, spy_client, raw, user, ready_clip,
    ):
        """The surviving row must be the FINAL heartbeat, not the first.

        ``watch_time_ms`` is a monotonic "user is still watching at T"
        signal. Keeping the first heartbeat would pin the row to the
        moment playback started and throw away the position the user
        actually reached.
        """
        events = [
            _event(user.id, ready_clip.id, event_id=f'e{i}', watch_time_ms=ms)
            for i, ms in enumerate((1_000, 2_000, 3_000), start=1)
        ]
        _seed_stream(raw, events)

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        row = UserInteraction.objects.get(user=user, clip=ready_clip, interaction_type='view')
        assert row.watch_time_ms == 3_000, (
            f'expected the last heartbeat (3000ms), got {row.watch_time_ms}'
        )

    def test_distinct_action_types_are_not_collapsed(
        self, spy_client, raw, user, ready_clip,
    ):
        """Only identical ``(user, clip, interaction_type)`` coalesce."""
        events = [
            _event(user.id, ready_clip.id, event_id='v1', action_type='view'),
            _event(user.id, ready_clip.id, event_id='v2', action_type='view'),
            _event(user.id, ready_clip.id, event_id='l1', action_type='like'),
        ]
        _seed_stream(raw, events)

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        types = sorted(
            UserInteraction.objects
            .filter(user=user, clip=ready_clip)
            .values_list('interaction_type', flat=True)
        )
        assert types == ['like', 'view']


# ---------------------------------------------------------------------------
# 2. THE CROSS-TENANT TEST
# ---------------------------------------------------------------------------

class TestCrossTenantBatchLoss:

    def test_one_duplicate_among_fifty_tenants_keeps_all_fifty(
        self, spy_client, raw, django_user_model, ready_clip,
    ):
        """One colliding event must not discard 50 other accounts' data.

        This is the whole bug in one test. 50 distinct users each emit a
        single ``view`` for the same clip, plus one EXTRA heartbeat for
        tenant 7 — which is exactly what the 6-second player heartbeat
        produces organically. On the unpatched code the extra row raises
        IntegrityError inside a savepoint-less atomic block, so all 50
        legitimate inserts roll back and every entry in the window is
        DLQ'd and XACK'd into oblivion.
        """
        tenants = _make_users(django_user_model, 50)
        events = [
            _event(u.id, ready_clip.id, event_id=f'tenant-{i}', watch_time_ms=1_000)
            for i, u in enumerate(tenants)
        ]
        # The poison: a second heartbeat for tenant 7, distinct event_id
        # (so it survives the SETNX dedup) but the same unique_together key.
        events.append(
            _event(tenants[7].id, ready_clip.id, event_id='tenant-7-second-heartbeat',
                   watch_time_ms=9_000)
        )
        _seed_stream(raw, events)

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        landed = set(
            UserInteraction.objects
            .filter(clip=ready_clip, interaction_type='view')
            .values_list('user_id', flat=True)
        )
        assert landed == {u.id for u in tenants}, (
            f'{len(landed)}/50 tenants landed; expected all 50. '
            f'missing={sorted({u.id for u in tenants} - landed)} '
            f'task said: {result!r} '
            f'(stream len={raw.xlen(STREAM_KEY)}, dlq len={raw.xlen(DLQ_KEY)}, '
            f'pending={_pending_count(raw)})'
        )
        assert raw.xlen(DLQ_KEY) == 0, (
            'no tenant event should be DLQ-ed when the only problem was a '
            'same-key heartbeat'
        )
        assert _pending_count(raw) == 0

    def test_tenant_rows_carry_their_own_payload(
        self, spy_client, raw, django_user_model, ready_clip,
    ):
        """Coalescing is per-(user, clip, type): it must not merge tenants."""
        tenants = _make_users(django_user_model, 5)
        events = []
        for i, u in enumerate(tenants):
            for j, ms in enumerate((1_000, 2_000)):
                events.append(_event(u.id, ready_clip.id,
                                     event_id=f'u{i}-h{j}', watch_time_ms=ms))
        _seed_stream(raw, events)

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        rows = {
            r.user_id: r.watch_time_ms
            for r in UserInteraction.objects.filter(clip=ready_clip)
        }
        assert rows == {u.id: 2_000 for u in tenants}


# ---------------------------------------------------------------------------
# 2b. Cross-tick collisions — the case coalescing cannot reach
# ---------------------------------------------------------------------------

class TestCrossTickConflict:
    """The conflict that ``ignore_conflicts=True`` exists for.

    Coalescing only ever sees one read window. These tests put the colliding
    row in Postgres *before* the window is read, which is the ordinary
    steady state: ``flush_counters_to_pg`` does
    ``update_or_create(..., interaction_type='view')`` on the same
    ``(user, clip)`` pair, and ``record_like_toggle`` / ``record_share`` use
    ``get_or_create`` on the same triple. The two writers are in a permanent
    race and the stream side used to lose the entire tick when it lost.
    """

    def test_existing_row_collision_does_not_lose_the_other_tenants(
        self, spy_client, raw, django_user_model, ready_clip,
    ):
        tenants = _make_users(django_user_model, 20)
        # What a previous tick (or the synchronous writer) already left behind.
        UserInteraction.objects.create(
            user=tenants[0], clip=ready_clip, interaction_type='view',
            watch_time_ms=999, completion_rate=0.1, is_active=True,
        )
        # Every tenant now emits a *new* event_id, so the SETNX dedup cannot
        # classify any of them as already-seen either.
        _seed_stream(raw, [
            _event(u.id, ready_clip.id, event_id=f'xtick-{i}', watch_time_ms=5_000)
            for i, u in enumerate(tenants)
        ])

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        landed = set(
            UserInteraction.objects
            .filter(clip=ready_clip, interaction_type='view')
            .values_list('user_id', flat=True)
        )
        assert landed == {u.id for u in tenants}, (
            f'{len(landed)}/20 tenants landed; a single pre-existing row must '
            f'not abort the batch'
        )
        assert raw.xlen(DLQ_KEY) == 0, (
            'ON CONFLICT DO NOTHING must absorb the collision — routing to '
            'the DLQ would discard 19 accounts to save one'
        )
        assert _pending_count(raw) == 0

    def test_collision_keeps_the_existing_row_and_that_is_documented(
        self, spy_client, raw, django_user_model, ready_clip,
    ):
        """Pins the *known weakness* of ON CONFLICT DO NOTHING, on purpose.

        For a cross-tick collision the surviving row is the earlier one, so
        tenant 0's watch_time stays 999 and the newer heartbeat is discarded.
        That is wrong as a signal and it is accepted deliberately: the
        alternative is losing 19 other accounts. The fix for the signal is
        to stop writing the row twice, not to make the loser win.
        """
        tenant = _make_users(django_user_model, 1)[0]
        UserInteraction.objects.create(
            user=tenant, clip=ready_clip, interaction_type='view',
            watch_time_ms=999, completion_rate=0.1, is_active=True,
        )
        _seed_stream(raw, [_event(tenant.id, ready_clip.id,
                                  event_id='xtick-1', watch_time_ms=5_000)])

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        row = UserInteraction.objects.get(user=tenant, clip=ready_clip,
                                          interaction_type='view')
        assert row.watch_time_ms == 999, (
            'documented tradeoff: the pre-existing row survives a cross-tick '
            'collision, so the newer heartbeat is lost'
        )

    def test_legacy_list_also_survives_a_pre_existing_row(
        self, raw, user, ready_clip,
    ):
        """Same guarantee on the Redis-degraded list fallback."""
        UserInteraction.objects.create(
            user=user, clip=ready_clip, interaction_type='view',
            watch_time_ms=999, completion_rate=0.1, is_active=True,
        )
        for i in (1, 2):
            raw.rpush(LEGACY_QUEUE_KEY, json.dumps(
                _event(user.id, ready_clip.id, event_id=f'legacy-xtick-{i}',
                       watch_time_ms=6_000)
            ))

        result = tasks.flush_telemetry_legacy.run(max_events=10)

        assert raw.llen(LEGACY_QUEUE_KEY) == 0, (
            f'the events were consumed either way; they must not be requeued: {result}'
        )
        assert UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='view',
        ).count() == 1


# ---------------------------------------------------------------------------
# 3. Stale PEL entries (XAUTOCLAIM reaping)
# ---------------------------------------------------------------------------

class TestPendingReaping:

    def test_stranded_entry_under_dead_consumer_is_reaped(
        self, spy_client, raw, monkeypatch, user, ready_clip,
    ):
        """A worker that dies between XREADGROUP and XACK strands entries.

        ``consumer_name`` is ``celery-{os.getpid()}``. Under Celery
        prefork that is a stable per-worker name, so a restarted worker
        has a DIFFERENT name and the stranded entries sit in the PEL
        forever: the only read in the task uses the ``'>'`` cursor, which
        never returns pending entries. XAUTOCLAIM is the reaper.
        """
        monkeypatch.setattr(tasks, 'TELEMETRY_CLAIM_MIN_IDLE_MS', 0, raising=False)
        event = _event(user.id, ready_clip.id, event_id='stranded-1')
        _seed_stream(raw, [event], consumer='celery-99999')  # never XACKed

        assert _pending_count(raw) == 1, 'precondition: one stranded entry'

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert spy_client.count('xautoclaim') >= 1, (
            'XAUTOCLAIM was never called, so the entry below could only '
            'have arrived by accident'
        )
        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1, (
            f'stranded entry was not reaped and processed: {result}'
        )
        assert _pending_count(raw) == 0

    def test_freshly_delivered_entries_are_not_stolen(
        self, spy_client, raw, monkeypatch, user, ready_clip,
    ):
        """The idle threshold must not re-claim work still in flight.

        With a realistic 60s threshold (10x the 10s beat interval), an
        entry this run is about to write stays owned by this run.

        NOTE (fixed 2026-09-30): as first written this test read
        ``spy_client.args_for('xautoclaim')`` *before* calling
        ``flush_telemetry_stream.run()``, so it raised ``IndexError: list
        index out of range`` for every implementation — the spy can only
        have recorded a call once something has made it. The expectation
        itself is correct and kept: the min-idle-time handed to XAUTOCLAIM
        must be the configured ``TELEMETRY_CLAIM_MIN_IDLE_MS``. Only the
        assertion order was wrong; it now reads the log after the run.
        """
        monkeypatch.setattr(tasks, 'TELEMETRY_CLAIM_MIN_IDLE_MS', 60_000, raising=False)
        event = _event(user.id, ready_clip.id, event_id='fresh-1')
        _seed_stream(raw, [event], consumer='celery-inflight')

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert spy_client.count('xautoclaim') == 1
        claim_args, _ = spy_client.args_for('xautoclaim')[0]
        assert claim_args[3] == 60_000, (
            f'XAUTOCLAIM min_idle_time should be the configured threshold, '
            f'got {claim_args[3]!r}'
        )
        # The fresh entry is NOT claimable, but it is still in the PEL of a
        # dead-ish consumer name, so it is not in the '>' window either. It
        # must be left pending rather than lost.
        assert _pending_count(raw) == 1

    def test_reaped_entries_go_through_the_same_write_path(
        self, spy_client, raw, monkeypatch, user, ready_clip,
    ):
        """A reaped duplicate of a new event must still coalesce, not blow up."""
        monkeypatch.setattr(tasks, 'TELEMETRY_CLAIM_MIN_IDLE_MS', 0, raising=False)
        events = [
            _event(user.id, ready_clip.id, event_id='r1', watch_time_ms=1_000),
            _event(user.id, ready_clip.id, event_id='r2', watch_time_ms=5_000),
        ]
        _seed_stream(raw, events, consumer='celery-88888')

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1
        assert raw.xlen(DLQ_KEY) == 0


# ---------------------------------------------------------------------------
# 4. ACK / DLQ accounting
# ---------------------------------------------------------------------------

class TestAckAndDlqAccounting:

    def test_deduped_entry_is_not_dlqed_when_the_batch_collides(
        self, spy_client, raw, user, ready_clip,
    ):
        """Entries that were already safe must stay ACK-eligible.

        The unpatched ``except`` block iterated the raw read window and
        *removed* ids from ``processed_ids`` — so an entry that had been
        dropped by the SETNX dedup (already in Postgres from a previous
        run) got re-classified as failed and pushed to the DLQ. A DLQ
        entry for an event that is safely in the database is a lie, and it
        inflates the depth past the "> 0 pages us" threshold.
        """
        # Pre-seed the dedup key so 'already-seen' is classified as a dup
        # and never enters the write batch.
        raw.set('processed_event:already-seen-1', '1', nx=True, ex=86400)

        already_seen = _event(user.id, ready_clip.id, event_id='already-seen-1')
        other = _event(user.id, ready_clip.id, event_id='other-1', watch_time_ms=4_000)
        entry_ids = _seed_stream(raw, [already_seen, other])

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1
        assert raw.xlen(DLQ_KEY) == 0, (
            'an event already deduped into Postgres must never be DLQ-ed'
        )
        assert _pending_count(raw) == 0

        # xack(stream, group, *ids) — args[2:] are the entry ids.
        acked = {i for args, _ in spy_client.args_for('xack') for i in args[2:]}
        assert acked == set(entry_ids), f'both entries must be XACKed, got {acked}'

    def test_malformed_event_still_reaches_the_dlq(
        self, spy_client, raw, user, ready_clip,
    ):
        """Genuinely unparseable entries must not be silently dropped."""
        good = _event(user.id, ready_clip.id, event_id='good-1')
        _seed_stream(raw, [good])
        # An entry whose payload field is missing entirely.
        raw.xadd(STREAM_KEY, {'event_id': 'broken-1', 'schema_version': '1.0.0'})

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1
        assert raw.xlen(DLQ_KEY) == 1
        assert _pending_count(raw) == 0, 'a DLQ route must still XACK the source entry'

    def test_dlq_entry_records_the_original_stream_id(
        self, spy_client, raw, user, ready_clip,
    ):
        good = _event(user.id, ready_clip.id, event_id='good-1')
        _seed_stream(raw, [good])
        bad_id = raw.xadd(STREAM_KEY, {'event_id': 'broken-2'})

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        entry = raw.xrange(DLQ_KEY)[0]
        assert entry[1]['original_id'] == bad_id
        assert entry[1]['reason']


# ---------------------------------------------------------------------------
# 5. Real producer -> real consumer, end to end
# ---------------------------------------------------------------------------

class TestEndToEndAgainstRealRedis:

    def test_xadd_by_the_real_producer_lands_a_row(
        self, spy_client, raw, user, ready_clip, monkeypatch,
    ):
        """Full round trip through the actual producer.

        Guards a defect that mocks hide completely: the consumer's
        client is built with ``redis_lib.from_url(url, ...)`` and the
        cache config sets no ``decode_responses``. Without it, redis-py
        returns the stream *field names* as bytes, so
        ``fields.get('payload')`` is always ``None`` and every single
        event is DLQ'd as "empty payload" — 100% telemetry loss that a
        MagicMock-based test cannot see, because the mock hands back the
        dict the test itself built.
        """
        from backend.app.services.interactions import record_telemetry

        monkeypatch.setenv('ECHOFLOW_TELEMETRY_STREAM', 'on')
        record_telemetry(user, ready_clip, action_type='view', watch_time_ms=4_200)

        assert raw.xlen(STREAM_KEY) == 1, 'producer did not XADD to the stream'
        assert raw.xlen(DLQ_KEY) == 0, 'nothing should be DLQ-ed before the flush'

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        rows = UserInteraction.objects.filter(user=user, clip=ready_clip)
        assert rows.count() == 1, (
            'the real producer\'s event did not reach Postgres — check that '
            f'the consumer client decodes responses. task said: {result!r} '
            f'(stream len={raw.xlen(STREAM_KEY)}, dlq len={raw.xlen(DLQ_KEY)})'
        )
        assert rows.first().watch_time_ms == 4_200
        assert raw.xlen(DLQ_KEY) == 0


class TestConsumerClientEncoding:
    """Pins the one defect ``TestEndToEndAgainstRealRedis`` structurally cannot see.

    ``TestEndToEndAgainstRealRedis`` monkeypatches ``redis.from_url`` and hands
    the task a client built with ``decode_responses=True``, so it proves the
    producer and consumer agree on the *field shape* while being immune to the
    flag itself. Verified against the real server on 2026-09-30: with the
    unpatched call (``from_url(url, socket_keepalive=True)`` and no
    ``decode_responses``), ``XREADGROUP`` returns
    ``{b'event_id': b'...', b'payload': b'...'}`` and
    ``fields.get('payload')`` is ``None`` — so every event in production takes
    the "empty payload" branch and is DLQ'd. That is 100% telemetry loss,
    silent, and the round-trip test passes right through it.

    So assert the kwarg itself.
    """

    def test_consumer_requests_decoded_stream_fields(
        self, raw, spy, monkeypatch, user, ready_clip,
    ):
        captured: dict = {}

        def _from_url(url, **kwargs):
            captured.update(kwargs)
            return spy

        monkeypatch.setattr('redis.from_url', _from_url)
        _seed_stream(raw, [_event(user.id, ready_clip.id, event_id='enc-1')])

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert captured.get('decode_responses') is True, (
            'the consumer must build its client with decode_responses=True; '
            f'from_url was called with {captured!r}'
        )
        # Belt and braces: prove the flag is what makes the payload readable,
        # so this cannot pass on a client that happens to decode anyway.
        assert raw.xlen(DLQ_KEY) == 0
        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1


# ---------------------------------------------------------------------------
# 6. XGROUP lifecycle
# ---------------------------------------------------------------------------

class TestConsumerGroupLifecycle:

    def test_busygroup_does_not_raise(
        self, spy_client, raw, user, ready_clip,
    ):
        """Re-creating an existing group raises BUSYGROUP; it must be swallowed.

        The group create is inside a bare ``try/except Exception: pass``
        on purpose. If that is ever narrowed, every tick after the first
        crashes and telemetry stops silently.

        NOTE (fixed 2026-09-30): this test as first written called
        ``xgroup_create`` three times — once directly, once inside
        ``_seed_stream``, and once again. The *second* call already
        succeeded, so the *third* raised BUSYGROUP **in the test's own
        setup** and the test errored before ever reaching the task under
        test. One create is all it takes: ``_seed_stream`` already
        creates the group, which is exactly the BUSYGROUP precondition
        this test wants.
        """
        _seed_stream(raw, [_event(user.id, ready_clip.id, event_id='g1')])
        with pytest.raises(redis_lib_errors.ResponseError):
            # Precondition, asserted rather than assumed: the group really is
            # there, so the task's own xgroup_create really will BUSYGROUP.
            raw.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id='0', mkstream=True)

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        assert spy_client.count('xgroup_create') == 1
        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1
        assert 'Flushed 1 telemetry events' in result

    def test_missing_group_is_created_on_first_run(
        self, spy_client, raw, user, ready_clip,
    ):
        """First run on a virgin Redis must bootstrap the group itself."""
        assert not raw.exists(STREAM_KEY)
        raw.xadd(STREAM_KEY, _stream_fields(_event(user.id, ready_clip.id, event_id='v')))

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        groups = {g['name'] for g in raw.xinfo_groups(STREAM_KEY)}
        assert CONSUMER_GROUP in groups
        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 1


# ---------------------------------------------------------------------------
# 7. The legacy LIST fallback
# ---------------------------------------------------------------------------

class TestLegacyListFallback:

    def test_duplicate_in_lpopped_batch_does_not_lose_the_rest(
        self, raw, user, ready_clip,
    ):
        """``flush_telemetry_legacy`` must coalesce too.

        The events are already ``LPOP``ed by the time ``bulk_create``
        runs, and the old call had no ``ignore_conflicts`` and no
        ``except`` at all — so one duplicate raised ``IntegrityError``
        out of the task with the legitimate events destroyed and nothing
        anywhere to recover them from. This is the Redis-degraded
        fallback path, so it fails precisely when the system can least
        afford it.
        """
        for ev in (
            _event(user.id, ready_clip.id, event_id='l1', watch_time_ms=1_000),
            _event(user.id, ready_clip.id, event_id='l2', watch_time_ms=8_000),
        ):
            raw.rpush(LEGACY_QUEUE_KEY, json.dumps(ev))
        assert raw.llen(LEGACY_QUEUE_KEY) == 2

        result = tasks.flush_telemetry_legacy.run(max_events=10)

        rows = list(UserInteraction.objects.filter(user=user, clip=ready_clip))
        assert len(rows) == 1, f'expected 1 coalesced row, got {len(rows)}: {result}'
        assert rows[0].watch_time_ms == 8_000, 'legacy coalescing must keep the last event'

    def test_lpopped_events_are_not_destroyed_by_a_failed_insert(
        self, raw, user, ready_clip, monkeypatch,
    ):
        """A mid-batch DB failure must not leave the events in the void.

        The list consumer has no PEL, so once an event is ``LPOP``ed the
        only way back is to push it onto the queue again. Losing the batch
        is not an option on a path that only runs when Redis is already
        degraded.
        """
        ev = _event(user.id, ready_clip.id, event_id='requeue-1')
        raw.rpush(LEGACY_QUEUE_KEY, json.dumps(ev))

        def _boom(*a, **kw):
            raise RuntimeError('simulated DB outage')

        monkeypatch.setattr(
            UserInteraction.objects, 'bulk_create', staticmethod(_boom),
        )

        result = tasks.flush_telemetry_legacy.run(max_events=10)

        assert raw.llen(LEGACY_QUEUE_KEY) == 1, (
            'the LPOPped event must be put back for the next tick, not dropped'
        )
        assert UserInteraction.objects.filter(user=user, clip=ready_clip).count() == 0
        assert '1' in result, f'the return value must report the requeue: {result}'

    def test_unresolvable_fk_events_are_dropped_not_requeued(
        self, raw, user, ready_clip,
    ):
        """An event whose clip was deleted has nothing worth replaying."""
        raw.rpush(LEGACY_QUEUE_KEY, json.dumps(
            _event(user.id, uuid.uuid4(), event_id='ghost-clip')
        ))

        result = tasks.flush_telemetry_legacy.run(max_events=10)

        assert raw.llen(LEGACY_QUEUE_KEY) == 0
        assert UserInteraction.objects.count() == 0
        assert 'No valid events' in result


# ---------------------------------------------------------------------------
# 8. FK integrity under ON CONFLICT DO NOTHING
# ---------------------------------------------------------------------------

class TestForeignKeyIntegrity:

    def test_unknown_user_and_clip_are_filtered_before_insert(
        self, spy_client, raw, user, ready_clip,
    ):
        """Pin the filter that makes ``ignore_conflicts`` safe.

        ``ON CONFLICT DO NOTHING`` (what ``ignore_conflicts=True``
        compiles to) swallows *any* constraint violation, including a
        foreign-key violation for a user or clip that no longer exists.
        That is only tolerable because unresolved FKs are dropped before
        the INSERT. This test pins that pre-filter: a ghost user id and
        a ghost clip id must not produce rows, and must not be replayed
        forever.
        """
        ghost_user_id = 987_654_321
        ghost_clip_id = uuid.uuid4()
        events = [
            _event(user.id, ready_clip.id, event_id='ok-1', watch_time_ms=3_000),
            _event(ghost_user_id, ready_clip.id, event_id='ghost-user'),
            _event(user.id, ghost_clip_id, event_id='ghost-clip'),
            _event('not-an-int', ready_clip.id, event_id='uncastable-user'),
            _event(user.id, 'not-a-uuid', event_id='uncastable-clip'),
        ]
        _seed_stream(raw, events)

        result = tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        rows = list(UserInteraction.objects.all())
        assert len(rows) == 1, f'only the resolvable event may become a row, got {rows}'
        assert rows[0].user_id == user.id and rows[0].clip_id == ready_clip.id
        # Unresolvable events are ACKed-and-dropped by design (there is no
        # retry that could ever resolve them), and must not be DLQ-spammed.
        assert raw.xlen(DLQ_KEY) == 0
        assert _pending_count(raw) == 0
        assert 'Flushed 1 telemetry events' in result

    def test_interactions_written_reference_existing_rows(
        self, spy_client, raw, user, ready_clip,
    ):
        """Every row the consumer writes must point at a live FK.

        Asserted structurally rather than by trusting the pre-filter.
        """
        _seed_stream(raw, [_event(user.id, ready_clip.id, event_id='fk-1')])

        tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        row = UserInteraction.objects.get()
        assert row.user_id == user.id
        assert row.clip_id == ready_clip.id


# ---------------------------------------------------------------------------
# 9. DLQ observability
# ---------------------------------------------------------------------------

class TestDlqInspectionCommand:

    def _run(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            call_command('inspect_telemetry_dlq', *argv)
        return out.getvalue()

    def test_reports_zero_depth_as_healthy(self, raw):
        payload = json.loads(self._run('--json'))
        assert payload['dlq_depth'] == 0
        assert payload['ok'] is True

    def test_lists_and_counts_entries(self, raw):
        for i in range(3):
            raw.xadd(DLQ_KEY, {'original_id': f'1-{i}', 'reason': 'malformed_or_duplicate'})

        payload = json.loads(self._run('--json', '--limit', '2'))

        assert payload['dlq_depth'] == 3, 'total depth must not be limited by --limit'
        assert len(payload['entries']) == 2, '--limit bounds the listing, not the count'
        assert payload['ok'] is False
        assert {e['original_id'] for e in payload['entries']} == {'1-1', '1-2'}

    def test_check_mode_exit_code_signals_the_alert(
        self, raw,
    ):
        """``docs/.../01-system-overview.md:224`` prescribes "alert on depth > 0".

        A command is only wireable into an alert if it has an exit code.
        """
        with pytest.raises(SystemExit) as exc:
            self._run('--check')
        assert exc.value.code == 0

        raw.xadd(DLQ_KEY, {'original_id': '1-0', 'reason': 'malformed_or_duplicate'})
        with pytest.raises(SystemExit) as exc:
            self._run('--check')
        assert exc.value.code == 1

    def test_surfaces_pending_depth_so_the_pel_alert_is_wireable(
        self, spy_client, raw, user, ready_clip,
    ):
        """The doc's ``XPENDING ... < 1000`` threshold is unwireable today.

        ``docs/EXPLAIN/redis-celery/01-redis-usage.md:281`` lists it as a
        critical metric, but no application code called XPENDING, so the
        alert had nothing to scrape. The inspection command reports it.
        """
        _seed_stream(raw, [_event(user.id, ready_clip.id, event_id='p1')],
                     consumer='celery-424242')

        payload = json.loads(self._run('--json'))

        assert payload['pending'] == 1
        assert payload['pending_threshold'] == 1000
