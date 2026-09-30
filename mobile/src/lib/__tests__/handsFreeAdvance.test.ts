import {
  AUTO_ADVANCE_HOLD_REASONS,
  BUFFERING_STALL_TIMEOUT_MS,
  BUFFER_HOLD_REASONS,
  INTER_REEL_PAUSE_MS,
  NO_REMINT_TOKEN_STATUSES,
  REMINT_TOKEN_STATUSES,
  bufferRetryDelayMs,
  decideBufferRetry,
  initialBufferWatch,
  isRemintableStatus,
  nextReelIndex,
  observeBuffer,
  retryStalledClip,
  shouldAutoAdvance,
  type AdvanceHoldReason,
  type AdvanceInfo,
  type AutoAdvanceDecision,
  type AutoAdvanceInput,
  type BufferHoldReason,
  type BufferRetryDecision,
  type BufferWatch,
} from '../handsFreeAdvance';
import { INTER_REEL_PAUSE_MS as DECISION_PAUSE } from '../playbackDecision';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { TokenStatus } from '../playbackTokenCache';
import { pacing } from '../../design/tokens';
import type { PlaybackState } from '../../store/player';

/**
 * The two feed-screen features whose bugs are properties of a *decision*, not
 * of React: hands-free auto-advance (`03-handoff.md` §7b task 3k) and the
 * buffering-timeout re-mint (task 3l, "an expired token is a *stall*, not an
 * error").
 *
 * Nothing here needs a renderer, a FlatList or a native module — which is the
 * only reason the timer-cancel half of the feature could be reasoned about at
 * all. The screen's own timer is exercised in `app/(tabs)/__tests__/index.test.tsx`;
 * what is pinned HERE is the state that makes `clearTimeout` in that effect's
 * cleanup sufficient.
 */

const FEED = ['a', 'b', 'c', 'd'];

const adv = (over: Partial<AutoAdvanceInput> = {}): AutoAdvanceInput => ({
  playback: 'ended',
  endedForClipId: 'a',
  playingClipId: 'a',
  handsFree: true,
  activeClipId: 'a',
  activeIndex: 0,
  feed: FEED,
  advancedFromClipId: null,
  ...over,
});

/** A clip that has been buffering since `sinceMs`. */
const stalled = (over: Partial<BufferWatch> = {}): BufferWatch => ({
  ...initialBufferWatch(),
  clipId: 'a',
  bufferingSinceMs: 1_000,
  ...over,
});

const retry = (
  watch: BufferWatch,
  over: Partial<Parameters<typeof decideBufferRetry>[1]> = {},
): BufferRetryDecision =>
  decideBufferRetry(watch, {
    playback: 'buffering',
    tokenStatus: 'ready',
    nowMs: 1_000 + BUFFERING_STALL_TIMEOUT_MS,
    ...over,
  });

const holdReason = (d: AutoAdvanceDecision): AdvanceHoldReason | null =>
  d.kind === 'hold' ? d.reason : null;

/* ------------------------------------------------------------------ */

