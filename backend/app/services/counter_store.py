"""Redis-backed counter store for AudioClip engagement metrics.

Architectural fix for the architecture-audit concern that the
legacy `update_global_metrics` task performs a correlated subquery
on `userinteraction` for every AudioClip row every 5 minutes
(`SELECT AVG(completion_rate) FROM userinteraction WHERE clip_id = …`).
At 1M clips × 100 views that's 100M index lookups every 5 minutes.
This module moves the hot path to O(1) Redis writes and pushes
Postgres updates into a periodic flusher that touches only dirty
clips.

Key space (all under `clip:` prefix so the legacy `KEYS clip:*` Lua
drain finds them):

  * `clip:<uuid>:likes`           — clip-global integer counter
  * `clip:<uuid>:shares`          — clip-global integer counter
  * `clip:<uuid>:skips`           — clip-global integer counter
  * `clip:<uuid>:user:<int>:completion_sum`   — per-(user,clip) float
  * `clip:<uuid>:user:<int>:completion_count` — per-(user,clip) int

And, deliberately OUTSIDE that namespace so `drain()` does not see it:

  * `completioncap:<uuid>:user:<int>` — per-(user,clip) fixed-window sample
    budget, `COMPLETION_SAMPLE_CAP` per `COMPLETION_CAP_TTL_SECONDS`.

The per-(user,clip) completion keys are needed because
`avg_completion_rate` is a per-(user,clip) measurement; preserving
the per-user signal keeps the recommendation engine's existing
`UserInteraction`-shaped inputs working. The flusher aggregates
those keys into a single `UserInteraction` row per `(user, clip,
'view')` tuple per beat, matching the row shape `record_skip` and
`flush_telemetry_stream` used to write synchronously.

PER-(USER, CLIP) SAMPLE CAP (2026-09-30)
---------------------------------------
`avg_completion_rate` is 30% of the recommendation composite
(`feed_pool.py:151-153`) and, before this cap, a single account could
write an unbounded number of samples onto one clip: `record_skip`
called `add_completion` on *every* request, nothing counted prior
submissions for the pair, and the binding throttle is
`UserRateThrottle` at 1000/hour — so 24,000 samples/day, all against
one clip, from one account. The client-independent dedup is the
`clip:<uuid>:user:<int>` key itself; telemetry's `event_id` is a
fresh `uuid4()` per request and therefore cannot detect a replay.

The budget key is deliberately given its own `completioncap:`
prefix instead of living under `clip:`. It must survive `drain()`,
and the reason is arithmetic, not taste:

  * `drain()` is `KEYS clip:*` + `DEL` (`_DRAIN_SCRIPT`). Anything
    under `clip:` is therefore reset every beat — 300s. A cap that
    resets every 300s is not a cap: the attacker paces at the
    throttle's ~16.7 skips/minute and collects `CAP x 288` samples a
    day. With CAP=3 that is 864 samples/day, still 288x more than the
    3/day this cap actually allows, and the `_COMPLETION_PRIOR_WEIGHT
    = 10` blend in `tasks._apply_completion_deltas` converges on the
    mean of the injected samples regardless, so the rate is the only
    lever and it has to come down by orders of magnitude.
  * Outside the prefix, drain never touches it, so the window is the
    real TTL rather than an artifact of the beat schedule.

The key therefore never expires via `drain()`, so the leak the prefix
move introduces is paid back by the TTL instead: it self-expires
`COMPLETION_CAP_TTL_SECONDS` after the *first* sample of each window
(the `GET`/`INCR`/`EXPIRE` pattern in `_CAP_SCRIPT` below), so it is
bounded by one key per (user, clip) pair that was active in the last 24h —
the same cardinality as the completion keys themselves, minus every
pair that has gone quiet. `redis_cache` runs the LRU eviction policy,
so even a pathological case is bounded by the 1GB maxmemory.

Public API:
  * `increment(clip_id, counter_type, delta=1) -> int`
  * `add_completion(clip_id, user_id, completion_rate) -> bool`
        (False when the per-(user,clip) window budget is spent)
  * `drain() -> dict`
  * `clear(clip_id, counter_type=None) -> None`
  * `dual_write_enabled() -> bool`  (transitional; slated for removal)

In test environments without Redis, the module falls back to an
in-memory dict with a `threading.Lock`. The API surface is identical.

In Phase 1 of the rollout, the synchronous F() side-effect in
`UserInteraction.save()` ALSO ran. The F() is now removed; the
flusher is the only path from Redis to Postgres.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


KEY_PREFIX = 'clip'  # results in keys like 'clip:<uuid>:likes'

# Counter types that follow the simple `clip:<uuid>:<type>` shape
# (clip-global, integer-valued).
SIMPLE_COUNTER_TYPES = ('likes', 'shares', 'skips')

# Per-(user,clip) completion accumulator: two keys per (user,clip).
COMPLETION_SUM_SUFFIX = 'completion_sum'
COMPLETION_COUNT_SUFFIX = 'completion_count'

# --- Per-(user,clip) sample budget (see the module docstring) -------------
# NOT under KEY_PREFIX, on purpose: `drain()` is `KEYS clip:*` + `DEL`,
# so a key under `clip:` would be reset every 300s beat and the cap would
# be worth ~CAP x 288 samples/day instead of CAP.
COMPLETION_CAP_PREFIX = 'completioncap'

# Samples one (user, clip) pair may contribute per window. An honest user
# contributes one per viewing and may re-watch a clip they liked, so 3 is
# headroom rather than a restriction; the fourth is indistinguishable from
# automation. See the module docstring for why the rate, not the total,
# is the thing being bought here.
COMPLETION_SAMPLE_CAP = 3

# 24h. A window that expired inside a session would be worthless (the
# attacker paces to it), and one that never expired is unbounded memory;
# 24h is also the TTL the telemetry stream's own dedup key uses
# (`processed_event:{event_id}` SETNX EX 86400), so there is one house
# convention for "one day of replay tolerance" in this codebase.
COMPLETION_CAP_TTL_SECONDS = 86_400

# Indirection so the in-memory backend's clock is patchable in tests
# without patching the `time` module globally.
_now = time.time


def _make_simple_key(clip_id: Any, counter_type: str) -> str:
    return f'{KEY_PREFIX}:{clip_id}:{counter_type}'


def _make_completion_sum_key(clip_id: Any, user_id: Any) -> str:
    return f'{KEY_PREFIX}:{clip_id}:user:{user_id}:{COMPLETION_SUM_SUFFIX}'


def _make_completion_count_key(clip_id: Any, user_id: Any) -> str:
    return f'{KEY_PREFIX}:{clip_id}:user:{user_id}:{COMPLETION_COUNT_SUFFIX}'


def _make_completion_cap_key(clip_id: Any, user_id: Any) -> str:
    return f'{COMPLETION_CAP_PREFIX}:{clip_id}:user:{user_id}'


def _key_pattern() -> str:
    return f'{KEY_PREFIX}:*'


def _parse_completion_key(key: str) -> tuple[str, str] | None:
    """Parse `clip:<uuid>:user:<int>:completion_<sum|count>` -> (clip_id, user_id) or None."""
    parts = key.split(':')
    # ['clip', '<uuid with dashes>', 'user', '<int>', 'completion_sum']
    if len(parts) != 5:
        return None
    if parts[0] != KEY_PREFIX or parts[2] != 'user':
        return None
    if parts[4] not in (COMPLETION_SUM_SUFFIX, COMPLETION_COUNT_SUFFIX):
        return None
    return parts[1], parts[3]


class _RedisBackend:
    """Production backend: real Redis with Lua-atomic drain."""

    # Atomic GETALL + DEL. Concurrent INCRBY / INCRBYFLOAT between
    # the read and the reset would be lost without atomicity; Lua
    # prevents that.
    #
    # `KEYS[1]` is `clip:*`, so the `completioncap:` budget keys are out
    # of reach by prefix, not by parsing: a 24h window cannot be reset by
    # a 300s beat. Those keys expire on their own TTL.
    _DRAIN_SCRIPT = """
    local keys = redis.call('KEYS', KEYS[1])
    local result = {}
    for _, k in ipairs(keys) do
        local val = redis.call('GET', k)
        if val then
            table.insert(result, k)
            table.insert(result, val)
            redis.call('DEL', k)
        end
    end
    return result
    """

    def __init__(self, client):
        self._client = client
        self._drain_sha = None
        self._cap_sha = None

    def _ensure_drain_script(self):
        if self._drain_sha is None:
            self._drain_sha = self._client.script_load(self._DRAIN_SCRIPT)

    def _ensure_cap_script(self):
        if self._cap_sha is None:
            self._cap_sha = self._client.script_load(self._CAP_SCRIPT)

    # Check the window budget, spend a sample, and record it — one round
    # trip, atomic. Returns the number of samples the pair has now used in
    # this window, or 0 (and writes nothing) when the budget is spent.
    #
    # ARGV: {ttl_seconds, cap, rate}
    # KEYS: {cap_key, completion_sum_key, completion_count_key}
    #
    # `GET` before `INCR` rather than `INCR` then compare: once the budget
    # is spent the key stops taking writes, so its value is exactly the
    # budget rather than a count of everything that was thrown at it, and a
    # refused submission costs one read instead of an unbounded-growth
    # write. It is still race-free — Redis runs a script to completion
    # without interleaving, so the read and the increment cannot be split.
    #
    # The `used == 1` guard sets the TTL once per window, on the first
    # sample, so the window is anchored to the first write rather than
    # being slid forward by every subsequent one.
    _CAP_SCRIPT = """
    local used = tonumber(redis.call('GET', KEYS[1]) or '0')
    if used >= tonumber(ARGV[2]) then
        return 0
    end
    used = redis.call('INCR', KEYS[1])
    if used == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    redis.call('INCRBYFLOAT', KEYS[2], ARGV[3])
    redis.call('INCR', KEYS[3])
    return used
    """

    def increment(self, clip_id, counter_type: str, delta: int = 1) -> int:
        return int(self._client.incrby(_make_simple_key(clip_id, counter_type), delta))

    def add_completion(self, clip_id, user_id, completion_rate: float) -> bool:
        """Record one sample for (clip, user). False if the window budget
        is spent."""
        self._ensure_cap_script()
        try:
            used = int(self._client.evalsha(
                self._cap_sha, 3,
                _make_completion_cap_key(clip_id, user_id),
                _make_completion_sum_key(clip_id, user_id),
                _make_completion_count_key(clip_id, user_id),
                COMPLETION_CAP_TTL_SECONDS, COMPLETION_SAMPLE_CAP, float(completion_rate),
            ))
        except Exception as exc:
            logger.warning("counter_store: evalsha failed (%s); reloading", exc)
            self._cap_sha = self._client.script_load(self._CAP_SCRIPT)
            used = int(self._client.evalsha(
                self._cap_sha, 3,
                _make_completion_cap_key(clip_id, user_id),
                _make_completion_sum_key(clip_id, user_id),
                _make_completion_count_key(clip_id, user_id),
                COMPLETION_CAP_TTL_SECONDS, COMPLETION_SAMPLE_CAP, float(completion_rate),
            ))
        return used > 0

    def drain(self) -> dict:
        """Atomic read-and-reset of all clip:* keys.

        Returns:
          {
            'counters':  {clip_id: {counter_type: int, ...}, ...},
            'completion': {(clip_id, user_id): {
                'completion_sum': float,
                'completion_count': int,
            }, ...},
          }
        """
        self._ensure_drain_script()
        try:
            raw = self._client.evalsha(self._drain_sha, 1, _key_pattern())
        except Exception as exc:
            logger.warning("counter_store: evalsha failed (%s); reloading", exc)
            self._drain_sha = self._client.script_load(self._DRAIN_SCRIPT)
            raw = self._client.evalsha(self._drain_sha, 1, _key_pattern())

        counters: dict[str, dict[str, int]] = {}
        completion: dict[tuple[str, str], dict[str, float]] = {}
        # raw is a flat list [k1, v1, k2, v2, ...]
        for i in range(0, len(raw), 2):
            key = raw[i]
            if isinstance(key, bytes):
                key = key.decode('utf-8')
            value = raw[i + 1]
            if isinstance(value, bytes):
                value = value.decode('utf-8')

            # Try completion-key shape first: clip:<uuid>:user:<int>:completion_<sum|count>
            parsed = _parse_completion_key(key)
            if parsed is not None:
                clip_id, user_id = parsed
                slot = completion.setdefault((clip_id, user_id), {})
                if key.endswith(COMPLETION_SUM_SUFFIX):
                    slot[COMPLETION_SUM_SUFFIX] = float(value)
                else:
                    slot[COMPLETION_COUNT_SUFFIX] = int(value)
                continue

            # Else simple counter shape: clip:<uuid>:<type>
            parts = key.split(':', 2)
            if len(parts) != 3:
                continue
            _, clip_id, counter_type = parts
            if counter_type not in SIMPLE_COUNTER_TYPES:
                # Unknown key under our prefix; skip (defense-in-depth
                # for namespace collision. The feed-pool ZSET
                # (`feed:exploit_pool`, formerly `clip:candidates:exploit`)
                # used to live under this prefix but was renamed so the
                # counter_store keyspace is no longer shared.
                continue
            counters.setdefault(clip_id, {})[counter_type] = int(value)

        return {'counters': counters, 'completion': completion}

    def clear(self, clip_id, counter_type: str | None = None) -> None:
        if counter_type is not None:
            self._client.delete(_make_simple_key(clip_id, counter_type))
            return
        for ct in SIMPLE_COUNTER_TYPES:
            self._client.delete(_make_simple_key(clip_id, ct))


class _InMemoryBackend:
    """Test backend: dict with a Lock, no Redis dependency.

    Behavior matches the Redis backend for the API surface used by
    production code: increment is atomic (under the lock), add_completion
    is atomic, drain is atomic (lock + dict copy + clear). The
    Lua-atomicity guarantee from the Redis backend is replaced by a
    single lock acquire that spans the equivalent read-and-reset.
    """

    def __init__(self):
        self._data: dict[str, int | float] = {}
        # Cap-key -> window deadline (epoch seconds). Kept apart from
        # `_data` so a deadline is never mistaken for a drained value.
        self._cap_deadlines: dict[str, float] = {}
        self._lock = threading.Lock()

    def increment(self, clip_id, counter_type: str, delta: int = 1) -> int:
        key = _make_simple_key(clip_id, counter_type)
        with self._lock:
            self._data[key] = int(self._data.get(key, 0)) + delta
            return int(self._data[key])

    def add_completion(self, clip_id, user_id, completion_rate: float) -> bool:
        cap_key = _make_completion_cap_key(clip_id, user_id)
        sum_key = _make_completion_sum_key(clip_id, user_id)
        count_key = _make_completion_count_key(clip_id, user_id)
        with self._lock:
            self._expire_cap_key(cap_key)
            used = int(self._data.get(cap_key, 0))
            if used >= COMPLETION_SAMPLE_CAP:
                # Mirrors the Lua: once the budget is spent the key takes no
                # further writes, so its value is the budget and not a count
                # of everything that was refused.
                return False
            used += 1
            self._data[cap_key] = used
            if used == 1:
                self._cap_deadlines[cap_key] = _now() + COMPLETION_CAP_TTL_SECONDS
            self._data[sum_key] = float(self._data.get(sum_key, 0.0)) + float(completion_rate)
            self._data[count_key] = int(self._data.get(count_key, 0)) + 1
            return True

    def _expire_cap_key(self, cap_key: str) -> None:
        """Drop the cap key if its window has elapsed. Caller holds the lock."""
        deadline = self._cap_deadlines.get(cap_key)
        if deadline is not None and _now() >= deadline:
            self._data.pop(cap_key, None)
            del self._cap_deadlines[cap_key]

    def _sweep_expired_cap_keys(self) -> None:
        """Drop every elapsed window, not just one read on write.

        `_expire_cap_key` only fires on a write to the same pair, so a pair
        that never writes again would hold its budget key for the life of
        the process. Redis expires the key server-side; this is the
        in-memory backend's equivalent, run from `drain()` — which is the
        only moment the in-memory backend does any reclamation at all.
        """
        now = _now()
        for cap_key in [k for k, d in self._cap_deadlines.items() if now >= d]:
            self._data.pop(cap_key, None)
            del self._cap_deadlines[cap_key]

    def drain(self) -> dict:
        counters: dict[str, dict[str, int]] = {}
        completion: dict[tuple[str, str], dict[str, float]] = {}
        with self._lock:
            self._sweep_expired_cap_keys()
            for key, value in list(self._data.items()):
                # The cap key is not a drained value and must survive the
                # drain: its window is COMPLETION_CAP_TTL_SECONDS, not the
                # 300s beat. `_DRAIN_SCRIPT` gets this for free (it globs
                # `KEYS clip:*` and the cap prefix is `completioncap:`), so
                # this branch is the in-memory backend's explicit mirror of
                # that. Without it the `continue` below would leave the key
                # in place only by accident of the key parser.
                if key.startswith(f'{COMPLETION_CAP_PREFIX}:'):
                    continue
                parsed = _parse_completion_key(key)
                if parsed is not None:
                    clip_id, user_id = parsed
                    slot = completion.setdefault((clip_id, user_id), {})
                    if key.endswith(COMPLETION_SUM_SUFFIX):
                        slot[COMPLETION_SUM_SUFFIX] = float(value)
                    else:
                        slot[COMPLETION_COUNT_SUFFIX] = int(value)
                    del self._data[key]
                    continue
                parts = key.split(':', 2)
                if len(parts) != 3:
                    continue
                _, clip_id, counter_type = parts
                if counter_type not in SIMPLE_COUNTER_TYPES:
                    continue
                counters.setdefault(clip_id, {})[counter_type] = int(value)
                del self._data[key]
        return {'counters': counters, 'completion': completion}

    def clear(self, clip_id, counter_type: str | None = None) -> None:
        with self._lock:
            if counter_type is not None:
                self._data.pop(_make_simple_key(clip_id, counter_type), None)
                return
            for ct in SIMPLE_COUNTER_TYPES:
                self._data.pop(_make_simple_key(clip_id, ct), None)


def _build_backend() -> Any:
    """Return a Redis-backed store in prod, in-memory in tests.

    Detection: try django.core.cache's _cache.get_client() first
    (the same client the rest of the app uses); if unavailable,
    fall back to in-memory. This keeps the test env (LocMem cache)
    on the in-memory backend and the prod env (Redis cache) on the
    Redis backend without an explicit env var.
    """
    try:
        from django.core.cache import caches

        cache = caches['default']
        # django-redis exposes .client.get_client() returning a real Redis client.
        if hasattr(cache, 'client') and hasattr(cache.client, 'get_client'):
            client = cache.client.get_client()
            return _RedisBackend(client)
    except Exception as exc:
        logger.debug("counter_store: Redis client unavailable, using in-memory: %s", exc)
    return _InMemoryBackend()


_backend: Any = None
_backend_lock = threading.Lock()


def _get_backend() -> Any:
    global _backend
    if _backend is None:
        with _backend_lock:
            if _backend is None:
                _backend = _build_backend()
    return _backend


def _reset_backend_for_tests() -> None:
    """Test hook: clear the cached backend so the next call rebuilds.

    Production code should NOT call this; the test suite uses it to
    reset state between tests when patching the cache backend.
    """
    global _backend
    with _backend_lock:
        _backend = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def increment(clip_id: Any, counter_type: str, delta: int = 1) -> int:
    """Increment a clip-global counter. Lock-free on the writer side.

    `counter_type` must be one of `SIMPLE_COUNTER_TYPES`
    (`likes`, `shares`, `skips`).
    """
    if counter_type not in SIMPLE_COUNTER_TYPES:
        raise ValueError(
            f"counter_type must be one of {SIMPLE_COUNTER_TYPES} for increment(); "
            f"use add_completion() for completion_rate data"
        )
    return _get_backend().increment(clip_id, counter_type, delta)


def add_completion(clip_id: Any, user_id: Any, completion_rate: float) -> bool:
    """Accumulate one completion sample for a (user, clip) pair.

    Increments the per-(user,clip) completion_sum by `completion_rate`
    (a float in [0.0, 1.0]) and the completion_count by 1. The
    flusher divides sum/count to recover the average.

    Returns False — and writes no sample at all — once the pair has
    spent its `COMPLETION_SAMPLE_CAP` budget for the current
    `COMPLETION_CAP_TTL_SECONDS` window. Before this cap, `record_skip`
    called this on every request with nothing counting prior
    submissions for the pair, so one account at the 1000/hour
    `UserRateThrottle` ceiling could write 24,000 samples a day onto a
    single clip — and `avg_completion_rate` is 30% of the
    recommendation composite (`feed_pool.py:151-153`).

    Callers must not treat False as an error: it is the ordinary
    outcome of a user re-watching a clip they have already watched
    several times today.
    """
    rate = float(completion_rate)
    if rate < 0.0 or rate > 1.0:
        # Clamp to bounds rather than reject: the upstream
        # computation is `min(watch_time_ms / clip_duration, 1.0)`,
        # which already enforces the upper bound; the lower bound
        # here is a safety net for any future caller that computes
        # completion differently.
        rate = max(0.0, min(1.0, rate))
    return _get_backend().add_completion(clip_id, user_id, rate)


def drain() -> dict:
    """Atomic read-and-reset of all counter deltas.

    Returns: `{'counters': {clip_id: {counter_type: int, ...}, ...},
              'completion': {(clip_id, user_id): {sum, count}, ...}}`
    """
    return _get_backend().drain()


def clear(clip_id: Any, counter_type: str | None = None) -> None:
    """Test-only: clear a single counter (or all simple counters for a clip)."""
    _get_backend().clear(clip_id, counter_type)


# ---------------------------------------------------------------------------
# Rollout flag (kept for transitional backward compatibility)
# ---------------------------------------------------------------------------
# `ECHOFLOW_DUAL_WRITE_COUNTERS` is now always False — the F()
# side-effect in UserInteraction.save() has been removed. The flag
# is retained as a no-op so deployment configurations referencing it
# do not error; a follow-up release will delete it.
DUAL_WRITE_ENV = 'ECHOFLOW_DUAL_WRITE_COUNTERS'


def dual_write_enabled() -> bool:
    """Always False after the F() removal. Retained for backward compat.

    The legacy dual-write F() path has been removed from
    `UserInteraction.save()`. This function is a no-op kept so
    deployment configurations that still set the env var do not
    error. The default for any new env value is False.
    """
    return False
