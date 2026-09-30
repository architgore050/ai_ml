import { ApiError } from '../api/client';
import { mintPlaybackToken } from '../api/endpoints/feed';

/**
 * The playback-token cache, as pure logic with no React dependency.
 *
 * Extracted from the hook deliberately. The subtle parts — expiry arithmetic,
 * in-flight de-duplication, and the status mapping — are where a real defect
 * would live, and none of them need a renderer to exercise. The hook in
 * `usePlaybackToken.ts` is a thin wrapper over this.
 *
 * ## Why the TTL is assumed rather than read
 * `MEDIA_TOKEN_TTL_SECONDS` defaults to 600 but is per-deployment config, and
 * the client cannot read it. The cache assumes a TTL SHORTER than the real one
 * and refreshes early, because the two failure modes are not symmetric:
 *
 *   - refresh early  → one extra cheap call (scope `playback_token`, 300/min).
 *   - refresh late   → the edge answers 403 and the clip goes silent
 *                      mid-playback. User-visible and expensive.
 *
 * `refresh()` exists for exactly that second case: when the edge rejects a
 * token, the client's clock is still confidently wrong, so eviction must not
 * depend on expiry.
 */

/** Deliberately < the 600 s server default. */
export const ASSUMED_TTL_MS = 8 * 60 * 1000;
/** plan §10: refresh when under 120 s remains. */
export const REFRESH_MARGIN_MS = 120 * 1000;

export type CachedToken = { token: string; expiresAt: number };

const cache = new Map<string, CachedToken>();
/** De-duplicates concurrent mints of one clip. */
const inflight = new Map<string, Promise<CachedToken>>();
/** Changes whenever an account boundary invalidates every token. */
let cacheGeneration = 0;

/**
 * Which clip a state describes.
 *
 * Carried on EVERY variant, not just `ready`, because the lag is not specific
 * to tokens. `useState` lags its input by one render, so on the render where
 * `clipId` moves A→B the hook still holds A's *whole* previous state — token,
 * or 403, or 409. A consumer that branches on `status` alone would render A's
 * error on B's card.
 *
 * `usePlaybackToken` resets the state to `{status:'minting', clipId:null}` for
 * the superseded clip, and a consumer compares `clipId` before acting, so a
 * stale read is a cheap no-op instead of a wrong-clip 403 or a wrong tombstone.
 */
type TokenState = { clipId: string | null };

export type TokenStatus =
  /**
   * A usable token. `clipId` is the clip the token is FOR, not the clip the
   * hook was called with. Tokens are per-clip scoped at the edge
   * (`workers/hls-token-worker/src/token.ts` checks the requested path's clip
   * prefix against the token's `c` claim), so a token presented for a
   * different clip is rejected with 403 — on the manifest and every segment.
   */
  | ({ status: 'ready'; token: string } & TokenState)
  | ({ status: 'minting' } & TokenState)
  /** HLS not produced yet — the clip is still encoding. Retry. */
  | ({ status: 'processing' } & TokenState)
  /** Unmoderated OR licence-restricted. ONE state for both: the server sends two
   *  different 403 messages, and telling them apart would leak moderation or
   *  licensing state to a caller who holds nothing but a UUID. */
  | ({ status: 'unavailable' } & TokenState)
  | ({ status: 'gone' } & TokenState)
  /**
   * `auth-required` is separate from a generic error because the two need
   * different client actions: 401 means the session is dead and the app is
   * already navigating to login via `onSessionExpired`, so the card should say
   * "sign in again", not "could not play this clip". Folding it into `error`
   * showed a false playback diagnosis for a screen before the redirect landed.
   */
  | ({ status: 'auth-required' } & TokenState)
  | ({ status: 'error'; message: string } & TokenState);

/** Map a thrown error onto the state the UI renders. */
export function classifyTokenError(err: unknown, clipId: string | null = null): TokenStatus {
  if (!(err instanceof ApiError)) {
    return {
      status: 'error',
      clipId,
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
  switch (err.status) {
    case 401:
      return { status: 'auth-required', clipId };
    case 403:
      return { status: 'unavailable', clipId };
    case 404:
      return { status: 'gone', clipId };
    case 409:
      return { status: 'processing', clipId };
    case 429:
      // The token endpoint is throttled at 300/min. A fast scroller plus
      // prefetching can reach it, and a 429 is retryable — so it must not be
      // presented as a permanent per-clip failure.
      return { status: 'error', clipId, message: 'Too many requests' };
    default:
      return { status: 'error', clipId, message: err.message };
  }
}

export function isFreshToken(entry: CachedToken | undefined): entry is CachedToken {
  return !!entry && Date.now() < entry.expiresAt - REFRESH_MARGIN_MS;
}

/** Cached token if still comfortably valid, else null. */
export function peekToken(clipId: string): CachedToken | null {
  const entry = cache.get(clipId);
  return isFreshToken(entry) ? entry : null;
}

export function evictToken(clipId: string): void {
  cache.delete(clipId);
}

/**
 * Forget every bearer token at an account boundary.
 *
 * A map clear alone is insufficient: a mint started just before logout may
 * resolve afterwards. The generation keeps that stale result from being
 * cached for the next account on this device.
 */
export function clearPlaybackTokenCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inflight.clear();
}

/**
 * Return a valid token for `clipId`, minting only if the cache cannot serve it.
 *
 * Concurrent calls for the same clip share one request.
 */
export async function getOrMintToken(clipId: string): Promise<CachedToken> {
  const fresh = peekToken(clipId);
  if (fresh) return fresh;

  const existing = inflight.get(clipId);
  if (existing) return existing;

  const generation = cacheGeneration;
  const promise = (async (): Promise<CachedToken> => {
    const { token } = await mintPlaybackToken(clipId);
    const entry: CachedToken = { token, expiresAt: Date.now() + ASSUMED_TTL_MS };
    if (cacheGeneration === generation) cache.set(clipId, entry);
    return entry;
  })();

  inflight.set(clipId, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(clipId) === promise) inflight.delete(clipId);
  }
}

/**
 * Warm the cache without surfacing failure.
 *
 * The next clip's token is fetched while the current one plays, because
 * minting on swipe produces a visible stall. A rejected prefetch is invisible
 * by design: the clip is fetched properly when it becomes active, and a
 * prefetch that could surface an error would be worse than a missing one.
 */
export function prefetchToken(clipId: string): void {
  if (peekToken(clipId)) return;
  void getOrMintToken(clipId).catch(() => undefined);
}

/** Test seam: module-level state would otherwise leak between test files. */
export function __resetTokenCacheForTests(): void {
  clearPlaybackTokenCache();
}