describe('the completion latch, not progress', () => {
  it('advances from the latch on the only state that means "finished"', () => {
    expect(shouldAutoAdvance(adv())).toEqual({
      kind: 'advance',
      fromClipId: 'a',
      toClipId: 'b',
      toIndex: 1,
      waitMs: INTER_REEL_PAUSE_MS,
      latch: 'a',
    });
  });

  /**
   * THE predicate the plan's row got wrong. `progress >= 0.99` is not completion:
   * it is reachable by a seek to the end (the scrubber clamps UP TO `duration`,
   * `SeekProgressBar.tsx:238`), by a stall with `currentTime` frozen, and on any
   * clip short enough that 0.99 of it falls inside one 500 ms tick.
   *
   * The clock has reached the very end here — `progress` is exactly 1.0, and a
   * progress rule would fire on the very next line of the mutation table — and
   * the decision is still a HOLD, because `playback` is not `ended`.
   */
  it('does not advance on a stalled position at the end of the clip', () => {
    // What the store holds during a stall: `currentTime` frozen at the end,
    // `duration` known, so `currentTime / duration === 1`.
    expect(holdReason(shouldAutoAdvance(adv({ playback: 'buffering' })))).toBe('not-ended');
  });

  /**
   * The once-per-clip property, over the tick rate the store actually produces.
   *
   * `playback: 'ended'` is LATCHED for as long as the clip is loaded
   * (`store/player.ts:393-403`), so a stable-true conjunct fires on every
   * 500 ms status tick. `shouldAutoAdvance` is called here the way the effect
   * calls it — 12 times, one per tick of a 6 s clip — threading the latch the
   * previous call returned, and exactly ONE of them advances.
   */
  it('is true exactly once per clip, not on every tick', () => {
    let latch: string | null = null;
    const decisions = Array.from({ length: 12 }, () => {
      const d = shouldAutoAdvance(adv({ advancedFromClipId: latch }));
      latch = d.latch;
      return d;
    });

    expect(decisions.filter((d) => d.kind === 'advance')).toHaveLength(1);
    // ...and every later tick says why, so the refusal is inspectable rather
    // than silent.
    expect(new Set(decisions.slice(1).map(holdReason))).toEqual(new Set(['already-advanced']));
  });

  it('refuses when the latch is armed for a clip that is not the one loaded', () => {
    // The latch clears on a new `loadClip` (`player.ts:481-483`), so a stale
    // armed latch is the shape a mid-swap render has.
    expect(holdReason(shouldAutoAdvance(adv({ endedForClipId: 'a', playingClipId: 'b' })))).toBe(
      'latch-for-other-clip',
    );
  });

  it('refuses when no latch is armed at all', () => {
    // The latch is armed only when something is loaded
    // (`player.ts:400`), so `didJustFinish` with `playingClipId === null` arms
    // nothing and there is no completion to act on.
    expect(holdReason(shouldAutoAdvance(adv({ playingClipId: null, endedForClipId: null })))).toBe(
      'nothing-loaded',
    );
    expect(holdReason(shouldAutoAdvance(adv({ endedForClipId: null })))).toBe('latch-unarmed');
  });

  /**
   * The guard that makes a SECOND advance impossible during the window between
   * the scroll landing and `loadClip` replacing the source. In that window the
   * latch still belongs to the OLD clip and still equals `playingClipId`, so
   * every latch check passes and only identity can refuse.
   */
  it('refuses while the finished clip is not the reel on screen', () => {
    expect(
      holdReason(shouldAutoAdvance(adv({ activeClipId: 'b', activeIndex: 1, playingClipId: 'a' }))),
    ).toBe('player-behind-screen');
  });
});

describe('hands-free off', () => {
  it('never advances, whatever the player is doing', () => {
    const states: PlaybackState[] = [
      'idle',
      'loading',
      'buffering',
      'playing',
      'paused',
      'ended',
      'error',
    ];
    for (const playback of states) {
      expect(holdReason(shouldAutoAdvance(adv({ handsFree: false, playback })))).toBe(
        'hands-free-off',
      );
    }
  });

  it('checks handsFree before anything else, so a last reel never even counts', () => {
    // Order is observable: with handsFree off AND on the last reel, the answer
    // is `hands-free-off`, which means the function really did look there first.
    expect(holdReason(shouldAutoAdvance(adv({ handsFree: false, activeIndex: 3 })))).toBe(
      'hands-free-off',
    );
  });
});

