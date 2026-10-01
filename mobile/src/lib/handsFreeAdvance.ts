import { pacing } from '../design/tokens';
import { clampIndex } from './feedViewport';
import type { PlaybackState } from '../store/player';
import type { TokenStatus } from './playbackTokenCache';

/**
 * Hands-free auto-advance and the buffering-timeout re-mint, as pure logic.
 *
 * Both live in one file because they are the same shape of problem — "a latch,
 * a clock, and a rule about what a failure means" — and both are decisions
 * over time rather than over React. Neither needs a FlatList, a renderer or a
 * native module to exercise, which is the only reason either can be tested at
 * the boundary where the bugs actually live (see `03-handoff.md` §7b tasks 3k
 * and 3l, which are the two rows this file implements).
 *
 * ## TYPE-ONLY IMPORTS FROM `store/player` AND `playbackTokenCache`
 * Deliberately `import type`, and that is load-bearing rather than stylistic.
 * `store/player.ts:2` imports `expo-audio`, whose native module does not exist
 * under jest, so a VALUE import would kill this module's whole suite at require
 * time with
 * `TypeError: Cannot read properties of undefined (reading 'prototype')`
 * (`expo-audio/src/ExpoAudio.ts:30`) — before a single assertion runs, and with
 * no error pointing at this file. `interactionGuard.ts:116-128` records the same
 * trap reached the other way round, by importing a *runtime* value out of
 * `src/components/**`. The TS transform erases `import type`, so neither module
 * is loaded. The test file's own ability to run is the proof.
 *
 * `pacing` IS a value import and is safe: `design/tokens.ts:58` imports
 * `expo-linear-gradient` with `import type` as well, and
 * `interactionGuard.ts:1` already imports this exact binding.
 */

// ===========================================================================
// PART 1 — HANDS-FREE AUTO-ADVANCE
// ===========================================================================

/**
 * The pause between a reel finishing and the next one being scrolled to.
 *
 * Read from the token rather than restated. `playbackDecision.ts:51` declares
 * its own `INTER_REEL_PAUSE_MS = 1000` with the comment "per plan §13" — the
 * same number, but a hardcoded one, so the two can drift silently. The test
 * file asserts all three agree (`pacing.interReelPause`, this, and
 * `playbackDecision`'s), which is the only cheap way to keep a transcription
 * honest.
 */
export const INTER_REEL_PAUSE_MS = pacing.interReelPause;

/**
 * The clip an auto-advance has already fired for, or `null`.
 *
 * **A clip id, not a boolean**, for the reason `store/player.ts:227-236` gives
 * for `endedForClipId`: a boolean needs a separate "someone reset it" path, and
 * nothing would remember to call it. Scoping the latch to an id makes it clear
 * itself when the clip changes, with no reset call anywhere.
 */
export type AdvanceLatch = string | null;

/** The store facts the advance rule reads. Nothing else is consulted. */
export type AutoAdvanceInput = {
  /** Native player state. `store/player.ts:194-201`. */
  playback: PlaybackState;
  /** The `ended` LATCH. `store/player.ts:227-236`. */
  endedForClipId: string | null;
  /** The clip NATIVE has loaded, which lags the reel on screen. */
  playingClipId: string | null;
  /** Hands-free mode. Read by nobody else in the app today. */
  handsFree: boolean;
  /** The settled reel, or null before the list has settled on anything. */
  activeClipId: string | null;
  /** `activeClipId`'s index in `feed`, or `-1` when it is not there. */
  activeIndex: number;
  /** The buffer's clip ids, in order. The list is the `FlatList`'s `data`. */
  feed: readonly string[];
  /** The once-only latch. See `AdvanceLatch`. */
  advancedFromClipId: AdvanceLatch;
};

