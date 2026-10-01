import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { Text, View } from 'react-native';

import { useAudioPlayerStatus } from 'expo-audio';

import { TelemetryHost } from '../TelemetryHost';
import { PlayerHost } from '../../hooks/PlayerHost';
import { useTelemetrySkip } from '../../hooks/useWatchTelemetry';
import { logTelemetry, registerSkip } from '../../api/endpoints/interactions';
import { releasePlayer, usePlayerStore, type PlayerState } from '../../store/player';

/**
 * `TelemetryHost` is a mount point, so what is pinned here is that it behaves
 * like one: renders nothing, owns the session's whole lifetime, and never
 * touches the native player.
 *
 * The logic — which heartbeat, which clip, which skip — is tested in
 * `hooks/__tests__/useWatchTelemetry.test.ts`. Duplicating it here would make a
 * behavioural change show up as two unrelated failures.
 */

// Same shape as `PlayerHost.test.tsx:29-50`: `store/player.ts` imports
// `expo-audio` at module load, and an unmocked native module crashes at import.
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

jest.mock('../../api/endpoints/interactions', () => {
  const actual = jest.requireActual('../../api/endpoints/interactions');
  return { ...actual, logTelemetry: jest.fn(), registerSkip: jest.fn() };
});

const { createAudioPlayer } = jest.requireMock('expo-audio') as {
  createAudioPlayer: jest.Mock;
  __player: Record<string, jest.Mock>;
};

// A constant snapshot, so `PlayerHost`'s effect runs once on mount and never
// writes over the store values a test sets. Same posture as
// `PlayerHost.test.tsx:67-97`.
const mockStatus = useAudioPlayerStatus as jest.MockedFunction<typeof useAudioPlayerStatus>;

const mockLogTelemetry = logTelemetry as jest.MockedFunction<typeof logTelemetry>;
const mockRegisterSkip = registerSkip as jest.MockedFunction<typeof registerSkip>;

const T0 = 1_700_000_000_000;
let now = T0;
/** Kept so one test can hand the clock back to jest's fake timers. */
let dateSpy: jest.SpyInstance<number, []>;

type AppStateListener = (status: AppStateStatus) => void;
let appStateListener: AppStateListener | null = null;
let appStateRemovals = 0;