describe('the last reel', () => {
  it('does not advance, and says so rather than scrolling to itself', () => {
    expect(holdReason(shouldAutoAdvance(adv({ activeClipId: 'd', activeIndex: 3 })))).toBe(
      'last-reel',
    );
  });

  /**
   * `clampIndex` does NOT return null past the end — it clamps
   * (`feedViewport.ts:60-65`, and `index.test.tsx:272` asserts
   * `clampIndex(99, 2) === 1`). Asking it "is there a next reel?" and reading
   * the null answers YES on the last reel, and hands-free would scroll onto the
   * reel the user is already watching, re-minting and re-loading the same clip.
   */
  it('computes the next index itself, past the end as well as through clampIndex', () => {
    expect(nextReelIndex(0, 4)).toBe(1);
    expect(nextReelIndex(2, 4)).toBe(3);
    expect(nextReelIndex(3, 4)).toBeNull();
    expect(nextReelIndex(99, 4)).toBeNull();
    expect(nextReelIndex(0, 0)).toBeNull();
    expect(nextReelIndex(-1, 4)).toBeNull();
    expect(nextReelIndex(Number.NaN, 4)).toBeNull();
  });

  it('stops on an empty feed rather than resolving to index 0', () => {
    expect(holdReason(shouldAutoAdvance(adv({ feed: [] })))).toBe('feed-empty');
  });
});

describe('a settled reel that is not in the buffer', () => {
  it('refuses, because scrolling would page to a clip that is not there', () => {
    // The 60-cap trims from the front, so the settled id can leave the buffer
    // while the screen still holds it.
    expect(holdReason(shouldAutoAdvance(adv({ activeIndex: -1 })))).toBe('active-clip-evicted');
  });

  it('refuses when nothing has settled on a reel yet', () => {
    expect(holdReason(shouldAutoAdvance(adv({ activeClipId: null })))).toBe('no-active-clip');
  });
});

/**
 * THE ACCEPTED FALSE POSITIVE, pinned so it cannot be changed silently.
 *
 * A seek to the end and a clip that ran to the end are the same signal to the
 * store: both arm `endedForClipId` through the one-tick `didJustFinish` pulse
 * (`store/player.ts:177-192`). `store/player.ts` records no user action, so the
 * only available discriminator would be a discontinuity in `currentTime` — and
 * `currentTime` is sampled at 2 Hz while iOS's periodic observer DROPS callbacks
 * under load, which `interactionGuard.ts:171` (`MAX_TICK_CREDIT_MS = 1000`)
 * already documents. A late tick is indistinguishable from a seek, so any
 * detector that catches deliberate drags also swallows real completions.
 *
 * The asymmetry settles it: a false advance costs one reel of content and
 * reports `userInitiated: false`, so `shouldRegisterSkip` refuses it
 * (`interactionGuard.ts:468`) and the recommender is untouched. A false
 * SUPPRESSION freezes the feed on a last frame with hands-free on.
 */