/**
 * Every way the advance can be refused, as data rather than as prose.
 *
 * Exported so a test can iterate the SET instead of trusting that the
 * hand-written cases happen to cover it — the arrangement
 * `ClipTransport.tsx:131-143` uses for `TERMINAL_CARD_STATUSES` /
 * `SERVED_CARD_STATUSES`, and for the same reason: a new reason that no test
 * names is a new reason nothing exercises.
 */
export const AUTO_ADVANCE_HOLD_REASONS = [
  /** Hands-free is off: the reel stops on its last frame. */
  'hands-free-off',
  /** The list has not settled on a reel yet. */
  'no-active-clip',
  /** The settled reel is not in the buffer — evicted by the 60-cap. */
  'active-clip-evicted',
  /** The buffer is empty, so there is nothing to advance to. */
  'feed-empty',
  /** The settled reel is the LAST one. See `nextReelIndex`. */
  'last-reel',
  /** `feed[toIndex]` is absent. Only reachable if the buffer shrank mid-read. */
  'target-missing',
  /** Nothing is loaded, so nothing has finished. */
  'nothing-loaded',
  /** The player is not in `ended`. */
  'not-ended',
  /** `didJustFinish` has not been consumed for any clip. */
  'latch-unarmed',
  /** The latch belongs to a different clip than the one loaded. */
  'latch-for-other-clip',
  /** The finished clip is not the reel on screen. */
  'player-behind-screen',
  /** This clip has already been auto-advanced away from. */
  'already-advanced',
] as const;

export type AdvanceHoldReason = (typeof AUTO_ADVANCE_HOLD_REASONS)[number];

export type AutoAdvanceDecision =
  | {
      kind: 'advance';
      /** The clip that finished — the telemetry agent's `fromClipId`. */
      fromClipId: string;
      /** The reel to land on — `toClipId`. */
      toClipId: string;
      /** The index to `scrollToIndex`. */
      toIndex: number;
      /** `INTER_REEL_PAUSE_MS`. The caller owns the timer. */
      waitMs: number;
      /** The latch the caller must store when the timer FIRES. */
      latch: AdvanceLatch;
    }
  | { kind: 'hold'; reason: AdvanceHoldReason; latch: AdvanceLatch };

/**
 * The index one reel past `activeIndex`, or `null` when there is none.
 *
 * ## `clampIndex` does NOT return null past the end — it clamps
 * `feedViewport.ts:60-65` returns `min(max(0, index), length - 1)`, so
 * `clampIndex(99, 2)` is `1`, not `null`; its only `null` is `length <= 0`.
 * (`index.test.tsx:272` pins exactly that: `expect(clampIndex(99, 2)).toBe(1)`.)
 * So it cannot be used to ask "is there a next reel?" — asking it that way and
 * reading the `null` would answer "there is a next reel" on the LAST reel, and
 * hands-free would scroll the user onto the reel they are already watching,
 * re-triggering a load and a mint for the same clip. The arithmetic is
 * therefore done here, and `clampIndex` is applied afterwards to produce the
 * value the list is scrolled to, which keeps the screen's own
 * `onScrollToIndexFailed` recovery and this function using the same clamp.
 */
export function nextReelIndex(activeIndex: number, feedLength: number): number | null {
  if (feedLength <= 0) return null;
  if (!Number.isFinite(activeIndex) || activeIndex < 0) return null;
  const next = activeIndex + 1;
  if (next >= feedLength) return null;
  return clampIndex(next, feedLength);
}

