/**
 * Design-token tests.
 *
 * `src/design/**` is excluded from coverage in jest.config.js — the tokens are
 * the contract, not the rendered output — so nothing here exists to move a
 * coverage number. These exist for two reasons that are actually load-bearing:
 *
 *  1. `linearGradientPoints` converts a CSS angle into a unit-box point pair.
 *     A wrong direction is INVISIBLE in any assertion short of the numbers
 *     themselves — it renders as a plausible gradient. So the 135deg points are
 *     asserted exactly, not approximately, to stop a "tidy-up" quietly rotating
 *     the reel backdrop.
 *  2. `tint()` has three distinct input bugs and one type-level one. They are
 *     pinned here as *current* behaviour so that fixing one is a visible,
 *     deliberate edit to this file rather than a silent change to pixels.
 */

import {
  brand,
  gradients,
  linearGradientPoints,
  surface,
  tint,
  tintColor,
  tintSteps,
  type LinearGradientSpec,
  type TintStep,
} from '../tokens';
import { BRANDED_CATEGORIES, categoryColor } from '../categories';

/** Independent expected alphas, written out rather than read back off the
 *  table — recomputing from `tintSteps` would assert nothing. */
const EXPECTED_ALPHA: Record<TintStep, number> = {
  '08': 0.08,
  '0A': 0.1,
  '10': 0.0625,
  '18': 0.18,
  '22': 0.22,
  '33': 0.33,
  '44': 0.44,
  '55': 0.55,
};

describe('tintSteps', () => {
  it('carries the 8 steps the design source composes', () => {
    // `.sort()` is required: '10' is an integer-like object key, so JS hoists it
    // to the front of Object.keys() (`10 18 22 33 44 55 08 0A`) even though it
    // is written after '0A'. Asserting on the unsorted list would be asserting
    // on a JS engine quirk rather than on the scale.
    expect(Object.keys(tintSteps).sort()).toEqual(['08', '0A', '10', '18', '22', '33', '44', '55']);
  });

  it("adds '10' for the reel backdrop, ordered by hex byte", () => {
    // `${c}10` in ReelCard.tsx:103 is a string concat, so the step has to match
    // the literal suffix '0x10' exactly — it is not '0A' and not a rounding of
    // '18'. Ordering is by hex byte, which is the only self-consistent reading:
    // 0.0625 sorts *below* '0A' = 0.1 numerically.
    expect(tintSteps['10']).toBe(0.0625);
    expect(parseInt('10', 16)).toBe(16);
    expect(16 / 256).toBe(0.0625);
  });

  it('maps every step to the value the table claims', () => {
    for (const key of Object.keys(tintSteps).sort() as TintStep[]) {
      expect(tintSteps[key]).toBe(EXPECTED_ALPHA[key]);
    }
  });
});

