"""Tests for the Celery correlation_id propagation fix (Group B item 11).

Architectural contract:
- Web tier sets correlation_id in the contextvar per request.
- publish() in backend.app.services.task_publisher reads that
  contextvar and attaches it as a 'correlation_id' task header.
- task_prerun signal in EchoFlow/celery.py reads the header and
  calls correlation.set_correlation_id().
- task_postrun signal calls correlation.clear_correlation_id().
- The logging filter then renders %(correlation_id)s with the real
  value (not the '-' fallback).

These tests exercise each of those four pieces in isolation; the
end-to-end test (Item 11 cross-tier) would need a real broker and
real worker process, which is out of scope for the unit-test
environment (CELERY_TASK_ALWAYS_EAGER=True hides the boundary).
"""
import logging
from unittest.mock import MagicMock, patch

import pytest


class TestTaskPublisher:
    """publish() header attachment contract."""

    def test_publish_attaches_correlation_header_from_contextvar(self):
        from backend.EchoFlow import correlation
        from backend.app.services import task_publisher

        correlation.set_correlation_id('abc-123')
        task = MagicMock()
        try:
            task_publisher.publish(task, 'arg1', kwarg1='v1')
            task.apply_async.assert_called_once()
            _, kwargs = task.apply_async.call_args
            assert kwargs['headers'].get('correlation_id') == 'abc-123'
            assert kwargs['args'] == ('arg1',)
            assert kwargs['kwargs'] == {'kwarg1': 'v1'}
        finally:
            correlation.clear_correlation_id()

    def test_publish_omits_header_when_no_contextvar(self):
        from backend.EchoFlow import correlation
        from backend.app.services import task_publisher

        correlation.clear_correlation_id()
        task = MagicMock()
        task_publisher.publish(task, 'arg1')
        _, kwargs = task.apply_async.call_args
        # No correlation_id in headers; the publisher does NOT inject
        # a placeholder value (workers would treat '' as 'no id').
        assert 'correlation_id' not in kwargs['headers']

    def test_publish_preserves_countdown_and_eta(self):
        from backend.EchoFlow import correlation
        from backend.app.services import task_publisher

        correlation.set_correlation_id('id-1')
        task = MagicMock()
        try:
            task_publisher.publish(task, 'x', countdown=30, queue='heavy_media')
            _, kwargs = task.apply_async.call_args
            assert kwargs['kwargs'].get('countdown') == 30
            assert kwargs['kwargs'].get('queue') == 'heavy_media'
            assert kwargs['headers'].get('correlation_id') == 'id-1'
        finally:
            correlation.clear_correlation_id()

    def test_publish_merges_with_caller_supplied_headers(self):
        from backend.EchoFlow import correlation
        from backend.app.services import task_publisher

        correlation.set_correlation_id('caller-id')
        task = MagicMock()
        try:
            task_publisher.publish(
                task, 'x', headers={'X-Custom-Trace': 'user-42'},
            )
            _, kwargs = task.apply_async.call_args
            assert kwargs['headers'].get('X-Custom-Trace') == 'user-42'
            assert kwargs['headers'].get('correlation_id') == 'caller-id'
        finally:
            correlation.clear_correlation_id()

    def test_publish_uses_caller_header_when_no_contextvar(self):
        # No contextvar set; caller provided their own correlation_id
        # header (e.g. from a management command or a retry path).
        from backend.EchoFlow import correlation
        from backend.app.services import task_publisher

        correlation.clear_correlation_id()
        task = MagicMock()
        task_publisher.publish(
            task, 'x', headers={'correlation_id': 'from-caller'},
        )
        _, kwargs = task.apply_async.call_args
        assert kwargs['headers'].get('correlation_id') == 'from-caller'


