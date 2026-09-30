import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import Screen from '../index';

import { Spinner } from '../../../src/components/ui/Button';
import { NetworkBanner } from '../../../src/components/NetworkBanner';
import { useBackendStatus } from '../../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../../src/hooks/usePlaybackToken';
import { loadClip, msToSeconds, pause, usePlayerStore } from '../../../src/store/player';
import { decidePlaybackAction } from '../../../src/lib/playbackDecision';
import { SKIP_SECONDS } from '../../../src/lib/skipSeconds';
import {
  clampIndex,
  clipIdAtIndex,
  indexFromOffset,
  itemLayout,
  unambiguousViewableId,
} from '../../../src/lib/feedViewport';
import { categoryColor, categoryLabel } from '../../../src/design/categories';
import { spacing, surface } from '../../../src/design/tokens';
import { typography } from '../../../src/design/typography';
import type { FeedClip } from '../../../src/api/schema';

/**
 * Render-level tests for the feed screen's list geometry.
 *
 * The bug this exists for: `ReelCard`'s root was `flex: 1`, and a FlatList
 * cell is wrapped in a View with **no style**. In Yoga, `flex: 1` implies
 * `flexBasis: 0%`, which inside an auto-height parent resolves to **zero
 * height**, with the children overflowing. `pagingEnabled` then has no page
 * height to snap to, and `removeClippedSubviews` compounds the blankness.
 *
 * Neither `tsc` nor a pure-function test can catch that — it is a Yoga
 * resolution, and it is the single most likely reason the feed rendered
 * nothing. The screen is imported here (not re-implemented) so the assertion
 * is about the shipped component tree.
 *
 * The screen's data and transport layers are stubbed; the list, the cells, the
 * layout measurement and the scroll handlers are real.
 */

jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/hooks/useFeedBuffer', () => ({
  useFeedBuffer: jest.fn(),
  useSuggestionsFallback: jest.fn(),
}));
jest.mock('../../../src/hooks/usePlaybackToken', () => ({
  usePlaybackToken: jest.fn(),
  usePrefetchPlaybackToken: jest.fn(),
}));
/**
 * `usePlayerStore` is a Zustand hook whose selector runs against live state.
 * The mock delegates to a real store so the screen's own selectors keep
 * working, rather than faking a hook that returns whatever the test wants —
 * a hand-rolled fake hook is how a test starts asserting its own stub.
 *
 * Built inside the factory (jest forbids out-of-scope references there) and
 * reached afterwards through `jest.requireMock`.
 *
 * THE FACTORY IS AN EXHAUSTIVE LIST OF NAMES, and adding an import to
 * `src/store/player` that is missing here does NOT fail `tsc` — it makes the
 * importing component `undefined` at runtime instead. That is the failure
 * "resolves every name the reel imports from store/player" below exists to
 * catch, and it reads the names off the sources rather than off this comment.
 */
