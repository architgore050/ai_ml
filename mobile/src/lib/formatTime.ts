/**
 * The reel's timecode.
 *
 * ## Why this is in `lib/` and not in a component
 * `jest.config.js` excludes `src/components/**` from `collectCoverageFrom` —
 * "the tokens are the contract, not the rendered output, so coverage is measured
 * on logic only" (`WaveformBars.test.tsx` docstring is the same argument). A
 * formatter written inside a component is therefore logic with no measurement:
 * the only way to exercise it is to render, and a render test cannot tell a
 * wrong rule from a right one any more than it can tell a right rule from a
 * wrong one for every other edge case. So the rule is a pure function with no
 * React and no renderer, and `lib/__tests__/formatTime.test.ts` calls it
 * directly.
 *
 * ## Provenance — and the two copies do NOT agree
 * `git show 20451d3:frontend/sample_frontend2/src/components/common/molecules.tsx`
 * lines 92-97 is the export this is a port of:
 *
 *     export function formatTime(s: number): string {
 *       if (!s || isNaN(s)) return '0:00';
 *       const m = Math.floor(s / 60);
 *       const sec = Math.floor(s % 60);
 *       return `${m}:${sec.toString().padStart(2, '0')}`;
 *     }
 *
 * The second copy the brief points at is NOT in that file. `sample_frontend2`'s
 * `ReelCard.tsx` contains no `formatTime` at all at 20451d3 — it reaches the
 * molecules one indirectly, through `WaveformBar.tsx:4` (`import { formatTime }
 * from '../common/molecules'`), which renders `{formatTime(duration * progress)} /
 * {formatTime(duration)}` (`WaveformBar.tsx:59`). The real duplicate lives in
 * the OLDER tree, `frontend/src/components/feed/ReelCard.tsx:110`, as a
 * component-local closure:
 *
 *     const formatTime = (sec: number) => {
 *       const mins = Math.floor(sec / 60);
 *       const secs = Math.floor(sec % 60);
 *       return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
 *     };
 *
 * The two **agree on every finite, non-negative input** — `secs < 10 ? '0' : ''`
 * is `padStart(2, '0')` for the only range `secs` can take, 0..59 — and
 * **disagree on every input that matters to a player**. Verified by executing
 * both:
 *
 *   | input  | molecules            | feed/ReelCard        |
 *   |--------|----------------------|----------------------|
 *   |  -7    | `"-1:-7"`            | `"-1:0-7"`           |
 *   |  NaN   | `"0:00"`             | `"NaN:NaN"`          |
 *   |  Infinity | `"Infinity:NaN"`   | `"Infinity:NaN"`     |
 *
 * The `Infinity` row is the one both get wrong identically, and it is the reason
 * this file is not a transcription. Every decision below is a decision the
 * source made by accident.
 *
 * ## UNITS: SECONDS
 * `usePlayerStore.currentTime` / `.duration` are expo-audio SECONDS and the
 * store is the single conversion choke point (`store/player.ts` §UNITS). Nothing
 * here converts, because a formatter that divided by 1000 would have to be
 * un-divided at every call site.
 */

/**
 * What every unusable input renders as.
 *
 * Named because it is the answer for three different failures that must not be
 * distinguishable on screen: nothing has played yet, the source reported a
 * non-finite time, and the position is negative. All three mean "no position is
 * known", and the honest rendering of that is the start of the clip.
 */
export const ZERO_TIME = '0:00';

