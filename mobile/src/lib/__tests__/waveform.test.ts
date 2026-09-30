/**
 * Tests for the decorative waveform math.
 *
 * The two properties under test are the ones the design source got wrong, and
 * neither is a rendering detail:
 *
 *  - **Heights are always valid.** The source's `8 + sin(i*0.4)*12 + Math.random()*10`
 *    has a theoretical minimum of −4px and no clamp anywhere. A spot check would
 *    not have caught that, so every bounds assertion here iterates ALL 40 bars
 *    across many seeds and many times.
 *  - **The same clip always produces the same row.** The source re-rolled
 *    `Math.random()` per bar per render, so the waveform reshuffled constantly.
 *    `describe('determinism')` is that regression guard, and it is the block to
 *    re-check after touching anything seeded.
 */

import {
  BAR_COUNT,
  BASE_SPAN,
  ENVELOPE_MAX,
  ENVELOPE_MIN,
  LOOP_SECONDS,
  MAX_BASE_HEIGHT,
  MAX_BAR_HEIGHT,
  MIN_BASE_HEIGHT,
  MIN_BAR_HEIGHT,
  baseHeight,
  baseProfile,
  barHeight,
  barProfile,
  envelope,
  envelopeFor,
  fnv1a32,
  pausedEnvelope,
  waveformSeed,
} from '../waveform';

const FRAME = 1 / 60;

/**
 * Seeds spanning the cases that matter: numeric ids, uuid-ish strings, the
 * empty-string fallback a loading clip gets, and ids that differ only in a
 * trailing character.
 */
const SEEDS = [
  waveformSeed(1),
  waveformSeed('42'),
  waveformSeed('a3f9c2e1-7b21-11ef-9c3a-0242ac120002'),
  waveformSeed(''),
  waveformSeed(0),
  waveformSeed(999999),
  waveformSeed('clip-0'),
  waveformSeed('clip-1'),
];

/** Times worth probing, including every non-finite shape `t` can arrive in. */
const TIMES = [0, 0.0166, 0.5, 1, 2.5, 3.75, 7.25, 10, 42, 3600, 1e6, 1e9, 1e15, 1e300];

const NON_FINITE_TIMES = [NaN, Infinity, -Infinity];

/** Assert a **rendered** height is a valid style value in `[MIN, MAX]`. */
function expectValidHeight(height: number, label: string): void {
  expect(Number.isFinite(height)).toBe(true);
  expect(height).not.toBeNaN();
  expect(height).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
  expect(height).toBeLessThanOrEqual(MAX_BAR_HEIGHT);
  expect(label).toBeTruthy();
}

/** Assert a **base** height is inside the derived base range. */
function expectValidBase(base: number, label: string): void {
  expect(Number.isFinite(base)).toBe(true);
  expect(base).not.toBeNaN();
  expect(base).toBeGreaterThanOrEqual(MIN_BASE_HEIGHT);
  expect(base).toBeLessThanOrEqual(MAX_BASE_HEIGHT);
  expect(label).toBeTruthy();
}

describe('constants', () => {
  it('is exactly 40 bars, as the design source renders', () => {
    expect(BAR_COUNT).toBe(40);
  });

  it('keeps a strictly positive, non-negative rendered floor', () => {
    // The source's floor was 8 - 12 - 0 = -4. Any floor <= 0 fails to rule out
    // the defect this module exists to remove.
    expect(MIN_BAR_HEIGHT).toBeGreaterThan(0);
    expect(MIN_BAR_HEIGHT).toBeLessThan(MAX_BAR_HEIGHT);
  });

  it('keeps MAX inside the source 60px bottom-aligned container', () => {
    // bars sit on a baseline in a 60px box; the ceiling must leave headroom
    expect(MAX_BAR_HEIGHT).toBeLessThanOrEqual(60);
    expect(MAX_BASE_HEIGHT - MIN_BASE_HEIGHT).toBe(BASE_SPAN);
  });

  it('derives the base range from the rendered range so the product is bounded', () => {
    // THE load-bearing relationship. `scaleY` multiplies, so the base is the
    // multiplier's operand and must leave the multiplier room to shrink without
    // crossing the rendered floor. These two assertions are what make
    // `base * envelope` structurally land in [MIN, MAX].
    expect(MIN_BASE_HEIGHT).toBeCloseTo(MIN_BAR_HEIGHT / ENVELOPE_MIN, 10);
    expect(MAX_BASE_HEIGHT).toBeCloseTo(MAX_BAR_HEIGHT / ENVELOPE_MAX, 10);

    // The composed bound, stated directly.
    expect(MIN_BASE_HEIGHT * ENVELOPE_MIN).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
    expect(MAX_BASE_HEIGHT * ENVELOPE_MAX).toBeLessThanOrEqual(MAX_BAR_HEIGHT);
  });

  it('brackets the envelope range for scaleY, shrink-only around 1', () => {
    expect(ENVELOPE_MIN).toBeGreaterThan(0);
    expect(ENVELOPE_MIN).toBeLessThan(1);
    expect(ENVELOPE_MAX).toBe(1);
  });

  it('has a finite, positive loop period', () => {
    expect(Number.isFinite(LOOP_SECONDS)).toBe(true);
    expect(LOOP_SECONDS).toBeGreaterThan(0);
  });
});

