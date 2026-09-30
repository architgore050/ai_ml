/**
 * SeekProgressBar.
 *
 * ## What is real and what is doubled
 * `expo-audio` is mocked at the module boundary (the native edge) exactly as
 * `store/__tests__/player.test.ts` does, so everything between the component
 * and the native `seekTo` is the shipped code: `seekToSeconds` ->
 * `getPlayerOrNull()` -> `seekTo`, and `clampSeekTime` as the one source of the
 * seek bounds. Assertions land on the fake player's `seekTo`, never on a spy of
 * this component's internals — a spy would pass even if the component stopped
 * calling the store at all.
 *
 * ## `touchHistory` is part of the event, and it is not optional
 * `PanResponder` does NOT compute gesture geometry from `nativeEvent`. It reads
 * `event.touchHistory` — `currentCentroidX(event.touchHistory)` in
 * `onResponderGrant` (`PanResponder.js:460`) and
 * `_updateGestureStateOnMove(gestureState, event.touchHistory)` in
 * `onResponderMove` (`:502`). RNTL passes the payload straight through and never
 * builds a touch history, so a `{nativeEvent: {locationX}}` payload throws
 * `Cannot read properties of undefined (reading 'touchBank')` inside RN's own
 * code before the component's handler is reached.
 *
 * So `touch()` builds a real one: a single-active-touch bank whose
 * `previousPageX` is the position before this event. That is not scaffolding —
 * it is what makes `gestureState.dx` the same number the device would produce,
 * so the drag-vs-tap and horizontal-lock decisions are exercised for real
 * instead of being handed a fabricated `dx`.
 *
 * ## Animated styles are read through `getAnimatedStyle`, never `props.style`
 * `props.style` is frozen at the initial value, so an assertion written against
 * it is a FALSE PASS: it would read the mount-time width while time had in fact
 * advanced past it. Every animated assertion here goes through
 * `getAnimatedStyle`, with fake timers installed in `beforeEach` BEFORE
 * `render` — reanimated's frame loop schedules its first frame through
 * `requestAnimationFrame`, which fake timers replace, and installing them after
 * render leaves the loop on real rAF where `advanceTimersByTime` moves nothing.
 * `src/lib/__tests__/reanimatedHarness.test.tsx` is the reference for that.
 *
 * STATIC styles (track height, glow, hit-box height) are read through
 * `StyleSheet.flatten(props.style)`, which is legitimate: they are not animated
 * and therefore not frozen.
 */

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Platform, processColor, StyleSheet } from 'react-native';
import { createAudioPlayer } from 'expo-audio';
import { getAnimatedStyle } from 'react-native-reanimated';

import {
  DIRECTION_SLOP,
  FILL_EASING,
  FILL_EASING_STOPS,
  SAMPLE_INTERVAL_MS,
  SeekProgressBar,
  TRACK_HEIGHT,
  TRACK_RADIUS,
  fractionFromLocation,
  progressFraction,
  resolveAxis,
  seekTargetFor,
} from '../SeekProgressBar';
import { ClipTransport } from '../ClipTransport';
import { formatTime } from '../../../lib/formatTime';
import { SKIP_SECONDS } from '../../../lib/skipSeconds';
import { accessibility, accent, surface } from '../../../design/tokens';
import { categoryColor } from '../../../design/categories';
import { MIN_TOUCH_TARGET } from '../../ui/primitives';
import {
  getPlayer,
  releasePlayer,
  usePlayerStore,
  type PlayerState,
} from '../../../store/player';
import * as playerModule from '../../../store/player';

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));

type FakePlayer = {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  remove: jest.Mock;
  release: jest.Mock;
};

const CLIP_ID = 'clip-a';
const OTHER_CLIP_ID = 'clip-b';
/** An arbitrary but exact bar width, so x -> fraction arithmetic is checkable. */
const BAR_WIDTH = 300;
/** 60 s. Divisible by 300, so every quarter of the bar is a whole 15 s. */
const DURATION = 60;
/** 15 s of 60 s = 25%. The non-zero target the fill animations need. */
const QUARTER = 15;

let fakePlayer: FakePlayer;
/** Monotonic event clock. `dt` in `_updateGestureStateOnMove` must be non-zero. */
let touchSeq = 0;

const makeFakePlayer = (): FakePlayer => ({
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  remove: jest.fn(),
  release: jest.fn(),
});

/** Write the store the way `syncFromPlayer` would, bypassing its coercion. */
const seedStore = (o: {
  currentTime?: number;
  duration?: number;
  playing?: boolean;
  playback?: string;
  playingClipId?: string | null;
}) => {
  usePlayerStore.setState({
    currentTime: o.currentTime ?? 0,
    duration: o.duration ?? 0,
    playback: (o.playback ?? (o.playing ? 'playing' : 'paused')) as never,
    playingClipId: o.playingClipId === undefined ? CLIP_ID : o.playingClipId,
  });
};

/** Store write on a mounted tree, so React is not updated outside `act`. */
const setStore = async (patch: Partial<PlayerState>) => {
  await act(async () => {
    usePlayerStore.setState(patch);
  });
};

/** One finger. The bank is keyed by this, exactly as the renderer's is. */
const TOUCH_ID = 1;

/**
 * One synthetic touch event, carrying the `touchHistory` `PanResponder` needs.
 *
 * The shape is the renderer's own, not an invention: `ResponderTouchHistoryStore`
 * keeps a FLAT array of touch records indexed by `identifier`
 * (`ReactFabric-dev.js:876`, `touchBank[identifier]`), sets
 * `indexOfSingleActiveTouch` to `touches[0].identifier` (`:16212`), and on a
 * move copies the record's previous `currentPageX` into `previousPageX`
 * (`recordTouchMove`, `:908`). Getting this wrong is silent rather than loud:
 * `centroidDimension` finds no active touch and returns `noCentroid` (-1), so
 * `gestureState.dx` stays 0 and every drag-vs-tap decision in the component
 * reads as "the finger never moved".
 *
 * So `previousX` is the position before this event, which is what makes the
 * accumulated `dx` real. Omit it for a tap, where no movement has happened.
 *
 * The `y` pair was added with directional claiming. A vertical drag is now the
 * behaviour under test, and `PanResponder` derives `dy` from
 * `previousPageY`/`currentPageY` by exactly the same arithmetic as `dx` — so a
 * harness with no vertical axis could only ever manufacture `dy === 0`, and
 * every "this gesture is vertical" assertion would have been satisfied by a
 * payload that cannot express the case.
 */
const touch = (
  locationX: number,
  previousX: number = locationX,
  y: number = 24,
  previousY: number = y,
) => {
  touchSeq += 1;
  const point = {
    touchActive: true,
    startPageX: previousX,
    startPageY: previousY,
    startTimeStamp: 1,
    currentPageX: locationX,
    currentPageY: y,
    currentTimeStamp: touchSeq,
    previousPageX: previousX,
    previousPageY: previousY,
    previousTimeStamp: touchSeq - 1,
  };
  const touchBank: Array<typeof point | undefined> = [];
  touchBank[TOUCH_ID] = point;
  return {
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: TOUCH_ID,
      mostRecentTimeStamp: touchSeq,
      touchBank,
    },
    nativeEvent: {
      changedTouches: [{ ...point, identifier: TOUCH_ID }],
      identifier: TOUCH_ID,
      locationX,
      locationY: y,
      pageX: locationX,
      pageY: y,
      target: TOUCH_ID,
      timestamp: touchSeq,
      touches: [{ ...point, identifier: TOUCH_ID }],
    },
  };
};

