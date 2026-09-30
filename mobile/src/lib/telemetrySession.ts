import {
  initialAccumulator,
  observe,
  onSeek,
  reportableWatchedMs,
  resetAccumulator,
  shouldRegisterSkip,
  startClip,
  type DurationHint,
  type SkipDecision,
  type WatchAccumulator,
} from './interactionGuard';

/**
 * The flush policy: when a watch-time sample is SENT, QUEUED, DROPPED, or
 * permanently refused.
 *
 * ===========================================================================
 * WHY THIS IS A PURE REDUCER AND NOT A HOOK
 * ===========================================================================
 * Every rule below is a *decision about two requests that hit the same row*.
 * `log-telemetry` and `register-skip` both land in `UserInteraction` keyed
 * `(user, clip, interaction_type)`, and their conflict semantics are OPPOSITE
 * (§6.2 of `docs/mobile/04-interaction-contract.md`, verified at
 * `backend/app/tasks.py:1845-1854` and `:1011-1013`):
 *
 *   - `flush_telemetry_stream` -> `bulk_create(..., ignore_conflicts=True)`
 *     compiles to `ON CONFLICT DO NOTHING`, so a telemetry write that arrives
 *     second is SILENTLY DISCARDED.
 *   - `flush_counters_to_pg` -> `update_or_create(interaction_type='view',
 *     defaults={'watch_time_ms': 0, ...})` OVERWRITES, and hardcodes
 *     `watch_time_ms: 0`.
 *
 * So a clip that receives both is left with one of them, and the survivor is
 * whichever landed second-in-order-of-merge. A false skip therefore
 * **permanently destroys the honest telemetry for that clip** — not "makes it
 * stale", WRONG, and nothing will ever revise it. Whichever number reaches
 * `recommendation.py:124` as `comp_weight` is 30 % of the ranking composite,
 * and the write is async and silent, so no error ever surfaces. That is the
 * same argument `interactionGuard.ts` makes for itself, one layer up: there is
 * no production signal to fall back on, so if these tests do not catch it,
 * nothing will.
 *
 * `nowMs` is ALWAYS a parameter. `Date.now()` is never called here, so the
 * whole file is exercised with plain integers and a chosen origin, with no fake
 * timers and no renderer.
 *
 * ===========================================================================
 * THE TWO SUPPRESSION FLAGS ARE INDEPENDENT, AND THAT IS THE POINT
 * ===========================================================================
 *   1. `skipSuppressedClipIds` — per clip, set when a skip is EMITTED (not
 *      when it resolves). A skip permanently bars telemetry for that clip.
 *   2. `telemetrySuppressed` — global, set by the first DPDP §9 403. A minor's
 *      refusal is a property of the ACCOUNT (`is_minor` is written at
 *      registration and mutated by no endpoint) and the gate runs before the
 *      clip lookup (`backend/app/views/interactions.py:158-166`), so a minor
 *      gets 403 even for a clip that does not exist. Nothing can clear it.
 *
 * Neither one suppresses a SKIP. `toggle-like` and `register-skip` are
 * deliberately open to minors ("Likes and skips are NOT blocked: they are
 * explicit user actions rather than passive tracking" —
 * `backend/app/views/interactions.py:154-157`), so a 403'd telemetry session
 * must keep reporting intent.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The floor between two `log-telemetry` heartbeats, enforced HERE and not by
 * the caller's timer.
 *
 * A caller that re-arms on every 500 ms store tick has built a 500 ms timer,
 * not a 5 s heartbeat: `telemetry: 60/min` (`backend/EchoFlow/settings.py:889`)
 * is 120/min at that cadence, so the session 429s after ~30 s of playback and
 * every subsequent flush is refused. `interactions.ts:254-261` records the same
 * arithmetic.
 *
 * **This is a request-rate floor, not a per-clip quality measure.** It is
 * therefore SESSION-scoped rather than per-clip, and the MANDATORY flush points
 * (`onClipChanged`, `onPaused`, `onEnteredBackground`, `drainForUnmount`)
 * bypass it. A 2 s clip produces no heartbeat at all and still reports, through
 * its clip-switch flush; gating those on a rate would lose real data to protect
 * a budget.
 *
 * 5 s is the plan's value (`docs/mobile-rebuild-plan.md:606, :761`); the web
 * client ships 6 s (`frontend/src/stores/player.tsx:134`). Both are safe —
 * 12/min vs 10/min against 60/min — and 5 s is the tighter of the two, so it is
 * the one worth pinning. Asserted as a literal in the test so a change fails
 * there rather than silently redefining "a heartbeat".
 */
export const TELEMETRY_INTERVAL_MS = 5_000;

/**
 * How many emitted-but-unresolved samples one session may hold, oldest first.
 *
 * **`queue` holds samples the reducer has decided to EMIT and has not yet seen
 * an `onSendResult` for.** It is not a send-ahead buffer: every sample in it
 * was handed to the caller in a `pending` array on the call that produced it.
 * Two things depend on that reading:
 *
 *  - `onSendResult` needs to remove a sample from somewhere, and the only place
 *    it can be is the unresolved set.
 *  - A second heartbeat for a clip that already has one in flight is DROPPED
 *    (see `emitTelemetry`), so the queue can never hold two samples for the
 *    same `(clipId, 'telemetry')`. What it CAN hold is one sample per
 *    `(clipId, channel)` across many clips — a user swiping fast with a dead
 *    network.
 *
 * **Why 8.** The consumer drains `stream:interaction.events` every 10 s and
 * keeps the LAST payload per `(user, clip, action_type)` within that window
 * (`CELERY_BEAT_SCHEDULE['flush-telemetry-stream'].schedule = 10.0`,
 * `coalesce_telemetry_latest`, `backend/app/tasks.py:53-98`). Anything that has
 * not reached the stream inside one window is already superseded by a later
 * heartbeat, so it has no value beyond the in-band case. Eight slots covers
 * roughly 4 s of aggressive swiping (~2 clips/s) with headroom, bounds the
 * session's memory to a fixed array, and bounds how much a 429 has to throw
 * away. Beyond 8 the oldest is shed: it is the sample most likely to be
 * already superseded, and shedding the newest would discard the measurement the
 * user is still making.
 */
