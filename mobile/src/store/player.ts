import { create } from 'zustand';
import { createAudioPlayer, type AudioPlayer, type AudioPlayerOptions } from 'expo-audio';

import type { FeedClip } from '../api/schema';

/**
 * Playback state. ONE player for the whole app, created once here and
 * attached at the app root — see `usePlayerInstance` below.
 *
 * ## Why one player, owned here
 * The old app owned the player inside a feed *card*. Every card unmounted with
 * its view, taking the player and the audio with it: scrolling reset playback
 * and the user lost their position on every swipe. That was the single most
 * expensive defect in the old app (plan §8, §10 "Player placement").
 *
 * ## Why `createAudioPlayer` and not `useAudioPlayer`
 * `useAudioPlayer` is a hook, and a hook cannot be called inside a Zustand
 * store. The two ways out are (a) call the hook in a root component and push
 * the instance in, or (b) use the non-hook factory. This uses (b) so the
 * store is constructible outside React, which is what makes it testable — the
 * token/load logic can be exercised in plain Jest with no renderer. The
 * instance is still a single app-wide singleton, created once and torn down
 * on unmount, so the intent of the plan is preserved.
 *
 * ## UNITS
 * `expo-audio` is in **seconds** throughout (`status.currentTime`,
 * `status.duration`, `seekTo(seconds)`). The backend speaks **milliseconds**
 * (`clip.duration_ms`). Every conversion happens at this boundary and nowhere
 * else, and is named, because a silent factor-of-1000 error would corrupt the
 * completion-rate telemetry that drives the recommender (defect 2) with no
 * visible symptom.
 */

/** ms (backend) → s (expo-audio). */
export const msToSeconds = (ms: number): number => ms / 1000;

/** s (expo-audio) → ms (backend). */
export const secondsToMs = (seconds: number): number => Math.round(seconds * 1000);

let instance: AudioPlayer | null = null;

/**
 * The one player, created on demand.
 *
 * Lazy so importing this module never touches a native module, and
 * constructible outside React so the load logic is testable in plain Jest.
 * The instance is still a single app-wide singleton.
 */
export function getPlayer(): AudioPlayer {
  if (!instance) {
    instance = createAudioPlayer(null, { updateInterval: 500 } satisfies AudioPlayerOptions);
  }
  return instance;
}

/**
 * The player if it exists, else `null`. **Does not create one.**
 *
 * `pause`/`resume`/`seekToSeconds` must use this. They used to call
 * `getPlayer()`, which after `releasePlayer()` would happily construct a fresh
 * AVPlayer/ExoPlayer with no source purely to pause nothing — resurrecting a
 * native resource on a call that cannot do anything useful.
 */
export function getPlayerOrNull(): AudioPlayer | null {
  return instance;
}

/**
 * Release the native player and clear the store's claim that something is
 * playing. Call from the root component's effect cleanup.
 *
 * Clearing the store is not optional. The effect body creates nothing, so its
 * cleanup can fire at any time relative to the component that actually uses the
 * player — and reachable today on any Fast Refresh of `_layout.tsx`. Without
 * the reset the store keeps `status: 'playing'` and `playingClipId` for a
 * player that no longer exists, and since no dependency changes, **no load is
 * ever re-triggered**: playback is dead behind a "Now playing" card.
 */
export function releasePlayer(): void {
  instance?.remove();
  instance = null;
  usePlayerStore.getState().reset();
}

export type PlaybackStatus =
  | 'idle'
  | 'minting'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'processing'
  /**
   * `unavailable` is ONE state for both 403 causes — unmoderated and
   * licence-restricted. The server sends two different messages; distinguishing
   * them would leak moderation or licensing state to a caller holding only a
   * UUID, so `classifyTokenError` collapses them and this must stay collapsed.
   */
  | 'unavailable'
  /** 404: the clip does not exist. Same copy as `unavailable` by choice. */
  | 'gone'
  /**
   * 401: the session died, so `onSessionExpired` is already navigating to
   * login. Kept distinct from `error` so the card says "sign in again"
   * instead of a false "could not play this clip".
   */
  | 'auth-required'
  | 'error';

export type PlayerState = {
  queue: FeedClip[];
  activeIndex: number;
  handsFree: boolean;
  status: PlaybackStatus;
  /** Null until a load succeeds; the id actually playing, not the requested one. */
  playingClipId: string | null;
  error: string | null;

  setQueue: (clips: FeedClip[]) => void;
  setActiveIndex: (index: number) => void;
  toggleHandsFree: () => void;
  setStatus: (status: PlaybackStatus, error?: string | null) => void;
  /**
   * Return the store to its initial state, so a released player cannot leave
   * the UI asserting that audio is playing. See `releasePlayer`.
   */
  reset: () => void;
};