jest.mock('../../../src/store/player', () => {
  const { create } = require('zustand');
  const INITIAL = {
    queue: [],
    activeIndex: 0,
    handsFree: true,
    cardStatus: 'idle',
    playback: 'idle',
    currentTime: 0,
    duration: 0,
    playingClipId: null as string | null,
    endedForClipId: null as string | null,
    error: null as string | null,
  };
  return {
    loadClip: jest.fn(),
    pause: jest.fn(),
    // `PlayOverlay` calls `resume()` on the press that starts playback, so a
    // missing name here is a TypeError on the tap path rather than a compile
    // error.
    resume: jest.fn(),
    // `SeekProgressBar`'s tap channel commits through `clampSeekTime` and then
    // `seekToSeconds`.
    seekToSeconds: jest.fn(),
    /**
     * `null`, which is what the real `skipBy` returns when nothing is loaded
     * (`clampSeekTime`'s refusal) — and the mock store's `duration` is 0 until a
     * test seeds it.
     */
    skipBy: jest.fn(() => null),
    /**
     * A transcription of the real `clampSeekTime`, which is unit-tested in
     * `store/__tests__/player.test.ts`. It cannot be re-exported from the real
     * module: `jest.requireActual` would import `expo-audio`, whose native
     * module does not exist under jest and which crashes at import.
     */
    clampSeekTime: (requested: number, duration: number) => {
      if (!Number.isFinite(requested) || !Number.isFinite(duration)) return null;
      if (duration <= 0) return null;
      return Math.min(Math.max(requested, 0), duration);
    },
    msToSeconds: (ms: number) => ms / 1000,
    playbackStateFrom: jest.fn(() => 'idle'),
    // Mirrors the real store's shape, including the split between the card's
    // token state and the native player state. A stub with a single `status`
    // would let the screen render while hiding the very confusion this stage
    // removed.
    usePlayerStore: create((set: (p: unknown) => void) => ({
      ...INITIAL,
      setQueue: () => {},
      setActiveIndex: () => {},
      toggleHandsFree: () => {},
      setCardStatus: (cardStatus: string) => set({ cardStatus }),
      syncFromPlayer: () => {},
      // Real, unlike the rest of the doubles: the reel's own components subscribe
      // to this store, so a test that seeds it must not leak into the next one.
      reset: () => set({ ...INITIAL }),
    })),
  };
});

const mockedPlayer = jest.requireMock('../../../src/store/player') as Record<string, unknown> & {
  usePlayerStore: { getState: () => Record<string, unknown>; setState: (p: unknown) => void };
  loadClip: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  seekToSeconds: jest.Mock;
  skipBy: jest.Mock;
  clampSeekTime: unknown;
  msToSeconds: unknown;
  playbackStateFrom: unknown;
};
const playState = mockedPlayer.usePlayerStore.getState();

const mockFeed = useFeedBuffer as jest.MockedFunction<typeof useFeedBuffer>;
const mockFallback = useSuggestionsFallback as jest.MockedFunction<
  typeof useSuggestionsFallback
>;
const mockToken = usePlaybackToken as jest.MockedFunction<typeof usePlaybackToken>;
const mockLoad = loadClip as jest.MockedFunction<typeof loadClip>;

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
  ...over,
});

const feedState = (clips: FeedClip[], over: Record<string, unknown> = {}) => ({
  clips,
  loading: false,
  coolingDown: false,
  degraded: false,
  error: null as string | null,
  queueHealth: 0,
  lastEvicted: [] as string[],
  refresh: jest.fn(),
  ...over,
});

const VIEWPORT = 800;

beforeEach(() => {
  jest.clearAllMocks();
  // The mock store's `reset` is real (see the factory), because the reel's own
  // components now subscribe to it and a seeded state would leak between tests.
  usePlayerStore.getState().reset();
  mockFallback.mockReturnValue({ clips: [], loading: false, error: null });
  mockToken.mockReturnValue({ status: 'minting', clipId: null, refresh: jest.fn() });
  mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
});

// The root layout provides SafeAreaProvider; the screen alone does not, and
// `useSafeAreaInsets` throws without it. Fixed metrics so the assertions are
// not at the mercy of a mock device.
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// RNTL v14's `render` is async (it returns a Promise of the result), unlike
// v13. `await` it or every query is `undefined` and the failure looks like a
// missing element rather than a misused API.
const renderScreen = async () =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Screen />
    </SafeAreaProvider>,
  );

/**
 * Fire `onLayout` with a viewport height, the way the platform would.
 *
 * The screen is deliberately gated on this measurement (see the `viewport`
 * docstring in `index.tsx`), so a test that does not fire it never reaches
 * the list at all — and a test that asserted against the unmeasured spinner
 * would be testing the gate rather than the feed.
 */
async function measure(result: Awaited<ReturnType<typeof render>>, height = 800) {
  // `test-renderer`'s TestInstance exposes `queryAll`, not react-test-renderer's
  // `findAll`. Same idea, different name.
  const host = result.root
    ?.queryAll((n) => typeof n.props?.onLayout === 'function')
    .find((n) => Array.isArray(n.props?.style));
  await act(async () => {
    host?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
  });
  return result;
}

