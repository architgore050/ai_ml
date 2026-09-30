import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { logTelemetry, registerSkip } from '../../api/endpoints/interactions';
import {
  useTelemetrySkip,
  useWatchTelemetry,
  type TelemetryAdvanceInfo,
  type TelemetrySkipHandle,
} from '../useWatchTelemetry';
import { usePlayerStore, type PlayerState } from '../../store/player';
import { MAX_TICK_CREDIT_MS } from '../../lib/interactionGuard';
import { TELEMETRY_INTERVAL_MS } from '../../lib/telemetrySession';
import type { FeedClip } from '../../api/schema';

/**
 * The wiring, not the state machine.
 *
 * `lib/telemetrySession.ts` (109 tests) and `lib/interactionGuard.ts` (116) own
 * every decision about whether a sample may be sent. This file pins the four
 * things only React can get wrong, and each has a defect it prevents:
 *
 *   1. WHICH clip a sample belongs to (a perfect 1.0 completion on the wrong
 *      clip, plus a `'view'` row that excludes that clip from the feed).
 *   2. WHICH units the position is in (a missing `* 1000` corrupts 30 % of the
 *      ranking composite with no visible symptom).
 *   3. WHAT a rejected request means (a 403 latches telemetry off for the whole
 *      account, permanently; a 429 must not clear it).
 *   4. WHEN the session is torn down (an unmounted session stops reporting; a
 *      backgrounded one banks a five-minute gap as watch time).
 */

// `store/player.ts` imports `expo-audio` at module load, and the jest preset's
// failure mode for an unmocked native module is a `prototype` crash at import —
// before any assertion runs, which reads as a broken suite rather than as a
// missing mock. Mirrors `PlayerHost.test.tsx:29-50`.
jest.mock('expo-audio', () => {
  const player = {
    replace: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    release: jest.fn(),
    remove: jest.fn(),
    setActiveForLockScreen: jest.fn(),
  };
  return { createAudioPlayer: jest.fn(() => player), useAudioPlayerStatus: jest.fn(), __player: player };
});

// `isTelemetryRefusedForMinor` is left REAL. Mocking it would make the 403 latch
// test assert against a jest.fn rather than against the predicate that decides
// the refusal — and that predicate's "matches ANY 403, feed it only errors from
// logTelemetry" scope is part of what is under test here.
jest.mock('../../api/endpoints/interactions', () => {
  const actual = jest.requireActual('../../api/endpoints/interactions');
  return { ...actual, logTelemetry: jest.fn(), registerSkip: jest.fn() };
});

const mockLogTelemetry = logTelemetry as jest.MockedFunction<typeof logTelemetry>;
const mockRegisterSkip = registerSkip as jest.MockedFunction<typeof registerSkip>;

const T0 = 1_700_000_000_000;
let now = T0;

type AppStateListener = (status: AppStateStatus) => void;
let appStateListener: AppStateListener | null = null;
let appStateRemovals = 0;

/** The handle from the most recently mounted host — what a screen would hold. */
let handle: TelemetrySkipHandle | null = null;

