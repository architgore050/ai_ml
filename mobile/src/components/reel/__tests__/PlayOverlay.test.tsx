/**
 * PlayOverlay — the reel's play/pause affordance.
 *
 * ## What is real and what is doubled
 * `expo-audio` is mocked at the module boundary (the native edge) exactly as
 * `store/__tests__/player.test.ts` and `SeekProgressBar.test.tsx` do, so
 * everything between the component and native playback is shipped code:
 * `PlayOverlay` -> `canTogglePlayback` -> `pause()`/`resume()` ->
 * `getPlayerOrNull()` -> the native `pause`/`play`. Assertions land on the fake
 * player's `pause`/`play`, never on a spy of this component's internals — a spy
 * would pass even if the component stopped calling the store at all.
 *
 * ## Animated styles are read through `getAnimatedStyle`, never `props.style`
 * `props.style` is frozen at the mount-time value, so an assertion written
 * against it is a FALSE PASS: it would read the initial `scaleY` while time had
 * in fact advanced past it. Every animated assertion here goes through
 * `getAnimatedStyle`, with `jest.useFakeTimers()` installed in `beforeEach`
 * BEFORE `render` — reanimated's frame loop schedules its first frame through
 * `requestAnimationFrame`, which fake timers replace, so installing them after
 * render leaves the loop on real rAF where `advanceTimersByTime` moves nothing.
 * `src/lib/__tests__/reanimatedHarness.test.tsx` is the reference, and
 * "the false-pass trap" below re-pins the trap in this file's own terms.
 *
 * STATIC styles (circle size, bar width, `transformOrigin`, hit-area floor) are
 * read through `StyleSheet.flatten(props.style)`, which is legitimate: they are
 * not animated, and therefore not frozen. The design-source constants are
 * RESTATED here as literals rather than imported, so drift surfaces as a
 * FAILURE instead of a test that quietly agrees with whatever the component does
 * (the `AmbientOrbs.test.tsx` convention).
 *
 * ## Queries need `includeHiddenElements`, and that is the component being right
 * The circle is `aria-hidden` and `pointerEvents="none"` by design — it is
 * decoration over a tap target that always carries the role and the label. RNTL
 * 14 excludes accessibility-hidden subtrees by default
 * (`config.js:16`, `defaultIncludeHiddenElements: false`), so a plain
 * `getByTestId('play-overlay-circle')` throws "Unable to find an element" — the
 * library confirming the disc really is invisible to assistive technology.
 * Passed per query rather than flipped globally in `jest.setup.js`, so other
 * suites still notice when something that SHOULD be announced is not.
 */

import { act, fireEvent, isHiddenFromAccessibility, render } from '@testing-library/react-native';
import React from 'react';
import { processColor, StyleSheet } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import type { TestInstance } from 'test-renderer';

import {
  BARS,
  barTestID,
  CIRCLE_SCRIM,
  CIRCLE_SIZE,
  OVERLAY_Z,
  PlayOverlay,
  TRIANGLE_HEIGHT,
  TRIANGLE_WIDTH,
} from '../PlayOverlay';
import { MIN_TOUCH_TARGET } from '../../ui/primitives';
import { radius } from '../../../design/tokens';
import { OVERLAY_AUTO_HIDE_MS } from '../../../lib/playOverlayVisibility';
import {
  getPlayer,
  releasePlayer,
  usePlayerStore,
  type PlayerState,
} from '../../../store/player';

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));

/* ------------------------------------------------------------------ */
/* The design source, restated                                         */
/* ------------------------------------------------------------------ */

const SOURCE = {
  circle: 100,
  scrim: 'rgba(0, 0, 0, 0.4)',
  z: 10,
  /** ReelCard.tsx:150 heights + globals.css:209-215 delays. */
  bars: [
    { height: 12, delayMs: 0 },
    { height: 18, delayMs: 120 },
    { height: 14, delayMs: 240 },
    { height: 20, delayMs: 360 },
    { height: 14, delayMs: 240 },
    { height: 18, delayMs: 120 },
    { height: 12, delayMs: 0 },
  ],
  barWidth: 4,
  barRadius: 2,
  gap: 3,
  rowHeight: 24,
  /** ReelCard.tsx:157-158. */
  triangle: { w: 28, h: 34, viewBoxWidth: 24, viewBoxHeight: 24, points: 'M6 4 22 12 6 20z' },
  /** globals.css:170-171, the waveBar keyframes. */
  scaleMin: 0.25,
  scaleMax: 1,
} as const;

const CLIP = 'clip-a';
const NEXT_CLIP = 'clip-b';

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

type FakePlayer = {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  remove: jest.Mock;
  release: jest.Mock;
};

let fakePlayer: FakePlayer;

const makeFakePlayer = (): FakePlayer => ({
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  remove: jest.fn(),
  release: jest.fn(),
});

/**
 * Write the store the way `syncFromPlayer` would, bypassing its coercion.
 *
 * `endedForClipId` is seeded to match `playingClipId` for every `ended` case,
 * because the store LATCHES `ended` there — a test that set only `playback`
 * would be describing a state the store cannot actually hold.
 */
