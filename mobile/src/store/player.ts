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

const msToS = msToSeconds;
const sToMs = secondsToMs;

let instance: AudioPlayer | null = null;

/** The one player. Created on first call; `null` only before first use. */
export function getPlayer(): AudioPlayer {
  if (!instance) {
    instance = createAudioPlayer(null, { updateInterval: 500 } satisfies AudioPlayerOptions);
  }
  return instance;
}

/** Release the native player. Call from the root component's effect cleanup. */
export function releasePlayer(): void {
  instance?.remove();
  instance = null;
}

export type PlaybackStatus =
  | 'idle'
  | 'minting'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'processing'
  | 'unavailable'
  | 'gone'
  | 'error';

export type PlayerState = {
  queue: FeedClip[];
  activeIndex: number;
  /**
   * Monotonic guard against out-of-order loads. A `load()` bumps it; a load
   * that resolves with a stale generation is discarded. Without this a slow
   * load can resolve after a fast one and win, leaving the wrong clip playing
   * under the new card (plan §10 "Race guard").
   */
  loadGeneration: number;
  handsFree: boolean;
  status: PlaybackStatus;
  /** Null until a load succeeds; the id actually playing, not the requested one. */
  playingClipId: string | null;
  error: string | null;

  setQueue: (clips: FeedClip[]) => void;
  setActiveIndex: (index: number) => void;
  toggleHandsFree: () => void;
  setStatus: (status: PlaybackStatus, error?: string | null) => void;
};

export const usePlayerStore = create<PlayerState>((set) => ({
  queue: [],
  activeIndex: 0,
  loadGeneration: 0,
  handsFree: true,
  status: 'idle',
  playingClipId: null,
  error: null,

  setQueue: (clips) => set({ queue: clips }),
  setActiveIndex: (index) => set({ activeIndex: index, loadGeneration: usePlayerStore.getState().loadGeneration + 1 }),
  toggleHandsFree: () => set((s) => ({ handsFree: !s.handsFree })),
  setStatus: (status, error = null) => set({ status, error }),
}));

/** The current generation, for callers that need to stamp a load. */
export function currentGeneration(): number {
  return usePlayerStore.getState().loadGeneration;
}

export type LoadResult = 'loaded' | 'stale' | 'failed';

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
 * `generation` is captured BEFORE the await so a superseded load can detect it
 * has been overtaken. `replace()` is synchronous, but `play()` and the
 * subsequent load-completion handling are not, and the token mint that precedes
 * this call is where the real await is.
 */
export async function loadClip(
  clip: FeedClip,
  token: string,
  generation: number,
): Promise<LoadResult> {
  const url = clip.hls_playlist_url;
  if (!url) {
    usePlayerStore.getState().setStatus('error', 'clip has no hls_playlist_url');
    return 'failed';
  }

  // A newer load started while this one was in flight → this is stale.
  if (generation !== currentGeneration()) return 'stale';

  usePlayerStore.getState().setStatus('loading');

  try {
    const player = getPlayer();
    // NOTE: replace()/play() return VOID in expo-audio (they were Promises in
    // expo-av). Awaiting them would be a no-op at best.
    player.replace({
      uri: url,
      headers: { 'X-EchoFlow-Media-Token': token },
    });
    player.play();

    if (generation !== currentGeneration()) return 'stale';
    usePlayerStore.getState().setStatus('playing');
    usePlayerStore.setState({ playingClipId: clip.id });
    return 'loaded';
  } catch (err) {
    if (generation !== currentGeneration()) return 'stale';
    usePlayerStore.getState().setStatus('error', err instanceof Error ? err.message : 'playback failed');
    return 'failed';
  }
}

export function pause(): void {
  getPlayer().pause();
  const s = usePlayerStore.getState();
  if (s.status === 'playing') s.setStatus('paused');
}

export function resume(): void {
  getPlayer().play();
  usePlayerStore.getState().setStatus('playing');
}

/** `seconds` is expo-audio's unit. Callers converting from `duration_ms` use msToSeconds. */
export function seekToSeconds(seconds: number): void {
  void getPlayer().seekTo(seconds);
}

export { msToS, sToMs };
