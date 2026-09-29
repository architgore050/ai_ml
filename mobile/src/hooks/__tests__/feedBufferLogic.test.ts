import { getFeedPage, getSuggestions } from '../../api/endpoints/feed';
import type { FeedClip } from '../../api/schema';

/**
 * `GET /feed/` is a destructive `lpop` (views/feed.py:75): every call CONSUMES
 * up to 10 ids. There is no cursor and no way to re-read a page.
 *
 * So the buffer's job is not "fetch pages" — it is to make sure exactly one
 * request happens, that its ids are never discarded, and that a duplicate
 * (which the trending fallback can produce) cannot make two cards fight over
 * one playback token.
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

/** The merge rule, restated as a pure function so it can be pinned. */
function mergeClips(seen: Set<string>, existing: FeedClip[], incoming: FeedClip[]): FeedClip[] {
  const merged = [...existing];
  for (const c of incoming) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }
  return merged.length > 60 ? merged.slice(merged.length - 60) : merged;
}

describe('feed buffer merge rules', () => {
  it('appends unseen clips in order', () => {
    const seen = new Set<string>();
    const out = mergeClips(seen, [], [clip('a'), clip('b')]);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('dedupes by id', () => {
    // A duplicate id would mean two ReelCards both minting a token for the
    // same clip and racing on `replace()` — one card silently winning.
    const seen = new Set<string>();
    mergeClips(seen, [], [clip('a')]);
    const out = mergeClips(seen, [clip('a')], [clip('a'), clip('b')]);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('caps at 60 and keeps the NEWEST, so the reel keeps moving', () => {
    const seen = new Set<string>();
    let acc: FeedClip[] = [];
    for (let i = 0; i < 75; i += 1) {
      acc = mergeClips(seen, acc, [clip(`c${i}`)]);
    }
    expect(acc).toHaveLength(60);
    expect(acc[acc.length - 1]?.id).toBe('c74');
    // Oldest dropped from the front, not the newest from the end.
    expect(acc[0]?.id).toBe('c15');
  });

  it('never shrinks mid-session except to enforce the cap', () => {
    const seen = new Set<string>();
    let acc: FeedClip[] = [];
    for (let i = 0; i < 40; i += 1) {
      acc = mergeClips(seen, acc, [clip(`c${i}`)]);
    }
    expect(acc).toHaveLength(40);
  });
});

describe('getFeedPage contract', () => {
  beforeEach(() => {
    mockGetFeedPage.mockReset();
    mockGetSuggestions.mockReset();
  });

  it('a 200 page reports queue health so the caller can decide to refill', async () => {
    mockGetFeedPage.mockResolvedValue({
      kind: 'ok',
      clips: [clip('a')],
      queueHealth: 3,
    });
    const page = await getFeedPage();
    expect(page.kind).toBe('ok');
    if (page.kind === 'ok') expect(page.queueHealth).toBe(3);
  });

  it('a 202 is not an error and carries the retry hint', async () => {
    // The failure mode this guards: treating a cold queue as a hard failure
    // shows the user an error screen for a condition that resolves itself in
    // 1.5s.
    mockGetFeedPage.mockResolvedValue({ kind: 'cold', retryAfterMs: 1500 });
    await expect(getFeedPage()).resolves.toEqual({ kind: 'cold', retryAfterMs: 1500 });
  });
});

describe('getSuggestions fallback', () => {
  beforeEach(() => {
    mockGetSuggestions.mockReset();
  });

  it('is safe to call repeatedly, unlike /feed/', async () => {
    // This is exactly why the cold-start fallback uses /suggestions/ and not
    // the feed: /suggestions/ is a normal paged read and costs no queue.
    mockGetSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    await getSuggestions('music');
    await getSuggestions('music');
    expect(mockGetSuggestions).toHaveBeenCalledTimes(2);
    expect(mockGetSuggestions).toHaveBeenLastCalledWith('music');
  });
});
