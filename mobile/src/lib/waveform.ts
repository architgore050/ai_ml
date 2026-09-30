/**
 * The reel card's decorative 40-bar waveform, as pure functions.
 *
 * Extracted for the same reason `lib/feedViewport.ts` and
 * `lib/playbackDecision.ts` are: the two defects this replaces were properties
 * of a *computation*, not of React, so a test can call the computation directly.
 * `jest.config.js` excludes `src/components/**` from coverage, so any of this
 * left inside a component would be unmeasured.
 *
 * THE TWO SOURCE DEFECTS. The design source is
 * `frontend/sample_frontend2/src/components/audio/ReelCard.tsx:175-177`
 * (readable only via `git show 20451d3:...`, the directory is gitignored):
 *
 * ```js
 * const h = 8 + Math.sin(i * 0.4) * 12 + Math.random() * 10;
 * ```
 *
 *  1. `Math.random()` is re-rolled on every render, so the row visibly
 *     reshuffles whenever React re-renders — and it re-rolls per bar per
 *     render, so there is no stable shape at all. Plan §13 lists the
 *     `Math.random()` waveform as **deliberately not ported** and replaces it
 *     with "a deterministic pseudo-reactive envelope on the UI thread via
 *     Reanimated — not `Math.random()`".
 *  2. The theoretical minimum is `8 - 12 - 0 = -4 px`. A negative height is
 *     invalid CSS *and* invalid React Native, and **no source anywhere clamps
 *     it** — the clamp is a decision made here, not a port of an existing one.
 *
 * WHAT IS DELIBERATELY NOT HERE: colour. The source gradient is
 * `linear-gradient(to top, ${c}, var(--sage))`; `c` comes from
 * `design/categories.ts::categoryColor`, which the component resolves. Bar
 * geometry is colour-independent, and folding category into the seed would make
 * a clip's waveform change when it is recategorised — a visible reshuffle,
 * which is defect 1 wearing a different hat.
 */

/** Bars in the row. The source's `Array.from({ length: 40 })`. */
export const BAR_COUNT = 40;

/**
 * Floor, px, of a **rendered** bar.
 *
 * `8` is the source's own baseline constant (the leading term of
 * `8 + sin(...)*12 + rand*10`) and is also the reference web envelope's paused
 * floor (`8 + round((i / BAR_COUNT) * 6)`, `frontend/src/stores/player.tsx:157`).
 * It is the shortest a bar can be and still read as a bar: below roughly 6px a
 * 3px-wide, 2px-corner-radius pill stops being legible as a rounded cap.
 *
 * This is the number that defect 2 was missing — the source's floor of −4 is
 * replaced by 8, not by 0. Note this is the floor of the *rendered* height; the
 * base profile it multiplies has its own, higher floor at `MIN_BASE_HEIGHT`.
 */
export const MIN_BAR_HEIGHT = 8;

/**
 * Ceiling, px, of a **rendered** bar. `8 + 12 + 10 = 30` is the source's nominal
 * maximum, and it fits the source's 60px-tall, `alignItems: 'flex-end'`
 * container with 30px of headroom above the tallest bar — so the row reads as a
 * waveform sitting on a baseline rather than as bars that fill their box.
 */
export const MAX_BAR_HEIGHT = 30;

/**
 * The envelope's range, and therefore the valid range for `transform: scaleY`.
 *
 * NOT `[0, 1]`, and that is forced rather than chosen. `scaleY` is a
 * *multiplier*, so the rendered height is `base * envelope` — which means a bar
 * sitting at its base height **8px** with an envelope of `0.5` renders at 4px,
 * straight back through the floor this module exists to enforce. With one
 * envelope band shared by all 40 bars and a base profile that spans a 2.25x
 * range, there is no way to have both visible motion and a hard 8px floor.
 *
 * So the band is `[0.6, 1]` and the **base range is derived from it**:
 *
 *   rendered = base * envelope,  base in [MIN/0.6, MAX/1] = [13.33, 30]
 *            => rendered in [13.33 * 0.6, 30 * 1] = [8, 30]  — exactly, always
 *
 * The invariant holds for *any* base and *any* independently valid envelope, so
 * it is structural rather than a clamp that has to be re-verified by reading the
 * arithmetic. `barHeight` still clamps, as a safety net for a future caller that
 * passes something else.
 *
 * `1` as the ceiling means the base IS the peak and the row only ever shrinks.
 * Growing upward would need headroom above every base bar, and the source's
 * ceiling is already the container's midpoint — there is none to give.
 */