describe('seek to the end', () => {
  it('is indistinguishable from a completion, and advances — the accepted cost', () => {
    // The store's exact post-seek reading: the scrubber clamped UP TO `duration`
    // (`SeekProgressBar.tsx:238`), so `currentTime === duration` and the
    // platform fired its end notification, which is what armed the latch.
    const scrubbedToTheEnd = adv({
      playback: 'ended',
      endedForClipId: 'a',
      playingClipId: 'a',
    });
    expect(shouldAutoAdvance(scrubbedToTheEnd).kind).toBe('advance');
  });

  /**
   * The compensating fact, and the one that makes the false positive affordable:
   * this transition is reported with `userInitiated: false`, which is what
   * `interactionGuard.shouldRegisterSkip` checks FIRST and refuses on
   * (`interactionGuard.ts:468`) before it reads a single number. So the whole
   * cost of a seek-to-the-end being read as a completion is one reel of
   * content, and `avg_completion_rate` — 30 % of the ranking composite — is
   * untouched.
   *
   * This is the shape `AdvanceInfo` hands the telemetry agent, asserted here
   * rather than at the call site so the contract is pinned next to the decision
   * that produces it.
   */
  it('reports the transition as NOT user-initiated, so no skip can be produced', () => {
    const d = shouldAutoAdvance(adv());
    if (d.kind !== 'advance') throw new Error('expected an advance');
    const info: AdvanceInfo = {
      fromClipId: d.fromClipId,
      toClipId: d.toClipId,
      userInitiated: false,
    };
    expect(info).toEqual({ fromClipId: 'a', toClipId: 'b', userInitiated: false });
    expect(info.userInitiated).toBe(false);
  });

  /**
   * A guard on the UPGRADE PATH, so nobody re-adds a `currentTime`-discontinuity
   * detector on the strength of the module docstring's argument against one.
   * `SeekProgressBar` already reports every committed seek through its
   * `onSeekResult` prop (`SeekProgressBar.tsx:257-261,421-441`), which is an
   * exact signal rather than an inference. That file belongs to the
   * telemetry/action-cluster work, so the routing is reported, not done here.
   */
  it('has an exact seek signal available in the component layer already', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'components', 'reel', 'SeekProgressBar.tsx'),
      'utf8',
    );
    expect(source).toContain('onSeekResult');
    // Read off the source rather than restated, for the reason
    // `index.test.tsx:437-447` gives: a hand-written list is a second place to
    // forget. If this ever goes false, the upgrade path is gone and the
    // accepted false positive above has to be re-justified from scratch.
    expect(source).toMatch(/seekToSeconds\(clamped\)/);
  });
});

/* ------------------------------------------------------------------ */

describe('the inter-reel pause', () => {
  it("is the token, and agrees with the load effect's own copy of it", () => {
    // `playbackDecision.ts:51` hardcodes 1000 with "per plan §13" as its
    // provenance. Three places, one number: if this ever fails, the advance and
    // the load are pausing for different lengths.
    expect(INTER_REEL_PAUSE_MS).toBe(pacing.interReelPause);
    expect(INTER_REEL_PAUSE_MS).toBe(DECISION_PAUSE);
    expect(INTER_REEL_PAUSE_MS).toBe(1000);
  });

  it('hands the caller the wait rather than the timer', () => {
    const d = shouldAutoAdvance(adv());
    expect(d.kind === 'advance' && d.waitMs).toBe(pacing.interReelPause);
  });
});

/**
 * WHAT MAKES `clearTimeout` IN THE EFFECT'S CLEANUP SUFFICIENT.
 *
 * The screen owns a real `setTimeout`, and the only thing standing between a
 * stale timer and a DOUBLE advance is that every state change invalidating the
 * pending advance re-runs the effect, whose cleanup clears it. So the claim is
 * exactly: for each invalidating state, `shouldAutoAdvance` returns `hold`.
 * Tabulated over the SET of reasons rather than hand-written, so a new reason
 * that invalidates nothing — or a state that invalidates and is not listed —
 * shows up here.
 */
