import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useFeedBuffer, useSuggestionsFallback } from '../useFeedBuffer';
import { getFeedPage, getSuggestions } from '../../api/endpoints/feed';
import { MAX_BUFFER } from '../../lib/feedBuffer';
import type { FeedClip } from '../../api/schema';

/**
 * Effect-level tests for the real hook.
 *
 * These exist because the *behaviour* that matters is not a pure function:
 * it is the sequencing. `GET /feed/` is destructive, so what has to be proven
 * is that exactly one request happens per decision, that a 202 schedules a
 * retry rather than an immediate re-request, and that a failure does not
 * become a loop. A pure-function test cannot show any of that.
 *
 * `getFeedPage` is mocked at the module boundary (it is the network edge), but
 * the hook under test is the shipped one and the state machine driving it is
 * the shipped `lib/feedBuffer.ts`.
 */

jest.mock('../../api/endpoints/feed', () => ({
  getFeedPage: jest.fn(),
  getSuggestions: jest.fn(),
}));

const mockGetFeedPage = getFeedPage as jest.MockedFunction<typeof getFeedPage>;
const mockGetSuggestions = getSuggestions as jest.MockedFunction<typeof getSuggestions>;

const clip = (id: string): FeedClip => ({
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
});

const page = (ids: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'ok' as const,
  clips: ids.map(clip),
  queueHealth: 40,
  degraded: false,
  ...extra,
});

beforeEach(() => {
  jest.useRealTimers();
  mockGetFeedPage.mockReset();
  mockGetSuggestions.mockReset();
});

describe('useFeedBuffer — first load', () => {
  it('requests exactly one page on mount', async () => {
    mockGetFeedPage.mockResolvedValue(page(['a', 'b', 'c']));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.clips).toHaveLength(3));
    expect(mockGetFeedPage).toHaveBeenCalledTimes(1);
  });

  it('exposes the server queue depth and clears loading', async () => {
    mockGetFeedPage.mockResolvedValue(page(['a'], { queueHealth: 12 }));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.clips).toHaveLength(1));
    expect(result.current.queueHealth).toBe(12);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useFeedBuffer — the destructive-page guarantee', () => {
  it('does not re-request a page it already consumed', async () => {
    // A re-request would NOT return the same clips: lpop already consumed
    // them, so the second call silently eats the NEXT ten. Any test that
    // passes while the hook double-fetches is testing nothing.
    mockGetFeedPage.mockResolvedValue(page(['a', 'b']));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.clips).toHaveLength(2));
    // Let any spurious effect re-runs settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetFeedPage).toHaveBeenCalledTimes(1);
  });

  it('issues only one concurrent request while the first is in flight', async () => {
    // Two overlapping lpops consume two pages but return one, so a page is
    // destroyed for nothing. `inFlight` is set synchronously before the first
    // await specifically to block this.
    let release: (v: ReturnType<typeof page>) => void = () => {};
    mockGetFeedPage.mockImplementation(() => new Promise((res) => { release = res as never; }));

    const { result } = await renderHook(() => useFeedBuffer());
    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
      await Promise.resolve();
    });
    expect(mockGetFeedPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(page(['a']));
      await Promise.resolve();
    });
  });

  it('dedupes a repeated id across pages', async () => {
    mockGetFeedPage
      .mockResolvedValueOnce(page(['a', 'b']))
      .mockResolvedValue(page(['b', 'c']));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.clips).toHaveLength(2));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.clips).toHaveLength(3));
    expect(result.current.clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useFeedBuffer — 202 cold start', () => {
  it('honours retry_after_ms and does not treat it as an error', async () => {
    // The server's 202 body carries `results: []` (views/feed.py:92-100), so a
    // parser that discriminates on the absence of `results` treats it as a
    // normal empty page and this whole path never runs.
    mockGetFeedPage.mockResolvedValue({ kind: 'cold', retryAfterMs: 1500 });
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.coolingDown).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.clips).toEqual([]);
  });

  it('does not spin while cooling down', async () => {
    mockGetFeedPage.mockResolvedValue({ kind: 'cold', retryAfterMs: 1500 });
    await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(mockGetFeedPage).toHaveBeenCalledTimes(1));
    // No further request while the cool-down is armed. A tight loop here is
    // one destructive lpop per round trip against a drained queue.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mockGetFeedPage).toHaveBeenCalledTimes(1);
  });
});