/**
 * Should the feed scroll to the next reel, after `INTER_REEL_PAUSE_MS`?
 *
 * ## WHY NOT `progress >= 0.99`
 * The plan's row (`03-handoff.md` §7b task 3k) and `ClipTransport.tsx:315-321`
 * both spell this rule as `progress >= 0.99`, and it is reachable three ways
 * that are not completion:
 *
 *  1. **A seek to the end.** `SeekProgressBar` commits through
 *     `clampSeekTime(requested, duration)` (`SeekProgressBar.tsx:238,430`),
 *     which clamps UP TO `duration` — so tapping the far right of the scrubber
 *     seeks to exactly the duration and the platform fires its end
 *     notification. A user reaching for the last moment of the clip is thrown
 *     to the next reel.
 *  2. **Buffering at the end.** `currentTime` freezes at the stall position
 *     while `duration` stays known, so the ratio sits high for as long as the
 *     stall lasts.
 *  3. **A very short clip.** 0.99 × 3 s is 2.97 s, which is inside one 500 ms
 *     status tick of the end — so on a 3 s clip the threshold *is* `ended` with
 *     the same three failure modes attached and none of them distinguishable.
 *
 * `playback === 'paused' && endedForClipId !== null` is no better, and worse: the
 * latch holds for as long as the clip is loaded, so that conjunct is
 * stable-TRUE for the entire time the clip is on the player — about 12 ticks on
 * a 6 s clip — and every one of them would fire the advance.
 *
 * So the predicate is the latch itself, which is the only signal here that is
 * both once-per-clip and free of seek and pause false positives.
 *
 * ## THE SEEK-TO-THE-END FALSE POSITIVE — ACCEPTED, DELIBERATELY
 * The platform cannot tell a seek to the end from a clip that ran to the end:
 * both arm `endedForClipId` through the same one-tick `didJustFinish` pulse, and
 * `store/player.ts` records no user action of any kind. The brief for this
 * module offered a choice, and option (a) — accept it — is taken, for four
 * reasons:
 *
 *  1. **The only available discriminator is provably unreliable.** Detecting the
 *     seek means watching `currentTime` jump. `currentTime` is sampled at 2 Hz
 *     (`updateInterval: 500`, `store/player.ts:51`) and iOS's periodic time
 *     observer **drops callbacks under load** — `interactionGuard.ts:171`
 *     already sets `MAX_TICK_CREDIT_MS = 1000` precisely because a single tick
 *     can be a second or more late, and names "a long GC pause" and "device
 *     sleep" as causes. A clip that plays 0 → 1.0 s and whose next observation
 *     lands at 2.5 s produces the SAME discontinuity a 0 → 2.5 s seek does. Any
 *     threshold high enough to catch a deliberate drag also swallows genuine
 *     completions that happened to end on a late tick.
 *  2. **The failure costs are not symmetric.** A false advance costs one reel
 *     of content: visible, reversible, and the same thing hands-free already
 *     does. A false suppression freezes the feed on a last frame with hands-free
 *     ON, which is indistinguishable from a broken player and has no recovery
 *     but toggling hands-free.
 *  3. **It cannot corrupt the recommender.** The advance reports
 *     `userInitiated: false`, so `interactionGuard.shouldRegisterSkip` refuses
 *     with `not-user-initiated` before it looks at any number
 *     (`interactionGuard.ts:468`). The entire cost of the false positive is one
 *     reel.
 *  4. **A real fix already exists and is not ours to take.**
 *     `SeekProgressBar` reports EVERY committed seek through its
 *     `onSeekResult` prop (`SeekProgressBar.tsx:257-261,421-441`). Routing that
 *     to the screen would give an exact "the user seeked" signal and would
 *     retire this false positive outright. That file is owned by the
 *     telemetry/action-cluster work, so it is reported rather than edited.
 *
 * Check order, and why:
 *
 *  - `handsFree` first. It is the user's instruction and it makes every other
 *    question moot.
 *  - "is there a next reel" before "did this reel finish". A finished clip with
 *    nowhere to go must stop on its last frame, and that is the common case at
 *    the end of a 60-clip buffer.
 *  - `nothing-loaded` before `not-ended`, because `playback` is a NATIVE
 *    reading and is meaningless until something is loaded.
 *  - `latch-unarmed` and `latch-for-other-clip` before `player-behind-screen`:
 *    they are the specific statements about the latch, and
 *    `player-behind-screen` is the general one about identity.
 *  - `player-behind-screen` is what makes a second advance impossible during the
 *    gap between the scroll landing and `loadClip` replacing the source. The
 *    latch alone does not: for that window `endedForClipId` is still the OLD
 *    clip and still equal to `playingClipId`, so `playback` is still `'ended'`.
 *  - `already-advanced` last, as the belt to that braces.
 */