const INITIAL: Pick<
  PlayerState,
  'queue' | 'activeIndex' | 'handsFree' | 'status' | 'playingClipId' | 'error'
> = {
  queue: [],
  activeIndex: 0,
  handsFree: true,
  status: 'idle',
  playingClipId: null,
  error: null,
};

export const usePlayerStore = create<PlayerState>((set) => ({
  ...INITIAL,

  setQueue: (clips) => set({ queue: clips }),
  setActiveIndex: (index) => set({ activeIndex: index }),
  toggleHandsFree: () => set((s) => ({ handsFree: !s.handsFree })),
  setStatus: (status, error = null) => set({ status, error }),
  reset: () => set({ ...INITIAL }),
}));

export type LoadResult = 'loaded' | 'failed';

/**
 * Point the player at `clip` using `token`, and play it.
 *
 * `clip.hls_playlist_url` is used **verbatim** — never rebuilt, never prefixed
 * with the API base. It points at the edge (a different host and port from the
 * API) and in `edge` style it is bucket-less; both existing clients got this
 * wrong and it 403s (`FRONTEND-REQUIREMENTS.md` §4.7).
 *
 * The token rides as a per-source **request header**, which expo-audio applies
 * to the manifest *and* every segment. This is the only transport a native
 * player can use: the `ef_hls_token` cookie is HttpOnly+Secure and neither
 * AVPlayer nor ExoPlayer's default data source would ever send it.
 *
 * ## There is no generation guard here, and there is not meant to be
 * This function is `async` for the caller's ergonomics but contains **no
 * `await`** — `replace()` and `play()` return `void` in expo-audio (they were
 * Promises in expo-av; awaiting them is a no-op at best). Every statement
 * therefore runs in one synchronous block, so no load can interleave with
 * another and a "stale generation" check could only ever compare a value with
 * itself. A previous revision carried exactly such a check, plus a `generation`
 * parameter and a `'stale'` result, and all three were unreachable.
 *
 * The real ordering guarantees, both outside this function:
 *
 *  - `usePlaybackToken`'s `cancelled` flag drops a superseded token mint, so a
 *    slow mint for a swiped-past reel cannot land after the current one.
 *  - `decidePlaybackAction`'s `load-after` arm is cleared by its effect's own
 *    cleanup, so a deferred load cannot fire for a clip the user has left.
 *
 * Both were verified by test in `lib/__tests__/playbackDecision.test.ts` and
 * `hooks/__tests__/usePlaybackToken.test.ts`. Adding a real guard here needs a
 * genuinely async body first; a ceremonial one is worse than none, because it
 * documents a safety property the code does not have.
 */
export async function loadClip(clip: FeedClip, token: string): Promise<LoadResult> {
  const url = clip.hls_playlist_url;
  if (!url) {
    usePlayerStore.getState().setStatus('error', 'clip has no hls_playlist_url');
    return 'failed';
  }

  try {
    const player = getPlayer();
    player.replace({
      uri: url,
      headers: { 'X-EchoFlow-Media-Token': token },
    });
    player.play();
    // One `set` for status and playingClipId together. Two separate calls let
    // a render observe `status: 'playing'` with the *previous* clip's
    // `playingClipId` — the exact "wrong clip under the new card" hazard the
    // field's docstring exists to prevent.
    usePlayerStore.setState({ status: 'playing', playingClipId: clip.id, error: null });
    return 'loaded';
  } catch (err) {
    usePlayerStore
      .getState()
      .setStatus('error', err instanceof Error ? err.message : 'playback failed');
    return 'failed';
  }
}

export function pause(): void {
  // Must not create a player: after `releasePlayer()` this would resurrect a
  // native AVPlayer/ExoPlayer with no source just to pause nothing.
  getPlayerOrNull()?.pause();
  const s = usePlayerStore.getState();
  if (s.status === 'playing') s.setStatus('paused');
}

export function resume(): void {
  getPlayerOrNull()?.play();
  usePlayerStore.getState().setStatus('playing');
}

/** `seconds` is expo-audio's unit. Callers converting from `duration_ms` use msToSeconds. */
export function seekToSeconds(seconds: number): void {
  void getPlayerOrNull()?.seekTo(seconds);
}
