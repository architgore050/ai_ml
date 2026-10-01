"""The test suite must not be able to destroy live development state.

The defect
----------
``settings.CACHES`` has exactly one alias and it points at whatever
``REDIS_CACHE_URL`` resolves to, which in every stack is the *development*
Redis, database 0. Two mechanisms then write into that shared keyspace:

* ``django_redis.cache.RedisCache.clear()`` is ``FLUSHDB``, not a prefix
  scan. conftest's ``clear_throttle_cache`` calls it on purpose — one file's
  rate-limit spend must not fail another file's authorization assertions — so
  any test file requesting that fixture wipes the live throttle budgets, the
  live ``user_feed:*`` queues, the live ``user_vectors:*`` cache and every
  live ``clip:*`` counter.
* ``counter_store.drain()`` is ``KEYS clip:*`` + ``DEL``, a second door into
  the same keyspace, so two concurrent runs delete each other's pending
  telemetry even when neither one flushes.

``TEST_DB_NAME`` already isolates Postgres per run and ``--reuse-db`` protects
the schema, which is precisely what made the gap invisible: the run looked
isolated while Redis was shared. Measured consequence — three runs of
identical, unmodified code produced three different failure sets.

The fix, and the ordering trap it has to survive
-----------------------------------------------
The index is retargeted in ``EchoFlow/settings.py`` (``resolve_test_redis_cache_url``),
gated on ``testing_enabled()``. It cannot go in ``conftest.py``: pytest-django
calls ``django.setup()`` from its own ``pytest_load_initial_conftests``, while
``_pytest.config``'s implementation of that hook is ``trylast``, so the
rootdir conftest's module body has not executed yet and an ``os.environ``
assignment there cannot reach ``CACHES``. ``TestTheOverrideReachesSettings``
pins both halves of that claim — the override demonstrably works, and a late
assignment demonstrably does not move the built config.

Everything here is gated on the *live* configuration actually pointing
somewhere else. A test that only exercised the resolver function would pass
even if the resolver were never called, so the load-bearing assertions are the
ones that talk to a real Redis: they write a canary into the development
index, run the real teardown path, and require the canary to survive.
"""
import os
import uuid
from unittest import mock
from urllib.parse import urlsplit

import pytest
import redis as redis_lib
from django.conf import settings
from django.core.cache import cache

from backend.EchoFlow.settings import resolve_test_redis_cache_url


#: The index every stack uses for development. Nothing the suite does may
#: reach it.
LIVE_CACHE_INDEX = 0

#: Scratch indexes claimed by another module's own fixture, which FLUSHes
#: them. `test_telemetry_flush_integrity.py` derives
#: `BASE_SCRATCH_DB_INDEX + os.getpid() % SCRATCH_DB_COUNT` = {14, 15}. If the
#: suite default ever moved there, a concurrent run of that file would hand
#: back the very defect this file pins.
RESERVED_SCRATCH_INDEXES = frozenset({14, 15})


def _db_index(url: str) -> int:
    return int(urlsplit(url).path.lstrip('/') or 0)


def _live_url(live_location: str) -> str:
    """The development-index URL on the same server as ``live_location``."""
    parts = urlsplit(live_location)
    return parts._replace(path=f'/{LIVE_CACHE_INDEX}').geturl()


@pytest.fixture
def live_client():
    """A raw redis-py client on the development index.

    Deliberately built from the URL rather than reached through ``cache``: the
    assertions below are about what the *development* database holds, and
    going through the app's own cache handle could not tell the difference
    between "isolated" and "flushed".
    """
    client = redis_lib.from_url(
        _live_url(settings.CACHES['default']['LOCATION']),
        decode_responses=True,
    )
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def run_client():
    """A raw redis-py client on this run's index — the cache's own server."""
    client = redis_lib.from_url(
        settings.CACHES['default']['LOCATION'], decode_responses=True)
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def canary(live_client):
    """A key planted in the development index, deleted on teardown."""
    key = f'echoflow_dev_canary:{uuid.uuid4().hex}'
    live_client.set(key, 'alive', ex=300)
    try:
        yield key
    finally:
        live_client.delete(key)


# ---------------------------------------------------------------------------
# The live configuration points at the isolated index
# ---------------------------------------------------------------------------

class TestTheRunningSuiteIsIsolated:

    def test_the_cache_is_not_on_the_development_index(self):
        location = settings.CACHES['default']['LOCATION']
        assert _db_index(location) != LIVE_CACHE_INDEX, (
            'the suite is on the development Redis database; every '
            'cache.clear() it performs is a FLUSHDB of live state'
        )

    def test_the_index_is_the_one_this_process_was_started_with(self):
        """The resolver is only worth anything if the config follows it.

        Read from the environment the process was launched with, which is how
        a parallel agent picks its own slot:
        ``docker compose exec -e TEST_REDIS_CACHE_DB=14 web_local pytest``.
        """
        expected = int(os.environ.get('TEST_REDIS_CACHE_DB') or
                       settings.TEST_REDIS_CACHE_DB_DEFAULT)
        assert _db_index(settings.CACHES['default']['LOCATION']) == expected

    def test_the_default_index_is_unclaimed(self):
        assert settings.TEST_REDIS_CACHE_DB_DEFAULT not in RESERVED_SCRATCH_INDEXES

    def test_it_is_the_same_redis_server_on_a_different_index(self, live_client,
                                                               run_client):
        """An index swap must not become a different server.

        ``tasks.flush_telemetry_stream`` builds its own client from
        ``CACHES['default']['LOCATION']`` and the end-to-end telemetry tests
        need real Redis stream semantics, so pointing the suite at another
        host would trade one class of green for another.
        """
        assert run_client.info('server')['run_id'] == live_client.info('server')['run_id']


