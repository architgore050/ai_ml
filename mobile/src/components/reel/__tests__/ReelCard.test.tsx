/**
 * ReelCard — the assembled reel.
 *
 * ## WHAT IS ACTUALLY BEING GUARDED HERE
 *
 * The five components this card mounts are each tested on their own, and every
 * one of them passes in isolation. None of them can see the property that
 * matters most here, because it is a property of the ASSEMBLY:
 *
 *  1. **The paint order.** Six layers, five of them absolutely positioned or
 *     transparent, so nothing but `zIndex` decides what covers what. "The orbs
 *     are over the title", "the progress bar is under the transport" and "the
 *     scrubber is under the full-bleed tap target" are all invisible to a
 *     per-component suite and obvious on a device. The RN test renderer runs no
 *     layout engine, so the `zIndex` is the only handle on this that exists.
 *  2. **Only the active reel animates.** A feed keeps several cards mounted
 *     (`initialNumToRender: 2`, `windowSize: 3`), so passing `state="playing"`
 *     unconditionally would run 40 reanimated bars per cell forever.
 *  3. **The controls are reachable at all.** `PlayOverlay` is a full-bleed
 *     `Pressable`; anything under it loses hit-testing. This file pins both
 *     halves of that: the scrubber/transport sit ABOVE it, and no wrapper
 *     around them claims a touch down (which is what broke the feed's pager in
 *     `SeekProgressBar`'s own history).
 *  4. **The terminal state outranks `playback`** — including the identity line,
 *     which used to say "Now playing" directly above a copy saying the clip is
 *     unavailable.
 *
 * ## WHAT IS DOUBLED
 *
 * `expo-audio` alone, at the module boundary (the native edge), exactly as
 * `PlayOverlay.test.tsx`, `ClipTransport.test.tsx` and
 * `store/__tests__/player.test.ts` do. The player STORE is real, so
 * `PlayOverlay` -> `canTogglePlayback` -> `pause()` -> the native `pause` is
 * shipped code end to end, and the assertions land on the fake player rather
 * than on a spy of a component's internals.
 *
 * ## TIMERS
 *
 * `jest.useFakeTimers()` runs in `beforeEach`, BEFORE any `render`: the
 * animation schedules its first frame through `requestAnimationFrame`, which the
 * fake timers replace. Animated values are read with `getAnimatedStyle` and
 * never through `props.style` — the latter is frozen at the mount-time value,
 * so an assertion written against it passes with the clock standing still. One
 * test below re-pins that trap. `src/lib/__tests__/reanimatedHarness.test.tsx`
 * is the reference.
 *
 * ## RNTL v14
 *
 * `render` is async, and queries for `aria-hidden` subtrees (the orbs, the
 * overlay circle) need `includeHiddenElements` — which is the components being
 * right, not the test working around them.
 */

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, processColor } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { createAudioPlayer } from 'expo-audio';
import type { TestInstance } from 'test-renderer';

import { LAYER, ReelCard, cardStatusReport } from '../ReelCard';
import { OVERLAY_Z } from '../PlayOverlay';
import { BAR_COUNT, LOOP_SECONDS, envelopeFor, waveformSeed } from '../../../lib/waveform';
import { categoryColor } from '../../../design/categories';
import { gradients, surface, tintColor } from '../../../design/tokens';
import {
  getPlayer,
  releasePlayer,
  usePlayerStore,
  type CardStatus,
  type PlaybackState,
  type PlayerState,
} from '../../../store/player';
import type { FeedClip } from '../../../api/schema';

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

type FakePlayer = {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  release: jest.Mock;
};

let fakePlayer: FakePlayer;

