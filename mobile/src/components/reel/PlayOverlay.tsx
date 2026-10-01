import { BlurView } from 'expo-blur';
import Svg, { Polygon } from 'react-native-svg';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { MIN_TOUCH_TARGET } from '../ui/primitives';
import { blur, duration, radius } from '../../design/tokens';
import {
  autoHideDelayMs,
  canTogglePlayback,
  initialPlayOverlay,
  playOverlayReducer,
  playOverlayVisibility,
  toggleDirection,
  type OverlayIcon,
  type PlayOverlayState,
} from '../../lib/playOverlayVisibility';
import { pause, resume, usePlayerStore } from '../../store/player';

/**
 * The reel's play/pause affordance: a tap target plus the 100 px circle that
 * reports what that tap did.
 *
 * ---------------------------------------------------------------------------
 * DESIGN SOURCE
 * ---------------------------------------------------------------------------
 * `ReelCard.tsx:135-163` — the only surviving copy, read via
 * `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`.
 * Transcribed: the absolutely-filled centred wrapper at `zIndex: 10`; the 100 px
 * `--radius-full` circle at `rgba(0,0,0,0.4)` with `backdrop-filter: blur(10px)`
 * and `animation: popIn 0.3s ease forwards`; the 7 bars at
 * `[12,18,14,20,14,18,12]` with `gap: 3` in a 24 px bottom-aligned row, 4 px
 * wide, 2 px radius, white at 0.9, on the `.wave-bar` class
 * (`waveBar 1s ease-in-out infinite; transform-origin: bottom`) with per-index
 * delays `[0, .12, .24, .36, .24, .12, 0]s`; and the 28×34
 * `viewBox="0 0 24 24"` triangle at `polygon 6,4 22,12 6,20`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT THE SOURCE'S: THE TAP HANDLER
 * ---------------------------------------------------------------------------
 * The source's `handleVisualTap` (`:35-54`) is broken, and both faults are
 * instructive:
 *
 *  1. Its double-tap branch is an EMPTY BLOCK —
 *     `if (globalPlaying) { /* pause handled by player *\/ }` — so there is no
 *     `pause()` call anywhere in the file. Double-tapping a playing reel shows
 *     the overlay for 600 ms and does nothing else, and the comment asserts a
 *     behaviour the code does not have. A comment naming a method that does not
 *     exist is worse than no comment: it tells the next reader the pause is
 *     handled elsewhere, and it is not.
 *  2. Its 250 ms single-tap timer adds that latency to EVERY tap, including the
 *     first play, and its 600 ms hide timer is never cleared.
 *
 * So there is no tap delay here. One tap toggles play/pause immediately, and
 * the 600 ms window belongs to the VISIBILITY machine in
 * `lib/playOverlayVisibility.ts`, which is clip-scoped, restartable, and cleared
 * on unmount. Double-tap-to-like is a different gesture on a different element
 * (the action cluster, not the reel) and is Phase 3.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TAP TARGET IS A SEPARATE, ALWAYS-MOUNTED ELEMENT
 * ---------------------------------------------------------------------------
 * The brief for this pass: the overlay is a STATUS affordance, and the reel has
 * to stay operable without it. That is why `visible` gates the CIRCLE and not
 * this `Pressable`: the reel is one full-size touch target carrying the
 * role/label at all times, and what comes and goes is the 100 px of chrome drawn
 * over it. The alternative — mounting the target only while the circle is up —
 * would make the affordance load-bearing, so a reel that decided not to draw a
 * circle would be a reel that cannot be played.
 *
 * The circle is `pointerEvents="none"` and `aria-hidden`, so it can neither steal
 * a touch from the target nor be announced. It is decoration: a screen reader
 * gets "Play"/"Pause" and the real state from the target, and a blurred disc
 * that happens to be animating is not something to read aloud.
 *
 * `zIndex: 10` is the source's, and it is a CONSTRAINT on the caller: the action
 * cluster and the seek bar must render above it, or this full-reel target will
 * swallow their taps. `style/tokens.ts` has no layer token for this (its
 * `zIndex` group is nav/sheet/toast/banner — all app chrome, not card internals),
 * so the literal is restated here and exported for the caller and the test.
 *
 * ---------------------------------------------------------------------------
 * ON `lib/playbackDecision.ts` — READ, NOT REUSED
 * ---------------------------------------------------------------------------
 * That module is the LOAD path: given a `TokenStatus` and the active clip, it
 * answers "load / load-after / show / stop / none", and the feed screen performs
 * the answer (`app/(tabs)/index.tsx`). A tap asks a different question, about
 * state the module never receives: it takes no `playback` at all, it is not
 * parameterised by what is already loaded, and it deliberately returns
 * `{kind:'none'}` for a token error so that "the audio is still playing, keep
 * the last good state" — the exact opposite of what a tap on an errored card
 * must do. Its `show` arm does encode the same five terminal statuses, and that
 * correspondence is noted where `TERMINAL_CARD_STATUSES` is defined; the
 * membership is restated rather than derived, because the two questions are
 * different and forcing one function to answer both is how a "what is servable"
 * check ends up with two divergent copies.
 *
 * What IS shared is the single source of truth for the two state types: both are
 * `CardStatus` / `PlaybackState` from `store/player.ts`, and they stay
 * SEPARATE. "Now playing" is `playback === 'playing'` — never
 * `cardStatus === 'idle'`, which is also what a settled, playable card reads.
 */

