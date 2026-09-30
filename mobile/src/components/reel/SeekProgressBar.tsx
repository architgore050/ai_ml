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
 * Accessibility step for VoiceOver/TalkBack increment/decrement.
 * 10 s because that is the app's own skip granularity (`skipBy`, "the ±10 s
 * skip button" in `store/player.ts`).
 */
export const A11Y_STEP_SECONDS = 10;

/**
 * Movement past which a gesture is treated as a drag rather than a tap.
 * Below it the release position is the seek position anyway, so this only
 * decides whether a drag was in progress, not where it lands.
 */
const MIN_DRAG_SLOP = 3;

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

/** `m:ss`, or `m:ss.t` under a minute. Screen readers read this verbatim. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
   * PanResponder, not `react-native-gesture-handler`. The deciding reason is
   * the clip-identity guard, not ergonomics:
   *
   * `blockerFor` must read the LIVE store at grant, move and release. A
   * worklet runs on the UI thread, where `usePlayerStore.getState()` does not
   * exist — every read would have to be a snapshot mirrored into shared values
   * and pushed across on each tick, which is strictly more machinery and a new
   * way for the guard to be a tick stale against the very race it exists to
   * catch. PanResponder handlers run on the JS thread where the store is a
   * plain synchronous read, and the seek rules become ordinary code.
   *
   * Also in its favour: the drag preview still runs on the UI thread (it is a
   * Reanimated shared value either way, so smoothness is unaffected), and it
   * has no hard dependency on a root `GestureHandlerRootView` — so the bar can
   * be rendered in a test or a preview without one. For reference, this app
   * DOES have one (`app/_layout.tsx`), so RNGH remains a live option if the
   * guard is ever rewritten in shared values.
   *
   * `onShouldBlockNativeResponder: false` is deliberate: the enclosing feed is
   * a `pagingEnabled` FlatList, and a vertical flick that happens to begin on
   * this row should scroll the feed rather than be swallowed. When native takes
   * the touch, `onPanResponderTerminate` fires and the drag is abandoned
   * without seeking. `onPanResponderTerminationRequest: false` is the other
   * half — a JS-level *parent* cannot take the drag away mid-gesture.
   */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactive,
        // Consulted only when start declined the touch (it does not, while
        // interactive), so this documents the horizontal lock rather than
        // enforcing it. Enforced at runtime in `onPanResponderMove` instead,
        // where the accumulated gesture state is available.
        onMoveShouldSetPanResponder: (_e, g) =>
          interactive && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => false,

        onPanResponderGrant: (e: GestureResponderEvent) => {
          if (!interactive) return;
          const s = usePlayerStore.getState();
          const fraction = fractionFromLocation(e.nativeEvent.locationX, widthRef.current);
          gestureRef.current = {
            clipId: clipIdRef.current,
            playingClipId: s.playingClipId,
            duration: s.duration,
            // No geometry yet (no `onLayout`) is still a valid grant: a tap that
            // commits nothing is better than a bar that swallows the gesture.
            fraction: fraction ?? 0,
          };
          isDragging.value = true;
          if (fraction !== null) drag.value = fraction;
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
            gestureRef.current = null;
            isDragging.value = false;
            restoreFromStore();
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
          const gesture = gestureRef.current;
          // A tap is a release with no drag: the fraction to commit is simply
          // where the finger is. Same code path, so a tap and the end of a drag
          // cannot disagree.
          const fraction = fractionFromLocation(e.nativeEvent.locationX, widthRef.current);
          if (gesture !== null && fraction !== null) {
            gesture.fraction = fraction;
            drag.value = fraction;
          }
          finishGesture(fraction);
        },

        onPanResponderTerminate: () => {
          // Native took the touch (the feed scrolling). Never seek from here.
          finishGesture(null);
        },
      }),
    [drag, finishGesture, interactive, isDragging, restoreFromStore, stillCurrent],
  );

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
    if (name === 'increment') skipBy(A11Y_STEP_SECONDS);
    else if (name === 'decrement') skipBy(-A11Y_STEP_SECONDS);
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
        text: `${formatClock(a11yNow)} of ${formatClock(safeDuration)}`,
      }}
      accessibilityState={{ disabled: !interactive }}
      accessibilityActions={[
        { name: 'increment', label: `Forward ${A11Y_STEP_SECONDS} seconds` },
        { name: 'decrement', label: `Back ${A11Y_STEP_SECONDS} seconds` },
      ]}
      onAccessibilityAction={onAccessibilityAction}
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