export function shouldAutoAdvance(input: AutoAdvanceInput): AutoAdvanceDecision {
  const hold = (reason: AdvanceHoldReason): AutoAdvanceDecision => ({
    kind: 'hold',
    reason,
    latch: input.advancedFromClipId,
  });

  if (!input.handsFree) return hold('hands-free-off');
  if (input.activeClipId === null) return hold('no-active-clip');
  if (input.feed.length === 0) return hold('feed-empty');
  if (input.activeIndex < 0) return hold('active-clip-evicted');

  const toIndex = nextReelIndex(input.activeIndex, input.feed.length);
  if (toIndex === null) return hold('last-reel');
  const toClipId = input.feed[toIndex];
  if (toClipId === undefined) return hold('target-missing');

  if (input.playingClipId === null) return hold('nothing-loaded');
  if (input.playback !== 'ended') return hold('not-ended');
  if (input.endedForClipId === null) return hold('latch-unarmed');
  if (input.endedForClipId !== input.playingClipId) return hold('latch-for-other-clip');
  if (input.playingClipId !== input.activeClipId) return hold('player-behind-screen');
  if (input.advancedFromClipId === input.playingClipId) return hold('already-advanced');

  return {
    kind: 'advance',
    fromClipId: input.playingClipId,
    toClipId,
    toIndex,
    waitMs: INTER_REEL_PAUSE_MS,
    latch: input.playingClipId,
  };
}

/**
 * What `useWatchTelemetry` needs to know about a transition it did not cause.
 *
 * ## `userInitiated: false` IS THE LOAD-BEARING FIELD
 * `interactionGuard.shouldRegisterSkip` checks `userInitiated` FIRST and out of
 * everything else, and refuses with `not-user-initiated` when it is false
 * (`interactionGuard.ts:468`) — that check is what stops every natural
 * completion in a session from being counted as an abandonment, which was the
 * old app's defect 2 (`docs/mobile/04-interaction-contract.md` §1.1). So the
 * screen reports this transition and reports NO skip, and nothing the telemetry
 * side does with `userInitiated: false` can produce one.
 *
 * ## THE INTENDED CONSUMER, AND WHY IT IGNORES TWO OF THE THREE FIELDS
 * `useTelemetrySkip()` exposes `reportAutoAdvance(): void`
 * (`hooks/useWatchTelemetry.ts:150,180-182`) and reads the outgoing clip and its
 * position out of the store at CALL time rather than from a payload — which is
 * correct, because the caller's own idea of "the current clip" is exactly the
 * value that is stale during a swipe. So the one-line wiring is
 *
 *     <Screen onAdvance={() => reportAutoAdvance()} />
 *
 * and `fromClipId` / `toClipId` are carried for a consumer that wants to know
 * WHICH transition it was, not merely that one happened. `reportAutoAdvance` is
 * called synchronously from the advance timer, before `scrollToIndex`, which is
 * the ordering that hook's own docstring requires: at that instant the store
 * still names the outgoing clip with its real position, and after
 * `loadClip` it is zeroed.
 *
 * A USER swipe is deliberately not reported through here: it arrives through the
 * `onMomentumScrollEnd` / `onViewableItemsChanged` the screen already owns, and
 * a second channel for the same transition would be two places to forget.
 */
export type AdvanceInfo = {
  fromClipId: string;
  toClipId: string;
  /** Always `false` for an auto-advance. See above. */
  userInitiated: boolean;
};

/** The seam the feed screen exposes. See `AdvanceInfo`. */
export type AdvanceReporter = (info: AdvanceInfo) => void;