beforeEach(() => {
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  appStateListener = null;
  appStateRemovals = 0;
  handle = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    listener: AppStateListener,
  ) => {
    if (type === 'change') appStateListener = listener;
    return { remove: () => { appStateRemovals += 1; } };
  }) as unknown as typeof AppState.addEventListener);

  usePlayerStore.getState().reset();
  mockLogTelemetry.mockReset();
  mockRegisterSkip.mockReset();
  mockLogTelemetry.mockResolvedValue({ status: 'telemetry logged' });
  mockRegisterSkip.mockResolvedValue({ status: 'skip/view registered' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

async function setStore(partial: Partial<PlayerState>): Promise<void> {
  await act(async () => {
    usePlayerStore.setState(partial);
  });
  // Drain the mock's promise chain so an `onSendResult` lands before the next
  // step. Otherwise the previous sample is still in flight and the next emit is
  // refused by rule 1, which would make every later assertion vacuous.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** `loadClip`'s half of the contract: one clip, position zeroed, playing. */
async function loadClip(clipId: string, durationSeconds = 60): Promise<void> {
  await setStore({
    playingClipId: clipId,
    currentTime: 0,
    duration: durationSeconds,
    playback: 'playing',
    endedForClipId: null,
  });
}

/**
 * One 500 ms store tick — `store/player.ts:51` builds the player with
 * `updateInterval: 500` — with the clock moving alongside the position.
 */
async function tick(positionSeconds: number, playback: PlayerState['playback'] = 'playing'): Promise<void> {
  now += 500;
  await setStore({ currentTime: positionSeconds, playback });
}

/** Advance the wall clock without a store change (the inter-reel pause). */
async function setAppState(status: AppStateStatus): Promise<void> {
  await act(async () => {
    appStateListener?.(status);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount the session and take the handle the feed screen would hold. */
async function mount() {
  const rendered = await renderHook(() => {
    useWatchTelemetry();
    return useTelemetrySkip();
  });
  handle = rendered.result.current;
  return rendered;
}

const skip = (): void => {
  if (!handle) throw new Error('no telemetry host mounted');
  handle.reportUserSkip();
};

const advance = (): void => {
  if (!handle) throw new Error('no telemetry host mounted');
  handle.reportAutoAdvance();
};

/** The feed screen's structured report, straight from its own decision. */
const advanceWith = (info: TelemetryAdvanceInfo): void => {
  if (!handle) throw new Error('no telemetry host mounted');
  handle.reportAdvance(info);
};

/** The `watchTimeMs` of every `logTelemetry` call, in order. */
function sentWatchTimes(): number[] {
  return mockLogTelemetry.mock.calls.map(([, input]) => input.watchTimeMs);
}

/** `apiFetch` builds a network failure as `{ status: 0, isNetwork: true }`. */
const networkFailure = (): Error => Object.assign(new Error('Network request failed'), { status: 0, isNetwork: true });
const apiFailure = (status: number): Error => Object.assign(new Error('API error'), { status });

/** A feed clip, so the store's `queue` can disagree with `playingClipId`. */
const feedClip = (id: string, durationMs?: number): FeedClip => ({
  id,
  title: `clip ${id}`,
  creator_name: 'creator',
  creator_id: 1,
  category: 'music',
  hls_playlist_url: `https://media.example/hls/${id}/master.m3u8`,
  likes: 0,
  shares: 0,
  skips: 0,
  comment_count: 0,
  is_liked: false,
  ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
});

// ---------------------------------------------------------------------------

describe('heartbeat cadence', () => {
  it('sends the first heartbeat immediately, holds the 5 s floor, and sends at the boundary', async () => {
    // The floor is a floor BETWEEN heartbeats: `lastEmitAt === null` on a fresh
    // session means the first one is due now. Seeding it with the session's own
    // clock would delay the first sample by 5 s on every mount.
    await mount();
    await loadClip('clip-a');

    await tick(0.5);
    expect(sentWatchTimes()).toEqual([500]);

    // Every tick up to 4.5 s after that emit is refused by rule 10.
    for (let i = 1; i <= 9; i += 1) {
      await tick(0.5 + i * 0.5);
    }
    expect(Date.now() - (T0 + 500)).toBe(4500);
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    // Exactly TELEMETRY_INTERVAL_MS after the last emit: emitted.
    await tick(6.0);
    expect(Date.now() - (T0 + 500)).toBe(TELEMETRY_INTERVAL_MS);
    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
  });

  it('does not credit a non-playing tick, however stale the position is', async () => {
    // On iOS the periodic time observer keeps firing with a frozen `currentTime`
    // through a stall (`ios/AudioPlayer.swift:474-489`) and on Android the update
    // loop stops writing entirely while not playing
    // (`BaseAudioPlayer.kt:52-69`). A store tick is not proof of progress.
    await mount();
    await loadClip('clip-a');

    for (let i = 0; i < 20; i += 1) {
      await tick(30, 'paused');
    }
    expect(mockLogTelemetry).not.toHaveBeenCalled();

    // The first playing tick afterwards can claim only its own interval, not the
    // twenty frozen ones.
    await tick(30.5);
    expect(sentWatchTimes()).toEqual([500]);
  });

  it('does not emit while buffering', async () => {
    // `playbackStateFrom` ranks `isBuffering` above `playing`
    // (`store/player.ts:277`), so a stall arrives here as a non-playing state and
    // a stall is not watch time.
    await mount();
    await loadClip('clip-a');
    for (let i = 1; i <= 20; i += 1) {
      await tick(i * 0.5, 'buffering');
    }
    expect(mockLogTelemetry).not.toHaveBeenCalled();
  });
});

describe('the clip switch', () => {
  it('flushes the OUTGOING clip id with the OUTGOING clip watch time', async () => {
    // THE rule. `loadClip` zeroes `currentTime` and moves `playingClipId` in one
    // `setState`, so anything keyed on the screen's active clip reads the
    // PREVIOUS clip's position. `min(280000, 10000)` would be a perfect 1.0
    // completion on a 10 s clip watched for 0 s — and the `'view'` row that
    // creates excludes that clip from the feed for 30 days.
    await mount();
    await loadClip('clip-a');
    await tick(0.5); // emits 500: the floor is open on a fresh session
    await tick(1.0);
    await tick(1.5); // accumulated 1500, still under the floor

    // The switch: clip-b's id arrives with clip-a's position still in the store,
    // exactly as `loadClip` leaves it.
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });

    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });
    expect(mockLogTelemetry.mock.calls.some(([clipId]) => clipId === 'clip-b')).toBe(false);
  });

  it('keeps accumulating the outgoing clip through the inter-reel pause', async () => {
    // The 1000 ms window between "the screen moved on" and "the new clip is
    // loaded" (`app/(tabs)/index.tsx:237-248`) is exactly when `playingClipId`
    // still names the OLD clip while the SCREEN'S active clip is already the new
    // one — so the store is seeded here with both, disagreeing, and the queue and
    // index the feed screen derives that "active clip" from. Ticks in this window
    // arrive with a frozen position and `playing: false`, and they must keep
    // crediting clip-a. A heartbeat keyed on `queue[activeIndex]` would bill
    // clip-a's 1000 ms to clip-b, whose own claim is then capped at 10 000 ms and
    // reads as a completion the user never watched to.
    await mount();
    await setStore({ queue: [feedClip('clip-a'), feedClip('clip-b')] });
    await loadClip('clip-a');
    await tick(0.5); // emits 500: the floor is open on a fresh session
    await tick(1.0); // accumulated 1000, still under the floor

    // The screen has moved on: index 1, queue length 2. The player has not.
    await setStore({ activeIndex: 1, queue: [feedClip('clip-a'), feedClip('clip-b')] });

    // The feed stops the outgoing clip NOW and defers the load by 1000 ms. The
    // native player keeps reporting status throughout.
    for (let i = 0; i < 4; i += 1) {
      now += 250;
      await setStore({ playback: 'paused' });
    }
    // A pause is not one of the mandatory flush points, so nothing was sent…
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);
    // …and nothing accrued to the clip the screen is looking at.
    expect(mockLogTelemetry.mock.calls.some(([clipId]) => clipId === 'clip-b')).toBe(false);

    // …and the deferred load flushes the OLD clip with the OLD clip's watch time.
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1000 });
  });

  it('caps a claim at the server length as well as the element length', async () => {
    // The element can report a longer length than the server's own measure (a
    // rounded encoder duration), so `reportableWatchedMs` takes `min` of both.
    // A caller that supplies only the element over-reports.
    await mount();
    await setStore({ queue: [feedClip('clip-a', 3_000)] });
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 20; i += 1) {
      await tick(i * 0.5);
    }
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });

    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 3000 });
  });
});

