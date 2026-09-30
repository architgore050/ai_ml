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
 * ## `release()`, NOT `remove()` — do not "simplify" this back
 * `AudioPlayer` extends `SharedObject<AudioEvents>`
 * (`expo-audio/build/AudioModule.types.d.ts:24`), and the two methods look
 * interchangeable from JS. They are not:
 *
 *  - `remove()` is a **one-line dictionary delete**, not a teardown. iOS:
 *    `ios/AudioModule.swift:251-253` → `self.registry.remove(player)` →
 *    `players.removeValue(forKey:)`; Android: `AudioModule.kt:544-546` →
 *    `players.remove(player.id)`. Neither path calls `teardownPlayer()`, so the
 *    periodic time observer is never unregistered, the `AVPlayer`/ExoPlayer is
 *    never released, and the lock screen is never cleared.
 *  - `release()` (declared on the `SharedObject` base,
 *    `expo-modules-core/src/ts-declarations/SharedObject.ts:22`) is the real
 *    teardown. iOS `sharedObjectWillRelease()`
 *    (`ios/AudioPlayer.swift:506-518`) does all of the above; Android
 *    `sharedObjectDidRelease()` → `releasePlayer()` (`AudioPlayer.kt:274-286`)
 *    releases the ExoPlayer, the MediaSession and the visualizer.
 *
 * The failure mode of using `remove()` is silent and expensive: the store
 * nulls `instance` and resets to `playback: 'idle'`, while the native player
 * **keeps playing and keeps pushing status events** into a store that claims
 * nothing is playing. The next `getPlayer()` then constructs a SECOND native
 * player, and two are now alive.
 *
 * ## Ordering, because `release()` is TERMINAL
 * After `release()` the JS and native objects are detached, and any subsequent
 * native call on that object throws `InvalidSharedObjectIdException`
 * (`expo-modules-core/android/.../SharedObjectRegistry.kt:87-98` zeroes the
 * id and `toNativeObject` throws on the lookup). So `release()` must be the
 * last thing that touches the instance, and the `instance === null` guard
 * matters: calling it twice would be the terminal call on a dead object.
 *
 * The slot is nulled BEFORE the native call so a re-entrant `getPlayer()`
 * during `release()` cannot hand out an object that is about to be detached.
 *
 * The reset is in a `finally` because it is the part that must not be skipped.
 * `release()` is a far bigger native operation than `remove()` was — Android's
 * `releasePlayer()` releases the ExoPlayer, the MediaSession and the
 * visualizer and unbinds the playback service (`AudioPlayer.kt:279-286`) — so
 * it has real ways to throw where the old dictionary-delete could not. If it
 * throws and the store reset is skipped, we are strictly worse off than the bug
 * this function exists to prevent: the store keeps asserting `playback:
 * 'playing'` for a player that is gone, and because no dependency changes, no
 * load is ever re-triggered. Nothing after the `finally` touches `dying`, so
 * this does not weaken the terminal-call rule.
 *
 * ## Clearing the store is not optional
 * The effect body creates nothing, so its cleanup can fire at any time relative
 * to the component that actually uses the player — and reachable today on any
 * Fast Refresh of `_layout.tsx`. Without the reset the store keeps
 * `status: 'playing'` and `playingClipId` for a player that no longer exists,
 * and since no dependency changes, **no load is ever re-triggered**: playback
 * is dead behind a "Now playing" card. The reset is outside the `instance ===
 * null` guard on purpose: `releasePlayer()` is a public cleanup entry point,
 * and "no player to release" is not a reason to leave the store asserting
 * otherwise.
 */
