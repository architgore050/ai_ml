import { AppState, type AppStateStatus } from 'react-native';
import { useEffect, useRef } from 'react';

import {
  isTelemetryRefusedForMinor,
  logTelemetry,
  registerSkip,
} from '../api/endpoints/interactions';
import {
  createSession,
  drainForUnmount,
  onClipAbandoned,
  onClipChanged,
  onEnteredBackground,
  onResumed,
  onSendResult,
  onTick,
  type SendFailureKind,
  type SendResult,
  type TelemetryChannel,
  type TelemetryObservation,
  type TelemetrySample,
  type TelemetrySession,
  type TelemetryTransition,
} from '../lib/telemetrySession';
import { secondsToMs, usePlayerStore, type PlayerState } from '../store/player';

/**
 * React binding for `lib/telemetrySession`.
 *
 * ===========================================================================
 * WHAT IS ALREADY SOLVED AND MUST NOT BE RE-DERIVED HERE
 * ===========================================================================
 * Every decision — when a heartbeat is due, whether a claim is reportable,
 * whether a transition is a skip, what a 429 costs, what a 403 latches — lives
 * in `lib/telemetrySession.ts` (109 tests) and `lib/interactionGuard.ts` (116).
 * This file contributes the four things a pure reducer cannot know:
 *
 *   1. WHERE the clip identity comes from (`playingClipId`).
 *   2. WHEN a tick happens (the store's 500 ms `updateInterval`, not a timer).
 *   3. WHEN the session is torn down (`AppState`, unmount).
 *   4. HOW a rejected request is turned into a `SendResult`.
 *
 * ===========================================================================
 * IDENTITY: `playingClipId`, AND ONLY `playingClipId`
 * ===========================================================================
 * `loadClip` moves `playingClipId` and zeroes `currentTime` in ONE `setState`
 * (`store/player.ts:477-490`), so those two can never disagree with each other.
 * The screen's `activeClipId` CAN disagree with both: `loadClip` runs only after
 * the token resolves and after the 1000 ms inter-reel pause
 * (`app/(tabs)/index.tsx:237-248`), so for that whole window `currentTime` is
 * still the PREVIOUS clip's position.
 *
 * A heartbeat keyed on the screen's active clip therefore reads the old
 * position and attributes it to the new clip. With clip A at 280 s accumulated
 * and clip B 10 s long, `min(280000, 10000) = 10000` is a perfect 1.0 completion
 * on a 10 s clip the user watched for 0 s — plus a `'view'` row, which the feed
 * filter then excludes for 30 days. `onClipChanged` builds the outgoing
 * sample's value and its id in the same synchronous step, so subscribing to the
 * store is not a preference: it is what makes that sample correct.
 *
 * The corollary, and the reason the check below is at SEND time: **no path in
 * the app clears `playingClipId` except `loadClip` and `reset()`**. The feed's
 * `stop` arm calls `pause()`, which leaves `playingClipId` pointing at an
 * evicted clip, frozen. A check captured when the listener was armed would
 * therefore be answering a question about a moment that has already passed.
 *
 * ===========================================================================
 * TICKS: THE STORE'S CADENCE, NEVER A TIMER OF OUR OWN
 * ===========================================================================
 * `setInterval(5000, …)` re-armed by every 500 ms store change is a 500 ms
 * timer, and `telemetry` is 60/min (`backend/EchoFlow/settings.py:889`) — the
 * session would 429 within ~30 s of playback and every later flush would be
 * refused. `TELEMETRY_INTERVAL_MS` is enforced inside `onTick` for exactly that
 * reason; this file's only job is to call it once per store change.
 *
 * ===========================================================================
 * FLUSH POINTS AND WHAT IS DELIBERATELY NOT ONE
 * ===========================================================================
 * Wired: clip change, background, unmount, abandonment. Each of those returns
 * its `pending` array **synchronously**, and each is followed by
 * `commit()`, which writes the new session back BEFORE anything is dispatched.
 * An `await` between reading the session and writing it back would read the
 * store's post-switch state and lose the sample that already existed.
 *
 * NOT wired: `onPaused`. It is a mandatory flush in the library and it is
 * correct — but the store does not clear `onPaused`'s `watchedMs`, so a pause
 * flush followed by the clip-change flush 1000 ms later emits the SAME number
 * twice as two separate requests. The clip-change flush already covers every
 * transition that ends a clip, and losing one 5-second window is a smaller
 * defect than double-reporting a measurement that is 30% of the ranking
 * composite. Revisit with an explicit "paused" emission policy, not by adding a
 * second mandatory flush.
 */