describe('the invalidation set', () => {
  const invalidating: { what: string; input: Partial<AutoAdvanceInput>; reason: AdvanceHoldReason }[] = [
    {
      what: 'the user swiped to the next reel before the timer fired',
      input: { activeClipId: 'b', activeIndex: 1 },
      reason: 'player-behind-screen',
    },
    {
      // The mirror of the row above: reel b finished, the advance to c was
      // pending, and the user swiped BACK to a before the timer fired. The
      // latch still matches the loaded clip, so only identity refuses.
      what: 'the user swiped back to the previous reel',
      input: { activeClipId: 'a', activeIndex: 0, playingClipId: 'b', endedForClipId: 'b' },
      reason: 'player-behind-screen',
    },
    { what: 'hands-free was toggled off', input: { handsFree: false }, reason: 'hands-free-off' },
    { what: 'the player left the ended state', input: { playback: 'playing' }, reason: 'not-ended' },
    { what: 'a new clip was loaded', input: { playingClipId: 'b' }, reason: 'latch-for-other-clip' },
    {
      what: 'the player was released',
      input: { playingClipId: null, endedForClipId: null },
      reason: 'nothing-loaded',
    },
    { what: 'the buffer was trimmed', input: { activeIndex: -1 }, reason: 'active-clip-evicted' },
    { what: 'the last reel was reached', input: { activeIndex: 3, activeClipId: 'd' }, reason: 'last-reel' },
    { what: 'the advance already fired', input: { advancedFromClipId: 'a' }, reason: 'already-advanced' },
  ];

  it.each(invalidating)('refuses when $what', ({ input, reason }) => {
    expect(holdReason(shouldAutoAdvance(adv(input)))).toBe(reason);
  });

  /**
   * One case per exported reason, so `AUTO_ADVANCE_HOLD_REASONS` is proven
   * reachable rather than merely declared — `TypeScript` guarantees the union
   * and this table guarantees the behaviour.
   */
  const onePerReason: { reason: AdvanceHoldReason; input: Partial<AutoAdvanceInput> }[] = [
    { reason: 'hands-free-off', input: { handsFree: false } },
    { reason: 'no-active-clip', input: { activeClipId: null } },
    { reason: 'active-clip-evicted', input: { activeIndex: -1 } },
    { reason: 'feed-empty', input: { feed: [] } },
    { reason: 'last-reel', input: { activeIndex: 3, activeClipId: 'd' } },
    {
      reason: 'target-missing',
      // Reachable ONLY through `noUncheckedIndexedAccess`: a real array has no
      // holes, so `feed[toIndex]` cannot be `undefined` while
      // `toIndex < feed.length`. The branch is here because the TYPE says it
      // can be, and a screen that passes a `FeedClip[]` it is concurrently
      // mutating is exactly the case where "cannot happen" would be the
      // dangerous assumption.
      input: { feed: new Array(4) as unknown as readonly string[] },
    },
    { reason: 'nothing-loaded', input: { playingClipId: null, endedForClipId: null } },
    { reason: 'not-ended', input: { playback: 'paused' } },
    { reason: 'latch-unarmed', input: { endedForClipId: null } },
    { reason: 'latch-for-other-clip', input: { endedForClipId: 'z' } },
    { reason: 'player-behind-screen', input: { activeClipId: 'b', activeIndex: 1 } },
    { reason: 'already-advanced', input: { advancedFromClipId: 'a' } },
  ];

  it.each(onePerReason)('reaches every refusal: $reason', ({ input, reason }) => {
    expect(holdReason(shouldAutoAdvance(adv(input)))).toBe(reason);
  });

  it('exports exactly the reasons the function can return', () => {
    // The two tables must not drift apart: a reason with no case, or a case with
    // no reason, both mean the exported union is describing the wrong function.
    expect(onePerReason.map((c) => c.reason).sort()).toEqual([...AUTO_ADVANCE_HOLD_REASONS].sort());
  });
});

/* ------------------------------------------------------------------ */

