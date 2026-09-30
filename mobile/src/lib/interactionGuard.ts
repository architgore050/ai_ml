import { pacing } from '../design/tokens';

/**
 * The two pure functions that decide what gets reported to a recommender.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE HIGHEST-RISK CODE IN THE APP
 * ---------------------------------------------------------------------------
 * Everything else here can be wrong in a way a user notices. This cannot. A bug
 * in the play/pause overlay draws the wrong circle; a bug here writes a wrong
 * number into `AudioClip.avg_completion_rate`, which is **30 % of the ranking
 * composite** (`services/feed_pool.py:152` and `:225` — both spell it
 * `(F('avg_completion_rate') * 0.30)`). The write is async and silent
 * (`services/counter_store.py` -> Redis -> `flush_counters_to_pg`), so no error
 * ever surfaces, and the damage is a permanently shifted ranking that nobody
 * attributes back to this module.
 *
 * It lives in `lib/` and not in the store because both halves are *decisions
 * over numbers*, not React: the accumulator is a reducer whose every input is
 * injected (`nowMs` is always supplied by the caller — `Date.now()` is never
 * called here), and the guard is a total function. Both are therefore testable
 * with plain numbers and no fake timers and no renderer.
 *
 * ---------------------------------------------------------------------------
 * PART 1 — WATCH TIME IS A QUANTITY, NOT A POSITION
 * ---------------------------------------------------------------------------
 * The old web client sent `currentTime * 1000` as `watch_time_ms`
 * (`player.tsx`, pre-2026-09). Seek to 0:55 of a 60 s clip and it recorded a
 * **0.92 completion for one second of listening**. Since that number is the
 * numerator of `completion_rate`, seeking was a ranking exploit available to
 * anyone who read the client. The fix is to accumulate the *elapsed wall-clock
 * delta between ticks* instead of reading the playhead — a seek then moves the
 * playhead but not the clock, so it cannot be credited.
 *
 * The cap on one tick is not a refinement of that fix; it is what makes the fix
 * safe on mobile specifically. iOS suspends timers when an app is backgrounded,
 * so a single gap between two ticks can be *thirty minutes*. Without the cap
 * that gap credits +1 800 000 ms, which against a 10 s clip is a **perfect 1.0
 * completion for a clip nobody was listening to**. The web client already
 * settled on 1000 (`frontend/src/stores/player.tsx:147`, with the reasoning at
 * `:136-146`) and this module uses the identical value so the two clients cannot
 * disagree about what a tick is worth.
 *
 * ---------------------------------------------------------------------------
 * PART 2 — A SKIP IS A CLAIM ABOUT INTENT, NOT ABOUT PROGRESS ALONE
 * ---------------------------------------------------------------------------
 * `shouldRegisterSkip` fires on the transition, not on the timeline. The
 * original defect was that a clip which played to the end and auto-advanced
 * reported a skip — every natural completion in the session counted as an
 * abandonment. Progress alone cannot distinguish the two: at the moment of
 * auto-advance the position is *at* the duration, so the only thing that
 * separates "the user swiped away at 0:10" from "the reel finished and moved
 * on" is whether the transition was user-initiated. That check therefore runs
 * FIRST and outranks everything else.
 *
 * The second load-bearing rule is that `listenDurationMs` is the *accumulated
 * watch time* and `reelPositionMs` is the *position*, and they are deliberately
 * allowed to disagree. The server divides `listen_duration_ms` by the clip's
 * own `duration_ms` (`services/interactions.py:215-225`) and never reads
 * `reel_position_ms` for anything — the divisor is server state precisely
 * because the caller used to control it (`interactions.py:252-268`). Swapping
 * the two fields is therefore not a refactor, it is a forged 1.0.
 */

// ---------------------------------------------------------------------------
// Coercion. One helper, because every number that reaches this module can be
// hostile and "coerce at the boundary" only works if there is exactly one
// boundary.
// ---------------------------------------------------------------------------

/**
 * `value` as a usable positive duration/quantity, or 0 for anything else.
 *
 * `null`, `undefined`, `NaN`, `Infinity`, `-1` and `0` all become 0, which every
 * caller then reads as "this length is unknown". Note `Number.isFinite` is the
 * test and not `isNaN`: `Infinity` survives `isNaN`, and an `Infinity` duration
 * turns every ratio into 0 while an `Infinity` numerator turns every ratio into
 * `NaN`.
 */