describe('units', () => {
  it('sends accumulated watch time in milliseconds, never the 12.5 s position', async () => {
    await mount();
    await loadClip('clip-a');
    // Ten seconds of ticks on a clip the user has seeked ahead to 12.5 s. The
    // claim is the QUANTITY (10000). Sending the position is the defect the old
    // web client shipped: a seek then reads as a near-complete view.
    for (let i = 1; i <= 20; i += 1) {
      now += 500;
      await setStore({ currentTime: 12.5 });
    }
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });

    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 10_000 });
  });

  it('converts the skip position from seconds to milliseconds', async () => {
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 20; i += 1) {
      await tick(12.5);
    }
    skip();

    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-a', {
      listenDurationMs: 10_000,
      reelPositionMs: 12_500,
    });
  });
});

describe('backgrounding', () => {
  it('flushes on background and credits at most one tick across a five-minute gap', async () => {
    await mount();
    await loadClip('clip-a');
    await tick(0.5); // emits 500
    await tick(1.0); // accumulated 1000

    await setAppState('background');
    // Mandatory: the app may never come back, so what the accumulator holds is
    // reported now.
    expect(sentWatchTimes()).toEqual([500, 1000]);

    // Five minutes away. No tick of any kind arrives, and on resume the native
    // player still reports `playing: true` — from its point of view the audio
    // never stopped — so `observe`'s non-playing branch cannot save us. Only the
    // re-baseline does: without it the first tick back would bank 300 000 ms.
    now += 5 * 60_000;
    await setAppState('active');

    now += 500;
    await setStore({ currentTime: 1.5 });
    expect(sentWatchTimes()).toEqual([500, 1000, 1500]);
    expect(sentWatchTimes()[2]).toBeLessThanOrEqual(1000 + MAX_TICK_CREDIT_MS);
  });

  it('flushes exactly once for a repeated background event', async () => {
    // iOS delivers `inactive` then `background`, and a React effect can
    // re-enter. `onEnteredBackground` is idempotent while already backgrounded.
    await mount();
    await loadClip('clip-a');
    await tick(0.5);
    await tick(1.0);
    await setAppState('background');
    await setAppState('background');
    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
  });
});

