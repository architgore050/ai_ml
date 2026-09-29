import { useCallback, useEffect, useRef, useState } from 'react';

import { getFeedPage, getSuggestions } from '../api/endpoints/feed';
import type { FeedClip } from '../api/schema';

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
 *   - a naive refetch (React StrictMode double-effect, TanStack Query's
 *     window-focus refetch, a pull-to-refresh) silently discards a page of the
 *     user's feed;
 *   - a request that errors *after* the lpop still consumed the ids, so a
 *     retry is not free.
 *
 * Therefore: exactly one in-flight request at a time, never a refetch, and the
 * buffer only ever grows.
 */

/** Bounded so a long session cannot hold the whole catalogue in memory. */
const MAX_BUFFER = 60;

/** Below this, ask for more. Matches the server's own refill trigger (< 20). */
const REFILL_THRESHOLD = 15;

/** Fallback when the server sends no `retry_after_ms` (documented default). */
const DEFAULT_RETRY_MS = 1500;

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
  refresh: () => void;
};

export function useFeedBuffer(): FeedBuffer {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueHealth, setQueueHealth] = useState(0);
  const [nonce, setNonce] = useState(0);

  /**
   * Guards against a second request while one is in flight. The alternative —
   * letting the effect re-run — is precisely the bug: `lpop` makes concurrent
   * requests *destructive*, so an overlapping call silently eats a page.
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
        // 202: the queue drained. Honour the server's hint — do not invent
        // a backoff, and do not treat this as an error. The trending
        // fallback is served by the backend on a 200, so nothing to show here.
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

      // Dedupe by id. `lpop` returns unique ids, but the degraded/trending
      // fallback can re-offer a clip already in the buffer, and `replace()`
      // with a duplicate id would make two cards fight over one token.
      setClips((prev) => {
        const merged = [...prev];
        for (const clip of page.clips) {
          if (seen.current.has(clip.id)) continue;
          seen.current.add(clip.id);
          merged.push(clip);
        }
        // Keep the newest MAX_BUFFER; drop the oldest so the reel keeps
        // forward momentum instead of pinning the user's history.
        return merged.length > MAX_BUFFER ? merged.slice(merged.length - MAX_BUFFER) : merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
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
   * Top up when the buffer runs low. Called by the feed screen on reel
   * change, not on a timer, so a paused feed stops spending requests.
   */
  useEffect(() => {
    if (coolingDown || loading || inFlight.current) return;
    if (clips.length > 0 && clips.length < REFILL_THRESHOLD) {
      void fetchMore();
    }
  }, [clips.length, coolingDown, loading, fetchMore]);

  return {
    clips,
    loading,
    coolingDown,
    degraded,
    error,
    queueHealth,
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
      .then(({ clips: rows }) => {
        if (!cancelled) setClips(rows as FeedClip[]);
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