/** The store written the way `syncFromPlayer` would leave it. */
const seedStore = (o: {
  cardStatus?: CardStatus;
  playback?: PlaybackState;
  playingClipId?: string | null;
  duration?: number;
  currentTime?: number;
}) => {
  usePlayerStore.setState({
    cardStatus: o.cardStatus ?? 'idle',
    playback: o.playback ?? 'paused',
    playingClipId: o.playingClipId === undefined ? CLIP : o.playingClipId,
    endedForClipId: o.playback === 'ended' ? (o.playingClipId ?? CLIP) : null,
    currentTime: o.currentTime ?? 0,
    duration: o.duration ?? 0,
    error: null,
  } satisfies Partial<PlayerState>);
};

const setStore = async (patch: Partial<PlayerState>) => {
  await act(async () => {
    usePlayerStore.setState(patch);
  });
};

const CLIP: string = 'clip-a';
const NEXT: string = 'clip-b';
const HEIGHT = 800;

const clip = (id: string, over: Partial<FeedClip> = {}): FeedClip => ({
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
  duration_ms: 42_000,
  ...over,
});

type Rendered = Awaited<ReturnType<typeof render>>;

const renderCard = async (over: Partial<Parameters<typeof ReelCard>[0]> = {}) =>
  render(
    <ReelCard
      clip={clip(CLIP)}
      active
      cardStatus="idle"
      playback="paused"
      durationMs={42_000}
      height={HEIGHT}
      {...over}
    />,
  );

it('mounts actionable controls above the play overlay only when the feed supplies both sheet callbacks', async () => {
  const comments = jest.fn();
  const share = jest.fn();
  const r = await renderCard({ onOpenComments: comments, onOpenShare: share });
  const layer = node(r, 'reel-layer-actions');
  expect(styleOf(layer).zIndex).toBe(LAYER.actions);
  expect(LAYER.actions).toBeGreaterThan(OVERLAY_Z);
  await fireEvent.press(r.getByTestId('action-comment'));
  await fireEvent.press(r.getByTestId('action-share'));
  expect(comments).toHaveBeenCalledTimes(1);
  expect(share).toHaveBeenCalledTimes(1);
});

/** Hidden-aware lookup — the orbs and the overlay circle are `aria-hidden`. */
const node = (r: Rendered, testID: string): TestInstance =>
  r.getByTestId(testID, { includeHiddenElements: true });

const queryNode = (r: Rendered, testID: string): TestInstance | null =>
  r.queryByTestId(testID, { includeHiddenElements: true });

/** Flatten a STATIC style. Not legitimate for an animated property. */
function styleOf(n: TestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(n.props.style) ?? {}) as Record<string, unknown>;
}

/** The LIVE animated value, via reanimated's own reader. */
const scaleYOf = (n: TestInstance): number => {
  const s = getAnimatedStyle(n) as { transform?: Array<{ scaleY?: number }> };
  return s.transform?.[0]?.scaleY ?? Number.NaN;
};

const opacityOf = (n: TestInstance): number =>
  (getAnimatedStyle(n) as { opacity?: number }).opacity ?? Number.NaN;

const barTestID = (i: number) => `waveform-bar-${i}`;
const BAR_SELECTOR = /^waveform-bar-/;

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

/* ------------------------------------------------------------------ */
/* The state space, declared once                                      */
/* ------------------------------------------------------------------ */

/**
 * `Record<CardStatus, true>` rather than an array: an array of a few hand-written
 * cases is silently incomplete, whereas omitting a member here is a COMPILE
 * error the moment the union grows. Adding a card status breaks this file
 * instead of quietly becoming unreported.
 */
const EVERY_CARD_STATUS: Record<CardStatus, true> = {
  idle: true,
  minting: true,
  processing: true,
  unavailable: true,
  gone: true,
  'auth-required': true,
  error: true,
};

const EVERY_PLAYBACK: Record<PlaybackState, true> = {
  idle: true,
  loading: true,
  buffering: true,
  playing: true,
  paused: true,
  ended: true,
  error: true,
};

const CARD_STATUSES = Object.keys(EVERY_CARD_STATUS) as CardStatus[];
const PLAYBACKS = Object.keys(EVERY_PLAYBACK) as PlaybackState[];