beforeEach(() => {
  now = T0;
  dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  appStateListener = null;
  appStateRemovals = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    listener: AppStateListener,
  ) => {
    if (type === 'change') appStateListener = listener;
    return { remove: () => { appStateRemovals += 1; } };
  }) as unknown as typeof AppState.addEventListener);

  releasePlayer();
  usePlayerStore.getState().reset();
  createAudioPlayer.mockClear();
  mockStatus.mockReturnValue({
    id: 'evt',
    currentTime: 0,
    playbackState: 'idle',
    timeControlStatus: 'paused',
    reasonForWaitingToPlay: '',
    mute: false,
    duration: 0,
    playing: false,
    loop: false,
    didJustFinish: false,
    isBuffering: false,
    isLoaded: false,
    playbackRate: 1,
    shouldCorrectPitch: true,
    error: null,
  } as never);
  mockLogTelemetry.mockReset();
  mockRegisterSkip.mockReset();
  mockLogTelemetry.mockResolvedValue({ status: 'telemetry logged' });
  mockRegisterSkip.mockResolvedValue({ status: 'skip/view registered' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function setStore(partial: Partial<PlayerState>): Promise<void> {
  await act(async () => {
    usePlayerStore.setState(partial);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setAppState(status: AppStateStatus): Promise<void> {
  await act(async () => {
    appStateListener?.(status);
  });
}

/** One clip, playing, plus `ticks` × 500 ms of watch time. */
async function playingFor(ticks: number, clipId = 'clip-a'): Promise<void> {
  await setStore({ playingClipId: clipId, currentTime: 0, duration: 60, playback: 'playing' });
  for (let i = 1; i <= ticks; i += 1) {
    now += 500;
    await setStore({ currentTime: i * 0.5 });
  }
}

describe('rendering', () => {
  it('renders null, like every other root-level host', async () => {
    // It must not wrap the tree or contribute a View: it is mounted outside
    // `<Stack>` and any layout it added would change the app's frame.
    const view = await render(<TelemetryHost />);
    expect(view.toJSON()).toBeNull();
  });
});

describe('lifecycle', () => {
  it('adds an AppState listener and removes it on unmount', async () => {
    // Nothing in the app listens for `AppState` today
    // (`grep -rn AppState src app` is empty), so without this the accumulator
    // banks a background gap as watch time.
    const { unmount } = await render(<TelemetryHost />);
    expect(appStateListener).not.toBeNull();
    await unmount();
    expect(appStateRemovals).toBe(1);
  });

  it('leaves no store subscription behind on unmount', async () => {
    // A leaked subscription keeps crediting a dead session from the store, which
    // is invisible until it double-counts somebody's watch time. The player keeps
    // ticking after this host is gone; nothing may go out.
    const first = await render(<TelemetryHost />);
    await playingFor(2);
    expect(mockLogTelemetry.mock.calls.length).toBeGreaterThan(0);

    // The unmount drain is itself a request; count from AFTER it, so the only
    // thing the next assertion can be measuring is a leaked subscription.
    await first.unmount();
    const before = mockLogTelemetry.mock.calls.length;
    await setStore({ currentTime: 5 });
    expect(mockLogTelemetry).toHaveBeenCalledTimes(before);

    // And a fresh host works from a clean slate, rather than inheriting the old
    // session or double-counting against it.
    const second = await render(<TelemetryHost />);
    await playingFor(1, 'clip-b');
    expect(mockLogTelemetry).toHaveBeenCalledTimes(before + 1);
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-b', { watchTimeMs: 500 });
    await second.unmount();
  });

  it('flushes the pending sample on unmount', async () => {
    const { unmount } = await render(<TelemetryHost />);
    await playingFor(3);

    await unmount();

    // The last flush before the session goes away: mandatory, so the 5 s rate
    // floor does not apply to losing data.
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });
  });

  it('survives unmount after the player has been released', async () => {
    // `releasePlayer()` is called from the ROOT layout's effect cleanup
    // (`app/_layout.tsx:93`), and React runs a parent's cleanup before its
    // children's — so on a real teardown this host's cleanup runs after
    // `reset()`. It must not throw, and it must correctly send nothing, because
    // there is no longer a clip for a sample to belong to.
    const { unmount } = await render(<TelemetryHost />);
    await playingFor(3);
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);

    releasePlayer();
    expect(() => unmount()).not.toThrow();
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);
  });
});

describe('no native player access', () => {
  it('never constructs a player', async () => {
    // Everything this host needs is in the store. `getPlayer()` would construct a
    // fresh AVPlayer/ExoPlayer, and after `releasePlayer()` any native call
    // throws `InvalidSharedObjectIdException` — `store/player.ts:96-105` calls
    // that terminal.
    const view = await render(<TelemetryHost />);
    await playingFor(3);
    await view.unmount();

    expect(createAudioPlayer).not.toHaveBeenCalled();
    expect(mockRegisterSkip).not.toHaveBeenCalled();
  });

  it('produces no heartbeat from a timer of its own', async () => {
    // A `setInterval` re-armed by every 500 ms store change is a 500 ms timer,
    // and `telemetry` is 60/min — the session would 429 within ~30 s and every
    // later flush would be refused. The floor belongs inside `onTick`, and the
    // ONLY tick source is the store. With no status event arriving (the native
    // timer suspended, the user on another screen) thirty seconds of wall clock
    // must produce nothing at all: watch time is credited from ticks, not from
    // elapsed time.
    jest.useFakeTimers();
    try {
      const view = await render(<TelemetryHost />);
      await act(async () => {
        usePlayerStore.setState({
          playingClipId: 'clip-a',
          currentTime: 1,
          duration: 60,
          playback: 'playing',
        });
      });
      // Hand the clock to jest's fake timers, which advance it themselves.
      dateSpy.mockRestore();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockLogTelemetry).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('tolerates an unmount with no clip ever loaded', async () => {
    const { unmount } = await render(<TelemetryHost />);
    await act(async () => {
      unmount();
    });
    expect(mockLogTelemetry).not.toHaveBeenCalled();
  });
});

describe('mounted after PlayerHost', () => {
  it('coexists with the player host and drains on the way out', async () => {
    // The documented mount order from `app/_layout.tsx`. Both are null-rendering
    // root hosts and neither cleans up after the other, so what matters is that
    // the pair works — and that the telemetry drain reads a store still holding
    // the outgoing clip, which it does because `releasePlayer()` belongs to the
    // PARENT layout, not to `PlayerHost`.
    const view = await render(
      <View>
        <PlayerHost />
        <TelemetryHost />
      </View>,
    );
    await playingFor(3);
    await view.unmount();

    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });
  });
});

describe('background and foreground', () => {
  it('reports the watch time it had when the app went away, and no more after it returns', async () => {
    await render(<TelemetryHost />);
    await playingFor(3);

    await setAppState('background');
    const afterBackground = mockLogTelemetry.mock.calls.length;
    expect(mockLogTelemetry).toHaveBeenLastCalledWith('clip-a', { watchTimeMs: 1500 });

    // Five minutes in the background, then back. iOS suspends timers, so no tick
    // arrives, and the native player still claims `playing: true` — the only
    // thing standing between that and 300 000 ms of fabricated watch time is the
    // re-baseline.
    now += 5 * 60_000;
    await setAppState('active');

    now += 500;
    await setStore({ currentTime: 2 });
    expect(mockLogTelemetry).toHaveBeenCalledTimes(afterBackground + 1);
    // The resumed claim is the pre-background total plus a single tick's credit,
    // not the gap.
    expect(mockLogTelemetry.mock.calls.at(-1)?.[1]).toEqual({ watchTimeMs: 2000 });
  });
});

describe('the abandonment handle', () => {
  it('is reachable from a component below the host, and inert above it', async () => {
    // `useTelemetrySkip()` is how the feed screen reports a swipe. Rendering it
    // from a sibling of the host — the shape the feed has, several providers and
    // a `<Stack>` below — must reach the SAME session, and must not start a
    // second one.
    const screen = jest.fn(() => null);
    function Screen() {
      screen();
      const { reportUserSkip } = useTelemetrySkip();
      return <Text testID="swipe" onPress={reportUserSkip} />;
    }

    const view = await render(
      <View>
        <TelemetryHost />
        <Screen />
      </View>,
    );
    await playingFor(4);

    await act(async () => {
      view.getByTestId('swipe').props.onPress();
    });

    expect(mockRegisterSkip).toHaveBeenCalledWith('clip-a', {
      listenDurationMs: 2000,
      reelPositionMs: 2000,
    });
    // One session: the store subscription is not doubled by the screen's use of
    // the handle, which is why this is a separate hook rather than a second
    // `useWatchTelemetry()`.
    expect(mockLogTelemetry).toHaveBeenCalledTimes(1);
  });
});