/* ------------------------------------------------------------------ */
/* Design source literals                                             */
/* ------------------------------------------------------------------ */

/** ReelCard.tsx:139 — `zIndex: 10`. Exported: a caller has to sit above it. */
export const OVERLAY_Z = 10;

/** ReelCard.tsx:141-142 — the circle is 100 × 100. */
export const CIRCLE_SIZE = 100;

/**
 * ReelCard.tsx:143 — `background: rgba(0,0,0,0.4)`.
 *
 * Not a token, and deliberately not `glass.background`: that is a 60 % scrim in
 * `surface.base`, which over cover art would be a grey slab rather than a
 * smoked disc. The 40 % black is a scrim over UNKNOWN content, so there is
 * nothing in the palette to derive it from, and `design/tokens.ts` is not this
 * pass's file to change.
 */
export const CIRCLE_SCRIM = 'rgba(0, 0, 0, 0.4)';

/**
 * The seven bars, each carrying its OWN height and its own phase delay.
 *
 *     ReelCard.tsx:150      [12, 18, 14, 20, 14, 18, 12]
 *     globals.css:209-215  .wave-bar:nth-child(n) { animation-delay: 0 / .12 /
 *                          .24 / .36 / .24 / .12 / 0 s }
 *
 * ONE array, not two, and that is load-bearing twice over.
 *
 * 1. **It is how `noUncheckedIndexedAccess` is satisfied without a lie.** The
 *    two were separate readonly 7-tuples indexed by a general `number`, so
 *    `BAR_DELAY_SECONDS[index]` was honestly typed `number | undefined` and
 *    would not compile. Reaching for `!` would have silenced the error without
 *    removing the unsafety it reports. Pairing the values removes the indexed
 *    access ENTIRELY — `.map` over an `as const` tuple hands each element its
 *    own literal type — so the compiler has nothing to complain about because
 *    there is no unchecked index left to complain about.
 * 2. **A height and a delay are one bar's identity, not two parallel lists.**
 *    With two arrays, editing one without the other is a silent mis-pairing
 *    (the 20 px bar gets the 0 s phase) that no type or test would catch. Here
 *    the pairing is unrepresentable: `WaveBar` is handed both, and cannot be
 *    handed one.
 *
 * `delayMs` is milliseconds because that is the unit `withDelay` takes; the
 * source's values are seconds, converted once, here.
 */
export const BARS = [
  { height: 12, delayMs: 0 },
  { height: 18, delayMs: 120 },
  { height: 14, delayMs: 240 },
  { height: 20, delayMs: 360 },
  { height: 14, delayMs: 240 },
  { height: 18, delayMs: 120 },
  { height: 12, delayMs: 0 },
] as const;

/** globals.css:170 — `0%,100% { transform: scaleY(0.25) }`. */
export const BAR_SCALE_MIN = 0.25;
/** globals.css:171 — `50% { transform: scaleY(1) }`. */
export const BAR_SCALE_MAX = 1;

/** globals.css:168-172 — the loop is one `scaleY` there-and-back, so two halves. */
const BAR_HALF_MS = duration.waveBar / 2;

/** globals.css:168 — `animation: waveBar 1s ease-in-out infinite`. */
const WAVE_EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);