export const ENVELOPE_MIN = 0.6;
export const ENVELOPE_MAX = 1;

/**
 * Floor of the **base** profile, derived: `MIN_BAR_HEIGHT / ENVELOPE_MIN` = 13.33.
 *
 * This is the number that makes the product invariant hold, and it is exported
 * because it is the range the component's `height` style actually lives in.
 */
export const MIN_BASE_HEIGHT = MIN_BAR_HEIGHT / ENVELOPE_MIN;

/** Ceiling of the base profile: `MAX_BAR_HEIGHT / ENVELOPE_MAX` = 30. */
export const MAX_BASE_HEIGHT = MAX_BAR_HEIGHT / ENVELOPE_MAX;

/** `MAX_BASE_HEIGHT - MIN_BASE_HEIGHT`. The span the base profile is mapped onto. */
export const BASE_SPAN = MAX_BASE_HEIGHT - MIN_BASE_HEIGHT;

/** Which pose to compute. `t` is ignored when `'paused'` — see `pausedEnvelope`. */
export type WaveformState = 'playing' | 'paused';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit, with a murmur3 finalizer.
 *
 * WHY THIS AND NOT `Math.random()`: the requirement is that the same clip id
 * produces the same row forever, on every device and in every test run.
 * `Math.random()` cannot do that by construction.
 *
 * WHY IT IS STABLE ACROSS JS ENGINES — Hermes on device, V8 under jest, JSC on
 * older iOS — which is the property that makes the hash usable here:
 *
 *  - FNV-1a is arithmetic on **integers only**. Every step is `Math.imul`
 *     (exact 32-bit signed multiply, ES2015, implemented bit-for-bit in Hermes)
 *     and `^` / `>>>` (spec-defined on the 32-bit view). No float ever enters
 *     the accumulator, so there is no accumulation-order or rounding question.
 *  - The naive `hash * 16777619` is **not** used: the product exceeds 2^53 and
 *     silently loses low bits through double rounding. `Math.imul` keeps it exact.
 *  - `charCodeAt` yields UTF-16 code units per the string spec, identically on
 *     every engine. (Clip ids are ASCII in practice — `models.py` ids and
 *     UUIDs — but the function must not depend on that.)
 *  - The finalizer is the standard murmur3 avalanche, which exists to destroy
 *     the low-entropy high bits FNV leaves in the low bits of its output.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash >>> 0);
}

/**
 * murmur3 finalizer — 32-bit integer avalanche. Same integer-only argument as
 * `fnv1a32`; it is what turns a well-mixed hash of the clip id into a
 * well-distributed *per-bar* value.
 */
