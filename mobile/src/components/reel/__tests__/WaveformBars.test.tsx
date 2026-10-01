/**
 * Tests for the decorative reel waveform.
 *
 * WHAT IS ACTUALLY BEING GUARDED HERE. `lib/waveform.test.ts` (47 tests) covers
 * the maths; this file covers the four things the maths cannot see, all of which
 * are properties of the *component* and not of any function:
 *
 *  1. `transformOrigin: 'bottom'` is present on all 40 bars. React Native scales
 *     about a view's centre by default, so without it a bottom-aligned row lifts
 *     off its baseline as it breathes. The pure functions have no opinion about
 *     layout, so nothing upstream can catch this.
 *  2. The bar's `height` is `baseHeight(...)`, NOT `barHeight(...)`. Those differ
 *     by the envelope, and using the composed value as the layout height would
 *     apply the envelope twice while still looking plausible.
 *  3. The animation actually advances. `getAnimatedStyle` is the ONLY valid way
 *     to read it — `element.props.style` is frozen at the initial value and an
 *     assertion written against it passes with time standing still. There is a
 *     test below that pins that trap on purpose.
 *  4. The gradient is wired to the clip's category colour through
 *     `gradients.waveformBar`, including the 0deg/180deg direction, which is the
 *     one gradient mistake that still renders as a plausible gradient.
 *
 * TIMERS: `jest.useFakeTimers()` runs in `beforeEach`, BEFORE any `render`. The
 * animation schedules its first frame through `requestAnimationFrame`, which the
 * fake timers replace; installing them afterwards leaves the loop on real rAF
 * and `advanceTimersByTime` moves nothing.
 */

import { act, render, type RenderResult } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, processColor } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';

import { WaveformBars } from '../WaveformBars';
import { BRANDED_CATEGORIES, categoryColor } from '../../../design/categories';
import { brand, gradients } from '../../../design/tokens';
import {
  BAR_COUNT,
  LOOP_SECONDS,
  MAX_BAR_HEIGHT,
  MIN_BAR_HEIGHT,
  baseHeight,
  envelope,
  envelopeFor,
  pausedEnvelope,
  waveformSeed,
} from '../../../lib/waveform';

const ROW_TEST_ID = 'waveform-row';
const barTestID = (index: number): string => `waveform-bar-${index}`;
const BAR_SELECTOR = /^waveform-bar-/;

/** Advance the animation clock and let the frame loop flush. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** Flatten a rendered element's style prop (safe for STATIC style only). */
function staticStyleOf(element: { props: Record<string, unknown> }): Record<string, unknown> {
  return StyleSheet.flatten(element.props.style as never) as Record<string, unknown>;
}

/** The live `scaleY` of a bar. `getAnimatedStyle`, never `props.style`. */
function scaleYOf(element: object): number {
  const style = getAnimatedStyle(element as never) as {
    transform?: Array<{ scaleY?: number }>;
  };
  return style.transform?.[0]?.scaleY ?? Number.NaN;
}

/** The live `opacity` of a bar. */
function opacityOf(element: object): number {
  return (getAnimatedStyle(element as never) as { opacity?: number }).opacity ?? Number.NaN;
}

/**
 * The per-bar gradient fill, as host instances.
 *
 * RNTL v14 REMOVED the type queries (`UNSAFE_getAllByType` and friends no longer
 * exist), so this walks the rendered tree instead. The host type is
 * `ViewManagerAdapter_ExpoLinearGradient`: `expo-linear-gradient`'s
 * `requireNativeViewManager` wrapper is a composite, and what the test can reach
 * is the native view it renders. Its props are the ones the gradient component
 * forwarded, which is exactly what should be asserted — `colors` after
 * `processColor`, and `startPoint`/`endPoint` after the `{x, y}` → `[x, y]`
 * normalisation.
 */
function gradientFills(
  view: RenderResult,
): ReturnType<RenderResult['container']['queryAll']> {
  return view.container.queryAll((instance) => instance.type.includes('LinearGradient'));
}

/** The bottom-most gradient stop of the first bar, as a native colour. */
function firstStopOf(view: RenderResult): unknown {
  return (gradientFills(view)[0]?.props.colors as unknown[] | undefined)?.[0];
}