/**
 * ReelCard.tsx:146 — `animation: popIn 0.3s ease forwards`.
 *
 * 300 ms, NOT `duration.popIn` (350). The source sets this as an INLINE
 * `animation` shorthand, which beats the `.pop-in` class that `duration.popIn`
 * and `easing.pop` transcribe (globals.css:216, `0.35s cubic-bezier(.34,1.56,.64,1)`).
 * The inline value is what the source renders.
 */
export const POP_IN_MS = 300;
/** globals.css:158 — `0% { transform: scale(0.8) }`. */
export const POP_SCALE_FROM = 0.8;
/** globals.css:157 — `70% { transform: scale(1.05) }`. */
export const POP_SCALE_PEAK = 1.05;
/** globals.css:158 — `100% { transform: scale(1) }`. */
export const POP_SCALE_TO = 1;
/** 70 % of 300 ms, to the overshoot. */
const POP_RISE_MS = Math.round(POP_IN_MS * 0.7);
/** The remaining 30 %, settling back to 1. */
const POP_SETTLE_MS = POP_IN_MS - POP_RISE_MS;

/**
 * globals.css:158 — `0.3s ease`, the CSS `ease` keyword.
 *
 * `cubic-bezier(0.25, 0.1, 0.25, 1)` — the keyword is exactly that curve, and
 * `easing.base`/`easing.fade` are the same one as a CSS string, which is not a
 * value `withTiming` accepts.
 */
const POP_EASE = Easing.bezier(0.25, 0.1, 0.25, 1);

/** ReelCard.tsx:157-158 — the paused glyph. */
export const TRIANGLE_WIDTH = 28;
export const TRIANGLE_HEIGHT = 34;
const TRIANGLE_VIEWBOX = '0 0 24 24';
const TRIANGLE_POINTS = '6,4 22,12 6,20';
/** The source's literal `#fff` on both the `<svg>` and the bars. */
const GLYPH_WHITE = '#fff';

const TARGET_TEST_ID = 'play-overlay';
const CIRCLE_TEST_ID = 'play-overlay-circle';
export const barTestID = (index: number): string => `play-overlay-bar-${index}`;

/** What a tap did, for a caller's own analytics. `null` = refused. */
export type PlayToggleResult = { direction: 'pause' | 'resume' } | null;

export type PlayOverlayProps = {
  /** The clip this reel shows. Gates the toggle and scopes the machine. */
  clipId: string;
  /**
   * Clip title, appended to the accessibility label. Optional because the
   * overlay is also used by callers with no title to hand, and a bare "Play" is
   * the fallback rather than the only spelling.
   */
  title?: string;
  /**
   * Observability seam, mirroring `SeekProgressBar`'s `onSeekResult`. Called
   * with the direction that was acted on, or `null` when the tap was refused
   * (a terminal card state, a native error, or another clip being the loaded
   * one). Default no-op, so callers are optional.
   */
  onToggle?: (result: PlayToggleResult) => void;
};

