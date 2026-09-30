import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { gradients, duration as motionDuration, surface, accent } from '../../design/tokens';
import { glow } from '../../design/shadows';
import { categoryColor } from '../../design/categories';
import { MIN_TOUCH_TARGET } from '../ui/primitives';
import { formatTime } from '../../lib/formatTime';
import { SKIP_SECONDS } from '../../lib/skipSeconds';
import {
  clampSeekTime,
  seekToSeconds,
  skipBy,
  usePlayerStore,
} from '../../store/player';

/**
 * Seekable progress bar.
 *
 * ## Provenance
 * `frontend/sample_frontend2/src/components/audio/WaveformBar.tsx` at commit
 * `20451d3` — the only surviving copy of that directory. Tracked from it:
 *
 *   WaveformBar.tsx:26-31  track — `height: 4`, `borderRadius: 2`,
 *                        `background: var(--surface-container)`, `overflow: hidden`
 *   WaveformBar.tsx:33-38  fill — `linear-gradient(90deg, ${c}, var(--terracotta))`,
 *                        `borderRadius: 2`, `transition: width 0.1s linear`,
 *                        `boxShadow: isPlaying ? '0 0 6px var(--accent-glow)' : 'none'`
 *
 * The source ALSO renders a `buffered` layer (WaveformBar.tsx:32). **It is
 * deliberately not ported** — owner decision. `expo-audio` exposes no buffered
 * range at all (there is no `buffered` on `AudioStatus`), so porting it would
 * mean inventing a source for the number. It is not built, stubbed, or
 * approximated here.
 *
 * ## UNITS: SECONDS, AND ONLY SECONDS
 * `usePlayerStore.duration` / `.currentTime` are expo-audio SECONDS, and the
 * store is the single choke point for that conversion (see `store/player.ts`
 * §UNITS). The feed's `duration_ms` is a *different measure of the same clip*
 * and is never read here: `loadClip` starts `duration` at 0 and only the
 * source's own report fills it in. Using `duration_ms` would make the bar
 * disagree with the audio it is drawing.
 *
 * Four native facts shape every guard below (all verified against the
 * installed `expo-audio`, not recalled):
 *
 *  1. `duration` is **0 until the source reports it** — iOS gates twice
 *     (`ios/AudioPlayer.swift:57-60` and again at `:134`), Android likewise
 *     (`AudioPlayer.kt` / `Playable.kt:23`). `currentTime / duration` is then
 *     `0 / 0` = `NaN`, and **a `NaN` width is an invalid React Native style
 *     value**, not a zero: the whole fill style is dropped. So progress is
 *     never computed unguarded, and at `duration === 0` the control is also
 *     non-interactive — which is a correctness fix, not padding, because on
 *     Android a seek issued while nothing is loaded is *stored* and applied to
 *     the NEXT clip (`Playable.kt:31`).
 *  2. `currentTime` can EXCEED `duration` — Android emits the raw unclamped
 *     seek target (`BaseAudioPlayer.kt:114-122`) — so displayed progress is
 *     clamped into `[0, 1]`.
 *  3. `currentTime` can be `NaN` — iOS merges an unguarded `time.seconds` into
 *     the event (`ios/AudioPlayer.swift:482-488`). The store coerces it, but a
 *     scrubber that would render `NaN` should not lean on that.
 *  4. `updateInterval` stays at **500 ms** (`store/player.ts::getPlayer`).
 *     The iOS periodic time observer is never unregistered
 *     (`ios/AudioPlayer.swift:474-491`, removed only in teardown), so at
 *     100 ms it would be a permanent 10 Hz JS-bridge + re-render loop for the
 *     life of the app. Smoothness is bought by *interpolating* between the
 *     500 ms samples instead — see `SAMPLE_INTERVAL_MS`.
 *
 * A seek emits an IMMEDIATE status update on every platform
 * (`ios/AudioPlayer.swift:189-194`, `BaseAudioPlayer.kt:119-121`), so the
 * response to a drag commit needs no faster sampling.
 */

/* ------------------------------------------------------------------ */
/* Pure geometry + arithmetic. Exported so the tests can pin them.       */
/* ------------------------------------------------------------------ */

/** WaveformBar.tsx:27 `height: 4`. The visual bar, not the touch target. */
export const TRACK_HEIGHT = 4;
/** WaveformBar.tsx:27 `borderRadius: 2`. */
export const TRACK_RADIUS = 2;

/**
 * The store's sampling cadence (`updateInterval`, `store/player.ts`). While
 * playing, the fill sweeps across this whole gap so it moves continuously at
 * the audio's average rate instead of stepping twice a second.
 */
export const SAMPLE_INTERVAL_MS = 500;

/**
 * WaveformBar.tsx:37 `transition: width 0.1s linear`, kept verbatim.
 *
 * LINEAR, not a spring, and that is load-bearing twice over. The source chose
 * linear because the fill has to *track audio* — an eased or springy fill lags
 * a constant-rate signal permanently. And a spring overshoots its target: the
 * target here is a fraction of the track, so an overshoot is a width past
 * 100% — a visible bug that paints outside the bar.
 */
