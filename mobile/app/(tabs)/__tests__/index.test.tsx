import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FlatList } from 'react-native';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import Screen from '../index';

import { Spinner } from '../../../src/components/ui/Button';
import { NetworkBanner } from '../../../src/components/NetworkBanner';
import { useBackendStatus } from '../../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../../src/hooks/usePlaybackToken';
import { useTelemetrySkip } from '../../../src/hooks/useWatchTelemetry';
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
import {
  BUFFERING_STALL_TIMEOUT_MS,
  INTER_REEL_PAUSE_MS,
} from '../../../src/lib/handsFreeAdvance';
import type { AdvanceInfo } from '../../../src/lib/handsFreeAdvance';
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
// The feed only needs the viewer id to decide whether a comment can expose its
// own edit/delete controls. Keep this native-storage-backed store outside this
// geometry/transport suite.
jest.mock('../../../src/store/auth', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));

/**
 * The production abandonment seam, mocked wholesale so the screen's CALL
 * PATTERN can be asserted. The real handle is a module-registry singleton that
 * is inert unless a `<TelemetryHost />` is mounted, which is the right runtime
 * behaviour and the wrong thing to assert against — an inert handle makes every
 * assertion here vacuously pass.
 *
 * Exhaustive list of names: `useWatchTelemetry` also exports `useWatchTelemetry`,
 * which this screen does not use. A missing entry makes the importing component
 * `undefined` at runtime rather than a tsc error, so the list is spelled out.
 */
jest.mock('../../../src/hooks/useWatchTelemetry', () => {
  // ONE handle object shared by every render, because the real one is a
  // module-registry singleton (`hooks/useWatchTelemetry.ts` returns
  // `SKIP_HANDLE`). A factory that built a fresh object per call would hand the
  // screen a different set of spies on each render than the one the assertion
  // reads, so every assertion here would fail at 0 calls no matter what the
  // screen did. That is a test that cannot fail for the right reason.
  const handle = {
    reportUserSkip: jest.fn(),
    reportAutoAdvance: jest.fn(),
    reportAdvance: jest.fn(),
  };
  return { useWatchTelemetry: jest.fn(), useTelemetrySkip: jest.fn(() => handle), __handle: handle };
});
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
 * As above, but handing the screen the `onAdvance` seam. Kept separate from
 * `renderScreen` so the seam cannot end up wired into the tests that are not
 * about it — a reporter installed globally would make every assertion in this
 * file pass for the wrong reason.
 */
const renderScreenWithAdvance = async (onAdvance: (info: AdvanceInfo) => void) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Screen onAdvance={onAdvance} />
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

/* ------------------------------------------------------------------ */
/* Hands-free auto-advance, and the buffering timeout                   */
/* ------------------------------------------------------------------ */

/**
 * The screen is a STAND-IN for two things this suite must not fake: a timer and a
 * scroll. `shouldAutoAdvance` is unit-tested in
 * `src/lib/__tests__/handsFreeAdvance.test.ts` over the whole decision space;
 * what can only be observed here is whether the screen actually
 *
 *   - schedules on the LATCH and not on `progress`,
 *   - CANCELS the pending timer when the state stops supporting it, and
 *   - calls `scrollToIndex` with the index the decision produced.
 *
 * The cancel half is the one that matters. A timer that fires after the user has
 * already swiped advances a SECOND reel: they swipe from a to b, and a moment
 * later the timer for a's completion pages them to c, so they never saw b at
 * all. Nothing about that timer is wrong — it is acting on a state that has
 * stopped being true — which is why it is only testable through the component.
 */

/**
 * `scrollToIndex` on the list the screen holds a ref to.
 *
 * Spied on the PROTOTYPE rather than on an instance, because the screen owns
 * `listRef` and the test has no business reaching into it — and reaching in
 * would assert on the test's own handle rather than on the call the screen
 * made. `FlatList` is a class component whose `scrollToIndex` forwards to the
 * inner `VirtualizedList`, so the prototype is the shipped entry point.
 *
 * `mockImplementation(() => {})` because the real one walks the scroll
 * responder, which is not mounted in the RN test renderer (no Yoga, no
 * animation) and would throw rather than record.
 *
 * Installed by the two suites below and NOT at file scope: a file-level
 * `beforeEach` would put this spy in front of the twenty tests that predate
 * this feature, which have no business running with the list's scroll method
 * replaced.
 */
let scrollToIndex: jest.SpyInstance;