export const MAX_PENDING_SAMPLES = 8;

/**
 * Why a candidate sample was not emitted, or was thrown away.
 *
 * Carried as a `Record` of counters rather than a one-shot return value
 * because the caller wants to LOG the reason, and a per-session tally is both
 * more useful and strictly more information than a single string. Rule 1 exists
 * precisely so that a drop is explainable after the fact.
 */
export type TelemetryDropReason =
  // --- telemetry channel -----------------------------------------------------
  /** A sample for this `(clipId, 'telemetry')` is already in flight. Rule 1. */
  | 'in-flight'
  /** `nowMs < lastEmitAt + TELEMETRY_INTERVAL_MS`. Rule 10. */
  | 'interval-floor'
  /** The claim would be 0, and the server records 0 as a real 0.0 sample. Rule 8. */
  | 'zero-watch'
  /** A skip has already been emitted for this clip. Rule 2. */
  | 'skip-suppressed'
  /** The DPDP §9 latch is set; telemetry is off for the whole account. Rule 3. */
  | 'minor-latched'
  /** There is no clip on the session, so there is nothing to report. */
  | 'no-clip'
  // --- skip channel ----------------------------------------------------------
  /** A skip for this clip has already been emitted. A second would double-count. */
  | 'skip-already-emitted'
  /** `shouldRegisterSkip` said `not-user-initiated` (auto-advance, unmount). */
  | 'skip-not-user-initiated'
  /** `shouldRegisterSkip` said `completed` — progress >= 0.9 of the position. */
  | 'skip-completed'
  /** `shouldRegisterSkip` said `unknown-duration`. The client must not guess. */
  | 'skip-unknown-duration'
  /** `shouldRegisterSkip` said `too-short` — the claim would be 0 ms. */
  | 'skip-too-short'
  // --- queue -----------------------------------------------------------------
  /** The queue was over `MAX_PENDING_SAMPLES`; the oldest was shed. Rule 4. */
  | 'queue-overflow'
  /** A 429. The failed sample plus the oldest survivor were shed. Rule 4. */
  | 'rate-limited'
  /** The send failed. Never retried, by decision. Rule 5. */
  | 'send-failed';

/**
 * Every reason, so the tests can assert the counter record is complete and a
 * new reason cannot be added without a test noticing the shape moved.
 */
export const TELEMETRY_DROP_REASONS: readonly TelemetryDropReason[] = [
  'in-flight',
  'interval-floor',
  'zero-watch',
  'skip-suppressed',
  'minor-latched',
  'no-clip',
  'skip-already-emitted',
  'skip-not-user-initiated',
  'skip-completed',
  'skip-unknown-duration',
  'skip-too-short',
  'queue-overflow',
  'rate-limited',
  'send-failed',
] as const;

/** Every counter at zero. Total by construction, so adding a reason is a type error. */
export function emptyDropCounts(): Record<TelemetryDropReason, number> {
  const counts = {} as Record<TelemetryDropReason, number>;
  for (const reason of TELEMETRY_DROP_REASONS) counts[reason] = 0;
  return counts;
}

export type TelemetryCounters = {
  /** Samples emitted per channel. Counted at EMIT, not at resolve. */
  emitted: { telemetry: number; skip: number };
  /** Why samples were not emitted, or were thrown away after being emitted. */
  dropped: Record<TelemetryDropReason, number>;
};

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * `value` as a usable clock reading, or null.
 *
 * RESTATED, not imported: `interactionGuard.ts:92-97` keeps `usableClock`
 * module-private, and that file is not mine to edit. `playOverlayVisibility.ts`
 * sets the in-repo precedent for restating a cross-module predicate rather than
 * exporting it for one caller, and the two copies are compared against each
 * other in the test file so they cannot drift apart silently.
 *
 * `>= 0` rather than `> 0`, for `interactionGuard.ts`'s reason: 0 is a
 * legitimate epoch a test can hand us and a monotonic wall clock can produce
 * after a device reset.
 */