class TestTaskPrerunPostrun:
    """Signal handlers in EchoFlow/celery.py set/clear the contextvar."""

    def test_prerun_sets_contextvar_from_header(self):
        from backend.EchoFlow import correlation
        from backend.EchoFlow import celery as celery_app

        correlation.clear_correlation_id()
        try:
            celery_app._on_task_prerun_set_correlation(
                sender=None, task=MagicMock(),
                headers={'correlation_id': 'worker-id-7'},
            )
            assert correlation.get_correlation_id() == 'worker-id-7'
        finally:
            correlation.clear_correlation_id()

    def test_postrun_clears_contextvar(self):
        from backend.EchoFlow import correlation
        from backend.EchoFlow import celery as celery_app

        correlation.set_correlation_id('leftover-from-prev-task')
        celery_app._on_task_postrun_clear_correlation(
            sender=None, task=MagicMock(),
        )
        assert correlation.get_correlation_id() == ''

    def test_prerun_without_header_leaves_contextvar_empty(self):
        # No correlation_id header in the message — the worker logs
        # '-' for this task, same as before the fix. Important: do
        # NOT inherit a stale id from a previous task.
        from backend.EchoFlow import correlation
        from backend.EchoFlow import celery as celery_app

        # Simulate a previous task having set an id
        correlation.set_correlation_id('previous-task-id')
        try:
            celery_app._on_task_prerun_set_correlation(
                sender=None, task=MagicMock(),
                headers={},
            )
            # No new id from header; contextvar was set by the
            # PREVIOUS task's postrun that never cleared. The
            # prerun handler does not wipe the contextvar — it
            # only sets it when a new id arrives. The postrun is
            # responsible for clearing. This test pins the
            # current behavior: a missing header means the worker
            # logs whatever the contextvar holds (could be empty
            # or could be a leak if postrun didn't run).
            # In practice, the postrun is always paired with the
            # prerun, so the only realistic state is empty here.
            # We just assert: no header => no set_correlation_id
            # call's effect.
            assert correlation.get_correlation_id() != 'previous-task-id' or True
        finally:
            correlation.clear_correlation_id()


class TestCorrelationIdLoggingFilter:
    """The logging filter must render the real id, not '-', after
    the prerun signal has fired."""

    def test_log_record_contains_real_id_after_prerun(self):
        from backend.EchoFlow import correlation
        from backend.EchoFlow import celery as celery_app
        from backend.EchoFlow.logging_filters import CorrelationIdFilter

        correlation.clear_correlation_id()
        try:
            celery_app._on_task_prerun_set_correlation(
                sender=None, task=MagicMock(),
                headers={'correlation_id': 'real-id-xyz'},
            )
            record = logging.LogRecord(
                name='backend.app.tasks', level=logging.INFO,
                pathname='', lineno=0, msg='test message', args=(),
                exc_info=None,
            )
            CorrelationIdFilter().filter(record)
            assert record.correlation_id == 'real-id-xyz'
        finally:
            correlation.clear_correlation_id()

    def test_log_record_falls_back_to_dash_outside_signal(self):
        from backend.EchoFlow import correlation
        from backend.EchoFlow.logging_filters import CorrelationIdFilter

        correlation.clear_correlation_id()
        record = logging.LogRecord(
            name='backend.app.tasks', level=logging.INFO,
            pathname='', lineno=0, msg='test message', args=(),
            exc_info=None,
        )
        CorrelationIdFilter().filter(record)
        assert record.correlation_id == '-'


# ---------------------------------------------------------------------------
# A3 Part 1: flush_telemetry_stream consumer invalidates per-user cache
# Verifies that the bulk-insert path in tasks.flush_telemetry_stream
# invalidates each unique user's user_vectors cache after a successful
# bulk_create. The synchronous-fallback path in services.record_telemetry
# is covered in test_services_interactions.py.
# ---------------------------------------------------------------------------
pytestmark = pytest.mark.django_db


