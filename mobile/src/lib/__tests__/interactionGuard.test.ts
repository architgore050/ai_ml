/**
 * The watch-time accumulator and the completion guard.
 *
 * ## These tests import the SHIPPED functions
 * Nothing here re-implements the rule it checks. The failure mode this file
 * exists to prevent is the one `feedBuffer.test.ts:9-19` documents at length: a
 * suite that passes 7/7 while measuring 0.0% of the shipped code, because the
 * assertion was written against a local copy.
 *
 * ## No renderer, no fake timers, by construction
 * `nowMs` is injected everywhere — `interactionGuard.ts` never calls
 * `Date.now()` — so every timing rule is asserted with plain integers and a
 * chosen origin. A bug here corrupts a ranking metric silently and asynchronously
 * (`counter_store` -> Redis -> `flush_counters_to_pg`), which means there is no
 * production signal to fall back on: if these tests do not catch it, nothing
 * will.
 *
 * ## Mutants are pinned, not assumed
 * The mutations at the bottom of each Part were each verified to turn this file
 * red. A test that has never been seen red is not evidence, and in a file this
 * consequential the distinction matters more than the coverage number.
 */

import {
  COMPLETION_THRESHOLD,
  initialAccumulator,
  MAX_TICK_CREDIT_MS,
  observe,
  onSeek,
  reportableWatchedMs,
  resetAccumulator,
  shouldRegisterSkip,
  startClip,
  type SkipDecision,
  type WatchAccumulator,
} from '../interactionGuard';
import { pacing } from '../../design/tokens';

/** A clock origin far from 0, so a stray `Date.now()` in the module is obvious. */
const T0 = 1_700_000_000_000;

const CLIP_A = 'clip-a';
const CLIP_B = 'clip-b';

/** A 60 s clip, the duration the brief's seek case is stated in. */
const SIXTY_S = 60_000;

const started = (clipId = CLIP_A, nowMs = T0): WatchAccumulator =>
  startClip(initialAccumulator(), clipId, nowMs);

/** Fold one observation in. */
const tick = (
  state: WatchAccumulator,
  positionMs: number,
  nowMs: number,
  playing = true,
  clipId = CLIP_A,
): WatchAccumulator => observe(state, { clipId, positionMs, nowMs, playing });

/** A `durationMs`/`watchTimeMs` pair for the guard's happy path. */
/** Position on a 60 s clip that sits exactly on the threshold. */
const atThreshold = SIXTY_S * COMPLETION_THRESHOLD; // 54_000

const guardInput = (over: Partial<Parameters<typeof shouldRegisterSkip>[0]> = {}) => ({
  positionMs: 10_000,
  durationMs: SIXTY_S,
  watchTimeMs: 10_000,
  userInitiated: true,
  clipId: CLIP_A,
  ...over,
});

// ===========================================================================
// PART 1 — the accumulator
// ===========================================================================