function spyOnScrollToIndex() {
  beforeEach(() => {
    scrollToIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollToIndex.mockRestore();
    // NOT `clearAllTimers`: RNTL's own auto-cleanup unmounts the tree between
    // tests, and the fake clock has to be torn down so the NEXT suite's
    // `useFakeTimers` starts from a clean one.
    jest.useRealTimers();
  });
}

spyOnScrollToIndex();

/** The store's reading of a clip that has just run to its end. */
async function seedEnded(id: string) {
  await act(async () => {
    usePlayerStore.setState({
      cardStatus: 'idle',
      playback: 'ended',
      currentTime: 60,
      duration: 60,
      playingClipId: id,
      endedForClipId: id,
      error: null,
    });
  });
}

/** Drive `onMomentumScrollEnd` — the "the user has landed on reel N" signal. */
async function swipeTo(
  view: Awaited<ReturnType<typeof renderScreen>>,
  index: number,
) {
  const list = view.root
    ?.queryAll((n) => Array.isArray(n.props?.data) && typeof n.props?.onMomentumScrollEnd === 'function')
    .at(0);
  await act(async () => {
    list?.props.onMomentumScrollEnd?.({
      nativeEvent: {
        contentOffset: { x: 0, y: VIEWPORT * index },
        contentSize: { width: 390, height: VIEWPORT * 3 },
        layoutMeasurement: { width: 390, height: VIEWPORT },
      },
    });
  });
}

/**
 * Move the fake clock.
 *
 * MUST be awaited, and MUST be RNTL's `act` rather than React's:
 * `@testing-library/react-native/dist/act.js` defines `act` as
 * `_act(async () => await callback())`, so its return value is always a
 * thenable and React's "act(...) without await" warning fires on any state
 * update the timer causes. The call sites below are therefore `await elapsed(…)`
 * throughout — the un-awaited form looks like it works and silently drops the
 * effect flush, which is how the first draft of these tests passed the advance
 * and failed the buffering half.
 */
const elapsed = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