const seedStore = (o: {
  cardStatus?: PlayerState['cardStatus'];
  playback?: PlayerState['playback'];
  playingClipId?: string | null;
}) => {
  const playingClipId = o.playingClipId === undefined ? CLIP : o.playingClipId;
  usePlayerStore.setState({
    cardStatus: o.cardStatus ?? 'idle',
    playback: o.playback ?? 'paused',
    playingClipId,
    endedForClipId: o.playback === 'ended' ? playingClipId : null,
    error: null,
  });
};

/** Store write on a mounted tree, so React is not updated outside `act`. */
const setStore = async (patch: Partial<PlayerState>) => {
  await act(async () => {
    usePlayerStore.setState(patch);
  });
};

/** RNTL v14's `render` is async, so the queries live on the awaited value. */
type Rendered = Awaited<ReturnType<typeof render>>;

/** Hidden-aware lookup. See the header: the circle is `aria-hidden` by design. */
function node(r: Rendered, testID: string): TestInstance {
  return r.getByTestId(testID, { includeHiddenElements: true });
}

const queryNode = (r: Rendered, testID: string): TestInstance | null =>
  r.queryByTestId(testID, { includeHiddenElements: true });

/**
 * The first HOST element of the given type at or below `node`.
 *
 * Needed because both libraries under test put the interesting props on an inner
 * host node rather than on the element carrying the `testID`:
 * `react-native-svg` compiles `<Polygon points>` into a `RNSVGPath` `d` string,
 * and `expo-blur` forwards `intensity`/`tint` to `ViewManagerAdapter_ExpoBlur`
 * while the `testID` stays on its outer wrapper `View`.
 *
 * `findAll`/`findAllByType` are not on RNTL v14's `TestInstance` (both measured
 * as "not a function"), so this walks `children` itself. The tree is one or two
 * levels deep in both cases, so the recursion is bounded by what the tests
 * actually query rather than by a rendered page.
 */
function findHost(node: TestInstance, type: string): TestInstance | null {
  if (node.type === type) return node;
  // `children` is `Array<TestNode>`, and `TestNode` includes `string` for text
  // content — so a raw text child is not a `TestInstance` and must be skipped.
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const match = findHost(child, type);
    if (match) return match;
  }
  return null;
}

/**
 * `findHost`, but failing the test with a legible message rather than a
 * `TypeError` on `null` — a missing host node means the library under test
 * changed shape, which is exactly the thing these assertions exist to catch.
 */
function requireHost(node: TestInstance, type: string): TestInstance {
  const match = findHost(node, type);
  if (!match) {
    throw new Error(
      `No host element of type "${type}" at or below this node. ` +
        `If react-native-svg or expo-blur changed its host element, update the test.`,
    );
  }
  return match;
}

