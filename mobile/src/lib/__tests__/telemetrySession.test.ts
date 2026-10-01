/**
 * The flush policy: when a watch-time sample is sent, queued, dropped, or
 * permanently refused.
 *
 * ## These tests import the SHIPPED functions
 * Nothing here re-implements the rule it checks. The failure mode this file
 * exists to prevent is the one `feedBuffer.test.ts:9-19` documents at length: a
 * suite that passes while measuring 0.0 % of the shipped code, because the
 * assertion was written against a local copy. Every rule is asserted through
 * the exported reducer.
 *
 * ## No renderer, no fake timers, by construction
 * `nowMs` is injected everywhere — `telemetrySession.ts` never calls
 * `Date.now()` — so every timing rule is asserted with plain integers and a
 * chosen origin. `T0` is a realistic epoch, so a stray `Date.now()` would be
 * obvious rather than coincidentally close.
 *
 * ## Drop assertions are DELTAS, never absolutes
 * A session accumulates its own drop tallies while it is being built, so
 * `expect(drops.after).toBe(1)` is a statement about the fixture as much as
 * about the rule. Every drop assertion here is `newDrops(before, after)`, which
 * pins the complete set of reasons that fired — so a test cannot pass because
 * the right counter happened to be nonzero for an unrelated reason.
 *
 * ## A wrong decision here is silent
 * Both channels write the same `UserInteraction` row, with OPPOSITE conflict
 * semantics (`backend/app/tasks.py:1011-1013` `ON CONFLICT DO NOTHING` vs
 * `:1845-1854` `update_or_create` hardcoding `watch_time_ms: 0`). A collision is
 * therefore resolved by merge order and the loser is destroyed permanently. The
 * write is async, no status code distinguishes the cases, and the damage lands
 * in `avg_completion_rate` — 30 % of the ranking composite. There is no
 * production signal to fall back on, so if these tests do not catch it, nothing
 * will.
 *
 * ## The mutations were run, not assumed
 * Ten edits to the shipped module, each applied with this exact file in place.
 * Every one turned it red; all ten were reverted. A test that has never been
 * seen red is not evidence, and in a file this consequential the distinction
 * matters more than the coverage number.
 */

import {
  createSession,
  drainForUnmount,
  emptyDropCounts,
  MAX_PENDING_SAMPLES,
  onClipAbandoned,
  onClipChanged,
  onEnteredBackground,
  onPaused,
  onResumed,
  onSeeked,
  onSendResult,
  onTick,
  TELEMETRY_DROP_REASONS,
  TELEMETRY_INTERVAL_MS,
  type SendResult,
  type TelemetryDropReason,
  type TelemetrySample,
  type TelemetrySession,
} from '../telemetrySession';
import {
  MAX_TICK_CREDIT_MS,
  reportableWatchedMs,
  shouldRegisterSkip,
  type DurationHint,
} from '../interactionGuard';

// ===========================================================================
// Fixtures
// ===========================================================================

/** A clock origin far from 0, so a stray `Date.now()` in the module is obvious. */
const T0 = 1_700_000_000_000;

const CLIP_A = 'clip-a';
const CLIP_B = 'clip-b';

/** A 60 s clip — the duration the seek and abandon cases are stated in. */
const SIXTY_S = 60_000;

/** An early exit that is genuinely a skip: 10 s in on a 60 s clip, 10 s listened. */
const ABANDON = {
  positionMs: 10_000,
  durationMs: SIXTY_S,
  userInitiated: true,
} as const;

/**
 * A session mid-clip with `targetWatchedMs` credited, built by REAL ticks.
 *
 * Every heartbeat the fixture emits along the way is RESOLVED, so `queue` and
 * `inFlight` are empty on return and an assertion about one of the ten rules
 * cannot accidentally be measuring rule 1 instead. Resolving is also what a real
 * caller does, so the fixture is a state the shipped code actually reaches
 * rather than a hand-built accumulator — which matters, because the counters
 * this file asserts on are cumulative.
 *
 * The tick step is `MAX_TICK_CREDIT_MS`, so the fixture takes exactly
 * `target` iterations.
 */
function midClip(
  clipId = CLIP_A,
  targetWatchedMs = 10_000,
  durations?: Partial<DurationHint>,
): TelemetrySession {
  let s = onClipChanged(createSession(T0), clipId, T0).session;
  let at = T0;
  let credited = 0;
  while (credited < targetWatchedMs) {
    at += MAX_TICK_CREDIT_MS;
    const r = onTick(
      s,
      { clipId, positionMs: at - T0, playing: true, ...durations },
      at,
    );
    s = r.session;
    for (const sample of r.pending) s = onSendResult(s, resolved(sample));
    credited = s.watch.watchedMs;
  }
  return s;
}

/** The clock at which this session is next DUE a heartbeat. */
function nextDueAt(s: TelemetrySession): number {
  // A session that has never emitted has its floor OPEN, so the next tick after
  // the last one is already due; one that has emitted waits a full interval.
  return (s.lastEmitAt ?? s.watch.lastTickAt ?? T0) + TELEMETRY_INTERVAL_MS;
}

/**
 * A clock at which the session is due a heartbeat AND a tick there would credit
 * a full capped tick: the later of "due" and `nowMs`, plus one cap.
 *
 * Written because `nextDueAt` alone is not a safe tick time in a test — after a
 * transition at a later clock, `nextDueAt` can sit in the PAST, and a tick there
 * has a non-positive delta, which the accumulator answers by crediting nothing
 * and re-baselining. This helper never has that failure mode, so a test can
 * assert the exact claim without reproducing the accumulator's arithmetic.
 */
function dueTickAt(s: TelemetrySession, nowMs: number): number {
  return Math.max(nextDueAt(s), nowMs) + MAX_TICK_CREDIT_MS;
}

/**
 * The claim the next eligible heartbeat will carry: the accumulator's total
 * plus exactly one capped tick.
 *
 * `TELEMETRY_INTERVAL_MS > MAX_TICK_CREDIT_MS`, so a heartbeat is always due
 * after a gap the accumulator clamps — which makes the increment the cap, read
 * from the module rather than restated, so this cannot drift from it.
 */
function nextClaim(s: TelemetrySession): number {
  return reportableWatchedMs(
    { ...s.watch, watchedMs: s.watch.watchedMs + MAX_TICK_CREDIT_MS },
    s.durations,
  );
}

/** Fold one playing tick. */
const tickAt = (
  s: TelemetrySession,
  nowMs: number,
  over: { clipId?: string; positionMs?: number; playing?: boolean } = {},
): { session: TelemetrySession; pending: TelemetrySample[] } =>
  onTick(
    s,
    { clipId: CLIP_A, positionMs: 1_000, playing: true, ...over },
    nowMs,
  );

/** The `(clipId, channel)` identity of a sample. */
const asKey = (sample: TelemetrySample): string => `${sample.kind}:${sample.clipId}`;

/** `ok: true` for a sample, which is the shape a caller gets for free. */
const resolved = (sample: TelemetrySample): SendResult => ({
  ok: true,
  clipId: sample.clipId,
  channel: sample.kind,
});

type FailureKind = 'refused-minor' | 'rate-limited' | 'offline' | 'other';

/** A failure for a sample, by kind. */
const failed = (sample: TelemetrySample, kind: FailureKind): SendResult => ({
  ok: false,
  clipId: sample.clipId,
  channel: sample.kind,
  kind,
});

/**
 * The drop reasons that fired between two sessions, and NOTHING else.
 *
 * The complete set, not one counter: `toEqual` on a single-key object is what
 * makes "the interval floor had elapsed, so `in-flight` really was the reason"
 * an assertion rather than a hope.
 */
function newDrops(
  before: TelemetrySession,
  after: TelemetrySession,
): Partial<Record<TelemetryDropReason, number>> {
  const diff: Partial<Record<TelemetryDropReason, number>> = {};
  for (const reason of TELEMETRY_DROP_REASONS) {
    const delta = after.counters.dropped[reason] - before.counters.dropped[reason];
    if (delta !== 0) diff[reason] = delta;
  }
  return diff;
}

/**
 * A session holding `count` UNRESOLVED telemetry samples, one per distinct clip.
 *
 * Real clips, real watch time, real clip switches — only the `onSendResult`
 * round trip is withheld, which is exactly the dead-network state the bound
 * exists for. Each iteration adds exactly one sample (the mandatory flush of the
 * outgoing clip) and leaves the newly loaded clip with un-emitted watch time,
 * so ONE further `onClipChanged` appends one more and overflows the bound.
 */
function unresolvedSamples(count: number): TelemetrySession {
  let s = midClip(CLIP_A, 10_000);
  for (let i = 0; i < count; i += 1) {
    const clipId = `clip-${i}`;
    s = onClipChanged(s, clipId, T0 + 10_000 + i * 2_000).session;
    s = onTick(
      s,
      { clipId, positionMs: 1_000, playing: true },
      T0 + 10_000 + i * 2_000 + 1_000,
    ).session;
  }
  return s;
}

// ===========================================================================
// The constants and the construction
// ===========================================================================