// ---------------------------------------------------------------------------
// The abandonment handle
// ---------------------------------------------------------------------------

/**
 * What a screen reports when it moves on from a clip.
 *
 * Structurally identical to `lib/handsFreeAdvance.ts`'s `AdvanceInfo`, restated
 * rather than imported: that file belongs to another change in flight, and a
 * compile-time dependency on it would let a rename there break the mount point.
 * The same shape means the feed screen's existing `AdvanceReporter` payload can
 * be handed straight to `reportAdvance` with no change on either side.
 */
export type TelemetryAdvanceInfo = {
  /** The clip being left. Used ONLY as a staleness cross-check — see below. */
  fromClipId: string;
  /** The clip being moved to. Not used: identity comes from the store. */
  toClipId: string;
  /** False for an auto-advance. The whole point of reporting it at all. */
  userInitiated: boolean;
};

/**
 * How the feed tells the session that a clip is being left, and WHY.
 *
 * `telemetrySession.onClipAbandoned` is the only entry point that emits a skip,
 * and it needs a `userInitiated` fact it cannot derive. Splitting it into two
 * named methods instead of one boolean parameter is the same move
 * `logTelemetry` makes by hardcoding `action_type: 'view'`
 * (`endpoints/interactions.ts:271`): a caller cannot express the wrong value,
 * so there is no call site, no prop and no store field that reaches it. A skip
 * reported at natural completion is the original defect this whole phase
 * exists to fix.
 *
 * Neither method takes arguments. Everything it needs is read from the store at
 * call time — which is the whole point, because the caller's own idea of "the
 * current clip" is exactly the value that is stale during a swipe.
 */
export type TelemetrySkipHandle = {
  /**
   * The user moved on from this clip on purpose: a swipe, or the ±10 s skip
   * button followed by a move away. May emit one skip.
   *
   * Call it SYNCHRONOUSLY, in the same commit that changes the active clip, and
   * BEFORE the deferred `loadClip`. At that moment the store still names the
   * OUTGOING clip with its real position. Later than that and `loadClip` has
   * already zeroed `currentTime` and the position is gone.
   */
  reportUserSkip: () => void;
  /**
   * The clip ended by itself and the feed moved on. Never a skip — not because
   * of the position, which at that moment *is* the duration and therefore
   * indistinguishable from a finish, but because of the intent.
   */
  reportAutoAdvance: () => void;
  /**
   * The same decision, from a screen that already builds a structured report —
   * `lib/handsFreeAdvance.ts`'s `AdvanceInfo` shape.
   *
   * `reportUserSkip` / `reportAutoAdvance` are the better API: they cannot
   * express a wrong answer. This one exists for a caller that ALREADY has a
   * `userInitiated: boolean` in hand and would otherwise be pushed into building
   * a second channel for it. `fromClipId` is used only as a staleness check, so
   * a report for a clip the player has already left is refused rather than
   * billed to whatever is playing now.
   */
  reportAdvance: (info: TelemetryAdvanceInfo) => void;
};

/**
 * The mounted host, or null.
 *
 * Module-scoped rather than Context because `TelemetryHost` must render `null`,
 * so it cannot carry a `<Provider>`; the in-repo precedent is the listener
 * registry in `api/client.ts:128` (`onSessionExpired`), which has the same
 * shape — a process-wide registration with a process-wide unsubscriber.
 */
let installedHost: TelemetrySkipHandle | null = null;

/** Inert before mount and after unmount. Never throws, never throws later. */
const SKIP_HANDLE: TelemetrySkipHandle = {
  reportUserSkip: () => {
    installedHost?.reportUserSkip();
  },
  reportAutoAdvance: () => {
    installedHost?.reportAutoAdvance();
  },
  reportAdvance: (info: TelemetryAdvanceInfo) => {
    installedHost?.reportAdvance(info);
  },
};

/**
 * The abandonment handle, for the component that knows about navigation.
 *
 * **Read-only.** Calling this installs nothing and creates no session: a screen
 * that renders before (or entirely without) `TelemetryHost` gets a stable set
 * of no-ops rather than a second controller fighting the real one for the
 * module slot.
 *
 * The returned object is a module-level constant that resolves `installedHost`
 * at CALL time, not capture time — so a component which grabbed it during the
 * first render, before the host's mount effect had run, still reaches the live
 * controller.
 */