export function releasePlayer(): void {
  const dying = instance;
  instance = null;
  try {
    if (dying) {
      // TERMINAL. Nothing after this line may touch `dying`.
      dying.release();
    }
  } finally {
    usePlayerStore.getState().reset();
  }
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
 *
 * ## `ended` is LATCHED by the store, and it has to be
 * `didJustFinish` is a **single-event pulse** on both native platforms, not a
 * flag that stays true: `ios/AudioPlayer.swift:146` hardcodes
 * `"didJustFinish": false` in `currentStatus()` and only the end-notification
 * override sets it true (`ios/AudioPlayer.swift:467`); Android does the same
 * (`AudioPlayer.kt:211` hardcodes it false, and `justFinished` in
 * `BaseAudioPlayer.kt:99-102` is only true for the one callback that
 * transitions *into* `STATE_ENDED`). Web is the outlier and latches
 * incidentally, because `HTMLMediaElement.ended` is a sticky property
 * (`src/AudioUtils.web.ts:70`).
 *
 * So an un-latched store would show `ended` for one 500 ms tick and then fall
 * back to `paused` on the next one — which silently breaks both the
 * auto-advance and the `progress >= 0.99` pacing rule, because neither would
 * ever observe the state it keys on. `syncFromPlayer` therefore latches it in
 * `endedForClipId`; see that field.
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
  /**
   * The clip whose native `didJustFinish` pulse we have already consumed, or
   * null. This is the `ended` LATCH — see `PlaybackState`.
   *
   * It holds a clip id rather than a boolean so the latch is scoped: it clears
   * when `playingClipId` changes (a new `loadClip`) instead of needing a
   * separate "someone pressed stop" reset path, which nothing would remember
   * to call.
   */
  endedForClipId: string | null;
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

/**
 * Defend the two numbers every consumer of this store depends on.
 *
 * Both bad values are produced by expo-audio itself, not by a caller bug, so
 * the coercion has to live in the store rather than in the view that happens to
 * read the value first — otherwise each new consumer re-implements it, or
 * forgets to.
 *
 *  - **Non-finite `currentTime`.** iOS guards the *property*
 *    (`ios/AudioPlayer.swift:62-70`: `seconds.isNaN ? 0.0 : seconds`) but the
 *    periodic time observer merges the raw observer value into the event with
 *    no such guard (`ios/AudioPlayer.swift:482-488`,
 *    `"currentTime": time.seconds`). A `NaN` there reaches the store. It is an
 *    invalid React Native style value for the progress width, and it silently
 *    poisons completion telemetry (`currentTime / duration`), which is a
 *    recommender input.
 *  - **Out-of-range `currentTime`.** On a `DISCONTINUITY_REASON_SEEK` Android
 *    emits the raw, unclamped position
 *    (`android/.../BaseAudioPlayer.kt:114-122`,
 *    `"currentTime" to (newPosition.positionMs / 1000.0)`). Seek to
 *    `duration + 10` and `currentTime = duration + 10` lands in the store.
 *
 * Rules, in order: non-finite → 0; then, when `duration > 0`, clamp
 * `currentTime` into `[0, duration]`. When `duration` is 0 the clip is not
 * reporting a length yet (or is a live stream), so there is no upper bound to
 * enforce and `currentTime` passes through.
 */
export function coerceNativeTimes(
  currentTime: number,
  duration: number,
): { currentTime: number; duration: number } {
  const safeDuration = Number.isFinite(duration) ? duration : 0;
  const safeCurrent = Number.isFinite(currentTime) ? currentTime : 0;
  return {
    currentTime: safeDuration > 0 ? Math.min(Math.max(safeCurrent, 0), safeDuration) : safeCurrent,
    duration: safeDuration,
  };
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
  | 'endedForClipId'
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
  endedForClipId: null,
  error: null,
};

export const usePlayerStore = create<PlayerState>((set) => ({
  ...INITIAL,

  setQueue: (clips) => set({ queue: clips }),
  setActiveIndex: (index) => set({ activeIndex: index }),
  toggleHandsFree: () => set((s) => ({ handsFree: !s.handsFree })),
  setCardStatus: (cardStatus, error = null) => set({ cardStatus, error }),

  syncFromPlayer: (next) =>
    set((s) => {
      // FIX: the two numbers are coerced here, once, for every consumer.
      const { currentTime, duration } = coerceNativeTimes(next.currentTime, next.duration);

      // FIX 4: iOS reports `isBuffering: true` when there is no current item
      // (`ios/AudioUtils.swift:197-209` — the `isBuffering` extension returns
      // a bare `true` when `currentItem == nil`). Our player is constructed
      // with `source = null` (`getPlayer`), so on iOS that is true for the
      // entire pre-first-clip life, and because `isBuffering` outranks `playing`
      // in `playbackStateFrom` the whole app sits on a permanent spinner.
      // Android disagrees — `isBuffering` is literally
      // `playbackState == Player.STATE_BUFFERING` (`AudioPlayer.kt:198`), which
      // `STATE_IDLE` is not — so the same snapshot means different things per
      // platform.
      //
      // The predicate is the STORE's loaded clip, deliberately NOT the native
      // `isLoaded`. That distinction is load-bearing and was got wrong first
      // time: `isLoaded` is `currentItem?.status == .readyToPlay` on iOS
      // (`ios/AudioPlayer.swift:86-88`) but `playbackState == STATE_READY` on
      // Android (`AudioPlayer.kt:197`, with `STATE_ENDED` also true at :212).
      // A REAL stall has `isLoaded: true` on iOS and `isLoaded: false` on
      // Android — so gating buffering on `isLoaded` would hide exactly the
      // spinner Android needs, while still not being the right question to ask
      // on either platform. `playingClipId` is the one signal that means the
      // same thing everywhere: we have loaded a clip, so a buffering flag
      // refers to real media rather than to the absence of any.
      //
      // This is done HERE rather than in `playbackStateFrom` so that function
      // stays a pure, independently-tested mapping of the snapshot it is
      // given; sanitising the snapshot keeps the platform quirk out of it.
      const sanitized: NativeStatusSnapshot = {
        ...next,
        currentTime,
        duration,
        isBuffering: s.playingClipId !== null && next.isBuffering,
      };
      const derived = playbackStateFrom(sanitized);

      // FIX 3: latch `ended` for as long as this clip is the one loaded.
      // `didJustFinish` is one tick wide (see `PlaybackState`), so without the
      // latch the 500 ms re-sync in `PlayerHost` turns `ended` into `paused`
      // and the auto-advance / `progress >= 0.99` pacing rule never fires.
      // A latch is only meaningful against a clip, so it is not armed unless
      // something is actually loaded. An error still wins, matching
      // `playbackStateFrom`'s "error must win outright" rule.
      const armed = next.didJustFinish && s.playingClipId !== null;
      const endedForClipId = armed ? s.playingClipId : s.endedForClipId;
      const latched = endedForClipId !== null && endedForClipId === s.playingClipId;
      const playback: PlaybackState = latched && derived !== 'error' ? 'ended' : derived;

      return {
        playback,
        currentTime,
        duration,
        endedForClipId,
        // A native error is the only thing that writes `error` from this side.
        // Card-level errors come from `setCardStatus`.
        error: next.error ?? (playback === 'error' ? 'Playback failed' : null),
      };
    }),

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
    // error. `'idle'` is the same claim in the other direction: the new source
    // has not reported anything yet.
    usePlayerStore.setState({
      cardStatus: 'idle',
      playback: 'idle',
      playingClipId: clip.id,
      // Disarm the `ended` latch, or the previous clip's completion would
      // follow the user to the next one (see `endedForClipId`).
      endedForClipId: null,
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

/**
 * Clamp a requested seek position into `[0, duration]`, or `null` when there
 * is nothing to seek within.
 *
 * **No platform clamps for us.** iOS builds the `CMTime` from whatever it is
 * given — `ios/AudioPlayer.swift:179-198`, so a `-10 s` at `t=3` becomes
 * `CMTime(seconds: -7.0)`. Android is `player.seekTo((seconds * 1000L).toLong())`
 * (`android/.../Playable.kt:31`). Web assigns `media.currentTime = seconds`
 * (`src/AudioPlayer.web.ts:169-175`). Worse than an out-of-range position: on
 * Android a seek issued while the player is still `STATE_IDLE` is *stored* by
 * ExoPlayer and applied to the NEXT item, so an unclamped skip pressed before
 * the first clip silently repositions the clip after it.
 *
 * `duration === 0` is the "nothing loaded" signal: the store only reports a
 * duration once the source has (`loadClip` deliberately starts it at 0 rather
 * than trusting the feed's `duration_ms`). Returning `null` there means
 * "refuse" rather than "seek to 0", so a skip button pressed on an
 * un-loaded player does not queue a position for the next clip.
 *
 * This is the ONE place the clamp lives — `skipBy` and any future scrubber
 * must go through it rather than re-deriving the bounds.
 */
export function clampSeekTime(
  requested: number,
  duration: number,
): number | null {
  if (!Number.isFinite(requested) || !Number.isFinite(duration)) return null;
  if (duration <= 0) return null;
  return Math.min(Math.max(requested, 0), duration);
}

/**
 * `seconds` is expo-audio's unit. Callers converting from `duration_ms` use msToSeconds.
 *
 * ## UNCLAMPED — prefer `skipBy`, or `clampSeekTime` for absolute seeks
 * This passes the value straight to native, which clamps on no platform (see
 * `clampSeekTime` for the citations). It is kept as the raw primitive because
 * a scrubber legitimately wants absolute positioning, but it has **no
 * production callers** as of 2026-09-30 (grepped: `src/`, `app/`), so a new
 * caller should be `skipBy()` or should clamp first.
 */
export function seekToSeconds(seconds: number): void {
  void getPlayerOrNull()?.seekTo(seconds);
}

/**
 * Move playback by `deltaSeconds` — the ±10 s skip button.
 *
 * Reads the store, clamps through `clampSeekTime`, and only then calls native.
 * It deliberately does **not** write `currentTime` optimistically: a seek
 * emits a status update on all three platforms
 * (`ios/AudioPlayer.swift:189-194`, `BaseAudioPlayer.kt:119-121`), so the next
 * tick corrects the store within one `updateInterval`. An optimistic write would
 * be a second source of truth that can disagree with native.
 *
 * @returns the position actually seeked to, or `null` if the seek was refused
 *   (nothing loaded, or a non-finite input).
 */
export function skipBy(deltaSeconds: number): number | null {
  const { currentTime, duration } = usePlayerStore.getState();
  const target = clampSeekTime(currentTime + deltaSeconds, duration);
  if (target === null) return null;
  getPlayerOrNull()?.seekTo(target);
  return target;
}