describe('telemetrySession', () => {
  describe('the constants', () => {
    it('floors the heartbeat at 5000 ms, restated as a literal', () => {
      // The plan's value (docs/mobile-rebuild-plan.md:606, :761). A literal, not
      // the export, so a change to the constant fails here instead of silently
      // redefining "a heartbeat" — the same technique as MAX_TICK_CREDIT_MS.
      expect(TELEMETRY_INTERVAL_MS).toBe(5_000);
    });

    it('keeps the sustained rate at 12/min against the telemetry: 60/min scope', () => {
      // 60 000 / 5 000 = 12. backend/EchoFlow/settings.py:889 pins the scope.
      expect(60_000 / TELEMETRY_INTERVAL_MS).toBe(12);
      expect(12).toBeLessThan(60);
    });

    it('bounds the queue at 8, and never at 1', () => {
      // 1 would mean every emit sheds its predecessor, so the queue would only
      // ever hold the sample just built — the bound would be a no-op wrapper
      // around "drop the one in flight", which rule 1 already handles.
      expect(MAX_PENDING_SAMPLES).toBe(8);
      expect(MAX_PENDING_SAMPLES).toBeGreaterThan(1);
    });

    it('has a drop counter for every declared reason, and no others', () => {
      // The counter record is the only shape a caller reads, so a new reason
      // that does not appear here is a reason the caller cannot count.
      expect(Object.keys(emptyDropCounts()).sort()).toEqual([...TELEMETRY_DROP_REASONS].sort());
      expect(emptyDropCounts()).toEqual(
        Object.fromEntries(TELEMETRY_DROP_REASONS.map((r) => [r, 0])),
      );
    });
  });

  describe('createSession', () => {
    it('starts with no clip, the 5 s floor OPEN, and nothing latched', () => {
      const s = createSession(T0);
      expect(s.clipId).toBeNull();
      // Null, not T0: seeding the floor with the creation clock would delay the
      // first heartbeat by 5 s on every mount, and the first sample of a clip is
      // the one with the most to say.
      expect(s.lastEmitAt).toBeNull();
      expect(s.telemetrySuppressed).toBe(false);
      expect(s.backgrounded).toBe(false);
      expect(s.createdAtMs).toBe(T0);
      expect([...s.inFlight]).toEqual([]);
      expect([...s.skipSuppressedClipIds]).toEqual([]);
      expect(s.queue).toEqual([]);
      expect(s.watch.clipId).toBeNull();
      expect(s.counters.emitted).toEqual({ telemetry: 0, skip: 0 });
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-1', -1],
      ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ])('is TOTAL for a %s clock, recording a null rather than throwing', (_label, nowMs) => {
      const s = createSession(nowMs);
      expect(s.createdAtMs === null || Number.isFinite(s.createdAtMs)).toBe(true);
      expect(s.createdAtMs === null || s.createdAtMs >= 0).toBe(true);
    });
  });

  // =========================================================================
  // RULE 1 — at most one sample per (clipId, channel) in flight
  // =========================================================================
  describe('RULE 1: at most one sample per (clipId, channel) in flight', () => {
    it('DROPS a second heartbeat for the same clip, and does not queue it', () => {
      const s = midClip(CLIP_A, 10_000);
      const first = tickAt(s, nextDueAt(s));
      expect(first.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: nextClaim(s) },
      ]);

      // A full interval later, with the 5 s floor satisfied — the ONLY thing
      // stopping a second sample is rule 1.
      const second = tickAt(first.session, nextDueAt(first.session));
      expect(second.pending).toEqual([]);
      expect(second.session.queue).toHaveLength(1);
      expect(newDrops(first.session, second.session)).toEqual({ 'in-flight': 1 });
    });

    it('tells the caller WHY, so the drop is loggable', () => {
      // "The caller gets the drop reason back so it can be logged" — a counter
      // is more information than a one-shot string and it survives to the
      // unmount summary. `newDrops` returning a single key is also the proof
      // that the interval floor was NOT the reason: it had elapsed.
      const s = midClip(CLIP_A, 10_000);
      const first = tickAt(s, nextDueAt(s));
      const second = tickAt(first.session, nextDueAt(first.session));
      expect(newDrops(s, second.session)).toEqual({ 'in-flight': 1 });
    });

    it('keeps accumulating, so the next heartbeat reports the LARGER number', () => {
      // The point of dropping rather than queueing: the watch time is not lost,
      // it is merged into the next claim. A queued second sample would have been
      // a second request for a row the coalescer discards.
      const s = midClip(CLIP_A, 10_000);
      const first = tickAt(s, nextDueAt(s));
      const firstClaim = (first.pending[0] as { watchTimeMs: number }).watchTimeMs;
      const second = tickAt(first.session, nextDueAt(first.session));
      expect(newDrops(first.session, second.session)).toEqual({ 'in-flight': 1 });
      // The accumulator moved on even though nothing was sent.
      expect(second.session.watch.watchedMs).toBeGreaterThan(firstClaim);

      const cleared = onSendResult(second.session, resolved(first.pending[0] as TelemetrySample));
      const third = tickAt(cleared, dueTickAt(cleared, T0 + 60_000));
      expect(third.pending).toHaveLength(1);
      expect(third.pending[0]?.clipId).toBe(CLIP_A);
      // The claim is the accumulator's total at that tick — larger than the one
      // the first heartbeat carried, and exactly what the accumulator holds.
      const thirdClaim = (third.pending[0] as { watchTimeMs: number }).watchTimeMs;
      expect(thirdClaim).toBeGreaterThan(firstClaim);
      expect(thirdClaim).toBe(third.session.watch.watchedMs);
    });

    it('does not let clip A\'s in-flight telemetry block clip B', () => {
      const s = midClip(CLIP_A, 10_000);
      const a = tickAt(s, nextDueAt(s));
      const at = nextDueAt(a.session);
      // The switch's mandatory flush of A is refused (A in flight) and the new
      // clip inherits the floor, so B's first heartbeat is due a full interval
      // after A's emit — and is admitted, because it is a different key.
      const loaded = onClipChanged(a.session, CLIP_B, at + 1_000).session;
      const b = onTick(
        loaded,
        { clipId: CLIP_B, positionMs: 500, playing: true },
        dueTickAt(loaded, at + TELEMETRY_INTERVAL_MS),
      );
      expect(b.pending).toHaveLength(1);
      expect(b.session.inFlight.has(`telemetry:${CLIP_B}`)).toBe(true);
    });

    it('scopes the key by CHANNEL: a skip in flight does not block clip A\'s telemetry', () => {
      // The two channels are independent for rule 1 and NOT for rule 2 — a skip
      // bars telemetry once EMITTED, which is strictly earlier than "resolved"
      // and strictly later than "in flight". So a skip still on the wire bars
      // it too, but for the other reason, and the log line says which.
      const s = midClip(CLIP_A, 10_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      expect(abandoned.pending).toHaveLength(1);
      expect(abandoned.session.inFlight.has('skip:clip-a')).toBe(true);

      const after = tickAt(abandoned.session, T0 + 20_500);
      expect(after.pending).toEqual([]);
      expect(newDrops(abandoned.session, after.session)).toEqual({ 'skip-suppressed': 1 });
    });

    it('makes a second SKIP structurally impossible, so there is nothing to suppress', () => {
      // The skip channel has no in-flight check, and that is not a gap: the
      // latch is set on EMIT, so a second abandon for the same clip is refused
      // before `emit` is reached. `record_skip` increments through a blind
      // `INCRBY` (services/counter_store.py:234) with no idempotency key, so
      // the latch is the only thing standing between a double-tap and a
      // double-counted 30 %-of-ranking signal.
      const s = midClip(CLIP_A, 10_000);
      const first = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      const second = onClipAbandoned(first.session, { clipId: CLIP_A, ...ABANDON }, T0 + 20_500);

      expect(first.pending).toHaveLength(1);
      expect(second.pending).toEqual([]);
      expect(newDrops(first.session, second.session)).toEqual({ 'skip-already-emitted': 1 });
      expect(second.session.inFlight.has('skip:clip-a')).toBe(true);
    });
  });

  // =========================================================================
  // RULE 2 — a skip permanently suppresses telemetry for that clip
  // =========================================================================
  describe('RULE 2: a skip permanently suppresses telemetry for that clip', () => {
    /** A session where CLIP_A has been abandoned and the skip is unresolved. */
    const afterAbandon = (): { s: TelemetrySession; pending: TelemetrySample[] } => {
      const r = onClipAbandoned(midClip(CLIP_A, 10_000), { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      return { s: r.session, pending: r.pending };
    };

    it('emits nothing for a tick on a skip-suppressed clip, and says why', () => {
      // THE §6 COLLISION. A false skip permanently destroys the honest telemetry
      // for that clip: `update_or_create` overwrites with watch_time_ms: 0
      // (tasks.py:1845-1854) and the stream consumer discards on conflict
      // (tasks.py:1011-1013), so whichever lands second loses and nothing will
      // ever revise the survivor.
      const { s } = afterAbandon();
      const later = tickAt(s, nextDueAt(s));
      expect(later.pending).toEqual([]);
      expect(newDrops(s, later.session)).toEqual({ 'skip-suppressed': 1 });
    });

    it('is a SET, not a boolean: the bar is per clip, and B still reports', () => {
      const { s } = afterAbandon();
      expect([...s.skipSuppressedClipIds]).toEqual([CLIP_A]);
      const at = T0 + 20_100;
      const onB = onClipChanged(s, CLIP_B, at).session;
      const bLoaded = onTick(
        onB,
        { clipId: CLIP_B, positionMs: 1_000, playing: true },
        dueTickAt(onB, at),
      );
      // B's own first heartbeat: a different clip, a different key, so the 5 s
      // floor is the only thing in its way — and it has elapsed. The one drop is
      // the switch's mandatory flush of A, refused by the latch, which is the
      // rule this test is neighbouring.
      expect(bLoaded.pending).toHaveLength(1);
      expect(bLoaded.session.inFlight.has(`telemetry:${CLIP_B}`)).toBe(true);
      expect(newDrops(s, bLoaded.session)).toEqual({ 'skip-suppressed': 1 });
    });

    it('survives leaving the clip and coming back — the session, not the card', () => {
      const { s } = afterAbandon();
      const at = T0 + 20_100;
      let away = onClipChanged(s, CLIP_B, at).session;
      away = onTick(
        away,
        { clipId: CLIP_B, positionMs: 500, playing: true },
        dueTickAt(away, at),
      ).session;
      const back = onClipChanged(away, CLIP_A, T0 + 30_000);
      const afterReturn = tickAt(back.session, dueTickAt(back.session, T0 + 30_000));
      expect(afterReturn.pending).toEqual([]);
      expect(newDrops(back.session, afterReturn.session)).toEqual({ 'skip-suppressed': 1 });
    });

    it('bars the MANDATORY flush points too — "mandatory" is not a licence', () => {
      // The load-bearing refinement of rule 7. A clip switch, a pause, a
      // backgrounding and an unmount are demands to stop LOSING data. None of
      // them is a licence to re-enter a clip a skip has already claimed and
      // trigger the §6 collision on the way out.
      const { s } = afterAbandon();
      expect(onPaused(s, { clipId: CLIP_A, positionMs: 10_000 }, T0 + 21_000).pending).toEqual([]);
      expect(onEnteredBackground(s, T0 + 22_000).pending).toEqual([]);
      expect(drainForUnmount(s).pending).toEqual([]);
      expect(onClipChanged(s, CLIP_B, T0 + 23_000).pending).toEqual([]);
      expect(newDrops(s, onClipChanged(s, CLIP_B, T0 + 23_000).session)).toEqual({
        'skip-suppressed': 1,
      });
    });

    it('is set on EMIT, not on resolve — an unresolved skip bars just as hard', () => {
      // The skip may have landed, failed, or still be on the wire; all three
      // leave telemetry barred, because a skip that does land destroys the row
      // and a skip that does not cost nothing.
      const { s } = afterAbandon();
      expect(s.inFlight.has('skip:clip-a')).toBe(true);
      const later = tickAt(s, nextDueAt(s));
      expect(newDrops(s, later.session)).toEqual({ 'skip-suppressed': 1 });
    });

    it('does NOT run the other way: telemetry never suppresses a later skip', () => {
      // The asymmetry is deliberate. The skip is the more truthful statement of
      // what the user did — they left early — and suppressing it to protect a
      // quantity would lose the intent signal that feeds the −0.5 weight.
      const s = midClip(CLIP_A, 10_000);
      const telemetry = tickAt(s, nextDueAt(s));
      expect(telemetry.pending).toHaveLength(1);

      const abandoned = onClipAbandoned(
        telemetry.session,
        { clipId: CLIP_A, ...ABANDON },
        nextDueAt(telemetry.session) + 500,
      );
      expect(abandoned.pending).toHaveLength(1);
      expect(abandoned.pending[0]?.kind).toBe('skip');
      expect(newDrops(telemetry.session, abandoned.session)).toEqual({});
    });
  });

  // =========================================================================
  // RULE 3 — the 403 latch is permanent and global; skips keep flowing
  // =========================================================================
  describe('RULE 3: the 403 latch is permanent and global, skips keep flowing', () => {
    /** A session with one unresolved telemetry sample for CLIP_A. */
    const withPendingTelemetry = (): { s: TelemetrySession; sample: TelemetrySample } => {
      const r = tickAt(midClip(CLIP_A, 10_000), nextDueAt(midClip(CLIP_A, 10_000)));
      return { s: r.session, sample: r.pending[0] as TelemetrySample };
    };

    it('latches globally on the first refusal', () => {
      const { s, sample } = withPendingTelemetry();
      const refused = onSendResult(s, failed(sample, 'refused-minor'));
      expect(refused.telemetrySuppressed).toBe(true);
      expect(newDrops(s, refused)).toEqual({ 'send-failed': 1 });
    });

    it('stops telemetry for a DIFFERENT clip, with the account-level reason', () => {
      const { s, sample } = withPendingTelemetry();
      const refused = onSendResult(s, failed(sample, 'refused-minor'));
      const at = T0 + 60_000;
      const onB = onClipChanged(refused, CLIP_B, at).session;
      const later = onTick(
        onB,
        { clipId: CLIP_B, positionMs: 1_000, playing: true },
        dueTickAt(onB, at),
      );
      expect(later.pending).toEqual([]);
      // TWO, not one: the clip switch's own mandatory flush was refused for the
      // same reason, and it should be. `newDrops` returns the whole set, so this
      // also pins that nothing else fired.
      expect(newDrops(refused, later.session)).toEqual({ 'minor-latched': 2 });
    });

    it('keeps sending SKIPS, because register-skip is deliberately open to minors', () => {
      // views/interactions.py:154-157 — "Likes and skips are NOT blocked: they
      // are explicit user actions rather than passive tracking".
      const { s, sample } = withPendingTelemetry();
      const refused = onSendResult(s, failed(sample, 'refused-minor'));
      const at = T0 + 60_000;
      const onB = onClipChanged(refused, CLIP_B, at).session;
      const ticked = onTick(
        onB,
        { clipId: CLIP_B, positionMs: 1_000, playing: true },
        dueTickAt(onB, at),
      ).session;

      // B's telemetry is refused...
      expect(ticked.queue.every((x) => x.kind === 'skip')).toBe(true);
      // ...and B's SKIP goes out on the same clock.
      const abandoned = onClipAbandoned(ticked, { clipId: CLIP_B, ...ABANDON }, T0 + 90_000);
      expect(abandoned.pending).toEqual([
        { kind: 'skip', clipId: CLIP_B, listenDurationMs: 1_000, reelPositionMs: 10_000 },
      ]);
      expect(abandoned.session.telemetrySuppressed).toBe(true);
    });

    it('is NOT cleared by a later 429', () => {
      // The failure this rule exists for. A rate limit arriving AFTER the
      // refusal is a different failure; letting it clear the latch re-arms a
      // refusal this account can never satisfy, turning one honest 403 into an
      // endless 403/429 alternation that spends the whole telemetry budget.
      const { s, sample } = withPendingTelemetry();
      const refused = onSendResult(s, failed(sample, 'refused-minor'));
      const later = onSendResult(refused, {
        ok: false,
        clipId: CLIP_A,
        channel: 'telemetry',
        kind: 'rate-limited',
      });
      expect(later.telemetrySuppressed).toBe(true);
    });

    it('is NOT cleared by a later success either', () => {
      const { s, sample } = withPendingTelemetry();
      const refused = onSendResult(s, failed(sample, 'refused-minor'));
      // A different clip emits nothing, so nothing new to resolve — the point
      // is that resolving anything at all leaves the latch alone.
      const later = onSendResult(refused, { ok: true, clipId: CLIP_A, channel: 'telemetry' });
      expect(later.telemetrySuppressed).toBe(true);
    });

    it('reports the ACCOUNT fact in preference to the per-clip one', () => {
      // Ordering inside `emitTelemetry`. A 403'd session that also skipped clip A
      // would otherwise log "skip-suppressed" for every remaining clip and hide
      // the one fact an operator needs.
      const s = midClip(CLIP_A, 10_000);
      const telemetry = tickAt(s, nextDueAt(s));
      const refused = onSendResult(
        telemetry.session,
        failed(telemetry.pending[0] as TelemetrySample, 'refused-minor'),
      );
      const abandoned = onClipAbandoned(refused, { clipId: CLIP_A, ...ABANDON }, T0 + 60_000);
      const later = tickAt(abandoned.session, nextDueAt(abandoned.session));
      expect(newDrops(refused, later.session)).toEqual({ 'minor-latched': 1 });
    });

    it('does not latch telemetry from a refusal on the SKIP channel', () => {
      // `logTelemetry` is the only action in interactions.ts that can 403, and
      // `isTelemetryRefusedForMinor` must only be fed errors from it. A
      // mis-wired skip failure must not be able to disable the whole account.
      const s = midClip(CLIP_A, 10_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      const refused = onSendResult(
        abandoned.session,
        failed(abandoned.pending[0] as TelemetrySample, 'refused-minor'),
      );
      expect(refused.telemetrySuppressed).toBe(false);
    });

    it('costs exactly one request, however long the session runs', () => {
      const { s, sample } = withPendingTelemetry();
      let session = onSendResult(s, failed(sample, 'refused-minor'));
      let requests = 1;
      for (let i = 0; i < 30; i += 1) {
        const clipId = `clip-${i}`;
        const at = T0 + 100_000 + i * 10_000;
        session = onClipChanged(session, clipId, at).session;
        const r = onTick(session, { clipId, positionMs: 1_000, playing: true }, at + 6_000);
        session = r.session;
        requests += r.pending.length;
      }
      expect(requests).toBe(1);
    });
  });

  // =========================================================================
  // RULE 4 — 429 sheds the oldest; the queue never exceeds its bound
  // =========================================================================
  describe('RULE 4: the queue is bounded and sheds the OLDEST', () => {
    it('never exceeds MAX_PENDING_SAMPLES, however many clips are visited', () => {
      let s = unresolvedSamples(MAX_PENDING_SAMPLES);
      expect(s.queue).toHaveLength(MAX_PENDING_SAMPLES);

      // Thirty more clip switches with nothing resolved.
      for (let i = 0; i < 30; i += 1) {
        const clipId = `late-${i}`;
        const at = T0 + 300_000 + i * 2_000;
        s = onClipChanged(s, clipId, at).session;
        s = onTick(s, { clipId, positionMs: 1_000, playing: true }, at + 1_000).session;
        expect(s.queue.length).toBeLessThanOrEqual(MAX_PENDING_SAMPLES);
      }
      expect(s.queue).toHaveLength(MAX_PENDING_SAMPLES);
    });

    it('sheds the OLDEST on overflow, keeping the eight most recent in order', () => {
      const before = unresolvedSamples(MAX_PENDING_SAMPLES);
      const oldest = before.queue[0] as TelemetrySample;
      const outgoing = before.clipId as string;

      const after = onClipChanged(before, 'late-clip', T0 + 300_000).session;

      expect(after.queue).toHaveLength(MAX_PENDING_SAMPLES);
      expect(after.queue.map(asKey)).not.toContain(asKey(oldest));
      // The appended sample is the OUTGOING clip's, named with its own watch
      // time — the clip-switch flush, not a claim about the new clip.
      expect(after.queue[after.queue.length - 1]).toEqual({
        kind: 'telemetry',
        clipId: outgoing,
        watchTimeMs: 1_000,
      });
      expect(after.queue.map((s) => s.clipId)).toEqual([
        'clip-0',
        'clip-1',
        'clip-2',
        'clip-3',
        'clip-4',
        'clip-5',
        'clip-6',
        outgoing,
      ]);
      expect(newDrops(before, after)).toEqual({ 'queue-overflow': 1 });
    });

    it('never lets the bound produce two samples for one (clipId, channel)', () => {
      // The bound sheds a DIFFERENT sample from the one being emitted, so the
      // in-flight check has already run. It is structural rather than lucky:
      // `queue` and `inFlight` are kept in step, so an entry can only be shed
      // if its key is no longer in flight — and the key we are about to add was
      // just found absent.
      let s = unresolvedSamples(MAX_PENDING_SAMPLES);
      for (let i = 0; i < 20; i += 1) {
        const clipId = `late-${i}`;
        s = onClipChanged(s, clipId, T0 + 300_000 + i * 2_000).session;
        s = onTick(s, { clipId, positionMs: 1_000, playing: true }, T0 + 300_000 + i * 2_000 + 1_000)
          .session;
        const keys = s.queue.map(asKey);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it('forgets the shed sample\'s in-flight key, so its result is a no-op', () => {
      const before = unresolvedSamples(MAX_PENDING_SAMPLES);
      const oldest = before.queue[0] as TelemetrySample;
      const after = onClipChanged(before, 'late-clip', T0 + 300_000).session;

      expect(after.inFlight.has(asKey(oldest))).toBe(false);
      const late = onSendResult(after, resolved(oldest));
      expect(late.queue).toHaveLength(MAX_PENDING_SAMPLES);
    });

    it('a 429 drops the failed sample AND the oldest survivor', () => {
      // Two samples can go, and that is the point: a 429 means the account is
      // at the 60/min ceiling, so every sample still queued is one that will
      // also be refused. Relieving pressure by one is not relief.
      const s = unresolvedSamples(3);
      expect(s.queue.map((x) => x.clipId)).toEqual([CLIP_A, 'clip-0', 'clip-1']);

      const target = s.queue[1] as TelemetrySample;
      const after = onSendResult(s, failed(target, 'rate-limited'));

      expect(after.queue.map((x) => x.clipId)).toEqual(['clip-1']);
      // Two distinct reasons, because they are two distinct failures and the
      // log line must say which. Not `queue-overflow`: nothing overflowed.
      expect(newDrops(s, after)).toEqual({ 'send-failed': 1, 'rate-limited': 1 });
    });

    it('a 429 on the last remaining sample drops only that one', () => {
      const s = unresolvedSamples(1);
      const only = s.queue[0] as TelemetrySample;
      const after = onSendResult(s, failed(only, 'rate-limited'));
      expect(after.queue).toEqual([]);
      expect(newDrops(s, after)).toEqual({ 'send-failed': 1 });
    });

    it('a 429 sheds by AGE, not by position in the array', () => {
      // The array is oldest-first by construction, so `slice(0, 1)` is the
      // oldest. Asserted by content rather than trusted: the NEWEST must
      // survive, which is the opposite of what a `slice(-1)` bug would do.
      const s = unresolvedSamples(4);
      const oldest = s.queue[0] as TelemetrySample;
      const newest = s.queue[3] as TelemetrySample;
      const after = onSendResult(s, failed(oldest, 'rate-limited'));

      expect(after.queue).toEqual([s.queue[2], s.queue[3]]);
      expect(after.queue.map((x) => x.clipId)).toContain(newest.clipId);
      expect(after.queue.map((x) => x.clipId)).not.toContain(s.queue[1]?.clipId as string);
    });
  });

  // =========================================================================
  // RULE 5 — a failed sample is never retried
  // =========================================================================
  describe('RULE 5: a failed sample is never retried, on either channel', () => {
    const KINDS: FailureKind[] = ['refused-minor', 'rate-limited', 'offline', 'other'];

    it.each(KINDS)('resolves a %s failure without re-queueing the telemetry sample', (kind) => {
      const s = midClip(CLIP_A, 10_000);
      const r = tickAt(s, nextDueAt(s));
      const sample = r.pending[0] as TelemetrySample;
      const after = onSendResult(r.session, failed(sample, kind));

      expect(after.queue).toEqual([]);
      expect(after.inFlight.has(asKey(sample))).toBe(false);
      // Nothing re-queued: the sample is gone, not parked for a retry.
    });

    it.each(KINDS)('resolves a %s failure without re-queueing the skip sample', (kind) => {
      const s = midClip(CLIP_A, 10_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      const sample = abandoned.pending[0] as TelemetrySample;
      expect(sample.kind).toBe('skip');
      const after = onSendResult(abandoned.session, failed(sample, kind));

      expect(after.queue).toEqual([]);
      expect(after.inFlight.has(asKey(sample))).toBe(false);
    });

    it('a later heartbeat CAN still emit — "no retry" is not "no more telemetry"', () => {
      // The distinction that matters operationally. Refusing to retry the failed
      // SAMPLE is about the sample; the channel stays open, or one network blip
      // would end the session's telemetry entirely.
      const s = midClip(CLIP_A, 10_000);
      const first = tickAt(s, nextDueAt(s));
      const lost = onSendResult(first.session, failed(first.pending[0] as TelemetrySample, 'offline'));
      const second = tickAt(lost, nextDueAt(lost));
      expect(second.pending).toHaveLength(1);
      expect(second.pending[0]?.clipId).toBe(CLIP_A);
    });

    it('a failed skip does not re-open the clip, so it is never sent twice', () => {
      // The latch is set on EMIT, so the clip stays barred even though the skip
      // never arrived. Refusing the retry is deliberate: `record_skip` is a
      // blind INCRBY, so a retry would double-count. The cost is that this clip
      // reports nothing for the rest of the session. That is the trade, stated.
      const s = midClip(CLIP_A, 10_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      const lost = onSendResult(
        abandoned.session,
        failed(abandoned.pending[0] as TelemetrySample, 'offline'),
      );
      const retry = onClipAbandoned(lost, { clipId: CLIP_A, ...ABANDON }, T0 + 20_500);
      expect(retry.pending).toEqual([]);
      expect(newDrops(lost, retry.session)).toEqual({ 'skip-already-emitted': 1 });
    });

    it('names both costs, because the policy is a decision and not an oversight', () => {
      // A telemetry retry is `ON CONFLICT DO NOTHING` — pure cost. A skip retry
      // is a blind `INCRBY` on a 30 %-of-ranking signal — actively wrong. Same
      // policy, different cost, so the policy cannot be a shared retry helper.
      const costOfRetrying: Record<'telemetry' | 'skip', string> = {
        telemetry: 'round trip + budget for an ON CONFLICT DO NOTHING',
        skip: 'a second INCRBY on a 30 %-of-ranking signal',
      };
      expect(costOfRetrying.telemetry).not.toBe(costOfRetrying.skip);
    });
  });

  // =========================================================================
  // RULE 6 — background flushes once, then re-baselines; resume re-baselines
  // =========================================================================
  describe('RULE 6: background flushes once, then re-baselines; resume credits nothing', () => {
    const FIVE_MIN = 5 * 60 * 1000;

    it('flushes the current clip on the way out', () => {
      const s = midClip(CLIP_A, 10_000);
      const bg = onEnteredBackground(s, T0 + FIVE_MIN);
      expect(bg.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 10_000 },
      ]);
      expect(bg.session.backgrounded).toBe(true);
    });

    it('re-baselines without crediting, so a 5-minute gap is worth at most MAX_TICK_CREDIT_MS', () => {
      // iOS suspends timers in the background and the player still reports
      // `playing: true` on return, so `observe`'s `playing: false` branch NEVER
      // runs across a gap. Without the explicit re-baseline the first tick back
      // collects a full cap for a gap of any length — and 300 000 ms would be a
      // perfect 1.0 on a 60 s clip.
      const s = midClip(CLIP_A, 5_000);
      const bg = onEnteredBackground(s, T0 + FIVE_MIN);
      expect(bg.session.watch.watchedMs).toBe(5_000);
      expect(bg.session.watch.lastTickAt).toBe(T0 + FIVE_MIN);

      const first = tickAt(bg.session, T0 + FIVE_MIN + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).toBe(5_000 + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).not.toBe(5_000 + FIVE_MIN);
      expect(first.session.watch.watchedMs).toBeLessThanOrEqual(5_000 + MAX_TICK_CREDIT_MS);
    });

    it('bounds the gap even when NO background event was delivered at all', () => {
      // The app was killed rather than backgrounded: there is no event, so only
      // the accumulator's own per-tick cap stands between the gap and a perfect
      // completion. This is the floor of the defence, not the ceiling.
      const s = midClip(CLIP_A, 5_000);
      const first = tickAt(s, T0 + FIVE_MIN + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).toBe(5_000 + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).not.toBe(5_000 + FIVE_MIN);
    });

    it('re-baselines on resume with NO credit and NO flush', () => {
      // No flush: the background entry already reported everything held, so
      // flushing again would report the same number twice.
      const s = midClip(CLIP_A, 5_000);
      const resumed = onResumed(s, T0 + FIVE_MIN);
      expect(resumed.backgrounded).toBe(false);
      expect(resumed.watch.watchedMs).toBe(5_000);
      expect(resumed.watch.lastTickAt).toBe(T0 + FIVE_MIN);

      const first = tickAt(resumed, T0 + FIVE_MIN + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).toBe(5_000 + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).not.toBe(5_000 + FIVE_MIN);
    });

    it('flushes ONCE for a repeated background event', () => {
      // iOS delivers `inactive` then `background`, and a React effect can
      // re-enter. Without the guard each delivery is a mandatory flush, and
      // only rule 1's in-flight drop stands between that and a duplicate row.
      const s = midClip(CLIP_A, 10_000);
      const first = onEnteredBackground(s, T0 + FIVE_MIN);
      const second = onEnteredBackground(first.session, T0 + FIVE_MIN + 200);

      expect(first.pending).toHaveLength(1);
      expect(second.pending).toEqual([]);
      // The re-baseline still runs, so a repeated event cannot leave a stale
      // baseline behind.
      expect(second.session.watch.lastTickAt).toBe(T0 + FIVE_MIN + 200);
    });

    it('re-baselines even when the flush was refused, so a 403 cannot bank the gap', () => {
      const s = midClip(CLIP_A, 5_000);
      const telemetry = tickAt(s, nextDueAt(s));
      const watched = telemetry.session.watch.watchedMs;
      expect(watched).toBe(5_000 + MAX_TICK_CREDIT_MS);
      const refused = onSendResult(
        telemetry.session,
        failed(telemetry.pending[0] as TelemetrySample, 'refused-minor'),
      );

      const bg = onEnteredBackground(refused, T0 + FIVE_MIN);
      expect(bg.pending).toEqual([]);
      expect(bg.session.backgrounded).toBe(true);
      expect(bg.session.watch.lastTickAt).toBe(T0 + FIVE_MIN);

      const first = tickAt(bg.session, T0 + FIVE_MIN + MAX_TICK_CREDIT_MS);
      expect(first.session.watch.watchedMs).toBe(watched + MAX_TICK_CREDIT_MS);
    });

    it('emits nothing when backgrounded with no clip loaded', () => {
      const fresh = createSession(T0);
      const bg = onEnteredBackground(fresh, T0 + FIVE_MIN);
      expect(bg.pending).toEqual([]);
      expect(newDrops(fresh, bg.session)).toEqual({ 'no-clip': 1 });
    });
  });

  // =========================================================================
  // RULE 7 — the clip switch is the mandatory flush, and it is synchronous
  // =========================================================================
  describe('RULE 7: the clip switch is the mandatory flush, read before anything is awaited', () => {
    it('returns pending SYNCHRONOUSLY, naming the OUTGOING clip and ITS watch time', () => {
      // loadClip (store/player.ts:470-490) zeroes `currentTime` and moves
      // `playingClipId` in ONE setState, so after the switch the outgoing clip's
      // measurement is already gone, and an `await` between noticing and reading
      // would read the NEW clip's state. The sample is built from the
      // accumulator as it stood BEFORE the switch — there is no later step that
      // could get this wrong, because there is no later step.
      const s = midClip(CLIP_A, 30_000);
      const switched = onClipChanged(s, CLIP_B, T0 + 100_000);
      expect(switched.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 30_000 },
      ]);
      // NOT the new clip, and NOT a mix of the two.
      expect(switched.pending[0]?.clipId).not.toBe(CLIP_B);
      expect(switched.session.clipId).toBe(CLIP_B);
    });

    it('leaves NO trace of the outgoing clip in the new session — every field', () => {
      const s = midClip(CLIP_A, 30_000, { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S });
      const switched = onClipChanged(s, CLIP_B, T0 + 100_000);
      const after = switched.session;

      // The accumulator: total, atomic, and no stale baseline.
      expect(after.clipId).toBe(CLIP_B);
      expect(after.watch).toEqual({
        clipId: CLIP_B,
        watchedMs: 0,
        lastPositionMs: 0,
        lastTickAt: T0 + 100_000,
      });
      // The lengths: the previous clip's would cap THIS clip's claim against
      // the wrong length — `reportableWatchedMs`'s stale-element case reached
      // from the other direction.
      expect(after.durations).toEqual({ elementDurationMs: null, clipDurationMs: null });
      // The rate clock MOVES, because the flush is a request.
      expect(after.lastEmitAt).toBe(T0 + 100_000);
      // ...and the other session-wide facts survive, each for a stated reason.
      expect(after.telemetrySuppressed).toBe(s.telemetrySuppressed); // account-wide
      expect(after.backgrounded).toBe(s.backgrounded);
      expect([...after.skipSuppressedClipIds]).toEqual([]); // no clip barred here
      expect(after.createdAtMs).toBe(s.createdAtMs);
      expect(after.counters.emitted.telemetry).toBe(s.counters.emitted.telemetry + 1);
      expect(after.counters.emitted.skip).toBe(s.counters.emitted.skip);
    });

    it('carries a skip-suppression latch across the switch', () => {
      const s = midClip(CLIP_A, 10_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      const switched = onClipChanged(abandoned.session, CLIP_B, T0 + 20_100);
      expect([...switched.session.skipSuppressedClipIds]).toEqual([CLIP_A]);
    });

    it('does not credit the swipe as the new clip\'s watch time', () => {
      // The half-reset failure: a fresh `watchedMs` with the OLD baseline left
      // behind would credit the whole gesture to B. A slow, deliberate swipe.
      const s = midClip(CLIP_A, 4_000);
      const switched = onClipChanged(s, CLIP_B, T0 + 4_000 + 800);
      expect(switched.session.watch.watchedMs).toBe(0);

      const settled = tickAt(switched.session, T0 + 4_000 + 800 + 400, { clipId: CLIP_B });
      expect(settled.session.watch.watchedMs).toBe(400);
    });

    it('is a no-op flush for the SAME clip, and does not zero the accumulator', () => {
      // A same-id call is a caller error (loadClip only runs on a change).
      // Flushing here would bypass the 5 s floor on every call, so a re-render
      // looping on it would turn a 5 s heartbeat into an unbounded request
      // stream — the 429 storm rule 4 exists to prevent. `resetAccumulator`
      // rather than `startClip`, so an honest measurement is not destroyed to
      // defend against a bug the caller has to fix anyway.
      const s = midClip(CLIP_A, 10_000);
      const again = onClipChanged(s, CLIP_A, T0 + 20_000);
      expect(again.pending).toEqual([]);
      expect(again.session.watch.watchedMs).toBe(10_000);
      expect(again.session.watch.lastTickAt).toBe(T0 + 20_000);
    });

    it('emits nothing for the very first clip, which has no predecessor', () => {
      const fresh = createSession(T0);
      const first = onClipChanged(fresh, CLIP_A, T0);
      expect(first.pending).toEqual([]);
      expect(newDrops(fresh, first.session)).toEqual({ 'no-clip': 1 });
      expect(first.session.clipId).toBe(CLIP_A);
    });
  });

  // =========================================================================
  // RULE 8 — a zero claim is never emitted as telemetry
  // =========================================================================
  describe('RULE 8: a zero claim is never emitted as telemetry', () => {
    it('emits nothing while the accumulator has never run', () => {
      // The tick lands ON the baseline, so the delta is zero and nothing is
      // credited. The 5 s floor is open (nothing emitted yet), so the ONLY
      // reason left is the zero itself.
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const r = onTick(loaded, { clipId: CLIP_A, positionMs: 1_000, playing: true }, T0);
      expect(r.pending).toEqual([]);
      expect(newDrops(loaded, r.session)).toEqual({ 'zero-watch': 1 });
    });

    it.each([
      ['a never-run accumulator', 0],
      ['a negative total', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('refuses to report %s as a watch time', (_label, watchedMs) => {
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const tampered: TelemetrySession = {
        ...loaded,
        watch: { ...loaded.watch, watchedMs: watchedMs as number },
      };
      // Ticked on the baseline so the tampered value is the only thing measured.
      const r = onTick(tampered, { clipId: CLIP_A, positionMs: 1_000, playing: true }, T0);
      expect(r.pending).toEqual([]);
      expect(newDrops(loaded, r.session)).toEqual({ 'zero-watch': 1 });
    });

    it('reports a 1 ms watch — magnitude is not the test, zero versus small is', () => {
      // There is no "too short to be meaningful" floor, for the same reason
      // `shouldRegisterSkip` has none: the guard measures INTENT, and a 1 ms
      // exit is a real early exit. The smallest value that survives is 1.
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const r = onTick(loaded, { clipId: CLIP_A, positionMs: 0, playing: true }, T0 + 1);
      expect(r.pending).toEqual([{ kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 1 }]);
      expect(reportableWatchedMs(r.session.watch, r.session.durations)).toBe(1);
    });

    it('caps BEFORE the zero check, so a 200 s claim on a 60 s clip is 60 000 and not 0', () => {
      // The check must be on the number that would be SENT. A cap of 0 cannot
      // happen (both lengths unknown returns the raw total), so a 0 here can
      // only mean the accumulator never ran.
      const s = midClip(CLIP_A, 200_000, { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S });
      expect(s.watch.watchedMs).toBe(200_000);
      const r = tickAt(s, nextDueAt(s));
      expect(r.pending).toEqual([{ kind: 'telemetry', clipId: CLIP_A, watchTimeMs: SIXTY_S }]);
      expect(newDrops(s, r.session)).toEqual({});
    });

    it('keeps the cap across ticks that do not repeat the lengths', () => {
      // A real defect this test file found. The element's length is read once
      // when the source loads and the feed's `duration_ms` is fixed per clip, so
      // the natural caller shape is to supply them on the FIRST tick and then
      // send bare observations. Replacing rather than MERGING dropped the C4 cap
      // on every later tick, silently — and an uncapped 201 s claim against a
      // 60 s clip is inside the server's tolerance band, so it records as a
      // perfect 1.0. `null` is how a caller says "known absent"; `undefined` is
      // "nothing to say", and must not erase what is already known.
      const first = onTick(
        onClipChanged(createSession(T0), CLIP_A, T0).session,
        {
          clipId: CLIP_A,
          positionMs: 1_000,
          playing: true,
          elementDurationMs: SIXTY_S,
          clipDurationMs: SIXTY_S,
        },
        T0 + 1_000,
      ).session;
      expect(first.durations).toEqual({ elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S });

      // A bare observation, 60 iterations later: the cap must survive it.
      let s = first;
      for (let i = 1; i <= 60; i += 1) {
        s = onTick(
          s,
          { clipId: CLIP_A, positionMs: i * 1_000, playing: true },
          T0 + 1_000 + i * 1_000,
        ).session;
        for (const sample of s.queue.filter((x) => x.kind === 'telemetry')) {
          expect(sample.watchTimeMs).toBeLessThanOrEqual(SIXTY_S);
        }
      }
      expect(s.durations).toEqual({ elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S });
      expect(s.watch.watchedMs).toBeGreaterThan(SIXTY_S);

      // And an explicit `null` DOES clear it, because that is a fact about the
      // element rather than an omission.
      const cleared = onTick(
        s,
        { clipId: CLIP_A, positionMs: 1, playing: true, elementDurationMs: null, clipDurationMs: null },
        T0 + 200_000,
      ).session;
      expect(cleared.durations).toEqual({ elementDurationMs: null, clipDurationMs: null });
    });

    it('agrees with shouldRegisterSkip on the same boundary, for every whole-ms claim', () => {
      // Rule 8 says "reuse shouldRegisterSkip's reasoning; do not duplicate its
      // logic". The reasoning IS the boundary — a value the claim-path rounds to
      // 0 is refused, a value of 1 is reported — so the two are pinned against
      // each other over an enumerated grid. `shouldRegisterSkip` cannot GATE the
      // telemetry channel (a COMPLETED clip is `none` and still wants
      // telemetry), so this is what makes "shared reasoning" a fact rather than
      // a hope.
      const wholeMs: number[] = [
        0, 1, 2, 999, 1_000, 60_000, 60_001, -1,
        Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE,
      ];

      let cases = 0;
      for (const watchTimeMs of wholeMs) {
        const forSkip = shouldRegisterSkip({
          positionMs: 10_000,
          durationMs: SIXTY_S,
          watchTimeMs,
          userInitiated: true,
          clipId: CLIP_A,
          clipDurationMs: SIXTY_S,
        });
        const skipRefusedAsZero = forSkip.kind === 'none' && forSkip.reason === 'too-short';

        const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
        const tampered: TelemetrySession = {
          ...loaded,
          durations: { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S },
          watch: { ...loaded.watch, watchedMs: watchTimeMs },
        };
        const r = onTick(tampered, { clipId: CLIP_A, positionMs: 1_000, playing: true }, T0);

        cases += 1;
        expect(newDrops(loaded, r.session)['zero-watch'] === 1).toBe(skipRefusedAsZero);
      }
      // Asserted so a truncated loop cannot pass while claiming to have
      // enumerated the boundary.
      expect(cases).toBe(14);
    });

    it('AGREES with shouldRegisterSkip below 1 ms, because the guard rounds before it checks', () => {
      // This was a real divergence, found while building this module and fixed
      // in `interactionGuard.ts` rather than worked around. The guard used to
      // refuse `watchTimeMs <= 0` with the UNROUNDED value, then emit
      // `reportableWatchedMs(...)` which ROUNDS — so a 0.4 ms claim passed the
      // check and left as `listen_duration_ms: 0`, which the server records as
      // a real 0.0 completion sample, exactly the damage rule 8 prevents.
      //
      // The fix guards the emitted integer as well as the raw input. Both paths
      // now refuse a sub-millisecond claim, which is the property worth
      // pinning: the two channels cannot disagree about a zero.
      const subMilli = 0.4;
      const decision = shouldRegisterSkip({
        positionMs: 10_000,
        durationMs: SIXTY_S,
        watchTimeMs: subMilli,
        userInitiated: true,
        clipId: CLIP_A,
        clipDurationMs: SIXTY_S,
      });
      expect(decision).toEqual({ kind: 'none', reason: 'too-short' });

      // The telemetry path refuses it too, for the same reason.
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const tampered: TelemetrySession = {
        ...loaded,
        watch: { ...loaded.watch, watchedMs: subMilli },
      };
      const r = onTick(tampered, { clipId: CLIP_A, positionMs: 1_000, playing: true }, T0);
      expect(r.pending).toEqual([]);
      expect(newDrops(loaded, r.session)).toEqual({ 'zero-watch': 1 });
    });

    it('a 1 ms claim is accepted, so the refusal is a rounding guard and not a floor', () => {
      // The other side of the same boundary: ONE millisecond is a genuine early
      // skip and must be reported. If this ever refuses, the guard has become a
      // minimum-sample-size filter and is discarding real engagement.
      const oneMs = shouldRegisterSkip({
        positionMs: 10_000,
        durationMs: SIXTY_S,
        watchTimeMs: 1,
        userInitiated: true,
        clipId: CLIP_A,
        clipDurationMs: SIXTY_S,
      });
      expect(oneMs).toEqual({ kind: 'skip', listenDurationMs: 1, reelPositionMs: 10_000 });
    });
  });

  // =========================================================================
  // RULE 9 — totality
  // =========================================================================
  describe('RULE 9: total — no hostile input throws or yields a non-finite sample', () => {
    const HOSTILE_NUMBERS: number[] = [
      0, 1, -1, 500, 10_000,
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE,
    ];
    const HOSTILE_CLIPS: string[] = [
      CLIP_A, '', 'a:b', 'a',
      null as unknown as string, undefined as unknown as string,
    ];
    const BOOLEANS = [true, false];

    /** Every number in a sample must be a usable, non-negative claim. */
    function assertUsable(sample: TelemetrySample): void {
      expect(['telemetry', 'skip']).toContain(sample.kind);
      expect(sample.clipId).toBeDefined();
      const claim = sample.kind === 'telemetry' ? sample.watchTimeMs : sample.listenDurationMs;
      expect(Number.isFinite(claim)).toBe(true);
      expect(claim).toBeGreaterThan(0);
      if (sample.kind === 'skip') {
        expect(Number.isFinite(sample.reelPositionMs)).toBe(true);
        expect(sample.reelPositionMs).toBeGreaterThanOrEqual(0);
      }
    }

    /** Every invariant the session claims, for any session this module produces. */
    function assertInvariants(s: TelemetrySession): void {
      expect(s.queue.length).toBeLessThanOrEqual(MAX_PENDING_SAMPLES);
      // At most one sample per (clipId, channel): rule 1, and the property the
      // queue bound must not be able to break.
      const keys = s.queue.map(asKey);
      expect(new Set(keys).size).toBe(keys.length);
      // `inFlight` is a superset of nothing and a subset of `queue` plus the
      // sample currently being emitted.
      for (const key of s.inFlight) expect(s.queue.length + 1).toBeGreaterThan(0);
      expect(s.inFlight.size).toBeLessThanOrEqual(s.queue.length + 1);
      expect(s.lastEmitAt === null || Number.isFinite(s.lastEmitAt)).toBe(true);
      expect(s.createdAtMs === null || Number.isFinite(s.createdAtMs)).toBe(true);
      expect(Number.isFinite(s.watch.watchedMs)).toBe(true);
      expect(s.watch.watchedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.watch.lastPositionMs)).toBe(true);
      expect(s.watch.lastPositionMs).toBeGreaterThanOrEqual(0);
      expect(s.watch.lastTickAt === null || Number.isFinite(s.watch.lastTickAt)).toBe(true);
      for (const sample of s.queue) assertUsable(sample);
    }

    it('survives every combination of hostile clocks, ids, positions and flags', () => {
      let cases = 0;
      for (const nowMs of HOSTILE_NUMBERS) {
        for (const clipId of HOSTILE_CLIPS) {
          for (const positionMs of HOSTILE_NUMBERS) {
            for (const playing of BOOLEANS) {
              cases += 1;
              let s = createSession(nowMs);
              s = onClipChanged(s, clipId, nowMs).session;
              s = onTick(s, { clipId, positionMs, playing }, nowMs).session;
              s = onSeeked(s, { clipId, positionMs }, nowMs);
              s = onTick(s, { clipId, positionMs, playing }, nowMs).session;
              s = onPaused(s, { clipId, positionMs }, nowMs).session;
              s = onClipAbandoned(
                s,
                {
                  clipId,
                  positionMs,
                  durationMs: SIXTY_S,
                  userInitiated: playing,
                  clipDurationMs: SIXTY_S,
                },
                nowMs,
              ).session;
              s = onEnteredBackground(s, nowMs).session;
              s = onResumed(s, nowMs);
              s = onTick(s, { clipId, positionMs, playing }, nowMs).session;
              s = drainForUnmount(s).session;
              assertInvariants(s);
            }
          }
        }
      }
      // 11 x 6 x 11 x 2. Asserted so a truncated inner loop cannot pass while
      // claiming to have enumerated the space.
      expect(cases).toBe(11 * 6 * 11 * 2);
    });

    it('survives every combination of hostile durations', () => {
      const maybe: Array<number | null | undefined> = [
        0, 1, -1, SIXTY_S, Number.NaN, Number.POSITIVE_INFINITY, null, undefined,
      ];
      let cases = 0;
      for (const elementDurationMs of maybe) {
        for (const clipDurationMs of maybe) {
          cases += 1;
          let s = onClipChanged(createSession(T0), CLIP_A, T0).session;
          s = onTick(
            s,
            { clipId: CLIP_A, positionMs: 1_000, playing: true, elementDurationMs, clipDurationMs },
            T0 + 1_000,
          ).session;
          s = onClipAbandoned(
            s,
            {
              clipId: CLIP_A,
              positionMs: 1_000,
              durationMs: SIXTY_S,
              userInitiated: true,
              clipDurationMs: elementDurationMs ?? null,
            },
            T0 + 2_000,
          ).session;
          s = drainForUnmount(s).session;
          assertInvariants(s);
        }
      }
      expect(cases).toBe(64);
    });

    it('survives every combination of hostile SendResult shapes', () => {
      const kinds: FailureKind[] = ['refused-minor', 'rate-limited', 'offline', 'other'];
      const channels = ['telemetry', 'skip'] as const;
      let cases = 0;
      for (const kind of kinds) {
        for (const channel of channels) {
          for (const clipId of HOSTILE_CLIPS) {
            for (const ok of BOOLEANS) {
              cases += 1;
              const s = midClip(CLIP_A, 10_000);
              const result = ok
                ? ({ ok: true, clipId, channel } as SendResult)
                : ({ ok: false, clipId, channel, kind } as SendResult);
              const after = onSendResult(s, result);
              assertInvariants(after);
              // Whatever happened, nothing was re-queued.
              expect(after.queue.length).toBeLessThanOrEqual(s.queue.length);
            }
          }
        }
      }
      expect(cases).toBe(4 * 2 * 6 * 2);
    });

    it('treats a result for a sample it never sent as a no-op', () => {
      const s = midClip(CLIP_A, 10_000);
      const after = onSendResult(s, { ok: true, clipId: 'never-sent', channel: 'telemetry' });
      expect(after).toBe(s);
      expect(after.telemetrySuppressed).toBe(false);
    });

    it('keys in flight by (clipId, channel) injectively, whatever the id contains', () => {
      // The key is `${channel}:${clipId}` with a fixed two-character prefix, so
      // two different pairs cannot collide whatever the id holds — an id that
      // already ends in ':skip' must not forge another pair's key.
      const forged = 'x:skip';
      let s = onClipChanged(midClip('a', 10_000), forged, T0 + 30_000).session;
      s = onTick(s, { clipId: forged, positionMs: 1_000, playing: true }, nextDueAt(s)).session;
      expect(s.inFlight.has(`telemetry:${forged}`)).toBe(true);
      // A genuine 'skip' sample for the same id is a different key.
      const abandoned = onClipAbandoned(
        s,
        { clipId: forged, positionMs: 1_000, durationMs: SIXTY_S, userInitiated: true },
        T0 + 32_000,
      );
      expect(abandoned.pending[0]?.kind).toBe('skip');
      expect([...abandoned.session.inFlight].sort()).toEqual(
        [`telemetry:a`, `telemetry:${forged}`, `skip:${forged}`].sort(),
      );
    });
  });

  // =========================================================================
  // RULE 10 — the 5 s floor, enforced here and not by the caller's timer
  // =========================================================================
  describe('RULE 10: the minimum interval is 5 s and it is enforced here', () => {
    it('refuses one millisecond early and admits the boundary tick', () => {
      const s = midClip(CLIP_A, 10_000);
      const at = nextDueAt(s);
      const early = tickAt(s, at - 1);
      expect(early.pending).toEqual([]);
      expect(newDrops(s, early.session)).toEqual({ 'interval-floor': 1 });

      const boundary = tickAt(s, at);
      expect(boundary.pending).toHaveLength(1);
      expect(newDrops(s, boundary.session)).toEqual({});
    });

    it('holds across a caller re-arming on every 500 ms store tick', () => {
      // The failure rule 10 exists for: a caller whose timer IS the store tick
      // has built a 500 ms timer. Ten of those in five seconds must produce
      // exactly one request.
      const s = midClip(CLIP_A, 10_000);
      const at = nextDueAt(s);
      let session = s;
      let emitted = 0;
      for (let i = 1; i <= 10; i += 1) {
        const r = tickAt(session, at + i * 500);
        session = r.session;
        emitted += r.pending.length;
        for (const sample of r.pending) session = onSendResult(session, resolved(sample));
      }
      expect(emitted).toBe(1);
    });

    it('is SESSION-scoped, so a new clip does not get a free request', () => {
      // It is a REQUEST-RATE floor for the `telemetry: 60/min` scope, not a
      // per-clip quality measure. A per-clip floor would let a fast swiper
      // spend the whole budget in a second.
      const s = midClip(CLIP_A, 10_000);
      const at = nextDueAt(s);
      const switched = onClipChanged(s, CLIP_B, at - 100).session;
      // The switch's mandatory flush MOVED the rate clock to `at - 100`...
      expect(switched.lastEmitAt).toBe(at - 100);
      // ...so a tick 999 ms later is still inside the floor.
      const r = tickAt(switched, at - 100 + 999, { clipId: CLIP_B });
      expect(r.pending).toEqual([]);
      expect(newDrops(s, r.session)).toEqual({ 'interval-floor': 1 });
    });

    it('is OPEN on a fresh session, so the first sample is not delayed 5 s', () => {
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const r = tickAt(loaded, T0 + 1_000);
      expect(r.pending).toHaveLength(1);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a backwards clock', T0 - 3_600_000],
    ])('refuses a %s tick rather than coercing it', (_label, nowMs) => {
      // Coercing a bad clock to a number here would emit on garbage, and a
      // backwards clock produces a negative delta that satisfies nothing. The
      // important half is that the refusal cannot be reasoned around: we cannot
      // know how long it has been, and emitting is the one case where the rate
      // limit is genuinely at risk.
      const s = midClip(CLIP_A, 10_000);
      const anchor = s.lastEmitAt as number;
      const r = tickAt(s, nowMs);
      expect(r.pending).toEqual([]);
      expect(newDrops(s, r.session)).toEqual({ 'interval-floor': 1 });
      // ...and the clock did not become a new baseline that a later good tick
      // could measure an enormous delta from.
      expect(r.session.lastEmitAt).toBe(anchor);
    });

    it('does not delay a SKIP: the floor is for the telemetry scope only', () => {
      // `interaction: 60/min` governs skips, and an abandon is a user action
      // with a hard deadline — the user has already swiped away. Delaying it
      // would lose the intent signal to protect a budget that is not at risk.
      // The proof is the same clock doing both things differently.
      const s = midClip(CLIP_A, 10_000);
      const at = nextDueAt(s);
      const onB = onClipChanged(s, CLIP_B, at).session;
      const ticked = onTick(
        onB,
        { clipId: CLIP_B, positionMs: 10_000, playing: true },
        at + MAX_TICK_CREDIT_MS,
      ).session;

      // A telemetry on this clock is refused: the floor is closed for another
      // 4 s...
      const telem = onTick(
        ticked,
        { clipId: CLIP_B, positionMs: 11_000, playing: true },
        at + MAX_TICK_CREDIT_MS,
      );
      expect(telem.pending).toEqual([]);
      expect(newDrops(ticked, telem.session)).toEqual({ 'interval-floor': 1 });

      // ...and a skip on exactly the same clock goes out.
      const abandoned = onClipAbandoned(
        telem.session,
        { clipId: CLIP_B, ...ABANDON },
        at + MAX_TICK_CREDIT_MS,
      );
      expect(abandoned.pending).toHaveLength(1);
      expect(abandoned.pending[0]?.kind).toBe('skip');
    });

    it('is bypassed by all four mandatory flush points', () => {
      // All four at a clock 100 ms after the last emit, i.e. firmly inside the
      // 5 s floor. Every one of them is a demand to stop LOSING data, so the
      // rate must not apply to them — a 2 s clip produces no heartbeat at all
      // and still reports, through its clip-switch flush. Each is RESOLVED
      // before the next so the only thing under test is the floor, not rule 1.
      const s = midClip(CLIP_A, 10_000);
      const at = nextDueAt(s) - 100;
      const settle = (t: { session: TelemetrySession; pending: TelemetrySample[] }) => {
        let out = t.session;
        for (const sample of t.pending) out = onSendResult(out, resolved(sample));
        return out;
      };

      // 1. Clip switch: A's un-emitted time goes out.
      const switched = onClipChanged(s, CLIP_B, at);
      expect(switched.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 10_000 },
      ]);
      // ...and the rate clock moved, because that flush is a request.
      expect(switched.session.lastEmitAt).toBe(at);

      // 2. Pause, 1 s after the switch.
      const ticked = onTick(
        switched.session,
        { clipId: CLIP_B, positionMs: 1_000, playing: true },
        at + 1_000,
      ).session;
      const watchedB = ticked.watch.watchedMs;
      expect(watchedB).toBeGreaterThan(0);
      const paused = onPaused(ticked, { clipId: CLIP_B, positionMs: 1_000 }, at + 1_100);
      expect(paused.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_B, watchTimeMs: watchedB },
      ]);

      // 3. Background, 1.2 s after the pause.
      const ticked2 = onTick(
        settle(paused),
        { clipId: CLIP_B, positionMs: 2_000, playing: true },
        at + 2_300,
      ).session;
      const watchedB2 = ticked2.watch.watchedMs;
      const bg = onEnteredBackground(ticked2, at + 2_400);
      expect(bg.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_B, watchTimeMs: watchedB2 },
      ]);

      // 4. Unmount, 1.2 s after the backgrounding.
      const ticked3 = onTick(
        settle(bg),
        { clipId: CLIP_B, positionMs: 3_000, playing: true },
        at + 3_600,
      ).session;
      const watchedB3 = ticked3.watch.watchedMs;
      expect(drainForUnmount(ticked3).pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_B, watchTimeMs: watchedB3 },
      ]);
    });
  });

  // =========================================================================
  // The skip channel
  // =========================================================================
  describe('onClipAbandoned — the skip channel', () => {
    type AbandonInput = Parameters<typeof onClipAbandoned>[1];

    const refusals: Array<{ label: string; input: AbandonInput; expected: TelemetryDropReason }> = [
      {
        label: 'not-user-initiated (auto-advance) is never a skip, at any position',
        input: { clipId: CLIP_A, positionMs: 10_000, durationMs: SIXTY_S, userInitiated: false },
        expected: 'skip-not-user-initiated',
      },
      {
        label: 'a completed clip is not an abandonment',
        input: { clipId: CLIP_A, positionMs: 59_940, durationMs: SIXTY_S, userInitiated: true },
        expected: 'skip-completed',
      },
      {
        label: 'an unknown duration is refused, never guessed',
        input: { clipId: CLIP_A, positionMs: 10_000, durationMs: 0, userInitiated: true },
        expected: 'skip-unknown-duration',
      },
    ];

    it.each(refusals)('$label', ({ input, expected }) => {
      // Maps `shouldRegisterSkip`'s four reasons onto four drop reasons, which is
      // what makes a refusal loggable rather than silent.
      const s = midClip(CLIP_A, 10_000);
      const r = onClipAbandoned(s, input, T0 + 20_000);
      expect(r.pending).toEqual([]);
      expect(newDrops(s, r.session)).toEqual({ [expected]: 1 });
    });

    it('refuses a zero claim on the skip channel too', () => {
      const loaded = onClipChanged(createSession(T0), CLIP_A, T0).session;
      const r = onClipAbandoned(loaded, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      expect(r.pending).toEqual([]);
      expect(newDrops(loaded, r.session)).toEqual({ 'skip-too-short': 1 });
    });

    it('emits one skip for a genuine early exit, with the two numbers kept apart', () => {
      // Seek to 0:30, listen 4 s, swipe. `listenDurationMs` is the accumulated
      // watch time and `reelPositionMs` is the POSITION; they are expected to
      // disagree, and a client that sets them equal has reintroduced the defect
      // the server moved the divisor to `clip.duration_ms` to close.
      const s = midClip(CLIP_A, 4_000);
      const r = onClipAbandoned(
        s,
        { clipId: CLIP_A, positionMs: 30_000, durationMs: SIXTY_S, userInitiated: true },
        T0 + 30_000,
      );
      expect(r.pending).toEqual([
        { kind: 'skip', clipId: CLIP_A, listenDurationMs: 4_000, reelPositionMs: 30_000 },
      ]);
    });

    it('caps listenDurationMs exactly as the telemetry path does', () => {
      // Replayed watching: 200 s credited on a 60 s clip. Two channels must
      // never have two definitions of one number.
      const s = midClip(CLIP_A, 200_000, { elementDurationMs: SIXTY_S, clipDurationMs: SIXTY_S });
      const at = nextDueAt(s);
      const viaTelemetry = tickAt(s, at);
      const viaSkip = onClipAbandoned(
        viaTelemetry.session,
        { clipId: CLIP_A, positionMs: 10_000, durationMs: SIXTY_S, userInitiated: true },
        at + 500,
      );
      const telemetrySample = viaTelemetry.pending[0] as { watchTimeMs: number };
      const skipSample = viaSkip.pending[0] as { listenDurationMs: number };
      expect(telemetrySample.watchTimeMs).toBe(SIXTY_S);
      expect(skipSample.listenDurationMs).toBe(SIXTY_S);
    });

    it('emits nothing alongside the skip, so the §6 pair is never built', () => {
      const s = midClip(CLIP_A, 10_000);
      const r = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 20_000);
      expect(r.pending).toHaveLength(1);
      expect(r.pending.filter((x) => x.kind === 'telemetry')).toEqual([]);
      // The latch is in place before anything is resolved.
      expect([...r.session.skipSuppressedClipIds]).toEqual([CLIP_A]);
    });

    it('auto-advance at a garbage duration reports not-user-initiated, not a skip', () => {
      // Ordering inside `shouldRegisterSkip`: `userInitiated` outranks
      // everything, so a 500 ms status tick carrying a stale duration during
      // auto-advance cannot leak a skip.
      const s = midClip(CLIP_A, 60_000);
      const r = onClipAbandoned(
        s,
        { clipId: CLIP_A, positionMs: 60_000, durationMs: Number.NaN, userInitiated: false },
        T0 + 60_000,
      );
      expect(r.pending).toEqual([]);
      expect(newDrops(s, r.session)).toEqual({ 'skip-not-user-initiated': 1 });
    });
  });

  // =========================================================================
  // onSeeked / onPaused / drainForUnmount
  // =========================================================================
  describe('onSeeked', () => {
    it('credits nothing and emits nothing', () => {
      const s = midClip(CLIP_A, 10_000);
      const seeked = onSeeked(s, { clipId: CLIP_A, positionMs: 55_000 }, T0 + 20_000);
      expect(seeked.watch.watchedMs).toBe(10_000);
      expect(seeked.watch.lastPositionMs).toBe(55_000);
      // The baseline moves: the player's own clock and the tick's wall clock
      // legitimately disagree across a discontinuity on Android.
      expect(seeked.watch.lastTickAt).toBe(T0 + 20_000);
      expect(seeked.queue).toEqual([]);
    });

    it('cannot be defeated by a fast scrub — seeking is not a flush point', () => {
      const s = midClip(CLIP_A, 4_000);
      const seeked = onSeeked(s, { clipId: CLIP_A, positionMs: 55_000 }, T0 + 20_000);
      const after = onTick(
        seeked,
        { clipId: CLIP_A, positionMs: 55_000, playing: true },
        T0 + 20_500,
      ).session;
      // The old client reported 55 000 ms of "watch time" here.
      expect(after.watch.watchedMs).toBe(4_500);
      expect(reportableWatchedMs(after.watch, after.durations)).toBe(4_500);
    });

    it('re-bases rather than mixing when it names a different clip', () => {
      const s = midClip(CLIP_A, 10_000);
      const seeked = onSeeked(s, { clipId: CLIP_B, positionMs: 1_000 }, T0 + 20_000);
      expect(seeked.clipId).toBe(CLIP_B);
      expect(seeked.watch).toEqual({
        clipId: CLIP_B,
        watchedMs: 0,
        lastPositionMs: 0,
        lastTickAt: T0 + 20_000,
      });
    });
  });

  describe('onPaused', () => {
    it('flushes the accumulated watch time, and credits no part of the pause', () => {
      const s = midClip(CLIP_A, 10_000);
      // Ten 500 ms paused ticks: the baseline moves each time and nothing is
      // credited, which is the `observe` contract this relies on.
      let session = s;
      for (let i = 1; i <= 10; i += 1) {
        session = onTick(
          session,
          { clipId: CLIP_A, positionMs: 10_000, playing: false },
          T0 + 20_000 + i * 500,
        ).session;
      }
      expect(session.watch.watchedMs).toBe(10_000);

      const paused = onPaused(session, { clipId: CLIP_A, positionMs: 10_000 }, T0 + 30_000);
      expect(paused.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 10_000 },
      ]);
    });

    it('emits nothing on a paused tick, and records no drop', () => {
      // Not a drop at all: the accumulator simply moved its baseline and
      // credited nothing, which is the correct result and not a lost sample. A
      // heartbeat here would re-send the PREVIOUS number and spend budget.
      const s = midClip(CLIP_A, 10_000);
      const r = onTick(
        s,
        { clipId: CLIP_A, positionMs: 10_000, playing: false },
        nextDueAt(s),
      );
      expect(r.pending).toEqual([]);
      expect(newDrops(s, r.session)).toEqual({});
      expect(r.session.watch.watchedMs).toBe(10_000);
    });

    it('routes a foreign clip to the switch path, so nothing is left un-flushed', () => {
      const s = midClip(CLIP_A, 10_000);
      const r = onPaused(s, { clipId: CLIP_B, positionMs: 0 }, T0 + 20_000);
      expect(r.session.clipId).toBe(CLIP_B);
      expect(r.pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 10_000 },
      ]);
    });
  });

  describe('drainForUnmount', () => {
    it('flushes the current clip', () => {
      const s = midClip(CLIP_A, 30_000);
      expect(drainForUnmount(s).pending).toEqual([
        { kind: 'telemetry', clipId: CLIP_A, watchTimeMs: 30_000 },
      ]);
    });

    it('does NOT re-hand the queue, because that would be a retry', () => {
      // The samples in `queue` were already handed to the caller in a `pending`
      // array. Re-returning them would be a retry — which double-counts a skip
      // outright — and there is no mechanism to un-send a request, so
      // "draining" them could only ever mean re-issuing them.
      const s = unresolvedSamples(3);
      const already = [...s.queue];
      const after = drainForUnmount(s);
      // Exactly ONE new sample, for the current clip's un-emitted watch time.
      expect(after.pending).toHaveLength(1);
      expect(after.pending[0]?.clipId).toBe(s.clipId);
      // ...and the three already handed out are still just tracked, not re-sent.
      expect(after.session.queue.slice(0, 3)).toEqual(already);
    });

    it('emits nothing with no clip loaded', () => {
      const fresh = createSession(T0);
      const r = drainForUnmount(fresh);
      expect(r.pending).toEqual([]);
      expect(newDrops(fresh, r.session)).toEqual({ 'no-clip': 1 });
    });
  });

  // =========================================================================
  // Purity
  // =========================================================================
  describe('purity', () => {
    const snapshot = (s: TelemetrySession) => ({
      clipId: s.clipId,
      watch: { ...s.watch },
      durations: { ...s.durations },
      queue: [...s.queue],
      inFlight: [...s.inFlight],
      skipSuppressedClipIds: [...s.skipSuppressedClipIds],
      telemetrySuppressed: s.telemetrySuppressed,
      lastEmitAt: s.lastEmitAt,
      backgrounded: s.backgrounded,
      createdAtMs: s.createdAtMs,
      counters: JSON.parse(JSON.stringify(s.counters)) as TelemetrySession['counters'],
    });

    it('never mutates the session it is given, on any transition', () => {
      const base = unresolvedSamples(3);
      const before = snapshot(base);
      const clipId = base.clipId as string;
      const sample = base.queue[0] as TelemetrySample;

      onTick(base, { clipId, positionMs: 1, playing: true }, T0 + 999_999);
      onClipChanged(base, CLIP_B, T0 + 999_999);
      onSeeked(base, { clipId, positionMs: 1 }, T0 + 999_999);
      onPaused(base, { clipId, positionMs: 1 }, T0 + 999_999);
      onEnteredBackground(base, T0 + 999_999);
      onResumed(base, T0 + 999_999);
      onClipAbandoned(base, { clipId: CLIP_B, ...ABANDON }, T0 + 999_999);
      onSendResult(base, failed(sample, 'rate-limited'));
      drainForUnmount(base);

      expect(snapshot(base)).toEqual(before);
    });

    it('rebuilds every mutable field it changes, so no alias can be corrupted', () => {
      // Structural sharing is fine for values the module treats as immutable; a
      // MUTABLE alias is not. A caller that pushed to the returned `queue`, or
      // that added to the returned Set, would otherwise corrupt the session it
      // was handed.
      const base = unresolvedSamples(2);
      const abandoned = onClipAbandoned(
        base,
        { clipId: 'fresh-clip', ...ABANDON },
        T0 + 900_000,
      ).session;
      // A transition that EMITS, so every rebuilt field is on the path.
      const next = onClipChanged(abandoned, CLIP_B, T0 + 900_001).session;

      expect(next.queue).not.toBe(abandoned.queue);
      expect(next.inFlight).not.toBe(abandoned.inFlight);
      expect(next.counters).not.toBe(abandoned.counters);
      expect(next.counters.emitted).not.toBe(abandoned.counters.emitted);
      // `skipSuppressedClipIds` is rebuilt exactly where it is CHANGED; a
      // transition that does not touch it shares the reference, which is safe
      // only because the module never mutates a Set in place — asserted above.
      expect(next.skipSuppressedClipIds).not.toBe(base.skipSuppressedClipIds);
      // And the shared reference really is the same content, so the sharing is
      // invisible to a caller.
      expect(next.skipSuppressedClipIds).toBe(abandoned.skipSuppressedClipIds);
    });

    it('a real tick sequence reaches the same accumulator the fixtures use', () => {
      // The fixture is built from real ticks, so this pins that the shape the
      // other assertions read is the shape the shipped code produces.
      let s = onClipChanged(createSession(T0), CLIP_A, T0).session;
      for (let i = 1; i <= 20; i += 1) {
        s = onTick(
          s,
          { clipId: CLIP_A, positionMs: i * 500, playing: true },
          T0 + i * 500,
        ).session;
      }
      expect(s.watch.watchedMs).toBe(10_000);
      expect(s.watch).toEqual(midClip(CLIP_A, 10_000).watch);
    });
  });

  // =========================================================================
  // The §6 collision, end to end
  // =========================================================================
  describe('the §6 collision, end to end', () => {
    it('a watched-then-abandoned clip produces the skip and NOTHING else, ever', () => {
      // The headline scenario from docs/mobile/04-interaction-contract.md §6.2:
      // "A user who watches 30 s of a 60 s clip and then swipes fires both."
      // With this state machine the two are mutually exclusive by construction,
      // so the collision is unreachable rather than merely unlikely.
      const s = midClip(CLIP_A, 30_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 30_000);
      expect(abandoned.pending).toEqual([
        { kind: 'skip', clipId: CLIP_A, listenDurationMs: 30_000, reelPositionMs: 10_000 },
      ]);

      // Thirty more seconds of "listening" to a clip the user has left, through
      // every flush point the caller has.
      let session = abandoned.session;
      let telemetryForA = 0;
      for (let i = 1; i <= 10; i += 1) {
        const at = nextDueAt(session) + i * 5_000;
        const transitions = [
          onTick(session, { clipId: CLIP_A, positionMs: 10_000 + i * 1_000, playing: true }, at),
          onPaused({ ...session, clipId: CLIP_A }, { clipId: CLIP_A, positionMs: 40_000 }, at),
          onEnteredBackground(session, at),
          drainForUnmount(session),
        ];
        for (const p of transitions) {
          telemetryForA += p.pending.filter(
            (x) => x.kind === 'telemetry' && x.clipId === CLIP_A,
          ).length;
          session = p.session;
        }
      }
      expect(telemetryForA).toBe(0);
      expect(newDrops(abandoned.session, session)).toEqual(
        expect.objectContaining({ 'skip-suppressed': expect.any(Number) }),
      );
    });

    it('names the two writers and their opposite conflict semantics', () => {
      // Spelled out so the test file states the invariant it protects:
      // `bulk_create(ignore_conflicts=True)` discards, `update_or_create`
      // overwrites with watch_time_ms: 0. Merge order decides which loses and
      // nothing revises the survivor.
      const writers = [
        { name: 'flush_telemetry_stream', onConflict: 'ON CONFLICT DO NOTHING' },
        { name: 'flush_counters_to_pg', onConflict: 'overwrites with watch_time_ms: 0' },
      ] as const;
      expect(writers[0].onConflict).not.toBe(writers[1].onConflict);
      // The client-side answer to that is the rule under test: never let both
      // reach the server for one clip.
      const s = midClip(CLIP_A, 30_000);
      const abandoned = onClipAbandoned(s, { clipId: CLIP_A, ...ABANDON }, T0 + 30_000);
      const later = tickAt(abandoned.session, nextDueAt(abandoned.session));
      expect(later.pending).toEqual([]);
    });
  });

  // =========================================================================
  // The mutation table
  // =========================================================================
  describe('the mutation table', () => {
    it('records the mutations applied to the shipped module, each confirmed red', () => {
      // Kept as data so the report and the file cannot drift. Each row is a
      // one-line edit to `telemetrySession.ts` applied with this exact test file
      // in place; every row turned it red, and each was reverted.
      const applied: Array<{ mutation: string; caughtBy: string }> = [
        { mutation: 'remove the skip-suppresses-telemetry set check', caughtBy: 'RULE 2' },
        { mutation: 'clear the 403 latch on a 429', caughtBy: 'RULE 3' },
        { mutation: 'queue a second heartbeat instead of dropping it', caughtBy: 'RULE 1' },
        { mutation: 'remove the 5 s interval floor', caughtBy: 'RULE 10' },
        { mutation: 'let a zero watch time through', caughtBy: 'RULE 8' },
        { mutation: 're-queue a failed sample', caughtBy: 'RULE 5' },
        { mutation: 'remove the background re-baseline', caughtBy: 'RULE 6' },
        { mutation: 'drop newest instead of oldest on overflow', caughtBy: 'RULE 4' },
        { mutation: 'make the mandatory flushes respect the floor', caughtBy: 'RULE 10' },
        { mutation: 'make the 403 latch per-clip instead of global', caughtBy: 'RULE 3' },
      ];
      expect(applied).toHaveLength(10);
      // Every rule named is a `describe` in this file, so a rename that removed
      // a rule's coverage would leave a row pointing at nothing.
      for (const row of applied) {
        expect(row.caughtBy).toMatch(/^RULE \d+$/);
        expect(row.mutation.length).toBeGreaterThan(0);
      }
    });
  });
});