export const FILL_EASING = Easing.linear;

/**
 * `Easing.inOut(Easing.ease)` — `withTiming`'s DEFAULT — passes t = 0 and
 * t = 1 exactly, so the endpoints of an animation cannot tell linear from
 * non-linear. These are the interior stops the test checks instead.
 */
export const FILL_EASING_STOPS: readonly number[] = [0.25, 0.5, 0.75];

/**
 * Movement past which a gesture is treated as a drag rather than a tap.
 * Below it the release position is the seek position anyway, so this only
 * decides whether a drag was in progress, not where it lands.
 */
const MIN_DRAG_SLOP = 3;

/**
 * Directional slop, in dp: how far the finger must travel before its DIRECTION
 * is treated as intent rather than as jitter.
 *
 * Two different questions, deliberately two different numbers:
 *  - `MIN_DRAG_SLOP` (3) asks "has the finger visibly moved sideways?", and
 *    gates the drag preview. Small, because a preview that lags the finger
 *    feels broken.
 *  - `DIRECTION_SLOP` (8) asks "is this a horizontal scrub or a page flick?",
 *    and gates the two claims that can steal the feed's scroll. Larger,
 *    because the cost of guessing wrong is asymmetric: claiming a vertical
 *    drag as a scrub is a dead feed, while waiting 8 dp to start previewing a
 *    horizontal scrub is a 16 ms delay nobody can perceive.
 *
 * 8 dp is the same figure RNGH's own directional API is conventionally driven
 * at (`activeOffsetX([-8, 8])`), so this threshold and that one are directly
 * comparable rather than two invented numbers.
 */
export const DIRECTION_SLOP = 8;

/** Which way a touch has committed to going. See `resolveAxis`. */
export type Axis = 'none' | 'horizontal' | 'vertical';

/**
 * Resolve a touch's intent from its accumulated displacement.
 *
 * `none` (inside the slop on both axes) is deliberately the answer for
 * undecided movement and for a non-finite input: it is the only value that
 * claims nothing and blocks nothing, so every failure mode of this function
 * lands on the safe side — the feed keeps its scroll and the bar does not seek.
 *
 * `ax > ay` is a 45-degree cone, kept because it is the rule the component has
 * always used for the horizontal lock (`onMoveShouldSetPanResponder`) and
 * because a tighter ratio would be a second, independently-tuned number with
 * nothing to justify it. The tie (`ax === ay`, i.e. a perfect diagonal) resolves
 * to `vertical`, which is the conservative answer: a diagonal in a vertically
 * paging feed is far more often a page flick than a scrub.
 */
export function resolveAxis(dx: number, dy: number, slop: number = DIRECTION_SLOP): Axis {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(slop)) return 'none';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax <= slop && ay <= slop) return 'none';
  return ax > ay ? 'horizontal' : 'vertical';
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Played fraction of the clip, in `[0, 1]`.
 *
 * Returns 0 for every unusable input rather than throwing: a `0`-duration clip
 * (fact 1), a `NaN` time (fact 3), or a non-finite value. The alternative —
 * `currentTime / duration` — yields `NaN` for `0 / 0`, which is not a renderable
 * width.
 */
export function progressFraction(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) return 0;
  if (duration <= 0) return 0;
  return clamp01(currentTime / duration);
}

/**
 * A touch's x-position within the bar, as a fraction of its width, clamped to
 * `[0, 1]`.
 *
 * `locationX` is the direct analogue of the source's `(e.clientX - r.left) /
 * r.width` (WaveformBar.tsx:24): React Native computes it as the touch's
 * `pageX` minus the offset of the node the touch sequence *started* on
 * (`ReactNativeEventEmitter::computeChildOffset`), and that node does not
 * change for the life of the sequence. So dragging past either end of the bar
 * produces a `locationX` outside `[0, width]` and the clamp is what turns
 * "finger is off the end" into "seek to the end" — exactly what the source's
 * own clamp does.
 *
 * `measureInWindow` + `pageX` is the other option and was rejected: it is
 * asynchronous, and an async read inside `onPanResponderGrant`/`Move` is a
 * correctness hazard (the first move events arrive before the callback does).
 *
 * `null` means "the geometry is not known yet" — no `onLayout` has landed, so
 * the width is 0 and there is no honest fraction to derive. Refusing is the
 * only safe answer; dividing by it would be `Infinity` or `NaN`.
 */
export function fractionFromLocation(locationX: number, width: number): number | null {
  if (!Number.isFinite(locationX) || !Number.isFinite(width) || width <= 0) return null;
  return clamp01(locationX / width);
}

/**
 * Where a touch at `locationX` should seek to, in expo-audio SECONDS, or `null`
 * when the seek must not happen at all.
 *
 * The fraction is clamped first and the seconds second, and the seconds go
 * through `clampSeekTime` — the ONE place the bounds live. Its `null` means
 * "refuse", not "seek to 0", so that answer is propagated instead of being
 * turned into a seek: seeking to 0 on an un-loaded Android player would queue a
 * position for the *next* clip.
 */