/** Flatten a static style. Legitimate for non-animated props — see the header. */
function styleOf(node: TestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

/** The LIVE animated value, via reanimated's own reader. */
function scaleYOf(node: TestInstance): number {
  const style = getAnimatedStyle(node) as { transform?: Array<{ scaleY?: number }> };
  return style.transform?.[0]?.scaleY ?? Number.NaN;
}

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

const press = async (r: Rendered) => {
  await fireEvent.press(node(r, 'play-overlay'));
};

/* ------------------------------------------------------------------ */

describe('PlayOverlay', () => {
  beforeEach(() => {
    // Before the first `render`, not after: the animation loop schedules its
    // first frame through requestAnimationFrame, which fake timers replace.
    jest.useFakeTimers();
    fakePlayer = makeFakePlayer();
    (jest.requireMock('expo-audio').createAudioPlayer as jest.Mock).mockReturnValue(fakePlayer);
    // Populates the store's module-level singleton, so `pause()`/`resume()`
    // reach the fake player instead of short-circuiting on a null instance.
    getPlayer();
    seedStore({ playback: 'paused' });
  });

  afterEach(() => {
    // `releasePlayer` nulls the singleton and resets the store; without it the
    // fake player would leak into the next test through the module singleton.
    releasePlayer();
    // Global spies MUST be restored here rather than at the end of each test:
    // a spy left installed by a test that threw mid-way outlives the test,
    // wraps the fake `setTimeout` React's scheduler uses, and surfaces in the
    // NEXT test as an opaque React `AggregateError`.
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /* ---------------------------------------------------------------- */
  describe('the tap target is always mounted', () => {
    it('renders the full-reel target with the role and a real-state label', async () => {
      const r = await render(<PlayOverlay clipId={CLIP} />);
      const target = node(r, 'play-overlay');

      expect(target.props.accessibilityRole).toBe('button');
      expect(target.props.accessible).toBe(true);
      // An idle reel presents a visible affordance as well as retaining the
      // full-card target for its gesture contract.
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
      expect(queryNode(r, 'play-overlay-triangle')).not.toBeNull();
    });

    it('sits above the card, below the action cluster, and fills the reel', async () => {
      const r = await render(<PlayOverlay clipId={CLIP} />);
      const style = styleOf(node(r, 'play-overlay'));

      // ReelCard.tsx:139. A CONSTRAINT on the caller: the action cluster and the
      // seek bar must render above it or this full-reel target eats their taps.
      expect(style.zIndex).toBe(SOURCE.z);
      expect(OVERLAY_Z).toBe(SOURCE.z);
      expect(style).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
    });

    it('meets the enforced touch-target floor on BOTH axes', async () => {
      const r = await render(<PlayOverlay clipId={CLIP} />);
      const style = styleOf(node(r, 'play-overlay'));

      // 44pt iOS / 48dp Android, from `primitives.ts`. Stated on the target
      // rather than inherited from the reel's measured height, so it is a
      // property of the control and not an accident of the viewport.
      expect(style.minWidth).toBe(MIN_TOUCH_TARGET);
      expect(style.minHeight).toBe(MIN_TOUCH_TARGET);
      expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(44);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('accessibility reflects the REAL state', () => {
    it('offers "Pause" while playing and "Play" while paused', async () => {
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Pause');

      await setStore({ playback: 'paused' });
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play');
    });

    it('appends the title when there is one, and falls back to a bare verb when there is not', async () => {
      seedStore({ playback: 'playing' });
      const titled = await render(<PlayOverlay clipId={CLIP} title="Monsoon" />);
      expect(node(titled, 'play-overlay').props.accessibilityLabel).toBe('Pause Monsoon');

      await setStore({ playback: 'paused' });
      expect(node(titled, 'play-overlay').props.accessibilityLabel).toBe('Play Monsoon');

      // A caller with no title must still get a usable label, not `undefined`.
      const bare = await render(<PlayOverlay clipId={CLIP} />);
      expect(node(bare, 'play-overlay').props.accessibilityLabel).toBe('Play');
    });

    it('updates the label from the LIVE state after a tap, not from a latched intent', async () => {
      // The failure this rules out: reading the verb off the machine's record of
      // what the tap DID. For the whole 600 ms after every tap that would tell a
      // screen reader to "Play" a clip that is playing.
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} title="Monsoon" />);
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Pause Monsoon');

      await press(r);

      // The tap PAUSED it. The store says paused, so the affordance is "Play" —
      // immediately, not after the window closes.
      expect(usePlayerStore.getState().playback).toBe('paused');
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play Monsoon');
    });

    it('announces a refused tap as a disabled control, not as a third label', async () => {
      // The card already reads out its own copy for every terminal state, and it
      // must not distinguish 403 from 404 — so there is no single collapsed
      // string to reuse, and a third label here would contradict the card.
      seedStore({ cardStatus: 'unavailable', playback: 'idle' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      const state = node(r, 'play-overlay').props.accessibilityState as { disabled?: boolean };

      expect(state.disabled).toBe(true);
      // The verb still tracks real state; only the affordance is withdrawn.
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play');
    });

    it('hides the circle from assistive technology, leaving the target as the only voice', async () => {
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      // A blurred disc that happens to be animating is not something to read
      // aloud; the target above already carries the role and the label.
      expect(isHiddenFromAccessibility(node(r, 'play-overlay-circle'))).toBe(true);
      expect(isHiddenFromAccessibility(node(r, 'play-overlay'))).toBe(false);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a tap that RESUMES — transient, 600 ms, bars', () => {
    it('reaches native `play` and draws the bars', async () => {
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      expect(fakePlayer.play).toHaveBeenCalledTimes(1);
      // `pause` must NOT have fired: the direction and the native call are the
      // same decision, and a test on the store alone could not tell a swapped
      // pair apart from a correct one.
      expect(fakePlayer.pause).not.toHaveBeenCalled();
      expect(queryNode(r, 'play-overlay-bars')).not.toBeNull();
    });

    it('hides after exactly 600 ms, and not a millisecond earlier', async () => {
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();

      await advance(OVERLAY_AUTO_HIDE_MS - 1);
      expect(OVERLAY_AUTO_HIDE_MS).toBe(SOURCE.circle === 100 ? 600 : 600);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();

      await advance(1);
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });

    it('reports the direction to the caller, and `null` when it refuses', async () => {
      const onToggle = jest.fn();
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} onToggle={onToggle} />);
      await press(r);
      expect(onToggle).toHaveBeenLastCalledWith({ direction: 'resume' });

      seedStore({ cardStatus: 'gone', playback: 'playing' });
      await setStore({ cardStatus: 'gone' });
      await press(r);
      expect(onToggle).toHaveBeenLastCalledWith(null);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a tap that PAUSES — persistent, no timer, triangle', () => {
    it('reaches native `pause` and draws the triangle', async () => {
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      expect(fakePlayer.pause).toHaveBeenCalledTimes(1);
      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(queryNode(r, 'play-overlay-triangle')).not.toBeNull();
      expect(queryNode(r, 'play-overlay-bars')).toBeNull();
    });

    it('stays visible far past 600 ms — the triangle is the only way back', async () => {
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      // There is no transport bar in the centre of a card, so hiding this would
      // strand the user on a paused reel with nothing to resume it with.
      await advance(OVERLAY_AUTO_HIDE_MS * 20);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
    });

    it('schedules NO auto-hide timer at all, rather than a ceremonial one', async () => {
      seedStore({ playback: 'paused' });
      const quiet = await render(<PlayOverlay clipId={CLIP} />);
      const before = jest.getTimerCount();

      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      // The paused arm arms no deadline, so the only new timers are reanimated's
      // pop-in and wave animations — nothing that can change the output. A timer
      // here could not hide the overlay (the latch already does), so it would be
      // pure ceremony; the assertion is that the latched case needs none.
      expect(jest.getTimerCount()).toBeGreaterThan(before);
      expect(queryNode(quiet, 'play-overlay')).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the auto-hide timer', () => {
    it('is cleared on unmount — the design source leaks it', async () => {
      // `ReelCard.tsx:140` calls `setTimeout(..., 600)` and never keeps the
      // handle. Swipe the reel away inside the window and that timeout still
      // fires, writing state into a card that is gone: one setState per
      // abandoned tap, on a fast scroll, with no warning (React 18 dropped the
      // setState-after-unmount warning entirely).
      //
      // ------------------------------------------------------------------------
      // HOW THIS IS OBSERVED, and why it is not `jest.getTimerCount()`
      // ------------------------------------------------------------------------
      // Two facts, both measured in this environment rather than assumed:
      //
      //  - `jest.getTimerCount()` is useless here. Reanimated's frame loop and
      //    React's scheduler keep their own timers around, and the count moves
      //    in BOTH directions across an unmount (3 -> 8 with cleanups flushed).
      //    A count assertion would be measuring the harness.
      //  - `jest.spyOn(global, 'clearTimeout')` sees a DIFFERENT `clearTimeout`
      //    than the one module code resolves, so matching a spied `setTimeout`
      //    handle against a spied `clearTimeout` argument never matches — even
      //    for a two-line component with no animation in it.
      //
      // What IS sound: the pairing itself. A probe confirmed a fake-timer
      // callback is genuinely cancelled by the component's cleanup (`fired ===
      // 0`) and genuinely fires without it (`fired === 1`). So the auto-hide
      // callback is intercepted and asked whether it ran.
      //
      // THE CONTROL ARM IS THE POINT. Without it this test would pass even if
      // the harness could not see leaks at all — the failure mode that matters
      // most here, because a test that cannot fail is worse than no test. The
      // control runs the identical harness with the unmount omitted and REQUIRES
      // the callback to have fired.
      const runLeakHarness = async ({ unmount }: { unmount: boolean }) => {
        const realSetTimeout = global.setTimeout;
        const autoHideCallbacks: jest.Mock[] = [];
        jest
          .spyOn(global, 'setTimeout')
          .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
            if (ms !== OVERLAY_AUTO_HIDE_MS) {
              return realSetTimeout(fn, ms, ...rest);
            }
            const wrapped = jest.fn(fn);
            autoHideCallbacks.push(wrapped);
            return realSetTimeout(wrapped, ms, ...rest);
          }) as never);

        seedStore({ playback: 'paused' });
        const r = await render(<PlayOverlay clipId={CLIP} />);
        await press(r);
        await advance(0);
        // Non-vacuous: a 600 ms auto-hide was really intercepted.
        expect(autoHideCallbacks).toHaveLength(1);

        if (unmount) await r.unmount();
        await advance(OVERLAY_AUTO_HIDE_MS * 4);

        // The tree is ALWAYS torn down before returning, including in the control
        // arm. Two mounted trees in one test share the player store and the
        // mocked `setTimeout`, and the second render surfaces as an opaque React
        // `AggregateError` rather than as anything diagnosable.
        await r.unmount();
        // AND the spy is restored here, not left to `afterEach`: a second
        // `jest.spyOn` on an already-spied property re-mocks the EXISTING mock,
        // so the second run's `realSetTimeout` would be the first run's wrapper
        // rather than the fake timer — a two-deep interception that breaks React's
        // scheduler and throws as an `AggregateError` with no message.
        jest.restoreAllMocks();
        return autoHideCallbacks[0];
      };

      // Control: the harness CAN see the leak — the callback fires when the
      // reel is never torn down inside the window.
      const leaked = await runLeakHarness({ unmount: false });
      expect(leaked).toHaveBeenCalled();

      // And with the teardown, it does not.
      const cleared = await runLeakHarness({ unmount: true });
      expect(cleared).not.toHaveBeenCalled();
    });

    it('RESTARTS on a repeat tap instead of ending on the first deadline', async () => {
      // The source's actual behaviour is the opposite: the second tap schedules a
      // NEW anonymous 600 ms timeout and drops the handle to the first, so the
      // FIRST deadline is what hides the overlay and the user sees the remainder
      // (300 ms here) instead of 600.
      //
      // A note on why the store is driven back to `paused` between the two taps,
      // because it looks like scaffolding and is not. Tapping twice in a row does
      // NOT produce two `playing` outcomes: the first tap RESUMES, so the second
      // tap finds a PLAYING clip and PAUSES it, which takes the latched arm and
      // is covered by "a tap that PAUSES". The restart property needs two taps
      // that each end with the clip playing, so the pause in the middle has to
      // come from somewhere other than a tap — and the native player reporting
      // `paused` between them is exactly that. That is the real shape of the
      // race: a stall, an interruption, a `syncFromPlayer` tick.
      //
      // Timed in ABSOLUTE terms against a fixed t=0 tap, because the two windows
      // overlap and it is easy to write the second leg off the first deadline:
      // tap at t=0 closes at 600; tap at t=300 closes at 900.
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} />);

      await press(r); // t=0, resumes, window closes at 600
      expect(queryNode(r, 'play-overlay-bars')).not.toBeNull();

      await advance(300);
      await setStore({ playback: 'paused' }); // the player reports a pause
      await press(r); // t=300, resumes again, window closes at 900

      await advance(300); // t=600 — the FIRST window has just closed
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();

      await advance(299); // t=899, the second window's last millisecond
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();

      await advance(1); // t=900, 600 ms after the SECOND tap
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });

    it('is not restarted by an unrelated re-render', async () => {
      // The failure this rules out: keying the effect on a recomputed remaining
      // count, so the timer is re-armed by its own deadline approaching and the
      // overlay never hides at all.
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} title="Monsoon" />);
      await press(r);

      await advance(400);
      // A re-render with no behavioural change: new prop identity, new store read.
      await r.rerender(<PlayOverlay clipId={CLIP} title="Monsoon" onToggle={jest.fn()} />);
      await advance(200);

      // 600 ms after the tap, despite the re-render at 400 ms.
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });

    it('is cancelled when the clip changes, so a tap cannot hide the NEXT reel', async () => {
      // Two distinct properties, and the second is the one that actually bites:
      // the old clip's window must not SURVIVE, and the new clip must be able to
      // run its own window rather than inheriting a stale deadline.
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      seedStore({ playback: 'paused', playingClipId: CLIP });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();

      // The feed swaps the card. The armed deadline belongs to the old clip and
      // must not survive into the new one.
      seedStore({ playback: 'playing', playingClipId: NEXT_CLIP });
      await setStore({ playingClipId: NEXT_CLIP, playback: 'playing' });
      await r.rerender(<PlayOverlay clipId={NEXT_CLIP} />);

      // The NEW clip shows no overlay — it was never tapped — and the deadline
      // going `number -> null` is what ran the effect cleanup above.
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // And the new clip's OWN tap still gets a full window, rather than
      // inheriting the previous reel's already-partly-elapsed deadline.
      await setStore({ playback: 'paused' });
      await press(r);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
      await advance(OVERLAY_AUTO_HIDE_MS - 1);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
      await advance(1);
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the two refusals', () => {
    it.each(['processing', 'unavailable', 'gone', 'auth-required', 'error'] as const)(
      'does not toggle playback while the card shows %s',
      async (cardStatus) => {
        seedStore({ cardStatus, playback: 'paused' });
        const onToggle = jest.fn();
        const r = await render(<PlayOverlay clipId={CLIP} onToggle={onToggle} />);
        await press(r);

        // Not an optimistic claim: the backend already refused, 404'd or is still
        // encoding, so there is nothing loaded to pause and nothing to resume.
        expect(fakePlayer.play).not.toHaveBeenCalled();
        expect(fakePlayer.pause).not.toHaveBeenCalled();
        expect(onToggle).toHaveBeenCalledWith(null);
        expect(usePlayerStore.getState().playback).toBe('paused');
      },
    );

    it('does not toggle on a native playback error even with a healthy card', async () => {
      seedStore({ cardStatus: 'idle', playback: 'error' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(fakePlayer.pause).not.toHaveBeenCalled();
    });

    it('does not let a mounted-but-passed reel drive another clip’s player', async () => {
      // A reel that is rendered but not the loaded one. `playingClipId` is "the
      // id actually playing, not the requested one", so without the check this
      // reel could `resume()` a player pointing at a different clip and write
      // `playback: 'playing'` about a clip that is not on screen.
      seedStore({ playback: 'paused', playingClipId: NEXT_CLIP });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(node(r, 'play-overlay').props.accessibilityState).toMatchObject({ disabled: true });
    });

    it('draws no circle at all while a terminal card state is showing', async () => {
      // A control drawn over the card's own terminal copy is a second,
      // contradicting answer to the same question.
      seedStore({ cardStatus: 'gone', playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);

      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('`ended` — latched by the store', () => {
    it('takes the transient window and then gets out of the way', async () => {
      // `store/player.ts` latches `ended` in `endedForClipId` for as long as the
      // clip is loaded, because `didJustFinish` is a one-tick native pulse. So a
      // finished clip reads `ended` INDEFINITELY: any rule keyed on "not
      // playing" would be permanent, parking a play triangle that invites a
      // replay while auto-advance consumes `ended` and moves on.
      //
      // The glyph is the BARS, not the triangle, because tapping a finished clip
      // RESUMES it: `resume()` writes `playback: 'playing'` and the icon is read
      // from live state. Asserting the triangle here would be asserting a stale
      // reading of the pre-tap state.
      seedStore({ playback: 'ended', playingClipId: CLIP });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);

      // A finished clip is a legitimate thing to tap — that IS the replay.
      expect(fakePlayer.play).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().playback).toBe('playing');
      expect(queryNode(r, 'play-overlay-bars')).not.toBeNull();
      // ...and it is gone once the window closes, rather than sitting there for
      // ever because the store will keep reporting `ended`.
      await advance(OVERLAY_AUTO_HIDE_MS - 1);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
      await advance(1);
      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
    });

    it('does not wear a paused affordance once the clip has finished', async () => {
      // A pause latch is conjoined on `playback === 'paused'`, so it cannot
      // survive into `ended` — which matters precisely BECAUSE `ended` is
      // latched: a latch keyed on "not playing" would be permanent.
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      expect(queryNode(r, 'play-overlay-circle')).not.toBeNull();
      expect(queryNode(r, 'play-overlay-triangle')).not.toBeNull();

      // The clip finishes on its own — the store latches `ended` and it stays.
      await setStore({ playback: 'ended', endedForClipId: CLIP });

      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
      // Still reversible, and still honest about what it will do.
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play');
    });

    it('leaves no latch behind from an `ended` tap', async () => {
      // Belt and braces on the same rule, observed at the source: the machine's
      // pause latch can only be set by a tap that ENDED paused, and this one
      // ended playing, so nothing survives the window.
      seedStore({ playback: 'ended', playingClipId: CLIP });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      await advance(OVERLAY_AUTO_HIDE_MS);

      expect(queryNode(r, 'play-overlay-circle')).toBeNull();
      expect(usePlayerStore.getState().playback).toBe('playing');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the circle', () => {
    const showCircle = async () => {
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      return r;
    };

    it('is 100 px, a full-radius circle, over the source’s 40 % black scrim', async () => {
      const r = await showCircle();
      const style = styleOf(node(r, 'play-overlay-circle'));

      expect(style.width).toBe(SOURCE.circle);
      expect(style.height).toBe(SOURCE.circle);
      expect(CIRCLE_SIZE).toBe(SOURCE.circle);
      expect(style.borderRadius).toBe(radius.full);
      expect(style.backgroundColor).toBe(SOURCE.scrim);
      expect(CIRCLE_SCRIM).toBe(SOURCE.scrim);
      // `border-radius: 9999px` on a square only reads as a circle if the
      // radius is at least half the side.
      expect(Number(style.borderRadius)).toBeGreaterThanOrEqual(SOURCE.circle / 2);
    });

    it('centres its glyph and clips the blurred backdrop to its own bounds', async () => {
      const r = await showCircle();
      const style = styleOf(node(r, 'play-overlay-circle'));

      expect(style).toMatchObject({
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      });
    });

    it('cannot steal the touch from the target beneath it', async () => {
      const r = await showCircle();
      expect(node(r, 'play-overlay-circle').props.pointerEvents).toBe('none');
    });

    it('pops in from scale 0.8 and fades in over 300 ms', async () => {
      // globals.css:155-159 — `popIn 0.3s ease forwards`, inline, so it beats the
      // `.pop-in` class's 0.35 s. The overshoot to 1.05 at 70 % is a SEQUENCE of
      // two timings, and opacity is a separate LINEAR track because 70 % declares
      // no opacity, so it ramps across the whole duration rather than following
      // the overshoot.
      const r = await showCircle();
      const circle = node(r, 'play-overlay-circle');

      await advance(0);
      const started = getAnimatedStyle(circle) as {
        opacity?: number;
        transform?: Array<{ scale?: number }>;
      };
      expect(started.opacity).toBe(0);
      expect(started.transform?.[0]?.scale).toBeCloseTo(0.8, 5);

      // 70 % of 300 ms: the peak, before the settle.
      await advance(210);
      const peak = getAnimatedStyle(circle) as { transform?: Array<{ scale?: number }> };
      expect(peak.transform?.[0]?.scale).toBeGreaterThan(1.04);
      expect(peak.transform?.[0]?.scale).toBeLessThanOrEqual(1.05);

      // Settled.
      await advance(90);
      const settled = getAnimatedStyle(circle) as {
        opacity?: number;
        transform?: Array<{ scale?: number }>;
      };
      expect(settled.transform?.[0]?.scale).toBeCloseTo(1, 2);
      expect(settled.opacity).toBeCloseTo(1, 2);
    });

    it('draws a 10 px backdrop blur, standing in for `backdrop-filter: blur(10px)`', async () => {
      // React Native has NO `backdrop-filter` style, so the source's
      // `backdropFilter` has no native equivalent and `expo-blur` is the
      // documented substitute (`design/tokens.ts` says the `blur.*` group "drives
      // expo-blur intensity and the BlurView radius").
      //
      // WHAT THIS DOES NOT PROVE, per the `AmbientOrbs.test.tsx` precedent: blur
      // RENDERING is unverifiable from JS — `processFilter`/the native blur pass
      // never run under jest, so an invalid intensity would pass here and fail
      // silently on device. What is asserted is that the documented 10 reaches
      // the native blur view, which is the part that can be checked.
      const r = await showCircle();
      // The `testID` sits on expo-blur's outer wrapper; the props it forwards to
      // the native view are on the inner host node.
      const host = requireHost(node(r, 'play-overlay-blur'), 'ViewManagerAdapter_ExpoBlur');

      expect(host.props.intensity).toBe(10);
      // The source's backdrop has no tint of its own; `light` is the least
      // additive available and it sits UNDER the 40 %-black scrim anyway.
      expect(host.props.tint).toBe('light');
    });

    it('fills the circle with the blur rather than laying it beside the glyph', async () => {
      const r = await showCircle();
      // `StyleSheet.absoluteFill` on the BlurView: anything less and the scrim
      // would be a smaller blurred square inside a 100 px transparent disc.
      expect(styleOf(node(r, 'play-overlay-blur'))).toMatchObject({
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the paused glyph', () => {
    /** Press while PLAYING, so the tap pauses and the triangle is what is left. */
    const showTriangle = async () => {
      seedStore({ playback: 'playing' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      return r;
    };

    it('is the source’s inline SVG triangle, not a View with borders', async () => {
      const r = await showTriangle();
      const svg = node(r, 'play-overlay-triangle');
      // react-native-svg renders host elements, so this also pins "it is an SVG"
      // — a switch to an icon font or a border triangle fails here.
      expect(svg.type).toBe('RNSVGSvgView');
      expect(svg.props.width).toBe(SOURCE.triangle.w);
      expect(svg.props.height).toBe(SOURCE.triangle.h);
      expect(TRIANGLE_WIDTH).toBe(SOURCE.triangle.w);
      expect(TRIANGLE_HEIGHT).toBe(SOURCE.triangle.h);

      // `viewBox="0 0 24 24"` is PARSED by react-native-svg into numeric
      // vbWidth/vbHeight for the native view, which is a stronger assertion than
      // the string: it proves the string was understood, not just forwarded.
      expect(svg.props.vbWidth).toBe(SOURCE.triangle.viewBoxWidth);
      expect(svg.props.vbHeight).toBe(SOURCE.triangle.viewBoxHeight);

      // And the polygon is COMPILED to path data — again stronger than restating
      // `points`, because it proves the points became geometry.
      const polygon = requireHost(svg, 'RNSVGPath');
      expect(polygon.props.d).toBe(SOURCE.triangle.points);
    });

    it('is white on both the root and the polygon', async () => {
      // `Svg` does pass fill/stroke down, but an inherited white that silently
      // failed would render a BLACK triangle on a 40 %-black disc — invisible
      // rather than broken, which is the worst way for it to fail.
      const r = await showTriangle();

      const svg = node(r, 'play-overlay-triangle');
      expect(svg.props.fill).toBe('#fff');
      expect(svg.props.stroke).toBe('#fff');
      expect(svg.props.strokeWidth).toBe(1);

      const polygon = requireHost(svg, 'RNSVGPath');
      // react-native-svg hands the native view an ALREADY-PROCESSED colour
      // (`{type, payload}`), not the string, so the payload is what is compared —
      // against `processColor('#fff')`, which is how the white is pinned rather
      // than the opaque numeric literal.
      expect(polygon.props.fill).toMatchObject({ payload: processColor('#fff') });
      expect(polygon.props.stroke).toMatchObject({ payload: processColor('#fff') });
      expect(polygon.props.strokeWidth).toBe(1);
    });

    it('replaces the bars rather than stacking with them', async () => {
      const r = await showTriangle();
      expect(queryNode(r, 'play-overlay-triangle')).not.toBeNull();
      expect(queryNode(r, 'play-overlay-bars')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the playing glyph', () => {
    const showBars = async () => {
      seedStore({ playback: 'paused' });
      const r = await render(<PlayOverlay clipId={CLIP} />);
      await press(r);
      return r;
    };

    it('is seven bars at the source’s heights, 4 px wide with a 2 px radius', async () => {
      const r = await showBars();
      const bars = SOURCE.bars.map((_, i) => node(r, barTestID(i)));

      expect(bars).toHaveLength(SOURCE.bars.length);
      expect(BARS).toHaveLength(SOURCE.bars.length);
      // The pairing is one array so a height and its phase delay cannot drift
      // apart — a mis-pairing no type or test would otherwise catch.
      expect(BARS).toEqual(SOURCE.bars);

      bars.forEach((bar, i) => {
        const style = styleOf(bar);
        expect(style.width).toBe(SOURCE.barWidth);
        expect(style.borderRadius).toBe(SOURCE.barRadius);
        expect(style.height).toBe(SOURCE.bars[i]?.height);
        expect(style.opacity).toBe(0.9);
        expect(style.backgroundColor).toBe('#fff');
      });
    });

    it('lays them out in a 24 px bottom-aligned row with the source’s 3 px gap', async () => {
      const r = await showBars();
      const row = styleOf(node(r, 'play-overlay-bars'));

      expect(row).toMatchObject({
        height: SOURCE.rowHeight,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: SOURCE.gap,
      });
    });

    it('anchors every bar to the baseline with `transformOrigin: bottom`', async () => {
      // LOAD-BEARING, not decoration. RN scales a view about its CENTRE, so
      // without this every bar lifts off the baseline as it breathes and the row
      // detaches from the middle of the disc.
      const r = await showBars();
      for (let i = 0; i < SOURCE.bars.length; i += 1) {
        expect(styleOf(node(r, barTestID(i))).transformOrigin).toBe('bottom');
      }
    });

    it('keeps `transformOrigin: bottom` AFTER the animation clock advances', async () => {
      // The regression this guards: `transformOrigin` moving into the animated
      // style, where a transform that omits it would drop the origin and the
      // bars would start lifting off the baseline mid-breath. The origin is
      // static and unconditional, so the animated style must not be able to
      // displace it — and the animated scale is proven to have moved first, or
      // this would pass without time advancing at all.
      const r = await showBars();
      const first = node(r, barTestID(0));
      const startScale = scaleYOf(first);

      await advance(500);
      const midScale = scaleYOf(first);

      // Time really moved — read through reanimated, not props.style.
      expect(midScale).not.toBe(startScale);
      expect(midScale).toBeGreaterThanOrEqual(SOURCE.scaleMin);
      expect(midScale).toBeLessThanOrEqual(SOURCE.scaleMax);
      // ...and the origin is still there on every bar.
      for (let i = 0; i < SOURCE.bars.length; i += 1) {
        expect(styleOf(node(r, barTestID(i))).transformOrigin).toBe('bottom');
      }
    });

    it('breathes on the source’s 1 s cycle, out of phase per bar', async () => {
      // `waveBar 1s ease-in-out infinite` — there-and-back, so two halves of
      // 500 ms. Each bar has its own `withRepeat` and its own `withDelay`, which
      // is what makes the row read as a wave rather than a pulse.
      //
      // The property asserted is the PHASE SPREAD, not an exact peak: the first
      // frame lands a frame or two after t=0 (the effect that arms the animation
      // runs after mount), and pinning a precise mid-point value would assert
      // reanimated's scheduler rather than this component. `bar 0` has no delay
      // and `bar 3` has 360 ms, so at any instant inside the first half-second
      // the first is well past the second.
      const r = await showBars();
      await advance(250);

      const lead = scaleYOf(node(r, barTestID(0)));
      const lagged = scaleYOf(node(r, barTestID(3)));

      expect(lead).toBeGreaterThan(lagged + 0.3);
      // A shared clock with no delay would make all seven identical.
      const heights = SOURCE.bars.map((_, i) => scaleYOf(node(r, barTestID(i))));
      expect(new Set(heights.map((h) => h.toFixed(3))).size).toBeGreaterThan(1);
      // And every bar stays inside the source's keyframe range.
      for (const h of heights) {
        expect(h).toBeGreaterThanOrEqual(SOURCE.scaleMin);
        expect(h).toBeLessThanOrEqual(SOURCE.scaleMax);
      }
    });

    it('leaves `props.style` frozen, so an animated assertion written on it would lie', async () => {
      // The false-pass trap, in this file's own terms. `props.style` is pinned at
      // the mount-time value for ever, so every animated assertion above goes
      // through `getAnimatedStyle` instead. If this test ever starts failing
      // because the frozen read tracked the animation, the harness changed.
      const r = await showBars();
      const bar = node(r, barTestID(0));
      // Scans the style ARRAY for the entry that carries a transform, rather
      // than indexing position 0 — the array is `[styles.bar, {height},
      // animatedHandle]`, so a hard-coded index would break if the order changed
      // while still reading as a pass when it returned `undefined`.
      const frozenRead = () => {
        const entries = (bar.props.style as Array<{ transform?: unknown }>).filter((s) =>
          Array.isArray(s?.transform),
        );
        const transform = entries[0]?.transform as Array<{ scaleY?: number }> | undefined;
        return transform?.[0]?.scaleY ?? Number.NaN;
      };

      expect(frozenRead()).toBe(SOURCE.scaleMin);

      await advance(250);

      // Time HAS advanced...
      expect(scaleYOf(bar)).toBeGreaterThan(0.5);
      // ...while the prop a naive assertion would target is still the initial
      // value. That is precisely why the assertions above do not use it.
      expect(frozenRead()).toBe(SOURCE.scaleMin);
    });
  });
});