const layout = (width: number) => ({
  nativeEvent: { layout: { x: 0, y: 0, width, height: MIN_TOUCH_TARGET } },
});

/** RNTL v14's `render` is async, so the queries live on the awaited value. */
type Rendered = Awaited<ReturnType<typeof render>>;
type TestElement = ReturnType<Rendered['getByTestId']>;

/**
 * Dispatch an event straight to the handler the element carries.
 *
 * ## Why this is not just `fireEvent`
 * `fireEvent` runs every event through RNTL's authorization gate
 * (`dist/fire-event.js:34-47`, `isEventEnabled`), which is a PROXY for the
 * responder negotiation:
 *
 *     const touchStart = nearestTouchResponder?.props.onStartShouldSetResponder?.();
 *     const touchMove  = nearestTouchResponder?.props.onMoveShouldSetResponder?.();
 *     if (touchStart || touchMove) return true;
 *     return touchStart === undefined && touchMove === undefined;
 *
 * It is not event-specific, so it gates `layout` and `accessibilityAction` too.
 * Both `should*` callbacks are invoked with NO ARGS, so `resolveAxis(g.dx, g.dy)`
 * reads `0, 0` = `'none'`, and under the directional rule the bar answers `false`
 * to both — at which point the gate returns `false` and swallows everything.
 * Measured, not assumed: flipping `onStartShouldSetPanResponder` to
 * `() => false` and changing nothing else turns 13 of the 39 tests in this file
 * red with zero calls reaching `onPanResponderGrant`.
 *
 * That gate is a harness artifact, not production behaviour: on a device the
 * real negotiation always passes a live `gestureState` (PanResponder's wrapper
 * closes over it and supplies it regardless), and RN re-consults
 * `onMoveShouldSetResponder` on every move with the accumulated `dx`/`dy`. So
 * the gate must be stepped over, not fed a rigged answer.
 *
 * ## What is still real here
 * Nothing is stubbed. Payloads are the same `touchHistory` the previous harness
 * built, they go through the same `PanResponder` wrapper the `View` is given,
 * and that wrapper is what computes `dx`/`dy` from `touchHistory`
 * (`PanResponder.js:490-506` → `_updateGestureStateOnMove`). So the drag-vs-tap
 * and horizontal-vs-vertical decisions are still made from genuine accumulated
 * geometry; only RNTL's permission check is bypassed.
 *
 * Prop lookup mirrors `getEventHandlerFromProps(..., { loose: true })`: try
 * `on` + Capitalized, then the bare name.
 */
const fire = (el: TestElement, name: string, payload?: unknown) => {
  const props = el.props as Record<string, ((p?: unknown) => unknown) | undefined>;
  const prop =
    props[`on${name.charAt(0).toUpperCase()}${name.slice(1)}`] ?? props[name];
  if (typeof prop !== 'function') {
    throw new Error(`SeekProgressBar exposes no handler for "${name}"`);
  }
  // CALLED WITHOUT `act`, and that is deliberate rather than lazy.
  //
  // Every handler reached through here — the four `*ShouldSetResponder*` props,
  // the five `onResponder*` props, and the three `onTouch*` props — is a plain
  // synchronous function over refs, zustand state and Reanimated shared values.
  // None of them sets React state, so there is nothing for `act` to flush.
  //
  // Wrapping them anyway is actively harmful, and the damage is not local. RNTL's
  // `act` is `withGlobalActEnvironment(reactAct)(async () => await callback())`
  // (`dist/act.js:96-98`) — it ALWAYS takes the async path, so every call opens
  // an act scope that is closed only on a later microtask. A nine-event gesture
  // chains them faster than they close, React reports "overlapping act() calls",
  // and the leaked scope then suppresses the effects of the NEXT `render` — so
  // a later `getByTestId` finds an empty tree and the failure lands on an
  // innocent-looking query instead of on the gesture. Measured: 8 such warnings,
  // and every test after the first flick went red.
  //
  // `settle` / `frame` / `setStore` below DO use `act`, and must: those are the
  // points where Reanimated's frame loop and the store subscription actually
  // re-render, so that is where flushing belongs.
  prop(payload);
};

/**
 * TOUCH-DOWN on the responder negotiation, capture phase.
 *
 * Not optional decoration: `PanResponder._initializeGestureState` is called
 * from exactly one place on the way in — `onStartShouldSetResponderCapture`
 * when `touches.length === 1` (`PanResponder.js:432-434`) — and it is what
 * zeroes `dx`/`dy` before a sequence accumulates. Skip it and the previous
 * sequence's displacement leaks into the next one.
 */
const beginSequence = (el: TestElement, at: number, y: number = 24): void => {
  // `onStartShouldSetResponderCapture` — NOT `onResponderStartShould...`. The
  // capture handlers drop the `Responder` infix that the bubble ones carry
  // (`PanResponder.js:429` vs `:459`), while the CONFIG names the other way
  // round (`onStartShouldSetPanResponderCapture` vs `onPanResponderGrant`).
  // Both spellings are the install's, and the mismatch is worth writing down.
  fire(el, 'startShouldSetResponderCapture', touch(at, at, y, y));
};

/**
 * ONE move of the negotiation, and the bar's answer.
 *
 * Both phases, in the order the platform runs them, because the bubble answer
 * is UNREACHABLE without the capture phase:
 *
 *  - `onMoveShouldSetResponderCapture` (`PanResponder.js:442-457`) calls
 *    `_updateGestureStateOnMove(gestureState, touchHistory)` FIRST, and only
 *    then consults the config.
 *  - `onMoveShouldSetResponder` (`:424-428`) does NOT update the state at all —
 *    it passes the same closed-over object. A second `gestureState` argument
 *    handed in from outside is silently DISCARDED, and the bar then reads
 *    `resolveAxis(0, 0)` = `'none'` and declines to claim. That failure is
 *    silent and looks exactly like "the bar never claims", so this helper is the
 *    only correct way to ask.
 */
const askMove = (
  el: TestElement,
  locationX: number,
  previousX: number,
  y: number = 24,
  previousY: number = 24,
): boolean => {
  const payload = touch(locationX, previousX, y, previousY);
  // `onMoveShouldSetResponderCapture` — see `beginSequence` on the naming.
  fire(el, 'moveShouldSetResponderCapture', payload);
  const probe = (el.props as { onMoveShouldSetResponder?: (e: unknown) => boolean })
    .onMoveShouldSetResponder;
  if (typeof probe !== 'function') throw new Error('no onMoveShouldSetResponder');
  // No `act` — see `fire`. This is a read of the same ref, not a state change.
  return probe(payload) === true;
};

/**
 * A ONE-SHOT question: "given a touch that has moved `dx`/`dy`, does the bar
 * want it?" Self-contained — it initialises the sequence first, so the answer
 * depends only on the displacement asked about.
 */
const wouldClaimMove = (el: TestElement, dx: number, dy: number): boolean => {
  beginSequence(el, 0, 0);
  return askMove(el, dx, 0, dy, 0);
};

/** Fire the `onLayout` that gives the bar its width. */
const layOut = (bar: TestElement, width = BAR_WIDTH): void => {
  fire(bar, 'layout', layout(width));
};

/** Where in a touch sequence the bar took the responder, if it did. */
type Claim = { claimed: boolean; claimedAt: 'start' | 'move' | null };