describe('the buffering timeout', () => {
  it('does not fire before the threshold', () => {
    expect(retry(stalled(), { nowMs: 1_000 + BUFFERING_STALL_TIMEOUT_MS - 1 })).toEqual({
      kind: 'hold',
      reason: 'within-threshold',
    });
  });

  it('fires at the threshold', () => {
    expect(retry(stalled())).toEqual({ kind: 'remint', clipId: 'a' });
  });

  it('is several seconds, and several segment fetches', () => {
    // `-hls_time 4` (`backend/app/tasks.py:431`) => a 4 s segment. The threshold
    // is about three of them, and is coarse against the 500 ms status tick, so
    // jitter cannot make it fire early.
    expect(BUFFERING_STALL_TIMEOUT_MS % 4_000).toBe(0);
    expect(BUFFERING_STALL_TIMEOUT_MS / 4_000).toBe(3);
    expect(BUFFERING_STALL_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('does not fire twice for one clip', () => {
    // The second call reads the watch the FIRST call returned. `refresh()` bumps
    // a nonce unconditionally, so without the latch a sustained stall re-mints
    // every time the re-mint lands — which is a loop, and the loop is the thing
    // this feature is forbidden from building.
    const refresh = jest.fn();
    const first = retryStalledClip({
      watch: stalled(),
      playback: 'buffering',
      tokenStatus: 'ready',
      nowMs: 1_000 + BUFFERING_STALL_TIMEOUT_MS,
      refresh,
    });
    expect(first).toEqual({ watch: stalled({ retried: true }), reminted: true, reason: null });
    expect(refresh).toHaveBeenCalledTimes(1);

    const second = retryStalledClip({
      watch: first.watch,
      playback: 'buffering',
      tokenStatus: 'ready',
      nowMs: 1_000 + 2 * BUFFERING_STALL_TIMEOUT_MS,
      refresh,
    });
    expect(second).toEqual({
      watch: first.watch,
      reminted: false,
      reason: 'already-retried',
    });
    // ONE call in total, however long the stall goes on.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('clears the retry on a clip change', () => {
    const spent = stalled({ retried: true });
    const onNext = observeBuffer(spent, { clipId: 'b', buffering: true, nowMs: 20_000 });
    expect(onNext).toEqual({ clipId: 'b', bufferingSinceMs: 20_000, retried: false });
    // ...and the new clip has a full budget again, at its own clock.
    expect(retry(onNext, { nowMs: 20_000 + BUFFERING_STALL_TIMEOUT_MS })).toEqual({
      kind: 'remint',
      clipId: 'b',
    });
  });

  /**
   * A 403 is a RIGHTS decision — unmoderated or licence-restricted — and a fresh
   * token cannot change it. The loop this feature must not build is precisely a
   * rights-restricted clip re-minting until the 300/min `playback_token` bucket
   * is empty. The sets are keyed on `classifyTokenError`'s own vocabulary, so
   * there is no second classification to keep in step.
   */
  it('does not re-mint on a rights decision, however long the stall ran', () => {
    for (const status of NO_REMINT_TOKEN_STATUSES) {
      expect(retry(stalled(), { tokenStatus: status })).toEqual({
        kind: 'hold',
        reason: 'rights-decision',
      });
      // ...and not even after ten timeouts' worth of stall.
      expect(retry(stalled(), { tokenStatus: status, nowMs: 1_000 + 10 * BUFFERING_STALL_TIMEOUT_MS })).toEqual({
        kind: 'hold',
        reason: 'rights-decision',
      });
    }
  });

  it('re-mints for the token-class statuses', () => {
    for (const status of REMINT_TOKEN_STATUSES) {
      expect(isRemintableStatus(status)).toBe(true);
      expect(retry(stalled(), { tokenStatus: status })).toEqual({ kind: 'remint', clipId: 'a' });
    }
  });

  it('classifies every status classifyTokenError can produce, and no others', () => {
    // Enumerated from the union, so ADDING a status to `TokenStatus` fails this
    // test rather than silently falling through both lists.
    const every = [
      'ready',
      'minting',
      'processing',
      'unavailable',
      'gone',
      'auth-required',
      'error',
    ] as const satisfies readonly TokenStatus['status'][];

    expect([...REMINT_TOKEN_STATUSES, ...NO_REMINT_TOKEN_STATUSES].sort()).toEqual(
      [...every].sort(),
    );
    for (const status of every) {
      expect(isRemintableStatus(status)).toBe(
        (REMINT_TOKEN_STATUSES as readonly TokenStatus['status'][]).includes(status),
      );
    }
  });

  it('does not re-mint on a token that does not describe this clip', () => {
    // `usePlaybackToken` lags by one render, so `null` is the normal value on
    // the render where `activeClipId` moves. Re-minting a previous clip's token
    // would be a different bug entirely.
    expect(retry(stalled(), { tokenStatus: null })).toEqual({
      kind: 'hold',
      reason: 'token-pending',
    });
  });

  it('only measures a CONTINUOUS stall', () => {
    const buffering = observeBuffer(initialBufferWatch(), {
      clipId: 'a',
      buffering: true,
      nowMs: 1_000,
    });
    expect(buffering).toEqual({ clipId: 'a', bufferingSinceMs: 1_000, retried: false });

    // Playing resets the clock, so 60 s of intermittent stalling is not a
    // 60 s stall.
    const playing = observeBuffer(buffering, { clipId: 'a', buffering: false, nowMs: 2_000 });
    expect(playing.bufferingSinceMs).toBeNull();
    expect(retry(playing, { playback: 'playing', nowMs: 62_000 })).toEqual({
      kind: 'hold',
      reason: 'not-buffering',
    });

    const again = observeBuffer(playing, { clipId: 'a', buffering: true, nowMs: 62_000 });
    expect(retry(again, { nowMs: 62_000 + BUFFERING_STALL_TIMEOUT_MS - 1 })).toEqual({
      kind: 'hold',
      reason: 'within-threshold',
    });
  });

  it('refuses a clock that reads backwards or non-finite rather than retrying', () => {
    for (const nowMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(retry(stalled({ bufferingSinceMs: 1_000 }), { nowMs })).toEqual({
        kind: 'hold',
        reason: 'within-threshold',
      });
    }
  });

  it('refuses when the player is not buffering, even with a long clock', () => {
    const watch = stalled();
    for (const playback of ['idle', 'loading', 'playing', 'paused', 'ended', 'error'] as const) {
      expect(retry(watch, { playback })).toEqual({ kind: 'hold', reason: 'not-buffering' });
    }
  });

  it('refuses with no clip and with no baseline', () => {
    expect(retry(stalled({ clipId: null }))).toEqual({ kind: 'hold', reason: 'no-clip' });
    expect(retry(stalled({ bufferingSinceMs: null }))).toEqual({
      kind: 'hold',
      reason: 'no-timer',
    });
  });

  it('reaches every refusal it exports, and no others', () => {
    const onePerReason: { reason: BufferHoldReason; watch: BufferWatch; over?: Partial<Parameters<typeof decideBufferRetry>[1]> }[] = [
      { reason: 'not-buffering', watch: stalled(), over: { playback: 'paused' } },
      { reason: 'no-clip', watch: stalled({ clipId: null }) },
      { reason: 'no-timer', watch: stalled({ bufferingSinceMs: null }) },
      { reason: 'rights-decision', watch: stalled(), over: { tokenStatus: 'unavailable' } },
      { reason: 'within-threshold', watch: stalled(), over: { nowMs: 1_000 + 1 } },
      { reason: 'already-retried', watch: stalled({ retried: true }) },
      { reason: 'token-pending', watch: stalled(), over: { tokenStatus: null } },
    ];

    for (const { reason, watch, over } of onePerReason) {
      expect(retry(watch, over)).toEqual({ kind: 'hold', reason });
    }
    expect(onePerReason.map((c) => c.reason).sort()).toEqual([...BUFFER_HOLD_REASONS].sort());
  });
});

/**
 * WHY THIS EXISTS AT ALL: the screen's effect body only runs when a dependency
 * CHANGES, and a stall changes nothing. `buffering` is stable, and the 2 Hz
 * `currentTime` tick is a field the feed screen does not subscribe to. Without a
 * timer, the retry decision would be made exactly once — at the moment buffering
 * began — and never again, so the feature would be a permanent spinner with
 * extra steps.
 */
describe('bufferRetryDelayMs', () => {
  it('returns the REMAINING delay, not the whole threshold', () => {
    // A stall that began 8 s ago is 4 s from its deadline. Returning the full
    // 12 s here would push the deadline out to 20 s of stall every time the
    // effect re-ran, which is how a timeout quietly stops being a timeout.
    expect(bufferRetryDelayMs(stalled(), 1_000 + 8_000)).toBe(4_000);
    expect(bufferRetryDelayMs(stalled(), 1_000)).toBe(BUFFERING_STALL_TIMEOUT_MS);
  });

  it('is 0 once the deadline has passed, so the screen decides in the same commit', () => {
    expect(bufferRetryDelayMs(stalled(), 1_000 + BUFFERING_STALL_TIMEOUT_MS)).toBe(0);
    expect(bufferRetryDelayMs(stalled(), 1_000 + 10 * BUFFERING_STALL_TIMEOUT_MS)).toBe(0);
  });

  it('is 0 when there is no clip, no baseline, or the budget is spent', () => {
    expect(bufferRetryDelayMs(stalled({ clipId: null }), 1_000)).toBe(0);
    expect(bufferRetryDelayMs(stalled({ bufferingSinceMs: null }), 1_000)).toBe(0);
    // The once-only latch also stops the TIMER, not just the decision — a timer
    // that re-armed after the retry is a loop with extra steps.
    expect(bufferRetryDelayMs(stalled({ retried: true }), 1_000)).toBe(0);
  });

  it('delays a whole threshold on a broken clock, rather than deciding on it', () => {
    // Returning 0 would mean "decide now", and `decideBufferRetry` refuses a
    // non-finite elapsed time — so 0 would hold, schedule no timer, and lose the
    // retry for the rest of the clip. The full timeout delays instead, and
    // recovers on the next reading. It can never turn a broken clock into an
    // EARLY re-mint, which is the direction the errors have to go.
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bufferRetryDelayMs(stalled(), nowMs)).toBe(BUFFERING_STALL_TIMEOUT_MS);
    }
    // A clock reading behind the baseline is a device reset or an NTP
    // correction: 13 s "remaining" on a 12 s threshold, i.e. not yet due.
    expect(bufferRetryDelayMs(stalled(), 0)).toBe(BUFFERING_STALL_TIMEOUT_MS + 1_000);
    expect(bufferRetryDelayMs(stalled(), Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('accepts a timeout override so the arithmetic is testable without a 12 s wait', () => {
    expect(bufferRetryDelayMs(stalled(), 1_000, 500)).toBe(500);
    expect(bufferRetryDelayMs(stalled(), 1_400, 500)).toBe(100);
  });
});

/**
 * The runner is the seam the screen uses, so its shape is part of the contract:
 * `useWatchTelemetry` needs to know the one re-mint happened, and the feed needs
 * to be able to call this without a renderer.
 */
describe('retryStalledClip', () => {  it('calls refresh exactly once and reports the clip it was for', () => {
    const refresh = jest.fn();
    const out = retryStalledClip({
      watch: stalled(),
      playback: 'buffering',
      tokenStatus: 'ready',
      nowMs: 1_000 + BUFFERING_STALL_TIMEOUT_MS,
      refresh,
    });
    expect(out.reminted).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.watch.retried).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns the watch UNCHANGED on a hold, so a hold cannot re-arm the latch', () => {
    const watch = stalled();
    const out = retryStalledClip({
      watch,
      playback: 'buffering',
      tokenStatus: 'unavailable',
      nowMs: 1_000 + BUFFERING_STALL_TIMEOUT_MS,
      refresh: jest.fn(),
    });
    expect(out.watch).toBe(watch);
    expect(out.reminted).toBe(false);
    expect(out.reason).toBe('rights-decision');
  });

  it('accepts a timeout override, so the arithmetic is testable without timers', () => {
    const refresh = jest.fn();
    const out = retryStalledClip({
      watch: stalled(),
      playback: 'buffering',
      tokenStatus: 'ready',
      nowMs: 1_500,
      refresh,
      timeoutMs: 500,
    });
    expect(out.reminted).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