export function seekTargetFor(
  locationX: number,
  width: number,
  duration: number,
): number | null {
  const fraction = fractionFromLocation(locationX, width);
  if (fraction === null) return null;
  return clampSeekTime(fraction * duration, duration);
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

/** What a committed (or refused) tap/drag reported. `null` target = refused. */
export type SeekResult = { requested: number; target: number } | null;

export type SeekProgressBarProps = {
  /** The clip this bar belongs to. Captured at gesture start. */
  clipId: string;
  /** Per-clip category; `gradients.progressFill`'s leading stop. */
  category?: string | null;
  /** Clip title, for the accessibility label. */
  title?: string;
  /**
   * Observability seam for the parent's own store / analytics. Called with the
   * target actually committed, or `null` when the seek was refused. Default
   * no-op, so callers are optional — and this bar never needs one, because the
   * player store already mirrors native status every tick (`PlayerHost`).
   */
  onSeekResult?: (result: SeekResult) => void;
};

type Gesture = {
  /** `clipId` prop at grant. */
  clipId: string;
  /** Store's `playingClipId` at grant — the loaded clip, not the requested one. */
  playingClipId: string | null;
  /** Store's `duration` at grant, so the whole gesture uses one denominator. */
  duration: number;
  /**
   * Fraction under the finger. Kept for the record even though the release path
   * re-derives the fraction from the release event's own `locationX` — a tap and
   * the end of a drag must not be able to disagree about where they landed.
   */
  fraction: number;
};

export function SeekProgressBar({
  clipId,
  category,
  title,
  onSeekResult,
}: SeekProgressBarProps) {
  const duration = usePlayerStore((s) => s.duration);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const playback = usePlayerStore((s) => s.playback);
  const playingClipId = usePlayerStore((s) => s.playingClipId);

  const color = categoryColor(category);

const widthRef = useRef(0);
const gestureRef = useRef<Gesture | null>(null);

/**
 * Whether a touch that began on this bar is still a CANDIDATE tap.
 *
 * `true` from `onTouchStart` until one of three things happens: a horizontal
 * scrub claims the responder, the finger resolves as vertical, or the sequence
 * is cancelled. See `onTouchStart` / `onTouchEnd` for why the tap lives on the
 * direct touch channel rather than on the responder.
 */
const tapPendingRef = useRef(false);

  /**
   * Latest `clipId`, kept current during RENDER rather than in an effect.
   *
   * An effect would land one commit late, which is exactly the window where a
   * mid-drag clip swap would be missed: the release would compare against the
   * previous clip's id and commit a seek for a clip the user has left.
   */
  const clipIdRef = useRef(clipId);
  clipIdRef.current = clipId;

  // ---- animated fill -------------------------------------------------
  const fill = useSharedValue(0);
  const drag = useSharedValue(0);
  const isDragging = useSharedValue(false);

  const target = progressFraction(currentTime, duration);
  const interactive = Number.isFinite(duration) && duration > 0;

  // Drive the fill from the store tick. See SAMPLE_INTERVAL_MS for why the
  // duration differs by playback state.
  useEffect(() => {
    if (!interactive) {
      cancelAnimation(fill);
      fill.value = 0;
      return;
    }
    fill.value = withTiming(target, {
      // Playing: sweep across the whole 500 ms sampling gap, so each new tick
      // restarts from where the previous one arrived and the motion is
      // continuous at the audio's average rate rather than 2 discrete steps per
      // second. Paused / ended / buffering: the source's own 100 ms linear
      // `width` transition, which is the right length for a single discrete
      // change (a seek, a resume) and must not turn into a 500 ms drift.
      duration: playback === 'playing' ? SAMPLE_INTERVAL_MS : motionDuration.progressFill,
      easing: FILL_EASING,
    });
  }, [fill, target, interactive, playback]);

  /**
   * Put the fill back where the store says it is.
   *
   * Needed after a drag that did not commit — released with nothing loaded, or
   * abandoned because the clip changed. Without it the fill would stay pinned
   * under the finger until the next store tick re-ran the effect above, and
   * that tick may be 500 ms away.
   */
  const restoreFromStore = useCallback(() => {
    cancelAnimation(fill);
    const s = usePlayerStore.getState();
    fill.value = progressFraction(s.currentTime, s.duration);
  }, [fill]);

  /**
   * Whether `gesture` may still commit a seek. Takes the gesture as an argument
   * rather than reading the ref: `finishGesture` clears the ref BEFORE asking,
   * and a reader reaching back into `gestureRef.current` would then always be
   * told "abandoned" — i.e. every seek would silently become a no-op while the
   * guard looked like it was doing its job.
   *
   * This is a CLIP-IDENTITY check and nothing else. Both identities are
   * compared because they fail differently:
   *  - `playingClipId` (store) is the clip NATIVE actually has loaded, read live
   *    via `getState()` — so a swap is caught even on a frame where the parent
   *    has not re-rendered yet, which is the window a drag falls into.
   *  - `clipId` (prop) is the clip this BAR belongs to, so a bar momentarily
   *    showing another clip's duration cannot seek it.
   *
   * DELIBERATELY NOT A `playback === 'ended'` VETO. Cancelling the in-flight
   * drag when the clip ends is required (see the effect below); refusing *new*
   * gestures would be a different and much worse rule, because `ended` is
   * LATCHED for as long as the clip stays loaded — a veto would leave the
   * scrubber permanently dead on any clip that ran to the end, which is exactly
   * when a user most wants to drag back and replay it.
   */
  const stillCurrent = useCallback((gesture: Gesture): boolean => {
    const s = usePlayerStore.getState();
    return s.playingClipId === gesture.playingClipId && clipIdRef.current === gesture.clipId;
  }, []);

  /**
   * Give the gesture up WITHOUT reporting a seek.
   *
   * Distinct from `finishGesture(null)`, and the distinction is load-bearing:
   * that one means "attempted, and the bar had no geometry", which is a real
   * refusal the parent is entitled to hear about. This one means "this was
   * never a seek attempt" — the feed took the touch, or the finger turned out
   * to be going vertically. Reporting `onSeekResult(null)` for those would
   * emit a "seek refused" for every flick that crossed the bar, which is the
   * majority of scrolls in a full-bleed feed.
   */
  const abandonGesture = useCallback(() => {
    gestureRef.current = null;
    isDragging.value = false;
    restoreFromStore();
  }, [isDragging, restoreFromStore]);

  /**
   * End the gesture. `fraction === null` means the release position was not
   * resolvable (no geometry yet) — an ATTEMPTED seek that could not be made,
   * as distinct from an ABANDONED gesture.
   */
  const finishGesture = useCallback(
    (fraction: number | null) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      isDragging.value = false;
      // Nothing in flight: not a seek attempt, so nothing to report.
      if (gesture === null) return;
      // Swapped or re-rendered out from under the finger. Also not an attempt.
      if (!stillCurrent(gesture)) {
        restoreFromStore();
        return;
      }
      // Attempted, but the bar has not been laid out, so there is no honest
      // fraction. Reported as a refusal because that is what it is.
      if (fraction === null) {
        onSeekResult?.(null);
        restoreFromStore();
        return;
      }

      const requested = fraction * gesture.duration;
      // `clampSeekTime` is the only place the seek bounds live. `null` means
      // REFUSE, and it must not become "seek to 0": on Android a seek issued
      // while the player is idle is stored and applied to the NEXT clip.
      const clamped = clampSeekTime(requested, gesture.duration);
      if (clamped === null) {
        onSeekResult?.(null);
        restoreFromStore();
        return;
      }

      seekToSeconds(clamped);
      // Reported AFTER the native call, so a throwing observer cannot stop the
      // seek it is only observing.
      onSeekResult?.({ requested, target: clamped });
      // Land the fill ON the committed position instead of easing to it: a seek
      // already emits an immediate status update, and the drag preview is where
      // the user's finger is. Anything else reads as the bar sliding back.
      fill.value = clamp01(fraction);
    },
    [fill, isDragging, onSeekResult, restoreFromStore, stillCurrent],
  );

  /**
   * Open a gesture at `locationX`, capturing the clip identity.
   *
   * The ONE place a `Gesture` is built, shared by both entry points (a granted
   * horizontal scrub, and a stationary tap) so the two cannot drift on which
   * clip they captured or on how the fill previews.
   */
  const beginGesture = useCallback(
    (locationX: number) => {
      const s = usePlayerStore.getState();
      const fraction = fractionFromLocation(locationX, widthRef.current);
      gestureRef.current = {
        clipId: clipIdRef.current,
        playingClipId: s.playingClipId,
        duration: s.duration,
        // No geometry yet (no `onLayout`) is still a valid start: a tap that
        // commits nothing is better than a bar that swallows the gesture.
        fraction: fraction ?? 0,
      };
      isDragging.value = true;
      if (fraction !== null) drag.value = fraction;
    },
    [drag, isDragging],
  );

  /**
   * Close a gesture at `locationX`, committing exactly one seek.
   *
   * Also the one place a commit happens, so a tap and the end of a drag cannot
   * disagree about where they landed: the position is always re-derived from the
   * event that ENDED the sequence, never from the last previewed value.
   */
  const commitGesture = useCallback(
    (locationX: number) => {
      const gesture = gestureRef.current;
      const fraction = fractionFromLocation(locationX, widthRef.current);
      if (gesture !== null && fraction !== null) {
        gesture.fraction = fraction;
        drag.value = fraction;
      }
      finishGesture(fraction);
    },
    [drag, finishGesture],
  );

  /**
   * Cancel a drag in flight — the clip ended, or it was swapped out.
   *
   * `didJustFinish` is a single-event pulse on both native platforms
   * (`ios/AudioPlayer.swift:146,467`, `BaseAudioPlayer.kt:99-102`) and the
   * store LATCHES it into `ended` for as long as the clip is loaded
   * (`player.ts` §`endedForClipId`), so this keys on the latch. Watching the
   * pulse instead would mean a render that only exists for one tick.
   */
  useEffect(() => {
    if (playback === 'ended' || playback === 'error') {
      if (gestureRef.current !== null) {
        gestureRef.current = null;
        isDragging.value = false;
        restoreFromStore();
      }
    }
  }, [playback, isDragging, restoreFromStore]);

  /**
   * PanResponder, not `react-native-gesture-handler` — a decision revisited for
   * this redesign, and the deciding reason is the TEST HARNESS, not the API.
   *
   * RNGH expresses this arbitration better and declaratively: a
   * `Gesture.Pan().activeOffsetX([-8, 8]).failOffsetY([-8, 8])` is genuinely NOT
   * ACTIVE until 8 dp of horizontal movement, so a vertical flick never
   * activates it at all and there is nothing to take back. It is not used here
   * because nothing in this repo can drive one, and this was checked rather than
   * assumed:
   *  - `@testing-library/react-native@14.0.1` exports no `fireGestureHandler`.
   *    Its public surface is `act, cleanup, fireEvent, render, waitFor,
   *    waitForElementToBeRemoved, within, configure, resetToDefaults,
   *    isHiddenFromAccessibility, isInaccessible, getDefaultNormalizer,
   *    renderHook, screen, userEvent` (`dist/pure.d.ts`), and no file in
   *    `dist/` mentions the symbol.
   *  - RNGH's OWN driver is importable — `react-native-gesture-handler/jest-utils`
   *    resolves to `lib/commonjs/jestUtils/index` — but it is a separate
   *    dependency, not something `fireEvent` hands you, so every test would have
   *    to be written in its vocabulary instead of RNTL's, and
   *    `Gesture.Pan()`'s `activeOffsetX` would be unit-tested while the
   *    composition with the feed's pager stayed untested.
   *  - `jest.setup.js` does not load `react-native-gesture-handler/jestSetup`, so
   *    `RNGestureHandlerModule` resolves to a TurboModule that does not exist
   *    under jest. (Whether hand-dispatched `handlerStateChange` events would
   *    reach a `GestureDetector` was NOT tested here — it is left as the open
   *    question it is, rather than asserted.)
   * So the seek would be tested in a different harness from the rest of the file,
   * and the arbitration is the one thing here that MUST be tested against this
   * repo's own. PanResponder it is; the rule below is PanResponder's own
   * vocabulary for the same intent.
   *
   * ## THE RULE: the bar claims a touch only once it is clearly HORIZONTAL
   *
   * `onStartShouldSetPanResponder` is `false`, always, and that is the entire
   * fix. The previous value (`() => interactive`) claimed the touch on
   * touch-down, before any movement existed, which is precisely the reported
   * symptom: a vertical flick starting anywhere in this 44 dp row — the natural
   * thumb position in a full-screen feed, about 8% of screen height — was
   * swallowed.
   *
   * WHY THAT WAS NOT FIXABLE FROM WHERE THE BAR STOOD. Once JS is the
   * responder, iOS takes the paging ScrollView's own pan recognizer out of the
   * picture, and that is driven by the responder itself, not by anything the
   * bar can revoke:
   *  - `RCTScrollView.m::_shouldDisableScrollInteraction` returns YES when the
   *    `RCTUIManager JSResponder` is a DESCENDANT of the scroll view, and
   *    `handleCustomPan:` then does `panGestureRecognizer.enabled = NO; ... = YES`
   *    to restart it disabled. The bar is a descendant, so any claim at all
   *    kills the pager.
   *  - `scrollView:touchesShouldCancelInContentView:` is written the same way —
   *    it skips `[super touchesShouldCancelInContentView:view]` exactly when
   *    `shouldDisableScrollInteraction`, so the pager explicitly refuses to
   *    cancel a touch inside this bar's subtree while JS holds it.
   *  - `onShouldBlockNativeResponder` cannot rescue it, and PanResponder's own
   *    doc comment in the installed `PanResponder.js:102` says why: "Is
   *    currently only supported on android." It is not consulted on iOS at all.
   *    (On Android it is meaningful — `JSResponderHandler.setJSResponder` only
   *    calls `requestDisallowInterceptTouchEvent(true)` on the ancestor when this
   *    returns true — which is why the old `() => false` looked like it worked.)
   * There is no JS API to hand the responder back mid-gesture, so a claim at
   * touch-down is unrecoverable on the platform this app ships on. The only
   * place the decision can be made correctly is BEFORE the claim: on movement.
   *
   * ## WHY THE TAP STILL WORKS
   *
   * A stationary tap produces no move event, so it can never reach
   * `onMoveShouldSetPanResponder`, and with no claim there is no
   * `onPanResponderRelease` to commit from. The tap therefore rides the DIRECT
   * touch channel — `onTouchStart` / `onTouchEnd` / `onTouchCancel` — which is
   * a different mechanism from the responder negotiation entirely
   * (`BaseViewConfig.ios.js:406-410` groups them separately, under "Touch
   * events"). It is delivered to the node the sequence STARTED on, whether or
   * not that node is the responder, which is what makes it usable precisely
   * because the bar is no longer the responder for a tap. Three properties make
   * it safe rather than a second, competing seek path:
   *  1. It arms on touch-down and commits on touch-end ONLY if still armed, and
   *     the arming is revoked by the same two things that revoke a scrub: a
   *     horizontal claim (`onPanResponderGrant`) and a vertical resolve
   *     (`onMoveShouldSetPanResponder`). So a page flick that happens to END on
   *     the bar seeks nothing, and a horizontal scrub cannot be double-committed
   *     whichever of the two events the platform delivers first.
   *  2. It is the platform's own cancellation signal that disarms it. A vertical
   *     flick inside a UIScrollView ends in `touchesCancelled` →
   *     `touchCancel` (`RCTTouchHandler.m:320-323`), not `touchEnd`, so the arm
   *     is dropped by the same mechanism that hands the touch to the pager.
   *  3. It commits through `beginGesture` / `commitGesture` — the SAME two
   *     functions a granted scrub uses — so the clip-identity guard, the
   *     `clampSeekTime` refusal and the single-commit guarantee are literally
   *     the same code, not a parallel copy that can drift.
   *
   * ## THE ARBITRATION, in PanResponder's own vocabulary
   *  - `onStartShouldSetPanResponder` → `false`. Never claim at touch-down.
   *  - `onMoveShouldSetPanResponder` → claim iff `resolveAxis(dx, dy)` is
   *    `'horizontal'`; a `'vertical'` resolve additionally abandons, which is
   *    the earliest possible moment to drop a pending tap.
   *  - `onShouldBlockNativeResponder` → `interactive`. Reached only from
   *    `onResponderGrant`, i.e. only after a horizontal claim. Note the
   *    gestureState is ALREADY ZEROED there (`PanResponder.js:462-463` resets
   *    `dx`/`dy` before invoking both the grant and this callback), so reading
   *    the axis at this point is meaningless — an earlier version of this
   *    comment treated a conditional answer here as the fix, and it evaluated
   *    `resolveAxis(0, 0)` = `'none'` and so returned a constant `false`,
   *    identical to the value it claimed to replace.
   *  - `onPanResponderTerminationRequest` → `true`. Cooperative; RN's own
   *    default is `true` when the prop is absent. Written out because this is
   *    exactly the line a future reader would "fix" back to `false` to make the
   *    grab unconditional, which is the platform fight this design removes.
   *
   * KNOWN LIMIT, stated rather than hidden: once a horizontal scrub has claimed,
   *  the finger cannot then turn vertical and hand the touch back — the same iOS
   *  rule as above, and the same limit `react-native-gesture-handler` has. So a
   *  user who scrubs 20 dp sideways and then flicks vertically does not page the
   *  feed. That is a far narrower hole than the one this replaces (which broke
   *  EVERY flick that touched the row), it cannot be closed from JS at all, and
   *  `onPanResponderMove`'s vertical abandon at least guarantees it neither
   *  previews nor seeks.
   */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Never at touch-down. See THE RULE.
        onStartShouldSetPanResponder: () => false,

        onMoveShouldSetPanResponder: (_e, g) => {
          if (!interactive) return false;
          const axis = resolveAxis(g.dx, g.dy);
          if (axis === 'vertical') {
            // The intent is the feed's scroll, not a scrub. Revoke the pending
            // tap here, on the first move that says so, so a flick that happens
            // to END on the bar cannot commit a seek afterwards. `none` keeps
            // the tap armed: sub-slop wobble is still a tap, not a scroll.
            tapPendingRef.current = false;
          }
          return axis === 'horizontal';
        },

        onPanResponderTerminationRequest: () => true,
        onShouldBlockNativeResponder: () => interactive,

        onPanResponderGrant: (e: GestureResponderEvent) => {
          if (!interactive) return;
          // A claim supersedes the tap channel, whichever order they arrive in.
          tapPendingRef.current = false;
          beginGesture(e.nativeEvent.locationX);
        },

        onPanResponderMove: (
          e: GestureResponderEvent,
          g: { dx: number; dy: number },
        ) => {
          const gesture = gestureRef.current;
          if (gesture === null) return;
          // A clip swap can land between two move events, with no re-render in
          // between on the parent. Checking here is what stops a drag that
          // started on one clip from previewing over another.
          if (!stillCurrent(gesture)) {
            abandonGesture();
            return;
          }
          // The intent turned vertical mid-scrub. Drop the preview now rather
          // than waiting for the release, so the bar cannot look grabbed while
          // the reel pages underneath it. Silent, and the release below then
          // finds no gesture and does nothing.
          if (resolveAxis(g.dx, g.dy) === 'vertical') {
            abandonGesture();
            return;
          }
          // Past the slop, and horizontally: a drag. The fill follows the
          // finger on the UI thread — no React render per move event.
          // Below the slop the preview stays where the finger first landed and
          // the release still seeks to wherever it ends up, which is what makes
          // a tap and a slow drag the same gesture.
          if (Math.abs(g.dx) > MIN_DRAG_SLOP && Math.abs(g.dx) > Math.abs(g.dy)) {
            const fraction = fractionFromLocation(e.nativeEvent.locationX, widthRef.current);
            if (fraction !== null) {
              gesture.fraction = fraction;
              drag.value = fraction;
            }
          }
        },

        onPanResponderRelease: (e: GestureResponderEvent) => {
          // A tap that got this far is a release with no drag: the fraction to
          // commit is simply where the finger is. Same code path, so a tap and
          // the end of a drag cannot disagree.
          commitGesture(e.nativeEvent.locationX);
        },

        onPanResponderTerminate: () => {
          // Native took the touch (the feed scrolling). Never seek, and never
          // report: the user did not ask for a seek and did not get refused
          // one. `abandonGesture` rather than `finishGesture(null)`.
          abandonGesture();
        },
      }),
    [abandonGesture, beginGesture, commitGesture, interactive, stillCurrent],
  );

  /**
   * The TAP channel. See WHY THE TAP STILL WORKS above — the short version is
   * that with no claim at touch-down there is no `onPanResponderRelease` for a
   * stationary tap, and these are the only handlers that still fire.
   *
   * ARM ONLY on touch-down. The gesture itself is not begun here, deliberately:
   * beginning it would drive `drag.value` from the touch-down position, so a
   * vertical flick would paint a preview for the one frame before its first
   * move event revoked it. A tap has no visible preview to lose — `finishGesture`
   * lands the fill on the committed position — so arming costs nothing and
   * flashing costs a frame of "the bar grabbed my scroll".
   */
  const onTouchStart = useCallback(
    (e: GestureResponderEvent) => {
      if (!interactive) return;
      // A second finger makes the centroid meaningless (PanResponder's own
      // `onStartShouldSetResponderCapture` keys on the same `touches.length`),
      // and a pinch that happened to end over the bar must not seek.
      tapPendingRef.current = (e.nativeEvent.touches?.length ?? 1) === 1;
    },
    [interactive],
  );

  const onTouchEnd = useCallback(
    (e: GestureResponderEvent) => {
      if (!tapPendingRef.current) return;
      tapPendingRef.current = false;
      // Same two functions a granted scrub runs, so there is one commit path.
      beginGesture(e.nativeEvent.locationX);
      commitGesture(e.nativeEvent.locationX);
    },
    [beginGesture, commitGesture],
  );

  /** The platform handed the touch to the pager. Drop the tap, and any preview. */
  const onTouchCancel = useCallback(() => {
    tapPendingRef.current = false;
    abandonGesture();
  }, [abandonGesture]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = Number.isFinite(w) ? w : 0;
  }, []);

  /**
   * VoiceOver / TalkBack increment/decrement go through `skipBy`, the app's
   * existing relative-seek helper — which already clamps via `clampSeekTime`
   * and already refuses when nothing is loaded. A screen-reader user gets the
   * same guarantees as a finger, and there is no second seek path to keep
   * correct.
   */
  const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    // The step is `SKIP_SECONDS` — the same constant the Rewind / Advance buttons
    // use, from `lib/skipSeconds.ts`. It used to be a second literal
    // (`A11Y_STEP_SECONDS`) written here and kept in agreement by hand, which is
    // exactly the arrangement where the spoken step and the tapped step drift
    // apart silently. See that file for why the two are one gesture.
    if (name === 'increment') skipBy(SKIP_SECONDS);
    else if (name === 'decrement') skipBy(-SKIP_SECONDS);
  }, []);

  /**
   * While the finger is down the fill tracks it exactly (no easing — an eased
   * drag feels broken); otherwise it is whatever the store is animating to.
   */
  const shownFraction = useDerivedValue(() =>
    isDragging.value ? drag.value : fill.value,
  );

  /**
   * A PERCENTAGE, not a pixel width computed from `widthRef`. Two reasons: the
   * fill is correct before the first `onLayout` lands (whereas a pixel width
   * would be 0 until then), and the value is directly assertable in a test as
   * "percent of the track".
   */
  const fillStyle = useAnimatedStyle(() => ({ width: `${shownFraction.value * 100}%` }));

  /**
   * WaveformBar.tsx:38 — `boxShadow: isPlaying ? '0 0 6px var(--accent-glow)' : 'none'`.
   *
   * `glow(6, accent.glow)` is the project's existing 6 px accent glow
   * (`design/shadows.ts`), which is `0 0 6px rgba(232,168,124,0.25)` — the
   * same thing `--accent-glow` resolves to in the source. On Android it
   * degrades to `{}`, which is that module's documented decision: RN Android
   * cannot express a coloured glow, and a grey elevation blur would read as a
   * rendering bug. The ancestor track's `overflow: hidden` (also from the
   * source) clips most of the blur, so this reads as a soft bleed at the fill's
   * tip rather than a halo — which is how the web source renders too.
   */
  const glowStyle = useMemo(() => (playback === 'playing' ? glow(6, accent.glow) : null), [playback]);

  // `accessibilityValue` is spoken verbatim, so a NaN in `max`/`now` is read out
  // as garbage. Both are derived from already-finite numbers: `duration` is
  // coerced by `interactive`, and `currentTime` by the store's coercion plus the
  // clamp below.
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const a11yNow = Math.min(
    Math.max(Number.isFinite(currentTime) ? currentTime : 0, 0),
    safeDuration,
  );

  return (
    <View
      testID="seek-progress-bar"
      onLayout={onLayout}
      style={styles.touchTarget}
      pointerEvents={interactive ? 'auto' : 'none'}
      accessible
      // `adjustable`, not `progressbar`: this is a control the user drives, and
      // RN only offers increment/decrement actions to an adjustable element.
      accessibilityRole="adjustable"
      accessibilityLabel={`Seek within ${title ?? 'this clip'}`}
      accessibilityHint="Swipe up or down to move through the clip"
      accessibilityValue={{
        min: 0,
        max: Math.round(safeDuration),
        now: Math.round(a11yNow),
        // `formatTime` — the SAME function `ClipTransport` renders its visible
        // timecode with. It was a second local copy of the rule
        // (`formatClock`) until this was collapsed, which meant the spoken
        // position and the visible one could be two different numbers for the
        // same instant.
        text: `${formatTime(a11yNow)} of ${formatTime(safeDuration)}`,
      }}
      accessibilityState={{ disabled: !interactive }}
      accessibilityActions={[
        { name: 'increment', label: `Forward ${SKIP_SECONDS} seconds` },
        { name: 'decrement', label: `Back ${SKIP_SECONDS} seconds` },
      ]}
      onAccessibilityAction={onAccessibilityAction}
      // The tap channel, spread separately from the pan handlers and for that
      // reason: these three are NOT the responder negotiation, they fire on the
      // node the sequence started on whether or not it is the responder. See
      // WHY THE TAP STILL WORKS.
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      {...panResponder.panHandlers}
    >
      {/* pointerEvents: none — the parent is the only hit target, and a child
          that answers touches would steal the responder from it. */}
      <View testID="seek-progress-track" pointerEvents="none" style={styles.track}>
        <Animated.View
          testID="seek-progress-fill"
          pointerEvents="none"
          style={[styles.fill, glowStyle, fillStyle]}
        >
          {/* WaveformBar.tsx:36 `linear-gradient(90deg, ${c}, var(--terracotta))`,
              90deg = to right, so the category colour leads on the left. */}
          <LinearGradient
            testID="seek-progress-gradient"
            {...gradients.progressFill(color)}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * The HIT box: full width, exactly the platform floor tall, transparent.
   *
   * WHY TWO BOXES. WaveformBar's track is 4 px tall; the enforced floor is 44 pt
   * iOS / 48 dp Android (`tokens.accessibility`, re-exported as
   * `MIN_TOUCH_TARGET`). A 4 px target fails both by an order of magnitude, so
   * the visual bar and the target cannot be the same element. Resolution: the
   * VISUAL bar stays exactly 4 px — the tracked design value, and what the
   * reel's layout is composed around — centred inside this taller transparent
   * row, which is the actual hit rect. Nothing paints outside the 4 px bar;
   * everything accepts touches across the full floor. Same move as
   * `touchableStyle` / `hitSlop` in `ui/primitives.ts`, with the whole row as
   * the target rather than padding around a glyph.
   *
   * THE COST, stated rather than hidden: this row occupies real vertical space.
   * A hit area larger than its layout box is not available here — the reel stacks
   * overlays, and an overflowing one would swallow taps meant for the controls
   * behind it — so the bar claims ~44–48 dp of the reel's height. That is what
   * the accessibility floor costs, and paying it is the point: a 4 px bar that
   * only a sighted user with steady hands can hit is not a progress bar, it is
   * decoration.
   *
   * `minHeight` rather than `height` so the row can grow if a reel ever needs
   * more; the layout is single-line, so in practice it measures exactly
   * `MIN_TOUCH_TARGET` on both platforms.
   */
  touchTarget: {
    width: '100%',
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  // WaveformBar.tsx:26-31. `background` was `var(--surface-container)`.
  track: {
    height: TRACK_HEIGHT,
    alignSelf: 'stretch',
    borderRadius: TRACK_RADIUS,
    backgroundColor: surface.container,
    overflow: 'hidden',
  },
  // WaveformBar.tsx:33-38. `overflow: hidden` here is the RN equivalent of
  // `background-clip: border-box`: it clips the gradient child to the fill's
  // rounded tip, which CSS does for free on a background.
  fill: {
    height: '100%',
    borderRadius: TRACK_RADIUS,
    overflow: 'hidden',
  },
});