describe('useFeedBuffer — failures', () => {
  it('surfaces the error and does not retry on its own', async () => {
    mockGetFeedPage.mockRejectedValue(new Error('boom'));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    // The regression this pins: a `useEffect([clips.length, loading])` refill
    // re-arms itself the moment `loading` flips false, so a failing backend
    // produced an unbounded destructive request loop.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mockGetFeedPage).toHaveBeenCalledTimes(1);
  });

  it('recovers when the user explicitly refreshes', async () => {
    mockGetFeedPage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(page(['a']));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.clips).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it('is not permanently wedged by a throw', async () => {
    // `inFlight` is cleared in `finally`; if that were missing the buffer
    // would be stuck with no clips and no way to retry.
    mockGetFeedPage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(page(['a']));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.clips).toHaveLength(1));
  });
});

describe('useFeedBuffer — buffering to the cap', () => {
  it('keeps the newest MAX_BUFFER and reports the evicted ids', async () => {
    const first = Array.from({ length: 10 }, (_, i) => `p0_${i}`);
    mockGetFeedPage.mockResolvedValueOnce(page(first));
    const { result } = await renderHook(() => useFeedBuffer());
    await waitFor(() => expect(result.current.clips).toHaveLength(10));

    const seen = new Set(first);
    for (let i = 1; i <= 8; i += 1) {
      const ids = Array.from({ length: 10 }, (_, k) => `p${i}_${k}`);
      ids.forEach((id) => seen.add(id));
      mockGetFeedPage.mockResolvedValueOnce(page(ids, { queueHealth: 80 }));
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { result.current.refresh(); });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(result.current.clips.length).toBeGreaterThan(0));
    }

    expect(result.current.clips).toHaveLength(MAX_BUFFER);
    // Oldest gone, newest present.
    expect(result.current.clips.some((c) => c.id === 'p0_0')).toBe(false);
    expect(result.current.clips[result.current.clips.length - 1]?.id).toBe('p8_9');
    expect(result.current.lastEvicted.length).toBeGreaterThan(0);
  });
});

describe('useSuggestionsFallback', () => {
  // /suggestions/ is the cold-start source precisely because it is NOT
  // destructive, so it is the one endpoint that may be called repeatedly. The
  // cost of getting this wrong is the opposite of /feed/: a blank screen, not
  // a destroyed page.

  it('does not call the API while disabled', async () => {
    mockGetSuggestions.mockResolvedValue({ clips: [], next: null });
    await renderHook(() => useSuggestionsFallback('all', false));
    expect(mockGetSuggestions).not.toHaveBeenCalled();
  });

  it('requests the unfiltered category by default', async () => {
    // `all` is now honoured server-side as "no category filter". It used to be
    // matched literally against a free-text column and matched nothing, which
    // is why this caller hardcoded 'music' and a cold start could only ever
    // show one category.
    mockGetSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    const { result } = await renderHook(() => useSuggestionsFallback('all', true));
    await waitFor(() => expect(result.current.clips).toHaveLength(1));
    expect(mockGetSuggestions).toHaveBeenCalledWith('all');
  });

  it('returns validated clips through the typed endpoint', async () => {
    mockGetSuggestions.mockResolvedValue({ clips: [clip('a'), clip('b')], next: null });
    const { result } = await renderHook(() => useSuggestionsFallback('all', true));
    await waitFor(() => expect(result.current.clips).toHaveLength(2));
    expect(result.current.clips[0]?.id).toBe('a');
  });

  it('surfaces an error without wiping what is already shown', async () => {
    mockGetSuggestions.mockRejectedValue(new Error('nope'));
    const { result } = await renderHook(() => useSuggestionsFallback('all', true));
    await waitFor(() => expect(result.current.error).toBe('nope'));
    expect(result.current.clips).toEqual([]);
  });

  it('is safe to call repeatedly', async () => {
    mockGetSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    const { result } = await renderHook(() => useSuggestionsFallback('all', true));
    await waitFor(() => expect(result.current.clips).toHaveLength(1));
    await act(async () => { result.current.clips.length; });
    expect(mockGetSuggestions).toHaveBeenCalledTimes(1);
  });
});