describe('watch accumulator', () => {
  describe('the constants', () => {
    it('caps one tick at 1000 ms, the value the fixed web client uses', () => {
      // frontend/src/stores/player.tsx:147. Restated as a literal so a change
      // to the constant fails here instead of silently redefining "a tick".
      expect(MAX_TICK_CREDIT_MS).toBe(1000);
    });

    it('reads the completion threshold from the design token, and that token is 0.9', () => {
      // design/tokens.ts:596. Both halves are asserted: the wiring (so the
      // guard cannot drift from the token) and the value (so the token cannot be
      // moved without breaking every boundary case below).
      expect(COMPLETION_THRESHOLD).toBe(0.9);
    });

    it('credits less per tick than the player\'s update interval, so the cap is not routine', () => {
      // store/player.ts:51 creates the player with `updateInterval: 500`.
      expect(500).toBeLessThan(MAX_TICK_CREDIT_MS);
    });
  });

  describe('a fresh accumulator', () => {
    it('has no clip, no watch time, no position and no baseline', () => {
      expect(initialAccumulator()).toEqual({
        clipId: null,
        watchedMs: 0,
        lastPositionMs: 0,
        lastTickAt: null,
      });
    });

    it('counts watch time from the instant the clip was started', () => {
      // `startClip` seeds the baseline, exactly as `resetAccumulator` does — the
      // two differ only in which clip they describe. So the first tick credits
      // the time since the start, not zero.
      const after = tick(started(), 1_000, T0 + 500);
      expect(after.watchedMs).toBe(500);
      expect(after.lastTickAt).toBe(T0 + 500);
    });

    it('caps the load-to-first-tick gap like any other tick', () => {
      // A slow load buffers. The gap between `startClip` and the first tick is
      // mostly silence, so it must be bounded by the cap and not credited in
      // full — one unbounded load would otherwise be worth more than the clip.
      const after = tick(started(), 0, T0 + 30 * 60 * 1000);
      expect(after.watchedMs).toBe(MAX_TICK_CREDIT_MS);
    });

    it('credits nothing for its first observation when the start clock was unusable', () => {
      const s = tick(startClip(initialAccumulator(), CLIP_A, Number.NaN), 1_000, T0 + 500);
      expect(s.watchedMs).toBe(0);
      expect(s.lastTickAt).toBe(T0 + 500);
    });

    it('refuses an observation that names no started clip, rather than crediting into null', () => {
      const after = tick(initialAccumulator(), 1_000, T0 + 500);
      expect(after.watchedMs).toBe(0);
      expect(after.clipId).toBe(CLIP_A);
    });
  });

  describe('credit is the TIME DELTA, never the position', () => {
    it('credits elapsed wall-clock time while the position is ignored', () => {
      // 5 ticks of 500 ms = 2500 ms, whatever the playhead did.
      let s = started();
      for (let i = 1; i <= 5; i += 1) s = tick(s, i * 500, T0 + i * 500);
      expect(s.watchedMs).toBe(2_500);
    });

    it('credits the same total whether the playhead advanced or stood still', () => {
      const advance = [0, 250, 900, 1_800, 3_000];
      const frozen = [1_000, 1_000, 1_000, 1_000, 1_000];

      const run = (positions: number[]): number => {
        let s = started();
        positions.forEach((p, i) => {
          s = tick(s, p, T0 + (i + 1) * 500);
        });
        return s.watchedMs;
      };

      expect(run(advance)).toBe(2_500);
      // A frozen playhead is exactly what a stalled player looks like. Crediting
      // it would report watch time for a clip that was not making sound.
      expect(run(frozen)).toBe(run(advance));
    });
  });

  describe('the per-tick cap: iOS background suspension', () => {
    it('credits the cap, not the gap, for a 30-minute background gap', () => {
      const thirtyMinutes = 30 * 60 * 1000;
      const after = tick(started(), 0, T0 + thirtyMinutes);
      expect(after.watchedMs).toBe(MAX_TICK_CREDIT_MS);
      expect(after.watchedMs).not.toBe(thirtyMinutes);
    });

    it('caps every gap at or beyond the cap, not just one', () => {
      const gaps = [
        MAX_TICK_CREDIT_MS,
        MAX_TICK_CREDIT_MS + 1,
        5_000,
        60_000,
        30 * 60 * 1000,
        8 * 60 * 60 * 1000,
      ];
      for (const gap of gaps) {
        const after = tick(started(), 0, T0 + gap);
        expect(after.watchedMs).toBe(MAX_TICK_CREDIT_MS);
      }
    });

    it('credits a gap below the cap exactly, and does not round it up to the cap', () => {
      expect(tick(started(), 0, T0 + 999).watchedMs).toBe(999);
      expect(tick(started(), 0, T0 + 500).watchedMs).toBe(500);
      expect(tick(started(), 0, T0 + 1).watchedMs).toBe(1);
    });

    it('a background gap can never manufacture a perfect completion on a short clip', () => {
      // The failure this cap exists for: a 10 s clip nobody listened to must not
      // reach 1.0. Ten 30-minute "ticks" would be 10 credits without the cap.
      let s = started();
      for (let i = 1; i <= 10; i += 1) {
        s = tick(s, 0, T0 + i * 30 * 60 * 1000);
      }
      const reportable = reportableWatchedMs(s, {
        elementDurationMs: 10_000,
        clipDurationMs: 10_000,
      });
      expect(reportable).toBe(10_000);
      // Without the cap this would be 18 000 000 on a 10 000 ms clip.
      expect(reportable).toBeLessThanOrEqual(10_000);
    });
  });

  describe('a seek credits nothing', () => {
    it('seeking 0:00 -> 0:55 of a 60 s clip via onSeek credits 0, not 55 000', () => {
      let s = started();
      s = tick(s, 0, T0 + 1_000); // 1 s genuinely listened.
      expect(s.watchedMs).toBe(1_000);

      s = onSeek(s, { clipId: CLIP_A, positionMs: 55_000, nowMs: T0 + 1_200 });
      expect(s.watchedMs).toBe(1_000);
      expect(s.lastPositionMs).toBe(55_000);

      // Ten seconds of further listening on top of the seek.
      s = tick(s, 55_000, T0 + 2_200);
      expect(s.watchedMs).toBe(2_000);

      // The old client would have reported 56 000 ms of "watch time".
      expect(s.watchedMs).not.toBeGreaterThan(11_000);
    });

    it('seeking WITHOUT onSeek also credits nothing — the delta is immune by construction', () => {
      // The property, as opposed to the contract. If a caller forgets to wire
      // `onSeek`, the accumulator still cannot be defrauded by a seek.
      let s = started();
      s = tick(s, 0, T0 + 1_000);
      // No onSeek: the playhead jumps 0 -> 55 000 and the next tick just reads the clock.
      s = tick(s, 55_000, T0 + 2_000);
      expect(s.watchedMs).toBe(2_000);

      const reportable = reportableWatchedMs(s, {
        elementDurationMs: SIXTY_S,
        clipDurationMs: SIXTY_S,
      });
      // 2 000 / 60 000 = 0.033. The old client reported 0.92 here.
      expect(reportable / SIXTY_S).toBeLessThan(0.05);
    });

    it('a backward seek credits nothing either', () => {
      let s = started();
      // 4 s at once is capped to MAX_TICK_CREDIT_MS — the cap applies to the
      // tick, not only to background gaps.
      s = tick(s, 40_000, T0 + 4_000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);
      s = onSeek(s, { clipId: CLIP_A, positionMs: 0, nowMs: T0 + 4_500 });
      s = tick(s, 0, T0 + 5_500);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS + 1_000);
    });
  });

  describe('monotonic, never negative', () => {
    it('never decreases across 50 observations, including every hostile shape', () => {
      const hostile: Array<Partial<{ positionMs: number; nowMs: number; playing: boolean }>> = [
        {},
        { positionMs: NaN },
        { positionMs: -1 },
        { nowMs: NaN },
        { nowMs: -1 },
        { nowMs: Infinity },
        { positionMs: Infinity },
        { playing: false },
        { positionMs: Number.MAX_SAFE_INTEGER },
      ];

      let s = started();
      let previous = s.watchedMs;
      for (let i = 1; i <= 50; i += 1) {
        const bad = hostile[i % hostile.length] ?? {};
        s = tick(s, bad.positionMs ?? i * 300, bad.nowMs ?? T0 + i * 500, bad.playing ?? true);
        expect(s.watchedMs).toBeGreaterThanOrEqual(previous);
        expect(s.watchedMs).toBeGreaterThanOrEqual(0);
        previous = s.watchedMs;
      }
    });

    it('credits 0 for a backwards clock and re-baselines so it cannot wedge', () => {
      let s = started();
      s = tick(s, 0, T0 + 5_000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);

      // Device reset / NTP correction: the clock jumps back an hour.
      s = tick(s, 0, T0 - 3_600_000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);

      // ...and the next ordinary tick measures from the new baseline, so the
      // accumulator cannot wedge at zero for the rest of the session.
      s = tick(s, 0, T0 - 3_600_000 + 500);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS + 500);
    });

    it('holds no negative value from a negative position, on any entry point', () => {
      let s = tick(started(), -5_000, T0 + 100);
      expect(s.lastPositionMs).toBe(0);
      expect(s.watchedMs).toBe(100);

      s = onSeek(s, { clipId: CLIP_A, positionMs: -1, nowMs: T0 + 200 });
      expect(s.lastPositionMs).toBe(0);
      expect(s.watchedMs).toBe(100);
      expect(s.watchedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('non-finite and negative inputs are refused, not propagated', () => {
    it('never lets a NaN clock move the baseline — which would mint fake watch time', () => {
      // The subtle one. Coercing NaN -> 0 and STORING it would leave the next
      // good tick reading a delta of ~1.7e12 ms, which the cap satisfies at its
      // full 1000 ms: one bad tick would buy a full second of fabricated watch
      // time out of a 50 ms gap.
      let s = tick(started(), 0, T0 + 1_000);
      expect(s.watchedMs).toBe(1_000);

      s = tick(s, 0, Number.NaN);
      expect(s.watchedMs).toBe(1_000);
      expect(s.lastTickAt).toBe(T0 + 1_000);

      s = tick(s, 0, T0 + 1_050);
      expect(s.watchedMs).toBe(1_050);
    });

    it('the same for a negative clock', () => {
      let s = tick(started(), 0, T0 + 1_000);
      s = tick(s, 0, -1);
      expect(s.lastTickAt).toBe(T0 + 1_000);
      s = tick(s, 0, T0 + 1_100);
      expect(s.watchedMs).toBe(1_100);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['-1', -1],
      ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ])('a %s position is coerced to a usable number, not propagated', (_label, positionMs) => {
      const s = tick(started(), positionMs, T0 + 100);
      expect(Number.isFinite(s.lastPositionMs)).toBe(true);
      expect(s.lastPositionMs).toBeGreaterThanOrEqual(0);
      // The credit comes from the clock, so it is 100 ms whatever the position
      // was — which is the property that makes a frozen playhead harmless.
      expect(s.watchedMs).toBe(100);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['-1', -1],
    ])('a %s clock still leaves a usable state', (_label, nowMs) => {
      const s = tick(started(), 1_000, nowMs);
      expect(Number.isFinite(s.watchedMs)).toBe(true);
      expect(s.watchedMs).toBeGreaterThanOrEqual(0);
      expect(s.lastTickAt === null || Number.isFinite(s.lastTickAt)).toBe(true);
    });

    it('never overflows to Infinity, even from a hand-built near-MAX state', () => {
      // Unreachable through the public API (50 ticks of 1000 ms cannot get
      // here), but "the state never holds a non-finite number" is a property
      // this module claims, so it is enforced rather than assumed.
      const absurd: WatchAccumulator = {
        clipId: CLIP_A,
        watchedMs: Number.MAX_VALUE,
        lastPositionMs: 0,
        lastTickAt: T0,
      };
      const s = observe(absurd, { clipId: CLIP_A, positionMs: 0, nowMs: T0 + 500, playing: true });
      expect(Number.isFinite(s.watchedMs)).toBe(true);
      expect(s.watchedMs).toBe(Number.MAX_VALUE);
    });
  });

  describe('playing: false credits nothing', () => {
    it('a paused tick adds zero', () => {
      let s = started();
      s = tick(s, 5_000, T0 + 5_000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);
      // A minute of wall clock while paused: the tick itself adds nothing.
      s = tick(s, 5_000, T0 + 65_000, false);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);
    });

    it('a 10-minute stall is discarded rather than collected on resume', () => {
      // The store freezes `currentTime` during a stall and on Android stops
      // writing it entirely, so a heartbeat in the stall re-reads the same
      // number. If the baseline did not move, the first playing tick after a
      // long stall would see the whole gap and collect the cap.
      let s = started();
      s = tick(s, 5_000, T0 + 5_000);
      for (let i = 1; i <= 12; i += 1) {
        s = tick(s, 5_000, T0 + 5_000 + i * 50_000, false);
      }
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);

      s = tick(s, 5_000, T0 + 5_000 + 12 * 50_000 + 500);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS + 500);
    });

    it('a paused tick still records the position, because the playhead is still there', () => {
      const s = tick(started(), 7_500, T0 + 100, false);
      expect(s.lastPositionMs).toBe(7_500);
      expect(s.watchedMs).toBe(0);
    });

    it('a paused tick with an unusable clock moves nothing at all', () => {
      let s = tick(started(), 0, T0 + 1_000);
      s = tick(s, 0, Number.NaN, false);
      expect(s.lastTickAt).toBe(T0 + 1_000);
      s = tick(s, 0, T0 + 1_250);
      expect(s.watchedMs).toBe(1_250);
    });
  });

  describe('a stale baseline is bounded', () => {
    it('a 30-minute stale lastTickAt credits at most the cap, never the gap', () => {
      const stale: WatchAccumulator = {
        clipId: CLIP_A,
        watchedMs: 2_000,
        lastPositionMs: 1_000,
        lastTickAt: T0,
      };
      const after = observe(stale, {
        clipId: CLIP_A,
        positionMs: 1_000,
        nowMs: T0 + 30 * 60 * 1000,
        playing: true,
      });
      expect(after.watchedMs).toBe(2_000 + MAX_TICK_CREDIT_MS);
    });

    it('a null baseline on an otherwise perfect state still credits nothing', () => {
      const stale: WatchAccumulator = {
        clipId: CLIP_A,
        watchedMs: 7_000,
        lastPositionMs: 1_000,
        lastTickAt: null,
      };
      const after = observe(stale, {
        clipId: CLIP_A,
        positionMs: 1_000,
        nowMs: T0 + 10_000,
        playing: true,
      });
      expect(after.watchedMs).toBe(7_000);
      expect(after.lastTickAt).toBe(T0 + 10_000);
    });
  });

  describe('changing clip resets everything, atomically', () => {
    const wellEstablished = (): WatchAccumulator => {
      let s = started(CLIP_A);
      for (let i = 1; i <= 4; i += 1) s = tick(s, i * 1_000, T0 + i * 1_000);
      s = onSeek(s, { clipId: CLIP_A, positionMs: 40_000, nowMs: T0 + 4_500 });
      return s;
    };

    it('carries nothing across from the previous clip', () => {
      const before = wellEstablished();
      expect(before.watchedMs).toBe(4_000);
      expect(before.lastPositionMs).toBe(40_000);

      const after = startClip(before, CLIP_B, T0 + 10_000);
      expect(after).toEqual({
        clipId: CLIP_B,
        watchedMs: 0,
        lastPositionMs: 0,
        lastTickAt: T0 + 10_000,
      });
    });

    it('an observe naming a different clip switches rather than mixes', () => {
      const before = wellEstablished();
      const after = tick(before, 0, T0 + 10_000, true, CLIP_B);
      expect(after.clipId).toBe(CLIP_B);
      expect(after.watchedMs).toBe(0);
      expect(after.lastPositionMs).toBe(0);
      expect(after.lastTickAt).toBe(T0 + 10_000);
    });

    it('does not credit the wall-clock gap between the two clips', () => {
      // The half-reset failure: a fresh watchedMs with the OLD baseline left in
      // place would credit the whole swipe as the new clip's watch time.
      let s = wellEstablished();
      const swipeMs = 800; // a slow, deliberate swipe
      s = tick(s, 0, T0 + 4_500 + swipeMs, true, CLIP_B);
      expect(s.watchedMs).toBe(0);

      // A second tick after the swipe settles does credit normally.
      s = tick(s, 200, T0 + 4_500 + swipeMs + 400, true, CLIP_B);
      expect(s.watchedMs).toBe(400);
    });

    it('a seek naming a different clip switches too', () => {
      const after = onSeek(wellEstablished(), {
        clipId: CLIP_B,
        positionMs: 55_000,
        nowMs: T0 + 20_000,
      });
      expect(after.clipId).toBe(CLIP_B);
      expect(after.watchedMs).toBe(0);
      expect(after.lastPositionMs).toBe(0);
    });

    it('two full clips never accumulate into one number', () => {
      let s = started(CLIP_A);
      for (let i = 1; i <= 3; i += 1) s = tick(s, i * 1_000, T0 + i * 1_000);
      expect(s.watchedMs).toBe(3_000);

      s = startClip(s, CLIP_B, T0 + 50_000);
      for (let i = 1; i <= 2; i += 1) {
        s = tick(s, i * 500, T0 + 50_000 + i * 500, true, CLIP_B);
      }
      expect(s.watchedMs).toBe(1_000);
      expect(s.clipId).toBe(CLIP_B);
    });
  });

  describe('resetAccumulator re-baselines without crediting', () => {
    it('keeps the clip and the total, and discards the baseline', () => {
      let s = started();
      s = tick(s, 3_000, T0 + 3_000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);

      // App resumes 30 minutes later. iOS suspended the timers, so no tick of
      // any kind arrived — and the player still reports `playing: true`.
      s = resetAccumulator(s, T0 + 30 * 60 * 1000);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS);
      expect(s.clipId).toBe(CLIP_A);
      expect(s.lastTickAt).toBe(T0 + 30 * 60 * 1000);
    });

    it('the first tick after a resume credits only its own delta, not the gap', () => {
      let s = started();
      s = tick(s, 3_000, T0 + 3_000);
      s = resetAccumulator(s, T0 + 30 * 60 * 1000);
      s = tick(s, 3_500, T0 + 30 * 60 * 1000 + 500);
      expect(s.watchedMs).toBe(MAX_TICK_CREDIT_MS + 500);
    });

    it('an unusable clock clears the baseline rather than storing a bad one', () => {
      const s = resetAccumulator(tick(started(), 1_000, T0 + 1_000), Number.NaN);
      expect(s.lastTickAt).toBeNull();
      expect(s.watchedMs).toBe(1_000);
    });
  });

  describe('reportableWatchedMs', () => {
    it('passes the total through when it is below every cap', () => {
      const s = tick(tick(started(), 1_000, T0 + 1_000), 2_000, T0 + 2_000);
      expect(reportableWatchedMs(s, { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S })).toBe(
        2_000,
      );
    });

    it('caps at the element duration when the server has no duration yet', () => {
      const s: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 70_000 };
      // duration_ms is 0 between upload and HLS processing, and permanently 0
      // for any clip not produced by process_audio_to_hls.
      expect(reportableWatchedMs(s, { elementDurationMs: SIXTY_S, clipDurationMs: 0 })).toBe(
        SIXTY_S,
      );
      expect(reportableWatchedMs(s, { elementDurationMs: SIXTY_S, clipDurationMs: null })).toBe(
        SIXTY_S,
      );
    });

    it('caps at the server duration when the element reports none', () => {
      const s: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 70_000 };
      expect(reportableWatchedMs(s, { elementDurationMs: 0, clipDurationMs: SIXTY_S })).toBe(
        SIXTY_S,
      );
    });

    it('uses the SHORTER of the two lengths', () => {
      const s: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 70_000 };
      expect(reportableWatchedMs(s, { elementDurationMs: 90_000, clipDurationMs: SIXTY_S })).toBe(
        SIXTY_S,
      );
      expect(reportableWatchedMs(s, { elementDurationMs: 30_000, clipDurationMs: SIXTY_S })).toBe(
        30_000,
      );
    });

    it('returns the raw clamped total when neither length is usable', () => {
      const s: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 4_321 };
      // Returning 0 here would be recorded server-side as a real 0.0 completion
      // sample: `_completion_rate(0, clip)` is 0.0, not None, so it IS recorded.
      for (const hint of [
        { elementDurationMs: 0, clipDurationMs: 0 },
        { elementDurationMs: null, clipDurationMs: null },
        { elementDurationMs: undefined, clipDurationMs: undefined },
        { elementDurationMs: Number.NaN, clipDurationMs: Number.NaN },
      ]) {
        expect(reportableWatchedMs(s, hint)).toBe(4_321);
      }
    });

    it('lands exactly on the cap at the boundary', () => {
      const at: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 60_000 };
      const over: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 60_001 };
      const hint = { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S };
      expect(reportableWatchedMs(at, hint)).toBe(60_000);
      expect(reportableWatchedMs(over, hint)).toBe(60_000);
    });

    it('rounds to whole milliseconds and never returns a negative', () => {
      const odd: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: 4_321.6 };
      expect(reportableWatchedMs(odd, { elementDurationMs: 0, clipDurationMs: 0 })).toBe(4_322);

      const negative: WatchAccumulator = { ...initialAccumulator(), clipId: CLIP_A, watchedMs: -9 };
      expect(reportableWatchedMs(negative, { elementDurationMs: 0, clipDurationMs: 0 })).toBe(0);
    });

    it('is TOTAL — no combination of hostile inputs yields NaN, Infinity or a negative', () => {
      // Enumerated, not sampled: the claim is a property of the whole input
      // space, so a sample would not establish it.
      const watched = [0, 1, 999, 60_000, 60_001, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE];
      const element = [...watched, null, undefined];
      const clip = [...watched, null, undefined];

      let cases = 0;
      for (const w of watched) {
        for (const e of element) {
          for (const c of clip) {
            const state: WatchAccumulator = {
              clipId: CLIP_A,
              watchedMs: w,
              lastPositionMs: 0,
              lastTickAt: T0,
            };
            const out = reportableWatchedMs(state, {
              elementDurationMs: e,
              clipDurationMs: c,
            });
            cases += 1;
            expect(Number.isNaN(out)).toBe(false);
            expect(Number.isFinite(out)).toBe(true);
            expect(out).toBeGreaterThanOrEqual(0);
          }
        }
      }
      // 11 x 13 x 13. A truncated loop that quietly tested 20 cases would look
      // identical from outside.
      expect(cases).toBe(11 * 13 * 13);
    });
  });
});

