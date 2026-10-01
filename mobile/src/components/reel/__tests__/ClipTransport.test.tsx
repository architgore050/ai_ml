/**
 * ClipTransport — the timecode, the ±10 s pair, and the hands-free toggle.
 *
 * ## What is real and what is doubled
 * `expo-audio` is mocked at the module boundary (the native edge), exactly as
 * `SeekProgressBar.test.tsx` and `store/__tests__/player.test.ts` do. Everything
 * between the component and the native player is the shipped code: press →
 * `skipBy` → `clampSeekTime` → `getPlayerOrNull()` → `seekTo`. Assertions land
 * on the FAKE player's `seekTo` — never on a spy of the component's internals,
 * because a spy passes even if the component stopped calling the store at all.
 *
 * ## `lucide-react-native` is imported NORMALLY, and that took a config fix
 * `jest.config.js`'s `transformIgnorePatterns` allowlists packages by prefix
 * after `node_modules/`, and `lucide-react-native` used to match NONE of them.
 * Its `react-native` export condition then resolves to
 * `dist/esm/lucide-react-native.mjs` — real ESM — and every suite that imports
 * it died at IMPORT time with `SyntaxError: Unexpected token 'export'`, before a
 * single assertion ran.
 *
 * This file used to work around that with a `jest.mock` bridge reaching into
 * the installed CJS build through an absolute `__dirname` path (the package's
 * `exports` map hides `./dist/cjs/*`). That bridge is DELETED, deliberately: it
 * was a test-only channel into a package the app itself imports normally, so it
 * made a config defect look like a passing suite and would have hidden the next
 * one. The fix is in `jest.config.js` — the allowlist entry plus an `.mjs`
 * transform, since an un-allowlisted `.mjs` matches no transform rule at all.
 *
 * The icons under test are therefore still the REAL lucide components resolved
 * the same way Metro resolves them, and the glyph assertions below read their
 * actual path data — a stronger claim than checking a name.
 *
 * ## The icons are asserted by their PATH, not by component name
 * The plan is explicit that the source's `SkipForward` / `SkipBack` are
 * semantically wrong — these are rewind/advance WITHIN a clip, not item
 * navigation. Both glyphs exist in `lucide-react-native@1.48.0`
 * (`dist/cjs/lucide-react-native.js:6380` `RotateCcw`, `:6392` `RotateCw`), and
 * `react-native-svg` does not forward a `testID` to the native view, so there is
 * no testID to query. Reading the `d` attribute is the only way to see which
 * glyph actually rendered, and it also pins the SIZE and STROKE, which a name
 * could not.
 *
 * ## TIMERS
 * Nothing here animates, so there are no fake timers and no `getAnimatedStyle`
 * anywhere in this file. `reanimatedHarness.test.tsx` and
 * `WaveformBars.test.tsx` are the references for the rule that DOES apply —
 * `props.style` is frozen at the initial value for an ANIMATED property, so an
 * assertion written against one is a false pass. Every style read below is a
 * STATIC style (`StyleSheet.flatten` on the resolved `props.style`), which is
 * legitimate for the same reason those files distinguish the two.
 *
 * ## RESPONSER BOUNDARY
 * `fireEvent.press` is not the whole story for a DISABLED control. RNTL's
 * `isEventEnabled` consults the host's own `onStartShouldSetResponder()`, which
 * `Pressability` derives from `disabled` — so a `fireEvent` at a disabled
 * button is swallowed by the HARNESS, and an assertion written that way would
 * pass without the component doing anything. Every "does not seek" claim
 * therefore asserts `onStartShouldSetResponder() === false` explicitly, which is
 * the load-bearing property, AND fires the press.
 */

import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { createAudioPlayer } from 'expo-audio';

import {
  ClipTransport,
  SERVED_CARD_STATUSES,
  SKIP_BUTTON_SIZE,
  SKIP_ICON_SIZE,
  TERMINAL_CARD_STATUSES,
  canSkipClip,
} from '../ClipTransport';
import { formatTime } from '../../../lib/formatTime';
import { SKIP_SECONDS } from '../../../lib/skipSeconds';
import { accessibility, accent, border, content, glass, radius } from '../../../design/tokens';
import { onAccent } from '../../ui/primitives';
import {
  getPlayer,
  releasePlayer,
  usePlayerStore,
  type CardStatus,
  type PlaybackState,
  type PlayerState,
} from '../../../store/player';

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));

type FakePlayer = {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  release: jest.Mock;
};

const CLIP_ID = 'clip-a';
const OTHER_CLIP_ID = 'clip-b';
const DURATION = 60;
/** Half a minute in, so ±10 s lands well inside [0, duration] from both sides. */
const MIDPOINT = 30;
const TITLE = 'Rain on a tin roof';

/** The two path `d` strings of the real lucide glyphs, read from the package. */
const ROTATE_CCW_PATHS = ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'];
const ROTATE_CW_PATHS = ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'];
const SKIP_BACK_PATHS = [
  'M19 20 9 12l10-8v16Z',
  'm5 19-8-7 8-7v14Z',
];
const SKIP_FORWARD_PATHS = ['m5 4 10 8-10 8V4Z', 'm19 4-8 8 8 8V4Z'];

let fakePlayer: FakePlayer;

const makeFakePlayer = (): FakePlayer => ({
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  release: jest.fn(),
});

/** Store write, the way `syncFromPlayer` would leave it. */
const seedStore = (o: {
  currentTime?: number;
  duration?: number;
  cardStatus?: CardStatus;
  playback?: PlaybackState;
  playingClipId?: string | null;
  handsFree?: boolean;
}) => {
  usePlayerStore.setState({
    currentTime: o.currentTime ?? 0,
    duration: o.duration ?? DURATION,
    cardStatus: o.cardStatus ?? 'idle',
    playback: o.playback ?? 'playing',
    playingClipId: o.playingClipId === undefined ? CLIP_ID : o.playingClipId,
    handsFree: o.handsFree ?? true,
  } satisfies Partial<PlayerState>);
};

/** Store write on a mounted tree, so React is not updated outside `act`. */
const setStore = async (patch: Partial<PlayerState>) => {
  await act(async () => {
    usePlayerStore.setState(patch);
  });
};

/** RNTL v14's `render` is async, so the queries live on the awaited value. */
type TestElement = ReturnType<Awaited<ReturnType<typeof render>>['getByTestId']>;

/** Every `d` attribute in the tree, in render order. */
const pathData = (view: RenderResult): string[] =>
  view.container.queryAll((n) => typeof n.props?.d === 'string').map((n) => String(n.props.d));

