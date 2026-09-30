import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { categoryColor } from '../../design/categories';
import { gradients, type LinearGradientSpec } from '../../design/tokens';
import {
  BAR_COUNT,
  ENVELOPE_MAX,
  LOOP_SECONDS,
  baseHeight,
  envelopeFor,
  waveformSeed,
  type WaveformState,
} from '../../lib/waveform';

/**
 * The reel card's decorative 40-bar waveform.
 *
 * DECORATIVE. It is a deterministic pseudo-reactive shape, NOT audio amplitude
 * and NOT a seek bar: nothing the API returns describes a clip's waveform, so
 * nothing here may claim to, and no accessibility semantics are attached (a
 * `progressbar` role on invented data would be worse than silence).
 *
 * Design source: `ReelCard.tsx:170-186` at `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`
 * — `Array.from({ length: 40 })`, a 60px bottom-aligned row, `gap: 2`,
 * `opacity: 0.15`, 3px-wide bars with a 2px radius, a
 * `linear-gradient(to top, ${c}, var(--sage))` fill, and a per-bar
 * `opacity: isActive ? 0.6 : 0.3` with a `transition: opacity 0.3s`.
 *
 * THE GEOMETRY IS NOT THE SOURCE'S. `lib/waveform.ts` owns it, and the source's
 * `8 + sin(i * 0.4) * 12 + Math.random() * 10` had two defects: a re-rolled
 * random term (the row reshuffled on every render) and a −4px floor. This
 * component renders what the library computes and adds nothing to it.
 *
 * ## The composition contract (from `lib/waveform.ts`)
 *
 *     height:          baseHeight(index, seed)          px, [MIN_BASE, MAX_BASE]
 *     transform:       [{ scaleY: envelope(index, t, seed) }]   [ENVELOPE_MIN, 1]
 *     transformOrigin: 'bottom'
 *
 * which renders to `base * envelope` in `[MIN_BAR_HEIGHT, MAX_BAR_HEIGHT]`.
 *
 * `transformOrigin: 'bottom'` is LOAD-BEARING, not decoration. React Native
 * scales a view about its CENTRE by default, and this row is bottom-aligned
 * against a baseline (`alignItems: 'flex-end'`), so without it every bar lifts
 * off the baseline as it breathes and the row visibly detaches from the bottom
 * of its box — the mirror image of the negative-height bug the library exists
 * to prevent, and invisible to the pure functions.
 *
 * `barHeight()` is deliberately NOT called per frame: the split above is what
 * keeps the animation on the UI thread, and collapsing it back into a per-frame
 * pixel height would reimplement the `requestAnimationFrame` + `setState` loop
 * the library was written to avoid.
 *
 * ## Why the envelope is a SAMPLED TABLE (a plan premise that does not hold)
 *
 * The obvious implementation is to call `envelopeFor(...)` inside
 * `useAnimatedStyle`, i.e. run the library's maths on the UI thread. **That
 * cannot work in this toolchain, and it fails only on device — a green jest
 * suite would hide it.**
 *
 * `react-native-worklets`' babel plugin (auto-added by `babel-preset-expo`)
 * workletises a function when it carries a `'worklet'` directive or is a
 * workletisable callback at a recognised call site. `lib/waveform.ts` is
 * neither: transforming it with this project's actual babel config produces
 * zero `__workletHash` properties, i.e. its exports are ordinary JS functions.
 * A worklet that captures one gets a *remote function*
 * (`memory/serializable.native.ts` → `cloneNonWorkletFunction`), and calling it
 * on the UI runtime throws
 * `[Worklets] Tried to synchronously call a Remote Function` — from
 * `memory/remoteFunctionUnpacker.native.ts`. Under jest there is a single
 * runtime, so the same call succeeds and the bug is invisible to the tests.
 * Adding `'worklet'` to `waveform.ts` would fix it, but that file is not this
 * component's to change.
 *
 * So the envelope is sampled on the JS thread instead: `SAMPLE_COUNT` values
 * per bar, all of them produced by the library's own `envelopeFor`, computed
 * once per (clip, pose) in a `useMemo`. The worklet does array arithmetic only —
 * a lerp between two neighbouring samples — and never any waveform maths. Plain
 * number arrays are serialisable into the UI thread, so the whole animation
 * still runs there and the JS thread does no per-frame work.
 *
 * Fidelity: the fast harmonic is `FAST_RATE = 1.8` rad/s, i.e. exactly 3 cycles
 * per `LOOP_SECONDS`, so 64 samples is one every 164ms. Measured worst-case
 * error over 40 seeds x 40 bars x 2001 phases is `1.4e-3` of an envelope in
 * `[0.6, 1]` — 0.04px on a 30px bar, on a 3px-wide bar at 15% opacity. The
 * samples are also *exactly* on the library's curve at every keyframe, so the
 * values the row reports agree with `barHeight` to interpolation error rather
 * than drifting. Cost: 40 x 64 doubles (~20KB) per mounted row, computed once
 * per (clip, pose).
 *
 * ## A consequence of the base+scaleY split worth knowing
 *
 * The gradient is rasterised over each bar's LAYOUT box (3 × base), and the
 * transform does not re-rasterise it. Since `ENVELOPE_MAX` is 1 the envelope only
 * ever shrinks a bar, so a bar mid-breath shows the lower part of its gradient
 * and its top never reaches full sage. The source, whose gradient was drawn on
 * an element whose height WAS the rendered height, did not have this. It is
 * inherent to the mandated split, not a choice, and it is invisible at the
 * source's 0.15 opacity.
 */

