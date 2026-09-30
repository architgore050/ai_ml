/**
 * `formatTime` — the reel timecode rule, with no renderer.
 *
 * Pure unit tests, deliberately: `jest.config.js` excludes `src/components/**`
 * from coverage, so a formatter that lived in a component would be unmeasured
 * logic, and the only way to reach these edges through a render would be a
 * render whose own props are the thing under suspicion.
 *
 * ## What the table is asserting
 * The rule is four decisions, and each is pinned at the value that would change
 * if the decision were reversed:
 *
 *  1. `m:ss`, minutes UNBOUNDED — so `3600` is `"60:00"`, not `"1:00:00"`.
 *     Pinned at `3599`/`3600`/`3661` so the boundary is exact from both sides
 *     and so a re-introduced hour branch has to produce a THREE-field string
 *     that no other assertion in the file allows.
 *  2. FLOOR, not round — pinned at `59.4` and `59.9`, the two values where
 *     floor and round disagree by a second.
 *  3. Non-finite and negative are `0:00` — the totality property, asserted over
 *     a table rather than one case at a time, because "must not produce
 *     `NaN:NaN`" is a statement about the whole input space.
 *  4. `NaN:NaN` / `Infinity:NaN` / `-1:-7` are the three strings the SOURCE
 *     produces (`molecules.tsx:92` and `feed/ReelCard.tsx:110` — which disagree
 *     with each other; see the module docstring). They are asserted as
 *     *forbidden outputs*, so a revert to the source cannot pass quietly.
 */

import { ZERO_TIME, formatTime } from '../formatTime';

/** Every string the two source copies can produce that this one must not. */
const FORBIDDEN_SUBSTRINGS = ['NaN', 'Infinity', '-'];

