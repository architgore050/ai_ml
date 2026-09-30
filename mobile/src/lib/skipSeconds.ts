/**
 * The skip step, in seconds — the ONE place it is defined.
 *
 * ## Why this file exists at all
 * It used to be written down twice, `10`, in two component files:
 * `ClipTransport.tsx` as `SKIP_SECONDS` and `SeekProgressBar.tsx` as
 * `A11Y_STEP_SECONDS`. The numbers agreed only because nobody had edited them.
 * That is not a stylistic complaint — the two are the SAME gesture:
 *
 *  - `ClipTransport`'s Rewind / Advance buttons call `skipBy(±SKIP_SECONDS)`.
 *  - `SeekProgressBar`'s VoiceOver / TalkBack `increment` / `decrement` actions
 *    call `skipBy(±A11Y_STEP_SECONDS)`. They are literally the same store
 *    function with the same clamping (`store/player.ts` §`clampSeekTime`).
 *
 * So the screen-reader step and the button step cannot be allowed to disagree.
 * The failure mode is quiet and specific: a user swiping up on the bar would
 * hear "Forward 5 seconds" from the action label while the control they can
 * actually tap performs 10 — two spellings of one action on one screen, with
 * nothing in the test suite able to see it, because each file pinned only its
 * own copy.
 *
 * ## Why it is in `lib/` and not in either component
 * Neither component can own it: whichever one held it, the other would import a
 * number from a sibling's private vocabulary, and the dependency would point the
 * wrong way — the transport's label has no business depending on the scrubber's
 * internals. `lib/` is where `formatTime` lives for the same structural reason,
 * and it is inside `collectCoverageFrom` (`jest.config.js` excludes
 * `src/components/**` and `src/design/**`), so this file is measured rather than
 * being logic that only a render can reach.
 *
 * ## Why `SKIP_SECONDS` and not `A11Y_STEP_SECONDS`
 * The name follows the CONSUMERS, and there are two of them, only one of which is
 * the accessibility action. `A11Y_STEP_SECONDS` also read as though the step were
 * a property of the a11y implementation rather than of the app's skip gesture,
 * which is how a second copy got written in the first place. If a third gesture
 * ever joins them it takes this same number, and `SKIP_SECONDS` still names it.
 */

/**
 * The ±10 s skip step, in expo-audio SECONDS (`store/player.ts` §UNITS — never
 * milliseconds).
 *
 * 10 rather than 5 or 15 because it is the app's own skip granularity: the source
 * buttons are `<SkipForward size={16}/>` / `<SkipBack size={16}/>` on a 40 px
 * circle (`ReelCard.tsx:301,309` at `20451d3`) with no step stated anywhere, so
 * the figure is this app's choice rather than a transcribed one — and it is a
 * choice with a floor under it: 10 s is short enough to be a useful correction
 * inside a 60 s free-tier clip (`REVENUECAT_CLIP_DURATION_LIMIT_FREE = 60`, and
 * `SeekProgressBar`'s test fixture uses exactly that) and long enough that one
 * press is a deliberate act rather than a twitch.
 *
 * Always pass it SIGNED to `skipBy`, which is the store's one clamped relative
 * seek and returns `null` rather than seeking when there is nothing loaded. Do
 * not pass it to `seekToSeconds` and do not clamp against it here: the bounds
 * live in `clampSeekTime` and nowhere else.
 */
export const SKIP_SECONDS = 10;