/** Row geometry, from the design source. Kept here so nothing re-derives it. */
const ROW_HEIGHT = 60;
const ROW_GAP = 2;
const ROW_OPACITY = 0.15;
/** The source's `bottom: 120` inside the reel card. */
const DEFAULT_BOTTOM = 120;
const BAR_WIDTH = 3;
const BAR_RADIUS = 2;

/** `isActive ? 0.6 : 0.3`, per bar, with the source's 0.3s opacity transition. */
const ACTIVE_BAR_OPACITY = 0.6;
const IDLE_BAR_OPACITY = 0.3;
const BAR_OPACITY_MS = 300;

/**
 * Loop period in ms. DERIVED from the library rather than written as a literal:
 * the design source has no loop, and this is the constraint that keeps the row
 * in phase with every value `barHeight` reports. One definition, one use.
 */
const LOOP_MS = LOOP_SECONDS * 1000;

/** Samples per bar per loop. See the fidelity argument in the docstring. */
const SAMPLE_COUNT = 64;

const ROW_TEST_ID = 'waveform-row';
const barTestID = (index: number): string => `waveform-bar-${index}`;

export type WaveformBarsProps = {
  /**
   * Seeds the row. `string | number` because the same clip arrives both ways
   * (API payloads carry numeric ids, route params carry strings) and
   * `waveformSeed` makes both spellings identical. A null/undefined id still
   * renders — `waveformSeed` degrades to the empty-string seed — because a reel
   * whose clip is still loading must not lose its background.
   */
  clipId: string | number | null | undefined;
  /** Free-text category; `categoryColor` falls back to neutral for unknowns. */
  category: string | null | undefined;
  /** Whether this is the playing card. Gates the per-bar opacity only. */
  isActive?: boolean;
  /**
   * `'paused'` (the default) is a still pose; `'playing'` runs the
   * `LOOP_SECONDS` loop. Defaulting to paused is deliberate: a feed keeps several
   * cards mounted, and an animation nobody asked for is a UI thread burning
   * frames behind every offscreen reel.
   */
  state?: WaveformState;
  /** Distance from the card's bottom edge, px. The design source uses 120. */
  bottom?: number;
};

function barOpacityFor(isActive: boolean): number {
  return isActive ? ACTIVE_BAR_OPACITY : IDLE_BAR_OPACITY;
}

/**
 * `SAMPLE_COUNT` evenly spaced samples of the library's envelope for one bar,
 * covering exactly one loop. Sample `SAMPLE_COUNT` is not stored: the wrap is
 * implicit because the envelope is exactly periodic, so the last segment
 * interpolates from the final sample back to sample 0.
 */
function sampleEnvelope(index: number, seed: number, state: WaveformState): number[] {
  return Array.from({ length: SAMPLE_COUNT }, (_, sample) =>
    envelopeFor(index, (sample / SAMPLE_COUNT) * LOOP_SECONDS, seed, state),
  );
}

