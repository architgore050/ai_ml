import { parseFeedResponse } from '../schema';

/**
 * `GET /feed/` returns 200 or 202, and `apiFetch` hands back the parsed body
 * for both (it only throws on non-2xx). So the status is not available and the
 * two must be told apart by SHAPE.
 *
 * This matters because the mistake is silent in one direction: treat a 202 as a
 * 200 and you render an empty feed with no error and no explanation, which is
 * indistinguishable from a genuinely empty queue.
 */
describe('parseFeedResponse', () => {
  const clip = (id: string) => ({
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

  it('reads a 200 page', () => {
    const result = parseFeedResponse({
      next: 'auto_trigger',
      queue_health: 7,
      results: [clip('a'), clip('b')],
    });
    expect(result).toMatchObject({ kind: 'ok', queueHealth: 7 });
    if (result.kind === 'ok') {
      expect(result.clips).toHaveLength(2);
      expect(result.clips[0]?.id).toBe('a');
    }
  });

  it('reads a 202 cold-start and surfaces the server hint', () => {
    const result = parseFeedResponse({ retry_after_ms: 1500, degraded: true });
    expect(result).toEqual({ kind: 'cold', retryAfterMs: 1500 });
  });

  it('falls back to the documented 1500ms when the hint is absent', () => {
    // Do not invent your own backoff: the server's documented default is the
    // floor, and a shorter client retry just burns requests.
    expect(parseFeedResponse({ degraded: true })).toEqual({
      kind: 'cold',
      retryAfterMs: 1500,
    });
  });

  it('does not mistake an empty 200 page for a 202', () => {
    // `results: []` with a queue_health is a legitimately empty page, NOT the
    // cold-start marker. Conflating the two would stop the client ever
    // retrying a queue that is merely slow to fill.
    const result = parseFeedResponse({ next: 'auto_trigger', queue_health: 0, results: [] });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.clips).toHaveLength(0);
  });

  it('carries the degraded flag through so the UI can say so', () => {
    // The trending fallback is a different content set, and the user should
    // know they are not seeing their personalised feed.
    const result = parseFeedResponse({
      next: 'auto_trigger',
      queue_health: 0,
      degraded: true,
      results: [clip('a')],
    });
    expect(result).toMatchObject({ kind: 'ok', degraded: true });
  });

  it('tolerates a clip missing the optional B5 fields', () => {
    // duration_ms and tags are optional in FeedClipSerializer; a clip
    // produced before B5 must not fail the whole page.
    const result = parseFeedResponse({
      next: 'auto_trigger',
      queue_health: 1,
      results: [{ ...clip('a') }],
    });
    expect(result.kind).toBe('ok');
  });

  it('rejects a genuinely malformed page rather than returning empty', () => {
    // A silent empty result here is the "no comments" bug from plan D5: a
    // shape mismatch must be loud.
    expect(() => parseFeedResponse({ totally: 'wrong' })).toThrow();
  });
});