describe('tint()', () => {
  it('composes every step of the scale onto one colour', () => {
    for (const key of Object.keys(tintSteps).sort() as TintStep[]) {
      expect(tint('#e8a87c', key)).toBe(`rgba(232, 168, 124, ${EXPECTED_ALPHA[key]})`);
    }
  });

  it('emits the new 10 step at the backdrop value', () => {
    expect(tint('#e8a87c', '10')).toBe('rgba(232, 168, 124, 0.0625)');
  });

  // These pin bugs that are NOT fixed. `tint()` requires `` `#${string}` `` and
  // slices blindly, so anything that is not a 6-digit `#`-prefixed hex comes
  // back as plausible-looking garbage rather than an error. Verified by running.
  // If these ever start throwing, that is the fix landing — update them then.
  it('BUG: yields NaN for a 3-digit hex, silently', () => {
    // slice(1,3)='ff' -> 255, slice(3,5)='f' -> 15, slice(5,7)='' -> NaN.
    expect(tint('#fff', '10')).toBe('rgba(255, 15, NaN, 0.0625)');
  });

  it('BUG: yields a wrong-but-NaN-free colour when the # is missing', () => {
    // The dangerous one: three real numbers, so nothing anywhere marks it as
    // bad. '9d8e84' is `content.tertiary` minus its '#' — the exact value
    // `categoryColor()` would return if its neutral were ever dropped.
    expect(tint('9d8e84' as `#${string}`, '10')).toBe('rgba(216, 232, 4, 0.0625)');
  });

  it('BUG: silently discards the alpha of an 8-digit hex', () => {
    // '#e8a87c80' is 50% black-transparent; it comes back fully opaque-ish with
    // the step's alpha instead of the byte's.
    expect(tint('#e8a87c80' as `#${string}`, '10')).toBe('rgba(232, 168, 124, 0.0625)');
  });

  it('BUG: is not callable with the string categoryColor() returns', () => {
    // Type-level, and the reason `tintColor` exists. `categoryColor` is typed
    // `string` (categories.ts:75) and `tint` wants `` `#${string}` ``, so the
    // composition the reel backdrop actually needs is a TS2345. The
    // `@ts-expect-error` IS the assertion here — `npx tsc --noEmit` is what runs
    // it. If a future change widens `tint`, that line stops being an error, tsc
    // fails, and the signal is to delete `tintColor`.
    //
    // Note the mismatch runs in BOTH directions: the signature rejects this
    // perfectly valid 6-digit hex, while happily accepting '#fff' and '9d8e84'
    // (above), which it renders incorrectly. The type is simultaneously too
    // strict and too loose.
    const c: string = categoryColor('music');
    // @ts-expect-error TS2345: 'string' is not assignable to '`#${string}`'
    tint(c, '10');
    // ...and at runtime the same call happens to be correct, because the value
    // really is a well-formed hex. The type error is the only thing standing
    // between a caller and a cast, which is the point.
    expect(tint(c as `#${string}`, '10')).toBe('rgba(255, 107, 53, 0.0625)');
    expect(tint(c as `#${string}`, '10')).toBe(tintColor(c, '10'));
  });
});

describe('tintColor()', () => {
  it('agrees with tint() on a well-formed 6-digit hex', () => {
    for (const key of Object.keys(tintSteps).sort() as TintStep[]) {
      expect(tintColor('#9d8e84', key)).toBe(tint('#9d8e84', key));
    }
  });

  it('accepts what categoryColor() actually returns', () => {
    for (const { value, color } of BRANDED_CATEGORIES) {
      expect(tintColor(categoryColor(value), '10')).toBe(
        `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(
          color.slice(5, 7),
          16,
        )}, 0.0625)`,
      );
    }
  });

  it('expands 3-digit shorthand instead of emitting NaN', () => {
    expect(tintColor('#f0a', '18')).toBe('rgba(255, 0, 170, 0.18)');
    expect(tintColor('#fff', '10')).toBe('rgba(255, 255, 255, 0.0625)');
  });

  it('tolerates a missing # prefix, where tint() produces a wrong colour', () => {
    expect(tintColor('9d8e84', '22')).toBe('rgba(157, 142, 132, 0.22)');
    expect(tintColor('f0a', '18')).toBe('rgba(255, 0, 170, 0.18)');
    // The contrast is the point: same input, tint() gives three plausible
    // numbers that are not the colour asked for.
    expect(tintColor('9d8e84', '22')).not.toBe(tint('9d8e84' as `#${string}`, '22'));
  });

  it("keeps an 8-digit hex's own alpha rather than the step's", () => {
    // 0x80 = 128 -> 128/255 = 0.50196…, not the '18' step's 0.18. This is the
    // behaviour `tint()` cannot express at all — it has no way to see the byte.
    // NB 8 digits is `#rrggbbaa`; `#f0a818` is only 6 (`#rrggbb`) and has no
    // alpha to keep, so it correctly falls through to the step.
    expect(tintColor('#f0a81880', '18')).toBe('rgba(240, 168, 24, 0.5019607843137255)');
    expect(tintColor('#f0a818', '18')).toBe('rgba(240, 168, 24, 0.18)');
  });

  it('is case-insensitive', () => {
    expect(tintColor('#E8A87C', '10')).toBe(tintColor('#e8a87c', '10'));
  });

  it('throws on non-hex rather than emitting rgba(NaN, …)', () => {
    // A loud failure in a token function beats an invisible wrong colour. Every
    // real caller passes one of six literals from categories.ts, so this is
    // unreachable in production and diagnostic when it is not.
    for (const bad of ['', 'rgb(1,2,3)', '#12345', 'zzzzzz', 'nope']) {
      expect(() => tintColor(bad, '10')).toThrow(/expected a 3-, 6- or 8-digit hex/);
    }
  });
});