export function useTelemetrySkip(): TelemetrySkipHandle {
  return SKIP_HANDLE;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * `unknown` → the four `SendFailureKind` values, by duck-typing only.
 *
 * `instanceof ApiError` is deliberately avoided, for the reason
 * `isTelemetryRefusedForMinor` gives at `endpoints/interactions.ts:283-302`:
 * under Metro's module duplication, or across a jest module-mock boundary,
 * `instanceof` is a boolean that flips for reasons unrelated to the response.
 * Both `status` and the `isRateLimited` / `isNetwork` getters are read, so a
 * real `ApiError` and a structurally-identical plain object classify the same.
 *
 * `status === 0` is the offline case because that is what the client throws for
 * a transport failure (`api/client.ts:285-289`).
 *
 * The refusal is gated on `channel === 'telemetry'` because
 * `isTelemetryRefusedForMinor` matches ANY 403, and feeding it a skip failure
 * would latch an account-wide telemetry suppression off an error the server
 * never sends for `register-skip`.
 */
function classifySendFailure(err: unknown, channel: TelemetryChannel): SendFailureKind {
  if (channel === 'telemetry' && isTelemetryRefusedForMinor(err)) return 'refused-minor';
  const e = (err ?? {}) as { status?: unknown; isRateLimited?: unknown; isNetwork?: unknown };
  if (e.isRateLimited === true || e.status === 429) return 'rate-limited';
  if (e.isNetwork === true || e.status === 0) return 'offline';
  return 'other';
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/**
 * Everything the session needs from the outside world, as one object with an
 * explicit lifetime.
 *
 * A factory rather than a `useRef` bag so that "start exactly once" and "stop
 * exactly once" are structural (StrictMode double-invokes effects in dev, and a
 * hook that re-registered on every render would accumulate store subscriptions).
 */
type WatchTelemetryController = {
  start: () => void;
  stop: () => void;
};

function createController(): WatchTelemetryController {
  let session: TelemetrySession = createSession(Date.now());
  let unsubscribe: (() => void) | null = null;
  let appStateSubscription: { remove: () => void } | null = null;

  /** The OUTGOING clip's lengths, needed by the cap and by the skip decision. */
  function clipDurationMs(state: PlayerState, clipId: string): number | null {
    return state.queue.find((c) => c.id === clipId)?.duration_ms ?? null;
  }

  /**
   * One observation, in the store's units converted once, here.
   *
   * `secondsToMs` is imported from `store/player.ts` rather than inlined: that
   * module owns the seconds/milliseconds contract for the whole app
   * (`store/player.ts:25-38`), and a silent factor-of-1000 error here would
   * corrupt the completion rate with no visible symptom.
   *
   * The lengths are supplied on EVERY tick, not just the first. `undefined`
   * means "keep what you have" and is what the bare 500 ms observation would
   * send; passing `null` while `duration` is still 0 means "known absent" and
   * clears the cap — so the guard below keeps the session honest while a source
   * is still loading without wiping a length that was already learned.
   *
   * `playing` is the store's explicit state, not "a status event arrived". On
   * iOS the periodic time observer keeps firing with a frozen `currentTime`
   * through a stall (`ios/AudioPlayer.swift:474-489`) and on Android the update
   * loop stops writing entirely while not playing
   * (`BaseAudioPlayer.kt:52-69`), so a store tick is NOT evidence of progress.
   */
  function observation(state: PlayerState, clipId: string): TelemetryObservation {
    return {
      clipId,
      positionMs: secondsToMs(state.currentTime),
      playing: state.playback === 'playing',
      elementDurationMs: state.duration > 0 ? secondsToMs(state.duration) : null,
      clipDurationMs: clipDurationMs(state, clipId),
    };
  }

  /**
   * Put the samples on the wire. Fire-and-forget, and NEVER retried:
   *
   *  - telemetry is `ON CONFLICT DO NOTHING` server-side
   *    (`backend/app/tasks.py:1011-1012`), so a retry is a guaranteed no-op
   *    that still spends the `telemetry: 60/min` budget; and if a skip landed
   *    in between, the retry can win the row and pin a `watch_time_ms` the user
   *    has already contradicted.
   *  - a skip is a blind `INCRBY` (`services/counter_store.py:234`) with no
   *    idempotency key, so a retry DOUBLE-COUNTS a 30 %-of-ranking signal.
   *
   * So there is no retry, no backoff and no queue here, by design. The only
   * continuation is `onSendResult`.
   */
  function send(sample: TelemetrySample): void {
    const request: Promise<unknown> =
      sample.kind === 'telemetry'
        ? logTelemetry(sample.clipId, { watchTimeMs: sample.watchTimeMs })
        : registerSkip(sample.clipId, {
            listenDurationMs: sample.listenDurationMs,
            reelPositionMs: sample.reelPositionMs,
          });

    request.then(
      () => {
        resolve({ ok: true, clipId: sample.clipId, channel: sample.kind });
      },
      (err: unknown) => {
        resolve({
          ok: false,
          clipId: sample.clipId,
          channel: sample.kind,
          kind: classifySendFailure(err, sample.kind),
        });
      },
    );
  }

  /**
   * Fold one settled request back into the session.
   *
   * This is the ONLY continuation of a failed send. It cannot throw, it cannot
   * reach the network, and there is no branch in which it re-issues anything —
   * a 403 latches the account's telemetry off, a 429 sheds, and everything else
   * is counted and dropped. A sample that resolves after `stop()` lands on a
   * session nobody reads again, which is harmless and costs nothing.
   */
  function resolve(result: SendResult): void {
    session = onSendResult(session, result);
  }

  /**
   * THE SEND-TIME LIVENESS GATE, and the reason it lives here.
   *
   * `playingClipId` is re-read at the moment the request is issued rather than
   * captured when the sample was armed, so a session whose player has been
   * released (`reset()`, `store/player.ts:416`) cannot put a sample on the wire
   * with nothing to attribute it to. See the IDENTITY note above for why the
   * armed value could not answer that question.
   *
   * Note the consequence, because it is measured and not obvious: React runs a
   * parent's effect cleanup BEFORE its children's on unmount, and
   * `releasePlayer()` is called from `app/_layout.tsx:93` — the parent of this
   * host. So on a real app teardown `reset()` has already run by the time
   * `stop()` drains, and the final sample is correctly refused. Mounting after
   * `<PlayerHost />` does not change this; it is not what ordering guarantees.
   */
  function dispatch(pending: readonly TelemetrySample[]): void {
    if (pending.length === 0) return;
    if (usePlayerStore.getState().playingClipId === null) return;
    for (const sample of pending) send(sample);
  }

  /**
   * Adopt a transition: write the session back, THEN dispatch.
   *
   * The order is the rule. `pending` carries samples built from the session as
   * it stood BEFORE this call, so the assignment must not wait on anything —
   * and the dispatch must not await, or the next 500 ms tick could interleave
   * and the two would both believe they own the sample.
   */
  function commit(transition: TelemetryTransition): void {
    session = transition.session;
    dispatch(transition.pending);
  }

  /**
   * One store change. A different `playingClipId` is a SWITCH and takes the
   * `onClipChanged` path; anything else is a tick.
   *
   * Both branches run in the store's own notification, which is synchronous —
   * so the flush cannot be reordered behind a `setTimeout` or a promise
   * resolution that the feed screen is already scheduling.
   *
   * `playingClipId === null` returns without touching the session. Nothing has
   * been loaded yet, or the player was released; in both cases there is no clip
   * to attribute a sample to, and `onClipChanged` cannot be handed a null id
   * (`no-clip` is decided inside the library, not here).
   */
  function reconcile(state: PlayerState): void {
    const clipId = state.playingClipId;
    if (clipId === null) return;
    commit(
      session.clipId === clipId
        ? onTick(session, observation(state, clipId), Date.now())
        : onClipChanged(session, clipId, Date.now()),
    );
  }

  /**
   * A clip is being left.
   *
   * `userInitiated && !completedNaturally` is a deliberate AND, and the second
   * term is not redundant with the caller's claim. `endedForClipId` is the
   * store's own LATCH for "this clip's native completion pulse was consumed"
   * (`store/player.ts:227-236`), and it is cleared by the next `loadClip`
   * rather than by a pause — so while the feed screen is deciding what happened,
   * it still holds the truth about whether the outgoing clip finished. Without
   * the AND, a feed screen that mislabels an auto-advance as a swipe would
   * reintroduce the exact defect this phase exists to remove, and nothing else
   * in the stack would catch it: at that moment `position === duration`, so the
   * progress test reads "completed" and `shouldRegisterSkip` returns `none` for
   * a reason that has nothing to do with intent.
   */
  function reportAbandon(userInitiated: boolean): void {
    const state = usePlayerStore.getState();
    const clipId = state.playingClipId;
    if (clipId === null) return;

    commit(
      onClipAbandoned(
        session,
        {
          clipId,
          positionMs: secondsToMs(state.currentTime),
          durationMs: secondsToMs(state.duration),
          userInitiated: userInitiated && state.endedForClipId !== clipId,
          clipDurationMs: clipDurationMs(state, clipId),
        },
        Date.now(),
      ),
    );
  }

  /**
   * The `onAdvance` prop, mapped onto the same decision.
   *
   * `fromClipId` is a STALENESS CROSS-CHECK and nothing else. A screen that
   * reports a transition for a clip the player has already moved off is
   * describing a moment that has passed, and the position the store holds now
   * belongs to a different clip — which is the C5 misattribution by another
   * route. Refusing is the only safe answer, and it costs the report nothing
   * because a stale report was never worth acting on.
   *
   * `toClipId` is ignored on purpose: which clip is playing is the store's
   * claim, and a caller that could set it would be a second source of truth for
   * the one field this whole file is built around.
   */
  function reportAdvance(info: TelemetryAdvanceInfo): void {
    const clipId = usePlayerStore.getState().playingClipId;
    if (clipId === null) return;
    if (info.fromClipId !== '' && info.fromClipId !== clipId) return;
    reportAbandon(info.userInitiated);
  }

  /**
   * `AppState`. The ONLY listener in the app — `grep -rn AppState src app`
   * returns nothing, so without this the accumulator collects a background gap
   * as watch time.
   *
   * `background` flushes ONCE (the library is idempotent while already
   * backgrounded, which covers the double delivery iOS makes) and re-baselines
   * with `resetAccumulator` inside `onEnteredBackground`. `active` re-baselines
   * with NO flush and NO credit, because the entry already reported everything
   * the accumulator held and the native player still claims `playing: true` on
   * resume — which is precisely why `observe`'s `playing: false` branch cannot
   * be relied on across a gap.
   *
   * `inactive` is deliberately NOT handled. It fires first on iOS for a
   * notification banner or the control centre, while audio is still playing, so
   * treating it as background would re-baseline a session that never stopped.
   * Both platforms do deliver `background`.
   */
  function onAppStateChange(status: AppStateStatus): void {
    if (status === 'background') {
      commit(onEnteredBackground(session, Date.now()));
    } else if (status === 'active') {
      session = onResumed(session, Date.now());
    }
  }

  const handle: TelemetrySkipHandle = {
    reportUserSkip: () => reportAbandon(true),
    reportAutoAdvance: () => reportAbandon(false),
    reportAdvance,
  };

  return {
    start(): void {
      if (unsubscribe !== null) return;
      unsubscribe = usePlayerStore.subscribe((state) => {
        reconcile(state);
      });
      appStateSubscription = AppState.addEventListener('change', onAppStateChange);
      // Adopt whatever is already playing: this host mounts after the root
      // layout, and the first clip may already be loaded.
      reconcile(usePlayerStore.getState());
      installedHost = handle;
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
      appStateSubscription?.remove();
      appStateSubscription = null;
      if (installedHost === handle) installedHost = null;

      // The last flush. Synchronous and fire-and-forget: the requests either
      // land or die on their own, because a cleanup that awaits them would
      // block the unmount for as long as the network takes, and the outgoing
      // clip's `currentTime` has to be read NOW.
      commit(drainForUnmount(session));
    },
  };
}

/**
 * Own one watch-telemetry session for the app's lifetime.
 *
 * Mount it exactly once, from a component that renders `null` and outlives every
 * route — `components/TelemetryHost.tsx`.
 *
 * Returns nothing on purpose: the only thing a screen needs from it is the
 * abandonment handle, and handing that out through a second hook
 * (`useTelemetrySkip`) keeps a screen from accidentally starting a second
 * session.
 *
 * The session lives in a `useRef`, not `useState`: it changes on every 500 ms
 * tick, and re-rendering a root component twice a second to hold a value nobody
 * renders would be pure waste. Nothing here renders.
 */
export function useWatchTelemetry(): void {
  const controllerRef = useRef<WatchTelemetryController | null>(null);
  const controller =
    controllerRef.current ?? (controllerRef.current = createController());

  useEffect(() => {
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);
}
