import type { FeedClip } from '../api/schema';

/**
 * Pure feed-buffer logic, extracted from `hooks/useFeedBuffer.ts` so it can be
 * tested without a React renderer.
 *
 * ## Why this file exists
 * The first version of this logic lived entirely inside the hook, and the
 * "test" for it re-implemented the merge rule locally and asserted against
 * *that copy*. Measured, that suite covered **0.0%** of the hook and of
 * `endpoints/feed.ts` while passing 7/7 — deleting the dedupe or the cap
 * from the shipped code left every test green.
 *
 * So the rule lives here, is imported by the hook, and is imported by the
 * tests. That is the only arrangement in which a failing test means the
 * shipped code is broken.
 *
 * ## THE CONSTRAINT THAT SHAPES THIS FILE
 * `GET /feed/` is **destructive**: `FastFeedViewSet.list` does
 * `redis_client.lpop(redis_key, 10)` — it *consumes* up to 10 ids off the
 * user's Redis queue (`views/feed.py:75`). There is no offset and no cursor,
 * so re-requesting a page you already got does not return it again; it
 * returns the *next* ten, or 202 once the queue is empty. A request that
 * errors after the `lpop` has still consumed those ids.
 *
 * Every decision below follows from that.
 */

/** Bounded so a long session cannot hold the whole catalogue in memory. */
export const MAX_BUFFER = 60;

/**
 * Below this, ask for more.
 *
 * The plan/task-list say "< 20", and the server's own refill task uses `< 20`
 * — but the server refills on a *drained* `lpop`, not on a client-side
 * threshold. 15 is chosen to leave headroom below 20 so the client's own
 * request arrives while the queue is still non-empty.
 */
export const REFILL_THRESHOLD = 15;

/**
 * Fallback when the server sends no `retry_after_ms`.
 *
 * The server always sends it on a 202 (`views/feed.py:96`), so this is a
 * defensive default rather than an expected path — and deliberately the
 * server's own documented value so a future body without the hint behaves the
 * same as today's.
 */
export const DEFAULT_RETRY_MS = 1500;

/**
 * Merge an incoming page into the buffer.
 *
 * Dedupe by id. `lpop` returns unique ids, but the backend's degraded /
 * trending fallback re-offers the same top clips by `engagement_velocity`
 * with no exclusion (`views/feed.py:133-146`), so a duplicate is reachable
 * and two cards would otherwise fight over one playback token.
 *
 * Eviction keeps the **newest** `MAX_BUFFER` and drops from the front, so the
 * reel keeps forward momentum rather than pinning the user's history. Note
 * this is what makes `evictedIds` necessary: dropping from the front can
 * remove the clip currently being played, and the caller needs to know.
 *
 * `seen` is mutated and returned. It is deliberately NOT pruned — an
 * evicted-then-returned clip must stay excluded, because re-accepting it
 * would put a duplicate id back in a VirtualizedList keyed on id.
 */
export function mergeFeedPage(
  existing: FeedClip[],
  incoming: FeedClip[],
  seen: Set<string>,
): { clips: FeedClip[]; added: number; evicted: string[] } {
  const merged = [...existing];
  const clipped: string[] = [];
  let added = 0;

  for (const clip of incoming) {
    if (seen.has(clip.id)) continue;
    seen.add(clip.id);
    merged.push(clip);
    added += 1;
  }

  if (merged.length <= MAX_BUFFER) {
    return { clips: merged, added, evicted: clipped };
  }

  const overflow = merged.length - MAX_BUFFER;
  const evicted = merged.slice(0, overflow).map((c) => c.id);
  return { clips: merged.slice(overflow), added, evicted };
}

/**
 * Should the buffer ask for another page right now?
 *
 * Split out because the answer is a security-adjacent property, not styling:
 * `GET /feed/` is destructive, so every "yes" permanently consumes up to 10
 * clips from a finite queue. A wrong `true` destroys the user's feed; a wrong
 * `false` only delays.
 *
 * `error` is part of the input on purpose. A naive
 * `useEffect([clips.length, loading], ...)` re-arms itself the instant
 * `loading` flips back to false, which against a failing backend is an
 * unbounded request loop — one `lpop` per round trip, each also publishing
 * another `refill_user_feed` Celery task.
 *
 * `waitMs` is a caller-supplied delay rather than an internal timer so this
 * stays a pure predicate; the hook owns the scheduling.
 */
export function shouldRefill(input: {
  clipCount: number;
  coolingDown: boolean;
  loading: boolean;
  inFlight: boolean;
  error: string | null;
  /** Queue depth from the last page; `null` before any page has landed. */
  queueHealth: number | null;
}): boolean {
  if (input.coolingDown) return false;
  if (input.loading) return false;
  if (input.inFlight) return false;
  // A failure must not become a retry loop. `refresh()` is the explicit,
  // user-driven path back.
  if (input.error) return false;
  // 0 clips: a cold start. The 202 path owns the retry, via its own timer.
  // Auto-requesting here would tight-loop a drained queue.
  if (input.clipCount === 0) return false;
  if (input.clipCount >= REFILL_THRESHOLD) return false;
  // Server says the queue is deeper than we think — no need to ask.
  if (input.queueHealth !== null && input.queueHealth >= REFILL_THRESHOLD) return false;
  return true;
}

/**
 * How long to wait before the next automatic page request.
 *
 * `notBefore` is an absolute timestamp set when a 202 arrives (now +
 * `retryAfterMs`). Returning the remaining time means the hook can schedule
 * with `setTimeout` instead of calling synchronously, which is what stops the
 * effect from re-arming itself immediately.
 */
export function refillDelayMs(notBefore: number | null, now: number): number {
  if (notBefore === null) return 0;
  return Math.max(0, notBefore - now);
}