describe('formatTime', () => {
  describe('the required cases', () => {
    it.each([
      [0, '0:00'],
      [59, '0:59'],
      [60, '1:00'],
      [61, '1:01'],
      [3599, '59:59'],
      // The chosen hour rule: unbounded minutes, so 60 minutes is "60:00" and
      // there is no `h:mm:ss` form. See the module docstring, item 1.
      [3600, '60:00'],
    ])('formats %p as %p', (seconds, expected) => {
      expect(formatTime(seconds)).toBe(expected);
    });
  });

  describe('past the hour — one rule, not two', () => {
    it('keeps counting minutes rather than starting an hours field', () => {
      expect(formatTime(3600)).toBe('60:00');
      expect(formatTime(3661)).toBe('61:01');
      expect(formatTime(36000)).toBe('600:00');
    });

    it('never produces a three-field timecode', () => {
      // A re-introduced `h:mm:ss` branch would pass every case above, because
      // the smallest one of them is still two fields. This is the assertion that
      // separates "60:00" from "1:00:00" as a POLICY rather than by accident.
      for (const seconds of [0, 59, 60, 3599, 3600, 3601, 3661, 36000, 86400]) {
        const parts = formatTime(seconds).split(':');
        expect(parts).toHaveLength(2);
      }
      expect(formatTime(3600).split(':')[0]).toBe('60');
    });

    it('IS the rule both consumers render, so the reel cannot show two times', () => {
      // This replaced a parity test against `SeekProgressBar.formatClock` — a
      // second copy of this exact rule, declared inside the component. Two copies
      // WERE the defect, so pinning them to each other would have been pinning the
      // duplication in place and calling it coverage: it compared the
      // implementation against a hand-written transcription of itself, and would
      // have kept passing if `formatClock` were the one that changed.
      //
      // What is asserted instead is the DOCUMENTED rule, as literals, at the
      // inputs where each of its four decisions is decided:
      //   - 9  / 59   -> two-digit seconds (`padStart`, not the source's
      //                  `secs < 10 ? "0" : ""`)
      //   - 59.9       -> floor, not round (`round` would say "1:00")
      //   - 3600       -> unbounded minutes (`h:mm:ss` would say "1:00:00")
      //   - 9.5        -> no fractional field leaking out of `secs % 60`
      //   - NaN / -7   -> `0:00`, the "no position is known" rendering
      const DOCUMENTED: Array<[number, string]> = [
        [0, '0:00'],
        [9, '0:09'],
        [9.5, '0:09'],
        [59, '0:59'],
        [59.9, '0:59'],
        [60, '1:00'],
        [61, '1:01'],
        [599, '9:59'],
        [600, '10:00'],
        [3599, '59:59'],
        [3600, '60:00'],
        [3661, '61:01'],
        [Number.NaN, '0:00'],
        [-7, '0:00'],
      ];

      for (const [seconds, expected] of DOCUMENTED) {
        expect({ seconds, got: formatTime(seconds) }).toEqual({ seconds, got: expected });
      }
    });

    it('never emits a fractional second — there is no `m:ss.t` form at all', () => {
      // This is the decision the deleted `formatClock` docstring got wrong. It
      // claimed "`m:ss`, or `m:ss.t` under a minute" while its body had no
      // fractional branch and never could produce one — a comment describing
      // behaviour the code did not have. The code was right and the comment was
      // fixed; the property is pinned here so it cannot be "restored" by someone
      // reading that comment and believing it.
      //
      // Why it must stay integral is in `formatTime`'s docstring: both consumers
      // sit on a 500 ms clock (so a tenths digit would change twice a second, in
      // a `tabular-nums` slot chosen to prevent exactly that) and one of them is
      // SPOKEN VERBATIM by VoiceOver, where a running tenths digit is noise that
      // contradicts the floor decision.
      for (let i = 0; i <= 600; i += 1) {
        for (const fraction of [0, 0.1, 0.25, 0.5, 0.9, 0.999]) {
          const out = formatTime(i + fraction);
          expect(out).toMatch(/^\d+:[0-5]\d$/);
          expect(out.split(':')).toHaveLength(2);
          expect(out).not.toContain('.');
        }
      }
    });
  });

  describe('floats — the status ticks at 500 ms, so currentTime is never an integer', () => {
    it('floors, so the timecode can lag the audio but never lead it', () => {
      // FLOOR chosen over round. At 59.9 the audio is a tenth of a second from
      // the next minute; `round` would say "1:00" while `currentTime` is still
      // inside minute 0, which is a lie about what the user is hearing. Floor's
      // worst case is being up to 1 s behind, which is invisible.
      expect(formatTime(59.4)).toBe('0:59');
      expect(formatTime(59.9)).toBe('0:59');
      // `round` would produce "1:00" for BOTH of the values below. That is the
      // mutation these two lines exist to catch.
      expect(formatTime(60.4)).toBe('1:00');
      expect(formatTime(60.9)).toBe('1:00');
    });

    it('renders anything under a second as the start of the clip', () => {
      expect(formatTime(0.1)).toBe('0:00');
      expect(formatTime(0.999)).toBe('0:00');
    });

    it('does not bleed a decimal into the seconds field', () => {
      // The source's own arithmetic, `Math.floor(s % 60)`, is what keeps the
      // output integral. A `%` without a `Math.floor` would emit "0:9.5".
      expect(formatTime(9.5)).toBe('0:09');
      expect(formatTime(69.75)).toBe('1:09');
    });

    it('handles the exact 500 ms tick boundary', () => {
      // `updateInterval: 500` (store/player.ts::getPlayer), so this is the
      // smallest step the store can actually produce.
      expect(formatTime(0.5)).toBe('0:00');
      expect(formatTime(1.5)).toBe('0:01');
      expect(formatTime(2.5)).toBe('0:02');
    });
  });

  describe('non-finite — reachable from the native status, and never printable', () => {
    // `NativeStatusSnapshot` is a structural type, so `undefined` is a value the
    // store can hand over; the source's `!s || isNaN(s)` reaches it through
    // truthiness and its global `isNaN(undefined) === true` is a coincidence
    // rather than a guard. `Number.isFinite` has no coercion mode at all.
    const UNUSABLE: Array<[string, number]> = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['undefined', undefined as unknown as number],
      ['null', null as unknown as number],
    ];

    it.each(UNUSABLE)('renders %p as 0:00', (_label, input) => {
      expect(formatTime(input)).toBe(ZERO_TIME);
    });

    it('never emits the source\'s "NaN:NaN" or "Infinity:NaN"', () => {
      // Both source copies produce `Infinity:NaN`, and the OLDER one
      // (`feed/ReelCard.tsx:110`) produces `NaN:NaN` too, because it has no
      // `isNaN` guard at all. Those are the exact strings the brief forbids on
      // screen, and `molecules.tsx:95` is one of them.
      for (const [, input] of UNUSABLE) {
        const out = formatTime(input);
        expect(out).not.toContain('NaN');
        expect(out).not.toContain('Infinity');
        expect(out).toBe('0:00');
      }
    });

    it('is total: every input in a wide sweep yields a well-formed m:ss', () => {
      // The property, rather than the cases: a string that matches /^\d+:[0-5]\d$/
      // for EVERY input cannot be wrong on screen, whatever the input is.
      const sweep: number[] = [];
      for (let i = -50; i <= 50; i += 0.5) sweep.push(i);
      sweep.push(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
      sweep.push(1e21, -1e21, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
      sweep.push(0.1, 3599.999, 86399.999, 123456.789);

      for (const input of sweep) {
        const out = formatTime(input);
        expect(out).toMatch(/^\d+:[0-5]\d$/);
      }
    });
  });

  describe('negative — the store can let one through', () => {
    it('renders 0:00, because a position cannot be before the start', () => {
      expect(formatTime(-1)).toBe('0:00');
      expect(formatTime(-7)).toBe('0:00');
    });

    it('does not produce the source\'s "-1:-7" or "-1:0-7"', () => {
      // The two copies DISAGREE here, which is how the duplicate was found:
      //   molecules.tsx       -> "-1:-7"   (`padStart(2,'0')` on "-7" is a no-op)
      //   feed/ReelCard.tsx   -> "-1:0-7"  (`secs < 10` prefixes a "0")
      // Both are garbage on a screen, and they are not even the same garbage.
      expect(formatTime(-7)).not.toBe('-1:-7');
      expect(formatTime(-7)).not.toBe('-1:0-7');
      expect(formatTime(-7)).toBe('0:00');
    });

    it('normalises negative zero to 0:00 rather than "-0:00"', () => {
      // `-0 < 0` is FALSE, so this deliberately falls THROUGH the negative guard
      // and reaches the arithmetic: `Math.floor(-0)` is `-0`, `String(-0)` is
      // "0", and `padStart(2, '0')` makes it "00". The answer is right, but by
      // way of `${-0}` being "0" rather than by way of a decision — which is
      // exactly the sort of case that stops being right when the arithmetic is
      // touched, so it is pinned rather than assumed.
      expect(formatTime(-0)).toBe(ZERO_TIME);
      expect(formatTime(-0)).not.toContain('-');
      expect(String(-0)).toBe('0'); // the load-bearing coincidence, stated
    });

    it('treats a large negative the same way', () => {
      expect(formatTime(-86400)).toBe('0:00');
      expect(formatTime(-1e21)).toBe('0:00');
    });
  });

  describe('practical values the reel will actually show', () => {
    it('covers the whole free-tier clip length range', () => {
      // `REVENUECAT_CLIP_DURATION_LIMIT_FREE = 60` s, Pro = 300 s
      // (REVENUECAT_CLIP_DURATION_LIMIT_FREE / the 300 s MAX_DURATION_SECONDS).
      // Every whole second of a 60 s clip must read as one of two minutes.
      for (let s = 0; s <= 60; s += 1) {
        const out = formatTime(s);
        const expectedMinute = s < 60 ? '0' : '1';
        expect(out.split(':')[0]).toBe(expectedMinute);
        expect(out.split(':')[1]).toBe(String(s % 60).padStart(2, '0'));
      }
    });

    it('zero-pads the seconds field below ten', () => {
      expect(formatTime(9)).toBe('0:09');
      expect(formatTime(10)).toBe('0:10');
      // A non-padded "0:9" is what the old tree's `secs < 10 ? "0" : ""` was
      // guarding against, and it is the only reason to pad at all.
      expect(formatTime(9)).not.toBe('0:9');
    });
  });

  describe('the constant', () => {
    it('is the string the function returns, so callers can share one spelling', () => {
      // `ZERO_TIME` exists so a caller rendering an empty/known-nothing state
      // and the function's own fallback cannot drift apart.
      expect(ZERO_TIME).toBe('0:00');
      expect(formatTime(0)).toBe(ZERO_TIME);
      expect(formatTime(Number.NaN)).toBe(ZERO_TIME);
    });
  });
});