/**
 * THE ARBITRATION, run the way the platform runs it, and a report on who won.
 *
 * This is the only helper that can tell the two implementations apart, and the
 * reason is worth being explicit about. "A vertical drag does not seek" passes
 * under BOTH the old and the new arbitration — under the old one the bar claimed
 * on touch-down, but `onPanResponderMove` still saw a vertical axis and
 * abandoned, so the seek did not happen either. Asserting only "no seek" would
 * therefore have been a test that passes for the wrong reason, and it would have
 * looked like proof of the fix.
 *
 * What actually differs between the two is whether a GRANT EVER HAPPENED. That
 * is not a detail: on iOS, `RCTScrollView` disables its own pan recognizer as
 * soon as a descendant is the JS responder
 * (`_shouldDisableScrollInteraction` → `handleCustomPan:`), and nothing in JS
 * can undo it. So "did the bar become the responder" IS "does the feed still
 * scroll", and that is what this reports.
 *
 * The platform's contract, as modelled here: `onStartShouldSetResponder` is
 * consulted ONCE, on touch-down, before any movement exists. If it declines,
 * `onMoveShouldSetResponder` is consulted on every move until one of them
 * agrees, and the grant lands there. The first answer wins and is never revisited.
 */
const negotiate = (bar: TestElement, deltas: Array<{ dx: number; dy: number }>): Claim => {
  if (bar.props.onStartShouldSetResponder?.() === true) {
    return { claimed: true, claimedAt: 'start' };
  }
  beginSequence(bar, 0, 0);
  let x = 0;
  let y = 0;
  for (const d of deltas) {
    const nextX = x + d.dx;
    const nextY = y + d.dy;
    if (askMove(bar, nextX, x, nextY, y)) return { claimed: true, claimedAt: 'move' };
    x = nextX;
    y = nextY;
  }
  return { claimed: false, claimedAt: null };
};

/**
 * The move displacements a flick produces, in the order the pager sees them. The
 * first is already tens of dp — a real flick never starts sub-slop — and the
 * steps grow because a flick accelerates.
 */
const flickDeltas = (dy = -120) => [
  { dx: 0, dy: dy * 0.4 },
  { dx: 0, dy: dy * 0.4 },
  { dx: 0, dy: dy * 0.2 },
];

/**
 * A STATIONARY tap: arm on touch-down, commit on touch-up, no responder event
 * anywhere.
 *
 * This is the shape a real tap now takes, and it is a DIFFERENT set of handlers
 * than the old harness used. A tap used to be `responderGrant` +
 * `responderRelease`, which was only possible because the bar claimed the touch
 * on touch-down. It no longer does, so there is no grant to give — the tap
 * commits on the direct touch channel instead.
 */
const tap = (bar: TestElement, at: number): void => {
  fire(bar, 'touchStart', touch(at));
  fire(bar, 'touchEnd', touch(at));
};

/**
 * A VERTICAL flick that begins on the bar, and therefore the feed's problem
 * rather than the bar's.
 *
 * Modelled as the platform does it: arm the tap, negotiate the moves, then
 * CANCEL — a vertical flick inside a UIScrollView is cancelled by the recognizer
 * that took it (`RCTTouchHandler.m:320-323` turns `touchesCancelled` into
 * `touchCancel`), never ended. The x is held still on purpose, so `dy` is
 * unambiguously the only axis in play.
 */
const flickUp = (bar: TestElement, at = 150, dy = -120): Claim => {
  fire(bar, 'touchStart', touch(at));
  const claim = negotiate(bar, flickDeltas(dy));
  fire(bar, 'touchCancel', touch(at, at, dy, dy));
  return claim;

};

/** Advance past the in-flight fill animation. */
const settle = async (ms = SAMPLE_INTERVAL_MS) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

/** One frame, for a direct shared-value write to reach the animated style. */
const frame = async () => {
  await act(async () => {
    jest.advanceTimersByTime(16);
  });
};

/** The fill's animated width, as a percentage of the track. */
const widthPercent = (fill: TestElement): number =>
  Number.parseFloat(String(getAnimatedStyle(fill).width ?? 'NaN'));

/** A STATIC style — not animated, so `props.style` is not frozen here. */
const barStyle = (el: TestElement): Record<string, number | string> =>
  StyleSheet.flatten(el.props.style as never) as Record<string, number | string>;