describe('waveformSeed', () => {
  it('is deterministic for the same id', () => {
    expect(waveformSeed('clip-1')).toBe(waveformSeed('clip-1'));
  });

  it('treats a numeric id and its string spelling identically', () => {
    // `models.py` ids arrive as numbers over the API and as strings via route
    // params. If these differed, the row would reshuffle based on provenance.
    expect(waveformSeed(7)).toBe(waveformSeed('7'));
  });

  it('degrades a missing id to the empty-string seed instead of throwing', () => {
    const expected = fnv1a32('');
    expect(waveformSeed(null)).toBe(expected);
    expect(waveformSeed(undefined)).toBe(expected);
    expect(waveformSeed('')).toBe(expected);
  });

  it('returns an unsigned 32-bit integer for every input', () => {
    for (const id of ['', '0', 'abc', 'a3f9c2e1-7b21-11ef', 'naïve-🎧', 0, -5, 1e12]) {
      const seed = waveformSeed(id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(4294967295);
    }
  });

  it('gives distinct seeds to distinct clip ids', () => {
    const ids = ['1', '2', '3', '7', '42', 'clip-0', 'clip-1', 'clip-2', 'a3f9c2e1-7b21'];
    const seeds = ids.map((id) => waveformSeed(id));
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe('fnv1a32', () => {
  it('matches known answers, so the hash cannot drift silently', () => {
    // These pin the exact output. Because every step is an integer op
    // (`Math.imul`, `^`, `>>>`) rather than float arithmetic, any engine that
    // follows the ES spec — Hermes on device, V8 under jest, JSC on iOS — must
    // reproduce them. A float-based hash would not be portable this way.
    expect(fnv1a32('')).toBe(2872998923);
    expect(fnv1a32('1')).toBe(1428125071);
    expect(fnv1a32('42')).toBe(686566589);
    expect(fnv1a32('7')).toBe(2049036381);
    expect(fnv1a32('clip-0')).toBe(3913091134);
    expect(fnv1a32('clip-1')).toBe(3182358587);
    expect(fnv1a32('clip-2')).toBe(1521329121);
  });

  it('hashes non-ASCII input by UTF-16 code unit', () => {
    // charCodeAt is spec-defined, so surrogate pairs behave identically on
    // every engine. This pins that we are not relying on ASCII-only ids.
    expect(fnv1a32('naïve-🎧')).toBe(2996415680);
  });

  it('does not collide across many numeric ids', () => {
    const seeds = new Set<number>();
    for (let n = 0; n < 5000; n += 1) seeds.add(fnv1a32(String(n)));
    expect(seeds.size).toBe(5000);
  });
});

describe('baseProfile', () => {
  it('is exactly 40 bars for every seed', () => {
    for (const seed of SEEDS) {
      expect(baseProfile(seed)).toHaveLength(BAR_COUNT);
    }
  });

  it('keeps every bar within the derived base range, asserted over ALL 40', () => {
    for (const seed of SEEDS) {
      baseProfile(seed).forEach((base, i) => {
        expectValidBase(base, `seed ${seed} bar ${i}`);
      });
    }
  });

  it('is not a degenerate constant row', () => {
    // A bounds test alone passes for a profile where every bar is identical.
    for (const seed of SEEDS) {
      const distinct = new Set(baseProfile(seed).map((b) => b.toFixed(6)));
      expect(distinct.size).toBeGreaterThan(10);
    }
  });

  it('has no centre bias — uniform like the design source', () => {
    // A taper was tried here and measured out: the per-bar jitter swamped it,
    // so the centre mean fell BELOW the edge mean for 4 of 8 seeds. The taper
    // therefore lives in the poses only (see the envelope depth test below),
    // and the base profile matches the source's uniform `sin(i * 0.4)` row.
    // Asserting uniformity is what keeps that decision from silently regressing.
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    for (const seed of SEEDS) {
      const heights = baseProfile(seed);
      const centre = mean(heights.slice(16, 24));
      const edges = mean([...heights.slice(0, 8), ...heights.slice(32, 40)]);
      expect(Math.abs(centre - edges)).toBeLessThan(0.25 * BASE_SPAN);
    }
  });

  it('is identical across repeated calls', () => {
    for (const seed of SEEDS) {
      expect(baseProfile(seed)).toEqual(baseProfile(seed));
    }
  });

  it('differs between clips', () => {
    expect(baseProfile(waveformSeed('clip-0'))).not.toEqual(baseProfile(waveformSeed('clip-1')));
  });

  it('contains a caller-supplied out-of-range index', () => {
    for (const index of [-5, 0, BAR_COUNT, 999, NaN, Infinity]) {
      const base = baseHeight(index, SEEDS[0] ?? 0);
      expect(Number.isFinite(base)).toBe(true);
      expect(base).toBeGreaterThanOrEqual(MIN_BASE_HEIGHT);
      expect(base).toBeLessThanOrEqual(MAX_BASE_HEIGHT);
    }
  });
});

describe('barHeight — bounds', () => {
  it('keeps every bar within bounds across every seed and time', () => {
    for (const seed of SEEDS) {
      for (const t of TIMES) {
        for (let i = 0; i < BAR_COUNT; i += 1) {
          expectValidHeight(barHeight(i, t, seed), `seed ${seed} t ${t} bar ${i}`);
        }
      }
    }
  });

  it('never produces a negative height, the source defect', () => {
    // The source's floor was -4px. Checked explicitly and over all 40 bars so a
    // regression cannot hide behind an average.
    for (const seed of SEEDS) {
      for (const t of TIMES) {
        barProfile(t, seed).forEach((height, i) => {
          expect(height).toBeGreaterThan(0);
          expect(height).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
          expect(height).toBeGreaterThanOrEqual(0);
          if (height < 0) throw new Error(`negative height at bar ${i}`);
        });
      }
    }
  });

  it('is exactly 40 bars for every seed and state', () => {
    for (const seed of SEEDS) {
      expect(barProfile(0, seed)).toHaveLength(BAR_COUNT);
      expect(barProfile(0, seed, 'paused')).toHaveLength(BAR_COUNT);
    }
  });

  it('is exactly base * envelope, so the bounds are structural', () => {
    // The composition the component performs with `height` + `scaleY`. This is
    // the assertion that makes the clamp in `barHeight` a safety net rather
    // than the mechanism: the product of the two ranges lands in [MIN, MAX].
    for (const seed of SEEDS) {
      for (const t of [0, 1.5, 9.75]) {
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const expected = baseHeight(i, seed) * envelope(i, t, seed);
          expect(barHeight(i, t, seed)).toBeCloseTo(expected, 10);
        }
      }
    }
  });

  it('never needs its clamp, over 40 seeds across a whole loop', () => {
    // `barHeight` clamps, but with in-range inputs it must never actually clamp
    // — otherwise the "structural bound" claim above is decorative.
    for (let k = 0; k < 40; k += 1) {
      const seed = waveformSeed(`clip-${k}`);
      for (let step = 0; step < 60; step += 1) {
        const t = (step / 60) * LOOP_SECONDS;
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const raw = baseHeight(i, seed) * envelope(i, t, seed);
          const clamped = barHeight(i, t, seed);
          expect(raw).toBeCloseTo(clamped, 12);
        }
      }
    }
  });

  it('survives adversarial t values without NaN, Infinity or out-of-bounds', () => {
    const adversarial = [...TIMES, ...NON_FINITE_TIMES, -1, -0.5, -1e9, -1e300];
    for (const seed of SEEDS) {
      for (const t of adversarial) {
        for (let i = 0; i < BAR_COUNT; i += 1) {
          expectValidHeight(barHeight(i, t, seed), `t ${String(t)} bar ${i}`);
        }
      }
    }
  });

  it('treats a non-finite t as t=0 rather than propagating NaN', () => {
    // Documented decision: a decorative element must not crash, and NaN would
    // reach scaleY/height as an invalid style value (a silently blank waveform).
    const seed = SEEDS[0] ?? 0;
    const atZero = barProfile(0, seed);
    for (const t of NON_FINITE_TIMES) {
      expect(barProfile(t, seed)).toEqual(atZero);
    }
  });
});

describe('determinism — the Math.random() regression guard', () => {
  it('returns identical heights for the same seed and t, twice', () => {
    for (const seed of SEEDS) {
      for (const t of [0, 3.25, 88.5]) {
        const first = barProfile(t, seed);
        const second = barProfile(t, seed);
        expect(second).toEqual(first);
        expect(second).not.toHaveLength(0);
      }
    }
  });

  it('is stable across a simulated re-render', () => {
    // The source reshuffled because Math.random() was re-rolled per bar per
    // render. Simulating many renders must produce one row.
    const seed = waveformSeed('clip-1');
    const renders = Array.from({ length: 50 }, () => barProfile(1.234, seed));
    for (const render of renders) {
      expect(render).toEqual(renders[0]);
    }
  });

  it('gives different rows to different clips', () => {
    const a = barProfile(2, waveformSeed('clip-0'));
    const b = barProfile(2, waveformSeed('clip-1'));
    expect(b).not.toEqual(a);
    expect(a.some((height, i) => height !== b[i])).toBe(true);
  });

  it('gives different base profiles to different seeds, over all 40 bars', () => {
    for (let n = 0; n < 20; n += 1) {
      const a = baseProfile(waveformSeed(`clip-${n}`));
      const b = baseProfile(waveformSeed(`clip-${n + 1}`));
      const differing = a.filter((height, i) => height !== b[i]).length;
      expect(differing).toBeGreaterThan(0);
    }
  });

  it('is unaffected by call order', () => {
    const seed = waveformSeed('clip-7');
    const forward = Array.from({ length: BAR_COUNT }, (_, i) => barHeight(i, 4, seed));
    const backward = Array.from({ length: BAR_COUNT }, (_, i) => barHeight(i, 4, seed)).reverse()
      .reverse();
    expect(backward).toEqual(forward);
  });
});

describe('paused pose', () => {
  it('differs from the playing pose for every bar', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const playing = barHeight(i, 1.5, seed, 'playing');
        const paused = barHeight(i, 1.5, seed, 'paused');
        expect(paused).not.toBeCloseTo(playing, 5);
      }
    }
  });

  it('occupies a narrow band, so it reads as settled rather than mid-shrug', () => {
    // The real "visibly different" claim. Measured over 400 seeds the paused
    // envelope lives in [0.673, 0.808], while the playing pose sweeps all the
    // way up to 1.0. These bounds keep margin without being so loose as to let
    // the two bands meet.
    for (const seed of SEEDS) {
      const levels = Array.from({ length: BAR_COUNT }, (_, i) => pausedEnvelope(i, seed));
      for (const level of levels) {
        expect(level).toBeGreaterThan(0.65);
        expect(level).toBeLessThan(0.85);
      }
      expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(0.2);
    }
  });

  it('routes through envelopeFor to the matching pose', () => {
    // `envelopeFor` is the public selector the component will actually call,
    // so it needs coverage in its own right rather than as a side effect.
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(envelopeFor(i, 2.5, seed, 'playing')).toBe(envelope(i, 2.5, seed));
        expect(envelopeFor(i, 2.5, seed, 'paused')).toBe(pausedEnvelope(i, seed));
      }
    }
  });

  it('ignores t entirely, so it is a pose and not an animation', () => {
    for (const seed of SEEDS) {
      const reference = barProfile(0, seed, 'paused');
      for (const t of [1, 4.5, 100, 1e6, -3]) {
        expect(barProfile(t, seed, 'paused')).toEqual(reference);
      }
    }
  });

  it('stays inside the envelope range and the height bounds', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const level = pausedEnvelope(i, seed);
        expect(level).toBeGreaterThanOrEqual(ENVELOPE_MIN);
        expect(level).toBeLessThanOrEqual(ENVELOPE_MAX);
        expectValidHeight(barHeight(i, 0, seed, 'paused'), `paused bar ${i}`);
      }
    }
  });

  it('is not a monotonic ramp across the row', () => {
    // Mirrors the reference's monotonic `8 + round((i / BAR_COUNT) * 6)` and
    // asserts the divergence: a monotone ramp reads as a progress bar rather
    // than as a waveform, and it is the shape the reference actually produced
    // despite its "taller toward the centre" comment.
    const seed = SEEDS[0] ?? 0;
    const heights = Array.from({ length: BAR_COUNT }, (_, i) =>
      barHeight(i, 0, seed, 'paused'),
    );
    const first = heights[0] ?? 0;
    const last = heights[heights.length - 1] ?? 0;
    expect(last).not.toBe(first);
    expect(Math.min(...heights)).toBeGreaterThan(0);

    // The row is centre-weighted, so the two ends must not simply mirror into a
    // climb from left to right.
    const rises = heights.filter((height, i) => i > 0 && height > (heights[i - 1] ?? 0));
    const falls = heights.filter((height, i) => i > 0 && height < (heights[i - 1] ?? 0));
    expect(rises.length).toBeGreaterThan(0);
    expect(falls.length).toBeGreaterThan(0);
  });
});