/**
 * `m:ss` for any number of minutes, up to and past an hour.
 *
 * ## Hour format: `m:ss` unbounded, so `3600` renders `"60:00"`
 * The alternative is `h:mm:ss`, so `3600` would render `"1:00:00"`. Rejected,
 * for three reasons in the order that they actually bind:
 *
 *  1. **It would be a second, disagreeing timecode on the same screen.**
 *     `SeekProgressBar` speaks the position to VoiceOver as
 *     `accessibilityValue.text` (`${formatTime(now)} of ${formatTime(max)}`) and
 *     `ClipTransport` renders the visible timecode from this same function, so
 *     unbounded `m:ss` is already the one spelling on the reel. A `h:mm:ss`
 *     branch here would put two different renderings of the same position on
 *     screen at once — one visible, one spoken — and the spoken one would be the
 *     wrong one. Consistency with the *existing* implementation beats elegance.
 *  2. **It is the source's rule.** `Math.floor(s / 60)` has no hour division in
 *     either copy. This is a port, and a port that quietly re-spells its own
 *     output is a redesign wearing a port's commit message.
 *  3. **It buys nothing reachable.** The backend caps a clip at 60 s free /
 *     300 s Pro (`REVENUECAT_CLIP_DURATION_LIMIT_*`), so the hour branch is dead
 *     code that would only ever be reached by a test. It would also make the
 *     string one character wider at exactly one instant, inside a fixed-slot
 *     overlay, for a case that cannot occur.
 *
 * Minutes are therefore NOT wrapped at 60, and the function is total: it has no
 * hour branch to be wrong about.
 *
 * ## Rounding: FLOOR, never round
 * `currentTime` is a float — the store samples at `updateInterval: 500`
 * (`store/player.ts::getPlayer`), so 0.5 s steps — and the two candidates differ
 * by up to a second on screen:
 *
 *  - **Floor** can only ever UNDER-report. At `59.9` the audio is a tenth of a
 *    second from the next minute and the display says `0:59`. The worst case is
 *    that the timecode lags the audio by up to 1 s, which is invisible.
 *  - **Round** can report time that has not happened: at `59.5` it says `1:00`
 *    while `currentTime` is still inside minute 0. A timecode that runs ahead of
 *    the audio is a lie about the thing the user is listening to.
 *
 * Floor is also what both source copies do, so this costs nothing in fidelity.
 *
 * ## NEVER A FRACTIONAL SECOND — `m:ss`, always, and never `m:ss.t`
 * This is the one place the docstring used to lie. `SeekProgressBar` carried a
 * second copy of this rule as `formatClock`, documented as "`m:ss`, or `m:ss.t`
 * under a minute" — while its body, like this one, had no fractional branch and
 * no reachable fractional output. The CODE was right and the COMMENT was wrong,
 * so the comment is what changed: there is no `m:ss.t` form, and there never was.
 *
 * The code was right because a fractional form would be wrong here specifically,
 * not merely novel:
 *
 *  - **Both consumers are on a 500 ms clock** (`updateInterval`, `store/player.ts`
 *    §`getPlayer`), so `currentTime` is a float and a tenths digit would CHANGE
 *    TWICE A SECOND. The visible timecode is set in `fontVariant:
 *    ['tabular-nums']` precisely so its width cannot jitter; a fractional field
 *    would reintroduce the jitter at double the rate, in a fixed-slot overlay.
 *  - **One of the two consumers is SPOKEN VERBATIM.**
 *    `SeekProgressBar.accessibilityValue.text` and
 *    `ClipTransport`'s `accessibilityLabel` are both read out by VoiceOver and
 *    TalkBack. "zero point nine five seconds" read aloud every tick is noise, and
 *    it is the noisiest possible way to contradict the floor decision above.
 *  - **Neither source copy had one.** `molecules.tsx:92-97` and
 *    `feed/ReelCard.tsx:110` both emit two fields. A fractional form would be a
 *    redesign wearing a port's commit message — the same argument that rejects
 *    `h:mm:ss` a few lines up, applied to the seconds field.
 * The rule is pinned by `formatTime.test.ts` over a sweep, not just at the cases
 * where it is easy to be right.
 *
 * ## Non-finite and negative: `0:00`
 * `NaN` and `Infinity` are REACHABLE, not theoretical. The store coerces them
 * once, in `coerceNativeTimes` — and it has to, because `NaN` is an invalid
 * React Native style value and a poisoned completion rate is a recommender
 * input. But that coercion is a *store* guarantee about a *snapshot*, and a
 * formatter is a second consumer that would otherwise be the second place the
 * same bad number fails. The source shows what that looks like: `NaN` renders
 * `"NaN:NaN"` in the old tree, and `"Infinity:NaN"` in BOTH copies. Neither is
 * a string any screen reader has a good pronunciation for.
 *
 * So the rule is: **anything that is not a finite non-negative number is the
 * absence of a position, and renders `0:00`.** This deliberately does not
 * "propagate" the store's coercion — it re-derives the same answer independently
 * so that a caller bypassing the store, or a future change to the coercion, can
 * never turn this into garbage on screen.
 *
 * `Number.isFinite` is used rather than the source's `!s || isNaN(s)`: the
 * global `isNaN` coerces (`isNaN(undefined) === true`, `isNaN(null) === false`),
 * and the store's `NativeStatusSnapshot` is a structural type, so a missing
 * field is a `undefined` that would sail past a `isNaN` check that ran after a
 * truthiness test on a *string*. `Number.isFinite` has no coercion mode at all.
 *
 * Negative is rejected for the same reason `0:00` is the answer for it: a
 * timecode is a position, positions start at zero, and `"-1:-7"` is not a
 * position. The store can also let a negative through —
 * `coerceNativeTimes` only clamps into `[0, duration]` when `duration > 0`, and
 * passes `currentTime` through untouched when it is 0.
 *
 * @param seconds expo-audio SECONDS (`store/player.ts` §UNITS).
 * @returns `m:ss`, or `0:00` for any non-finite or negative input.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ZERO_TIME;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