/**
 * The height handed to each reel card, flattened from its style array.
 *
 * SCOPED TO `reel-card` on purpose. This walked every host node when the card
 * was identity-only, and the reel now contains fixed-size decoration — the two
 * 280/200 px ambient orbs, the 60 px waveform row — whose numeric `height`
 * landed in the same array and broke the "every height is the measured
 * viewport" assertion with a value that is legitimately not a cell. Scoping to
 * the card's own root is a tightening, not a weakening: the claim is still
 * about every cell, and it can no longer be satisfied (or contradicted) by a
 * view that is not a cell.
 */
function cellHeights(view: Awaited<ReturnType<typeof render>>): number[] {
  const out: number[] = [];
  for (const node of view.root?.queryAll((n) => n.props?.testID === 'reel-card') ?? []) {
    const style = node.props?.style;
    const entries = Array.isArray(style) ? style : [style];
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && typeof entry.height === 'number') {
        out.push(entry.height);
      }
    }
  }
  return out;
}

describe('list geometry', () => {
  it('derives the settled reel from a momentum scroll, not viewability', () => {
    // The viewability latch: mid-snap both reels exceed 70% and
    // `viewableItems` is unordered, so `viewableItems[0]` can be the reel the
    // user is leaving.
    expect(indexFromOffset(VIEWPORT * 1, VIEWPORT)).toBe(1);
    expect(unambiguousViewableId(['a', 'b'])).toBeNull();
  });

  it('resolves a clamped, in-range id from the offset', () => {
    const ids = ['a', 'b'];
    const idx = indexFromOffset(VIEWPORT * 1 + 20, VIEWPORT);
    expect(clipIdAtIndex(ids, idx)).toBe('b');
    // An over-scroll at the end cannot load a clip that is off screen.
    expect(clipIdAtIndex(ids, indexFromOffset(VIEWPORT * 9, VIEWPORT))).toBeNull();
  });

  it('recovers a failed scrollToIndex without looping forever', () => {
    expect(clampIndex(99, 2)).toBe(1);
    expect(clampIndex(0, 0)).toBeNull();
  });

  it('sizes cells from the measured viewport, not the window', () => {
    expect(itemLayout(VIEWPORT, 2)).toEqual({ length: 800, offset: 1600, index: 2 });
  });
});