// ===========================================================================
// PART 2 — THE BUFFERING TIMEOUT
// ===========================================================================

/**
 * How long a clip may sit in `buffering` before the token is re-minted and the
 * load retried — once.
 *
 * ## The failure this exists for
 * An expired or rejected HLS token almost never produces an error. When a
 * segment 403s, iOS **stalls** rather than failing the item, so the card shows a
 * spinner for ever with `error: null` (`03-handoff.md` §4, "An expired token
 * will most likely present as an infinite stall, not an error"; the same note
 * records that `error: nil` is hardcoded in `currentStatus()` on ALL platforms,
 * `ios/AudioPlayer.swift:153`, `AudioPlayer.kt:218`). Nothing in the app timed
 * this out, so the user got a permanent spinner and no explanation.
 *
 * ## Why 12 000 and not something shorter
 * The HLS output is 4-second segments — `backend/app/tasks.py:431` passes
 * `-hls_time 4` — so a healthy clip needs a manifest, a variant playlist and
 * then 4 s of segment, each of which is a fresh round trip through the
 * validating edge (`workers/hls-token-worker`) and out to R2 or MinIO. On a
 * congested mobile network that whole chain is routinely 2-4 s.
 *
 * 12 s is therefore about **three consecutive segment fetches**. One slow fetch
 * is unremarkable and must not trigger a re-mint; three in a row, with
 * `currentTime` frozen, is a dead edge or a credential the edge will not accept.
 * It is also coarse against every other clock in the path — 24× the 500 ms
 * status tick, 12× `pacing.interReelPause` — so ordinary scheduling jitter
 * cannot make it fire early, and one re-mint costs at most one extra
 * `playback_token` request out of 300/min.
 *
 * Deliberately NOT derived from a formula: a value tied to the encoder's
 * segment duration would silently re-tune itself if `-hls_time` ever changed,
 * and a self-moving timeout is a timeout nobody chose.
 */
export const BUFFERING_STALL_TIMEOUT_MS = 12_000;

/**
 * The clip statuses for which a fresh token is the right response.
 *
 * Keyed on `classifyTokenError`'s own vocabulary
 * (`playbackTokenCache.ts:52-105`) rather than on HTTP codes re-derived here —
 * the brief for this module was explicit that a parallel classification would
 * be a second thing to keep in step, and it would be a second thing that could
 * disagree about what a 403 means.
 *
 * - `minting` / `ready`: the edge rejected a credential our clock still believes
 *   is good. `playbackTokenCache.ts:21-23` names `refresh()` as existing for
 *   exactly this: "the edge can reject a token our clock still believes is good,
 *   so eviction must not wait for expiry."
 * - `error`: a transport failure or a 429. Re-minting is bounded to one per clip
 *   by `BufferWatch.retried`, so this cannot become a throttle storm; the cost of
 *   not retrying is the permanent spinner this feature removes.
 */
export const REMINT_TOKEN_STATUSES = ['minting', 'ready', 'error'] as const satisfies readonly TokenStatus['status'][];

/**
 * The statuses for which a fresh token teaches nothing, and trying anyway is
 * actively harmful.
 *
 * - `unavailable` (403) — a RIGHTS decision: unmoderated or licence-restricted.
 *   Re-minting cannot change it, and the loop this feature is explicitly
 *   forbidden from building is exactly "a rights-restricted clip re-minting
 *   until the 300/min `playback_token` bucket is empty".
 * - `gone` (404) — the clip does not exist.
 * - `auth-required` (401) — the session is dead and `onSessionExpired` is already
 *   navigating to login.
 * - `processing` (409) — HLS is still being encoded, and the screen ALREADY has
 *   a `PROCESSING_RETRY_MS` refresh timer for it (`index.tsx:225`). A second
 *   timer here would double that request.
 */
export const NO_REMINT_TOKEN_STATUSES = [
  'unavailable',
  'gone',
  'auth-required',
  'processing',
] as const satisfies readonly TokenStatus['status'][];

