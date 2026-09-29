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

export type TokenStatus =
  | { status: 'ready'; token: string }
  | { status: 'minting' }
  /** HLS not produced yet — the clip is still encoding. Retry. */
  | { status: 'processing' }
  /** Unmoderated OR licence-restricted. ONE state for both: the server sends two
   *  different 403 messages, and telling them apart would leak moderation or
   *  licensing state to a caller who holds nothing but a UUID. */
  | { status: 'unavailable' }
  | { status: 'gone' }
  | { status: 'error'; message: string };

/** Map a thrown error onto the state the UI renders. */
export function classifyTokenError(err: unknown): TokenStatus {
  if (!(err instanceof ApiError)) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' };
  }
  switch (err.status) {
    case 409:
      return { status: 'processing' };
    case 403:
      return { status: 'unavailable' };
    case 404:
      return { status: 'gone' };
    default:
      return { status: 'error', message: err.message };
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
 * Return a valid token for `clipId`, minting only if the cache cannot serve it.
 *
 * Concurrent calls for the same clip share one request.
 */
export async function getOrMintToken(clipId: string): Promise<CachedToken> {
  const fresh = peekToken(clipId);
  if (fresh) return fresh;

  const existing = inflight.get(clipId);
  if (existing) return existing;

  const promise = (async (): Promise<CachedToken> => {
    const { token } = await mintPlaybackToken(clipId);
    const entry: CachedToken = { token, expiresAt: Date.now() + ASSUMED_TTL_MS };
    cache.set(clipId, entry);
    return entry;
  })();

  inflight.set(clipId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(clipId);
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
  cache.clear();
  inflight.clear();
}