describe('rendering', () => {
  it('mounts without a SafeArea error and renders the feed', async () => {
    // The screen is gated on the list measurement, so before `onLayout` fires
    // it shows the loading spinner. Both that and the list are valid; a throw
    // is not. Asserting on real output rather than a snapshot, because the
    // failure this guards is a crash, not a shape change.
    const view = await renderScreen();
    expect(view.getByText('Loading feed')).toBeTruthy();
  });

  it('renders the clips once the viewport is measured', async () => {
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
    const view = await measure(await renderScreen());
    expect(view.getByText('clip a')).toBeTruthy();
    expect(view.getByText('clip b')).toBeTruthy();
  });

  /**
   * The zero-height-cell fix cannot be asserted by "the clips are on screen".
   *
   * The RN test renderer runs **no layout engine** — no Yoga, no flex
   * resolution — so `flex: 1` inside an auto-height cell does not collapse to
   * zero here, and removing the explicit height still leaves the text
   * findable. Measured: with `<View style={styles.reel}>` the render test
   * still passed 12/12.
   *
   * So the assertion has to be on the WIRING — that the measured height is
   * actually handed to each cell — and the visual fact itself has to be
   * confirmed on a device, which is Stage G. Claiming a render test proves the
   * cells are the right size would be exactly the kind of green-but-meaningless
   * result this repo keeps catching.
   */
  it('hands the measured height to every cell', async () => {
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
    const view = await measure(await renderScreen(), 742);
    // Assert on the HOST View's style, not ReelCard's props: `queryAll` walks
    // host components, and a composite function component's props are not
    // reachable through it. `{ height }` lands in the style array, which is.
    const heights = cellHeights(view);
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBe(742);
  });

  it('sizes cells from the measured height, never the window height', async () => {
    mockFeed.mockReturnValue(feedState([clip('a')]));
    // Window 844 minus a 100px tab bar is 744, not 844. A cell sized to the
    // window makes the last page unreachable and offsets every index.
    const view = await measure(await renderScreen(), 744);
    const heights = cellHeights(view);
    expect(heights[0]).toBe(744);
    expect(heights[0]).not.toBe(844);
  });

  it('does not render the list before the viewport is measured', async () => {
    mockFeed.mockReturnValue(feedState([clip('a')]));
    const view = await renderScreen();
    // Pins the gate, so a future change cannot drop it and silently ship the
    // zero-height cells.
    expect(view.queryByText('clip a')).toBeNull();
  });

  it('offers a retry when the feed errored, instead of blaming the content', async () => {
    mockFeed.mockReturnValue(feedState([], { error: 'Network request failed' }));
    const view = await measure(await renderScreen());
    // A 500 previously rendered "Nothing to play yet — pull to refresh",
    // which told the user their library was empty when the request had failed.
    expect(view.getByText("We couldn't load the feed.")).toBeTruthy();
  });

  it('does not tell the user to pull to refresh; there is no RefreshControl', async () => {
    mockFeed.mockReturnValue(feedState([], {}));
    const view = await measure(await renderScreen());
    expect(view.queryByText(/pull to refresh/i)).toBeNull();
  });

  it('offers a retry for an empty feed too, since refresh is the only action', async () => {
    const refresh = jest.fn();
    mockFeed.mockReturnValue(feedState([], { refresh }));
    const view = await measure(await renderScreen());
    expect(view.getByText('Upload a clip to get started.')).toBeTruthy();
  });

  it('says it is finding more while the 202 cool-down runs', async () => {
    mockFeed.mockReturnValue(feedState([], { coolingDown: true }));
    const view = await measure(await renderScreen());
    expect(view.getByText('Finding more for you…')).toBeTruthy();
  });

  it('exposes the pure helpers it depends on, so the test is not asserting a copy', () => {
    // Guards against this file drifting into re-implementing the screen's
    // helpers the way the deleted feedBufferLogic test did.
    expect(typeof indexFromOffset).toBe('function');
    expect(typeof clipIdAtIndex).toBe('function');
    expect(typeof itemLayout).toBe('function');
    expect(typeof unambiguousViewableId).toBe('function');
    expect(typeof clampIndex).toBe('function');
    expect(typeof decidePlaybackAction).toBe('function');
  });
});

/* ------------------------------------------------------------------ */
/* The reel, assembled                                                  */
/* ------------------------------------------------------------------ */

/**
 * Select a reel the way the app does, and let the screen's own effects run.
 *
 * `onViewableItemsChanged` is the screen's own callback (a `useRef(...).current`
 * in `index.tsx:154`), driven here with one viewable item — which is the
 * "settled on a reel" case, since mid-snap both reels clear the 70% threshold
 * and `unambiguousViewableId` deliberately returns `null` for two.
 *
 * Nothing here reaches into the screen: the node is found by the props the
 * FlatList itself was rendered with, and the handler is the shipped one.
 */
async function selectReel(
  view: Awaited<ReturnType<typeof renderScreen>>,
  item: FeedClip,
) {
  const list = view.root
    ?.queryAll(
      (n) =>
        Array.isArray(n.props?.data) &&
        typeof n.props?.onViewableItemsChanged === 'function',
    )
    .at(0);
  await act(async () => {
    list?.props.onViewableItemsChanged?.({
      viewableItems: [{ item, isViewable: true, key: item.id }],
      changed: [],
    });
  });
  return view;
}