/** Every way the re-mint can be refused. See `AUTO_ADVANCE_HOLD_REASONS`. */
export const BUFFER_HOLD_REASONS = [
  /** The player is not in `buffering`. */
  'not-buffering',
  /** Nothing is loaded. */
  'no-clip',
  /** `buffering` but no start time was recorded — a broken clock, not a stall. */
  'no-timer',
  /** The token state says a re-mint cannot help. See `NO_REMINT_TOKEN_STATUSES`. */
  'rights-decision',
  /** Under `BUFFERING_STALL_TIMEOUT_MS`. */
  'within-threshold',
  /** The one retry for this clip has been spent. */
  'already-retried',
  /** The token state does not describe this clip (the one-render lag). */
  'token-pending',
] as const;

export type BufferHoldReason = (typeof BUFFER_HOLD_REASONS)[number];

/**
 * Buffering bookkeeping for one clip. Immutable; `observeBuffer` is the only
 * transition, and it is pure so the arithmetic needs no fake timers.
 *
 * ## `retried` is per-clip and DIES WITH THE CLIP — it is not cleared by the
 * ## player leaving `buffering`
 * The brief for this module asked for the flag to be cleared on "a successful
 * load" as well as on a clip change, and the clip-change half is implemented
 * here. The other half is deliberately NOT, because the store cannot tell the
 * two apart: `playbackStateFrom` ranks `isBuffering` above `playing`
 * (`store/player.ts:277-278`), so within one stall `playback` is stably
 * `'buffering'` — but the instant it resolves it reports `'playing'` whether the
 * re-minted token worked OR whether the item recovered on its own and the retry
 * accomplished nothing. Clearing on `'playing'` therefore permits the exact loop
 * the brief forbids: stall → retry → brief `'playing'` → stall → retry → …
 *
 * A per-clip latch that only a clip change clears is **provably** loop-free:
 * `loadClip` sets `playingClipId` to the clip being loaded, and the same id
 * cannot re-enter without a user or auto action that also changes the id. The
 * upgrade path, if the owner wants a successful load to re-arm the budget, is a
 * `currentTime > 0` observation after the retry (`loadClip` zeroes it, so a
 * stalled retry can never satisfy it) — one extra selector on the screen.
 */
export type BufferWatch = {
  /** The clip this watch describes, or null before anything is loaded. */
  clipId: string | null;
  /** Caller clock at which `buffering` began. Null when not buffering. */
  bufferingSinceMs: number | null;
  /** The single re-mint for `clipId` has been issued. */
  retried: boolean;
};

export function initialBufferWatch(): BufferWatch {
  return { clipId: null, bufferingSinceMs: null, retried: false };
}

/**
 * Fold one observation into the watch.
 *
 *  1. **A foreign `clipId` is a reset, not an update** — new clip, new timer,
 *     `retried: false`. This is the "clear the flag when the clip changes" rule,
 *     and it is why `clipId` is on the state at all.
 *  2. **Not buffering stops the clock** but leaves `retried` alone. See the
 *     `BufferWatch` docstring for why that is not a bug.
 *  3. **Buffering with no baseline starts one at `nowMs`**, so a load that was
 *     already buffering when this screen first saw it is measured from here
 *     rather than being treated as an infinitely old stall.
 */
export function observeBuffer(
  watch: BufferWatch,
  observation: { clipId: string | null; buffering: boolean; nowMs: number },
): BufferWatch {
  if (observation.clipId !== watch.clipId) {
    return {
      clipId: observation.clipId,
      bufferingSinceMs: observation.buffering ? observation.nowMs : null,
      retried: false,
    };
  }

  if (!observation.buffering) {
    return watch.bufferingSinceMs === null ? watch : { ...watch, bufferingSinceMs: null };
  }

  if (watch.bufferingSinceMs === null) {
    return { ...watch, bufferingSinceMs: observation.nowMs };
  }

  return watch;
}