function mix32(value: number): number {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A 32-bit hash to a float in `[0, 1)`.
 *
 * `>>> 8` keeps 24 bits and divides by 2^24, which is exactly representable —
 * so the quotient is a clean double with no rounding surprise, and the range is
 * half-open at 1 so `Math.round(1 - epsilon)` can't produce 1.
 */
function unitFromHash(hash: number): number {
  return (mix32(hash) >>> 8) / 0x1000000;
}

/**
 * Derive the waveform seed from a clip id.
 *
 * Accepts `number | string` because the same clip reaches this code as both
 * (API payloads carry numeric `id`s, cache keys and route params carry
 * strings), and `String(7) === '7'`, so both spellings seed identically — a
 * difference that would otherwise make the row reshuffle depending on where the
 * id came from.
 *
 * A missing id degrades to the hash of the empty string: a fixed, valid row,
 * rather than a thrown error or a NaN height. A reel whose clip is still loading
 * must still render a waveform.
 */
export function waveformSeed(clipId: string | number | null | undefined): number {
  return fnv1a32(clipId === null || clipId === undefined ? '' : String(clipId));
}

// ---------------------------------------------------------------------------
// Index / time sanitising
// ---------------------------------------------------------------------------

/**
 * Bring an index inside `[0, BAR_COUNT)`.
 *
 * Clamping rather than wrapping: the row is **not** periodic in index (the
 * centre weighting makes it symmetric, not cyclic), so index 40 has no
 * meaningful value to wrap to. Clamping keeps a caller bug contained instead of
 * letting it propagate as `NaN` into a style. Matches `clampIndex` in
 * `lib/feedViewport.ts`, and matches the repo's existing convention.
 *
 * A non-finite index becomes 0 — same reasoning as `sanitizeTime`.
 */
function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  const whole = Math.round(index);
  if (whole < 0) return 0;
  if (whole >= BAR_COUNT) return BAR_COUNT - 1;
  return whole;
}

/**
 * Bring `t` into a range whose trigonometry is safe and bounded.
 *
 * **Non-finite `t` becomes 0, deliberately, and does not throw.** `t` comes from
 * an animation clock, so `NaN` reaches it whenever the clock has not started or
 * a seek failed, and `Infinity` when a caller divides by a zero duration.
 * `Math.sin(Infinity)` and `Math.sin(NaN)` are both `NaN`, which would travel
 * straight into `scaleY` / `height` and produce an invalid style value — the
 * classic "progress bar silently disappears" failure. `0` is the t=0 rest pose,
 * so the worst case is a still waveform instead of a blank or a crash.
 *
 * Finite `t` is reduced **modulo the loop period**, which is what makes
 * `barHeight` safe for any magnitude: a raw `t * 1.8` on `Number.MAX_VALUE`
 * stays finite in V8 but nothing guarantees a bounded *argument* on every
 * engine, and the reduction also buys an exactly periodic envelope. `%` is used
 * rather than `t - floor(t / P) * P` because `fmod` cannot overflow: the
 * `floor` form computes `floor(MAX_VALUE / P) * P` and rounds past `MAX_VALUE`
 * to `Infinity`, handing `NaN` back after all.
 */