describe('linearGradientPoints()', () => {
  it('derives the 135deg points asserted to full precision', () => {
    // d = (sin135, -cos135) = (0.70711, 0.70711); anchored at the centre,
    // d/2 = sqrt(2)/4 = 0.353553, so start 0.5-0.353553 and end 0.5+0.353553.
    // Exact equality on purpose: `toBeCloseTo` would pass for a rotation.
    expect(linearGradientPoints(135)).toEqual({
      start: { x: 0.146447, y: 0.146447 },
      end: { x: 0.853553, y: 0.853553 },
    });
  });

  it('produces a true 45deg line for 135deg, symmetric about the centre', () => {
    const { start, end } = linearGradientPoints(135);
    expect((end.y - start.y) / (end.x - start.x)).toBe(1);
    expect(start.x + end.x).toBe(1);
    expect(start.y + end.y).toBe(1);
    // Top-left to bottom-right: both deltas positive, y growing downward.
    expect(end.x).toBeGreaterThan(start.x);
    expect(end.y).toBeGreaterThan(start.y);
  });

  it("reproduces expo-linear-gradient's documented defaults at 180deg", () => {
    // LinearGradient.d.ts: `@default { x: 0.5, y: 0.0 }` / `{ x: 0.5, y: 1.0 }`.
    // This is the sign-convention check: y grows downward, so the library's
    // default is `to bottom` = 180deg, NOT 0deg. Getting it backwards is what
    // a 0deg-anchored implementation looks like, and it is invisible on screen
    // because a vertical gradient is a vertical gradient either way.
    expect(linearGradientPoints(180)).toEqual({
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
    });
  });

  it('returns the four cardinal angles exactly, not approximately', () => {
    // Math.sin(PI) is 1.22e-16, not 0, so an unrounded 180deg gives
    // x = 0.4999999999999999. The 6dp rounding in the helper is load-bearing.
    expect(linearGradientPoints(0)).toEqual({ start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } });
    expect(linearGradientPoints(90)).toEqual({ start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } });
    expect(linearGradientPoints(270)).toEqual({ start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } });
  });

  it('orients 0deg as to top, so the first colour is at the bottom', () => {
    // ReelCard.tsx:180's `to top`: the category colour leads at the BOTTOM of
    // each bar and sage sits at the top. start.y = 1 is the bottom edge.
    const { start, end } = linearGradientPoints(0);
    expect(start.y).toBe(1);
    expect(end.y).toBe(0);
  });

  it('reverses direction across 180 degrees on the same line', () => {
    // 135deg and 315deg draw the same line, opposite travel. Encoding only the
    // magnitude is what makes the direction auditable.
    const a = linearGradientPoints(135);
    const b = linearGradientPoints(315);
    expect(b.start).toEqual(a.end);
    expect(b.end).toEqual(a.start);
  });
});

