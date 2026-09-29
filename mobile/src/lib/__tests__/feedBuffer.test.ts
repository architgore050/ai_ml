import {
  MAX_BUFFER,
  REFILL_THRESHOLD,
  mergeFeedPage,
  refillDelayMs,
  shouldRefill,
} from '../feedBuffer';
import type { FeedClip } from '../../api/schema';

/**
 * These import the SHIPPED functions.
 *
 * The suite this replaces (`feedBufferLogic.test.ts`) re-implemented
 * `mergeClips` locally inside the test file and asserted against that copy
 * while `jest.mock`-ing away the module under test. Measured: **0.0%**
 * statements/branches/functions/lines on both `useFeedBuffer.ts` and
 * `endpoints/feed.ts`, 7/7 green. Deleting the dedupe or the cap from the real
 * code left every test passing.
 *
 * `MAX_BUFFER` and `REFILL_THRESHOLD` are imported rather than inlined
 * precisely so the cap cannot drift away from the tests.
 */

const clip = (id: string, extra: Partial<FeedClip> = {}): FeedClip => ({
  id,
  title: `clip ${id}`,
  creator_name: 'someone',
  creator_id: 1,
  category: 'music',
  hls_playlist_url: `https://localhost:19443/hls/${id}/master.m3u8`,
  likes: 0,
  shares: 0,
  skips: 0,
  comment_count: 0,
  is_liked: false,
  ...extra,
});

describe('mergeFeedPage', () => {
  it('appends unseen clips in order', () => {
    const seen = new Set<string>();
    const { clips, added } = mergeFeedPage([], [clip('a'), clip('b')], seen);
    expect(clips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(added).toBe(2);
  });

  it('dedupes by id', () => {
    // A duplicate id would mean two ReelCards both minting a token for the
    // same clip and racing on replace() — one card silently winning. The
    // backend's degraded/trending fallback re-offers the same top clips with no
    // exclusion (views/feed.py:133-146), so this is reachable in production.
    const seen = new Set<string>();
    mergeFeedPage([], [clip('a')], seen);
    const { clips, added } = mergeFeedPage(
      [clip('a')],
      [clip('a'), clip('b')],
      seen,
    );
    expect(clips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(added).toBe(1);
  });

  it('caps at MAX_BUFFER and keeps the NEWEST, so the reel keeps moving', () => {
    const seen = new Set<string>();
    let acc: FeedClip[] = [];
    for (let i = 0; i < MAX_BUFFER + 15; i += 1) {
      acc = mergeFeedPage(acc, [clip(`c${i}`)], seen).clips;
    }
    expect(acc).toHaveLength(MAX_BUFFER);
    expect(acc[acc.length - 1]?.id).toBe(`c${MAX_BUFFER + 14}`);
    // Oldest dropped from the front, not the newest from the end.
    expect(acc[0]?.id).toBe('c15');
  });

  it('reports which ids were evicted by that call', () => {
    // The caller needs this: dropping from the front can evict the clip
    // currently being played, and the UI has to stop the player rather than
    // leave audio running for a reel that is no longer on screen.
    //
    // `evicted` is per-call, not cumulative — the buffer is trimmed on every
    // merge, so with one clip arriving per call exactly one id leaves each
    // time once the cap is reached.
    const seen = new Set<string>();
    let acc: FeedClip[] = [];
    let evicted: string[] = [];
    for (let i = 0; i < MAX_BUFFER + 2; i += 1) {
      const r = mergeFeedPage(acc, [clip(`c${i}`)], seen);
      acc = r.clips;
      evicted = r.evicted;
    }
    expect(evicted).toEqual(['c1']);

    // And with a whole page arriving at once, the whole overflow is reported
    // in one call — which is the case the UI actually cares about, since
    // pages arrive ten at a time.
    const seen2 = new Set<string>();
    let acc2: FeedClip[] = [];
    let evicted2: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const page = Array.from({ length: 10 }, (_, k) => clip(`p${i * 10 + k}`));
      const r = mergeFeedPage(acc2, page, seen2);
      acc2 = r.clips;
      evicted2 = r.evicted;
    }
    expect(evicted2).toHaveLength(10);
    expect(evicted2[0]).toBe('p0');
  });

  it('does not report eviction below the cap', () => {
    const { evicted } = mergeFeedPage([], [clip('a')], new Set());
    expect(evicted).toEqual([]);
  });

  it('never re-admits an evicted id', () => {
    // `seen` is intentionally not pruned. Re-accepting an evicted clip would
    // put a duplicate key back into a VirtualizedList keyed on id, which
    // silently reuses the wrong cell.
    const seen = new Set<string>();
    let acc: FeedClip[] = [];
    for (let i = 0; i < MAX_BUFFER + 5; i += 1) {
      acc = mergeFeedPage(acc, [clip(`c${i}`)], seen).clips;
    }
    const c0 = clip('c0');
    const after = mergeFeedPage(acc, [c0], seen);
    expect(after.added).toBe(0);
    expect(after.clips.map((c) => c.id)).not.toContain('c0');
  });

  it('leaves the input array untouched', () => {
    const existing = [clip('a')];
    mergeFeedPage(existing, [clip('b')], new Set());
    expect(existing).toHaveLength(1);
  });
});

describe('shouldRefill', () => {
  const base = {
    clipCount: 5,
    coolingDown: false,
    loading: false,
    inFlight: false,
    error: null as string | null,
    queueHealth: null as number | null,
  };

  it('refills when the buffer is running low', () => {
    expect(shouldRefill(base)).toBe(true);
  });

  it('does not refill at or above the threshold', () => {
    expect(shouldRefill({ ...base, clipCount: REFILL_THRESHOLD })).toBe(false);
    expect(shouldRefill({ ...base, clipCount: MAX_BUFFER })).toBe(false);
  });

  it('does not refill at zero clips', () => {
    // A cold start. The 202 path owns the retry via its own timer; requesting
    // here would tight-loop a drained, destructive endpoint.
    expect(shouldRefill({ ...base, clipCount: 0 })).toBe(false);
  });

  it('does not refill while cooling down after a 202', () => {
    expect(shouldRefill({ ...base, coolingDown: true })).toBe(false);
  });

  it('does not refill while a request is in flight', () => {
    expect(shouldRefill({ ...base, loading: true })).toBe(false);
    expect(shouldRefill({ ...base, inFlight: true })).toBe(false);
  });

  it('does not retry in a loop after an error', () => {
    // The property that broke. A `useEffect([clips.length, loading])` re-arms
    // itself the instant `loading` flips false, so a failing backend produced
    // one destructive lpop per round trip — each also publishing another
    // refill_user_feed Celery task. `refresh()` is the explicit retry.
    expect(shouldRefill({ ...base, error: 'boom' })).toBe(false);
  });

  it('skips the request when the server says the queue is still deep', () => {
    expect(shouldRefill({ ...base, queueHealth: 40 })).toBe(false);
    expect(shouldRefill({ ...base, queueHealth: 3 })).toBe(true);
  });
});

describe('refillDelayMs', () => {
  it('is zero when there is no deadline', () => {
    expect(refillDelayMs(null, 1_000)).toBe(0);
  });

  it('is the remaining time', () => {
    expect(refillDelayMs(5_000, 1_000)).toBe(4_000);
  });

  it('never goes negative once the deadline has passed', () => {
    expect(refillDelayMs(1_000, 5_000)).toBe(0);
  });
});
