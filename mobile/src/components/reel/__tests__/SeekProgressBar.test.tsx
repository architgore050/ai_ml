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
  A11Y_STEP_SECONDS,
  FILL_EASING,
  FILL_EASING_STOPS,
  SAMPLE_INTERVAL_MS,
  SeekProgressBar,
  TRACK_HEIGHT,
  TRACK_RADIUS,
  formatClock,
  fractionFromLocation,
  progressFraction,
  seekTargetFor,
} from '../SeekProgressBar';
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
 */
const touch = (locationX: number, previousX: number = locationX) => {
  touchSeq += 1;
  const point = {
    touchActive: true,
    startPageX: previousX,
    startPageY: 24,
    startTimeStamp: 1,
    currentPageX: locationX,
    currentPageY: 24,
    currentTimeStamp: touchSeq,
    previousPageX: previousX,
    previousPageY: 24,
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
      locationY: 24,
      pageX: locationX,
      pageY: 24,
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

/** Fire the `onLayout` that gives the bar its width. */
const layOut = async (bar: TestElement, width = BAR_WIDTH) => {
  await fireEvent(bar, 'layout', layout(width));
};

/**
 * A complete gesture: grant at `xs[0]`, one move per remaining x (each
 * reporting the previous x so `dx` accumulates), then a release at `end`.
 * `xs` empty = a tap.
 */
const drag = async (bar: TestElement, xs: number[], end: number) => {
  const first = xs[0] ?? 0;
  await fireEvent(bar, 'responderGrant', touch(first));
  let prev = first;
  for (const x of xs) {
    await fireEvent(bar, 'responderMove', touch(x, prev));
    prev = x;
  }
  await fireEvent(bar, 'responderRelease', touch(end, prev));
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

      // Read the prop directly rather than through `fireEvent`: RNTL's
      // `isEventEnabled` consults `onStartShouldSetResponder()` itself, so a
      // `fireEvent` here would be swallowed by the HARNESS and the assertion
      // would pass for the wrong reason.
      expect(bar.props.onStartShouldSetResponder()).toBe(false);
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
      await layOut(bar);
      await drag(bar, [], 150);

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
      expect(getByTestId('seek-progress-bar').props.onStartShouldSetResponder()).toBe(false);
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
      await layOut(bar);
      await drag(bar, [], 150);

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
        await layOut(getByTestId('seek-progress-bar'));
        await drag(getByTestId('seek-progress-bar'), [], x);
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
      await layOut(bar);

      await drag(bar, [], -80);
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(0);
      fakePlayer.seekTo.mockClear();

      await drag(bar, [], 9999);
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
      await drag(getByTestId('seek-progress-bar'), [], 150);

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
      await layOut(bar);

      // 40 move events, then a release. Native must be told ONCE: 40 seeks would
      // queue 40 discontinuity events in the player for one finger movement.
      const xs = Array.from({ length: 40 }, (_, i) => 4 + i * 6);
      await fireEvent(bar, 'responderGrant', touch(xs[0] as number));
      let prev = xs[0] as number;
      for (const x of xs) {
        await fireEvent(bar, 'responderMove', touch(x, prev));
        prev = x;
      }
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      await fireEvent(bar, 'responderRelease', touch(prev, prev));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
    });

    it('previews the drag under the finger and lands the fill on the commit', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);
      const fill = getByTestId('seek-progress-fill');

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(150, 10));
      await frame();
      // The fill tracks the finger EXACTLY — no easing on a drag.
      expect(widthPercent(fill)).toBeCloseTo(50, 3);
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();

      await fireEvent(bar, 'responderRelease', touch(150, 150));
      await frame();
      // Lands ON the committed position rather than easing back to it.
      expect(widthPercent(fill)).toBeCloseTo(50, 3);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('treats a sub-slop nudge as a tap, not a drag', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      // 2 px of movement, under MIN_DRAG_SLOP. The commit is still made, and it
      // is made at the release position.
      await fireEvent(bar, 'responderGrant', touch(148));
      await fireEvent(bar, 'responderMove', touch(150, 148));
      await fireEvent(bar, 'responderRelease', touch(150, 150));

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(30);
    });

    it('does not seek when the native side takes the touch (feed scrolling)', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(150, 10));
      await fireEvent(bar, 'responderTerminate', touch(150, 150));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
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
      await layOut(bar);
      expect(bar.props.onStartShouldSetResponder()).toBe(true);

      const spy = jest.spyOn(playerModule, 'clampSeekTime').mockReturnValue(null);
      await drag(bar, [], 150);

      // The load-bearing assertion: NOT `seekTo(0)`.
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(onSeekResult).toHaveBeenCalledWith(null);
      spy.mockRestore();
    });

    it('still clamps through clampSeekTime rather than seeking the raw fraction', async () => {
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      const spy = jest.spyOn(playerModule, 'clampSeekTime');
      await drag(bar, [], 150);

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
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(120, 10));

      // ONLY the store changes — the props are untouched, so no effect keyed on
      // props can save us here. The live check inside the responder handlers is
      // the only thing that can, which is what makes this test non-vacuous.
      await setStore({ playingClipId: OTHER_CLIP_ID });

      await fireEvent(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('abandons the gesture when the clipId prop changes', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId, rerender } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(120, 10));

      await rerender(<SeekProgressBar clipId={OTHER_CLIP_ID} />);

      await fireEvent(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('stops previewing over the new clip once the store has swapped it', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      const fill = getByTestId('seek-progress-fill');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(150, 10));
      await frame();
      expect(widthPercent(fill)).toBeCloseTo(50, 3);

      await setStore({ playingClipId: OTHER_CLIP_ID, currentTime: 0 });
      await fireEvent(bar, 'responderMove', touch(200, 150));
      await frame();
      // The drag is dead, so the move cannot drag the thumb any further.
      expect(widthPercent(fill)).toBeCloseTo(0, 3);
    });

    it('cancels the drag when the clip finishes under the finger', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(120, 10));

      // `didJustFinish` is a ONE-tick pulse on both platforms, so the durable
      // signal is the store's latch of it into `ended`.
      await setStore({ playback: 'ended' });

      await fireEvent(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('cancels the drag when playback errors underneath it', async () => {
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(120, 10));
      await setStore({ playback: 'error' });

      await fireEvent(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('still allows a fresh gesture on a clip that ended and was reloaded', async () => {
      // Cancelling the IN-FLIGHT drag is not the same as disabling the control:
      // a user who taps a finished clip to hear the end again must still work.
      seedStore({ currentTime: 0, duration: DURATION, playing: true });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);
      const bar = getByTestId('seek-progress-bar');
      await layOut(bar);

      await fireEvent(bar, 'responderGrant', touch(10));
      await fireEvent(bar, 'responderMove', touch(120, 10));
      await setStore({ playback: 'ended' });
      await fireEvent(bar, 'responderRelease', touch(150, 120));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();

      await drag(bar, [], 150);
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

      await fireEvent(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(20 + A11Y_STEP_SECONDS);

      await fireEvent(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'decrement' },
      });
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(20 - A11Y_STEP_SECONDS);

      // An action that is not ours must not seek.
      fakePlayer.seekTo.mockClear();
      await fireEvent(bar, 'accessibilityAction', {
        nativeEvent: { actionName: 'activate' },
      });
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('refuses an accessibility seek when nothing is loaded', async () => {
      // `skipBy` already refuses at duration 0; this pins that the control does
      // not route around it.
      seedStore({ currentTime: 0, duration: 0 });
      const { getByTestId } = await render(<SeekProgressBar clipId={CLIP_ID} />);

      await fireEvent(getByTestId('seek-progress-bar'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('formats a spoken position rather than a raw number', () => {
      expect(formatClock(0)).toBe('0:00');
      expect(formatClock(9)).toBe('0:09');
      expect(formatClock(61)).toBe('1:01');
      expect(formatClock(600)).toBe('10:00');
      expect(formatClock(Number.NaN)).toBe('0:00');
      expect(formatClock(-5)).toBe('0:00');
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
      await layOut(bar);

      // The store is at 50%. Drag BACKWARDS, to 20%.
      await setStore({ currentTime: 30 });
      await settle();
      expect(widthPercent(fill)).toBeCloseTo(50, 1);

      await fireEvent(bar, 'responderGrant', touch(200));
      await fireEvent(bar, 'responderMove', touch(60, 200));
      await fireEvent(bar, 'responderRelease', touch(60, 60));
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