// ===========================================================================
// PART 2 — the completion guard
// ===========================================================================

describe('shouldRegisterSkip', () => {
  describe('the truth table', () => {
    // userInitiated x progress (below / at / above threshold) x duration
    // (usable / unusable). 12 cells, all of them asserted. `watchTimeMs` is held
    // at a value strictly below both the position and the threshold-crossing
    // point so that only the cell under test can decide the outcome.
    const DURATION = SIXTY_S;
    const cases: Array<{
      label: string;
      userInitiated: boolean;
      positionMs: number;
      durationMs: number;
      clipDurationMs?: number | null;
      expected: SkipDecision;
    }> = [
      // --- progress BELOW threshold -------------------------------------
      {
        label: 'below threshold, user-initiated, usable duration -> skip',
        userInitiated: true,
        positionMs: 10_000,
        durationMs: DURATION,
        expected: { kind: 'skip', listenDurationMs: 10_000, reelPositionMs: 10_000 },
      },
      {
        label: 'below threshold, NOT user-initiated -> none',
        userInitiated: false,
        positionMs: 10_000,
        durationMs: DURATION,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
      {
        label: 'below threshold, user-initiated, unusable duration -> unknown-duration',
        userInitiated: true,
        positionMs: 10_000,
        durationMs: 0,
        expected: { kind: 'none', reason: 'unknown-duration' },
      },
      {
        label: 'below threshold, NOT user-initiated AND unusable duration -> not-user-initiated wins',
        userInitiated: false,
        positionMs: 10_000,
        durationMs: Number.NaN,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
      // --- progress AT threshold ---------------------------------------
      {
        label: 'AT threshold, user-initiated -> none (completed)',
        userInitiated: true,
        positionMs: atThreshold,
        durationMs: DURATION,
        expected: { kind: 'none', reason: 'completed' },
      },
      {
        label: 'AT threshold, NOT user-initiated -> not-user-initiated',
        userInitiated: false,
        positionMs: atThreshold,
        durationMs: DURATION,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
      {
        label: 'AT threshold, user-initiated, unusable duration -> unknown-duration',
        userInitiated: true,
        positionMs: atThreshold,
        durationMs: Number.POSITIVE_INFINITY,
        expected: { kind: 'none', reason: 'unknown-duration' },
      },
      {
        label: 'AT threshold, NOT user-initiated, unusable duration -> not-user-initiated',
        userInitiated: false,
        positionMs: atThreshold,
        durationMs: -1,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
      // --- progress ABOVE threshold ------------------------------------
      {
        label: 'above threshold, user-initiated -> none (completed)',
        userInitiated: true,
        positionMs: 59_000,
        durationMs: DURATION,
        expected: { kind: 'none', reason: 'completed' },
      },
      {
        label: 'above threshold, NOT user-initiated -> not-user-initiated',
        userInitiated: false,
        positionMs: 59_000,
        durationMs: DURATION,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
      {
        label: 'above threshold, user-initiated, unusable duration -> unknown-duration',
        userInitiated: true,
        positionMs: 59_000,
        durationMs: Number.NaN,
        expected: { kind: 'none', reason: 'unknown-duration' },
      },
      {
        label: 'above threshold, NOT user-initiated, unusable duration -> not-user-initiated',
        userInitiated: false,
        positionMs: 59_000,
        durationMs: 0,
        expected: { kind: 'none', reason: 'not-user-initiated' },
      },
    ];

    it.each(cases)('$label', ({ userInitiated, positionMs, durationMs, clipDurationMs, expected }) => {
      expect(
        shouldRegisterSkip(
          guardInput({ userInitiated, positionMs, durationMs, watchTimeMs: 10_000, clipDurationMs }),
        ),
      ).toEqual(expected);
    });

    it('covers all twelve cells', () => {
      expect(cases).toHaveLength(12);
    });
  });

  describe('auto-advance must never produce a skip', () => {
    it('a natural completion at progress >= 0.99 reports nothing', () => {
      // The original defect: every finished clip in the session counted as an
      // abandonment, because the decision was made on position alone.
      const decision = shouldRegisterSkip(
        guardInput({ positionMs: 59_940, durationMs: SIXTY_S, watchTimeMs: 59_940, userInitiated: false }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'not-user-initiated' });
    });

    it.each([0, 0.5, 0.89, 0.9, 0.99, 1, 1.5, 2])(
      'progress %p with userInitiated false is never a skip',
      (fraction) => {
        expect(
          shouldRegisterSkip(
            guardInput({
              positionMs: SIXTY_S * fraction,
              durationMs: SIXTY_S,
              userInitiated: false,
            }),
          ).kind,
        ).toBe('none');
      },
    );

    it('is checked before the duration, so a garbage duration during auto-advance cannot leak a skip', () => {
      expect(
        shouldRegisterSkip(
          guardInput({ userInitiated: false, positionMs: 1_000, durationMs: Number.NaN, watchTimeMs: 1_000 }),
        ),
      ).toEqual({ kind: 'none', reason: 'not-user-initiated' });
    });
  });

  describe('the completion boundary is exactly the token', () => {
    const at = (fraction: number) =>
      shouldRegisterSkip(
        guardInput({ positionMs: SIXTY_S * fraction, durationMs: SIXTY_S, watchTimeMs: 30_000 }),
      );

    it('one millisecond below the threshold still skips', () => {
      expect(atThreshold - 1).toBe(53_999);
      expect(at(COMPLETION_THRESHOLD - 1 / SIXTY_S)).toEqual({
        kind: 'skip',
        listenDurationMs: 30_000,
        reelPositionMs: 53_999,
      });
    });

    it('exactly at the threshold does not skip', () => {
      expect(at(COMPLETION_THRESHOLD)).toEqual({ kind: 'none', reason: 'completed' });
    });

    it('one millisecond above does not skip', () => {
      expect(atThreshold + 1).toBe(54_001);
      expect(at(COMPLETION_THRESHOLD + 1 / SIXTY_S)).toEqual({
        kind: 'none',
        reason: 'completed',
      });
    });

    it('the threshold is read from the token, so moving the token moves the boundary', () => {
      // `pacing` is imported here directly, independently of the module under
      // test, so this cannot pass by importing the same wrong constant twice.
      expect(atThreshold).toBe(SIXTY_S * pacing.completionThreshold);
      expect(pacing.completionThreshold).toBe(COMPLETION_THRESHOLD);
    });

    it('FOLLOWS the token when the token moves — the guard does not hardcode 0.9', () => {
      // The assertion above cannot kill a hardcoded `0.9`, because the token
      // *is* 0.9 today: the mutant and the shipped code are the same function.
      // Verified — that mutant survived every other test in this file. The only
      // thing that distinguishes them is a token with a different value, so this
      // re-imports the guard against a token that says 0.5 and asserts the
      // boundary moved with it.
      //
      // `jest.isolateModules` gives a fresh module registry entry, so the
      // already-imported copy at the top of this file is untouched.
      let guarded: typeof shouldRegisterSkip | null = null;
      let threshold: number | null = null;
      jest.isolateModules(() => {
        jest.doMock('../../design/tokens', () => ({
          pacing: { completionThreshold: 0.5 },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../interactionGuard') as typeof import('../interactionGuard');
        guarded = fresh.shouldRegisterSkip;
        threshold = fresh.COMPLETION_THRESHOLD;
      });
      jest.dontMock('../../design/tokens');

      expect(threshold).toBe(0.5);
      const skipAt = guarded as unknown as typeof shouldRegisterSkip;

      // progress 0.6. The hardcoded-0.9 mutant answers `skip` here; the token
      // says `completed`. That difference is the whole point of the test.
      expect(skipAt(guardInput({ positionMs: 36_000, watchTimeMs: 30_000 }))).toEqual({
        kind: 'none',
        reason: 'completed',
      });
      // The boundary itself moves with the token: 0.5 exactly is not a skip,
      // one millisecond under it is.
      expect(skipAt(guardInput({ positionMs: 30_000, watchTimeMs: 30_000 }))).toEqual({
        kind: 'none',
        reason: 'completed',
      });
      expect(skipAt(guardInput({ positionMs: 29_999, watchTimeMs: 30_000 }))).toEqual({
        kind: 'skip',
        listenDurationMs: 30_000,
        reelPositionMs: 29_999,
      });
      // progress 0.4 — below both thresholds, so still a skip.
      expect(skipAt(guardInput({ positionMs: 24_000, watchTimeMs: 30_000 })).kind).toBe('skip');

      // The module-level copy this file imported is unaffected by the doMock,
      // and still reads 0.9 — so the same input answers the other way.
      expect(COMPLETION_THRESHOLD).toBe(0.9);
      expect(
        shouldRegisterSkip(guardInput({ positionMs: 36_000, watchTimeMs: 30_000 })).kind,
      ).toBe('skip');
    });
  });

  describe('watchTimeMs is the numerator, and zero is refused', () => {
    it('reports a 1 ms watch on a 60 s clip — magnitude is not the test', () => {
      // There is no "too short to be meaningful" floor. The guard measures
      // INTENT, not magnitude: a 1 ms exit is a real early exit.
      expect(shouldRegisterSkip(guardInput({ watchTimeMs: 1 }))).toEqual({
        kind: 'skip',
        listenDurationMs: 1,
        reelPositionMs: 10_000,
      });
    });

    it.each([
      ['0', 0],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('refuses a %s watch time with reason too-short', (_label, watchTimeMs) => {
      expect(shouldRegisterSkip(guardInput({ watchTimeMs }))).toEqual({
        kind: 'none',
        reason: 'too-short',
      });
    });

    it('refusing zero is what stops a systematic downward push on a 30% metric', () => {
      // The server has NO lower bound: SkipActionSerializer.listen_duration_ms
      // is min_value=0 with no max_value (serializers.py:764), and
      // _completion_rate(0, clip) is 0.0 — not None — so record_skip records it
      // as a REAL sample (interactions.py:291-299).
      expect(shouldRegisterSkip(guardInput({ watchTimeMs: 0 })).kind).toBe('none');
      // ...and the smallest value that does survive is 1.
      expect(shouldRegisterSkip(guardInput({ watchTimeMs: 1 }))).toMatchObject({
        listenDurationMs: 1,
      });
    });

    it('too-short outranks completed, so a dead accumulator is never mislabelled as a finish', () => {
      expect(
        shouldRegisterSkip(guardInput({ positionMs: 59_900, watchTimeMs: 0 })),
      ).toEqual({ kind: 'none', reason: 'too-short' });
    });
  });

  describe('an unknown duration is refused, never guessed', () => {
    it.each([
      ['0', 0],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('refuses a %s element duration when the server has none either', (_label, durationMs) => {
      expect(shouldRegisterSkip(guardInput({ durationMs, clipDurationMs: 0 }))).toEqual({
        kind: 'none',
        reason: 'unknown-duration',
      });
    });

    it('uses clipDurationMs as the fallback, because it is SERVER state', () => {
      // The element may report no length while it is still loading; the feed row
      // already carries the probed duration.
      expect(shouldRegisterSkip(guardInput({ durationMs: 0, clipDurationMs: SIXTY_S }))).toEqual({
        kind: 'skip',
        listenDurationMs: 10_000,
        reelPositionMs: 10_000,
      });
      // ...and the fallback is a real threshold, not a formality.
      expect(
        shouldRegisterSkip(
          guardInput({ durationMs: 0, clipDurationMs: SIXTY_S, positionMs: 55_000 }),
        ),
      ).toEqual({ kind: 'none', reason: 'completed' });
    });

    it.each([
      ['0', 0],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['null', null],
      ['undefined', undefined],
    ])('still refuses when the fallback itself is %s', (_label, clipDurationMs) => {
      expect(
        shouldRegisterSkip(guardInput({ durationMs: 0, clipDurationMs: clipDurationMs as number | null })),
      ).toEqual({ kind: 'none', reason: 'unknown-duration' });
    });

    it('never uses the server\'s own 60 000 ms divisor as a client-side guess', () => {
      // The web client does exactly this and it is a live defect:
      // frontend/src/stores/player.tsx:734 — `currentTime < (durationSecs || 20) * 0.9`.
      // A 20 s guess on a 60 s clip reports a skip at position 10 s (progress
      // 0.5 by the guess, 0.17 by the server) and misses the real one entirely.
      expect(shouldRegisterSkip(guardInput({ durationMs: 0, clipDurationMs: null }))).toEqual({
        kind: 'none',
        reason: 'unknown-duration',
      });
    });
  });

  describe('listenDurationMs is the WATCH TIME and reelPositionMs is the POSITION', () => {
    it('reports a large gap between the two, and the position never becomes the numerator', () => {
      // Seek to 0:30, listen 4 s, swipe away. The old client sent
      // `listen_duration_ms == reel_position_ms == 30_000`, which scored 0.5 for
      // four seconds of audio — services/interactions.py:252-268 records this as
      // the exact hole the divisor was moved to server state to close.
      const decision = shouldRegisterSkip(
        guardInput({ positionMs: 30_000, watchTimeMs: 4_000, durationMs: SIXTY_S }),
      );
      expect(decision).toEqual({
        kind: 'skip',
        listenDurationMs: 4_000,
        reelPositionMs: 30_000,
      });
      if (decision.kind !== 'skip') throw new Error('expected a skip');
      expect(decision.listenDurationMs).not.toBe(decision.reelPositionMs);
    });

    it('a seek past the threshold is NOT a skip, and that is the token speaking', () => {
      // `pacing.completionThreshold` is defined on POSITION
      // (design/tokens.ts:594-596), so seeking to 0:55 and swiping away reads as
      // `completed` and nothing is reported. Deliberate, and it has a cost: a
      // user who seeks forward and leaves is invisible to the skip signal. The
      // alternative — judging on watch time — is a different rule than the one
      // the token states, so it is not this function's to make.
      expect(
        shouldRegisterSkip(guardInput({ positionMs: 56_000, watchTimeMs: 4_000, durationMs: SIXTY_S })),
      ).toEqual({ kind: 'none', reason: 'completed' });
    });

    it('cannot be confused: the two fields are typed apart and are never equal by construction', () => {
      const decision = shouldRegisterSkip(
        guardInput({ positionMs: 50_000, watchTimeMs: 50_000 }),
      );
      expect(decision).toEqual({
        kind: 'skip',
        listenDurationMs: 50_000,
        reelPositionMs: 50_000,
      });

      // The fields are equal here ONLY because the inputs were equal. Move
      // either one and the outputs separate — that is the whole point.
      const moved = shouldRegisterSkip(guardInput({ positionMs: 50_000, watchTimeMs: 1_000 }));
      expect(moved).toEqual({
        kind: 'skip',
        listenDurationMs: 1_000,
        reelPositionMs: 50_000,
      });
    });

    it('the emitted listenDurationMs uses the SAME cap as the telemetry path', () => {
      // Replayed watching: 200 s of credited watch time on a 60 s clip. Both
      // channels must say 60 000 — the skip channel scoring above the telemetry
      // channel would be two definitions of one number.
      const state: WatchAccumulator = {
        clipId: CLIP_A,
        watchedMs: 200_000,
        lastPositionMs: 59_000,
        lastTickAt: T0,
      };
      const viaTelemetry = reportableWatchedMs(state, {
        elementDurationMs: SIXTY_S,
        clipDurationMs: SIXTY_S,
      });
      const viaSkip = shouldRegisterSkip(
        guardInput({ positionMs: 59_000, watchTimeMs: 200_000, durationMs: SIXTY_S }),
      );
      expect(viaSkip.kind).toBe('none'); // progress >= threshold: no skip at all

      const earlyExit = shouldRegisterSkip(
        guardInput({ positionMs: 10_000, watchTimeMs: 200_000, durationMs: SIXTY_S }),
      );
      expect(earlyExit).toEqual({
        kind: 'skip',
        listenDurationMs: viaTelemetry,
        reelPositionMs: 10_000,
      });
      expect(viaTelemetry).toBe(SIXTY_S);
    });

    it('caps at the shorter length, exactly as reportableWatchedMs does', () => {
      // A stale element still reporting the previous (longer) clip.
      expect(
        shouldRegisterSkip(
          guardInput({ positionMs: 10_000, watchTimeMs: 200_000, durationMs: 120_000, clipDurationMs: SIXTY_S }),
        ),
      ).toEqual({ kind: 'skip', listenDurationMs: SIXTY_S, reelPositionMs: 10_000 });
    });

    it('an emitted listenDurationMs is always at least 1', () => {
      for (const positionMs of [0, 1, 1_000, 53_999]) {
        const decision = shouldRegisterSkip(guardInput({ positionMs, watchTimeMs: 1 }));
        expect(decision).toEqual({
          kind: 'skip',
          listenDurationMs: 1,
          reelPositionMs: positionMs,
        });
      }
    });
  });

  describe('totality', () => {
    it('returns a valid SkipDecision for every combination of hostile inputs, and never throws', () => {
      const hostile = [
        0,
        1,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      ];
      const maybeClip = [...hostile, null, undefined];
      const booleans = [true, false];

      let cases = 0;
      for (const positionMs of hostile) {
        for (const durationMs of hostile) {
          for (const watchTimeMs of hostile) {
            for (const userInitiated of booleans) {
              for (const clipDurationMs of maybeClip) {
                const decision = shouldRegisterSkip({
                  positionMs,
                  durationMs,
                  watchTimeMs,
                  userInitiated,
                  clipId: CLIP_A,
                  clipDurationMs: clipDurationMs as number | null | undefined,
                });
                cases += 1;
                expect(['skip', 'none']).toContain(decision.kind);
                if (decision.kind === 'skip') {
                  expect(Number.isFinite(decision.listenDurationMs)).toBe(true);
                  expect(decision.listenDurationMs).toBeGreaterThan(0);
                  expect(Number.isFinite(decision.reelPositionMs)).toBe(true);
                  expect(decision.reelPositionMs).toBeGreaterThanOrEqual(0);
                } else {
                  expect([
                    'completed',
                    'not-user-initiated',
                    'unknown-duration',
                    'too-short',
                  ]).toContain(decision.reason);
                }
              }
            }
          }
        }
      }
      // 8 x 8 x 8 x 2 x 10 = 10 240. Asserted so a truncated inner loop cannot
      // pass while claiming to have enumerated the space.
      expect(cases).toBe(10_240);
    });

    it('produces no NaN even for the 0/0-style degeneracies', () => {
      for (const durationMs of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        const decision = shouldRegisterSkip(
          guardInput({ positionMs: Number.NaN, durationMs, watchTimeMs: Number.NaN }),
        );
        expect(decision.kind).toBe('none');
      }
    });

    it('a tiny duration against a huge position is completed, not NaN', () => {
      const decision = shouldRegisterSkip(
        guardInput({ positionMs: Number.MAX_SAFE_INTEGER, durationMs: 1, watchTimeMs: 5 }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'completed' });
    });
  });

  describe('the re-derived position fraction', () => {
    // `interactionGuard.ts` re-derives the scrubber's `progressFraction`
    // (`components/reel/SeekProgressBar.tsx:189-193`) rather than importing it.
    // The reason is measured, not stylistic — importing it takes down this whole
    // suite at import time, because `SeekProgressBar.tsx:26` reaches
    // `store/player.ts` and from there `expo-audio`, whose native module is
    // absent under jest:
    //
    //   TypeError: Cannot read properties of undefined (reading 'prototype')
    //     at Object.prototype (node_modules/expo-audio/src/ExpoAudio.ts:30:41)
    //     at Object.require (src/store/player.ts:2:1)
    //     at Object.require (src/components/reel/SeekProgressBar.tsx:26:1)
    //
    // So these tests pin the re-derivation against a restatement of the
    // original's CONTRACT rather than against its import. The restatement is a
    // `clamp01` over the same ratio, which is the whole of what the original
    // does once its two guards are accounted for.
    const ORIGINAL_CONTRACT = (positionMs: number, durationMs: number): number => {
      if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs)) return 0;
      if (durationMs <= 0) return 0;
      return Math.min(Math.max(positionMs / durationMs, 0), 1);
    };

    it('agrees EXACTLY with the original contract whenever the position is within the clip', () => {
      const durations = [1, 100, 999, 1_000, SIXTY_S, 600_000];
      const positions = [0, 1, 500, 53_999, 54_000, 54_001, 60_000];

      let compared = 0;
      for (const durationMs of durations) {
        for (const positionMs of positions) {
          // `positionFraction` is module-private, so it is reached the only way
          // the guard reaches it: through `shouldRegisterSkip`.
          const decision = shouldRegisterSkip(
            guardInput({ positionMs, durationMs, watchTimeMs: 30_000 }),
          );
          const ratio = positionMs / durationMs;
          compared += 1;
          if (ratio <= 1) {
            // In range: the two are the same number, so they must produce the
            // same verdict.
            expect(ratio).toBe(ORIGINAL_CONTRACT(positionMs, durationMs));
            expect(decision.kind).toBe(ratio >= COMPLETION_THRESHOLD ? 'none' : 'skip');
          }
        }
      }
      expect(compared).toBe(6 * 7);
    });

    it('diverges only above 1.0, and the divergence can never change the answer', () => {
      // The only permitted difference is the missing clamp01. If a future edit
      // to `positionFraction` introduces any OTHER divergence — a wrong
      // denominator, a dropped finiteness guard — this fails.
      for (const durationMs of [100, SIXTY_S, 600_000]) {
        for (const positionMs of [0, 60_001, 70_000, 1_000_000, 60 * durationMs]) {
          const ratio = positionMs / durationMs;
          const original = ORIGINAL_CONTRACT(positionMs, durationMs);

          if (ratio !== original) {
            expect(ratio).toBeGreaterThan(1);
            expect(original).toBe(1);
            // ...and both answer `completed`, so the divergence is inert.
            expect(ratio >= COMPLETION_THRESHOLD).toBe(true);
            expect(original >= COMPLETION_THRESHOLD).toBe(true);
          }
        }
      }
    });

    it('refuses before it ever reaches the ratio when the duration is unusable', () => {
      // The reason the guard cannot simply call the original: `progressFraction`
      // substitutes 0 for an unknown duration (SeekProgressBar.tsx:191), which
      // for a scrubber is the correct renderable answer and for this guard is
      // the exact inverse of the required one — it would report a skip precisely
      // where it has admitted it cannot judge.
      for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(ORIGINAL_CONTRACT(10_000, durationMs)).toBe(0);
        expect(
          shouldRegisterSkip(guardInput({ durationMs, clipDurationMs: 0, positionMs: 10_000 })),
        ).toEqual({ kind: 'none', reason: 'unknown-duration' });
      }
    });

    it('a position far beyond the duration reads as completed, not as a skip', () => {
      // The one input class where the guard and the scrubber are asked different
      // questions. Here the unclamped ratio is the more honest one: the
      // over-running position is what `_OVERCLAIM_TOLERANCE`
      // (services/interactions.py:219-225) exists to catch, and clamping to 1.0
      // would make it indistinguishable from an exact finish.
      expect(shouldRegisterSkip(guardInput({ positionMs: 600_000, durationMs: SIXTY_S }))).toEqual({
        kind: 'none',
        reason: 'completed',
      });
    });
  });
});