describe('WaveformBars', () => {
  beforeEach(() => {
    // Before the first `render`, not after — see the file docstring.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('structure', () => {
    it('renders exactly 40 bars, as the design source does', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);

      expect(view.getAllByTestId(BAR_SELECTOR)).toHaveLength(BAR_COUNT);
      expect(view.getByTestId(ROW_TEST_ID)).toBeTruthy();
    });

    it('labels every bar 0..39 in order, so one bar is addressable', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(view.getByTestId(barTestID(i))).toBeTruthy();
      }
    });

    it('reproduces the source row: 60px tall, bottom-aligned, centred, gap 2, 15% opacity', async () => {
      // Values are the design source's literals (ReelCard.tsx:170-174), not
      // imported constants, so a change to either side has to be a decision.
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);
      const style = staticStyleOf(view.getByTestId(ROW_TEST_ID));

      expect(style).toMatchObject({
        position: 'absolute',
        left: 0,
        right: 0,
        height: 60,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 2,
        opacity: 0.15,
      });
    });

    it('sits 120px above the card bottom by default, and honours an override', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);
      expect(staticStyleOf(view.getByTestId(ROW_TEST_ID)).bottom).toBe(120);

      const moved = await render(<WaveformBars clipId="clip-1" category="music" bottom={200} />);
      expect(staticStyleOf(moved.getByTestId(ROW_TEST_ID)).bottom).toBe(200);
    });

    it('gives every bar the source\'s 3px width and 2px radius', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);
      const style = staticStyleOf(view.getByTestId(barTestID(0)));

      expect(style.width).toBe(3);
      expect(style.borderRadius).toBe(2);
    });

    it('renders a still row for an unseedable clip instead of throwing', async () => {
      // `waveformSeed(null)` degrades to the empty-string seed, and a reel whose
      // clip is still loading must still paint.
      const view = await render(<WaveformBars clipId={null} category={null} />);

      expect(view.getAllByTestId(BAR_SELECTOR)).toHaveLength(BAR_COUNT);
      expect(staticStyleOf(view.getByTestId(barTestID(0))).height).toBe(
        baseHeight(0, waveformSeed(null)),
      );
    });
  });

  describe('transformOrigin — the constraint the maths cannot enforce', () => {
    it('is "bottom" on all 40 bars', async () => {
      // NOT catchable from `lib/waveform.ts`: RN scales about a view's CENTRE by
      // default, so without this every bar lifts off the baseline as it breathes
      // and the row detaches from the bottom of its box. The mirror image of the
      // negative-height bug, and invisible to the pure functions.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(staticStyleOf(view.getByTestId(barTestID(i))).transformOrigin).toBe('bottom');
      }
    });

    it('keeps it while the row animates, i.e. it is not part of the animated style', async () => {
      // If the origin were ever moved into the animated style it would have to
      // survive every frame; asserting it after time advances is what makes this
      // a static-style guarantee rather than a first-frame coincidence.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);

      await advance(LOOP_SECONDS * 250);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(staticStyleOf(view.getByTestId(barTestID(i))).transformOrigin).toBe('bottom');
      }
    });
  });

  describe('base × envelope composition', () => {
    it('renders baseHeight as the layout height, NOT barHeight', async () => {
      // The whole point of the split: the base is the multiplier's operand. If
      // `height` were the composed `barHeight`, the envelope would be applied
      // twice and `base * scaleY` would leave [MIN_BAR_HEIGHT, MAX_BAR_HEIGHT].
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(staticStyleOf(view.getByTestId(barTestID(i))).height).toBe(baseHeight(i, seed));
      }

      // ...and the composed value is demonstrably a different number, so this is
      // not a test that passes for both spellings.
      expect(baseHeight(7, seed)).not.toBe(baseHeight(7, seed) * envelope(7, 0, seed));
    });

    it('keeps every rendered bar inside the library\'s bounds, at both poses', async () => {
      // The invariant `MIN_BASE_HEIGHT * ENVELOPE_MIN >= MIN_BAR_HEIGHT` is what
      // makes this structural rather than a clamp, and it is the component that
      // has to honour it: `height` × `scaleY` is what the screen sees.
      for (const state of ['playing', 'paused'] as const) {
        const view = await render(
          <WaveformBars clipId={`bounds-${state}`} category="news" state={state} />,
        );

        for (let i = 0; i < BAR_COUNT; i += 1) {
          const base = staticStyleOf(view.getByTestId(barTestID(i))).height as number;
          const rendered = base * scaleYOf(view.getByTestId(barTestID(i)));
          expect(Number.isFinite(rendered)).toBe(true);
          expect(rendered).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
          expect(rendered).toBeLessThanOrEqual(MAX_BAR_HEIGHT);
        }
      }
    });

    it('gives the same row for a numeric id and its string spelling', async () => {
      // `models.py` ids arrive as numbers over the API and as strings through
      // route params. Different seeds would reshuffle the row by provenance.
      const numeric = await render(<WaveformBars clipId={7} category="music" />);
      const textual = await render(<WaveformBars clipId="7" category="music" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(staticStyleOf(numeric.getByTestId(barTestID(i))).height).toBe(
          staticStyleOf(textual.getByTestId(barTestID(i))).height,
        );
      }
    });

    it('does not reshuffle across re-renders, the Math.random() regression guard', async () => {
      // The source re-rolled `Math.random()` per bar per render, so the row
      // visibly changed on every React render. Re-rendering must be a no-op.
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);
      const before = Array.from({ length: BAR_COUNT }, (_, i) =>
        staticStyleOf(view.getByTestId(barTestID(i))).height,
      );

      for (let n = 0; n < 5; n += 1) {
        await act(async () => {
          view.rerender(<WaveformBars clipId="clip-1" category="music" />);
        });
      }

      const after = Array.from({ length: BAR_COUNT }, (_, i) =>
        staticStyleOf(view.getByTestId(barTestID(i))).height,
      );
      expect(after).toEqual(before);
      expect(before[0]).toBe(baseHeight(0, seed));
    });

    it('gives different clips different rows', async () => {
      const a = await render(<WaveformBars clipId="clip-0" category="music" />);
      const b = await render(<WaveformBars clipId="clip-1" category="music" />);

      const heights = (view: RenderResult): number[] =>
        Array.from({ length: BAR_COUNT }, (_, i) =>
          staticStyleOf(view.getByTestId(barTestID(i))).height as number,
        );

      expect(heights(a)).not.toEqual(heights(b));
    });
  });

  describe('gradient', () => {
    it('fills every bar with the clip\'s category colour, bottom to top', async () => {
      // `to top` is CSS 0deg, so the CATEGORY colour is the gradient's FIRST stop
      // and it lands at the BOTTOM of each bar (`start.y = 1`, `end.y = 0` — y
      // grows downward). 0 against 180 is the trap: the reverse still renders as
      // a plausible gradient, so only the numbers catch it.
      const view = await render(<WaveformBars clipId="clip-1" category="funny" />);
      const fills = gradientFills(view);
      const spec = gradients.waveformBar(categoryColor('funny'));

      expect(fills).toHaveLength(BAR_COUNT);
      for (const fill of fills) {
        expect(fill.props.colors).toEqual([
          processColor(categoryColor('funny')),
          processColor(brand.sage),
        ]);
        expect(fill.props.startPoint).toEqual([spec.start.x, spec.start.y]);
        expect(fill.props.endPoint).toEqual([spec.end.x, spec.end.y]);
      }

      // The claims themselves, so a shared-token change cannot pass unnoticed:
      // the category colour leads, sage trails, and the run is bottom → top.
      expect(spec.colors[0]).toBe(categoryColor('funny'));
      expect(spec.start).toEqual({ x: 0.5, y: 1 });
      expect(spec.end).toEqual({ x: 0.5, y: 0 });
    });

    it('re-colours the row when the category changes, rather than baking one colour', async () => {
      const funny = await render(<WaveformBars clipId="clip-1" category="funny" />);
      const science = await render(<WaveformBars clipId="clip-1" category="science" />);

      expect(firstStopOf(funny)).not.toEqual(firstStopOf(science));
      expect(firstStopOf(science)).toBe(processColor(categoryColor('science')));
    });

    it('colours every branded category distinctly, and falls back to neutral', async () => {
      const seen = new Set<unknown>();
      for (const { value, color } of BRANDED_CATEGORIES) {
        const view = await render(<WaveformBars clipId="clip-1" category={value} />);
        expect(firstStopOf(view)).toBe(processColor(color));
        seen.add(firstStopOf(view));
      }
      expect(seen.size).toBe(BRANDED_CATEGORIES.length);

      // Free-text category: an unknown value must still get a valid colour, not
      // an undefined stop.
      const unknown = await render(<WaveformBars clipId="clip-1" category="Cyberpunk" />);
      expect(firstStopOf(unknown)).toBe(processColor(categoryColor('Cyberpunk')));
      expect(categoryColor('Cyberpunk')).toBeTruthy();
    });

    it('covers the whole bar, so the fill is not a zero-size sliver', async () => {
      // The gradient sits on an absolutely-positioned child, so its size comes
      // from the bar's box. If the fill ever lost that, the row would be 40
      // flat-coloured bars.
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);

      expect(StyleSheet.flatten(gradientFills(view)[0]?.props.style as never)).toMatchObject({
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
      });
    });
  });

  describe('isActive gating', () => {
    it('holds the active row at 0.6 and the inactive row at 0.3', async () => {
      // The source's per-bar `isActive ? 0.6 : 0.3`. Read through
      // getAnimatedStyle because the value is animated (the source's
      // `transition: opacity 0.3s`); the initial value is the literal either way.
      const active = await render(<WaveformBars clipId="clip-1" category="music" isActive />);
      const idle = await render(<WaveformBars clipId="clip-1" category="music" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(opacityOf(active.getByTestId(barTestID(i)))).toBe(0.6);
        expect(opacityOf(idle.getByTestId(barTestID(i)))).toBe(0.3);
      }
    });

    it('moves to the active opacity when isActive flips, and is still moving at 0.15s', async () => {
      // The 0.3s transition is the source's, so the midpoint is genuinely between
      // the two values — which also proves the animation is live rather than a
      // re-render that swapped a constant.
      const view = await render(<WaveformBars clipId="clip-1" category="music" isActive={false} />);
      const bar = () => view.getByTestId(barTestID(0));
      expect(opacityOf(bar())).toBe(0.3);

      await act(async () => {
        view.rerender(<WaveformBars clipId="clip-1" category="music" isActive />);
      });
      await advance(150);

      const midway = opacityOf(bar());
      expect(midway).toBeGreaterThan(0.3);
      expect(midway).toBeLessThan(0.6);

      await advance(200);
      expect(opacityOf(bar())).toBe(0.6);
    });

    it('defaults to the inactive opacity', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);

      expect(opacityOf(view.getByTestId(barTestID(0)))).toBe(0.3);
    });
  });

  describe('animation — the non-vacuous part', () => {
    it('starts at the library\'s t=0 pose', async () => {
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(scaleYOf(view.getByTestId(barTestID(i)))).toBeCloseTo(
          envelopeFor(i, 0, seed, 'playing'),
          10,
        );
      }
    });

    it('changes scaleY as timers advance', async () => {
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);
      const bar = () => view.getByTestId(barTestID(20));

      const atRest = scaleYOf(bar());
      await advance(LOOP_SECONDS * 400);
      const later = scaleYOf(bar());
      await advance(LOOP_SECONDS * 200);
      const laterStill = scaleYOf(bar());

      expect(later).not.toBeCloseTo(atRest, 4);
      expect(laterStill).not.toBeCloseTo(later, 4);
    });

    it('tracks the library\'s envelope a quarter of the way into the loop', async () => {
      // The value is not merely "different", it is the library's own envelope at
      // the time the clock says. Loosened to 3dp because the sample position
      // inherits the timer clock's millisecond resolution; 1e-3 of an envelope is
      // a thousandth of a pixel on a bar.
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);

      await advance(LOOP_SECONDS * 250);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(scaleYOf(view.getByTestId(barTestID(i)))).toBeCloseTo(
          envelopeFor(i, LOOP_SECONDS * 0.25, seed, 'playing'),
          3,
        );
      }
    });

    it('returns to its starting pose after exactly one LOOP_SECONDS', async () => {
      // THE constraint-2 probe. The phase clock is animated with a duration
      // derived from the lib's period; if the two ever disagreed the row would
      // be somewhere else entirely when the period elapsed. The ceiling keeps the
      // advance at or past the wrap so a truncated timer tick cannot turn this
      // into a "one tick short" failure.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);
      const before = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );

      await advance(Math.ceil(LOOP_SECONDS * 1000));

      const after = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );
      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(after[i]).toBeCloseTo(before[i] ?? Number.NaN, 6);
      }
    });

    it('animates every bar, not just a few', async () => {
      // A per-bar bug (one shared transform, a stale index) would show up as
      // some bars frozen. Sampled at two points a quarter loop apart.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);
      const first = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );

      await advance(LOOP_SECONDS * 250);
      const second = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );

      const moved = second.filter((value, i) => Math.abs((value ?? 0) - (first[i] ?? 0)) > 0.001);
      // Outer bars breathe less than centre bars by design (centreWeight), so
      // not every bar is required to move by a given epsilon; a large majority
      // is, and a single shared transform would move none of them independently.
      expect(moved.length).toBeGreaterThan(BAR_COUNT * 0.8);
    });

    it('leaves props.style frozen while the live style moves (the false-pass trap)', async () => {
      // `element.props.style` is the INITIAL animated style and never updates, so
      // an assertion written against it passes with time standing still. Pinned
      // here for this component's own style shape, exactly as
      // `lib/__tests__/reanimatedHarness.test.tsx` pins it for the harness.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="playing" />);
      const bar = () => view.getByTestId(barTestID(20));
      const frozenScaleYOf = (): number =>
        ((staticStyleOf(bar()).transform as Array<{ scaleY?: number }>)?.[0]?.scaleY ??
          Number.NaN);

      const atRest = frozenScaleYOf();
      expect(atRest).toBeCloseTo(envelope(20, 0, waveformSeed('clip-1')), 10);

      await advance(LOOP_SECONDS * 300);

      // Time HAS advanced — proven by the live read...
      expect(scaleYOf(bar())).not.toBeCloseTo(atRest, 4);
      // ...while the prop a naive assertion would target has not moved at all.
      expect(frozenScaleYOf()).toBe(atRest);
    });
  });

  describe('paused is a pose, not an animation', () => {
    it('holds every bar at the library\'s paused envelope', async () => {
      const seed = waveformSeed('clip-1');
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="paused" />);

      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(scaleYOf(view.getByTestId(barTestID(i)))).toBeCloseTo(
          pausedEnvelope(i, seed),
          10,
        );
      }
    });

    it('does not move however long the clock runs', async () => {
      // `pausedEnvelope` ignores `t` entirely, so a paused row that drifts would
      // mean the component re-derived the pose per frame.
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="paused" />);
      const before = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );

      await advance(Math.ceil(LOOP_SECONDS * 1000) * 2);

      const after = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(view.getByTestId(barTestID(i))),
      );
      expect(after).toEqual(before);
    });

    it('is the default, so a caller that forgets `state` gets a still row', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" />);

      await advance(LOOP_SECONDS * 400);

      expect(scaleYOf(view.getByTestId(barTestID(0)))).toBeCloseTo(
        pausedEnvelope(0, waveformSeed('clip-1')),
        10,
      );
    });

    it('starts moving when the row switches to playing, and settles when it stops', async () => {
      const view = await render(<WaveformBars clipId="clip-1" category="music" state="paused" />);
      const bar = () => view.getByTestId(barTestID(20));
      const settled = scaleYOf(bar());

      await act(async () => {
        view.rerender(<WaveformBars clipId="clip-1" category="music" state="playing" />);
      });
      await advance(LOOP_SECONDS * 300);
      const moving = scaleYOf(bar());
      expect(moving).not.toBeCloseTo(settled, 3);

      await act(async () => {
        view.rerender(<WaveformBars clipId="clip-1" category="music" state="paused" />);
      });
      // The clock is cancelled and reset, so the paused pose is reached with no
      // easing tail — but a direct write to a shared value still has to travel
      // through `useAnimatedStyle`'s mapper, which needs one frame. Reading
      // before that flush is a stale value, not a slow animation.
      await advance(16);
      expect(scaleYOf(bar())).toBeCloseTo(settled, 6);

      // And it really is stopped, not merely back at the paused value once.
      await advance(Math.ceil(LOOP_SECONDS * 1000));
      expect(scaleYOf(bar())).toBeCloseTo(settled, 6);
    });
  });
});