describe('gradients', () => {
  const MUSIC = '#ff6b35';
  const SPECS: [string, () => LinearGradientSpec][] = [
    ['reelBackdrop', () => gradients.reelBackdrop(MUSIC)],
    ['progressFill', () => gradients.progressFill(MUSIC)],
    ['waveformBar', () => gradients.waveformBar(MUSIC)],
  ];

  it('is directly splattable into <LinearGradient>', () => {
    // The point of typing the spec as a Pick of the library's own props. If the
    // public prop names or the tuple arity ever change, tsc fails here.
    const props: LinearGradientSpec = gradients.brand;
    expect(props.colors).toEqual([brand.terracotta, brand.terracottaHover]);
  });

  it('brand is the 135deg terracotta -> accent-hover pair, no explicit stops', () => {
    // molecules.tsx:24: linear-gradient(135deg, var(--terracotta),
    // var(--accent-hover)). No stop positions in the source, so `locations` is
    // omitted rather than pinned — the even spread is the library default and
    // the source expresses it by not expressing it.
    expect(gradients.brand.colors).toEqual(['#e8a87c', '#d4956a']);
    expect(gradients.brand.colors).toHaveLength(2);
    expect('locations' in gradients.brand).toBe(false);
    expect(gradients.brand.start).toEqual({ x: 0.146447, y: 0.146447 });
    expect(gradients.brand.end).toEqual({ x: 0.853553, y: 0.853553 });
  });

  it('reelBackdrop is the 3-stop 135deg gradient with explicit locations', () => {
    // ReelCard.tsx:103: linear-gradient(135deg, ${c}10 0%, ${c}22 50%,
    // #121416 100%). The only gradient here with stop positions.
    const spec = gradients.reelBackdrop(MUSIC);
    expect(spec.colors).toEqual([
      'rgba(255, 107, 53, 0.0625)',
      'rgba(255, 107, 53, 0.22)',
      '#121416',
    ]);
    expect(spec.colors).toHaveLength(3);
    expect(spec.locations).toEqual([0, 0.5, 1]);
    expect(spec.start).toEqual({ x: 0.146447, y: 0.146447 });
    expect(spec.end).toEqual({ x: 0.853553, y: 0.853553 });
  });

  it('reelBackdrop ends on the app background, not black', () => {
    // #121416 verbatim from the source; a drifted literal here would show as a
    // visible seam where the gradient meets an uncovered card edge.
    expect(gradients.reelBackdrop(MUSIC).colors[2]).toBe(surface.base);
    expect(surface.base).toBe('#121416');
  });

  it('progressFill runs 90deg, category colour on the left', () => {
    // WaveformBar.tsx:36: linear-gradient(90deg, ${c}, var(--terracotta)).
    // 90deg is `to right`; the reverse would put the playhead colour on the
    // wrong side of the wipe.
    const spec = gradients.progressFill(MUSIC);
    expect(spec.colors).toEqual([MUSIC, brand.terracotta]);
    expect(spec.colors).toHaveLength(2);
    expect(spec.locations).toBeUndefined();
    expect(spec.start).toEqual({ x: 0, y: 0.5 });
    expect(spec.end).toEqual({ x: 1, y: 0.5 });
  });

  it('waveformBar runs to top, category colour at the bottom', () => {
    // ReelCard.tsx:180: linear-gradient(to top, ${c}, var(--sage)) on each of
    // the 40 bars. `to top` is 0deg, so the FIRST colour is at the bottom.
    const spec = gradients.waveformBar(MUSIC);
    expect(spec.colors).toEqual([MUSIC, brand.sage]);
    expect(spec.colors).toHaveLength(2);
    expect(spec.locations).toBeUndefined();
    expect(spec.start).toEqual({ x: 0.5, y: 1 });
    expect(spec.end).toEqual({ x: 0.5, y: 0 });
  });

  it('threads the category colour through every category-derived gradient', () => {
    // The whole point of the parameter: these are not baked hexes. Each of the
    // 5 branded colours must actually appear, or the reel would look identical
    // across categories.
    for (const { value, color } of BRANDED_CATEGORIES) {
      const c = categoryColor(value);
      expect(c).toBe(color);
      expect(gradients.progressFill(c).colors[0]).toBe(color);
      expect(gradients.waveformBar(c).colors[0]).toBe(color);
      // rgba form for the tinted backdrop stops.
      expect(gradients.reelBackdrop(c).colors[0]).toContain(
        `${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(
          color.slice(5, 7),
          16,
        )}`,
      );
    }
  });

  it('falls back to the neutral for an unknown category, without a new colour', () => {
    // `category` is free text, so this is a normal input, not an error path.
    const c = categoryColor('Krautrock');
    expect(gradients.waveformBar(c).colors[0]).toBe(c);
    expect(gradients.progressFill(c).colors[0]).toBe(c);
  });

  it('gives every spec 2+ colours and, if it has locations, matching ascending ones', () => {
    // expo-linear-gradient's documented constraint: locations must be the same
    // length as colors and ascending least-to-greatest. A mismatch is a
    // platform-level failure, not a visual near-miss, so it gets checked.
    // `null` is the library's other spelling of "no explicit locations" (the
    // builders omit the key instead), so it counts as absent here too.
    for (const [name, build] of SPECS) {
      const spec = build();
      expect(spec.colors.length).toBeGreaterThanOrEqual(2);
      const { locations } = spec;
      if (locations != null) {
        expect(locations).toHaveLength(spec.colors.length);
        expect([...locations].sort((a, b) => a - b)).toEqual([...locations]);
      }
    }
  });

  it('keeps every start/end inside the 0..1 unit box', () => {
    for (const build of [() => gradients.brand, ...SPECS.map(([, b]) => b)]) {
      const { start, end } = build();
      for (const p of [start, end]) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
  });
});