/* ------------------------------------------------------------------ */

describe('ReelCard', () => {
  beforeEach(() => {
    // Before the first `render`, not after — see the file header.
    jest.useFakeTimers();
    fakePlayer = {
      replace: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      seekTo: jest.fn(),
      release: jest.fn(),
    };
    (jest.requireMock('expo-audio').createAudioPlayer as jest.Mock).mockReturnValue(
      fakePlayer,
    );
    // Populates the store's module-level singleton so `pause()`/`resume()` reach
    // the fake player instead of short-circuiting on a null instance.
    getPlayer();
    seedStore({ playback: 'paused' });
  });

  afterEach(() => {
    releasePlayer();
    jest.useRealTimers();
  });

  /* ---------------------------------------------------------------- */
  describe('the layer stack', () => {
    it('gives every layer the zIndex the table declares, in the table\'s order', async () => {
      const r = await renderCard();

      // The whole assembly, as one ordered list. If a layer loses its zIndex
      // this fails; if two layers swap, the comparison below fails.
      const rendered: Array<[string, number]> = [
        ['reel-layer-backdrop', styleOf(node(r, 'reel-layer-backdrop')).zIndex as number],
        ['reel-layer-waveform', styleOf(node(r, 'reel-layer-waveform')).zIndex as number],
        ['reel-layer-content', styleOf(node(r, 'reel-layer-content')).zIndex as number],
        // The overlay carries its own zIndex (PlayOverlay sets it on the
        // Pressable), so it is read from the component, not from a wrapper.
        ['play-overlay', styleOf(node(r, 'play-overlay')).zIndex as number],
        ['reel-layer-footer', styleOf(node(r, 'reel-layer-footer')).zIndex as number],
        ['reel-layer-transport', styleOf(node(r, 'reel-layer-transport')).zIndex as number],
        ['reel-layer-progress', styleOf(node(r, 'reel-layer-progress')).zIndex as number],
      ];

      expect(rendered).toEqual([
        ['reel-layer-backdrop', LAYER.backdrop],
        ['reel-layer-waveform', LAYER.waveform],
        ['reel-layer-content', LAYER.content],
        ['play-overlay', OVERLAY_Z],
        ['reel-layer-footer', LAYER.footer],
        ['reel-layer-transport', LAYER.transport],
        ['reel-layer-progress', LAYER.progress],
      ]);
      // Strictly increasing: the list above is a claim about order, and this is
      // the claim being made true.
      const values = rendered.map(([, z]) => z);
      expect([...values].sort((a, b) => a - b)).toEqual(values);
    });

    it('anchors the stack on the source\'s own zIndex: 10, and not on tokens.zIndex', async () => {
      // ReelCard.tsx:139 `zIndex: 10`. `design/tokens.ts` HAS a zIndex group, but
      // every entry in it is app chrome (nav 200 … networkBanner 8000) and a card
      // internal must not be able to climb into that range — which is exactly why
      // `PlayOverlay` exports `OVERLAY_Z` for its caller.
      const r = await renderCard();

      expect(LAYER.overlay).toBe(OVERLAY_Z);
      expect(OVERLAY_Z).toBe(10);
      expect(LAYER.backdrop).toBeLessThan(LAYER.waveform);
      expect(LAYER.waveform).toBeLessThan(LAYER.content);
      expect(LAYER.content).toBeLessThan(LAYER.overlay);
    });

    it('puts the scrubber and the transport ABOVE the full-bleed tap target', async () => {
      // `PlayOverlay` is `StyleSheet.absoluteFill` + a Pressable, so it wins
      // hit-testing against anything under it. `PlayOverlay.tsx:86-90` makes
      // this a requirement on the caller; getting it wrong means the scrubber
      // cannot be tapped, and no component-level test can see it.
      const r = await renderCard();

      expect(LAYER.footer).toBeGreaterThan(OVERLAY_Z);
      expect(LAYER.transport).toBeGreaterThan(OVERLAY_Z);
      expect(LAYER.progress).toBeGreaterThan(OVERLAY_Z);
      // ...and the scrubber above the transport, which is the brief's own
      // named failure ("the progress bar is under the transport").
      expect(LAYER.progress).toBeGreaterThan(LAYER.transport);
      expect(LAYER.progress).toBeGreaterThan(LAYER.footer);
    });

    it('leaves the card root and every layer wrapper free of touch handlers', async () => {
      // The pager regression. A touch-capturing view INSIDE a `pagingEnabled`
      // FlatList is what `SeekProgressBar` stopped doing on purpose
      // (`onStartShouldSetPanResponder: () => false`, with the platform
      // citations), and a card root that became a Pressable would reintroduce
      // it for the whole reel.
      const r = await renderCard();
      const roots = [
        'reel-card',
        'reel-layer-backdrop',
        'reel-layer-waveform',
        'reel-layer-content',
        'reel-layer-footer',
        'reel-layer-transport',
        'reel-layer-progress',
      ];

      for (const testID of roots) {
        const props = node(r, testID).props as Record<string, unknown>;
        expect({ testID, responder: props.onStartShouldSetResponder }).toEqual({
          testID,
          responder: undefined,
        });
        expect(props.onResponderGrant).toBeUndefined();
        expect(props.onResponderRelease).toBeUndefined();
        expect(props.onResponderTerminate).toBeUndefined();
      }
    });

    it('makes the footer wrappers transparent, so their empty space cannot eat the tap', async () => {
      // `box-none`, not `auto`: a plain full-width View in the middle of the
      // stack IS a hit target, and the overlay's tap target is the whole reel.
      const r = await renderCard();

      for (const testID of [
        'reel-layer-footer',
        'reel-layer-transport',
        'reel-layer-progress',
      ]) {
        expect(node(r, testID).props.pointerEvents).toBe('box-none');
      }
    });

    it('makes the decoration itself non-interactive', async () => {
      const r = await renderCard();

      expect(node(r, 'reel-layer-backdrop').props.pointerEvents).toBe('none');
      expect(node(r, 'reel-layer-waveform').props.pointerEvents).toBe('none');
      // AmbientOrbs sets this on itself; asserting the card keeps it is the
      // half that belongs here.
      expect(node(r, 'ambient-orbs').props.pointerEvents).toBe('none');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the backdrop', () => {
    it('draws the reel gradient and the orbs, because this clip has no cover art', async () => {
      // The source's `else` branch (ReelCard.tsx:121-133 at 20451d3). The
      // gradient is `gradients.reelBackdrop`, which `AmbientOrbs` explicitly
      // leaves to the caller because only the caller also knows whether the
      // gradient should be drawn at all.
      const r = await renderCard();

      expect(node(r, 'reel-backdrop')).toBeTruthy();
      expect(node(r, 'ambient-orbs')).toBeTruthy();
      expect(node(r, 'ambient-orb-A')).toBeTruthy();
      expect(node(r, 'ambient-orb-B')).toBeTruthy();
      // ...and the cover-art branch is not what rendered.
      expect(queryNode(r, 'reel-cover-art')).toBeNull();
    });

    it('tints the orbs and the gradient from THIS clip\'s category, not a default', async () => {
      const r = await renderCard({ clip: clip(CLIP, { category: 'news' }) });
      const tint = categoryColor('news');

      expect(styleOf(node(r, 'ambient-orb-A')).backgroundColor).toBe(
        tintColor(tint, '08'),
      );
      expect(styleOf(node(r, 'ambient-orb-B')).backgroundColor).toBe(
        tintColor(tint, '0A'),
      );

      // ReelCard.tsx:103 — `linear-gradient(135deg, ${c}10 0%, ${c}22 50%,
      // #121416 100%)`, the one gradient in tokens.ts with explicit locations.
      const spec = gradients.reelBackdrop(tint);
      const backdrop = node(r, 'reel-backdrop');
      expect(backdrop.props.colors).toEqual(spec.colors.map((c) => processColor(c)));
      expect(backdrop.props.locations).toEqual([0, 0.5, 1]);
      expect(backdrop.props.startPoint).toEqual([spec.start.x, spec.start.y]);
      expect(backdrop.props.endPoint).toEqual([spec.end.x, spec.end.y]);
      // The claims themselves, so a shared-token change cannot pass unnoticed.
      expect(spec.colors).toEqual([
        tintColor(categoryColor('news'), '10'),
        tintColor(categoryColor('news'), '22'),
        surface.base,
      ]);
    });

    it('survives an unknown category, which the API allows as free text', async () => {
      // `AudioClip.category` is a `CharField` with no `choices`
      // (`models.py:112`), so an unrecognised string is a normal input.
      const r = await renderCard({ clip: clip(CLIP, { category: 'a-new-category' }) });

      expect(node(r, 'ambient-orbs')).toBeTruthy();
      expect(node(r, 'reel-backdrop')).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the decorative waveform', () => {
    it('renders the source\'s 40-bar row on every card, active or not', async () => {
      const r = await renderCard();

      expect(node(r, 'waveform-row')).toBeTruthy();
      expect(r.getAllByTestId(BAR_SELECTOR)).toHaveLength(BAR_COUNT);
    });

    it('holds a non-active card still, however long the clock runs', async () => {
      // The requirement, stated as a measurement: a feed keeps several cards
      // mounted, so an animated row on every one of them is a UI thread burning
      // frames behind reels the user is not watching. `WaveformBars` defaults
      // `state` to `'paused'` for exactly this; the card's job is not to
      // override that by accident.
      //
      // THE OFFSET IS LOAD-BEARING, and getting it wrong makes this test
      // vacuous. The clock is advanced by two WHOLE loops, which is what
      // `WaveformBars.test.tsx` does for the same reason — and a running row is
      // back at exactly its mounted value after an integer number of periods, so
      // a playing row and a paused one are indistinguishable at 2 x 10472 ms.
      // The 997 ms puts the sample off the period.
      const r = await renderCard({ active: false, playback: 'playing' });
      const before = Array.from({ length: BAR_COUNT }, (_, i) =>
        scaleYOf(node(r, barTestID(i))),
      );

      await advance(Math.ceil(LOOP_SECONDS * 1000) * 2 + 997);

      const after = Array.from({ length: BAR_COUNT }, (_, i) => scaleYOf(node(r, barTestID(i))));
      expect(after).toEqual(before);
    });

    it('moves an active, playing card — so the assertion above is not vacuous', async () => {
      const r = await renderCard({ active: true, playback: 'playing' });
      const bar = () => node(r, barTestID(20));
      const settled = scaleYOf(bar());

      await advance(Math.round(LOOP_SECONDS * 400));

      expect(scaleYOf(bar())).not.toBeCloseTo(settled, 3);
    });

    it('holds an active card still when playback is not "playing"', async () => {
      // `playback === 'playing'` and not merely `active`: a paused reel must not
      // breathe as if it were making noise, and `WaveformState` has no third
      // pose to express "active but silent".
      for (const playback of ['paused', 'buffering', 'ended', 'idle'] as const) {
        const r = await renderCard({ active: true, playback });
        const before = scaleYOf(node(r, barTestID(20)));

        await advance(Math.round(LOOP_SECONDS * 200));

        expect(scaleYOf(node(r, barTestID(20)))).toBe(before);
      }
    });

    it('reads props.style at the frozen value, so an animated read must not use it', async () => {
      // The false-pass trap, in this file's own terms. A non-active card's row
      // does not move, so its `props.style` and its live value agree — which is
      // exactly why the "holds still" test above would pass with time standing
      // still if it read the frozen prop. Here the row IS moving: after the
      // clock advances the live value has left the pose it mounted at, and the
      // flattened prop has not. See `reanimatedHarness.test.tsx` for the same
      // fact in a file that contains nothing else.
      const seed = waveformSeed(CLIP);
      const mounted = envelopeFor(20, 0, seed, 'playing');
      const r = await renderCard({ active: true, playback: 'playing' });
      const bar = node(r, barTestID(20));
      const propScaleY = () =>
        (styleOf(bar).transform as Array<{ scaleY?: number }> | undefined)?.[0]?.scaleY;

      expect(scaleYOf(bar)).toBeCloseTo(mounted, 10);
      expect(propScaleY()).toBeCloseTo(mounted, 10);

      await advance(Math.round(LOOP_SECONDS * 400));

      expect(scaleYOf(bar)).not.toBeCloseTo(mounted, 3);
      // ...and the prop is still the pose it mounted at, which is what makes the
      // read above a false pass rather than merely a slow one.
      expect(propScaleY()).toBeCloseTo(mounted, 10);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the bottom cluster', () => {
    it('mounts the transport and the scrubber on the active reel', async () => {
      const r = await renderCard();

      expect(node(r, 'clip-transport')).toBeTruthy();
      expect(node(r, 'clip-transport-timecode')).toBeTruthy();
      expect(node(r, 'clip-transport-advance')).toBeTruthy();
      expect(node(r, 'clip-transport-rewind')).toBeTruthy();
      expect(node(r, 'clip-transport-hands-free')).toBeTruthy();
      expect(node(r, 'seek-progress-bar')).toBeTruthy();
      expect(node(r, 'seek-progress-track')).toBeTruthy();
    });

    it('mounts neither on a non-active reel', async () => {
      // Not an economy: both components read `currentTime` / `duration` /
      // `playback` off the app-wide store (`SeekProgressBar.tsx:285-288`,
      // `ClipTransport.tsx:210-216`), so a mounted neighbour would draw the
      // LOADED clip's position and duration — extra scrubbers reporting a
      // position that is not theirs.
      const r = await renderCard({ active: false });

      expect(queryNode(r, 'reel-layer-footer')).toBeNull();
      expect(queryNode(r, 'clip-transport')).toBeNull();
      expect(queryNode(r, 'seek-progress-bar')).toBeNull();
    });

    it('puts the scrubber after the transport, so it is the bottom row', async () => {
      const r = await renderCard();
      const footer = node(r, 'reel-layer-footer');
      const order = footer.children
        .flatMap((c) => (Array.isArray(c) ? c : [c]))
        .filter((c): c is TestInstance => typeof c !== 'string')
        .map((c) => c.props?.testID);

      expect(order).toEqual(['reel-layer-transport', 'reel-layer-progress']);
    });

    it('hands each control this clip\'s identity', async () => {
      // The a11y labels and the gesture-identity guards are all keyed on the
      // clip id, so a card that passed its own id would seek the wrong clip.
      const r = await renderCard({ clip: clip(CLIP) });

      expect(node(r, 'seek-progress-bar').props.accessibilityLabel).toBe(
        'Seek within clip clip-a',
      );
      expect(node(r, 'clip-transport-advance').props.accessibilityLabel).toBe(
        'Advance 10 seconds in clip clip-a',
      );
      expect(node(r, 'clip-transport-rewind').props.accessibilityLabel).toBe(
        'Rewind 10 seconds in clip clip-a',
      );
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the play/pause target', () => {
    it('is mounted on the active reel, full-bleed, at the source\'s zIndex', async () => {
      const r = await renderCard();

      expect(styleOf(node(r, 'play-overlay'))).toMatchObject({
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: OVERLAY_Z,
      });
      expect(node(r, 'play-overlay').props.accessibilityRole).toBe('button');
    });

    it('is absent from a non-active reel', async () => {
      const r = await renderCard({ active: false });

      expect(queryNode(r, 'play-overlay')).toBeNull();
    });

    it('reaches `pause` on the native player when the reel is playing', async () => {
      seedStore({ cardStatus: 'idle', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ playback: 'playing' });

      await fireEvent.press(node(r, 'play-overlay'));

      expect(fakePlayer.pause).toHaveBeenCalledTimes(1);
      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().playback).toBe('paused');
    });

    it('reaches `resume` on the native player when the reel is paused', async () => {
      seedStore({ cardStatus: 'idle', playback: 'paused', playingClipId: CLIP });
      const r = await renderCard({ playback: 'paused' });

      await fireEvent.press(node(r, 'play-overlay'));

      expect(fakePlayer.play).toHaveBeenCalledTimes(1);
      expect(fakePlayer.pause).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().playback).toBe('playing');
    });

    it('labels the target from the LIVE state, not the previous one', async () => {
      seedStore({ cardStatus: 'idle', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ playback: 'playing' });
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Pause clip clip-a');

      await fireEvent.press(node(r, 'play-overlay'));

      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play clip clip-a');
    });

    it('does nothing on a terminal card', async () => {
      seedStore({ cardStatus: 'processing', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ cardStatus: 'processing', playback: 'playing' });

      await fireEvent.press(node(r, 'play-overlay'));

      expect(fakePlayer.pause).not.toHaveBeenCalled();
      expect(fakePlayer.play).not.toHaveBeenCalled();
      expect(node(r, 'play-overlay').props.accessibilityState).toMatchObject({
        disabled: true,
      });
    });

    it('does nothing when a different clip is the loaded one', async () => {
      // The neighbour case: a mounted card must never pause the clip the player
      // is actually on. (The card does not mount one at all — this asserts the
      // component's own guard, which is what protects a mid-snap window.)
      seedStore({ cardStatus: 'idle', playback: 'playing', playingClipId: NEXT });
      const r = await renderCard({ playback: 'playing' });

      await fireEvent.press(node(r, 'play-overlay'));

      expect(fakePlayer.pause).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().playback).toBe('playing');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the terminal state outranks playback', () => {
    it('renders the copy, not "Now playing", when the card is terminal', async () => {
      // The specific contradiction this removes: the identity line used to read
      // "Now playing" directly above a status box saying the clip is not
      // available.
      seedStore({ cardStatus: 'processing', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ cardStatus: 'processing', playback: 'playing' });

      expect(r.getByText('Still processing — this clip is being encoded')).toBeTruthy();
      expect(r.queryByText('Now playing')).toBeNull();
      expect(r.getByText('creator')).toBeTruthy();
    });

    it('says "Now playing" only when there is nothing to report', async () => {
      seedStore({ cardStatus: 'idle', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ playback: 'playing' });

      expect(r.getByText('Now playing')).toBeTruthy();
      expect(queryNode(r, 'reel-status')).toBeNull();
    });

    it('shows a spinner for the settling states, with no words', async () => {
      for (const [cardStatus, playback] of [
        ['minting', 'idle'],
        ['idle', 'loading'],
        ['idle', 'buffering'],
      ] as const) {
        const r = await renderCard({ cardStatus, playback });
        expect(queryNode(r, 'reel-status')).not.toBeNull();
        expect(cardStatusReport(cardStatus, playback)).toEqual({ kind: 'spinner' });
        expect(r.queryByText('Now playing')).toBeNull();
      }
    });

    it('does not distinguish a 403 from a 404', async () => {
      // SECURITY: one message for both. Saying which would tell a caller
      // holding only a UUID whether the row was gated or deleted.
      const unavailable = cardStatusReport('unavailable', 'idle');
      const gone = cardStatusReport('gone', 'idle');

      expect(unavailable).toEqual(gone);
      expect(unavailable).toEqual({ kind: 'copy', text: 'This clip is no longer available' });
    });

    it('renders no status layer on a non-active reel', async () => {
      seedStore({ cardStatus: 'error', playback: 'error', playingClipId: NEXT });
      const r = await renderCard({ active: false, cardStatus: 'error', playback: 'error' });

      expect(queryNode(r, 'reel-status')).toBeNull();
    });

    it('decides the same thing for every card status and playback pair', async () => {
      // Exhaustive over the declared state space, on the pure rule rather than
      // through 49 renders. The completeness of the space is a COMPILE-time
      // property: `EVERY_CARD_STATUS` / `EVERY_PLAYBACK` are `Record`s keyed by
      // the unions, so a new state is a build error.
      expect(CARD_STATUSES).toHaveLength(7);
      expect(PLAYBACKS).toHaveLength(7);

      const reporting = CARD_STATUSES.filter(
        (s) => cardStatusReport(s, 'paused') !== null,
      );
      // Every state except the two that mean "nothing to say" reports
      // something. A state added to the union and not handled here fails this.
      expect(reporting.sort()).toEqual(
        ['auth-required', 'error', 'gone', 'minting', 'processing', 'unavailable'].sort(),
      );

      for (const cardStatus of CARD_STATUSES) {
        for (const playback of PLAYBACKS) {
          const report = cardStatusReport(cardStatus, playback);
          if (report === null) continue;
          expect(['spinner', 'copy']).toContain(report.kind);
          if (report.kind === 'copy') {
            expect(typeof report.text).toBe('string');
            expect(report.text.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it('reads its own copy from the props and the control from the store, and conflates neither', async () => {
      // The split discipline, asserted from both sides. `ReelCard` takes BOTH
      // `cardStatus` and `playback` as props because the SCREEN owns them, and it
      // mounts three components that read the STORE instead. Two producers, two
      // read paths, and a card that derived "Now playing" from
      // `cardStatus === 'idle'` — the state a settled, playable card also reads —
      // would be permanently wrong, and the only way to notice is to move one
      // source and check the other did not follow.
      seedStore({ cardStatus: 'idle', playback: 'playing', playingClipId: CLIP });
      const r = await renderCard({ cardStatus: 'idle', playback: 'playing' });
      expect(r.getByText('Now playing')).toBeTruthy();
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Pause clip clip-a');

      // The store moves on. The control follows it; the card's own copy does not,
      // because it is told what to say by the screen.
      await setStore({ playback: 'paused' });
      expect(node(r, 'play-overlay').props.accessibilityLabel).toBe('Play clip clip-a');
      expect(r.getByText('Now playing')).toBeTruthy();

      // ...and when the screen DOES update the prop, the copy follows the prop
      // and the two never contradict each other.
      await act(async () => {
        r.rerender(
          <ReelCard
            clip={clip(CLIP)}
            active
            cardStatus="idle"
            playback="paused"
            durationMs={42_000}
            height={HEIGHT}
          />,
        );
      });
      expect(r.queryByText('Now playing')).toBeNull();
      expect(r.getByText('creator')).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the card', () => {
    it('sizes itself from the measured viewport, never from the window', async () => {
      // The zero-height-cell defect: a FlatList cell is wrapped in a View with
      // no style, so `flex: 1` alone resolves to zero and `pagingEnabled` has
      // no page to snap to. See `index.tsx`'s `viewport` docstring.
      const r = await renderCard({ height: 742 });

      expect(styleOf(node(r, 'reel-card')).height).toBe(742);
    });

    it('keeps the identity block, the category chip and the duration', async () => {
      const r = await renderCard();

      expect(r.getByText('clip clip-a')).toBeTruthy();
      expect(r.getByText('Music')).toBeTruthy();
      // `duration_ms` → seconds, via the store's own converter.
      expect(r.getByText('42s')).toBeTruthy();
    });
  });
});
