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

/**
 * What the NATIVE player is doing, as reported by `useAudioPlayerStatus`.
 *
 * Separate from `CardStatus` on purpose. The two are written by different
 * producers — the token lifecycle (`decidePlaybackAction`) and the native
 * player — and collapsing them into one field makes them overwrite each other.
 * That is not hypothetical: `decidePlaybackAction` returns `show: 'processing'`
 * for a still-encoding clip, and a single shared `status` would be reset to
 * `playing` by the next native tick, so the spinner would vanish.
 *
 * `ended` is why the plan's pacing rule can be implemented at all
 * (`motion.pacing.completionThreshold`): natural completion must not be
 * reported as a skip.
 */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/** The card's own state, from the token lifecycle. Not the player's state. */
export type CardStatus =
  | 'idle'
  | 'minting'
  | 'processing'
  | 'unavailable'
  | 'gone'
  | 'auth-required'
  | 'error';

export type PlayerState = {
  queue: FeedClip[];
  activeIndex: number;
  handsFree: boolean;
  /** Token-lifecycle state for the active card. See `CardStatus`. */
  cardStatus: CardStatus;
  /** Native player state. See `PlaybackState`. */
  playback: PlaybackState;
  /** expo-audio SECONDS. Never milliseconds — see the UNITS note above. */
  currentTime: number;
  /** expo-audio SECONDS. 0 until the source reports its duration. */
  duration: number;
  /** Null until a load succeeds; the id actually playing, not the requested one. */
  playingClipId: string | null;
  error: string | null;

  setQueue: (clips: FeedClip[]) => void;
  setActiveIndex: (index: number) => void;
  toggleHandsFree: () => void;
  setCardStatus: (status: CardStatus, error?: string | null) => void;
  /**
   * Apply a native status update. The ONLY writer of `playback`,
   * `currentTime` and `duration`.
   */
  syncFromPlayer: (next: NativeStatusSnapshot) => void;
  /**
   * Return the store to its initial state, so a released player cannot leave
   * the UI asserting that audio is playing. See `releasePlayer`.
   */
  reset: () => void;
};

/**
 * The subset of expo-audio's `AudioStatus` this store reads.
 *
 * Declared structurally rather than imported so `syncFromPlayer` is testable
 * without a native module, and so a field we do not consume cannot tempt a
 * future edit into depending on it.
 */
export type NativeStatusSnapshot = {
  currentTime: number;
  duration: number;
  playing: boolean;
  isBuffering: boolean;
  isLoaded: boolean;
  didJustFinish: boolean;
  error: string | null;
};

/** Order matters: the first matching branch wins, and error must win outright. */
export function playbackStateFrom(snapshot: NativeStatusSnapshot): PlaybackState {
  if (snapshot.error) return 'error';
  if (snapshot.didJustFinish) return 'ended';
  if (snapshot.isBuffering) return 'buffering';
  if (snapshot.playing) return 'playing';
  if (snapshot.isLoaded) return 'paused';
  return 'idle';
}

const INITIAL: Pick<
  PlayerState,
  | 'queue'
  | 'activeIndex'
  | 'handsFree'
  | 'cardStatus'
  | 'playback'
  | 'currentTime'
  | 'duration'
  | 'playingClipId'
  | 'error'
> = {
  queue: [],
  activeIndex: 0,
  handsFree: true,
  cardStatus: 'idle',
  playback: 'idle',
  currentTime: 0,
  duration: 0,
  playingClipId: null,
  error: null,
};

export const usePlayerStore = create<PlayerState>((set) => ({
  ...INITIAL,

  setQueue: (clips) => set({ queue: clips }),
  setActiveIndex: (index) => set({ activeIndex: index }),
  toggleHandsFree: () => set((s) => ({ handsFree: !s.handsFree })),
  setCardStatus: (cardStatus, error = null) => set({ cardStatus, error }),

  syncFromPlayer: (next) => {
    const playback = playbackStateFrom(next);
    set({
      playback,
      currentTime: next.currentTime,
      duration: next.duration,
      // A native error is the only thing that writes `error` from this side.
      // Card-level errors come from `setCardStatus`.
      error: next.error ?? (playback === 'error' ? 'Playback failed' : null),
    });
  },

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
    usePlayerStore.getState().setCardStatus('error', 'clip has no hls_playlist_url');
    return 'failed';
  }

  try {
    const player = getPlayer();
    player.replace({
      uri: url,
      headers: { 'X-EchoFlow-Media-Token': token },
    });
    player.play();
    // Reset the position for the new clip. NOT a claim that it is playing —
    // that arrives from the native listener. `replace()` and `play()` return
    // void and do not throw when the manifest 403s, so writing `playing` here
    // would assert success for a clip that is silent, and on iOS
    // `currentStatus()` hardcodes `error: nil` so nothing would ever correct
    // it. The card would read "Now playing" for ever with no spinner and no
    // error.
    usePlayerStore.setState({
      cardStatus: 'idle',
      playingClipId: clip.id,
      error: null,
      currentTime: 0,
      // Duration is only known once the source reports it; `duration_ms` from
      // the feed is not the same thing (it is the backend's own measure) and
      // using it here would make the scrubber jump.
      duration: 0,
    });
    return 'loaded';
  } catch (err) {
    usePlayerStore
      .getState()
      .setCardStatus('error', err instanceof Error ? err.message : 'playback failed');
    return 'failed';
  }
}

export function pause(): void {
  // Must not create a player: after `releasePlayer()` this would resurrect a
  // native AVPlayer/ExoPlayer with no source just to pause nothing.
  getPlayerOrNull()?.pause();
  usePlayerStore.setState({ playback: 'paused' });
}

export function resume(): void {
  getPlayerOrNull()?.play();
  usePlayerStore.setState({ playback: 'playing' });
}

/** `seconds` is expo-audio's unit. Callers converting from `duration_ms` use msToSeconds. */
export function seekToSeconds(seconds: number): void {
  void getPlayerOrNull()?.seekTo(seconds);
}