/** Seed the store the way a successful load would leave it. */
async function seedLoaded(id: string) {
  await act(async () => {
    usePlayerStore.setState({
      cardStatus: 'idle',
      playback: 'playing',
      currentTime: 12,
      duration: 60,
      playingClipId: id,
      endedForClipId: null,
      error: null,
    });
  });
}

const token = (status: string, id: string) => ({
  status,
  clipId: id,
  refresh: jest.fn(),
});

/**
 * Every name `src/store/player` has to export for this screen's reel to mount,
 * READ OFF THE SOURCES.
 *
 * WHY A SCAN AND NOT A LIST. `jest.mock`'s factory replaces a module wholesale:
 * an import this file does not name resolves to `undefined` at runtime, and
 * `tsc` cannot see it because the real module still declares the export. A
 * hand-written list in the test would be a second place to forget — the same
 * arrangement `PlayOverlay`'s docstring warns about, where two copies of a set
 * drift until someone edits one of them. So the expectation IS the derived set.
 */
function playerNamesImportedBy(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  // `[^;]*?` and not `[\s\S]*?`: a lazy `[\s\S]` happily spans every import
  // statement between this one and the first `from '…store/player'`, which
  // collects the whole file's imports as if they were one clause.
  const match = source.match(
    /^import\s+([^;]*?)\s+from\s+['"][^'"]*store\/player['"]/m,
  );
  if (!match) return [];
  // `import { msToSeconds, type CardStatus } from …` and `import type { X } from
  // …`: a `type` import is stripped by the TS transform and never becomes a
  // runtime reference, so requiring those in the mock would be wrong. What has
  // to resolve is the VALUE import. Both the inline `type X` pair and a leading
  // `type` keyword are removed, because only the keyword is a word boundary the
  // name can hide behind.
  const clause = (match[1] ?? '')
    .replace(/\btype\s+[A-Za-z_$][\w$]*/g, '')
    .replace(/^\s*type\b\s*/, '');
  return clause.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

function playerNamesTheScreenNeeds(): string[] {
  const reelDir = join(__dirname, '..', '..', '..', 'src', 'components', 'reel');
  const files = [
    join(__dirname, '..', 'index.tsx'),
    ...readdirSync(reelDir)
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => join(reelDir, f)),
  ];
  return [...new Set(files.flatMap(playerNamesImportedBy))].sort();
}

