import type { TokenStatus } from './playbackTokenCache';

/**
 * The decision of what to do with a token, as a pure function.
 *
 * Extracted from the feed screen's load effect because that effect is where
 * the two worst bugs in this app lived, and neither was findable by reading
 * the component:
 *
 *  1. It read `token.token` on the render where `activeClipId` had just
 *     changed. `usePlaybackToken` is `useState`, which lags by one render, so
 *     that value was the *previous* clip's token. Tokens are per-clip scoped
 *     at the edge, so the new clip's manifest was fetched with a foreign
 *     credential and 403'd — on every swipe.
 *
 *  2. `clips` was in the effect's dependency array. A background refill
 *     replaces the array identity, which re-ran the effect, which called
 *     `loadClip` again for the clip the user was already listening to — the
 *     audio restarted under them with no visible cause.
 *
 * Both are properties of a *decision*, not of React, so the decision is a
 * function that can be called directly by a test.
 */

/** `clips.length` is deliberately absent — see `decidePlaybackAction`. */
export type PlaybackInput = {
  token: TokenStatus;
  /** The clip currently on screen, or null when the reel has settled on nothing. */
  activeClipId: string | null;
  /** True when the clip at `activeClipId` is not in the buffer (or is gone). */
  activeClipMissing: boolean;
  /** True when the clip at `activeClipId` has no HLS URL. */
  activeClipHasNoPlaylist: boolean;
  /** Milliseconds since the last load was issued. */
  sinceLastLoadMs: number;
};

export type PlaybackAction =
  /** Load this clip with this token. */
  | { kind: 'load'; clipId: string; token: string }
  /** Wait `waitMs` before loading — the inter-reel pause. */
  | { kind: 'load-after'; clipId: string; token: string; waitMs: number }
  /** Render a terminal state. */
  | { kind: 'show'; status: 'processing' | 'unavailable' | 'gone' | 'auth-required' | 'idle' }
  /** Do nothing: the state belongs to a different clip, or is still settling. */
  | { kind: 'none' }
  /** Eviction removed the clip that was playing; stop the player. */
  | { kind: 'stop' };

/** Inter-reel pause, per plan §13. */
export const INTER_REEL_PAUSE_MS = 1000;

/**
 * Decide what the player should do.
 *
 * Order matters and is load-bearing:
 *
 *  - `stale` FIRST, before any status branch. A state whose `clipId` is not
 *    the active clip describes a *previous* clip — token, 403, 409 or all —
 *    and acting on it is how the wrong clip got loaded, or a tombstone showed
 *    on the wrong card.
 *  - `activeClipMissing` before the token branches, because a clip evicted by
 *    the 60-cap has no URL to load. Playing on would leave audio running for a
 *    reel that is no longer on screen.
 */
export function decidePlaybackAction(input: PlaybackInput): PlaybackAction {
  const { token, activeClipId, activeClipMissing, activeClipHasNoPlaylist } = input;

  // The state describes a different clip than the one on screen. Most often
  // this is the one-render lag described above.
  if (token.clipId !== activeClipId) return { kind: 'none' };
  // Narrowed: from here on `token.clipId === activeClipId` and the hook only
  // ever sets a non-null clipId, so a non-null activeClipId is implied.
  if (!activeClipId) return { kind: 'none' };

  if (activeClipMissing) return { kind: 'stop' };

  // Nothing to play. Terminal for this clip; do not spin.
  if (activeClipHasNoPlaylist) return { kind: 'show', status: 'gone' };

  switch (token.status) {
    case 'minting':
      return { kind: 'show', status: 'idle' };
    case 'processing':
      return { kind: 'show', status: 'processing' };
    case 'unavailable':
      return { kind: 'show', status: 'unavailable' };
    case 'gone':
      return { kind: 'show', status: 'gone' };
    case 'auth-required':
      return { kind: 'show', status: 'auth-required' };
    case 'error':
      // Retain the last good state. The audio is still playing, so clobbering
      // the store to `error` would report a failure for a clip that is
      // audibly fine. The `NetworkBanner` covers the transport failure.
      return { kind: 'none' };
    case 'ready':
      break;
    default:
      return { kind: 'none' };
  }

  // `status: 'ready'` with no token is malformed; never load an empty header.
  if (!token.token) return { kind: 'none' };

  if (input.sinceLastLoadMs < INTER_REEL_PAUSE_MS) {
    return {
      kind: 'load-after',
      clipId: activeClipId,
      token: token.token,
      waitMs: INTER_REEL_PAUSE_MS - input.sinceLastLoadMs,
    };
  }

  return { kind: 'load', clipId: activeClipId, token: token.token };
}