describe('failure classification', () => {
  it('latches telemetry off globally on a 403 and keeps sending skips', async () => {
    // `is_minor` is written at registration and mutated by no endpoint, and the
    // DPDP §9 gate runs before the clip lookup, so this 403 can never be
    // satisfied later. Skips are deliberately open to minors — explicit user
    // actions rather than passive tracking — so they must keep flowing.
    mockLogTelemetry.mockRejectedValue(apiFailure(403));
    await mount();
    await loadClip('clip-a');
    await tick(0.5);
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 30; i += 1) {
      await tick(0.5 + i * 0.5);
    }
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    // A DIFFERENT clip is latched off too: the suppression is global, where a
    // skip suppression is per-clip. Every heartbeat the session would otherwise
    // have emitted for clip-b is refused.
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 60 });
    for (let i = 1; i <= 20; i += 1) {
      await tick(i * 0.5);
    }
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    // The skip on the SAME clip-b still goes out, with its own watch time.
    skip();
    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);
    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-b', {
      listenDurationMs: 10_000,
      reelPositionMs: 10_000,
    });
  });

  it('does not let a 429 clear the 403 latch', async () => {
    // `telemetrySuppressed` is a property of the ACCOUNT. A rate limit arriving
    // afterwards is a different failure, and letting it clear the latch would
    // re-arm a refusal this account can never satisfy.
    mockLogTelemetry.mockRejectedValue(apiFailure(403));
    mockRegisterSkip.mockRejectedValue(apiFailure(429));
    await mount();
    await loadClip('clip-a');
    await tick(0.5); // telemetry #1 -> 403 -> latch
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    skip(); // skip #1 -> 429
    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);

    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });
    for (let i = 1; i <= 12; i += 1) {
      await tick(0.5 + i * 0.5);
    }
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);
  });

  it('classifies a transport failure as offline, without latching or retrying', async () => {
    // A transport failure is not a refusal: the session must stay usable. The
    // 403 case above is the contrast — there the second heartbeat never goes out.
    mockLogTelemetry.mockRejectedValue(networkFailure());
    await mount();
    await loadClip('clip-a');
    await tick(0.5); // emits 500 -> offline

    // A 5 s gap, then one tick: eligible again, and a second request.
    now += TELEMETRY_INTERVAL_MS;
    await setStore({ currentTime: 5 });

    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
    // 500 credited, plus one tick capped at MAX_TICK_CREDIT_MS.
    expect(sentWatchTimes()).toEqual([500, 500 + MAX_TICK_CREDIT_MS]);
  });

  it('never retries, on either channel', async () => {
    // Telemetry is `ON CONFLICT DO NOTHING` server-side
    // (`backend/app/tasks.py:1011-1012`), so a retry is pure cost against a
    // 60/min budget; a skip is a blind `INCRBY` with no idempotency key
    // (`services/counter_store.py:234`), so a retry DOUBLE-COUNTS a
    // 30 %-of-ranking signal.
    mockLogTelemetry.mockRejectedValue(networkFailure());
    mockRegisterSkip.mockRejectedValue(apiFailure(500));
    await mount();
    await loadClip('clip-a');
    await tick(0.5);
    for (let i = 1; i <= 20; i += 1) {
      await tick(0.5 + i * 0.5);
    }
    // 10.5 s of playback is exactly three eligible heartbeats. A retry on any of
    // the three failures would make six or nine.
    expect(mockLogTelemetry).toHaveBeenCalledTimes(3);
    expect(sentWatchTimes()).toEqual([500, 5500, 10_500]);

    skip();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);
  });
});