# ---------------------------------------------------------------------------
# Behaviour: the real teardown paths leave development state alone
# ---------------------------------------------------------------------------

class TestTheRunCannotFlushDevelopment:

    def test_cache_clear_leaves_the_development_index_alone(self, canary,
                                                            live_client,
                                                            run_client):
        """RED before GREEN. Without the index swap this is a FLUSHDB of the
        development database and ``live_client.get(canary)`` is ``None``."""
        cache.clear()

        assert live_client.get(canary) == 'alive', (
            'cache.clear() reached the development Redis database; the suite '
            'is not isolated'
        )
        assert run_client.get(canary) is None, (
            'the development key is visible from this run\'s index, so the '
            'two are not separate keyspaces'
        )

    def test_the_conftest_throttle_fixture_leaves_development_alone(
        self, clear_throttle_cache, canary, live_client,
    ):
        """The same property, requested through the real fixture.

        ``clear_throttle_cache`` is the only thing in the suite that flushes,
        and it fails rather than skips when Redis is unreachable on purpose.
        That behaviour is load-bearing and unchanged; what this asserts is
        that the flush it performs is now a harmless one.
        """
        assert live_client.get(canary) == 'alive'

    def test_counter_writes_land_in_this_runs_index_only(self, live_client,
                                                         run_client):
        """``counter_store`` is the second door into the shared keyspace.

        It resolves its client from ``caches['default'].client.get_client()``,
        so it follows ``CACHES`` — this proves it follows it, rather than
        asserting that it should.
        """
        from backend.app.services import counter_store

        clip_id = uuid.uuid4().hex
        counter_store.increment(clip_id, 'likes')

        try:
            assert run_client.get(f'clip:{clip_id}:likes') == '1'
            assert live_client.get(f'clip:{clip_id}:likes') is None
        finally:
            counter_store.drain()


# ---------------------------------------------------------------------------
# The override, and the ordering trap that shaped where it lives
# ---------------------------------------------------------------------------

class TestTheOverrideReachesSettings:

    def test_the_settings_module_reads_the_override(self):
        """Half one: the mechanism works, and reads the environment.

        ``resolve_test_redis_cache_url`` is what ``settings.py`` calls while it
        is being imported, so a value in the process environment at launch
        time reaches ``CACHES``.
        """
        current = settings.CACHES['default']['LOCATION']
        with mock.patch.dict(os.environ, {'TEST_REDIS_CACHE_DB': '11'}):
            got = resolve_test_redis_cache_url(current)

        assert _db_index(got) == 11
        assert urlsplit(got).netloc == urlsplit(current).netloc

    def test_a_late_assignment_cannot_reach_the_built_config(self):
        """Half two: the same value, set *after* ``django.setup()``, does not.

        ``django.setup()`` has already run by the time any test body executes,
        so this is the exact position the rootdir conftest body occupies
        relative to the settings module's import. The override computes a
        different index and the live configuration does not move — which is
        why the fix has to live in ``settings.py`` and why an
        ``os.environ`` line in ``conftest.py`` would have looked correct.

        The probe index is derived, not literal: an operator may legitimately
        have launched this run on any of 1-15, and a hardcoded probe would
        either collide with it (failing for the wrong reason) or make the
        "different index" claim vacuous.
        """
        current = settings.CACHES['default']['LOCATION']
        probe_index = LIVE_CACHE_INDEX + 1 \
            if _db_index(current) != LIVE_CACHE_INDEX + 1 \
            else LIVE_CACHE_INDEX + 2

        with mock.patch.dict(os.environ, {'TEST_REDIS_CACHE_DB': str(probe_index)}):
            late = resolve_test_redis_cache_url(current)

        assert _db_index(late) == probe_index != _db_index(current)
        assert settings.CACHES['default']['LOCATION'] == current

    def test_a_full_url_overrides_the_index(self):
        """For a CI runner whose Redis is not the one compose configured."""
        current = settings.CACHES['default']['LOCATION']
        with mock.patch.dict(os.environ, {
            'TEST_REDIS_CACHE_DB': '11',
            'TEST_REDIS_CACHE_URL': 'redis://ci-cache:6379/3',
        }):
            got = resolve_test_redis_cache_url(current)

        assert got == 'redis://ci-cache:6379/3'

    @pytest.mark.parametrize('raw', ['0', '-1', '16', 'nope', ''])
    def test_unusable_indexes_are_refused(self, raw):
        """Fail closed. A value that cannot be parsed, or that names the live
        index, would silently put the suite back on shared state — the same
        fail-open shape ``build_redis_url`` already refuses."""
        from django.core.exceptions import ImproperlyConfigured

        current = settings.CACHES['default']['LOCATION']
        with mock.patch.dict(os.environ, {'TEST_REDIS_CACHE_DB': raw}):
            if raw == '':
                # Empty means "unset", so it takes the default rather than
                # failing. Anything else is an operator error worth a loud one.
                assert _db_index(resolve_test_redis_cache_url(current)) == \
                    settings.TEST_REDIS_CACHE_DB_DEFAULT
            else:
                with pytest.raises(ImproperlyConfigured):
                    resolve_test_redis_cache_url(current)

    def test_a_url_with_no_path_still_gets_one(self):
        """``redis://localhost:6379`` has its *port* after the last slash, so
        a ``rpartition('/')`` rewrite would corrupt it instead of adding an
        index."""
        with mock.patch.dict(os.environ, {'TEST_REDIS_CACHE_DB': '11'}):
            got = resolve_test_redis_cache_url('redis://localhost:6379')

        assert got == 'redis://localhost:6379/11'
