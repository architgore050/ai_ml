import { useCallback, useEffect, useState } from 'react';

import {
  classifyTokenError,
  getOrMintToken,
  peekToken,
  evictToken,
  prefetchToken,
  type TokenStatus,
} from '../lib/playbackTokenCache';

/**
 * React binding for the playback-token cache.
 *
 * All the logic — expiry arithmetic, de-duplication, error classification —
 * lives in `lib/playbackTokenCache.ts` so it is testable without a renderer.
 * This only manages the lifecycle: one in-flight resolution per clipId, and
 * dropping results from a superseded effect run.
 */
export function usePlaybackToken(
  clipId: string | null,
  enabled = true,
): TokenStatus & { refresh: () => void } {
  const [state, setState] = useState<TokenStatus>({ status: 'minting' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!clipId || !enabled) return;

    // A newer effect run (clipId / enabled / nonce changed) owns the state now.
    // Without this, a slow mint for a swiped-past reel lands after the new
    // one and the card shows the wrong clip's token.
    let cancelled = false;

    const cached = peekToken(clipId);
    if (cached) {
      setState({ status: 'ready', token: cached.token });
      return;
    }

    setState({ status: 'minting' });
    getOrMintToken(clipId)
      .then((entry) => {
        if (!cancelled) setState({ status: 'ready', token: entry.token });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState(classifyTokenError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [clipId, enabled, nonce]);

  const refresh = useCallback(() => {
    if (!clipId) return;
    // The edge can reject a token our clock still believes is good, so
    // eviction must not wait for expiry.
    evictToken(clipId);
    setNonce((n) => n + 1);
  }, [clipId]);

  return { ...state, refresh };
}

/** Warm the next clip's token so a swipe does not stall. Failures invisible. */
export function usePrefetchPlaybackToken(clipId: string | null): void {
  useEffect(() => {
    if (clipId) prefetchToken(clipId);
  }, [clipId]);
}

export { __resetTokenCacheForTests } from '../lib/playbackTokenCache';
export type { TokenStatus } from '../lib/playbackTokenCache';