describe('abandonment', () => {
  it('reports a user swipe as a skip with the accumulated watch time', async () => {
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 6; i += 1) {
      await tick(i * 0.5);
    }
    skip();

    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);
    // listenDurationMs is the accumulated quantity and reelPositionMs the media
    // position. They are expected to disagree after a seek, and a caller that
    // sets them equal has reintroduced the original defect.
    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-a', {
      listenDurationMs: 3000,
      reelPositionMs: 3000,
    });
  });

  it('reports NO skip for an auto-advance, however the caller phrases it', async () => {
    // Two ways in, because this is the original defect. `reportAutoAdvance` is
    // the intended spelling. `reportUserSkip` on a clip the store has latched as
    // finished is the mislabelling that `endedForClipId` has to catch: at that
    // moment `position === duration`, so the progress test reads "completed" for
    // a reason that has nothing to do with intent, and a clip paused at 60 % would
    // sail through the same path as a genuine abandon.
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    // Re-latch as finished at a position that is NOT the duration, so the only
    // thing standing between this and a reported skip is the intent.
    await setStore({ currentTime: 20, playback: 'ended', endedForClipId: 'clip-a' });

    advance();
    skip();
    skip();
    expect(mockRegisterSkip).not.toHaveBeenCalled();
  });

  it('emits at most one skip for one clip, however many times it is called', async () => {
    // `record_skip` increments a counter through a blind `INCRBY`; a double count
    // is a permanent error in a 30 %-of-ranking metric.
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    skip();
    skip();
    skip();
    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);
  });

  it('reports the skip under the outgoing clip even after the new one is loading', async () => {
    // The feed pauses the outgoing clip, then defers `loadClip` by 1000 ms. If
    // the report were made after that deferral the position would already be
    // zeroed, so the sample would claim nothing and the skip would be refused as
    // `too-short`.
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    skip();
    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-a', expect.objectContaining({ reelPositionMs: 2000 }));

    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });
    expect(mockRegisterSkip).toHaveBeenCalledTimes(1);
  });

  it('accepts the feed screen\'s own structured report shape', async () => {
    // `lib/handsFreeAdvance.ts` already produces `{ fromClipId, toClipId,
    // userInitiated }` for its auto-advance decision, so this is the seam that
    // lets that payload be handed over unchanged rather than re-derived at a
    // second call site.
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    advanceWith({ fromClipId: 'clip-a', toClipId: 'clip-b', userInitiated: true });

    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-a', {
      listenDurationMs: 2000,
      reelPositionMs: 2000,
    });
  });

  it('refuses a structured report for a clip the player has already left', async () => {
    // `fromClipId` is a staleness check, not decoration. A screen reporting a
    // transition for a clip that is no longer playing would bill the CURRENT
    // clip's position to it — the C5 misattribution by another route.
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    await setStore({ playingClipId: 'clip-b', currentTime: 0, duration: 30 });

    advanceWith({ fromClipId: 'clip-a', toClipId: 'clip-b', userInitiated: true });

    expect(mockRegisterSkip).not.toHaveBeenCalled();
  });

  it('reports no skip for a structured auto-advance report', async () => {
    await mount();
    await loadClip('clip-a', 60);
    for (let i = 1; i <= 4; i += 1) {
      await tick(i * 0.5);
    }
    await setStore({ currentTime: 20, playback: 'ended', endedForClipId: 'clip-a' });

    advanceWith({ fromClipId: 'clip-a', toClipId: 'clip-b', userInitiated: false });

    expect(mockRegisterSkip).not.toHaveBeenCalled();
  });

  it('is inert before a host is mounted', async () => {
    const { result } = await renderHook(() => useTelemetrySkip());
    expect(() => result.current.reportUserSkip()).not.toThrow();
    expect(() => result.current.reportAutoAdvance()).not.toThrow();
    expect(() =>
      result.current.reportAdvance({ fromClipId: 'a', toClipId: 'b', userInitiated: true }),
    ).not.toThrow();
    expect(mockRegisterSkip).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('flushes what is pending on unmount', async () => {
    const { unmount } = await mount();
    await loadClip('clip-a');
    await tick(0.5); // emits 500
    await tick(1.0);
    await tick(1.5); // accumulated 1500, still under the floor

    await unmount();

    // A mandatory flush: the 5 s rate floor does not apply to losing data.
    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });
  });

  it('does not await the requests it fires on unmount', async () => {
    // A cleanup that awaited its network I/O would block the unmount for as long
    // as the network takes, and the outgoing clip's `currentTime` has to be read
    // now. This request never settles, so the test passing at all IS the
    // assertion that the teardown did not hang on it.
    const { unmount } = await mount();
    await loadClip('clip-a');
    await tick(0.5); // resolves normally
    await tick(1.0);
    await tick(1.5);

    mockLogTelemetry.mockReturnValue(new Promise(() => {}));
    await unmount();

    expect(mockLogTelemetry).toHaveBeenCalledTimes(2);
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });
  });

  it('sends nothing on unmount once the player has been released', async () => {
    // The send-time liveness gate. `playingClipId` is cleared by `loadClip` and by
    // `reset()` and by nothing else, so it is re-read when the request is issued
    // rather than captured when the sample was armed — the feed's `stop` arm
    // leaves it pointing at an evicted clip, frozen, and an armed value would be
    // answering about a moment that has already passed.
    const { unmount } = await mount();
    await loadClip('clip-a');
    await tick(0.5);
    await tick(1.0);
    await tick(1.5);
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      usePlayerStore.getState().reset();
    });
    await unmount();

    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);
  });

  it('removes its AppState listener', async () => {
    const { unmount } = await mount();
    expect(appStateListener).not.toBeNull();
    await unmount();
    expect(appStateRemovals).toBe(1);
  });
});