describe('the reel, assembled', () => {
  it('resolves every name the reel imports from store/player through this mock', () => {
    const required = playerNamesTheScreenNeeds();

    // The scan has to actually find something, or a broken regex would make the
    // expectation below vacuously true.
    expect(required.length).toBeGreaterThan(5);
    expect(required).toEqual([
      'clampSeekTime',
      'loadClip',
      'msToSeconds',
      'pause',
      'resume',
      'seekToSeconds',
      'skipBy',
      'usePlayerStore',
    ]);
    // And each one resolves to something callable/usable, which is the actual
    // failure mode: `undefined` reaching a component that renders it.
    for (const name of required) {
      expect({ name, resolved: typeof mockedPlayer[name] }).not.toEqual({
        name,
        resolved: 'undefined',
      });
    }
  });

  it('draws the backdrop, the orbs and the waveform on every reel', async () => {
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
    const view = await measure(await renderScreen());

    // `ambient-orbs` is `aria-hidden` and `pointerEvents="none"` by design, so
    // RNTL v14 needs to be told it is allowed to see it.
    expect(view.getAllByTestId('ambient-orbs', { includeHiddenElements: true })).toHaveLength(2);
    expect(view.getAllByTestId('reel-backdrop')).toHaveLength(2);
    // 40 bars per cell, so 80 for two — the row is per-card, not per-screen.
    expect(view.getAllByTestId(/^waveform-bar-/)).toHaveLength(80);
  });

  it('mounts the transport, the scrubber and the play target on the ACTIVE reel only', async () => {
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
    const view = await measure(await renderScreen());

    // Nothing is active yet: `onViewableItemsChanged` has not fired, so no reel
    // is the one the user is on. Every control is a full-size target, so this is
    // also the assertion that a second reel cannot be played by accident.
    expect(view.queryByTestId('clip-transport')).toBeNull();
    expect(view.queryByTestId('seek-progress-bar')).toBeNull();
    expect(view.queryByTestId('play-overlay')).toBeNull();

    await seedLoaded('a');
    await selectReel(view, clip('a'));

    expect(view.getAllByTestId('clip-transport')).toHaveLength(1);
    expect(view.getAllByTestId('seek-progress-bar')).toHaveLength(1);
    expect(view.getAllByTestId('play-overlay')).toHaveLength(1);
  });

  it('routes a tap on the active reel to the player, through the store', async () => {
    mockFeed.mockReturnValue(feedState([clip('a')]));
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedLoaded('a');
    await selectReel(view, clip('a'));

    await fireEvent.press(view.getByTestId('play-overlay'));

    // The screen's own `pause` export, which is what `PlayOverlay` calls. The
    // store is a double here, so this is the seam: a reel that mounted a
    // different `play-overlay` (an `undefined` component, or one reading a
    // different store) would not reach it.
    expect(mockedPlayer.pause).toHaveBeenCalled();
    expect(mockedPlayer.resume).not.toHaveBeenCalled();

    // ...and the other direction, which is what a missing `resume` in the mock
    // factory actually breaks: the press throws a TypeError inside the handler
    // rather than failing a build.
    await act(async () => {
      usePlayerStore.setState({ playback: 'paused' });
    });
    await fireEvent.press(view.getByTestId('play-overlay'));

    expect(mockedPlayer.resume).toHaveBeenCalled();
  });

  it('routes the transport\'s ±10s to the store, at the shared step', async () => {
    mockFeed.mockReturnValue(feedState([clip('a')]));
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedLoaded('a');
    await selectReel(view, clip('a'));

    await fireEvent.press(view.getByTestId('clip-transport-advance'));
    await fireEvent.press(view.getByTestId('clip-transport-rewind'));

    expect(mockedPlayer.skipBy.mock.calls).toEqual([
      [SKIP_SECONDS],
      [-SKIP_SECONDS],
    ]);
  });

  it('lets the terminal state outrank playback on screen', async () => {
    // The screen-level version of the same rule `ReelCard` owns: the token
    // lifecycle reported a 403, so the card must not also be claiming to play.
    // The token drives it through the real effect — `decidePlaybackAction`'s
    // `show` arm is what calls `setCardStatus` here, not a direct store write.
    mockFeed.mockReturnValue(feedState([clip('a')]));
    mockToken.mockReturnValue(token('unavailable', 'a') as never);
    const view = await measure(await renderScreen());
    await seedLoaded('a');
    await selectReel(view, clip('a'));

    expect(view.getByText('This clip is no longer available')).toBeTruthy();
    expect(view.queryByText('Now playing')).toBeNull();
  });

  it('leaves the feed\'s own touch surface alone', async () => {
    // The pager regression guard, at the level where it would happen: no cell in
    // this list may claim a touch down, because the cell is inside a
    // `pagingEnabled` FlatList. `PlayOverlay` is the one full-size target, and
    // it is the one that is allowed to be one.
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b')]));
    const view = await measure(await renderScreen());
    await seedLoaded('a');
    await selectReel(view, clip('a'));

    const flatList = view.root
      ?.queryAll((n) => Array.isArray(n.props?.data) && n.props?.pagingEnabled === true)
      .at(0);
    expect(flatList).toBeTruthy();
    // The list is still a pager, still measured, still windowed.
    expect(typeof flatList?.props.getItemLayout).toBe('function');
    expect(typeof flatList?.props.onMomentumScrollEnd).toBe('function');
    expect(typeof flatList?.props.onScrollToIndexFailed).toBe('function');

    for (const node of view.root?.queryAll((n) => n.props?.testID === 'reel-card') ?? []) {
      expect(node.props.onStartShouldSetResponder).toBeUndefined();
      expect(node.props.onResponderGrant).toBeUndefined();
    }
  });
});