export function WaveformBars({
  clipId,
  category,
  isActive = false,
  state = 'paused',
  bottom = DEFAULT_BOTTOM,
}: WaveformBarsProps) {
  // One seed per clip, computed once — not per bar and not per frame.
  const seed = useMemo(() => waveformSeed(clipId), [clipId]);
  const tint = categoryColor(category);
  const gradient = useMemo(() => gradients.waveformBar(tint), [tint]);

  /**
   * The loop clock, 0 → 1 over exactly one `LOOP_SECONDS` period, restarted.
   * The duration IS the lib's period: if the two ever disagreed the row would
   * drift out of phase with every value `barHeight` reports, and the
   * paused/playing cross-check would stop matching what is on screen.
   */
  const phase = useSharedValue(0);
  const barOpacity = useSharedValue(barOpacityFor(isActive));

  useEffect(() => {
    phase.value =
      state === 'playing'
        ? withRepeat(
            // `Easing.linear` is a worklet in reanimated's own source; a bare
            // arrow here would be a plain JS function the UI runtime cannot
            // call. Linear because the phase is a CLOCK: any easing would make
            // the sample index and the loop period disagree.
            withTiming(1, { duration: LOOP_MS, easing: Easing.linear }),
            -1,
            false,
          )
        : 0;
    return () => cancelAnimation(phase);
  }, [phase, state]);

  // The source's `transition: opacity 0.3s`. Initial value is the source's own
  // literal, so the first committed frame is already correct.
  useEffect(() => {
    barOpacity.value = withTiming(barOpacityFor(isActive), { duration: BAR_OPACITY_MS });
  }, [barOpacity, isActive]);

  return (
    <View testID={ROW_TEST_ID} style={[styles.row, { bottom }]}>
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <Bar
          key={index}
          index={index}
          seed={seed}
          state={state}
          phase={phase}
          barOpacity={barOpacity}
          gradient={gradient}
        />
      ))}
    </View>
  );
}

/**
 * One bar: the static base profile as `height`, the envelope as `scaleY`.
 *
 * A component rather than a mapped inline element because the hooks
 * (`useSharedValue`, `useAnimatedStyle`, `useMemo`) are per-bar state: one hook
 * call in the parent would give all 40 bars a single shared transform.
 */
function Bar({
  index,
  seed,
  state,
  phase,
  barOpacity,
  gradient,
}: {
  index: number;
  seed: number;
  state: WaveformState;
  phase: SharedValue<number>;
  barOpacity: SharedValue<number>;
  gradient: LinearGradientSpec;
}) {
  // The base is the multiplier's OPERAND, so it is rendered as a height and
  // never scaled by hand — see `MIN_BASE_HEIGHT` for why it is not
  // `MIN_BAR_HEIGHT`.
  const base = useMemo(() => baseHeight(index, seed), [index, seed]);
  const levels = useMemo(() => sampleEnvelope(index, seed, state), [index, seed, state]);

  const animated = useAnimatedStyle(() => {
    // `phase` is a clock over one loop, so the sample position is
    // `phase * SAMPLE_COUNT`. Everything below is array arithmetic: no waveform
    // maths happens here, because none of it can run on this thread.
    const position = phase.value * SAMPLE_COUNT;
    const lower = Math.floor(position) % SAMPLE_COUNT;
    const upper = (lower + 1) % SAMPLE_COUNT;
    const fraction = position - Math.floor(position);
    // `??` rather than a non-null assertion: the modulo above keeps both indices
    // in range, but `noUncheckedIndexedAccess` is on and the worklet is shipped
    // code, so an out-of-range read must degrade to a valid envelope rather than
    // put `undefined` into `scaleY` and blank the bar.
    const from = levels[lower] ?? ENVELOPE_MAX;
    const to = levels[upper] ?? ENVELOPE_MAX;
    return {
      transform: [{ scaleY: from + (to - from) * fraction }],
      opacity: barOpacity.value,
    };
  });

  return (
    <Animated.View testID={barTestID(index)} style={[styles.bar, { height: base }, animated]}>
      {/* Fills the bar's layout box; the parent transform scales it with the bar. */}
      <LinearGradient {...gradient} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: ROW_GAP,
    opacity: ROW_OPACITY,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_RADIUS,
    // See the docstring: without this every bar scales about its centre and
    // lifts off the baseline. Stated in the STATIC style so it is unconditional
    // and independent of the animation.
    transformOrigin: 'bottom',
  },
});