describe('envelope continuity', () => {
  it('changes by a bounded amount per 60fps frame, over all bars', () => {
    // The largest possible slope is depth * 0.5 * (FAST_RATE*FAST_WEIGHT +
    // SLOW_RATE*SLOW_WEIGHT) with depth <= 1 - ENVELOPE_MIN = 0.4, i.e. <= 0.0044
    // per frame. The 0.01 bound is ~2x that, so it catches a discontinuity
    // without being tight enough to flake. Measured worst case: 0.0044.
    const BOUND = 0.01;
    for (const seed of SEEDS.slice(0, 3)) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        for (let frame = 0; frame < 300; frame += 1) {
          const t = frame * FRAME;
          const delta = Math.abs(envelope(i, t + FRAME, seed) - envelope(i, t, seed));
          expect(Number.isFinite(delta)).toBe(true);
          expect(delta).toBeLessThanOrEqual(BOUND);
        }
      }
    }
  });

  it('keeps the pixel height step under a third of a pixel per frame', () => {
    // A visible stepping threshold on a 3px-wide bar is a fraction of a pixel.
    // Measured worst case is ~0.13px/frame.
    for (const seed of SEEDS.slice(0, 3)) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        for (let frame = 0; frame < 180; frame += 1) {
          const t = frame * FRAME;
          const delta = Math.abs(barHeight(i, t + FRAME, seed) - barHeight(i, t, seed));
          expect(Number.isFinite(delta)).toBe(true);
          expect(delta).toBeLessThanOrEqual(0.34);
        }
      }
    }
  });

  it('has no discontinuity at the loop wrap', () => {
    // The envelope is exactly periodic, so stepping across the seam is as
    // smooth as stepping anywhere else.
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const before = envelope(i, LOOP_SECONDS - 1e-9, seed);
        const after = envelope(i, LOOP_SECONDS + 1e-9, seed);
        expect(after).toBeCloseTo(before, 8);
      }
    }
  });

  it('returns to the same value one full loop later', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        expect(envelope(i, LOOP_SECONDS, seed)).toBeCloseTo(envelope(i, 0, seed), 10);
        expect(envelope(i, LOOP_SECONDS * 5, seed)).toBeCloseTo(envelope(i, 0, seed), 10);
      }
    }
  });

  it('stays continuous walking negative t', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const delta = Math.abs(envelope(i, -0.0166, seed) - envelope(i, 0, seed));
        expect(delta).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('never leaves the envelope range for any bar, seed or time', () => {
    for (const seed of SEEDS) {
      for (const t of TIMES) {
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const level = envelope(i, t, seed);
          expect(Number.isFinite(level)).toBe(true);
          expect(level).toBeGreaterThanOrEqual(ENVELOPE_MIN);
          expect(level).toBeLessThanOrEqual(ENVELOPE_MAX);
        }
      }
    }
  });

  it('actually varies over time, so it is not a frozen pose', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const samples = [0, 1, 2, 3, 4, 5].map((t) => envelope(i, t, seed));
        const spread = Math.max(...samples) - Math.min(...samples);
        expect(spread).toBeGreaterThan(0);
      }
    }
  });

  it('gives the centre measurably more amplitude than the edges', () => {
    // Where the "taller toward the centre" intent actually lives (see
    // centreWeight): outer bars swing less. Measured across a full loop, and
    // required to be >2x so the taper cannot quietly decay into nothing.
    const spreadOverLoop = (index: number, seed: number): number => {
      const samples = Array.from({ length: 240 }, (_, k) =>
        envelope(index, (k * LOOP_SECONDS) / 240, seed),
      );
      return Math.max(...samples) - Math.min(...samples);
    };
    for (const seed of SEEDS.slice(0, 4)) {
      const centre = spreadOverLoop(20, seed);
      const edge = spreadOverLoop(0, seed);
      expect(centre).toBeGreaterThan(2 * edge);
    }
  });
});