/** The facts a retry decision reads beyond the watch itself. */
export type BufferRetryInput = {
  /** Native player state. `store/player.ts:194-201`. */
  playback: PlaybackState;
  /** `classifyTokenError`'s status for THIS clip, or null when it is not ours. */
  tokenStatus: TokenStatus['status'] | null;
  /** Caller clock, in ms. Injected — this module never reads `Date.now()`. */
  nowMs: number;
  /** Overridable so a test can pin the arithmetic without fake timers. */
  timeoutMs?: number;
};

export type BufferRetryDecision =
  | { kind: 'remint'; clipId: string }
  | { kind: 'hold'; reason: BufferHoldReason };

/**
 * Has this buffered clip stalled long enough to be worth one re-mint?
 *
 * Order matters in two places:
 *
 *  - **`rights-decision` BEFORE the clock.** A 403 clip must never reach the
 *    timer arithmetic at all, so the strongest possible statement is that a
 *    terminal token state short-circuits regardless of how long it has stalled.
 *  - **`token-pending` last.** A `null` status means `usePlaybackToken` has not
 *    resolved THIS clip's token yet — the one-render lag
 *    (`playbackTokenCache.ts:37-48`) — and re-minting a token that belongs to
 *    the previous clip would be a different bug. It is a hold, not a throw.
 *
 * A clock that reads backwards (device reset, NTP correction) or non-finite is
 * reported as `within-threshold`, i.e. it does NOT retry. Erring toward not
 * retrying is the same direction `interactionGuard.ts:294-301` takes with the
 * tick cap: under-reporting is recoverable, over-reporting is not.
 */
export function decideBufferRetry(
  watch: BufferWatch,
  input: BufferRetryInput,
): BufferRetryDecision {
  if (input.playback !== 'buffering') return { kind: 'hold', reason: 'not-buffering' };
  if (watch.clipId === null) return { kind: 'hold', reason: 'no-clip' };
  if (watch.bufferingSinceMs === null) return { kind: 'hold', reason: 'no-timer' };

  if (input.tokenStatus !== null && !isRemintableStatus(input.tokenStatus)) {
    return { kind: 'hold', reason: 'rights-decision' };
  }
  if (input.tokenStatus === null) return { kind: 'hold', reason: 'token-pending' };

  const timeout = input.timeoutMs ?? BUFFERING_STALL_TIMEOUT_MS;
  const elapsed = input.nowMs - watch.bufferingSinceMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) return { kind: 'hold', reason: 'within-threshold' };
  if (elapsed < timeout) return { kind: 'hold', reason: 'within-threshold' };

  if (watch.retried) return { kind: 'hold', reason: 'already-retried' };

  return { kind: 'remint', clipId: watch.clipId };
}

/** Whether a token status is one a fresh token could plausibly fix. */
export function isRemintableStatus(status: TokenStatus['status']): boolean {
  return (REMINT_TOKEN_STATUSES as readonly TokenStatus['status'][]).includes(status);
}

/**
 * Milliseconds until this clip's stall crosses the threshold, or `0` if it has
 * already (or never will).
 *
 * ## Why the screen needs this, and why a timer at all
 * The screen's effect body only runs when one of its dependencies CHANGES, and
 * nothing about a stall changes: `playback` is stably `'buffering'` (the store
 * derives it from `isBuffering`, which outranks `playing` —
 * `store/player.ts:277-278`), and the 2 Hz `currentTime` tick is a field the
 * feed screen does not subscribe to. So an effect that merely re-decided on each
 * render would never re-decide at all, and the retry would never fire — the
 * exact permanent spinner this feature exists to remove.
 *
 * Hence a `setTimeout`, the same shape as the inter-reel pause. This function
 * supplies the *remaining* delay rather than the whole threshold, so a stall
 * that began before the current render still times out at its own deadline
 * instead of being pushed out by however long the effect took to get here.
 *
 * ## A clock that reads backwards or non-finitely returns the FULL threshold
 * Not 0. Returning 0 would mean "decide now", and `decideBufferRetry` refuses a
 * non-finite elapsed time as `within-threshold` — so the decision would hold, no
 * timer would be scheduled, and the retry would be lost for the rest of the
 * clip. Returning the full timeout treats a broken clock as "the stall began
 * just now": the retry is delayed rather than skipped, and it recovers on the
 * next reading. It can never turn a broken clock into an early re-mint, which is
 * the direction the errors have to go (`interactionGuard.ts:294-301`).
 */
