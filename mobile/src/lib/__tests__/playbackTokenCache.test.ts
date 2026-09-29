import { ApiError } from '../../api/client';
import { mintPlaybackToken } from '../../api/endpoints/feed';
import {
  ASSUMED_TTL_MS,
  REFRESH_MARGIN_MS,
  __resetTokenCacheForTests,
  classifyTokenError,
  evictToken,
  getOrMintToken,
  isFreshToken,
  peekToken,
  prefetchToken,
} from '../playbackTokenCache';

jest.mock('../../api/endpoints/feed', () => ({
  mintPlaybackToken: jest.fn(),
  NATIVE_CLIENT_HEADER: 'X-EchoFlow-Client',
  NATIVE_CLIENT_VALUE: 'native',
}));

const mockMint = mintPlaybackToken as jest.MockedFunction<typeof mintPlaybackToken>;
const ok = (token: string) => ({ status: 'ok' as const, token });

describe('playbackTokenCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    __resetTokenCacheForTests();
    mockMint.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('expiry arithmetic', () => {
    it('serves a freshly minted token without re-minting', async () => {
      mockMint.mockResolvedValue(ok('t1'));
      const entry = await getOrMintToken('clip-a');
      expect(entry.token).toBe('t1');
      expect(mockMint).toHaveBeenCalledTimes(1);

      expect(peekToken('clip-a')).toEqual(entry);
      await getOrMintToken('clip-a');
      expect(mockMint).toHaveBeenCalledTimes(1);
    });

    it('is fresh just inside the refresh margin and stale just past it', async () => {
      mockMint.mockResolvedValue(ok('t1'));
      await getOrMintToken('clip-a');

      // One second before the margin opens: still cached.
      jest.setSystemTime(new Date(Date.now() + ASSUMED_TTL_MS - REFRESH_MARGIN_MS - 1000));
      expect(peekToken('clip-a')).not.toBeNull();
      expect(isFreshToken(peekToken('clip-a') ?? undefined)).toBe(true);

      // Past the margin: must re-mint, because the edge expires the real
      // token at 600s and we would be holding one with no time left.
      jest.setSystemTime(new Date(Date.now() + REFRESH_MARGIN_MS));
      expect(isFreshToken(peekToken('clip-a') ?? undefined)).toBe(false);
    });

    it('assumes a TTL shorter than the server default, deliberately', () => {
      // If this ever equals or exceeds 600_000 the "refresh early" strategy
      // inverts and the app can present an already-expired token.
      expect(ASSUMED_TTL_MS).toBeLessThan(600_000);
      expect(REFRESH_MARGIN_MS).toBeGreaterThan(0);
    });

    it('evictToken forces the next call to re-mint', async () => {
      mockMint.mockResolvedValueOnce(ok('stale')).mockResolvedValueOnce(ok('fresh'));
      expect((await getOrMintToken('clip-a')).token).toBe('stale');

      evictToken('clip-a');
      expect((await getOrMintToken('clip-a')).token).toBe('fresh');
    });
  });

  describe('concurrency', () => {
    it('de-duplicates simultaneous mints of the same clip', async () => {
      let release!: (v: { status: 'ok'; token: string }) => void;
      mockMint.mockReturnValue(
        new Promise((r) => {
          release = r;
        }),
      );

      const a = getOrMintToken('clip-a');
      const b = getOrMintToken('clip-a');
      expect(mockMint).toHaveBeenCalledTimes(1);

      release(ok('t1'));
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.token).toBe('t1');
      expect(rb.token).toBe('t1');
    });

    it('keeps clips independent', async () => {
      mockMint.mockResolvedValueOnce(ok('a')).mockResolvedValueOnce(ok('b'));
      const [a, b] = await Promise.all([getOrMintToken('clip-a'), getOrMintToken('clip-b')]);
      expect(a.token).toBe('a');
      expect(b.token).toBe('b');
    });

    it('clears the in-flight slot after a failure so a retry is possible', async () => {
      mockMint.mockRejectedValueOnce(new ApiError({ status: 500, body: {} }));
      await expect(getOrMintToken('clip-a')).rejects.toBeInstanceOf(ApiError);

      mockMint.mockResolvedValueOnce(ok('recovered'));
      expect((await getOrMintToken('clip-a')).token).toBe('recovered');
    });
  });

  describe('error classification (plan §11 error mapping)', () => {
    // Every classified state carries the clipId it describes. That is not
    // decoration: `usePlaybackToken` is `useState`, so it lags its input by a
    // render, and a consumer must be able to tell A's 403 from B's. See the
    // `TokenState` docstring.

    it('409 means still encoding, not an error', () => {
      expect(classifyTokenError(new ApiError({ status: 409, body: {} }), 'clip-a')).toEqual({
        status: 'processing',
        clipId: 'clip-a',
      });
    });

    it('collapses BOTH 403 causes into one indistinguishable state', () => {
      // The server sends "Content not available." (unmoderated) and
      // "Clip not available." (licence-restricted). The rendered state must
      // not reveal which, or a caller holding only a UUID learns something
      // about moderation or licensing.
      const moderation = classifyTokenError(
        new ApiError({ status: 403, body: { detail: 'Content not available.' } }),
        'clip-a',
      );
      const licensing = classifyTokenError(
        new ApiError({ status: 403, body: { detail: 'Clip not available.' } }),
        'clip-a',
      );
      expect(moderation).toEqual({ status: 'unavailable', clipId: 'clip-a' });
      expect(licensing).toEqual(moderation);
      expect(JSON.stringify(moderation)).not.toContain('Content');
      expect(JSON.stringify(moderation)).not.toContain('Clip');
    });

    it('404 is distinct from 403', () => {
      expect(classifyTokenError(new ApiError({ status: 404, body: {} }), 'clip-a')).toEqual({
        status: 'gone',
        clipId: 'clip-a',
      });
    });

    it('a non-HTTP failure is an error, not a tombstone', () => {
      expect(classifyTokenError(new Error('Network request failed'), 'clip-a')).toEqual({
        status: 'error',
        clipId: 'clip-a',
        message: 'Network request failed',
      });
    });
  });

  describe('prefetch', () => {
    it('warms the cache and skips a second mint', async () => {
      mockMint.mockResolvedValue(ok('pre'));
      prefetchToken('clip-next');
      await jest.advanceTimersByTimeAsync(0);

      expect(mockMint).toHaveBeenCalledTimes(1);
      prefetchToken('clip-next');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockMint).toHaveBeenCalledTimes(1);
    });

    it('never surfaces a rejection', async () => {
      mockMint.mockRejectedValue(new ApiError({ status: 403, body: {} }));
      expect(() => {
        prefetchToken('clip-bad');
      }).not.toThrow();
      await jest.advanceTimersByTimeAsync(0);
    });
  });
});