function positiveMs(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Can `value` be used as a clock reading?
 *
 * `>= 0` rather than `> 0`, because 0 is a legitimate origin — the tests use
 * it, and a monotonic wall clock can legitimately be 0 after a device reset.
 * Distinct from `positiveMs` because the *value* 0 is a usable clock while it
 * is never a usable duration.
 */
function usableClock(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * How far through the clip `positionMs` is, as a fraction. Total; never `NaN`.
 *
 * ---------------------------------------------------------------------------
 * RE-DERIVED, NOT IMPORTED — `components/reel/SeekProgressBar.tsx:189-193`
 * ---------------------------------------------------------------------------
 * That function computes the same ratio and is exported, so importing it was the
 * obvious choice. It is re-derived here for three reasons, in descending order
 * of how much they would hurt:
 *
 *  1. **It is the wrong function for this question, not merely a copy of the
 *     right one.** It returns `0` when `duration <= 0` (`SeekProgressBar.tsx:191`).
 *     For a scrubber fill, "no length yet" and "at the start" draw identically,
 *     so 0 is the correct renderable answer. For the completion guard it is
 *     exactly inverted: an unknown length must produce a *refusal*, and
 *     substituting 0 makes `progress < COMPLETION_THRESHOLD` true, i.e. it would
 *     report a skip precisely in the case where we have admitted we cannot judge.
 *     Importing it and keeping the duration check ahead of the call would work
 *     today and would break silently the first time someone reordered the
 *     checks — so the re-derivation is what makes the ordering visible.
 *  2. **`src/components/**` is excluded from coverage** (`jest.config.js:71`),
 *     so a pure decision module whose arithmetic lives in an unmeasured
 *     directory is a decision module with unmeasured arithmetic.
 *  3. **Importing it makes this module's test suite fail to RUN.** Observed, not
 *     predicted: `SeekProgressBar.tsx:26` imports `src/store/player.ts`, which
 *     imports `expo-audio`, whose native module is absent under jest. The whole
 *     suite dies at import with
 *     `TypeError: Cannot read properties of undefined (reading 'prototype')`
 *     (`expo-audio/src/ExpoAudio.ts:30`) before a single assertion runs — and
 *     the only fix is a `jest.mock('expo-audio')` in a file whose entire
 *     premise is that it needs no native doubles.
 *     `playOverlayVisibility.ts:39-40` and `:50-57` set the in-repo precedent
 *     for restating across that boundary rather than importing.
 *
 * **The one deliberate difference** from the original is the missing
 * `clamp01`. It cannot change any decision the guard makes — an over-running
 * position clamps to 1.0 and an over-running raw value exceeds the threshold
 * either way, so both answer `completed` — and it is left off because clamping
 * would hide exactly the over-run the server's `_OVERCLAIM_TOLERANCE` band
 * (`services/interactions.py:219-225`) is built to catch. The test file pins the
 * two against each other over an enumerated grid and asserts the divergence is
 * decision-neutral, so the copy cannot rot unnoticed.
 *
 * `durationMs` must be finite and positive; every caller has already refused
 * otherwise.
 */
function positionFraction(positionMs: number, durationMs: number): number {
  return positionMs / durationMs;
}

// ---------------------------------------------------------------------------
// PART 1 — the accumulator
// ---------------------------------------------------------------------------

/**
 * The most watch time a single tick may be credited.
 *
 * The value the fixed web client uses (`frontend/src/stores/player.tsx:147`),
 * restated rather than imported: the mobile app cannot import from the web
 * bundle, and a copy that is *named* after the shared decision is easier to
 * keep in step than a copy that is not. `playOverlayVisibility.ts:39-40` and
 * `:50-57` set the precedent for restating a cross-app constant.
 *
 * expo-audio is created with `updateInterval: 500` (`store/player.ts:51`), so a
 * healthy tick is worth ~500 ms and this cap is not reached in normal playback.
 * A gap at or beyond 1000 ms means the tick was *late*: a backgrounded app, a
 * device sleep, a long GC pause, or — on iOS — the timer suspension that
 * motivated the cap in the first place.
 *
 * The error direction is deliberate: erring low under-reports, which is a
 * pessimistic completion, and erring high is a fabrication. See
 * `services/interactions.py:219-225` for why the server treats a claim in
 * `[duration, duration + max(2000, 10%)]` as a *perfect* 1.0 rather than as an
 * over-report.
 */
export const MAX_TICK_CREDIT_MS = 1000;

/**
 * Accumulated watch time for **one** clip, as an immutable value.
 *
 * Every field is about a single clip, and `startClip` (plus the implicit switch
 * inside `observe`) is the only way to move between clips. That is what makes
 * "a sample must never mix two clips" structural rather than a rule the caller
 * has to remember.
 */
export type WatchAccumulator = {
  /** The clip this state describes, or null before the first `startClip`. */
  clipId: string | null;
  /**
   * Total credited watch time, in ms. **A quantity, never a position.**
   *
   * Monotonically non-decreasing *within a clip*. The one and only way it
   * decreases is `startClip` / a clip switch in `observe`, which is a different
   * clip's sample and not a regression.
   */
  watchedMs: number;
  /** Last `positionMs` seen, coerced non-negative. Reporting only; never credited. */
  lastPositionMs: number;
  /**
   * Caller clock at the last credited observation, or null when there is no
   * baseline yet.
   *
   * Null is not the same as 0. 0 is a real epoch the caller can hand us and a
   * valid baseline; null means "the next tick has nothing to measure against and
   * must credit nothing".
   */
  lastTickAt: number | null;
};

/** One observation fed by the caller. `nowMs` is always supplied, never read. */
export type WatchObservation = {
  clipId: string;
  /** Media position in ms. Recorded, never credited. */
  positionMs: number;
  /** Caller clock, in ms. Monotonic within one clip. */
  nowMs: number;
  /** False while paused or buffering — see `observe`. */
  playing: boolean;
};

/** The two lengths the client knows, for the cap. `null`/`undefined` = unknown. */
export type DurationHint = {
  /** The media element's own reported length, in ms. */
  elementDurationMs: number | null | undefined;
  /** The server's `AudioClip.duration_ms`, in ms. 0 until HLS processing. */
  clipDurationMs: number | null | undefined;
};

/** A fresh accumulator: no clip, nothing watched, no baseline. */
export function initialAccumulator(): WatchAccumulator {
  return { clipId: null, watchedMs: 0, lastPositionMs: 0, lastTickAt: null };
}

/**
 * Begin `clipId`, discarding everything about the previous clip.
 *
 * `state` is accepted and ignored so that `startClip`, `observe`, `onSeek` and
 * `resetAccumulator` share one call shape and a caller can hold a single
 * reducer-shaped handle. The discard is total and atomic — not `watchedMs: 0`
 * with the old `lastTickAt` left behind — because the dangerous states are the
 * half-reset ones: a fresh `watchedMs` with a stale baseline would credit the
 * entire wall-clock gap between two clips, which on a slow swipe is hundreds of
 * milliseconds of somebody else's clip.
 */
export function startClip(state: WatchAccumulator, clipId: string, nowMs: number): WatchAccumulator {
  return {
    clipId,
    watchedMs: 0,
    lastPositionMs: 0,
    lastTickAt: usableClock(nowMs) ? nowMs : null,
  };
}

/**
 * Fold one observation into the accumulator. Pure; `state` is never mutated.
 *
 * Order of the rules, and why each one is where it is:
 *
 *  1. **A foreign `clipId` is a switch, not a tick.** Refusing (returning
 *     `state` unchanged) would be worse than switching: the caller would go on
 *     accumulating against the *old* clip while the new one plays, which is the
 *     two-clip sample this whole design exists to prevent. Switching credits
 *     nothing and starts the new clip cleanly.
 *  2. **An unusable clock moves nothing** — not even the baseline. Coercing
 *     `NaN` to 0 and storing it would leave the next good tick reading a delta
 *     of ~1.7e12 ms, which the cap would satisfy at its full 1000 ms: one bad
 *     tick would mint a second of fake watch time out of a 50 ms gap.
 *  3. **`playing: false` credits nothing but DOES move the baseline.** A pause is
 *     not watch time, and if the baseline did not move then the first playing
 *     tick after a 60 s pause would see a 60 s delta and collect the cap. The
 *     store freezes `currentTime` during a stall and on Android stops writing it
 *     entirely, so a heartbeat during a stall re-reads the same number — which
 *     is only harmless *because* the credit comes from the clock.
 *  4. **No baseline, or a backwards clock, credits nothing** and re-baselines to
 *     `nowMs` so a skewed device cannot wedge the accumulator at zero for ever.
 *  5. **Otherwise credit `min(delta, MAX_TICK_CREDIT_MS)`.** The cap is the
 *     iOS background-suspend defence.
 */
export function observe(state: WatchAccumulator, observation: WatchObservation): WatchAccumulator {
  const { clipId, positionMs, nowMs, playing } = observation;

  if (state.clipId !== clipId) return startClip(state, clipId, nowMs);

  // Position is a reading, not a clock: coerce and store it even on a paused or
  // clock-broken tick, because it is still the most recent thing the user saw.
  const seen: WatchAccumulator = { ...state, lastPositionMs: positiveMs(positionMs) };

  if (!usableClock(nowMs)) return seen;

  if (!playing) return { ...seen, lastTickAt: nowMs };

  const previous = state.lastTickAt;
  if (!usableClock(previous)) return { ...seen, lastTickAt: nowMs };

  const elapsed = nowMs - previous;
  // Non-finite or non-positive: a backwards clock (device reset, NTP correction)
  // or an overflow from two near-MAX_SAFE_INTEGER readings. Either way, re-baseline.
  if (!Number.isFinite(elapsed) || elapsed <= 0) return { ...seen, lastTickAt: nowMs };

  const total = state.watchedMs + Math.min(elapsed, MAX_TICK_CREDIT_MS);
  return {
    ...seen,
    // The overflow guard is reachable only from a hand-built state at ~1.8e308,
    // but "total" is a property this module claims, so it is enforced rather
    // than assumed: the state never leaves holding a non-finite number.
    watchedMs: Number.isFinite(total) ? total : state.watchedMs,
    lastTickAt: nowMs,
  };
}

/**
 * Record a seek: new position, same clip, **zero credit**.
 *
 * The accumulator credits a time delta, so a seek is already immune — feeding a
 * seek through `observe` credits only that tick's elapsed time. This entry point
 * exists for the two things `observe` cannot know:
 *
 *  - the position must be updated *immediately*, because a seek is a
 *    discontinuity and the next native tick may not land for another 250-500 ms;
 *  - the baseline must move, because the player's own clock and the tick's wall
 *    clock legitimately disagree across a discontinuity on Android
 *    (`store/player.ts:298-302`, `DISCONTINUITY_REASON_SEEK`).
 *
 * Seeking to 0:55 of a 60 s clip with or without this call credits ~0. Both are
 * tested, because "with" is the contract and "without" is the property.
 */
export function onSeek(
  state: WatchAccumulator,
  seek: { clipId: string; positionMs: number; nowMs: number },
): WatchAccumulator {
  if (state.clipId !== seek.clipId) return startClip(state, seek.clipId, seek.nowMs);
  return {
    ...state,
    lastPositionMs: positiveMs(seek.positionMs),
    lastTickAt: usableClock(seek.nowMs) ? seek.nowMs : null,
  };
}

/**
 * Drop the baseline without crediting anything, keeping the clip and the total.
 *
 * The app-resume path, and it is not redundant with `playing: false`. iOS
 * suspends timers in the background, so no tick of any kind arrives while the
 * app is away — and on return the native player still reports `playing: true`,
 * because from its point of view the audio never stopped. The `playing: false`
 * branch therefore never runs across a background gap, and without this call the
 * first tick after resume would collect the full `MAX_TICK_CREDIT_MS` for a gap
 * of any length at all.
 */
export function resetAccumulator(state: WatchAccumulator, nowMs: number): WatchAccumulator {
  return { ...state, lastTickAt: usableClock(nowMs) ? nowMs : null };
}

/**
 * The `watch_time_ms` / `listen_duration_ms` value to send: accumulated watch
 * time, capped at the shorter of the two lengths the client knows.
 *
 * The cap rule is transcribed from the fixed web client's `reportableWatchedMs`
 * (`frontend/src/stores/player.tsx:325-335`) rather than invented: the element
 * duration catches a stale element (one reporting the previous clip's length),
 * and the server's `duration_ms` catches a rounded encoder duration. `min()`
 * because either one alone can over-report.
 *
 * **The cap does not protect the server-side score — it protects the CLAIM.**
 * This is the least intuitive rule in the file. `_completion_rate` returns
 * `min(listened / expected, 1.0)` for any claim up to
 * `expected + max(2000, 10%)` (`services/interactions.py:219-225`), so a claim
 * of `duration` and a claim of `duration + 6 s` on a 60 s clip both score
 * **exactly 1.0**. The server does not penalise an over-claim in that band; it
 * treats it as a completion. Only a client-side cap keeps the claim from being
 * over at all, and `completion_sample_recorded: false` (`interactions.py:295`)
 * is the far worse outcome — a dropped sample is one fewer row in the mean.
 *
 * Total: no combination of inputs returns `NaN`, `Infinity` or a negative. A
 * cap of 0 (neither length known) returns the raw clamped total rather than 0,
 * because a zero would be recorded server-side as a real `0.0` completion.
 */
export function reportableWatchedMs(state: WatchAccumulator, durations: DurationHint): number {
  const watched = Math.max(0, Math.round(positiveMs(state.watchedMs)));
  const elementMs = positiveMs(durations.elementDurationMs);
  const clipMs = positiveMs(durations.clipDurationMs);
  const cap = elementMs > 0 ? (clipMs > 0 ? Math.min(elementMs, clipMs) : elementMs) : clipMs;
  return cap > 0 ? Math.min(watched, cap) : watched;
}

// ---------------------------------------------------------------------------
// PART 2 — the completion guard
// ---------------------------------------------------------------------------

/**
 * The completion threshold, read from the design token rather than restated.
 *
 * `design/tokens.ts:594-596` documents it as "the completion guard boundary.
 * position < duration * this counts as a skip." Inlining a `0.9` here would let
 * the guard and the token drift, and the token is the thing the design system
 * and the plan both point at.
 */
export const COMPLETION_THRESHOLD = pacing.completionThreshold;

/**
 * What to report when a reel is left.
 *
 * `'none'` is the default and `'skip'` is the exception, which is the shape the
 * bug had inverted. The `reason` is carried rather than collapsed to a boolean so
 * a caller (and a test) can tell "the user finished it" from "we had no length
 * and refused to guess" — those are different bugs with different fixes.
 */
export type SkipDecision =
  | { kind: 'skip'; listenDurationMs: number; reelPositionMs: number }
  | {
      kind: 'none';
      reason: 'completed' | 'not-user-initiated' | 'unknown-duration' | 'too-short';
    };

/**
 * Should this transition be reported to `POST /interactions/{id}/register-skip/`?
 *
 *     report a skip  <=>  progress < COMPLETION_THRESHOLD  AND  user-initiated
 *
 * `progress` is `positionMs / durationMs` — the *position*, because the question
 * being asked is "how far in did they get". `listenDurationMs` is
 * `watchTimeMs` — the *accumulated watch time*, because the number the server
 * turns into a completion rate has to be a quantity. Those two fields are
 * expected to disagree whenever the user seeks, and a client that sets them
 * equal has reintroduced the original defect.
 *
 * ## Check order, and the two orderings that are load-bearing
 *
 * 1. **`userInitiated` first**, before the duration is even looked at. This is
 *    the fix for the original defect: at the moment of auto-advance the position
 *    *is* the duration, so progress alone cannot distinguish a finished clip
 *    from an abandoned one — but auto-advance is `userInitiated: false`, so it
 *    can never produce a skip no matter what the numbers say. Putting it first
 *    also means a garbage duration during auto-advance is reported as
 *    `not-user-initiated`, which is the fact worth logging.
 * 2. **`unknown-duration` before any progress arithmetic.** Progress is undefined
 *    without a length, and the tempting fallback is the server's own: when
 *    `AudioClip.duration_ms` is 0 the server substitutes a 60 000 ms divisor
 *    (`_ZERO_DURATION_FALLBACK_MS`, `services/interactions.py:184`, used by
 *    `_completion_rate` at `:215-217`). **The client must not.** A client that
 *    guesses 20 s where the server believes 60 s computes a progress of 0.5 at
 *    position 10 s and reports a skip the user did not make; a client that
 *    guesses 120 s sees progress 0.08 and reports a skip for a clip they watched
 *    to the end. The web client has this exact defect
 *    (`frontend/src/stores/player.tsx:734` — `currentTime < (durationSecs || 20) * 0.9`).
 *    `clipDurationMs` may stand in for the element's length because it is
 *    *server* state, but only if it is finite and positive.
 * 3. **`too-short` before `completed`.** A zero accumulated watch time means the
 *    accumulator never ran — a client defect, and a visible one: the server has
 *    no lower bound, so `listen_duration_ms: 0` is accepted
 *    (`SkipActionSerializer.listen_duration_ms` is `min_value=0` with no
 *    `max_value`, `serializers.py:764`) and `_completion_rate(0, clip)` returns
 *    `0.0`, which `record_skip` records as a *real* sample
 *    (`interactions.py:291-299`, `recorded = completion_rate is not None`). Every
 *    such request is therefore a systematic downward push on a 30 %-of-ranking
 *    metric. **The distinction this draws is exactly zero versus small**: a
 *    1 ms watch on a 60 s clip is a legitimate early exit and IS reported (there
 *    is no "too short to be meaningful" floor — the guard measures intent, not
 *    magnitude); a 0 ms watch means the clock never advanced and is refused.
 * 4. **`completed` last among the refusals**, then the skip.
 *
 * Total: every combination of `NaN` / `Infinity` / negative / zero / absent
 * returns a valid `SkipDecision`. It cannot throw.
 */
export function shouldRegisterSkip(input: {
  positionMs: number;
  durationMs: number;
  watchTimeMs: number;
  userInitiated: boolean;
  clipId: string;
  clipDurationMs?: number | null;
}): SkipDecision {
  if (!input.userInitiated) return { kind: 'none', reason: 'not-user-initiated' };

  const clipMs = positiveMs(input.clipDurationMs);
  // The element's own length is authoritative when usable; the server's is the
  // only permitted stand-in, and only because it is not client-controlled.
  const elementMs = positiveMs(input.durationMs);
  const durationMs = elementMs > 0 ? elementMs : clipMs;
  if (durationMs <= 0) return { kind: 'none', reason: 'unknown-duration' };

  const watched = positiveMs(input.watchTimeMs);
  // The raw zero check runs FIRST, before the progress comparison, so a dead
  // accumulator at 99 % is reported as `too-short` and never mislabelled as a
  // finish. `positiveMs` also absorbs a NaN/infinite watch time, so those land
  // here too rather than producing a nonsense ratio.
  if (watched <= 0) return { kind: 'none', reason: 'too-short' };

  const positionMs = positiveMs(input.positionMs);
  // Both operands are finite and the denominator is positive, so `progress` is
  // never NaN. It can be +Infinity (a tiny duration against a huge position),
  // which compares fine and lands on 'completed'.
  const progress = positionFraction(positionMs, durationMs);
  if (progress >= COMPLETION_THRESHOLD) return { kind: 'none', reason: 'completed' };

  // One implementation of the cap, reused rather than restated: `reportableWatchedMs`
  // is the same function the telemetry path calls, so the skip channel and the
  // view channel cannot drift on how far over a claim may run. A throwaway
  // accumulator is built deliberately — it is a plain data object, and
  // duplicating the cap arithmetic here is the one way this pair could disagree.
  //
  // `durationMs` is passed as the element length even when it came from
  // `clipDurationMs`, so the cap is `min(effective length, server length)` in
  // both branches. It cannot come out 0: that needs a cap of 0, which needs
  // `durationMs <= 0`, which returned above.
  const listenDurationMs = reportableWatchedMs(
    { clipId: input.clipId, watchedMs: watched, lastPositionMs: positionMs, lastTickAt: null },
    { elementDurationMs: durationMs, clipDurationMs: clipMs },
  );

  // The SECOND zero guard runs on the ROUNDED, CAPPED value — the exact integer
  // that leaves this function — and is not redundant with the check above. The
  // first sees 0.4 ms as positive; `reportableWatchedMs` then rounds it to 0 on
  // the way out. The server has no lower bound on `listen_duration_ms`, so that
  // 0 was recorded as a real 0.0 completion sample: exactly the downward
  // deflation this function exists to prevent, reachable by any caller that
  // hand-builds an accumulator instead of going through `observe`. Guarding the
  // emitted value makes the two impossible to disagree.
  if (listenDurationMs <= 0) return { kind: 'none', reason: 'too-short' };

  return { kind: 'skip', listenDurationMs, reelPositionMs: Math.round(positionMs) };
}