describe('hands-free auto-advance', () => {
  beforeEach(() => {
    // BEFORE render, per `03-handoff.md` §5.11: installing the fake clock after
    // the mount leaves the screen's effects on the real one, and every assertion
    // below would be measuring real time.
    jest.useFakeTimers();
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b'), clip('c')]));
  });

  it('scrolls to the next index after the inter-reel pause', async () => {
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedEnded('a');
    await selectReel(view, clip('a'));

    // Nothing before the pause elapses: 1000 ms is the design token
    // (`pacing.interReelPause`), not a number this test chose.
    await elapsed(INTER_REEL_PAUSE_MS - 1);
    expect(scrollToIndex).not.toHaveBeenCalled();

    await elapsed(1);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true });
  });

  it('advances ONE reel per completion, not one per status tick', async () => {
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedEnded('a');
    await selectReel(view, clip('a'));

    // `ended` is LATCHED for as long as the clip is loaded
    // (`store/player.ts:393-403`), so a per-render decision would see a
    // stable-true predicate on every 500 ms tick of the whole clip.
    await elapsed(INTER_REEL_PAUSE_MS);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    await elapsed(5_000);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  /**
   * THE BUG THIS EFFECT EXISTS TO PREVENT. The user swipes from a to b while
   * a's 1000 ms advance is still pending. If the timer survives, it pages them
   * on to c and they never see b.
   */
  it('cancels the pending advance when the user swipes first — one reel, not two', async () => {
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedEnded('a');
    await selectReel(view, clip('a'));

    // 400 ms into the pause: the user decides they have had enough.
    await elapsed(400);
    expect(scrollToIndex).not.toHaveBeenCalled();
    await swipeTo(view, 1);

    // Past a's deadline, and then well past it.
    await elapsed(2_000);
    expect(scrollToIndex).not.toHaveBeenCalled();

    // ...and the reel they chose is the one they are on. b is not playing yet,
    // so nothing can finish and nothing can advance either.
    await expect(selectReel(view, clip('b'))).resolves.toBeTruthy();
    await elapsed(5_000);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('cancels the pending advance on unmount', async () => {
    // `onAdvance` is the assertion that makes this test non-vacuous, and the
    // reason is a null check in the screen: the timer callback ends in
    // `listRef.current?.scrollToIndex(...)`, and `listRef.current` is null once
    // the tree is gone. So a timer that survives unmount scrolls nothing, the
    // `scrollToIndex` assertion passes for the wrong reason, and the test is
    // green while the timer is still live. `onAdvance` has no such guard — the
    // ref holding it outlives the component — so it is what actually observes
    // the leak. Asserted on both.
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const onAdvance = jest.fn();
    const view = await measure(await renderScreenWithAdvance(onAdvance));
    await seedEnded('a');
    await selectReel(view, clip('a'));

    await elapsed(400);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
    // AWAITED. RNTL v14's `unmount` is `async` (`dist/render.js:49`), so an
    // un-awaited call leaves an act scope open: the effect cleanups do not run
    // before the clock moves, and every LATER test in this file then silently
    // stops advancing its fake clock. Every other test in this file passes; only
    // the ones after this one go red, which is what made it worth chasing
    // rather than accepting.
    await view.unmount();

    // Unmount is a distinct invalidating state from a swipe, and a timer that
    // outlives its component is the classic "setState after unmount" plus a
    // report of a transition that never happened.
    await elapsed(5_000);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('stays on the last frame when hands-free is off', async () => {
    mockToken.mockReturnValue(token('ready', 'b') as never);
    const view = await measure(await renderScreen());
    await seedEnded('b');
    await selectReel(view, clip('b'));
    await act(async () => {
      usePlayerStore.setState({ handsFree: false });
    });

    await elapsed(5_000);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('stops on the last reel rather than scrolling onto itself', async () => {
    // `clampIndex` clamps rather than refusing, so a "is there a next reel"
    // question asked of it answers yes at the end of the buffer
    // (`feedViewport.ts:60-65`). One clip means there is no next reel.
    mockFeed.mockReturnValue(feedState([clip('only')]));
    mockToken.mockReturnValue(token('ready', 'only') as never);
    const view = await measure(await renderScreen());
    await seedEnded('only');
    await selectReel(view, clip('only'));

    await elapsed(5_000);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not advance a clip whose position merely reached the end', async () => {
    // The `progress >= 0.99` rule the plan specified. A stalled player freezes
    // `currentTime` while `duration` stays known, so the ratio is 1.0 for as
    // long as the stall lasts — and the platform fires no end notification, so
    // the latch is never armed.
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await act(async () => {
      usePlayerStore.setState({
        cardStatus: 'idle',
        playback: 'buffering',
        currentTime: 60,
        duration: 60,
        playingClipId: 'a',
        endedForClipId: null,
      });
    });
    await selectReel(view, clip('a'));

    await elapsed(5_000);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  /**
   * The seam `useWatchTelemetry` consumes, and the fact that makes a skip
   * impossible: `interactionGuard.shouldRegisterSkip` checks `userInitiated`
   * first and refuses on `false` (`interactionGuard.ts:468`), which is what
   * stops every natural completion in a session from counting as an
   * abandonment — the old app's defect 2.
   *
   * The reporter is called BEFORE `scrollToIndex`, so at that instant the store
   * still names the OUTGOING clip with its real position. The telemetry hook's
   * own docstring requires exactly that ordering ("Call it SYNCHRONOUSLY …
   * BEFORE the deferred `loadClip`"), and a scroll-then-report order would
   * arrive too late to read it.
   */
  it('reports the transition as NOT user-initiated, before it scrolls', async () => {
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const onAdvance = jest.fn();
    const order: string[] = [];
    onAdvance.mockImplementation(() => order.push('onAdvance'));
    scrollToIndex.mockImplementation(() => {
      order.push('scrollToIndex');
    });

    const view = await measure(await renderScreenWithAdvance(onAdvance));
    await seedEnded('a');
    await selectReel(view, clip('a'));
    await elapsed(INTER_REEL_PAUSE_MS);

    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith({
      fromClipId: 'a',
      toClipId: 'b',
      userInitiated: false,
    });
    expect(order).toEqual(['onAdvance', 'scrollToIndex']);
  });

  it('is optional, so the screen renders with no telemetry host at all', async () => {
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await renderScreen());
    await seedEnded('a');
    await selectReel(view, clip('a'));
    // No reporter: expo-router renders a route with `{ route, navigation,
    // params }`, so an absent `onAdvance` is the normal case and must not throw
    // when the timer fires.
    await expect(elapsed(INTER_REEL_PAUSE_MS)).resolves.toBeUndefined();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });
});

describe('the buffering timeout', () => {
  /** A clip whose load is stalled, with a mintable token. */
  const seedBuffering = async (id: string) => {
    await act(async () => {
      usePlayerStore.setState({
        cardStatus: 'idle',
        playback: 'buffering',
        currentTime: 0,
        duration: 0,
        playingClipId: id,
        endedForClipId: null,
        error: null,
      });
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockFeed.mockReturnValue(feedState([clip('a'), clip('b'), clip('c')]));
  });

  it('re-mints and retries the load once, after the threshold and not before', async () => {
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'ready', clipId: 'a', token: 'tok', refresh } as never);
    const view = await measure(await renderScreen());
    await seedBuffering('a');
    await selectReel(view, clip('a'));

    // The threshold is 12 s, not a number this test chose, and it is several
    // segment fetches: `-hls_time 4` (`backend/app/tasks.py:431`).
    await elapsed(BUFFERING_STALL_TIMEOUT_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    await elapsed(1);
    // `refresh()` is `usePlaybackToken`'s existing escape hatch — evict the
    // cached token, bump the nonce, and the load effect above re-issues
    // `loadClip` with the new one. Three steps, one call, no new eviction path.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-mint a second time, however long the stall continues', async () => {
    // The loop the brief forbids: a rights-restricted or unreachable clip
    // re-minting until the 300/min `playback_token` bucket is empty. `refresh()`
    // bumps a nonce unconditionally, so without the per-clip latch every
    // re-mint would re-arm the timer.
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'ready', clipId: 'a', token: 'tok', refresh } as never);
    const view = await measure(await renderScreen());
    await seedBuffering('a');
    await selectReel(view, clip('a'));

    for (let i = 0; i < 5; i += 1) {
      await elapsed(BUFFERING_STALL_TIMEOUT_MS);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-mint a rights-restricted clip, at any stall length', async () => {
    // A 403 is unmoderated or licence-restricted. A fresh token cannot change
    // it, and `classifyTokenError` is the only thing that decides which of its
    // statuses is a rights call.
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'unavailable', clipId: 'a', refresh } as never);
    const view = await measure(await renderScreen());
    await act(async () => {
      usePlayerStore.setState({
        cardStatus: 'unavailable',
        playback: 'buffering',
        currentTime: 0,
        duration: 0,
        playingClipId: 'a',
        endedForClipId: null,
      });
    });
    await selectReel(view, clip('a'));

    await elapsed(10 * BUFFERING_STALL_TIMEOUT_MS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not re-mint a still-encoding clip, which already has its own retry', async () => {
    // 409: `index.tsx` has a 5 s `PROCESSING_RETRY_MS` timer for this, and a
    // second one here would double that request. So `refresh` is NOT expected to
    // be untouched — it is expected to be called ONCE, by the 409 timer, and
    // never again: the load effect's dependency array (`[token, activeClipId,
    // setCardStatus, pause]`) does not change when the retry lands, so that timer
    // fires once and is never re-armed.
    //
    // Over 120 s of stall a broken rights check would add ten more calls
    // (one per threshold), so the exact count is the assertion.
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'processing', clipId: 'a', refresh } as never);
    const view = await measure(await renderScreen());
    await act(async () => {
      usePlayerStore.setState({
        cardStatus: 'processing',
        playback: 'buffering',
        currentTime: 0,
        duration: 0,
        playingClipId: 'a',
        endedForClipId: null,
      });
    });
    await selectReel(view, clip('a'));

    await elapsed(10 * BUFFERING_STALL_TIMEOUT_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('gives a new clip a full budget of its own', async () => {
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'ready', clipId: 'a', token: 'tok', refresh } as never);
    const view = await measure(await renderScreen());
    await seedBuffering('a');
    await selectReel(view, clip('a'));
    await elapsed(BUFFERING_STALL_TIMEOUT_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // b stalls too, on its own clock. The latch is scoped to a clip id, so it
    // dies with `a` rather than needing a reset call nobody would remember.
    mockToken.mockReturnValue({ status: 'ready', clipId: 'b', token: 'tok2', refresh } as never);
    await act(async () => {
      usePlayerStore.setState({ playingClipId: 'b' });
    });
    await swipeTo(view, 1);
    await elapsed(BUFFERING_STALL_TIMEOUT_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not fire for a clip that is not stalling', async () => {
    // `paused`, not `playing`: the claim is "the retry is gated on
    // `buffering`", and `WaveformBars` runs a frame loop in the `playing` state,
    // so advancing the fake clock through it costs one simulated frame per tick
    // and blew the 5 s test timeout. `paused` is the cheaper instance of the
    // same claim — still loaded, still not buffering.
    const refresh = jest.fn();
    mockToken.mockReturnValue({ status: 'ready', clipId: 'a', token: 'tok', refresh } as never);
    const view = await measure(await renderScreen());
    await act(async () => {
      usePlayerStore.setState({
        cardStatus: 'idle',
        playback: 'paused',
        currentTime: 12,
        duration: 60,
        playingClipId: 'a',
        endedForClipId: null,
      });
    });
    await selectReel(view, clip('a'));

    // Well past the threshold: if the gate were anything other than
    // `playback === 'buffering'`, this would fire.
    await elapsed(10 * BUFFERING_STALL_TIMEOUT_MS);
    expect(refresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The abandonment seam
// ---------------------------------------------------------------------------

/**
 * `register-skip` is the only client path that moves `avg_completion_rate` — a
 * 30 %-of-ranking term — so WHEN this screen reports one is load-bearing, and
 * the two ways to get it wrong are both silent 201s.
 *
 * These assert the screen's CALL PATTERN against the mocked handle. The
 * arithmetic that decides whether a report is a skip at all lives in
 * `interactionGuard.shouldRegisterSkip` and is swept there (116 tests); what is
 * unique to this screen is *when* it reaches for the handle.
 */
describe('reporting an abandonment', () => {
  // The same object the screen calls; see the mock factory for why it is a
  // singleton rather than a per-render construction.
  const handle = () =>
    (jest.requireMock('../../../src/hooks/useWatchTelemetry') as {
      __handle: { reportUserSkip: jest.Mock; reportAutoAdvance: jest.Mock };
    }).__handle;

  beforeEach(() => {
    handle().reportUserSkip.mockClear();
    handle().reportAutoAdvance.mockClear();
    // BEFORE render, for the reason `03-handoff.md` section 5 records: the
    // auto-advance is a `setTimeout`, so without a fake clock `elapsed()` moves
    // nothing and the timer simply never fires — which reads as "the seam is
    // not wired" rather than "the harness cannot drive a timer". Installed
    // here rather than relying on the `hands-free auto-advance` describe's own
    // beforeEach, which does not run for these tests.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports nothing on first paint, because viewing the first reel is not a departure', async () => {
    await measure(await renderScreen());
    expect(handle().reportUserSkip).not.toHaveBeenCalled();
  });

  it('reports the departure when the user lands on a different reel', async () => {
    const view = await measure(await renderScreen());
    await swipeTo(view, 1);
    expect(handle().reportUserSkip).toHaveBeenCalledTimes(1);
  });

  it('reports NOTHING when momentum settles back onto the reel it is already on', async () => {
    // `onMomentumScrollEnd` fires for a bounce as well as a swipe. Reporting
    // that would hand `register-skip` a clip the user is still watching, which
    // the server has no lower bound for: it records a real 0.0 completion
    // sample and the 30 % term is deflated by a clip nobody left.
    const view = await measure(await renderScreen());
    await swipeTo(view, 1);
    await swipeTo(view, 1);
    await swipeTo(view, 1);
    expect(handle().reportUserSkip).toHaveBeenCalledTimes(1);
  });

  it('reports each REAL departure, including one that returns to the first reel', async () => {
    // The counter-test for the bounce guard above, because "suppress repeats"
    // is only correct if it does not become "suppress returns". a -> b and
    // b -> a are two genuine departures from two different clips; a guard that
    // deduplicated by reel would report once and silently lose the second.
    const view = await measure(await renderScreen());
    await swipeTo(view, 1);
    await swipeTo(view, 0);
    expect(handle().reportUserSkip).toHaveBeenCalledTimes(2);
  });

  it('takes no arguments, so a caller cannot attribute one clip to another', async () => {
    // The seam that prevents "clip A's 280 s of watch time reported against
    // clip B", which with B's 10 s duration as the cap is a perfect 1.0 on a
    // clip with zero seconds of listening.
    const view = await measure(await renderScreen());
    await swipeTo(view, 1);
    expect(handle().reportUserSkip).toHaveBeenCalledWith();
  });

  it('does not report an auto-advance as an abandonment', async () => {
    // `reportAutoAdvance` is a different method precisely because
    // `shouldRegisterSkip` checks `userInitiated` FIRST, before reading a
    // duration — so a natural completion can never be recorded as a skip.
    mockToken.mockReturnValue(token('ready', 'a') as never);
    const view = await measure(await measure(await renderScreen()));
    await seedEnded('a');
    await selectReel(view, clip('a'));
    await elapsed(INTER_REEL_PAUSE_MS);

    expect(handle().reportAutoAdvance).toHaveBeenCalledTimes(1);
    // The auto-advance is not an abandonment, so the abandonment seam must not
    // have fired for it at all.
    expect(handle().reportUserSkip).not.toHaveBeenCalled();
  });
});