function clock(value: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The `(clipId, channel)` identity of an in-flight request.
 *
 * Injectivity does not depend on the clip id's contents: the channel is a fixed
 * two-character prefix, so two different `(clipId, channel)` pairs cannot
 * produce the same string whatever the ids contain.
 */
function inFlightKey(clipId: string, channel: TelemetryChannel): string {
  return `${channel}:${clipId}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which server endpoint a sample goes to. Also the second half of the
 * in-flight identity and of the §6.2 collision: both channels write the same
 * `UserInteraction` row.
 */
export type TelemetryChannel = 'telemetry' | 'skip';

/**
 * One outbound measurement, built at EVENT time and never re-derived.
 *
 * The fields are deliberately non-overlapping and the shapes differ, so a
 * caller cannot confuse them by spreading one into the other. The numbers
 * themselves come from `reportableWatchedMs` / `shouldRegisterSkip`, which are
 * the only two places a claim is allowed to be computed.
 */
export type TelemetrySample =
  | { kind: 'telemetry'; clipId: string; watchTimeMs: number }
  | { kind: 'skip'; clipId: string; listenDurationMs: number; reelPositionMs: number };

/**
 * What the caller did with a sample, mapped onto a `SendResult`.
 *
 * `isTelemetryRefusedForMinor(err)` (`endpoints/interactions.ts:303-306`) is the
 * only producer of `'refused-minor'`, and its docstring is emphatic that it
 * must only be fed an error caught around `logTelemetry` — it matches ANY 403,
 * and a playback-token 403 ("unavailable/removed") is not the minor refusal.
 *
 * **The identity is `(clipId, channel)`, not a synthetic request id**, because
 * that is precisely the key under which at most one request can be outstanding
 * (rule 1). A counter would work and would be one more field the caller has to
 * thread through a `map`; the sample the caller was handed already carries the
 * two fields this needs.
 */
export type SendResult =
  | { ok: true; clipId: string; channel: TelemetryChannel }
  | { ok: false; clipId: string; channel: TelemetryChannel; kind: SendFailureKind };

/** The four ways a send can fail. All four are terminal — see `onSendResult`. */
export type SendFailureKind = 'refused-minor' | 'rate-limited' | 'offline' | 'other';

/** The immutable machine. Every field is described; nothing is derived implicitly. */
export type TelemetrySession = {
  /**
   * The clip the accumulator describes, or null before the first
   * `onClipChanged`. Set by `onClipChanged` ONLY, which is what makes a tick
   * naming a different clip a switch rather than a mix.
   */
  clipId: string | null;

  /**
   * `interactionGuard`'s accumulator, verbatim. Not re-implemented and not
   * wrapped: the delta-not-position rule, the `MAX_TICK_CREDIT_MS` cap and the
   * `playing: false` branch are all load-bearing there and a second copy would
   * be a second definition of "watch time".
   */
  watch: WatchAccumulator;

  /**
   * The two lengths the cap needs, carried on the session so the flush points
   * (clip change, pause, background, unmount) can cap without the caller
   * re-supplying them — and, more importantly, so the cap is applied to the
   * clip the sample was BUILT for rather than to whatever the player reports
   * now. `reportableWatchedMs`'s own docstring calls the missing `clamp01` the
   * thing that hides an over-run; the wrong length is the same failure by
   * another route.
   *
   * CLEARED on every clip change: a stale element duration would cap the next
   * clip's claim against the previous clip's length. Within a clip it is
   * MERGED, not replaced — see `mergeDurations`, because the alternative loses
   * the cap silently.
   */
  durations: DurationHint;

  /**
   * Emitted, unresolved samples, OLDEST FIRST. See `MAX_PENDING_SAMPLES` for
   * what "unresolved" means and why it is the right place to bound.
   */
  queue: readonly TelemetrySample[];

  /** `(clipId, channel)` keys with a request outstanding. Rule 1. */
  inFlight: ReadonlySet<string>;

  /**
   * Clips for which a skip has been EMITTED. Not "resolved" — the moment the
   * reducer decides to send one, telemetry for that clip is barred for the rest
   * of the session, because the skip may land first and win the row.
   *
   * A set, not a boolean: a feed session touches many clips, and a single
   * `telemetrySuppressedForLastClip` flag would bar telemetry for the wrong
   * clip on every switch.
   */
  skipSuppressedClipIds: ReadonlySet<string>;

  /**
   * The DPDP §9 latch. GLOBAL and permanent, and NOT cleared by a 429 — a later
   * rate limit is a different failure and clearing this on one would re-arm a
   * refusal the account can never satisfy.
   */
  telemetrySuppressed: boolean;

  /**
   * Caller clock at the last EMITTED telemetry sample, or null when none has
   * been emitted. Null is not the same as `nowMs`: a fresh session's floor is
   * OPEN (the first heartbeat is due immediately), whereas seeding it with
   * `createSession`'s clock would silently delay the first sample by 5 s on
   * every mount.
   *
   * Session-scoped, and moved by mandatory flushes too — they are requests.
   */
  lastEmitAt: number | null;

  /**
   * True between `onEnteredBackground` and `onResumed`. Guards the
   * double-background event (iOS delivers `inactive` then `background`, and a
   * React effect can re-enter), which would otherwise flush twice.
   */
  backgrounded: boolean;

  /** `createSession`'s clock, for the unmount log line. Null when unusable. */
  createdAtMs: number | null;

  /** Emit/drop tallies. Read-only from the caller's side; see `onSendResult`. */
  counters: TelemetryCounters;
};

/** What every emitting transition returns: the next session, and what to send. */
export type TelemetryTransition = {
  session: TelemetrySession;
  /** The samples the caller should dispatch NOW, in order. Never a retry. */
  pending: TelemetrySample[];
};

/**
 * One observation from the store's 500 ms status cadence.
 *
 * `nowMs` is NOT a field: the caller passes the clock separately, so that no
 * call site can be read as supplying a stale one from an object literal that
 * was built at a different moment. The `interactionGuard` shape carries both,
 * and having both invites exactly the C5 error this file exists to prevent.
 */
export type TelemetryObservation = {
  clipId: string;
  /** Media position in ms. Recorded by the accumulator, never credited. */
  positionMs: number;
  /** The store's explicit `playing` state, NOT "a status event arrived". C7. */
  playing: boolean;
  /**
   * The two lengths, when the caller has them.
   *
   * OMIT them to say "nothing new to report" — the session's current values are
   * kept, which is the normal shape after the first tick. Pass `null` to say
   * "known to be absent" and clear them. See `mergeDurations`.
   */
  elementDurationMs?: number | null;
  clipDurationMs?: number | null;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * A fresh session, with the 5 s floor OPEN and nothing latched.
 *
 * `nowMs` seeds the accumulator's baseline and is recorded for logging. It
 * deliberately does NOT seed `lastEmitAt`: see that field. It is accepted and
 * coerced, so `createSession(Number.NaN)` is a valid session rather than a
 * throw.
 */
export function createSession(nowMs: number): TelemetrySession {
  const now = clock(nowMs);
  return {
    clipId: null,
    // `initialAccumulator()` has `clipId: null` and no baseline; the baseline is
    // seeded because a session that is created and immediately ticked should
    // measure from the instant it was created. In practice `onClipChanged`
    // re-seeds it, so this is belt-and-braces.
    watch: { ...initialAccumulator(), lastTickAt: now },
    durations: { elementDurationMs: null, clipDurationMs: null },
    queue: [],
    inFlight: new Set<string>(),
    skipSuppressedClipIds: new Set<string>(),
    telemetrySuppressed: false,
    lastEmitAt: null,
    backgrounded: false,
    createdAtMs: now,
    counters: { emitted: { telemetry: 0, skip: 0 }, dropped: emptyDropCounts() },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Tally one drop. Returns a new session; the input is never mutated. */
function note(session: TelemetrySession, reason: TelemetryDropReason): TelemetrySession {
  return {
    ...session,
    counters: {
      ...session.counters,
      dropped: { ...session.counters.dropped, [reason]: session.counters.dropped[reason] + 1 },
    },
  };
}

/**
 * Merge an observation's lengths into the session's.
 *
 * `undefined` means "I have nothing to say on this tick" and KEEPS the previous
 * value; `null` means "known to be absent" and clears it. That distinction is
 * load-bearing, not a nicety: the element's length is read once when the source
 * loads and the feed's `duration_ms` is fixed per clip, so a caller that
 * supplied them on the first tick and then sends bare 500 ms observations — the
 * natural shape — would lose the C4 cap on every later observation, and an
 * uncapped claim is precisely what `reportableWatchedMs` exists to prevent.
 * Losing it silently is the failure: the claim would be recorded as an in-band
 * 1.0 on a 60 s clip for 200 s of listening.
 */
function mergeDurations(
  previous: DurationHint,
  observation: TelemetryObservation,
): DurationHint {
  return {
    elementDurationMs:
      observation.elementDurationMs === undefined
        ? previous.elementDurationMs
        : observation.elementDurationMs,
    clipDurationMs:
      observation.clipDurationMs === undefined ? previous.clipDurationMs : observation.clipDurationMs,
  };
}

/** Has `TELEMETRY_INTERVAL_MS` elapsed since the last emitted heartbeat? */
function intervalElapsed(lastEmitAt: number | null, nowMs: number): boolean {
  // Null means "never emitted", so the floor is open.
  if (lastEmitAt === null) return true;
  // An unusable clock on EITHER side refuses. Coercing `NaN` to a number here
  // would emit on a garbage tick; comparing directly is safe because every
  // comparison with `NaN` is false, which lands on the same answer — but it
  // would do so by accident, so it is spelled out.
  const last = clock(lastEmitAt);
  const now = clock(nowMs);
  if (last === null || now === null) return false;
  // A backwards clock (device reset, NTP correction) yields a negative delta,
  // which is below the floor. That is the correct refusal: we cannot know how
  // long it has been, and emitting would be the one case where the rate limit
  // is actually at risk.
  return now - last >= TELEMETRY_INTERVAL_MS;
}

/**
 * Drop the OLDEST `count` unresolved samples and forget that they were in
 * flight.
 *
 * The request is already on the wire and cannot be recalled, so this stops
 * TRACKING it: a later `onSendResult` for a shed sample finds nothing to
 * remove and is a no-op. If it happens to have succeeded, the row landed and
 * the data is in — all that is lost is the slot, which is the point.
 */
function shedOldest(
  session: TelemetrySession,
  count: number,
  reason: TelemetryDropReason,
): TelemetrySession {
  const shed = session.queue.slice(0, count);
  if (shed.length === 0) return session;
  const inFlight = new Set(session.inFlight);
  for (const sample of shed) inFlight.delete(inFlightKey(sample.clipId, sample.kind));
  return note({ ...session, queue: session.queue.slice(count), inFlight }, reason);
}

/**
 * Put a sample on the wire.
 *
 * Three steps in this order, and the order is the rule:
 *
 *  1. **Shed the oldest FIRST if the queue is at its bound.** Checking after the
 *     append would mean the freshly built sample can itself be the one shed,
 *     which is the worst outcome available: it is the only sample whose value
 *     the user has not already had superseded.
 *  2. **Append and mark in flight.** In flight from the instant it leaves here,
 *     not when the caller reports it has started, because the caller cannot
 *     report that atomically with the next tick arriving. That is what makes
 *     rule 1 decidable inside a pure function.
 *  3. **Move `lastEmitAt`** when this is a telemetry sample on a usable clock.
 *     Only telemetry: the 5 s floor exists for the `telemetry: 60/min` scope,
 *     and `interaction: 60/min` governs skips separately.
 */
function emit(
  session: TelemetrySession,
  sample: TelemetrySample,
  nowMs: number,
): TelemetryTransition {
  const shedded =
    session.queue.length >= MAX_PENDING_SAMPLES ? shedOldest(session, 1, 'queue-overflow') : session;
  const now = clock(nowMs);
  const isTelemetry = sample.kind === 'telemetry';
  return {
    session: {
      ...shedded,
      queue: [...shedded.queue, sample],
      inFlight: new Set(shedded.inFlight).add(inFlightKey(sample.clipId, sample.kind)),
      lastEmitAt: isTelemetry && now !== null ? now : shedded.lastEmitAt,
      counters: {
        ...shedded.counters,
        emitted: {
          telemetry: shedded.counters.emitted.telemetry + (isTelemetry ? 1 : 0),
          skip: shedded.counters.emitted.skip + (isTelemetry ? 0 : 1),
        },
      },
    },
    pending: [sample],
  };
}

/**
 * Rule 8's gate, and the only place a telemetry claim is allowed to be refused
 * on its magnitude.
 *
 * This is `shouldRegisterSkip`'s `too-short` rule (`interactionGuard.ts:477-478`),
 * restated as a predicate because `shouldRegisterSkip` answers a different
 * question and returns nothing usable here: a COMPLETED clip is
 * `{kind: 'none', reason: 'completed'}` and still wants telemetry, so the
 * telemetry channel cannot be gated on the skip verdict. What it can share is
 * the boundary, and the boundary is the same claim: a value that
 * `reportableWatchedMs` would round to 0 is refused, and a value of 1 is
 * emitted. The test file pins the two against each other over an enumerated
 * grid, so "same reasoning" is asserted rather than asserted-about.
 *
 * Why it matters: the server has NO lower bound. `InteractionTelemetrySerializer
 * .watch_time_ms` is `min_value=0` with no `max_value` question to ask, and
 * `_completion_rate(0, clip)` is `0.0` — not `None` — so a zero IS recorded as
 * a real sample. Natural completion is the most common event in a feed, so a
 * client that emits zeros systematically deflates a 30 %-of-ranking metric on
 * exactly the events it should be learning most from.
 */
function isReportableClaim(watchTimeMs: number): boolean {
  return Number.isFinite(watchTimeMs) && watchTimeMs > 0;
}

/**
 * The telemetry emit path. Every refusal lives here, in one ordered list.
 *
 * `mandatory` marks the flush points — clip change, pause, background, unmount
 * — which are the only places a flush is REQUIRED (see `onClipChanged`), and
 * which therefore bypass the 5 s rate floor. They do NOT bypass the other four
 * gates, and the distinction matters: a mandatory flush is a demand to stop
 * losing data, not a licence to write a zero or to re-enter a clip a skip has
 * already claimed.
 */
function emitTelemetry(
  session: TelemetrySession,
  nowMs: number,
  options: { mandatory: boolean },
): TelemetryTransition {
  const clipId = session.clipId;
  if (clipId === null) return { session: note(session, 'no-clip'), pending: [] };

  // Order: the cheap latches first, then the rate, then the value.
  //
  // `minor-latched` before `skip-suppressed` because a 403 is the stronger and
  // more actionable fact: it means the whole account's telemetry signal is off,
  // and a log line that says "skip-suppressed" for every remaining clip would
  // hide that for the rest of the session.
  if (session.telemetrySuppressed) return { session: note(session, 'minor-latched'), pending: [] };
  if (session.skipSuppressedClipIds.has(clipId)) {
    return { session: note(session, 'skip-suppressed'), pending: [] };
  }
  // Rule 1. A second heartbeat for a clip whose first is unresolved is DROPPED,
  // not queued. The consumer's coalescer keeps the LAST payload per
  // `(user, clip, action_type)` per 10 s window (`coalesce_telemetry_latest`,
  // `backend/app/tasks.py:53-98`), so a queued second sample inside one window
  // is guaranteed to be discarded by the server — it would cost a round trip,
  // spend `telemetry: 60/min` budget, and give the earlier sample a second
  // writer to lose against.
  if (session.inFlight.has(inFlightKey(clipId, 'telemetry'))) {
    return { session: note(session, 'in-flight'), pending: [] };
  }

  if (!options.mandatory && !intervalElapsed(session.lastEmitAt, nowMs)) {
    return { session: note(session, 'interval-floor'), pending: [] };
  }

  // Capped at `min(elementDurationMs, clip.duration_ms)` BEFORE it is compared
  // to zero, so the check is on the number that would actually be sent. A cap
  // of 0 cannot happen (both lengths unknown returns the raw total), which is
  // why a 0 here can only mean the accumulator never ran.
  const watchTimeMs = reportableWatchedMs(session.watch, session.durations);
  if (!isReportableClaim(watchTimeMs)) {
    return { session: note(session, 'zero-watch'), pending: [] };
  }

  return emit(session, { kind: 'telemetry', clipId, watchTimeMs }, nowMs);
}

/**
 * The `reason` half of `shouldRegisterSkip`'s refusal arm, extracted rather than
 * written out: `SkipDecision` is a union and only the `'none'` member carries a
 * `reason`, so `SkipDecision['reason']` does not compile and a hand-written
 * union of the four strings could drift from `interactionGuard.ts` silently.
 */
type SkipRefusal = Extract<SkipDecision, { kind: 'none' }>['reason'];

/** Map `shouldRegisterSkip`'s refusal onto a drop reason, so it is loggable. */
function skipRefusalReason(reason: SkipRefusal): TelemetryDropReason {
  switch (reason) {
    case 'completed':
      return 'skip-completed';
    case 'not-user-initiated':
      return 'skip-not-user-initiated';
    case 'unknown-duration':
      return 'skip-unknown-duration';
    case 'too-short':
      return 'skip-too-short';
    default:
      return 'skip-not-user-initiated';
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * RULE 7 — the clip switch, and the only place a flush is MANDATORY.
 *
 * `loadClip` in `store/player.ts:470-490` zeroes `currentTime` and moves
 * `playingClipId` in a SINGLE `setState`. So by the time a caller notices the
 * clip has changed, the outgoing clip's measurement is already gone, and an
 * `await` between noticing and reading would read the NEW clip's state. This
 * function therefore returns `pending` **synchronously**, built from the
 * accumulator as it stood BEFORE the switch, and the sample names the OUTGOING
 * clip with the OUTGOING clip's watch time. That is C5 + C6 from
 * `docs/mobile/04-interaction-contract.md` implemented as a value rather than as
 * a convention: there is nothing to get wrong later because there is no later.
 *
 * ## The same-clip case is a no-op flush
 * `loadClip` only runs on a change, so a same-id call is a caller error. It is
 * answered with a re-baseline and NO flush, because flushing here would bypass
 * the 5 s floor on every call and a re-render that called it in a loop would
 * turn the 5 s heartbeat into an unbounded request stream — the exact 429 storm
 * rule 4 exists to prevent. `resetAccumulator` (not `startClip`) is used so the
 * accumulated watch time survives a same-id call: zeroing it would destroy an
 * honest measurement to defend against a bug the caller has to fix anyway.
 */
export function onClipChanged(
  session: TelemetrySession,
  clipId: string,
  nowMs: number,
): TelemetryTransition {
  if (session.clipId === clipId) {
    return {
      session: { ...session, watch: resetAccumulator(session.watch, nowMs) },
      pending: [],
    };
  }

  // The outgoing clip's flush, BEFORE the switch. `clipId === null` means there
  // is no outgoing clip, not a clip with nothing to say.
  const flushed: TelemetryTransition =
    session.clipId === null
      ? { session: note(session, 'no-clip'), pending: [] }
      : emitTelemetry(session, nowMs, { mandatory: true });

  return {
    session: {
      ...flushed.session,
      clipId,
      // `startClip`, not `resetAccumulator`: a total and atomic discard, which
      // is the only way to rule out a fresh `watchedMs` with a stale baseline
      // crediting the whole swipe. See `interactionGuard.ts:229-248`.
      watch: startClip(flushed.session.watch, clipId, nowMs),
      // The previous clip's lengths would cap THIS clip's claim against the
      // wrong length — `reportableWatchedMs`'s stale-element case, arrived at
      // from the other direction.
      durations: { elementDurationMs: null, clipDurationMs: null },
    },
    pending: flushed.pending,
  };
}

/**
 * A heartbeat candidate. The 500 ms store tick lands here, ten times per
 * interval.
 *
 * Three refusals, in order, and each is a different bug:
 *
 *  1. **A foreign `clipId` is a switch.** Routed to `onClipChanged` so there is
 *     ONE place that changes `clipId` and one place that flushes. Refusing
 *     instead would leave the caller accumulating the new clip's time against
 *     the old clip, which is the two-clip sample this file exists to prevent.
 *  2. **`playing: false` emits nothing.** The accumulator has just moved its
 *     baseline and credited zero, so a heartbeat here would re-send the
 *     previous number under a fresh timestamp — and would spend budget doing
 *     it. `onPaused` is the flush point for a pause; this is not.
 *  3. **Everything else** is `emitTelemetry`'s list, including the 5 s floor
 *     (rule 10). The floor is here and not in the caller's timer because a
 *     caller that re-arms on every store tick has built a 500 ms timer.
 */
export function onTick(
  session: TelemetrySession,
  observation: TelemetryObservation,
  nowMs: number,
): TelemetryTransition {
  const { clipId } = observation;
  const durations = mergeDurations(session.durations, observation);

  if (session.clipId !== clipId) {
    // The switch path clears `durations`, so re-apply this observation's
    // lengths AFTER it rather than before, or the new clip starts out with the
    // previous clip's length — the failure `onClipChanged` just fixed.
    const switched = onClipChanged(session, clipId, nowMs);
    return { session: { ...switched.session, durations }, pending: switched.pending };
  }

  const folded: TelemetrySession = {
    ...session,
    watch: observe(session.watch, {
      clipId,
      positionMs: observation.positionMs,
      nowMs,
      playing: observation.playing,
    }),
    durations,
  };

  if (!observation.playing) {
    // Not a drop, so no `note()`: the accumulator simply moved its baseline and
    // credited nothing, which is the correct result and not a lost sample. A
    // heartbeat here would re-send the PREVIOUS number under a fresh timestamp
    // and spend budget doing it. `onPaused` is the flush point for a pause.
    return { session: folded, pending: [] };
  }

  return emitTelemetry(folded, nowMs, { mandatory: false });
}

/**
 * A seek. No emission, ever: a seek is a discontinuity, not a flush point, and
 * it credits nothing (`onSeek` in `interactionGuard.ts` moves the baseline
 * without crediting). Its whole job here is to update the POSITION and
 * re-baseline promptly, before the next 500 ms tick can measure across the
 * discontinuity.
 *
 * Returns a bare session rather than a transition: a seek that produced a sample
 * would be a seek that could be defeated by a fast scrub, which is the ranking
 * exploit `interactionGuard.ts:24-42` documents.
 */
export function onSeeked(
  session: TelemetrySession,
  seek: { clipId: string; positionMs: number },
  nowMs: number,
): TelemetrySession {
  if (session.clipId !== seek.clipId) {
    // Same shape as a tick naming a foreign clip. No flush is possible: this
    // entry point returns a session, so the caller learns nothing to send. The
    // correct caller calls `onClipChanged` first; a seek that names a new clip
    // is a missed flush, not a silent one, because the accumulator is still
    // reset and the next switch will flush whatever is left.
    return { ...session, clipId: seek.clipId, watch: startClip(session.watch, seek.clipId, nowMs) };
  }
  return { ...session, watch: onSeek(session.watch, { ...seek, nowMs }) };
}

/**
 * A pause. A MANDATORY flush, because a pause is one of the two moments the
 * brief names (pause / skip) and it is the last one: after it the player keeps
 * reporting status on iOS but credits nothing, so the watch time earned so far
 * is the last chance to report it.
 *
 * The final fold is `playing: false` on purpose: it moves the baseline and
 * credits zero, so the pause interval itself can never be credited, while the
 * watch time already accumulated stays.
 *
 * A pause naming a foreign clip routes to `onClipChanged`, for the same reason a
 * tick does.
 */
export function onPaused(
  session: TelemetrySession,
  input: { clipId: string; positionMs: number },
  nowMs: number,
): TelemetryTransition {
  if (session.clipId !== input.clipId) return onClipChanged(session, input.clipId, nowMs);

  const paused: TelemetrySession = {
    ...session,
    watch: observe(session.watch, {
      clipId: input.clipId,
      positionMs: input.positionMs,
      nowMs,
      playing: false,
    }),
  };
  return emitTelemetry(paused, nowMs, { mandatory: true });
}

/**
 * RULE 6 — background: flush ONCE, then re-baseline with no credit.
 *
 * iOS suspends timers in the background, so no tick of any kind arrives while
 * the app is away, and on return the native player still reports `playing:
 * true` — from its point of view the audio never stopped. The `playing: false`
 * branch in `observe` therefore NEVER runs across a background gap, which is
 * why `resetAccumulator` exists and why it is called here rather than relied on
 * downstream: without it the first tick after resume collects a full
 * `MAX_TICK_CREDIT_MS` for a gap of any length at all. With a 5-minute gap
 * that is 1 000 ms of fabricated watch time; without the per-tick cap it would
 * be 300 000 ms, a perfect 1.0 on a 60 s clip.
 *
 * The flush is mandatory because the app may never come back; the re-baseline
 * happens even if the flush was refused, so a 403'd or skip-suppressed session
 * still cannot bank the gap.
 *
 * **Idempotent while already backgrounded.** iOS delivers `inactive` and then
 * `background`, and a React effect can re-enter; without this guard each
 * delivery is a mandatory flush and the in-flight rule would have to absorb
 * them. The re-baseline still runs, so a repeated event cannot leave a stale
 * baseline behind.
 */
export function onEnteredBackground(
  session: TelemetrySession,
  nowMs: number,
): TelemetryTransition {
  const flushed: TelemetryTransition =
    session.backgrounded || session.clipId === null
      ? { session: note(session, 'no-clip'), pending: [] }
      : emitTelemetry(session, nowMs, { mandatory: true });

  return {
    session: {
      ...flushed.session,
      backgrounded: true,
      watch: resetAccumulator(flushed.session.watch, nowMs),
    },
    pending: flushed.pending,
  };
}

/**
 * Resume. Re-baseline, NO credit, and — unlike the background path — no flush:
 * the background entry already flushed everything the accumulator held, so
 * flushing again would report the same number twice.
 *
 * The credit is zero for the same reason it is zero in `resetAccumulator`: the
 * player still says `playing: true`, so nothing downstream will distinguish
 * "five minutes of listening" from "five minutes of a locked phone".
 */
export function onResumed(session: TelemetrySession, nowMs: number): TelemetrySession {
  return { ...session, backgrounded: false, watch: resetAccumulator(session.watch, nowMs) };
}

/**
 * A clip was abandoned. THE ONLY entry point that emits a skip, and the only
 * one that can bar telemetry for a clip.
 *
 * The decision is `shouldRegisterSkip`, imported rather than re-derived, because
 * that function's whole argument is about intent versus progress and this file
 * has no way to add to it. `userInitiated` is the caller's fact, not ours:
 * auto-advance passes `false` and produces nothing, which is what stops every
 * natural completion in the session from counting as an abandonment.
 *
 * ## What is deliberately NOT emitted alongside the skip
 * A telemetry sample. Sending both is the §6.2 collision, and the two writers
 * have opposite conflict semantics, so one of them is destroyed. A skip
 * therefore bars telemetry for this clip for the rest of the session, via
 * `skipSuppressedClipIds`. The reverse is NOT true: telemetry does not bar a
 * later skip, because the skip is the more truthful statement of what the user
 * did (they left early) and suppressing it would lose the intent signal to
 * protect a quantity.
 *
 * ## The residual race, stated rather than hidden
 * If a telemetry sample for this clip is already IN FLIGHT, it cannot be
 * recalled, and the two can still land in either order. The exposure is one
 * request round trip, and the alternative — withholding the skip until the
 * telemetry resolves — would delay the intent signal by a network timeout on
 * every swipe and would still not prevent the collision when the user swipes
 * faster than the network. Accepted, bounded, and not hidden.
 */
export function onClipAbandoned(
  session: TelemetrySession,
  input: {
    clipId: string;
    positionMs: number;
    durationMs: number;
    userInitiated: boolean;
    clipDurationMs?: number | null;
  },
  nowMs: number,
): TelemetryTransition {
  const decision = shouldRegisterSkip({
    positionMs: input.positionMs,
    durationMs: input.durationMs,
    watchTimeMs: reportableWatchedMs(session.watch, session.durations),
    userInitiated: input.userInitiated,
    clipId: input.clipId,
    clipDurationMs: input.clipDurationMs,
  });

  if (decision.kind !== 'skip') {
    return { session: note(session, skipRefusalReason(decision.reason)), pending: [] };
  }

  // A second skip for one clip is impossible by construction rather than by a
  // check further down: the latch is set on EMIT, and the latch is also what
  // makes the second call unreachable. `record_skip` increments through a blind
  // `INCRBY` (`services/counter_store.py:234`) and there is no idempotency key
  // on the endpoint, so a duplicate skip DOUBLE-COUNTS a 30 %-of-ranking
  // signal. This is why there is no in-flight check on the skip channel: the
  // latch makes it unreachable, and adding one would imply it was reachable.
  if (session.skipSuppressedClipIds.has(input.clipId)) {
    return { session: note(session, 'skip-already-emitted'), pending: [] };
  }

  const latched: TelemetrySession = {
    ...session,
    skipSuppressedClipIds: new Set(session.skipSuppressedClipIds).add(input.clipId),
  };

  return emit(
    latched,
    {
      kind: 'skip',
      clipId: input.clipId,
      listenDurationMs: decision.listenDurationMs,
      reelPositionMs: decision.reelPositionMs,
    },
    nowMs,
  );
}

/**
 * Resolve one send. THE ONLY place a failure is handled, and no failure is
 * ever retried.
 *
 * ## Why neither channel retries — a decision, not an oversight
 *
 * **Telemetry.** The `'view'` row is write-once per `(user, clip)` anyway
 * (`unique_together` at `models.py:269` + `bulk_create(ignore_conflicts=True)`),
 * so a retry of a sample whose 202 was never seen is `ON CONFLICT DO NOTHING`:
 * a round trip and a slice of the `telemetry: 60/min` budget for a guaranteed
 * no-op. Worse, it is not even reliably a no-op — if the first attempt committed
 * and a SKIP was meanwhile registered, the retry can win the row and pin a
 * `watch_time_ms` the user has already contradicted.
 *
 * **Skip.** `record_skip` increments a counter through a blind `INCRBY`
 * (`services/counter_store.py:234`) and materialises the completion sample with
 * unconditional `update_or_create` (`backend/app/tasks.py:1845-1854`). There is
 * no idempotency key, so a retry DOUBLE-COUNTS — strictly worse than losing the
 * sample, and a permanent error in a 30 %-of-ranking metric.
 *
 * So the two channels are asymmetric in cost and identical in policy: both are
 * fire-and-forget, and the session trades a lost sample for the absence of a
 * storm. `log-telemetry` is a write-only analytics signal; losing one costs one
 * 5-second window.
 *
 * ## The 429 branch
 * Drops the failed sample (it is simply not re-queued) AND sheds the oldest
 * survivor. Two samples can go, and that is intentional: a 429 means the account
 * is at the `telemetry: 60/min` ceiling, and every sample still in the queue is
 * one that will also be refused. Relieving pressure by one is not relief.
 *
 * ## What a 429 must NOT do
 * Clear `telemetrySuppressed`. The DPDP §9 latch is a property of the account
 * and is not a retryable condition; a rate limit arriving afterwards is a
 * different failure, and letting it clear the latch would re-arm a refusal this
 * account can never satisfy — turning one honest 403 into an endless 403/429
 * alternation that spends the account's whole telemetry budget.
 */
export function onSendResult(
  session: TelemetrySession,
  result: SendResult,
): TelemetrySession {
  const key = inFlightKey(result.clipId, result.channel);
  const inFlight = new Set(session.inFlight);
  const hadKey = inFlight.delete(key);
  const queue = session.queue.filter(
    (sample) =>
      !(sample.clipId === result.clipId && sample.kind === result.channel),
  );
  const resolved: TelemetrySession =
    hadKey || queue.length !== session.queue.length
      ? { ...session, queue, inFlight }
      : session;

  if (result.ok) return resolved;

  // The refusal is only meaningful for the telemetry channel — `logTelemetry` is
  // the only action in `interactions.ts` that can return 403, and
  // `isTelemetryRefusedForMinor` must only be fed errors from it. Gating on the
  // channel is belt-and-braces for a caller who wires it up wrong, and it means
  // a mis-wired skip failure cannot silently disable the account's telemetry.
  if (result.kind === 'refused-minor' && result.channel === 'telemetry') {
    return note({ ...resolved, telemetrySuppressed: true }, 'send-failed');
  }

  const failed = note(resolved, 'send-failed');
  if (result.kind !== 'rate-limited') return failed;

  // Shed the oldest survivor on top of the failure that is already recorded.
  // `shedOldest` clears the key it drops, so a later `onSendResult` for it finds
  // nothing and is a no-op.
  return shedOldest(failed, 1, 'rate-limited');
}

/**
 * RULE 7's sibling — the last flush before the session goes away.
 *
 * There is no `nowMs` parameter, and the reason is that none is needed: this is
 * a MANDATORY flush, so the only use of a clock here would be to move
 * `lastEmitAt`, which cannot matter in a session that is ending. It is passed
 * as `NaN` internally so the shared `emitTelemetry` path stays single-sourced,
 * and `NaN` is a value the interval arithmetic already refuses.
 *
 * ## What it does NOT do: re-hand the queue
 * Samples in `queue` were already handed to the caller in a `pending` array on
 * the call that produced them. Re-returning them would be a RETRY, which rule 5
 * forbids on both channels and which would double-count a skip outright. There
 * is also no mechanism to un-send a request, so "draining" them could only
 * ever mean re-issuing them. The name says "drain what has not been reported";
 * the docstring says what that is.
 */
export function drainForUnmount(session: TelemetrySession): TelemetryTransition {
  if (session.clipId === null) return { session: note(session, 'no-clip'), pending: [] };
  return emitTelemetry(session, Number.NaN, { mandatory: true });
}