export function bufferRetryDelayMs(
  watch: BufferWatch,
  nowMs: number,
  timeoutMs: number = BUFFERING_STALL_TIMEOUT_MS,
): number {
  if (watch.clipId === null) return 0;
  if (watch.bufferingSinceMs === null) return 0;
  if (watch.retried) return 0;
  const remaining = watch.bufferingSinceMs + timeoutMs - nowMs;
  if (!Number.isFinite(remaining)) return timeoutMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * Run the retry decision and hand back the watch to store.
 *
 * This is the entry point the feed screen (and any future store-level caller)
 * uses. It is a plain function over injected inputs — no hooks, no React, no
 * native module — so the whole policy is testable and the only side effect is
 * the `refresh()` it is handed.
 *
 * ## Why `refresh()` and not a hand-rolled evict-and-remint
 * `usePlaybackToken.refresh()` already does exactly this and only this:
 * `evictToken(clipId)` then a nonce bump that re-runs the hook's effect
 * (`usePlaybackToken.ts:75-81`). The nonce makes the hook's state change
 * identity, which re-runs the screen's existing load effect, whose
 * `decidePlaybackAction` then issues a fresh `loadClip` with the new token.
 * So one call covers all three steps — evict, re-mint, retry the load — and
 * re-implementing any of them here would put a second eviction path next to the
 * one the 409-processing timer already uses. **`usePlaybackToken.ts` was not
 * modified**: `refresh()` was already the right shape.
 *
 * ## Exactly-once, and why it is not merely "usually once"
 * `retried` is written into the returned watch here, in the same call that
 * calls `refresh()`, and the caller stores that watch. A second call with the
 * stored watch therefore sees `already-retried` and calls `refresh()` zero more
 * times. `refresh()` bumps a nonce unconditionally, so without this latch a
 * sustained stall would re-mint every time the token state changed — which is
 * every time the re-mint lands, i.e. a loop.
 */
export function retryStalledClip(deps: {
  /** The current watch. `initialBufferWatch()` before anything is loaded. */
  watch: BufferWatch;
  /** Native player state. */
  playback: PlaybackState;
  /** `classifyTokenError`'s status for this clip, or null when not resolved. */
  tokenStatus: TokenStatus['status'] | null;
  /** Caller clock, in ms. */
  nowMs: number;
  /** `usePlaybackToken`'s `refresh()`. */
  refresh: () => void;
  /** Overridable for tests. Defaults to `BUFFERING_STALL_TIMEOUT_MS`. */
  timeoutMs?: number;
}): { watch: BufferWatch; reminted: boolean; reason: BufferHoldReason | null } {
  const decision = decideBufferRetry(deps.watch, {
    playback: deps.playback,
    tokenStatus: deps.tokenStatus,
    nowMs: deps.nowMs,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });

  if (decision.kind === 'hold') {
    return { watch: deps.watch, reminted: false, reason: decision.reason };
  }

  // The flag is stored BEFORE the call, so a `refresh()` that synchronously
  // re-enters this function (it does not today — it is a `setState` — but the
  // ordering should not depend on that) cannot observe an un-retried watch.
  const watch: BufferWatch = { ...deps.watch, retried: true };
  deps.refresh();
  return { watch, reminted: true, reason: null };
}
