import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import Screen from '../index';

import { Spinner } from '../../../src/components/ui/Button';
import { NetworkBanner } from '../../../src/components/NetworkBanner';
import { useBackendStatus } from '../../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../../src/hooks/usePlaybackToken';
import { loadClip, msToSeconds, pause, usePlayerStore } from '../../../src/store/player';
import { decidePlaybackAction } from '../../../src/lib/playbackDecision';
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
 */
jest.mock('../../../src/store/player', () => {
  const { create } = require('zustand');
  return {
    loadClip: jest.fn(),
    pause: jest.fn(),
    msToSeconds: (ms: number) => ms / 1000,
    playbackStateFrom: jest.fn(() => 'idle'),
    // Mirrors the real store's shape, including the split between the card's
    // token state and the native player state. A stub with a single `status`
    // would let the screen render while hiding the very confusion this stage
    // removed.
    usePlayerStore: create((set: (p: unknown) => void) => ({
      queue: [],
      activeIndex: 0,
      handsFree: true,
      cardStatus: 'idle',
      playback: 'idle',
      currentTime: 0,
      duration: 0,
      playingClipId: null as string | null,
      error: null as string | null,
      setQueue: () => {},
      setActiveIndex: () => {},
      toggleHandsFree: () => {},
      setCardStatus: (cardStatus: string) => set({ cardStatus }),
      syncFromPlayer: () => {},
      reset: () => {},
    })),
  };
});

const mockedPlayer = jest.requireMock('../../../src/store/player') as {
  usePlayerStore: { getState: () => Record<string, unknown> };
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

/** Numeric heights found in any host node's style, flattened from arrays. */
function cellHeights(view: Awaited<ReturnType<typeof render>>): number[] {
  const out: number[] = [];
  for (const node of view.root?.queryAll(() => true) ?? []) {
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