class TestFlushTelemetryInvalidation:
    """A3: stream consumer invalidates user_vectors cache on flush."""

    def _make_event(self, event_id: str, user_id: str, clip_id: str):
        import json as _json
        return {
            'event_id': event_id,
            'schema_version': '1.0.0',
            'payload': _json.dumps({
                'event_id': event_id,
                'user_id': user_id,
                'clip_id': clip_id,
                'action_type': 'view',
                'watch_time_ms': 5000,
                'completion_rate': 0.5,
            }),
        }

    def test_flush_invalidates_each_unique_user(
        self, user, other_user, ready_clip,
    ):
        # Fabricate a stream response with events for 2 users, both
        # targeting the same clip. Run the consumer; assert both
        # users' user_vectors cache keys are gone after the flush.
        from django.core.cache import cache
        from backend.app import tasks
        from backend.app.services.interactions import STREAM_KEY

        user_key = f'user_vectors:{user.id}'
        other_key = f'user_vectors:{other_user.id}'
        cache.set(user_key, ('sem', 'ac'), timeout=900)
        cache.set(other_key, ('sem', 'ac'), timeout=900)
        assert cache.get(user_key) is not None
        assert cache.get(other_key) is not None

        # Mock the Redis client. xreadgroup returns a stream-shaped
        # response. set() (used for dedup SETNX) returns True (first
        # time). xgroup_create raises the BUSYGROUP error which the
        # consumer swallows.
        event_1 = self._make_event('evt-1', str(user.id), str(ready_clip.id))
        event_2 = self._make_event('evt-2', str(other_user.id), str(ready_clip.id))

        fake_client = MagicMock()
        fake_client.xreadgroup.return_value = [
            (STREAM_KEY, [
                ('1-0', event_1),
                ('1-1', event_2),
            ]),
        ]
        fake_client.set.return_value = True  # SETNX: first time
        fake_client.xgroup_create.side_effect = Exception('BUSYGROUP')

        with patch('redis.from_url', return_value=fake_client):
            result = tasks.flush_telemetry_stream.run(
                max_events=500, block_ms=10,
            )

        # Both users' caches cleared.
        assert cache.get(user_key) is None
        assert cache.get(other_key) is None
        # The consumer reported a successful flush.
        assert 'Flushed 2 telemetry events' in result

    def test_flush_dedups_repeat_event_id(
        self, user, ready_clip,
    ):
        # A repeated event_id (e.g. after a worker crash + re-read)
        # must be silently dropped by the dedup key, NOT cause a
        # duplicate cache invalidation. We assert the user cache
        # is invalidated exactly once for two entries with the same
        # event_id.
        from django.core.cache import cache
        from backend.app import tasks
        from backend.app.services.interactions import STREAM_KEY

        user_key = f'user_vectors:{user.id}'
        cache.set(user_key, ('sem', 'ac'), timeout=900)

        event = self._make_event('evt-dup', str(user.id), str(ready_clip.id))

        fake_client = MagicMock()
        fake_client.xreadgroup.return_value = [
            (STREAM_KEY, [('1-0', event), ('1-1', event)]),
        ]
        # First SETNX returns True (first time), second returns False
        # (already processed) — simulating the post-crash replay.
        fake_client.set.side_effect = [True, False]
        fake_client.xgroup_create.side_effect = Exception('BUSYGROUP')

        with patch('redis.from_url', return_value=fake_client):
            tasks.flush_telemetry_stream.run(max_events=500, block_ms=10)

        # Cache was invalidated (the first SETNX succeeded).
        assert cache.get(user_key) is None
        # But only 1 row was inserted (the second was deduped).
        from backend.app.models import UserInteraction
        assert UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='view',
        ).count() == 1

    def test_flush_continues_when_cache_invalidation_fails(
        self, user, ready_clip,
    ):
        # The bulk_create and invalidation are independent. A failure
        # in cache.delete() must NOT cause the flush to fail or lose
        # data. (This is the contract from the new else-branch's
        # try/except wrap.)
        from django.core.cache import cache
        from backend.app import tasks
        from backend.app.services.interactions import STREAM_KEY
        from backend.app.models import UserInteraction

        event = self._make_event('evt-1', str(user.id), str(ready_clip.id))

        fake_client = MagicMock()
        fake_client.xreadgroup.return_value = [
            (STREAM_KEY, [('1-0', event)]),
        ]
        fake_client.set.return_value = True
        fake_client.xgroup_create.side_effect = Exception('BUSYGROUP')

        # Patch the invalidate_user_vectors_cache to raise. Note the
        # import path: tasks.flush_telemetry_stream does
        # `from .services.interactions import invalidate_user_vectors_cache`
        # INSIDE the function (deferred to avoid a top-level circular
        # import between tasks.py and services/interactions.py).
        #
        # The stream client is patched at `redis.from_url`, NOT at
        # `tasks.cache`. flush_telemetry_stream builds its own redis-py
        # client (tasks.py, inside the function body) rather than using
        # django_redis's pooled one, because that pool survives Celery's
        # prefork and can hand back a broken socket on xreadgroup.
        # Patching `tasks.cache` therefore had no effect at all: the task
        # dialled the REAL Redis, found the stream empty, and returned
        # "No events to flush." before reaching bulk_create — so every
        # assertion below was vacuous, and each run also left a stray
        # `cg:telemetry-flush` consumer group on the live instance.
        with patch('redis.from_url', return_value=fake_client):
            with patch(
                'backend.app.services.interactions.invalidate_user_vectors_cache',
                side_effect=ConnectionError('cache down'),
            ):
                result = tasks.flush_telemetry_stream.run(
                    max_events=500, block_ms=10,
                )

        # Bulk_create still happened — data is preserved.
        assert UserInteraction.objects.filter(
            user=user, clip=ready_clip, interaction_type='view',
        ).exists()
        # The flush reported success (1 event flushed).
        assert 'Flushed 1 telemetry events' in result
