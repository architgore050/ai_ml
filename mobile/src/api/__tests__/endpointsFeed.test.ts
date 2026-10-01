import { cursorFromNextUrl, getFeedPage, getSuggestions, mintPlaybackToken, NATIVE_CLIENT_HEADER, NATIVE_CLIENT_VALUE } from '../endpoints/feed';
import { apiFetch } from '../client';

/**
 * Endpoint-shape tests.
 *
 * Two of these pin real bugs rather than restating the implementation:
 *
 *  - `getSuggestions` used to return `clips: unknown[]` and the caller did
 *    `rows as FeedClip[]`. Nothing validated the fallback path, so a drifted
 *    serializer became an undefined-property crash inside `ReelCard`, and a row
 *    missing `id` became an `undefined` `keyExtractor` — which silently
 *    corrupts VirtualizedList cell reuse instead of failing loudly.
 *
 *  - `getSuggestions` also passed DRF's absolute `next` url back as `?cursor=`.
 *    `decode_cursor` would base64-decode the url characters into garbage and
 *    raise `InvalidCursor` (400), so any pagination attempt failed.
 */

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const clipRow = (id: string) => ({
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

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('getFeedPage', () => {
  it('calls the destructive endpoint exactly as the server expects', async () => {
    mockApiFetch.mockResolvedValue({ next: 'auto_trigger', queue_health: 30, results: [] });
    await getFeedPage();
    expect(mockApiFetch).toHaveBeenCalledWith('/feed/');
    // No method override, no cache mode, no retry: a refetch would consume
    // another page. The client is the thing that must not re-request.
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('getSuggestions', () => {
  it('returns validated clips, not unknown[]', async () => {
    mockApiFetch.mockResolvedValue({ results: [clipRow('a')], next: null });
    const { clips } = await getSuggestions('music');
    expect(clips).toHaveLength(1);
    expect(clips[0]?.id).toBe('a');
    // A typed array, so a drifted row is a parse error at the boundary.
    expect(typeof clips[0]?.title).toBe('string');
  });

  it('throws on a malformed row instead of passing it through', async () => {
    mockApiFetch.mockResolvedValue({ results: [{ id: 'a' }], next: null });
    await expect(getSuggestions('music')).rejects.toThrow();
  });

  it('treats a missing results key as an empty page', async () => {
    mockApiFetch.mockResolvedValue({ next: null });
    const { clips } = await getSuggestions('music');
    expect(clips).toEqual([]);
  });

  it('builds the category query', async () => {
    mockApiFetch.mockResolvedValue({ results: [], next: null });
    await getSuggestions('funny');
    expect(mockApiFetch).toHaveBeenCalledWith('/suggestions/?category=funny');
  });

  it('omits the query entirely when no category is given', async () => {
    mockApiFetch.mockResolvedValue({ results: [], next: null });
    await getSuggestions();
    expect(mockApiFetch).toHaveBeenCalledWith('/suggestions/');
  });
});

describe('cursorFromNextUrl', () => {
  it('extracts the opaque cursor from DRF absolute url', () => {
    // CursorPagination returns an absolute url, not a bare cursor.
    const next = 'https://localhost:18443/suggestions/?category=music&cursor=cD0yMDI2LTA5';
    expect(cursorFromNextUrl(next)).toBe('cD0yMDI2LTA5');
  });

  it('returns null for a null, undefined or empty next', () => {
    expect(cursorFromNextUrl(null)).toBeNull();
    expect(cursorFromNextUrl(undefined)).toBeNull();
    expect(cursorFromNextUrl('')).toBeNull();
  });

  it('returns null when the url carries no cursor', () => {
    expect(cursorFromNextUrl('https://localhost:18443/suggestions/')).toBeNull();
  });

  it('degrades to null rather than returning a whole url as a cursor', () => {
    // The failure this prevents: handing the whole url to `?cursor=`, which
    // makes decode_cursor produce garbage and 400.
    const bogus = 'not a url at all';
    expect(cursorFromNextUrl(bogus)).not.toBe(bogus);
  });

  it('is threaded through getSuggestions', async () => {
    mockApiFetch.mockResolvedValue({
      results: [clipRow('a')],
      next: 'https://localhost:18443/suggestions/?cursor=abc123',
    });
    const { next } = await getSuggestions('music');
    expect(next).toBe('abc123');
  });
});

describe('mintPlaybackToken', () => {
  it('POSTs with the native opt-in header', async () => {
    mockApiFetch.mockResolvedValue({ status: 'ok', token: 'a.b.c' });
    await mintPlaybackToken('11111111-1111-1111-1111-111111111111');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/media/playback-token/11111111-1111-1111-1111-111111111111/',
      { method: 'POST', headers: { [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE } },
    );
  });

  it('rejects a body with no token', async () => {
    // The server omits `token` unless `X-EchoFlow-Client: native` is present.
    // A web-shaped body on the native stack means the credential only
    // travelled as an HttpOnly cookie the player cannot present, so this must
    // fail loudly rather than load a clip that will 403 on every segment.
    mockApiFetch.mockResolvedValue({ status: 'ok' });
    await expect(mintPlaybackToken('11111111-1111-1111-1111-111111111111')).rejects.toThrow();
  });

  it('returns the token when present', async () => {
    mockApiFetch.mockResolvedValue({ status: 'ok', token: 'hdr.payload.sig' });
    const token = await mintPlaybackToken('11111111-1111-1111-1111-111111111111');
    expect(token.token).toBe('hdr.payload.sig');
  });
});