describe('SeekProgressBar', () => {
  beforeEach(() => {
    // Reanimated's first frame is scheduled through requestAnimationFrame, which
    // jest's modern fake timers replace. Installed BEFORE the first `render`.
    jest.useFakeTimers();

    // Drop the player singleton and reset the store, then materialise a fake
    // one so `seekToSeconds` has something to call. `releasePlayer` (not
    // `reset`) so the module-level `instance` slot is cleared too.
    releasePlayer();
    fakePlayer = makeFakePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(fakePlayer);
    getPlayer();
    touchSeq = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // duration === 0: width 0 AND not interactive
  // -------------------------------------------------------------------------

  describe('with no duration reported yet', () => {
    it('renders a zero-width fill rather than a NaN one', async () => {
      // `duration` is 0 until the source reports it, on BOTH platforms, so
      // `currentTime / duration` is 0/0 = NaN — and a NaN width is an INVALID
      // React Native style value, which drops the fill's style entirely rather
      // than rendering it at zero. The second assertion is the point.
      seedStore({ currentTime: 0, duration: 0 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      const w = widthPercent(getByTestId('seek-progress-fill'));
      expect(Number.isNaN(w)).toBe(false);
      expect(w).toBe(0);
    });

    it('refuses the gesture at the responder boundary', async () => {
      seedStore({ currentTime: 0, duration: 0 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');

      // Read the props directly rather than through `fireEvent`: RNTL's
      // `isEventEnabled` consults `onStartShouldSetResponder()` /
      // `onMoveShouldSetResponder()` itself (see `fire`), so a `fireEvent` here
      // would be swallowed by the HARNESS and the assertion would pass for the
      // wrong reason.
      //
      // STRENGTHENED: `onStartShouldSetResponder()` alone no longer proves
      // anything — under directional claiming it is `false` on every bar,
      // interactive or not, because claiming at touch-down is the bug being
      // fixed. The claim question now lives on `onMoveShouldSetResponder`, so
      // THAT is what has to answer false. The old assertion is kept alongside
      // it because the gate still reads it, and a future change that starts
      // claiming on start must be caught here too.
      expect(bar.props.onStartShouldSetResponder()).toBe(false);
      expect(wouldClaimMove(bar, 40, 0)).toBe(false);
      expect(bar.props.pointerEvents).toBe('none');
      expect(bar.props.accessibilityState).toEqual({ disabled: true });
    });

    it('does not seek even if the responder events are dispatched anyway', async () => {
      // Belt and braces: this holds even for a caller that dispatches past the
      // gate. On Android a seek issued while nothing is loaded is STORED and
      // applied to the next clip (`Playable.kt:31`).
      seedStore({ currentTime: 0, duration: 0 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);
      await tap(bar, 150);

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // progress clamped into [0, 1]
  // -------------------------------------------------------------------------

  describe('progress clamping', () => {
    it('clamps a currentTime past duration (Android emits the raw seek target)', async () => {
      // `BaseAudioPlayer.kt:114-122` emits `newPosition.positionMs / 1000.0`
      // with no clamp, so `currentTime > duration` really reaches the store.
      seedStore({ currentTime: 500, duration: 100 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      expect(widthPercent(getByTestId('seek-progress-fill'))).toBeCloseTo(100, 3);
    });

    it('clamps a negative currentTime to zero', async () => {
      seedStore({ currentTime: -50, duration: 100 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      expect(widthPercent(getByTestId('seek-progress-fill'))).toBeCloseTo(0, 3);
    });

    it('treats a NaN currentTime as zero (iOS merges an unguarded time.seconds)', async () => {
      seedStore({ currentTime: Number.NaN, duration: 100 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      expect(widthPercent(getByTestId('seek-progress-fill'))).toBeCloseTo(0, 3);
    });

    it('treats a non-finite duration as no duration at all', async () => {
      seedStore({ currentTime: 5, duration: Number.NaN });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      expect(widthPercent(getByTestId('seek-progress-fill'))).toBe(0);
      // STRENGTHENED — see the note in `refuses the gesture at the responder
      // boundary`: `onStartShouldSetResponder()` is `false` unconditionally
      // under directional claiming, so the interactivity question has moved to
      // `onMoveShouldSetResponder`.
      expect(getByTestId('seek-progress-bar').props.onStartShouldSetResponder()).toBe(false);
      expect(wouldClaimMove(getByTestId('seek-progress-bar'), 40, 0)).toBe(false);
    });

    it('uses the exact stored fraction in between', async () => {
      seedStore({ currentTime: QUARTER, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      await settle();

      expect(widthPercent(getByTestId('seek-progress-fill'))).toBeCloseTo(25, 3);
    });

    it('progressFraction is total: no input produces a non-finite result', () => {
      const inputs: Array<[number, number]> = [
        [0, 0],
        [Number.NaN, 10],
        [Number.NaN, Number.NaN],
        [5, 0],
        [5, Number.NaN],
        [Number.POSITIVE_INFINITY, 10],
        [-Number.POSITIVE_INFINITY, 10],
        [Number.POSITIVE_INFINITY, 0],
      ];
      for (const [t, d] of inputs) {
        const out = progressFraction(t, d);
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // x -> seconds
  // -------------------------------------------------------------------------

  describe('converting a touch to a seek', () => {
    it('converts a tap at the middle of a 300 pt bar into 30 s of a 60 s clip', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);
      await tap(bar, 150);

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
      expect(onSeekResult).toHaveBeenCalledWith({ requested: 30, target: 30 });
    });

    it('converts each fifth of the bar into the right second', async () => {
      for (const [x, seconds] of [
        [0, 0],
        [60, 12],
        [150, 30],
        [240, 48],
        [300, 60],
      ] as const) {
        seedStore({ currentTime: 0, duration: DURATION });
        const { getByTestId, unmount } = await render(<SeekProgressBar clipId={CLIP_ID} />);
        layOut(getByTestId('seek-progress-bar'));
        await tap(getByTestId('seek-progress-bar'), x);
        expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(seconds);
        fakePlayer.seekTo.mockClear();
        await unmount();
      }
    });

    it('clamps a tap beyond either end of the bar to that end', async () => {
      // A finger that leaves the bar produces a `locationX` outside [0, width]
      // (RN computes it as pageX minus the offset of the node the sequence
      // started on, which does not change), and the clamp turns that into
      // "seek to the end" — which is what the web source's own clamp does.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await tap(bar, -80);
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(0);
      fakePlayer.seekTo.mockClear();

      await tap(bar, 9999);
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(DURATION);
    });

    it('refuses to seek before the bar has been laid out', async () => {
      // No `onLayout`, so there is no honest fraction: width is 0, and
      // 150 / 0 would be Infinity.
      seedStore({ currentTime: 0, duration: DURATION });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      await tap(getByTestId('seek-progress-bar'), 150);

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(onSeekResult).toHaveBeenCalledWith(null);
    });

    it('fractionFromLocation returns null rather than dividing by an unknown width', () => {
      expect(fractionFromLocation(150, 0)).toBeNull();
      expect(fractionFromLocation(150, Number.NaN)).toBeNull();
      expect(fractionFromLocation(Number.NaN, 300)).toBeNull();
      expect(fractionFromLocation(150, 300)).toBeCloseTo(0.5, 10);
      expect(fractionFromLocation(-40, 300)).toBe(0);
      expect(fractionFromLocation(400, 300)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // ONE seek per gesture
  // -------------------------------------------------------------------------

  describe('one commit per gesture', () => {
    it('commits a single seek for a drag with many move events', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      // 40 move events, then a release. Native must be told ONCE: 40 seeks would
      // queue 40 discontinuity events in the player for one finger movement.
      const xs = Array.from({ length: 40 }, (_, i) => 4 + i * 6);
      await fire(bar, 'responderGrant', touch(xs[0] as number));
      let prev = xs[0] as number;
      for (const x of xs) {
        await fire(bar, 'responderMove', touch(x, prev));
        prev = x;
      }
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      await fire(bar, 'responderRelease', touch(prev, prev));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
    });

    it('previews the drag under the finger and lands the fill on the commit', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);
      const fill = getByTestId('seek-progress-fill');

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(150, 10));
      await frame();
      // The fill tracks the finger EXACTLY — no easing on a drag.
      expect(widthPercent(fill)).toBeCloseTo(50, 3);
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();

      await fire(bar, 'responderRelease', touch(150, 150));
      await frame();
      // Lands ON the committed position rather than easing back to it.
      expect(widthPercent(fill)).toBeCloseTo(50, 3);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('treats a sub-slop nudge as a tap, not a drag', async () => {
      // NAME UNCHANGED, SCOPE NARROWED, and the reason is worth stating.
      //
      // This used to be the only sub-slop test, and it drove
      // `responderGrant` → `responderMove` → `responderRelease`, a shape that was
      // possible solely because the bar claimed the touch on touch-down. Under
      // directional claiming a real 2 dp nudge never reaches those handlers at
      // all — it is sub-slop on both axes, so `resolveAxis` says `'none'`, the
      // bar does not claim, and the tap commits on the direct touch channel.
      // That case now lives in `a sub-slop wobble is still a tap` under the
      // arbitration block.
      //
      // What is left here, and is still worth pinning, is the GRANTED path's
      // handling of a sub-slop displacement: the preview must stay put rather
      // than chase the finger by 2 px, and the commit must still land at the
      // RELEASE position. That is a separate property from the arbitration, and
      // it is not covered by the other test.
      seedStore({ currentTime: 0, duration: DURATION });

      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      // 2 px of movement, under MIN_DRAG_SLOP. The commit is still made, and it
      // is made at the release position.
      await fire(bar, 'responderGrant', touch(148));
      await fire(bar, 'responderMove', touch(150, 148));
      await fire(bar, 'responderRelease', touch(150, 150));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('does not seek when the native side takes the touch (feed scrolling)', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(150, 10));
      await fire(bar, 'responderTerminate', touch(150, 150));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Directional claiming: a vertical drag is the FEED's, not the bar's
  // -------------------------------------------------------------------------

  describe('arbitrating a drag against the feed pager', () => {
    it('never claims the responder on touch-down, so the pager always gets the touch', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');

      // THE load-bearing assertion. Read from the prop because the prop IS the
      // contract: `onStartShouldSetResponder` is consulted exactly once, on
      // touch-down, before any movement exists, so a `true` here is
      // unconditional and no later event can undo it. On iOS that is fatal for
      // a vertical feed — `RCTScrollView._shouldDisableScrollInteraction`
      // disables the pager's own pan recognizer as soon as a DESCENDANT is the
      // JS responder, and there is no JS API to give the responder back.
      expect(bar.props.onStartShouldSetResponder()).toBe(false);

      // ...and the bar is genuinely interactive, so this is the directional rule
      // and not the `duration > 0` gate wearing the same answer.
      expect(wouldClaimMove(bar, 40, 0)).toBe(true);
    });

    it('a vertical drag starting on the bar never becomes the responder', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');

      // THE assertion that actually discriminates. Under the old arbitration
      // this returns `{ claimed: true, claimedAt: 'start' }` — the bar took the
      // touch on touch-down, which is the bug, and which on iOS is what turns
      // off the feed's own pan recognizer for that gesture.
      expect(negotiate(bar, flickDeltas())).toEqual({ claimed: false, claimedAt: null });

      // Same answer with x held still, with a much larger first jump, and with
      // the flick the other way. The direction of the flick cannot matter to a
      // vertical feed, and a slow start must not change the answer either.
      expect(negotiate(bar, flickDeltas(120))).toEqual({ claimed: false, claimedAt: null });
      expect(negotiate(bar, [{ dx: 0, dy: -400 }])).toEqual({
        claimed: false,
        claimedAt: null,
      });
    });

    it('a diagonal drag is the FEED\'s, not the bar\'s', async () => {
      // 45 degrees is a genuine ambiguity, and it is resolved conservatively.
      // In a vertically paging feed a diagonal flick is far more often someone
      // changing reel than someone scrubbing, and the two failures are not
      // symmetric: a wrong scrub is a one-off annoyance, a wrong page gesture is
      // a control that looks broken.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);

      expect(negotiate(getByTestId('seek-progress-bar'), [{ dx: 0, dy: -60 }])).toEqual({
        claimed: false,
        claimedAt: null,
      });
      // Past `DIRECTION_SLOP` and clearly sideways: now it is a scrub.
      expect(negotiate(getByTestId('seek-progress-bar'), [{ dx: 60, dy: 0 }])).toEqual({
        claimed: true,
        claimedAt: 'move',
      });
    });

    it('a vertical drag does not seek, and does not report a refusal either', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      // End-to-end guarantee on top of the arbitration assertion above. It is
      // NOT the discriminating test — it passes under the old arbitration too,
      // because the old `onPanResponderMove` also saw a vertical axis and
      // abandoned — so it is kept for the guarantee, and the negotiation
      // assertion is kept for the proof.
      expect(negotiate(bar, flickDeltas())).toEqual({ claimed: false, claimedAt: null });
      flickUp(bar);

      // No seek...
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      // ...and no "refused" either. The user never asked for a seek, so
      // `onSeekResult(null)` here would be a lie the parent could log or
      // surface; and this is the common case, not an edge — most scrolls in a
      // full-bleed feed cross this row.
      expect(onSeekResult).not.toHaveBeenCalled();
    });

    it('a vertical drag that ENDS on the bar still does not seek', async () => {
      // The nastier shape, and the one a pure `onTouchEnd` tap channel gets
      // wrong: the finger is released over the bar even though it went
      // vertically. `onTouchCancel` is the platform's own signal, so a real
      // flick never reaches `onTouchEnd` — but the arm must be revoked on the
      // MOVE too, so the row cannot be armed by a gesture that has already
      // been ruled vertical.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'touchStart', touch(150));
      beginSequence(bar, 150, 0);
      // Sub-slop on both axes: still undecided, so the tap is NOT revoked.
      expect(askMove(bar, 150, 150, -6, 0)).toBe(false);
      // 40 dp vertically: the feed's scroll, and the arm is revoked.
      expect(askMove(bar, 150, 150, -40, -6)).toBe(false);
      await fire(bar, 'touchEnd', touch(150));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('a horizontal drag claims, previews, and seeks exactly once on release', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      const bar = getByTestId('seek-progress-bar');
      const fill = getByTestId('seek-progress-fill');
      layOut(bar);

      await fire(bar, 'touchStart', touch(10));
      // The claim, and the mirror of the vertical case: the bar is NOT the
      // responder at touch-down and IS the responder after the first horizontal
      // move. `claimedAt: 'move'` is the whole point — under the old
      // arbitration this returned `'start'`, which is the bug.
      expect(negotiate(bar, [{ dx: 12, dy: 1 }])).toEqual({
        claimed: true,
        claimedAt: 'move',
      });
      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(150, 10));
      await frame();

      // Previews under the finger, and has NOT committed — a seek per move
      // would queue a discontinuity per event for one finger movement.
      expect(widthPercent(fill)).toBeCloseTo(50, 3);
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(onSeekResult).not.toHaveBeenCalled();

      await fire(bar, 'responderRelease', touch(150, 150));

      // ONCE. 150/300 of 60 s = 30 s.
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
      expect(onSeekResult).toHaveBeenCalledTimes(1);
      expect(onSeekResult).toHaveBeenCalledWith({ requested: 30, target: 30 });
    });

    it('a horizontal drag cannot also be committed by the tap channel', async () => {
      // The two channels are independent mechanisms, so they could double-commit
      // if the claim did not revoke the arm. Whichever of `touchEnd` and
      // `responderRelease` the platform delivers FIRST, the answer is one seek.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'touchStart', touch(10));
      expect(negotiate(bar, [{ dx: 30, dy: 0 }])).toEqual({ claimed: true, claimedAt: 'move' });
      await fire(bar, 'responderGrant', touch(10));
      // touchEnd FIRST, then the responder release.
      await fire(bar, 'touchEnd', touch(150));
      await fire(bar, 'responderRelease', touch(150, 150));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('a stationary tap still seeks, on the direct touch channel', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      // No responder event anywhere: the bar is not the responder for a tap, so
      // this is the only channel left. Removing it is what "claiming later"
      // would silently do to tap-to-seek.
      await tap(bar, 150);

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
      expect(onSeekResult).toHaveBeenCalledWith({ requested: 30, target: 30 });
    });

    it('a sub-slop wobble is still a tap', async () => {
      // Inside the slop on both axes the intent is genuinely undecided, and
      // `resolveAxis` says `'none'`. The bar must neither claim nor revoke the
      // tap: a 3 dp wobble is how most people actually tap, and it is the case
      // a "claim on any move" rule would break.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'touchStart', touch(148));
      expect(wouldClaimMove(bar, 3, -3)).toBe(false);
      await fire(bar, 'touchEnd', touch(150));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('refuses to seek a tap before the bar has been laid out', async () => {
      // The tap channel is a second entry point, so the `duration > 0` refusal
      // and the no-geometry refusal have to hold on it too — otherwise a tap
      // becomes a way around the Android "seek queues onto the NEXT clip" trap.
      seedStore({ currentTime: 0, duration: DURATION });
      const onSeekResult = jest.fn();
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );

      await tap(getByTestId('seek-progress-bar'), 150);

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(onSeekResult).toHaveBeenCalledWith(null);
    });

    it('a second finger disarms the tap rather than seeking on pinch', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      // PanResponder's own start capture keys on `touches.length` for the same
      // reason: with two touches the centroid is not a finger position, so a
      // position derived from it is not a place to seek to.
      const twoFingers = { ...touch(150), nativeEvent: { ...touch(150).nativeEvent, touches: [
        { ...touch(150).nativeEvent.touches[0], identifier: 1 },
        { ...touch(150).nativeEvent.touches[0], identifier: 2, pageX: 200 },
      ] } };
      await fire(bar, 'touchStart', twoFingers);
      await fire(bar, 'touchEnd', touch(150));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('a cancel disarms the tap, so a cancelled sequence seeks nothing', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'touchStart', touch(150));
      await fire(bar, 'touchCancel', touch(150));
      // A stray touchEnd after the cancel must not resurrect the arm.
      await fire(bar, 'touchEnd', touch(150));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('resolveAxis separates the three intents, and treats a diagonal as vertical', () => {
      // Below the slop on both axes: undecided, claim nothing.
      expect(resolveAxis(0, 0)).toBe('none');
      expect(resolveAxis(DIRECTION_SLOP, DIRECTION_SLOP)).toBe('none');
      // One dp over on one axis is a decision.
      expect(resolveAxis(DIRECTION_SLOP + 1, 0)).toBe('horizontal');
      expect(resolveAxis(0, DIRECTION_SLOP + 1)).toBe('vertical');
      expect(resolveAxis(0, -(DIRECTION_SLOP + 1))).toBe('vertical');
      // 45-degree cone, and the tie resolves to the FEED, not to the bar.
      expect(resolveAxis(40, -39)).toBe('horizontal');
      expect(resolveAxis(-39, 40)).toBe('vertical');
      expect(resolveAxis(30, 30)).toBe('vertical');
      // Total: nothing undecided resolves to a claim, and nothing is a claim
      // unless it is real.
      for (const [dx, dy] of [
        [Number.NaN, 0],
        [0, Number.NaN],
        [Number.POSITIVE_INFINITY, 0],
        [0, Number.NEGATIVE_INFINITY],
        [Number.NaN, Number.NaN],
      ] as const) {
        expect(resolveAxis(dx, dy)).toBe('none');
      }
    });

    it('the claim slop and the preview slop are genuinely independent', async () => {
      // Two different questions, deliberately two different numbers. 8 dp asks
      // "is this a scrub or a page flick?" and gates the claim; 3 dp asks "has
      // the finger visibly moved sideways?" and gates the preview. So there is a
      // band — between 3 and 8 dp — where the bar has CLAIMED but must not yet
      // have previewed. If the two ever collapse to one number this band
      // disappears, and the failure mode is a bar that jumps under the thumb
      // before the user has committed to a scrub.
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      const fill = getByTestId('seek-progress-fill');
      layOut(bar);

      await fire(bar, 'touchStart', touch(10));
      // 5 dp: past the preview slop (3), short of the claim slop (8).
      expect(negotiate(bar, [{ dx: 5, dy: 0 }])).toEqual({ claimed: false, claimedAt: null });
      await fire(bar, 'touchEnd', touch(15));
      fakePlayer.seekTo.mockClear();

      // 9 dp: over the claim slop, and now the drag previews.
      await fire(bar, 'touchStart', touch(10));
      expect(negotiate(bar, [{ dx: 9, dy: 0 }])).toEqual({ claimed: true, claimedAt: 'move' });
      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(19, 10));
      await frame();
      // 19/300 of a 300 pt bar = 6.3%, i.e. the finger, not the grant position.
      expect(widthPercent(fill)).toBeCloseTo(6.33, 1);
    });
  });

  // -------------------------------------------------------------------------
  // clampSeekTime -> null means REFUSE, not "seek to 0"
  // -------------------------------------------------------------------------

  describe('a null from clampSeekTime', () => {
    it('results in no seek at all', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const onSeekResult = jest.fn();
      // The control IS interactive here, so nothing else is holding the seek
      // back: the refusal is provably the null, not the duration gate.
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} onSeekResult={onSeekResult} />,
      );
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);
      // CHANGED (was `expect(bar.props.onStartShouldSetResponder()).toBe(true)`).
      // That assertion encoded the OLD arbitration: the bar claimed the touch
      // on touch-down, so "interactive" was observable there. Under directional
      // claiming the bar never claims at touch-down — that is the fix — so the
      // assertion is not merely outdated, it now asserts the BUG.
      //
      // Its purpose is preserved verbatim above it: prove nothing EXCEPT the
      // `clampSeekTime` null is holding the seek back. Under the new rule that
      // means proving the bar WOULD claim a committed horizontal scrub, which is
      // the gesture this test drives (`tap(bar, 150)`).
      expect(wouldClaimMove(bar, 20, 0)).toBe(true);

      const spy = jest.spyOn(playerModule, 'clampSeekTime').mockReturnValue(null);
      await tap(bar, 150);

      // The load-bearing assertion: NOT `seekTo(0)`.
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(onSeekResult).toHaveBeenCalledWith(null);
      spy.mockRestore();
    });

    it('still clamps through clampSeekTime rather than seeking the raw fraction', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      const spy = jest.spyOn(playerModule, 'clampSeekTime');
      await tap(bar, 150);

      // The component must not re-derive the bounds itself.
      expect(spy).toHaveBeenCalledWith(30, DURATION);
      spy.mockRestore();
    });

    it('seekTargetFor refuses on unknown geometry and clamps seconds otherwise', () => {
      expect(seekTargetFor(150, 0, DURATION)).toBeNull();
      expect(seekTargetFor(150, BAR_WIDTH, 0)).toBeNull();
      expect(seekTargetFor(150, BAR_WIDTH, DURATION)).toBe(30);
      expect(seekTargetFor(-10, BAR_WIDTH, DURATION)).toBe(0);
      expect(seekTargetFor(1e6, BAR_WIDTH, DURATION)).toBe(DURATION);
    });
  });

  // -------------------------------------------------------------------------
  // mid-gesture clip change / clip end
  // -------------------------------------------------------------------------

  describe('a clip change underneath a drag', () => {
    it('abandons the gesture when the store swaps the loaded clip', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(120, 10));

      // ONLY the store changes — the props are untouched, so no effect keyed on
      // props can save us here. The live check inside the responder handlers is
      // the only thing that can, which is what makes this test non-vacuous.
      await setStore({ playingClipId: OTHER_CLIP_ID });

      await fire(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('abandons the gesture when the clipId prop changes', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId, rerender } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(120, 10));

      await rerender(<SeekProgressBar clipId={OTHER_CLIP_ID} />);

      await fire(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('stops previewing over the new clip once the store has swapped it', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      const fill = getByTestId('seek-progress-fill');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(150, 10));
      await frame();
      expect(widthPercent(fill)).toBeCloseTo(50, 3);

      await setStore({ playingClipId: OTHER_CLIP_ID, currentTime: 0 });
      await fire(bar, 'responderMove', touch(200, 150));
      await frame();
      // The drag is dead, so the move cannot drag the thumb any further.
      expect(widthPercent(fill)).toBeCloseTo(0, 3);
    });

    it('cancels the drag when the clip finishes under the finger', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(120, 10));

      // `didJustFinish` is a ONE-tick pulse on both platforms, so the durable
      // signal is the store's latch of it into `ended`.
      await setStore({ playback: 'ended' });

      await fire(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('cancels the drag when playback errors underneath it', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(120, 10));
      await setStore({ playback: 'error' });

      await fire(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('still allows a fresh gesture on a clip that ended and was reloaded', async () => {
      // Cancelling the IN-FLIGHT drag is not the same as disabling the control:
      // a user who taps a finished clip to hear the end again must still work.
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      layOut(bar);

      await fire(bar, 'responderGrant', touch(10));
      await fire(bar, 'responderMove', touch(120, 10));
      await setStore({ playback: 'ended' });
      await fire(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();

      await tap(bar, 150);
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });
  });

  // -------------------------------------------------------------------------
  // Accessibility: the 4 px vs 44/48 dp resolution
  // -------------------------------------------------------------------------

  describe('accessibility', () => {
    it('keeps the VISUAL bar at the design 4 px and the HIT box at the floor', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);

      // The tracked design values: 4 px tall, 2 px radius, surface-container,
      // clipped. STATIC styles, so reading them through props is legitimate.
      const track = barStyle(getByTestId('seek-progress-track'));
      expect(track.height).toBe(TRACK_HEIGHT);
      expect(track.height).toBe(4);
      expect(track.borderRadius).toBe(TRACK_RADIUS);
      expect(track.borderRadius).toBe(2);
      expect(track.backgroundColor).toBe(surface.container);
      expect(surface.container).toBe('#1e2022');
      expect(track.overflow).toBe('hidden');

      // The resolution: the target is a SEPARATE, taller box. A 4 px bar fails
      // both platform floors by an order of magnitude, which is the entire
      // reason there are two boxes rather than one compromise.
      const target = barStyle(getByTestId('seek-progress-bar'));
      expect(target.minHeight).toBe(MIN_TOUCH_TARGET);
      expect(target.width).toBe('100%');

      // The floor that binds on the platform under test is met, not just the
      // other platform's. jest-expo runs as ios, so this is the 44 pt floor; the
      // Android arm is the 48 dp one and reaches this layout through the same
      // `MIN_TOUCH_TARGET` selection with no other difference in the layout.
      const floor =
        Platform.OS === 'android'
          ? accessibility.minTouchTargetAndroid
          : accessibility.minTouchTargetIOS;
      expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(floor);
      expect(MIN_TOUCH_TARGET).toBe(floor);
      expect(accessibility.minTouchTargetIOS).toBe(44);
      expect(accessibility.minTouchTargetAndroid).toBe(48);
      // ...and the visual bar alone would fail either of them. That inequality
      // is the justification for the whole two-box design.
      expect(TRACK_HEIGHT).toBeLessThan(floor);
      expect(TRACK_HEIGHT).toBeLessThan(accessibility.minTouchTargetIOS);
      expect(TRACK_HEIGHT).toBeLessThan(accessibility.minTouchTargetAndroid);
    });

    it('is announced as an adjustable control with a value in seconds', async () => {
      seedStore({ currentTime: 12, duration: DURATION });
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} title="Rain on a tin roof" />,
      );
      const bar = getByTestId('seek-progress-bar');

      expect(bar.props.accessible).toBe(true);
      // `adjustable`, NOT `progressbar`: React Native only offers
      // increment/decrement actions to an adjustable element, so `progressbar`
      // would ship a dead control behind the VoiceOver rotor.
      expect(bar.props.accessibilityRole).toBe('adjustable');
      expect(bar.props.accessibilityLabel).toBe('Seek within Rain on a tin roof');
      expect(bar.props.accessibilityValue).toEqual({
        min: 0,
        max: DURATION,
        now: 12,
        text: '0:12 of 1:00',
      });
      expect(bar.props.accessibilityState).toEqual({ disabled: false });
    });

    it('drives increment / decrement through skipBy, so they share its clamp', async () => {
      seedStore({ currentTime: 20, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');

      await fire(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(20 + SKIP_SECONDS);

      await fire(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'decrement' },
      });
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(20 - SKIP_SECONDS);

      // An action that is not ours must not seek.
      fakePlayer.seekTo.mockClear();
      await fire(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'activate' },
      });
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('refuses an accessibility seek when nothing is loaded', async () => {
      // `skipBy` already refuses at duration 0; this pins that the control does
      // not route around it.
      seedStore({ currentTime: 0, duration: 0 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);

      await fire(getByTestId('seek-progress-bar'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('formats a spoken position rather than a raw number', () => {
      // The formatter is `lib/formatTime.ts` and nothing else. This file used to
      // import `formatClock`, a second copy of the same rule declared in
      // `SeekProgressBar.tsx` itself — logic that `jest.config.js` excludes from
      // `collectCoverageFrom` (`src/components/**`), so it was only ever reachable
      // through a render. It is called `formatTime` here now, and the assertions
      // are the SAME values the deleted copy produced, which is the point: the
      // rule did not move, the duplicate did.
      expect(formatTime(0)).toBe('0:00');
      expect(formatTime(9)).toBe('0:09');
      expect(formatTime(61)).toBe('1:01');
      expect(formatTime(600)).toBe('10:00');
      expect(formatTime(Number.NaN)).toBe('0:00');
      expect(formatTime(-5)).toBe('0:00');
    });

    it('names the a11y step with the SAME constant the skip buttons seek by', async () => {
      // The two were once separate literals — `SKIP_SECONDS` in
      // `ClipTransport.tsx`, `A11Y_STEP_SECONDS` here — kept equal by hand, and
      // nothing in either suite could see them drift. Both are now one binding in
      // `lib/skipSeconds.ts`, and this renders BOTH controls so the claim is
      // checked on the rendered labels rather than on the import.
      seedStore({ currentTime: 20, duration: DURATION });
      const { getByTestId } = await render(
        <>
          <SeekProgressBar clipId={CLIP_ID} />
          <ClipTransport clipId={CLIP_ID} />
        </>,
      );

      const spoken = (getByTestId('seek-progress-bar').props.accessibilityActions as Array<{
        name: string;
        label: string;
      }>).find((a) => a.name === 'increment');
      expect(spoken?.label).toBe(`Forward ${SKIP_SECONDS} seconds`);
      expect(getByTestId('clip-transport-advance').props.accessibilityLabel).toBe(
        `Advance ${SKIP_SECONDS} seconds`,
      );

      // ...and the ACTION agrees with the label, so the announced number is the
      // number the control actually performs rather than a second description of it.
      await fire(getByTestId('seek-progress-bar'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(20 + SKIP_SECONDS);
    });

    it('speaks the position with the SAME function the transport displays', async () => {
      // The cross-consumer claim, in one test and on one tree: the visible
      // timecode, the transport's spoken label, and this bar's spoken value are
      // three renderings of two numbers, and they must all come from
      // `formatTime`. While this file carried its own `formatClock`, nothing
      // asserted that — the two were pinned only against the same string
      // literals in two suites that could not see each other.
      seedStore({ currentTime: 12, duration: DURATION });
      const { getByTestId } = await render(
        <>
          <SeekProgressBar clipId={CLIP_ID} title="Rain on a tin roof" />
          <ClipTransport clipId={CLIP_ID} title="Rain on a tin roof" />
        </>,
      );

      const position = formatTime(12);
      const total = formatTime(DURATION);

      // Visible, on the transport: `"0:12 / 1:00"` — the `/` is layout, not a
      // different spelling of the position.
      expect(getByTestId('clip-transport-timecode').props.children).toBe(
        `${position} / ${total}`,
      );
      // Spoken, on the transport, and spoken, on this bar: the same `"x of y"`.
      expect(getByTestId('clip-transport-timecode').props.accessibilityLabel).toBe(
        `${position} of ${total}`,
      );
      expect(
        (getByTestId('seek-progress-bar').props.accessibilityValue as { text: string }).text,
      ).toBe(`${position} of ${total}`);

      // Non-vacuity of the equality: the two spellings really are distinct
      // strings, so "the spoken one equals the visible one" is not a tautology.
      expect(`${position} / ${total}`).not.toBe(`${position} of ${total}`);
    });
  });

  // -------------------------------------------------------------------------
  // Smoothness at 500 ms sampling
  // -------------------------------------------------------------------------

  describe('smoothness', () => {
    it('uses a LINEAR timing function, at every interior stop', () => {
      // Endpoints prove nothing: `withTiming`'s default `inOut(ease)` also
      // returns 0 at t=0 and 1 at t=1. Only the interior stops separate a linear
      // ramp from an eased one, and this is the property the source's
      // `transition: width 0.1s linear` asks for.
      for (const t of FILL_EASING_STOPS) {
        expect(FILL_EASING(t)).toBe(t);
      }
      // ...and explicitly NOT the default, so the constant cannot silently
      // become `withTiming`'s own easing.
      expect(FILL_EASING(0.25)).not.toBeCloseTo(0.13, 2);
    });

    it('moves linearly across the whole 500 ms sampling gap while playing', async () => {
      seedStore({ currentTime: QUARTER, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const fill = getByTestId('seek-progress-fill');

      // Sampled at 25% and 75% of the sweep, NEVER at 50%. `Easing.inOut` — the
      // `withTiming` default — is symmetric about the midpoint, so at t = 0.5 it
      // returns exactly the same number as linear and a midpoint-only assertion
      // cannot tell the two apart. That trap is real: this test was originally
      // written at 250/500 ms and the `inOut` mutation passed it.
      //
      // The sweep spans one whole `updateInterval`, so each quarter of elapsed
      // time is a quarter of the 25% target: the fill is in near-continuous
      // motion at the audio's average rate instead of stepping twice a second.
      // A 100 ms ramp would already be FINISHED at 125 ms and parked at 25%,
      // which is a different number — so this also separates the two regimes.
      await act(async () => {
        jest.advanceTimersByTime(125);
      });
      expect(widthPercent(fill)).toBeCloseTo(6.25, 2);

      // t = 0.75 of the sweep.
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(widthPercent(fill)).toBeCloseTo(18.75, 2);

      // t = 1.0: the ramp is over and the fill parks on the target.
      await act(async () => {
        jest.advanceTimersByTime(125);
      });
      expect(widthPercent(fill)).toBeCloseTo(25, 2);
    });

    it('uses the source 100 ms transition when not playing', async () => {
      seedStore({ currentTime: QUARTER, duration: DURATION, playing: false });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const fill = getByTestId('seek-progress-fill');

      // Same quarter-of-the-way samples, on a ramp a fifth of the length: 25 ms
      // and 75 ms of 100 ms. The expected NUMBERS are identical to the 500 ms
      // case, reached by a fifth of the elapsed time — so the two tests cannot
      // pass for the same reason, and neither can pass under `inOut`.
      await act(async () => {
        jest.advanceTimersByTime(25);
      });
      expect(widthPercent(fill)).toBeCloseTo(6.25, 2);

      // t = 0.75 of the sweep.
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      expect(widthPercent(fill)).toBeCloseTo(18.75, 2);

      await act(async () => {
        jest.advanceTimersByTime(25);
      });
      expect(widthPercent(fill)).toBeCloseTo(25, 2);
    });

    it('never overshoots its target, at any point in the ramp', async () => {
      seedStore({ currentTime: QUARTER, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const fill = getByTestId('seek-progress-fill');

      // A spring would exceed 25% around the midpoint and paint outside the
      // track. The ramp is sampled every 16 ms so the excursion cannot hide
      // between two checkpoints.
      const seen: number[] = [];
      for (let i = 0; i < 34; i++) {
        await act(async () => {
          jest.advanceTimersByTime(16);
        });
        seen.push(widthPercent(fill));
      }
      for (const v of seen) {
        expect(v).toBeLessThanOrEqual(25 + 1e-6);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      // ...and it does arrive, so "never exceeded" is not "never moved".
      expect(seen[seen.length - 1]).toBeCloseTo(25, 1);
    });

    it('lands the fill on the committed position after a drag, not through it', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      const fill = getByTestId('seek-progress-fill');
      layOut(bar);

      // The store is at 50%. Drag BACKWARDS, to 20%.
      await setStore({ currentTime: 30 });
      await settle();
      expect(widthPercent(fill)).toBeCloseTo(50, 1);

      await fire(bar, 'responderGrant', touch(200));
      await fire(bar, 'responderMove', touch(60, 200));
      await fire(bar, 'responderRelease', touch(60, 60));
      await frame();

      // Committed to 20% of 60 s = 12 s. If the drag had only previewed and let
      // the store animation win, this would drift back towards 50%.
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(12);
      expect(widthPercent(fill)).toBeCloseTo(20, 1);
    });

    it('gates the fill glow on playback, matching boxShadow: isPlaying', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);

      // WaveformBar.tsx:38 `boxShadow: isPlaying ? '0 0 6px var(--accent-glow)' : 'none'`.
      // On Android `glow()` returns {} — that module's documented "a grey
      // elevation blur would read as a rendering bug" choice — so the iOS arm
      // is the only one with a measurable radius here.
      const playing = barStyle(getByTestId('seek-progress-fill'));
      if (Platform.OS === 'android') {
        expect(playing.shadowRadius).toBeUndefined();
      } else {
        expect(playing.shadowRadius).toBe(6);
        expect(playing.shadowOpacity).toBeCloseTo(0.25, 5);
        expect(playing.shadowColor).toBe(accent.base);
        expect(playing.shadowOffset).toEqual({ width: 0, height: 0 });
      }

      await setStore({ playback: 'paused' });
      await frame();
      expect(barStyle(getByTestId('seek-progress-fill')).shadowRadius).toBeUndefined();
    });

    it('paints the fill gradient from the clip category to the terracotta accent', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(
        <SeekProgressBar clipId={CLIP_ID} category="instrumental" />,
      );
      // The gradient is a native child rather than a style, so it is read
      // through the element. 90deg = to right, so the category colour leads on
      // the LEFT and the accent trails — `linearGradientPoints(90)` returns
      // start.x = 0, and reversing it puts the playhead colour on the wrong
      // side of the wipe.
      // `expo-linear-gradient` renames `start`/`end` to the native
      // `startPoint`/`endPoint` and normalises each to a pair
      // (`LinearGradient.js:14-15,42-48`), so the element carries those, not the
      // component-level prop names.
      const spec = getByTestId('seek-progress-gradient').props as {
        colors: number[];
        startPoint: number[];
        endPoint: number[];
      };
      // `expo-linear-gradient` runs `processColor` on every stop off web
      // (`LinearGradient.js:20-22`), so the element carries native colour ints.
      // Comparing against the processed form keeps the assertion about WHICH
      // stops are in which order rather than about the platform's encoding.
      expect(spec.colors).toEqual([
        processColor(categoryColor('instrumental')),
        processColor(accent.base),
      ]);
      // `linearGradientPoints(90)`: start (0, 0.5) -> end (1, 0.5), i.e. exactly
      // left-to-right. Reversed, the accent would lead and the playhead colour
      // would trail on the wrong side of the wipe.
      expect(spec.startPoint[0]).toBeCloseTo(0, 6);
      expect(spec.endPoint[0]).toBeCloseTo(1, 6);
      expect(spec.startPoint[1]).toBeCloseTo(0.5, 6);
      expect(spec.endPoint[1]).toBeCloseTo(0.5, 6);
    });
  });
});