/**
 * The `d` attributes inside one control's subtree, in render order.
 *
 * `TestInstance.queryAll` is the v14 API — RNTL v14 REMOVED the element-level
 * `find` / `findAll` / `findAllByType` queries, so a subtree is reached through
 * the instance the standard queries return, not through a scoped query set.
 */
function pathsUnder(control: TestElement): string[] {
  return control
    .queryAll((n) => typeof n.props?.d === 'string')
    .map((n) => String(n.props.d));
}

/** The single descendant whose flattened style has `borderRadius: radius.full`. */
function circleUnder(control: TestElement): TestElement {
  const matches = control.queryAll(
    (n) =>
      (StyleSheet.flatten((n.props?.style as never) ?? {}) as { borderRadius?: number })
        ?.borderRadius === radius.full,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0] as TestElement;
}

/** The descendant rendered as an Svg, which carries lucide's width/height. */
function svgUnder(control: TestElement): TestElement {
  const matches = control.queryAll((n) => String(n.type).includes('Svg'));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0] as TestElement;
}

/** A STATIC style — nothing here is animated, so `props.style` is not frozen. */
function styleOf(element: { props: Record<string, unknown> }): Record<string, unknown> {
  const raw = element.props.style;
  // RN's `Pressable` resolves a function style into the host's `style` prop, but
  // resolving it here as well keeps the helper honest if that ever changes.
  const resolved =
    typeof raw === 'function'
      ? (raw as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return StyleSheet.flatten(resolved as never) as Record<string, unknown>;
}

const ROOT = 'clip-transport';
const TIMECODE = 'clip-transport-timecode';
const REWIND = 'clip-transport-rewind';
const ADVANCE = 'clip-transport-advance';
const TOGGLE = 'clip-transport-hands-free';
const PILL = 'clip-transport-hands-free-pill';
const DOT = 'clip-transport-hands-free-dot';

/**
 * Every `onPress` on this instance or above it, walking the real ancestor chain.
 *
 * RNTL resolves a press from the node the touch hit, walking UP to the nearest
 * handler (`dist/fire-event.js`, `findEventHandler`), which is the platform's
 * rule as well: the hit view names the target, and the responder is found among
 * its ancestors. That last hop is why the missing ancestor hop is not a no-op —
 * without it, `fireEvent.press(advanceButton)` would find nothing, and the press
 * would silently go nowhere.
 *
 * Used to prove there is NOTHING above the transport's root to handle a press
 * that lands on its own box — see the "not being a touch target itself" block.
 */
function pressHandlersAtOrAbove(node: TestElement): string[] {
  const found: string[] = [];
  for (let n: TestElement | null = node; n !== null; n = n.parent) {
    if (typeof n.props?.onPress === 'function') found.push(String(n.type));
  }
  return found;
}

const renderTransport = (props: { clipId?: string; title?: string } = {}) =>
  render(<ClipTransport clipId={props.clipId ?? CLIP_ID} title={props.title} />);

describe('ClipTransport', () => {
  beforeEach(() => {
    // `releasePlayer`, not `reset`: it also clears the module-level `instance`
    // slot, so `getPlayerOrNull()` cannot hand a previous test's player to this
    // one. Then a fake native player so `skipBy` has something to call.
    releasePlayer();
    fakePlayer = makeFakePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(fakePlayer);
    getPlayer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The timecode
  // -------------------------------------------------------------------------

  describe('the timecode', () => {
    it('renders "position / total" once a duration is reported', async () => {
      // WaveformBar.tsx:59 — `${formatTime(duration * progress)} / ${formatTime(duration)}`,
      // with the two halves both from `formatTime` so they cannot disagree on the
      // spelling. `3.4` is a float on purpose: the store samples every 500 ms.
      seedStore({ currentTime: 3.4, duration: 12 });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(TIMECODE).props.children).toBe('0:03 / 0:12');
    });

    it('omits the total until the source reports a duration, rather than showing "0:00"', async () => {
      // `duration === 0` is the NORMAL pre-load state on both platforms
      // (store/player.ts §UNITS; SeekProgressBar's fact 1), not an error.
      // "0:03 / 0:00" is a worse sentence than "0:03".
      seedStore({ currentTime: 3.4, duration: 0 });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(TIMECODE).props.children).toBe('0:03');
      expect(getByTestId(TIMECODE).props.children).not.toContain('/');
    });

    it('reads 0:00 before anything has loaded, and never a non-finite value', async () => {
      // The store coerces non-finite times once (`coerceNativeTimes`), but the
      // formatter is a second consumer and must not be the second place the same
      // bad number fails. `lib/formatTime.ts` decides the rendering; this pins
      // that the component feeds it the raw store value rather than something it
      // invented.
      seedStore({ currentTime: Number.NaN, duration: 12 });
      const { getByTestId } = await renderTransport();
      expect(getByTestId(TIMECODE).props.children).toBe('0:00 / 0:12');

      await setStore({ currentTime: Number.POSITIVE_INFINITY });
      expect(String(getByTestId(TIMECODE).props.children)).not.toContain('Infinity');
      expect(getByTestId(TIMECODE).props.children).toBe('0:00 / 0:12');

      await setStore({ currentTime: -7 });
      expect(getByTestId(TIMECODE).props.children).toBe('0:00 / 0:12');
    });

    it('uses tabbed figures and the source\'s 11px / --outline / 0.03em', async () => {
      // WaveformBar.tsx:57-60. `fontVariantNumeric: 'tabular-nums'` is
      // load-bearing rather than decorative: with proportional digits the string
      // changes width every time the seconds digit changes, so the two halves
      // jitter apart twice a second. RN spells it `fontVariant`.
      seedStore({ currentTime: 3, duration: 12 });
      const { getByTestId } = await renderTransport();
      const style = styleOf(getByTestId(TIMECODE));

      expect(style.fontSize).toBe(11);
      expect(style.color).toBe(content.tertiary);
      expect(style.letterSpacing).toBeCloseTo(0.03, 6);
      expect(style.fontVariant).toEqual(['tabular-nums']);
      expect(style.textTransform).toBe('uppercase');
    });

    it('is announced with the same "x of y" spelling the seek bar speaks', async () => {
      // `SeekProgressBar` puts `${formatTime(now)} of ${formatTime(max)}` in its
      // `accessibilityValue.text`. Two controls on one reel describing the same
      // instant in two spellings is a VoiceOver bug waiting to happen — and the
      // spelling used to be riskier than it looks, because that bar carried its
      // own copy of the formatter until it was collapsed onto `lib/formatTime`.
      // The cross-consumer assertion (both controls rendered on one tree) lives
      // in `SeekProgressBar.test.tsx`; this is the transport's half.
      seedStore({ currentTime: 12, duration: DURATION });
      const { getByTestId } = await renderTransport({ title: TITLE });
      const timecode = getByTestId(TIMECODE);

      expect(timecode.props.accessible).toBe(true);
      expect(timecode.props.accessibilityRole).toBe('text');
      expect(timecode.props.accessibilityLabel).toBe('0:12 of 1:00');
      // ...built from the shared rule rather than a literal in this file, so the
      // two spellings cannot drift independently.
      expect(timecode.props.accessibilityLabel).toBe(
        `${formatTime(12)} of ${formatTime(DURATION)}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // The skip pair: what a press actually does
  // -------------------------------------------------------------------------

  describe('skipBy', () => {
    it('seeks +10 s from the forward button and -10 s from the rewind button', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(ADVANCE));
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(MIDPOINT + SKIP_SECONDS);

      await fireEvent.press(getByTestId(REWIND));
      expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(MIDPOINT - SKIP_SECONDS);
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(2);
    });

    it('goes through skipBy rather than seekToSeconds, so there is ONE clamp', async () => {
      // `clampSeekTime` is documented as the only place the seek bounds live
      // (store/player.ts). A component that re-derived them would be a second
      // copy of the one rule whose failure mode is a seek on an idle player.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const view = await renderTransport();
      const player = jest.requireActual<typeof import('../../../store/player')>(
        '../../../store/player',
      );
      const spy = jest.spyOn(player, 'skipBy');

      await fireEvent.press(view.getByTestId(ADVANCE));
      expect(spy).toHaveBeenLastCalledWith(SKIP_SECONDS);

      await fireEvent.press(view.getByTestId(REWIND));
      expect(spy).toHaveBeenLastCalledWith(-SKIP_SECONDS);

      spy.mockRestore();
    });

    it('does not write currentTime optimistically', async () => {
      // `skipBy` deliberately does not, and neither may a caller: a seek emits
      // an immediate status update on all three platforms, so the store corrects
      // itself within one `updateInterval`. An optimistic write would be a second
      // source of truth that can disagree with native — visibly, as the timecode
      // snapping back to the pre-skip value one tick later.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(ADVANCE));

      expect(usePlayerStore.getState().currentTime).toBe(MIDPOINT);
      // The skip is nonetheless real: native was told.
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(MIDPOINT + SKIP_SECONDS);
    });

    it('sends ONE seek per press', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(ADVANCE));
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // The clip boundary: the decision, pinned
  // -------------------------------------------------------------------------

  describe('at a clip boundary, the buttons stay ENABLED and the clamp answers', () => {
    // THE DECISION: rewind at t=2 s is NOT disabled. `clampSeekTime` turns the
    // request into 0, which is exactly what the user asked for ("earlier than
    // this"). Disabling it would make availability depend on POSITION, so the
    // control would go dead for reasons the label never states and a screen
    // reader would see a state change it cannot explain. The only genuinely
    // dangerous press is one on an UNLOADED player — Android stores that seek and
    // applies it to the NEXT clip (`Playable.kt:31`) — and that is a property of
    // "nothing is loaded", not of "we are near the start".
    it('rewinds to 0 at t=2, and does NOT send a negative position', async () => {
      seedStore({ currentTime: 2, duration: DURATION });
      const { getByTestId } = await renderTransport();
      const rewind = getByTestId(REWIND);

      expect(rewind.props.accessibilityState).toEqual({ disabled: false });
      expect(rewind.props.onStartShouldSetResponder()).toBe(true);

      await fireEvent.press(rewind);

      // The load-bearing assertion: 0, never -8. iOS would have built
      // `CMTime(seconds: -8.0)` out of the unclamped value.
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(0);
      expect(fakePlayer.seekTo).not.toHaveBeenCalledWith(-8);
    });

    it('advances to the duration three seconds from the end, symmetrically', async () => {
      seedStore({ currentTime: DURATION - 3, duration: DURATION });
      const { getByTestId } = await renderTransport();
      const advance = getByTestId(ADVANCE);

      expect(advance.props.accessibilityState).toEqual({ disabled: false });

      await fireEvent.press(advance);

      expect(fakePlayer.seekTo).toHaveBeenCalledWith(DURATION);
      expect(fakePlayer.seekTo).not.toHaveBeenCalledWith(DURATION + SKIP_SECONDS);
    });

    it('presses repeatedly at the boundary without drifting out of range', async () => {
      // Ten rewind presses from t=0 must not accumulate into a negative request.
      seedStore({ currentTime: 0, duration: DURATION });
      const { getByTestId } = await renderTransport();

      for (let i = 0; i < 10; i += 1) {
        await fireEvent.press(getByTestId(REWIND));
      }

      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(10);
      for (const [target] of fakePlayer.seekTo.mock.calls) {
        expect(target as number).toBeGreaterThanOrEqual(0);
        expect(target as number).toBeLessThanOrEqual(DURATION);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Gating: the three independent reasons the control is dead
  // -------------------------------------------------------------------------

  describe('gating on card state', () => {
    it('disables BOTH buttons for every terminal cardStatus, and enables them for the rest', async () => {
      // Iterated over the EXPORTED set, so adding a card status without deciding
      // it here fails a test rather than silently shipping a live-looking control
      // on a clip that will never play.
      for (const status of TERMINAL_CARD_STATUSES) {
        seedStore({ currentTime: MIDPOINT, duration: DURATION, cardStatus: status });
        const { getByTestId, unmount } = await renderTransport();

        expect({ status, ...getByTestId(REWIND).props.accessibilityState }).toEqual({
          status,
          disabled: true,
        });
        expect({ status, ...getByTestId(ADVANCE).props.accessibilityState }).toEqual({
          status,
          disabled: true,
        });
        // The responder boundary is what RNTL consults, so it is asserted
        // directly rather than inferred from a swallowed `fireEvent`.
        expect({ status, responder: getByTestId(REWIND).props.onStartShouldSetResponder() }).toEqual({
          status,
          responder: false,
        });

        await fireEvent.press(getByTestId(REWIND));
        await fireEvent.press(getByTestId(ADVANCE));
        expect(fakePlayer.seekTo).not.toHaveBeenCalled();

        await unmount();
      }

      for (const status of SERVED_CARD_STATUSES) {
        seedStore({ currentTime: MIDPOINT, duration: DURATION, cardStatus: status });
        const { getByTestId, unmount } = await renderTransport();

        expect({ status, ...getByTestId(REWIND).props.accessibilityState }).toEqual({
          status,
          disabled: false,
        });
        await fireEvent.press(getByTestId(REWIND));
        expect(fakePlayer.seekTo).toHaveBeenCalledWith(MIDPOINT - SKIP_SECONDS);

        await unmount();
      }
    });

    it('covers every cardStatus exactly once, so the two exported sets are complete', async () => {
      // The complement is the whole point of exporting BOTH. If a sixth status
      // were added to the type and to neither list, it would be "not terminal"
      // and enabled by accident.
      const all: CardStatus[] = ['idle', 'minting', ...TERMINAL_CARD_STATUSES];
      expect(new Set([...SERVED_CARD_STATUSES, ...TERMINAL_CARD_STATUSES]).size).toBe(all.length);
      expect([...SERVED_CARD_STATUSES, ...TERMINAL_CARD_STATUSES].sort()).toEqual(all.sort());
    });

    it('agrees with the rendered control over the whole cardStatus x playback matrix', async () => {
      // THE non-vacuous form of the gate. `disabled` and the handler guard are
      // the SAME `canSkipClip` result, so this is not "the two happen to match
      // today" — it is the property that they cannot be computed from different
      // things. 8 card statuses x 3 native states x loaded/unloaded, each pair
      // checked against the predicate AND against the responder boundary RNTL
      // actually consults.
      const cases: Array<{ cardStatus: CardStatus; playback: PlaybackState; duration: number }> =
        [];
      for (const cardStatus of [...SERVED_CARD_STATUSES, ...TERMINAL_CARD_STATUSES]) {
        for (const playback of ['playing', 'ended', 'error'] as const) {
          cases.push({ cardStatus, playback, duration: DURATION });
          cases.push({ cardStatus, playback, duration: 0 });
        }
      }

      for (const { cardStatus, playback, duration } of cases) {
        seedStore({ currentTime: MIDPOINT, duration, cardStatus, playback });
        const { getByTestId, unmount } = await renderTransport();
        const expected = canSkipClip({
          cardStatus,
          playback,
          duration,
          playingClipId: CLIP_ID,
          clipId: CLIP_ID,
        });

        expect({ cardStatus, playback, duration, disabled: getByTestId(REWIND).props.accessibilityState }).toEqual({
          cardStatus,
          playback,
          duration,
          disabled: { disabled: !expected },
        });
        // The enforcement point, not an inference from the swallowed press.
        expect({
          cardStatus,
          playback,
          duration,
          responder: getByTestId(REWIND).props.onStartShouldSetResponder(),
        }).toEqual({ cardStatus, playback, duration, responder: expected });
        expect({ cardStatus, playback, duration, advance: getByTestId(ADVANCE).props.accessibilityState }).toEqual({
          cardStatus,
          playback,
          duration,
          advance: { disabled: !expected },
        });

        await unmount();
      }
    });
  });

  describe('canSkipClip — the rule on its own', () => {
    it('refuses for each of its four reasons, in isolation', () => {
      const base = {
        cardStatus: 'idle' as CardStatus,
        playback: 'playing' as PlaybackState,
        duration: DURATION,
        playingClipId: CLIP_ID,
        clipId: CLIP_ID,
      };
      expect(canSkipClip(base)).toBe(true);

      // 1. terminal card
      for (const cardStatus of TERMINAL_CARD_STATUSES) {
        expect(canSkipClip({ ...base, cardStatus })).toBe(false);
      }
      // 2. nothing loaded
      expect(canSkipClip({ ...base, duration: 0 })).toBe(false);
      expect(canSkipClip({ ...base, duration: Number.NaN })).toBe(false);
      // 3. a different clip is loaded
      expect(canSkipClip({ ...base, playingClipId: OTHER_CLIP_ID })).toBe(false);
      expect(canSkipClip({ ...base, playingClipId: null })).toBe(false);
      // 4. the native player errored
      expect(canSkipClip({ ...base, playback: 'error' })).toBe(false);
    });

    it('permits every other playback state, `ended` above all', () => {
      // `ended` is LATCHED for as long as the clip is loaded, so a veto keyed on
      // it would be permanently dead on a finished clip. One entry per
      // PlaybackState, so adding an eighth state to the union without deciding
      // it here fails a test.
      const base = {
        cardStatus: 'idle' as CardStatus,
        duration: DURATION,
        playingClipId: CLIP_ID,
        clipId: CLIP_ID,
      };
      for (const playback of [
        'idle',
        'loading',
        'buffering',
        'playing',
        'paused',
        'ended',
      ] as const) {
        expect(canSkipClip({ ...base, playback })).toBe(true);
      }
    });

    it('is a function of four fields, so availability cannot depend on the playhead', () => {
      // The clip-boundary decision, as a property of the SIGNATURE: position is
      // not an input. The component calls `canSkipClip({cardStatus, playback,
      // duration, playingClipId, clipId})` and there is no `currentTime` to pass,
      // so a rewind at t=2 and a rewind at t=59 take the identical branch. The
      // boundary is `clampSeekTime`'s job; the render tests above confirm the
      // button is lit at both ends.
      expect(Object.keys(canSkipClip).length).toBe(0);
      // Spelled out so the claim is checkable: the gate sees 4 of the store's 8
      // number/bool fields, and `currentTime` is not among them.
      const store = usePlayerStore.getState();
      const input = {
        cardStatus: store.cardStatus,
        playback: store.playback,
        duration: store.duration,
        playingClipId: store.playingClipId,
        clipId: CLIP_ID,
      };
      expect(Object.keys(input).sort()).toEqual([
        'cardStatus',
        'clipId',
        'duration',
        'playback',
        'playingClipId',
      ]);
      expect(Object.keys(input)).not.toContain('currentTime');
    });
  });

  describe('gating on what is loaded', () => {
    it('is disabled when nothing is loaded (duration 0), and never seeks', async () => {
      // `duration === 0` IS the store's "nothing to seek within" signal, and it
      // is the same predicate `clampSeekTime` refuses on. On Android a seek
      // issued while the player is idle is STORED by ExoPlayer and applied to the
      // NEXT clip (`Playable.kt:31`), so this is a correctness fix rather than
      // padding.
      seedStore({ currentTime: 0, duration: 0, playingClipId: null });
      const { getByTestId } = await renderTransport();

      for (const id of [REWIND, ADVANCE]) {
        const button = getByTestId(id);
        expect(button.props.accessibilityState).toEqual({ disabled: true });
        expect(button.props.onStartShouldSetResponder()).toBe(false);
        await fireEvent.press(button);
      }
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('is disabled when the store is playing a DIFFERENT clip', async () => {
      // A reel under momentum scroll can have a neighbour mounted. Without this,
      // a transport for reel 2 would seek reel 1 — the identity half of what
      // `SeekProgressBar.stillCurrent` checks at gesture commit.
      seedStore({ currentTime: MIDPOINT, duration: DURATION, playingClipId: OTHER_CLIP_ID });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(REWIND).props.accessibilityState).toEqual({ disabled: true });
      await fireEvent.press(getByTestId(ADVANCE));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });

    it('is enabled again as soon as that clip becomes the loaded one', async () => {
      // The gate is a fact about the store, not a latch: swiping back must not
      // leave a permanently dead control.
      seedStore({ currentTime: MIDPOINT, duration: DURATION, playingClipId: OTHER_CLIP_ID });
      const { getByTestId } = await renderTransport();
      expect(getByTestId(REWIND).props.accessibilityState).toEqual({ disabled: true });

      await setStore({ playingClipId: CLIP_ID });
      expect(getByTestId(REWIND).props.accessibilityState).toEqual({ disabled: false });

      await fireEvent.press(getByTestId(REWIND));
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(MIDPOINT - SKIP_SECONDS);
    });
  });

  // -------------------------------------------------------------------------
  // `ended` is LATCHED, so the timecode must not key on it
  // -------------------------------------------------------------------------

  describe('`ended` — latched, and deliberately unhandled', () => {
    it('shows the real end position rather than 0:00 or a snapped value', async () => {
      // `ended` is LATCHED in `endedForClipId` for as long as the clip is loaded
      // (store/player.ts §`endedForClipId`), because `didJustFinish` is a
      // ONE-TICK pulse on both native platforms. Any rule keyed on `ended` would
      // therefore hold until the user swipes — a rule with a LIFETIME. The
      // timecode renders the store's `currentTime` unconditionally, so it needs
      // no state and cannot be wrong for the duration of the latch.
      seedStore({
        currentTime: DURATION,
        duration: DURATION,
        playback: 'ended',
        endedForClipId: CLIP_ID,
      } as Partial<PlayerState>);
      usePlayerStore.setState({ endedForClipId: CLIP_ID });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(TIMECODE).props.children).toBe('1:00 / 1:00');
      // The old app's rule (`isThisPlaying ? formatTime(progress) : '0:00'`,
      // feed/ReelCard.tsx:263-264) would have rendered "0:00 / 1:00" here: a clip
      // that played to the end, shown as never started.
      expect(getByTestId(TIMECODE).props.children).not.toBe('0:00 / 1:00');
    });

    it('does not snap the display to the duration for a clip abandoned early', async () => {
      // The other rejected rule (`ended ? duration : currentTime`) is a lie in
      // the opposite direction, and the latch makes it a lie that persists.
      seedStore({ currentTime: 4, duration: DURATION, playback: 'ended' });
      usePlayerStore.setState({ endedForClipId: CLIP_ID });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(TIMECODE).props.children).toBe('0:04 / 1:00');
    });

    it('stays ENABLED on a finished clip, because that is when a user rewinds', async () => {
      // A veto keyed on `ended` would leave the transport permanently dead on
      // every clip that ran to the end — which is exactly when a user most wants
      // to hear the last ten seconds again. `SeekProgressBar` refuses an `ended`
      // veto for the same reason (`SeekProgressBar.tsx:376-381`).
      seedStore({ currentTime: DURATION, duration: DURATION, playback: 'ended' });
      usePlayerStore.setState({ endedForClipId: CLIP_ID });
      const { getByTestId } = await renderTransport();
      const rewind = getByTestId(REWIND);

      expect(rewind.props.accessibilityState).toEqual({ disabled: false });
      expect(rewind.props.onStartShouldSetResponder()).toBe(true);

      await fireEvent.press(rewind);
      expect(fakePlayer.seekTo).toHaveBeenCalledWith(DURATION - SKIP_SECONDS);
    });

    it('is disabled on a native playback error, which is not the same thing', async () => {
      // `playback === 'error'` is a live media failure: there is nothing to seek
      // within, and `ReelCard.CardStatusView` already renders it as a failure.
      seedStore({ currentTime: MIDPOINT, duration: DURATION, playback: 'error' });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(REWIND).props.accessibilityState).toEqual({ disabled: true });
      await fireEvent.press(getByTestId(REWIND));
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The accessibility floor
  // -------------------------------------------------------------------------

  describe('the touch target floor', () => {
    it('meets the platform minimum on the LAYOUT BOX of both skip buttons', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      for (const id of [REWIND, ADVANCE]) {
        const style = styleOf(getByTestId(id));
        // jest-expo runs as ios, so `MIN_TOUCH_TARGET` is the 44 pt floor here;
        // the Android arm is the 48 dp one and arrives through the same
        // `Platform.select` with no other difference in this layout.
        const floor =
          Platform.OS === 'android'
            ? accessibility.minTouchTargetAndroid
            : accessibility.minTouchTargetIOS;

        expect(style.minWidth).toBeGreaterThanOrEqual(floor);
        expect(style.minHeight).toBeGreaterThanOrEqual(floor);
        expect(style.alignItems).toBe('center');
        expect(style.justifyContent).toBe('center');
      }

      expect(accessibility.minTouchTargetIOS).toBe(44);
      expect(accessibility.minTouchTargetAndroid).toBe(48);
    });

    it('keeps the VISUAL circle at the source 40 px, and admits that 40 fails both floors', async () => {
      // The source's `width/height: 40` (ReelCard.tsx:301,309) is a tracked
      // design value, and the column is composed around it — but on its own it
      // fails 44 pt AND 48 dp. The two-box resolution is what lets both facts be
      // true at once: the visual is 40, the target is the floor, and nothing
      // paints outside the 40 px circle.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      const target = styleOf(getByTestId(REWIND));
      const circleStyle = styleOf(circleUnder(getByTestId(REWIND)));

      expect(circleStyle.width).toBe(SKIP_BUTTON_SIZE);
      expect(circleStyle.height).toBe(SKIP_BUTTON_SIZE);
      expect(SKIP_BUTTON_SIZE).toBe(40);

      // The justification, stated as an inequality so a future edit cannot
      // quietly re-justify the 40 px.
      expect(SKIP_BUTTON_SIZE).toBeLessThan(accessibility.minTouchTargetIOS);
      expect(SKIP_BUTTON_SIZE).toBeLessThan(accessibility.minTouchTargetAndroid);
      expect(target.minWidth as number).toBeGreaterThan(SKIP_BUTTON_SIZE);
      expect(target.minHeight as number).toBeGreaterThan(SKIP_BUTTON_SIZE);
    });

    it('reproduces the source circle: glass surface, hairline border, full radius', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();
      const style = styleOf(circleUnder(getByTestId(REWIND)));

      // `background: var(--surface-overlay)` (ReelCard.tsx:304) is `glass.background`
      // (globals.css:60), and the source's `rgba(255,255,255,0.2)` border is
      // replaced by the token for a hairline on a glass surface, `border.default`
      // — the same one `uiStyles.glass` uses. The one deliberate departure.
      expect(style.backgroundColor).toBe(glass.background);
      expect(style.backgroundColor).toBe('rgba(18, 20, 22, 0.6)');
      expect(style.borderColor).toBe(border.default);
      expect(style.borderWidth).toBe(StyleSheet.hairlineWidth);
      expect(style.borderRadius).toBe(radius.full);
      expect(style.borderRadius).toBe(9999);
    });

    it('gives the toggle a floor-sized target around a much smaller pill', async () => {
      // Header.tsx:92-95 — `text-[11px] px-3 py-1.5` is a ~28 px pill, which fails
      // both floors outright. Same resolution: the box is the target, the pill is
      // the visual inside it.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      const target = styleOf(getByTestId(TOGGLE));
      const floor =
        Platform.OS === 'android'
          ? accessibility.minTouchTargetAndroid
          : accessibility.minTouchTargetIOS;
      expect(target.minHeight).toBeGreaterThanOrEqual(floor);
      expect(target.minWidth).toBeGreaterThanOrEqual(floor);

      const pill = styleOf(getByTestId(PILL));
      expect(pill.paddingVertical).toBe(6);
      expect(pill.paddingHorizontal).toBe(12);
      expect(pill.borderRadius).toBe(radius.sm);
      // 11px text + 2x6 padding = a 23 px pill: well under the floor, which is
      // precisely why it is not the target.
      expect(pill.paddingVertical as number).toBeLessThan(floor);
    });

    it('carries hitSlop on every control, and it does not make the pair overlap', async () => {
      // The house `hitSlop` (primitives.ts:53) is 8 per side. The target box
      // already clears the floor, so the hitSlop is belt-and-braces rather than
      // load-bearing — it is applied anyway because the brief requires it where
      // the visual is smaller than the target, and the arithmetic below is what
      // makes it safe: the two targets sit on a 16 dp column gap (ReelCard.tsx:
      // 299), so 8 + 8 of expansion meets at the midpoint and does not cross.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      for (const id of [REWIND, ADVANCE, TOGGLE]) {
        expect(getByTestId(id).props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
      }

      const expanded = SKIP_BUTTON_SIZE + 16;
      expect(expanded).toBeGreaterThanOrEqual(accessibility.minTouchTargetIOS);
      expect(expanded).toBeGreaterThanOrEqual(accessibility.minTouchTargetAndroid);
      // Half of each expansion is 8, and the gap is 16: touching, not overlapping.
      expect(8 * 2).toBeLessThanOrEqual(16);
    });
  });

  // -------------------------------------------------------------------------
  // The container must not be a touch target
  // -------------------------------------------------------------------------

  /**
   * THE DEAD ZONE, and what this harness can and cannot prove about it.
   *
   * `ClipTransport`'s root is a full-width band (every ancestor is a column
   * flex container, so the default `alignItems: 'stretch'` stretches it) that
   * mounts at `LAYER.transport = 21`, ABOVE `PlayOverlay`'s full-bleed
   * `Pressable` at `LAYER.overlay = OVERLAY_Z = 10`. The gap between that band
   * and the overlay's handler is the whole bug; `ReelCard.test.tsx` owns the
   * `LAYER` ordering and the `box-none` wrappers, and this file owns the one
   * thing the caller cannot fix from outside.
   *
   * A COORDINATE-LEVEL TAP TEST IS NOT FEASIBLE HERE, and the reason is worth
   * stating rather than papering over. Hit-testing is native-only and has no JS
   * implementation to drive — iOS `RCTViewComponentView.hitTest:`
   * (`:772-785`) and Android `TouchTargetHelper.findTargetTagForTouch(x, y, …)`
   * — and the RN test renderer runs NO LAYOUT ENGINE, so there are no frames
   * and no `onLayout` numbers to resolve "a point inside this band" against.
   * Any such test would have to invent the geometry it claims to measure, and
   * would then prove its own arithmetic. What IS measurable here is the tree:
   * which node a press resolves to, and which `pointerEvents` values the
   * harness gates a press on. The three tests below stay inside that.
   */
  describe('not being a touch target itself', () => {
    it('is `box-none`, the only one of the four values that is not a different bug', async () => {
      // THE REGRESSION GUARD. With no `pointerEvents` prop the container is
      // `AUTO`, i.e. it IS the hit test wherever the point lands — so the 16 px
      // gaps, the margins, and the full width either side of the centred
      // controls swallowed taps meant for play/pause and produced nothing at
      // all. `ReelCard`'s wrappers cannot cover for that: a parent's
      // `pointerEvents` removes only the PARENT from the hit test, and both
      // implementations still descend into this view and take it.
      //
      // The four values, from the installed source rather than from memory, so
      // the choice is auditable and not a habit:
      //  - `auto` (i.e. no prop)  — the dead zone above. iOS `:775-776` runs
      //    `betterHitTest` and returns `self` when nothing below it hits.
      //  - `none` — returns `nil` for the whole subtree, so it would kill the
      //    three controls this file exists for. `RCTViewComponentView.mm:777`;
      //    `TouchTargetHelper.kt:347-349` "This view and its children can't be
      //    the target".
      //  - `box-only` — offers SELF and never descends, so the container becomes
      //    the target and the controls below become unreachable.
      //    `RCTViewComponentView.mm:779-780`; `TouchTargetHelper.kt:351-352`
      //    passes `EnumSet.of(SELF)` only.
      //  - `box-none` — `RCTViewComponentView.mm:781-783` runs `betterHitTest`
      //    and returns `view != self ? view : nil`, i.e. the deepest descendant
      //    wins and "only the container would have hit" answers `nil`, which
      //    lets the search continue to whatever is behind it. Android agrees
      //    (`TouchTargetHelper.kt:363-365`, `EnumSet.of(CHILD)`, SELF not even
      //    offered). Documented equivalently in `ViewPropTypes.d.ts:181-198`.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(ROOT).props.pointerEvents).toBe('box-none');
    });

    it('all three controls still answer a press through the now-transparent container', async () => {
      // THE BEHAVIOURAL HALF, and the one that DISCRIMINATES between the four
      // values above. `box-none` has two jobs — stop the container answering,
      // keep its children answering — and only the second is observable as
      // behaviour. It is observable here because the harness gates `press` /
      // `onPress` on `isPointerEventEnabled`
      // (`@testing-library/react-native/dist/helpers/pointer-events.js:15-26`),
      // which walks the instance's own ancestors and implements the same rule as
      // both platforms: a `none` or `box-only` ANCESTOR makes the child
      // unreachable, a `box-none` one does not.
      //
      // So this test FAILS if the value on the root is ever changed to `none`
      // or `box-only` — the outcome a "just make it non-interactive" fix ships,
      // verified here rather than assumed. It passes both before and after the
      // `box-none` change: it guards the VALUE, not the prop. The prop is the
      // test above.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(ADVANCE));
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);

      await fireEvent.press(getByTestId(REWIND));
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(2);

      // ...and the control that does not touch the player at all, so "the press
      // got through" is not just "the press reached `skipBy`".
      const handsFreeBefore = usePlayerStore.getState().handsFree;
      await fireEvent.press(getByTestId(TOGGLE));
      expect(usePlayerStore.getState().handsFree).toBe(!handsFreeBefore);
    });

    it('a tap on its own box reaches no handler at all, so being a target loses the tap', async () => {
      // WHY `box-none` RATHER THAN `AUTO` — the consequence, demonstrated. In
      // this harness a press is resolved from the addressed node upwards
      // (`findEventHandler` in `dist/fire-event.js`), which is the platform's
      // rule too: the hit view names the target, and the responder is found
      // among its ancestors. Addressing a press to the container IS therefore
      // the dead-zone case, and it resolves to nothing.
      //
      // This is NOT the regression guard, and deliberately so: it passes with no
      // `pointerEvents` prop at all, because the harness does no hit-testing and
      // a missing prop is invisible to it. It pins the half the prop assertion
      // cannot state — that there is NO rescue handler above the container. The
      // overlay is a SIBLING of this column's wrapper, not an ancestor, so it is
      // never consulted either; "add a handler" is not a repair, and
      // transparency is the only one left.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();
      const root = getByTestId(ROOT);

      expect(pressHandlersAtOrAbove(root)).toEqual([]);

      const before = usePlayerStore.getState();
      await fireEvent.press(root);

      // Every mutating path this subtree could have taken, all unmoved.
      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(fakePlayer.pause).not.toHaveBeenCalled();
      expect(fakePlayer.replace).not.toHaveBeenCalled();
      const after = usePlayerStore.getState();
      expect(after.handsFree).toBe(before.handsFree);
      expect(after.playback).toBe(before.playback);
      expect(after.currentTime).toBe(before.currentTime);
    });
  });

  // -------------------------------------------------------------------------
  // Accessibility naming
  // -------------------------------------------------------------------------

  describe('naming', () => {
    it('labels each skip with its action, the amount, and the clip', async () => {
      // The source's affordance was a `title` attribute (ReelCard.tsx:307,315) —
      // a browser tooltip, invisible to VoiceOver, TalkBack, a keyboard and a
      // switch user, and invisible on a phone entirely.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport({ title: TITLE });

      for (const [id, label] of [
        [REWIND, `Rewind ${SKIP_SECONDS} seconds in ${TITLE}`],
        [ADVANCE, `Advance ${SKIP_SECONDS} seconds in ${TITLE}`],
      ] as const) {
        const button = getByTestId(id);
        expect(button.props.accessible).toBe(true);
        expect(button.props.accessibilityRole).toBe('button');
        expect(button.props.accessibilityLabel).toBe(label);
      }
    });

    it('still names the action when there is no title to name the clip with', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      expect(getByTestId(REWIND).props.accessibilityLabel).toBe(`Rewind ${SKIP_SECONDS} seconds`);
      expect(getByTestId(ADVANCE).props.accessibilityLabel).toBe(
        `Advance ${SKIP_SECONDS} seconds`,
      );
      // The step is a SHARED constant (`lib/skipSeconds.ts`) rather than a literal
      // written down here and again in `SeekProgressBar.tsx`. Two copies were kept
      // equal by hand, and only a rendered label can prove they still are — the
      // seek bar's own half of that assertion is in `SeekProgressBar.test.tsx`.
      expect(SKIP_SECONDS).toBe(10);
    });

    it('draws the rotate glyphs, not the source\'s skip-to-item glyphs', async () => {
      // The plan is explicit that SkipForward/SkipBack are semantically wrong
      // here: a skip-to-item glyph next to a vertically paging reel says "this
      // changes the reel", and it does not. `react-native-svg` drops a testID, so
      // the glyph is identified by its real path data.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const view = await renderTransport();

      expect(pathsUnder(view.getByTestId(REWIND))).toEqual(ROTATE_CCW_PATHS);
      expect(pathsUnder(view.getByTestId(ADVANCE))).toEqual(ROTATE_CW_PATHS);

      // ...and the two are MIRRORED, so a swapped pair would be caught: the CCW
      // glyph's `M3 12a9 9 0 1 0` is the CW glyph's `M21 12a9 9 0 1 1` reflected
      // about the centre line. An `expect(rewind).not.toEqual(advance)` alone
      // would pass on any two different icons.
      expect(ROTATE_CCW_PATHS[0]).not.toBe(ROTATE_CW_PATHS[0]);
      expect(pathsUnder(view.getByTestId(REWIND))).not.toEqual(
        pathsUnder(view.getByTestId(ADVANCE)),
      );
    });

    it('never draws the source glyphs the plan rejected', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const view = await renderTransport();
      const drawn = pathData(view);

      for (const d of [...SKIP_BACK_PATHS, ...SKIP_FORWARD_PATHS]) {
        expect(drawn).not.toContain(d);
      }
    });

    it('sizes the glyphs at the source\'s 16 px', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      expect(SKIP_ICON_SIZE).toBe(16);
      const svgProps = svgUnder(getByTestId(REWIND)).props as {
        width?: number;
        height?: number;
      };
      expect(svgProps.width).toBe(SKIP_ICON_SIZE);
      expect(svgProps.height).toBe(SKIP_ICON_SIZE);
    });
  });

  // -------------------------------------------------------------------------
  // The hands-free toggle
  // -------------------------------------------------------------------------

  describe('the hands-free toggle', () => {
    it('round-trips the store: off to on to off', async () => {
      seedStore({ currentTime: MIDPOINT, duration: DURATION, handsFree: false });
      const { getByTestId } = await renderTransport();
      const toggle = getByTestId(TOGGLE);

      expect(usePlayerStore.getState().handsFree).toBe(false);
      expect(toggle.props.accessibilityState).toEqual({ checked: false });

      await fireEvent.press(toggle);
      expect(usePlayerStore.getState().handsFree).toBe(true);
      expect(getByTestId(TOGGLE).props.accessibilityState).toEqual({ checked: true });

      await fireEvent.press(getByTestId(TOGGLE));
      expect(usePlayerStore.getState().handsFree).toBe(false);
      expect(getByTestId(TOGGLE).props.accessibilityState).toEqual({ checked: false });
    });

    it('follows a change made anywhere else, not just its own press', async () => {
      // It reads the store rather than holding local state, so there is exactly
      // one source of truth for the preference.
      seedStore({ currentTime: MIDPOINT, duration: DURATION, handsFree: true });
      const { getByTestId } = await renderTransport();
      expect(getByTestId(TOGGLE).props.accessibilityState).toEqual({ checked: true });

      await setStore({ handsFree: false });
      expect(getByTestId(TOGGLE).props.accessibilityState).toEqual({ checked: false });
    });

    it('is a switch, labelled with what it does', async () => {
      // `switch`, not `checkbox`: VoiceOver reads one as on/off and the other as
      // checked/unchecked, and a mode is a switch. The checked state is NOT
      // folded into the label, because `accessibilityState.checked` is announced
      // by the platform and a label repeating it would be read twice.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();
      const toggle = getByTestId(TOGGLE);

      expect(toggle.props.accessibilityRole).toBe('switch');
      expect(toggle.props.accessibilityLabel).toBe('Hands-free auto-advance');
      expect(toggle.props.accessibilityHint).toBe(
        'Clips move on by themselves once they finish',
      );
      expect(toggle.props.accessibilityLabel).not.toMatch(/on|off|enabled|disabled/i);
    });

    it('paints the ON and OFF pills differently, and shows the dot only when on', async () => {
      // Header.tsx:92-100 — `bg-[#FF6321] text-black border-[#FF6321]` when on,
      // `bg-white/5 text-white/60 border-white/10` when off, plus a 6 px dot
      // only while on. `#FF6321` is the OLD app's orange, which `tokens.ts`
      // explicitly rejects as not part of this design system; `accent.base`
      // (`--terracotta`) is the token, and `onAccent` the foreground on it.
      seedStore({ currentTime: MIDPOINT, duration: DURATION, handsFree: true });
      const on = await renderTransport();
      const onPill = styleOf(on.getByTestId(PILL));

      expect(onPill.backgroundColor).toBe(accent.base);
      expect(onPill.borderColor).toBe(accent.base);
      expect(onPill.borderRadius).toBe(radius.sm);
      expect(on.getByTestId(DOT)).toBeTruthy();
      const dot = styleOf(on.getByTestId(DOT));
      expect(dot.width).toBe(6);
      expect(dot.height).toBe(6);
      expect(dot.backgroundColor).toBe(onAccent);
      expect(accent.base).not.toBe('#FF6321');

      await setStore({ handsFree: false });
      const offPill = styleOf(on.getByTestId(PILL));
      expect(offPill.backgroundColor).not.toBe(accent.base);
      expect(offPill.borderColor).toBe(border.default);
      expect(on.queryByTestId(DOT)).toBeNull();
    });

    it('is never disabled, on any card state', async () => {
      // Hands-free is a MODE for the whole feed, not an affordance for this
      // clip's audio. Disabling it while a clip is unservable would remove the
      // only control that helps: hands-free ON is what moves the user OFF a
      // still-encoding reel, which is exactly when they reach for the toggle.
      for (const cardStatus of [...SERVED_CARD_STATUSES, ...TERMINAL_CARD_STATUSES]) {
        seedStore({
          currentTime: MIDPOINT,
          duration: DURATION,
          cardStatus,
          playingClipId: cardStatus === 'idle' ? CLIP_ID : null,
        });
        const { getByTestId, unmount } = await renderTransport();
        const toggle = getByTestId(TOGGLE);

        expect(toggle.props.onStartShouldSetResponder()).toBe(true);
        expect(toggle.props.accessibilityState).toEqual({ checked: true });

        await fireEvent.press(toggle);
        expect(usePlayerStore.getState().handsFree).toBe(false);

        await unmount();
      }
    });

    it('does not touch the player at all', async () => {
      // The control is a preference. It must not seek, replace, or play — a
      // toggle that restarted the audio would be a very hard bug to see.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(TOGGLE));

      expect(fakePlayer.seekTo).not.toHaveBeenCalled();
      expect(fakePlayer.replace).not.toHaveBeenCalled();
      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(fakePlayer.pause).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The non-vacuous checks
  // -------------------------------------------------------------------------

  describe('non-vacuity', () => {
    it('the seek assertions would fail if the transport did not seek', async () => {
      // A guard on the harness itself. Every "does not seek" test above is only
      // as good as the fact that a press CAN seek in this setup, and that is
      // asserted nowhere else in this file.
      seedStore({ currentTime: MIDPOINT, duration: DURATION });
      const { getByTestId } = await renderTransport();

      await fireEvent.press(getByTestId(ADVANCE));
      expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
    });

    it('the store is what the buttons read, not a prop passed in', async () => {
      // The convention `SeekProgressBar` sets: playback state comes from
      // `usePlayerStore`, not from props. This mounts with ONE clip and then
      // moves the store's clock, with no re-render and no prop change.
      seedStore({ currentTime: 1, duration: 12 });
      const { getByTestId } = await renderTransport();
      expect(getByTestId(TIMECODE).props.children).toBe('0:01 / 0:12');

      await setStore({ currentTime: 7, duration: 12 });
      expect(getByTestId(TIMECODE).props.children).toBe('0:07 / 0:12');
    });
  });
});