export function PlayOverlay({ clipId, title, onToggle }: PlayOverlayProps) {
  // Three selectors and no more. `currentTime` moves every 500 ms; subscribing
  // to it would re-render the reel twice a second for nothing.
  const playback = usePlayerStore((s) => s.playback);
  const cardStatus = usePlayerStore((s) => s.cardStatus);
  const playingClipId = usePlayerStore((s) => s.playingClipId);

  const toggleable = canTogglePlayback({ cardStatus, playback, playingClipId, clipId });

  /**
   * The machine lives here, per mounted reel.
   *
   * `scoped` re-bases a state left over from a different clip DURING RENDER
   * rather than repairing it in an effect: an effect would leave the first frame
   * of a newly-swiped-to reel drawing the PREVIOUS reel's overlay, for exactly
   * one commit. `dispatch` then stamps the same correction into the stored state
   * before any event lands on it, so the machine is never left describing a clip
   * it is not on.
   *
   * Both are needed and neither subsumes the other: `scoped` is what stops the
   * stale state being DRAWN, `dispatch` is what stops it being WRITTEN. Render
   * alone would re-base a fresh copy on every render and never heal the stored
   * one, so the very next event would land on the old clip again.
   */
  const [machine, setMachine] = useState<PlayOverlayState>(() => initialPlayOverlay(clipId));
  const scoped = useMemo(
    () =>
      machine.clipId === clipId
        ? machine
        : playOverlayReducer(machine, { type: 'clip', clipId }),
    [machine, clipId],
  );
  /**
   * Re-base to THIS clip, then apply the event.
   *
   * Unconditionally, and that is the whole point. The previous revision guarded it
   * the other way round — `prev.clipId === clipId ? rebase(prev) : prev` — which
   * re-based only when there was nothing to correct and passed a foreign clip's
   * state straight through when there was. The consequence is a real, reachable
   * bug: reels stay mounted across a swipe, so for a while after `clipId` changes
   * the stored machine still describes the PREVIOUS clip, and tapping the new
   * one during that window wrote its deadline onto the old clip's machine. The
   * render-time `scoped` re-base then wiped that state, so the tap the user had
   * just made produced NO overlay at all on the clip they tapped — a pause that
   * gives no feedback whatsoever, which is the failure this component exists to
   * prevent. `components/reel/__tests__/PlayOverlay.test.tsx` covers it.
   *
   * Calling the `clip` event unconditionally is free: it returns `prev` BY
   * IDENTITY when the ids already match, so the common case allocates nothing and
   * the `useState` bail-out still holds.
   */
  const dispatch = useCallback(
    (event: Parameters<typeof playOverlayReducer>[1]) =>
      setMachine((prev) =>
        playOverlayReducer(playOverlayReducer(prev, { type: 'clip', clipId }), event),
      ),
    [clipId],
  );

  /**
   * `Date.now()` at render, not a ticking state value. The only thing that
   * changes `visible` over time is the timer below, and that timer is what
   * re-renders — so reading the clock here is exact, and adding a
   * `setInterval` to keep it "fresh" would be a second timer to leak.
   */
  const effect = playOverlayVisibility({
    state: scoped,
    now: Date.now(),
    cardStatus,
    playback,
  });
  const { visible, icon, autoHideAt } = effect;

  /**
   * The auto-hide, keyed on the ABSOLUTE deadline.
   *
   * Three properties fall out of that one choice, and all three are in the
   * brief: the effect's cleanup runs on unmount (the source never clears its
   * timer), on a REPEAT TAP the new `autoHideAt` is a different number so the
   * cleanup cancels the old timer and a fresh 600 ms starts, and an unrelated
   * re-render leaves the dependency untouched so the timer is not restarted by
   * its own deadline approaching.
   */
  useEffect(() => {
    const delay = autoHideDelayMs(autoHideAt, Date.now());
    if (delay === null) return undefined;
    const handle = setTimeout(() => {
      dispatch({ type: 'window-elapsed' });
    }, delay);
    return () => clearTimeout(handle);
  }, [autoHideAt, dispatch]);

  const onPress = useCallback(() => {
    if (!canTogglePlayback({ cardStatus, playback, playingClipId, clipId })) {
      onToggle?.(null);
      return;
    }
    const direction = toggleDirection(playback);
    if (direction === 'pause') pause();
    else resume();
    dispatch({ type: 'tap', now: Date.now(), outcome: direction === 'pause' ? 'paused' : 'playing' });
    onToggle?.({ direction });
  }, [cardStatus, clipId, dispatch, onToggle, playback, playingClipId]);

  // Real state, never a latched value: a screen reader must not be told to
  // "Play" a clip that is playing, which is what reading a stale intent off the
  // machine would do for the first 600 ms of every tap.
  const verb = playback === 'playing' ? 'Pause' : 'Play';
  const label = title ? `${verb} ${title}` : verb;

  return (
    <Pressable
      testID={TARGET_TEST_ID}
      style={styles.target}
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      // A refused tap is announced as a disabled control rather than a third
      // label: the card already reads out its own copy for every terminal state
      // (and must not distinguish 403 from 404, which is why there is no single
      // collapsed string to reuse here either — "unavailable" would misdescribe
      // `processing`).
      accessibilityState={{ disabled: !toggleable }}
    >
      {visible ? <OverlayCircle icon={icon} /> : null}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Circle                                                             */
/* ------------------------------------------------------------------ */

/**
 * The 100 px circle: `popIn`, the scrim, and one of the two glyphs.
 *
 * Split out from the target so the pop animation's starting values can live in
 * `useSharedValue` INITIALISERS. The circle mounts exactly when the overlay
 * becomes visible, so a fresh component per appearance is what makes the pop
 * start at `scale(0.8), opacity 0` every time — held in the parent it would
 * have to be reset by hand, and a second appearance would scale from 1.
 */
function OverlayCircle({ icon }: { icon: OverlayIcon }) {
  const scale = useSharedValue(POP_SCALE_FROM);
  const opacity = useSharedValue(0);

  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  useEffect(() => {
    /**
     * `popIn`, as a sequence. globals.css:155-159:
     *
     *     0%   { transform: scale(0.8); opacity: 0 }
     *     70%  { transform: scale(1.05) }
     *     100% { transform: scale(1);   opacity: 1 }
     *
     * The scale overshoots to 1.05 at 70 % of 300 ms and settles over the last
     * 30 %, so it is two `withTiming`s in a `withSequence` rather than one curve.
     *
     * OPACITY IS A SEPARATE, LINEAR TRACK, and that is a reading of the
     * keyframes rather than an invention: 70 % does not declare opacity, so
     * there is no mid keyframe for it and it ramps across the WHOLE duration
     * rather than following the overshoot. Reusing the scale's easing here would
     * make the disc fade in fast and hold, which is a different animation.
     */
    scale.value = withSequence(
      withTiming(POP_SCALE_PEAK, { duration: POP_RISE_MS, easing: POP_EASE }),
      withTiming(POP_SCALE_TO, { duration: POP_SETTLE_MS, easing: POP_EASE }),
    );
    opacity.value = withTiming(1, { duration: POP_IN_MS, easing: Easing.linear });
    // Cancelled on unmount. The circle is mounted for as little as 600 ms, and a
    // `withSequence` left running against a dropped view is a per-frame write
    // into a component that is gone.
    return () => {
      cancelAnimation(scale);
      cancelAnimation(opacity);
    };
  }, [opacity, scale]);

  return (
    <Animated.View
      testID={CIRCLE_TEST_ID}
      style={[styles.circle, animated]}
      // Decoration: the target above already carries the role and the label, and
      // `aria-hidden` is the cross-platform spelling (View.js expands it to
      // `accessibilityElementsHidden` + `importantForAccessibility`).
      aria-hidden
      pointerEvents="none"
    >
      {/* ReelCard.tsx:144 `backdropFilter: 'blur(10px)'`. React Native has no
          `backdrop-filter` style (verified: `StyleSheetTypes.d.ts` has
          `filter` and `experimental_backgroundImage`, and no `backdropFilter`),
          and `design/tokens.ts` says so outright — the `blur.*` group "drives
          `expo-blur` intensity and the `BlurView` radius". `blur.button` is the
          10 the source asks for. The source's backdrop has no tint of its own;
          `light` is the least additive of the available tints and it sits UNDER
          the 40 % scrim anyway. */}
      <BlurView
        testID="play-overlay-blur"
        intensity={blur.button}
        tint="light"
        style={StyleSheet.absoluteFill}
      />
      {icon === 'bars' ? <WaveBars /> : <PlayTriangle />}
    </Animated.View>
  );
}

/**
 * The playing glyph: seven bars, out of phase.
 *
 * globals.css:168-172 + 208-215 — `waveBar 1s ease-in-out infinite`,
 * `transform-origin: bottom`, and a delay per bar so the row reads as a wave
 * rather than a pulse. Each bar is its own component because each has its own
 * `useSharedValue` and its own delay; a shared clock would need a per-bar phase
 * wrap inside a worklet, which is the same shape of problem `WaveformBars` had to
 * solve for a different reason.
 */
function WaveBars() {
  return (
    <View testID="play-overlay-bars" style={styles.barRow}>
      {BARS.map((bar, index) => (
        <WaveBar key={index} index={index} height={bar.height} delayMs={bar.delayMs} />
      ))}
    </View>
  );
}

function WaveBar({
  index,
  height,
  delayMs,
}: {
  index: number;
  height: number;
  delayMs: number;
}) {
  const scale = useSharedValue(BAR_SCALE_MIN);

  useEffect(() => {
    scale.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(BAR_SCALE_MAX, { duration: BAR_HALF_MS, easing: WAVE_EASE_IN_OUT }),
          withTiming(BAR_SCALE_MIN, { duration: BAR_HALF_MS, easing: WAVE_EASE_IN_OUT }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(scale);
  }, [delayMs, scale]);

  const animated = useAnimatedStyle(() => ({ transform: [{ scaleY: scale.value }] }));

  return (
    // `transformOrigin` lives in `styles.bar` — see that comment for why it is a
    // static STYLE and not a prop, and why it has to be on THIS view.
    <Animated.View testID={barTestID(index)} style={[styles.bar, { height }, animated]} />
  );
}

/** ReelCard.tsx:157-158 — an inline SVG triangle, not a View with borders. */
function PlayTriangle() {
  return (
    <Svg
      testID="play-overlay-triangle"
      width={TRIANGLE_WIDTH}
      height={TRIANGLE_HEIGHT}
      viewBox={TRIANGLE_VIEWBOX}
      fill={GLYPH_WHITE}
      stroke={GLYPH_WHITE}
      strokeWidth={1}
    >
      {/* Fill and stroke repeated on the polygon rather than relied on from the
          root. `Svg` does pass them down, but an inherited white that silently
          failed would render a BLACK triangle on a 40 %-black disc — invisible
          rather than broken, which is the worst way for it to fail. */}
      <Polygon points={TRIANGLE_POINTS} fill={GLYPH_WHITE} stroke={GLYPH_WHITE} strokeWidth={1} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  /**
   * The TAP TARGET: the whole reel, transparent, `zIndex: 10`.
   *
   * `minWidth`/`minHeight` are belt-and-braces on an element that already fills
   * its parent — they are here so the enforced floor (44 pt iOS / 48 dp Android,
   * `MIN_TOUCH_TARGET`) is a stated property of the target rather than an
   * accident of the reel's measured height, and so a test can assert it.
   */
  target: {
    ...StyleSheet.absoluteFill,
    zIndex: OVERLAY_Z,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
  },
  circle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: radius.full,
    backgroundColor: CIRCLE_SCRIM,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // ReelCard.tsx:149 — `display:flex; align-items:flex-end; gap:3; height:24`.
  barRow: {
    height: 24,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 3,
  },
  // ReelCard.tsx:152 — `width: 4; borderRadius: 2; background: #fff; opacity: .9`.
  bar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: GLYPH_WHITE,
    opacity: 0.9,
    // ------------------------------------------------------------------------
    // LOAD-BEARING, and the placement is not negotiable. Same as `WaveformBars`.
    // ------------------------------------------------------------------------
    // The row is bottom-aligned and RN scales a view about its CENTRE, so
    // without this every bar lifts off the baseline as it breathes and the row
    // detaches from the middle of the disc.
    //
    // **It must be in the STATIC STYLE, on THIS view — and both halves of that
    // sentence are load-bearing.**
    //
    // *In a style, not a prop.* `transformOrigin` is a STYLE property: it is
    // declared in `TransformOriginStyleProps` (`StyleSheetTypes.d.ts:296`) and
    // is absent from `ViewProps`, so `ViewPropTypes.d.ts` has no mention of it.
    // Written as `transformOrigin="bottom"` on the JSX element it is not merely
    // a type error — it is a prop the renderer has no handler for, and the
    // origin would silently not be set. The compiler caught that; the reason it
    // caught it is worth keeping.
    //
    // *On this view, not an outer wrapper.* The brief for this pass suggested a
    // plain `View` carrying the static origin with the animated transform on an
    // inner `Animated.View`. That does not work, and it is worth saying why
    // rather than shipping it because it was asked for. `transformOrigin` is a
    // per-view NATIVE PROP — `BaseViewConfig.ios.js:218` /
    // `.android.js` list it in the view config, and
    // `processTransformOrigin.js` resolves `'bottom'` to `['50%', '100%', 0]`
    // against the view being transformed. Nothing inherits it. So an origin on
    // a parent leaves the child's own `scaleY` anchored at the child's centre,
    // which is precisely the bug this line exists to prevent — it would type-check
    // and still render wrong.
    //
    // *Why this type-checks at all*, since `Animated.View`'s style prop is
    // `AnimatedStyleProp<ViewStyle>` and that does not resolve the key: the
    // value lives in a `StyleSheet.create` entry, which is typed against
    // `NamedStyles<ViewStyle>` and so IS checked against real `ViewStyle` here —
    // at the definition, where a typo would be caught. It then reaches the
    // component as an opaque `RegisteredStyle` (a branded `number`), which the
    // animated prop accepts without having to resolve its contents. The check
    // is not skipped, it is performed at the right place.
    transformOrigin: 'bottom',
  },
});
