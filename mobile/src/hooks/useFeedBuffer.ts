import { useCallback, useEffect, useRef, useState } from 'react';

import { getFeedPage, getSuggestions } from '../api/endpoints/feed';
import type { FeedClip } from '../api/schema';
import {
  DEFAULT_RETRY_MS,
  mergeFeedPage,
  refillDelayMs,
  shouldRefill,
} from '../lib/feedBuffer';

/**
 * Accumulates `GET /feed/` pages into a capped, deduped buffer.
 *
 * ## THE CONSTRAINT THAT SHAPES THIS FILE
 * `GET /feed/` is **destructive**. `FastFeedViewSet.list` does
 * `redis_client.lpop(redis_key, 10)` — it *consumes* up to 10 ids off the
 * user's Redis queue (views/feed.py:75). There is no offset, no cursor, and no
 * "give me page 2". So:
 *
 *   - re-requesting a page you already got does NOT return it again; it
 *     returns the NEXT ten, or 202 once the queue is empty;
 *   - a naive refetch (React StrictMode double-effect, a pull-to-refresh) is
 *     not free — it permanently discards a page of the user's feed;
 *   - a request that errors *after* the lpop still consumed the ids, so a
 *     blind retry is not free either.
 *
 * The rules therefore live in `lib/feedBuffer.ts` as pure functions, and this
 * file is the React binding around them. They are extracted because a test
 * that re-implements the rule tests only itself — see the note in that file.
 */

export { MAX_BUFFER, REFILL_THRESHOLD, DEFAULT_RETRY_MS } from '../lib/feedBuffer';

export type FeedBuffer = {
  clips: FeedClip[];
  /** True while a page request is in flight. */
  loading: boolean;
  /** True once the server has returned 202 and the cool-down has not elapsed. */
  coolingDown: boolean;
  /** Non-fatal: the cold-start path is serving trending content. */
  degraded: boolean;
  error: string | null;
  /** Queue depth as of the last page. A falling number means "refill soon". */
  queueHealth: number;
  /** Clip ids dropped by the cap on the most recent page (usually empty). */
  lastEvicted: string[];
  refresh: () => void;
};

export function useFeedBuffer(): FeedBuffer {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueHealth, setQueueHealth] = useState(0);
  const [lastEvicted, setLastEvicted] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);

  /**
   * Guards against a second request while one is in flight. The alternative —
   * letting the effect re-run — is precisely the bug: `lpop` makes concurrent
   * requests *destructive*, so an overlapping call silently eats a page.
   *
   * Set synchronously before the first `await`, so a StrictMode double-effect
   * or any same-tick re-entry is blocked rather than merely de-duplicated.
   */
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const fetchMore = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const page = await getFeedPage();

      if (page.kind === 'cold') {
        // 202: the queue drained. Honour the server's hint — do not invent a
        // backoff, and do not treat this as an error. The trending fallback is
        // served by the backend on a 200, so there is nothing to show here.
        setCoolingDown(true);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          setCoolingDown(false);
        }, page.retryAfterMs || DEFAULT_RETRY_MS);
        return;
      }

      setCoolingDown(false);
      setDegraded(page.degraded ?? false);
      setQueueHealth(page.queueHealth);
      setClips((prev) => {
        const { clips: next, evicted } = mergeFeedPage(prev, page.clips, seen.current);
        // `setClips` must stay pure for StrictMode's double-invoke, so the
        // evicted ids are reported through a separate call rather than by
        // returning them out of the updater.
        if (evicted.length) setLastEvicted(evicted);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      // Reset in `finally` so a throw cannot leave the buffer permanently
      // wedged with nothing left to render and no way to retry.
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMore();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [fetchMore, nonce]);

  /**
   * Top up when the buffer runs low.
   *
   * Schedules a `setTimeout` rather than calling `fetchMore()` inline. The
   * difference is the whole point: calling it synchronously makes the effect
   * re-arm itself the moment `loading` flips back to false, which against a
   * cold queue is an unbounded loop against a destructive endpoint.
   */
  useEffect(() => {
    const due = shouldRefill({
      clipCount: clips.length,
      coolingDown,
      loading,
      inFlight: inFlight.current,
      error,
      queueHealth: clips.length > 0 ? queueHealth : null,
    });
    if (!due) return;

    const delay = refillDelayMs(null, Date.now());
    const timer = setTimeout(() => void fetchMore(), delay);
    return () => clearTimeout(timer);
  }, [clips.length, coolingDown, loading, error, queueHealth, fetchMore]);

  return {
    clips,
    loading,
    coolingDown,
    degraded,
    error,
    queueHealth,
    lastEvicted,
    /**
     * Manual retry after an error. Deliberately does NOT clear `seen` — those
     * ids were already consumed from the queue, so clearing it would make the
     * buffer claim to have clips it can no longer obtain.
     */
    refresh: () => setNonce((n) => n + 1),
  };
}

/**
 * Cold-start fallback content.
 *
 * When the feed is empty the app must not show a blank screen, and it must not
 * pretend the personalised feed worked. `/suggestions/` is a real, paged,
 * **non-destructive** listing, so it is safe to call repeatedly — which is
 * exactly why it is the fallback and the destructive `/feed/` is not.
 *
 * The category defaults to `all`, which the backend treats as "unfiltered"
 * (`views/feed.py`, `SuggestionViewSet.get_queryset`). It used to be
 * hardcoded to `music` as a workaround for that endpoint being broken: `all`
 * was an exact match against a free-text column, so it matched nothing.
 */
export function useSuggestionsFallback(category: string, enabled: boolean) {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    getSuggestions(category)
      .then((result) => {
        if (!cancelled) setClips(result.clips);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load suggestions');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [category, enabled]);

  return { clips, loading, error };
}