function sanitizeTime(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const reduced = t % LOOP_SECONDS;
  return reduced < 0 ? reduced + LOOP_SECONDS : reduced;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Two harmonics whose rates are **exactly commensurate** — `FAST_RATE` is 3x
 * `SLOW_RATE` — so the pair shares the period `TAU / SLOW_RATE` and the envelope
 * loops seamlessly with no discontinuity at the wrap.
 *
 * Worth flagging: the reference web envelope uses `2.1` and `0.7` and comments
 * that they are "incommensurable ... so the envelope never visibly repeats".
 * Their ratio is exactly 3, so they are perfectly commensurate and the pair
 * repeats every `TAU / 0.7 ≈ 8.98s` anyway. Commensurability is what buys the
 * exact loop and the bounded argument above, so these rates keep it
 * deliberately: `LOOP_SECONDS ≈ 10.47s` of slow breathing, which at the
 * source's 0.15 opacity reads as a pulse rather than as a loop.
 */
export const FAST_RATE = 1.8;
export const SLOW_RATE = 0.6;
/** Sum is 1, so `oscillation` is confined to `[-1, 1]`. */
export const FAST_WEIGHT = 0.62;
export const SLOW_WEIGHT = 0.38;

/**
 * Seconds for one full loop of the envelope — `TAU / SLOW_RATE`, ~10.47s.
 *
 * Exported because the component's Reanimated `withRepeat` duration **must**
 * match it. The decided animation is a UI-thread keyframe `scaleY` loop, and if
 * its period differs from this, the rendered row silently drifts out of phase
 * with every value `barHeight` reports — which then makes the paused/playing
 * cross-check and any frame-level test disagree with what is on screen.
 */
export const LOOP_SECONDS = TAU / SLOW_RATE;

/** Wobble cycles across the row in the *base* profile. The source had ~2.5. */
const PROFILE_CYCLES = 3;

/**
 * `0` at the outer bars, `1` at the centre — the symmetric reading of the
 * reference's "taller toward the centre".
 *
 * The reference computes its floor as `0.18 + (i / BAR_COUNT) * 0.5`, which is
 * monotonic in `i`, so its tallest bar is the **last** one, not the middle. For a
 * centred reel that is a misreading of the stated intent, so this uses the
 * mirrored form. Deviating from the reference is deliberate; the reference is
 * not the design source here (`ReelCard.tsx` is), and it has no centre at all.
 *
 * SCOPE — this weights the **poses** (`envelope`, `pausedEnvelope`) and NOT the
 * base profile. That is a measured decision, not an oversight: the reference's
 * floor only ever scaled the animated value, and when the same taper was applied
 * to `baseHeight` the per-bar jitter swamped it (the centre mean fell *below* the
 * edge mean for 4 of 8 seeds), so the parameter was not producing the shape its
 * own comment claimed. The pose taper is real — ~2.5-3.2x more envelope
 * amplitude at the centre than at the edge — and the base profile is left
 * uniform, which is what the design source's `sin(i * 0.4)` row does anyway.
 */
function centreWeight(index: number): number {
  return 1 - Math.abs((2 * (index + 0.5)) / BAR_COUNT - 1);
}

/**
 * The playing envelope for one bar, in `[ENVELOPE_MIN, ENVELOPE_MAX]`.
 *
 * Formulated as a *shrink from the base* — `1 - depth * (1 - unit)` — rather than
 * as a swing about the midpoint. That is what makes the product invariant with
 * `baseHeight` hold for any `depth <= 1 - ENVELOPE_MIN`: the result is always in
 * `[ENVELOPE_MIN, 1]`, so `base * envelope >= MIN_BASE * ENVELOPE_MIN`, i.e.
 * `>= MIN_BAR_HEIGHT`, regardless of which bar or which clip.
 *
 * Advancing `t` moves this **smoothly**: the largest possible slope is
 * `depth * 0.5 * (FAST_RATE * FAST_WEIGHT + SLOW_RATE * SLOW_WEIGHT)`, and
 * `depth` is at most `1 - ENVELOPE_MIN = 0.4`, so at 60fps (`dt = 1/60`) the
 * envelope changes by at most **0.0044 per frame** and a mid-sized bar's pixel
 * height by at most 0.07px. That bound is what makes it safe to drive from a
 * UI-thread animation without visible stepping — and it is asserted, not assumed.
 *
 * `seed` enters as a per-bar phase offset, so two clips breathe out of step
 * with each other while each one keeps its own steady rhythm.
 */
export function envelope(index: number, t: number, seed: number): number {
  const i = clampIndex(index);
  const time = sanitizeTime(t);
  const phase = (i / BAR_COUNT) * TAU;

  // The two harmonics of the reference: a fast term and a slow one on a
  // doubled phase, so the slow term is not merely a scaled copy of the fast one.
  const fast = Math.sin(time * FAST_RATE + phase + seedPhase(seed));
  const slow = Math.sin(time * SLOW_RATE + phase * 2 + seedPhase(seed) * 1.7);
  const oscillation = fast * FAST_WEIGHT + slow * SLOW_WEIGHT; // [-1, 1]
  const unit = 0.5 + oscillation * 0.5; // [0, 1]

  // Outer bars shrink less, so the row tapers and the centre reads as the
  // active part — the reference's intent, on the correct (symmetric) axis.
  // Capped at `1 - ENVELOPE_MIN` so the envelope can never leave its band.
  const depth = (1 - ENVELOPE_MIN) * (0.35 + 0.65 * centreWeight(i));

  return clamp(1 - depth * (1 - unit), ENVELOPE_MIN, ENVELOPE_MAX);
}

/**
 * The paused pose for one bar, in `[ENVELOPE_MIN, ENVELOPE_MAX]`.
 *
 * **Ignores `t` entirely**, which is what makes it a *pose* rather than an
 * animation: the reference branches on `isPlaying` and returns a flat ramp when
 * paused, and so does this.
 *
 * It occupies a deliberately narrow band near the bottom of the envelope range —
 * measured over 400 seeds, `[0.62, 0.78]` — so it cannot be confused with a frame
 * of the playing pose, which reaches all the way up to `1`. Paused reads as
 * *settled*, not as a waveform caught mid-shrug.
 *
 * The seed shifts it slightly so a paused row still belongs to its clip, but it
 * stays close to a common level on purpose: a rest state that looks the same on
 * every reel reads as a rest state.
 */
export function pausedEnvelope(index: number, seed: number): number {
  const i = clampIndex(index);
  const jitter = (unitFromHash(mix32(seed) ^ (i + 1)) - 0.5) * 0.06; // [-0.03, 0.03]
  return clamp(
    ENVELOPE_MIN + 0.1 + 0.08 * centreWeight(i) + jitter,
    ENVELOPE_MIN,
    ENVELOPE_MAX,
  );
}

/** Route to the playing or paused envelope. `t` is unused when paused. */
export function envelopeFor(
  index: number,
  t: number,
  seed: number,
  state: WaveformState,
): number {
  return state === 'paused' ? pausedEnvelope(index, seed) : envelope(index, t, seed);
}

/** Deterministic horizontal phase shift of the row, in `[0, TAU)`. */
function seedPhase(seed: number): number {
  const normalised = Number.isFinite(seed) ? Math.abs(seed) % 6283 : 0;
  return (normalised / 1000) * TAU;
}

// ---------------------------------------------------------------------------
// Base profile — the per-clip static shape
// ---------------------------------------------------------------------------
//
// WHY BASE PROFILE *AND* ENVELOPE, RATHER THAN ONE HEIGHT FUNCTION:
//
// The decision is to animate a keyframe `scaleY` envelope, and that forces the
// split. `scaleY` is a *multiplier*, so it needs a number in a known range that
// means "how much of this bar to show", not a pixel height. A single
// `height(index, t)` function would force the component to either
//
//   (a) call it every frame on the JS thread to get pixel heights — which is
//       what the reference does with `requestAnimationFrame` + `setState`, the
//       exact pattern that makes a re-render per frame, or
//   (b) divide out a base height and pass the ratio, which is the split anyway,
//       just with the division buried in the component.
//
// So the shape is: a **static per-clip base profile** that the component renders
// once as `height`, multiplied by a **normalised envelope** it drives through
// `scaleY`. Both halves are separately testable, and neither depends on the
// other's arithmetic.
//
// THE COMPOSITION MUST BE A PRODUCT — DO NOT "SIMPLIFY" IT TO AN ADDITION.
// `barHeight = MIN + envelope * SPAN` looks tidier and is wrong: it is not what
// `height * scaleY` computes, so `barHeight` would silently disagree with the
// component it documents. It is also self-defeating as a guard — with `barHeight`
// not calling `baseHeight`, a `Math.random()` reintroduced into the base profile
// is invisible to the determinism tests, because they all go through
// `barHeight`. `barProfile`/`barHeight` must keep composing the two exported
// halves, and `MIN_BASE_HEIGHT` exists only to make `base * envelope >=
// MIN_BAR_HEIGHT` true.
//
// The composition contract for the component:
//
//   height:      baseHeight(i, seed)                  // px, in [MIN_BASE, MAX_BASE]
//   transform:   [{ scaleY: envelope(i, t, seed) }]   // in [ENVELOPE_MIN, 1]
//   transformOrigin: 'bottom'                         // RN 0.86 has it; see below
//
// which renders to `base * envelope`, in `[MIN_BAR_HEIGHT, MAX_BAR_HEIGHT]`.
//
// **`transformOrigin: 'bottom'` is not optional.** RN scales about a view's
// centre by default, and this row is bottom-aligned against a baseline (the
// source's `alignItems: 'flex-end'`). Without `transformOrigin: 'bottom'` every
// bar lifts off the baseline as it scales and the row visibly detaches from the
// bottom of its box — the mirror image of the negative-height bug, and not
// catchable from these pure functions.
//
// `barHeight` below is the composition of the two halves. The component should
// prefer the split (base + scaleY) so the animation stays on the UI thread;
// `barHeight` exists for tests, for a non-animated static render, and for any
// caller that needs the pixel value.

/**
 * The static, per-clip base height of one bar, in
 * `[MIN_BASE_HEIGHT, MAX_BASE_HEIGHT]` = `[13.33, 30]` px.
 *
 * Note this is deliberately **not** `[MIN_BAR_HEIGHT, MAX_BAR_HEIGHT]`. The base
 * is a multiplier's operand, so it must leave room for the multiplier to shrink
 * it without crossing the rendered floor — see `ENVELOPE_MIN`.
 *
 * This is the deterministic replacement for the source's `Math.random() * 10`
 * term. Everything that varies between clips arrives through `seed`:
 *
 *  - `seedPhase(seed)` slides the whole wobble horizontally, so two clips are
 *    not the same wave shifted by nothing at all;
 *  - a per-bar `unitFromHash` jitter replaces the random term with a value that
 *    is the same on every device, every run and every re-render.
 *
 * The blend is 62% smooth wobble to 38% jitter: mostly a legible wave with a
 * little texture, rather than noise with a wave in it. The jitter's 38% share is
 * calibrated against the source's own `Math.random() * 10`, which allowed 10px
 * of pure bar-to-bar noise — this is slightly *less* ragged than the source.
 *
 * Uniform across the row: no centre weighting, deliberately — see `centreWeight`.
 */
export function baseHeight(index: number, seed: number): number {
  const i = clampIndex(index);
  const phase = (i / BAR_COUNT) * TAU * PROFILE_CYCLES;

  const wobble = 0.5 + 0.5 * Math.sin(phase + seedPhase(seed)); // [0, 1]
  const jitter = unitFromHash(mix32(seed) ^ (i + 1)); // [0, 1)
  const shape = 0.62 * wobble + 0.38 * jitter; // [0, 1]

  return clamp(MIN_BASE_HEIGHT + shape * BASE_SPAN, MIN_BASE_HEIGHT, MAX_BASE_HEIGHT);
}

/**
 * The composed pixel height of one bar: `baseHeight * envelope`, clamped to
 * `[MIN_BAR_HEIGHT, MAX_BAR_HEIGHT]`.
 *
 * With an in-range envelope the clamp never activates — `MIN_BASE_HEIGHT` is
 * defined as `MIN_BAR_HEIGHT / ENVELOPE_MIN` precisely so the product cannot dip
 * below the floor. It is here so that *any* envelope, including one from a
 * future caller, still yields a valid style value.
 *
 * This is the value to render when the caller is not animating. For the animated
 * path use `baseHeight` + `scaleY` (see the composition contract above).
 */
export function barHeight(
  index: number,
  t: number,
  seed: number,
  state: WaveformState = 'playing',
): number {
  const level = envelopeFor(index, t, seed, state);
  return clamp(
    baseHeight(index, seed) * level,
    MIN_BAR_HEIGHT,
    MAX_BAR_HEIGHT,
  );
}

/** All {@link BAR_COUNT} base heights for a clip. Compute once per clip. */
export function baseProfile(seed: number): number[] {
  return Array.from({ length: BAR_COUNT }, (_, i) => baseHeight(i, seed));
}

/**
 * All {@link BAR_COUNT} composed pixel heights at time `t`.
 *
 * The static counterpart to a Reanimated-driven row: render this once at the
 * rest pose, or use it to assert a frame without a UI thread.
 */
export function barProfile(
  t: number,
  seed: number,
  state: WaveformState = 'playing',
): number[] {
  return Array.from({ length: BAR_COUNT }, (_, i) => barHeight(i, t, seed, state));
}
