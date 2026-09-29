import { act, render } from '@testing-library/react-native';
import { useAudioPlayerStatus } from 'expo-audio';

import { PlayerHost } from '../PlayerHost';
import { releasePlayer, usePlayerStore } from '../../store/player';
import type { FeedClip } from '../../api/schema';

/**
 * `PlayerHost` is the component that makes the app's playback state honest.
 * Before it, `loadClip` asserted "playing" from its own optimism and nothing
 * could correct it — on iOS `currentStatus()` hardcodes `error: nil`
 * (`ios/AudioPlayer.swift:143`), so a 403'd manifest produced "Now playing"
 * for ever with no spinner and no error.
 *
 * The mapping logic itself is tested in `store/__tests__/player.test.ts`.
 * What is pinned here is the WIRING: that the host subscribes, that a native
 * error reaches the store, and that the lock-screen registration uses the clip
 * that is actually playing.
 */

/**
 * ONE fake player shared by every `createAudioPlayer()` call.
 *
 * The store caches the instance, so a factory returning a fresh object per call
 * means the mock the test inspects is not the one the component subscribed to —
 * which reads as "the component never called it" rather than "the test grabbed
 * the wrong instance".
 */
jest.mock('expo-audio', () => {
  // ONE shared instance: the store caches the player, so a factory returning a
  // fresh object per call would mean the mock the test inspects is not the one
  // the component subscribed to — which reads as "the component never called
  // it" rather than "the test grabbed the wrong instance". Built inside the
  // factory because jest forbids closing over outer variables.
  const player = {
    replace: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    remove: jest.fn(),
    setActiveForLockScreen: jest.fn(),
  };
  return { createAudioPlayer: jest.fn(() => player), useAudioPlayerStatus: jest.fn(), __player: player };
});

const mockStatus = useAudioPlayerStatus as jest.MockedFunction<typeof useAudioPlayerStatus>;
const { __player: fakePlayer } = jest.requireMock('expo-audio') as {
  __player: { setActiveForLockScreen: jest.Mock };
};

const nativeSnapshot = (o: Record<string, unknown> = {}) => ({
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
  ...o,
});

const clip = (over: Partial<FeedClip> = {}): FeedClip => ({
  id: 'clip-a',
  title: 'a clip',
  creator_name: 'creator',
  creator_id: 1,
  category: 'music',
  hls_playlist_url: 'https://media.example/hls/a/master.m3u8',
  likes: 0,
  shares: 0,
  skips: 0,
  comment_count: 0,
  is_liked: false,
  ...over,
});

const lockScreen = fakePlayer.setActiveForLockScreen;

beforeEach(() => {
  jest.clearAllMocks();
  releasePlayer();
  usePlayerStore.getState().reset();
  mockStatus.mockReturnValue(nativeSnapshot() as never);
});

describe('status mirroring', () => {
  it('pushes the native snapshot into the store on mount', async () => {
    mockStatus.mockReturnValue(nativeSnapshot({ playing: true, isLoaded: true, currentTime: 4, duration: 30 }) as never);
    await render(<PlayerHost />);
    const s = usePlayerStore.getState();
    expect(s.playback).toBe('playing');
    expect(s.currentTime).toBe(4);
    expect(s.duration).toBe(30);
  });

  it('surfaces a native media error instead of reporting playing', async () => {
    // The symptom this component exists to remove: a 403'd manifest used to
    // leave the card reading "Now playing" for ever.
    mockStatus.mockReturnValue(nativeSnapshot({ error: 'manifest 403', playing: true }) as never);
    await render(<PlayerHost />);
    expect(usePlayerStore.getState().playback).toBe('error');
    expect(usePlayerStore.getState().error).toBe('manifest 403');
  });

  it('reports natural completion as ended, which is what makes the pacing rule possible', async () => {
    mockStatus.mockReturnValue(nativeSnapshot({ didJustFinish: true, isLoaded: true }) as never);
    await render(<PlayerHost />);
    // Phase 3 must not report a finished clip as a skip; that needs `ended` to
    // be distinguishable from `paused`.
    expect(usePlayerStore.getState().playback).toBe('ended');
  });

  it('reports buffering, which a stale playing flag would hide', async () => {
    mockStatus.mockReturnValue(nativeSnapshot({ isBuffering: true, playing: true }) as never);
    await render(<PlayerHost />);
    expect(usePlayerStore.getState().playback).toBe('buffering');
  });

  it('does not touch the card status', async () => {
    usePlayerStore.getState().setCardStatus('processing');
    mockStatus.mockReturnValue(nativeSnapshot({ playing: true, isLoaded: true }) as never);
    await render(<PlayerHost />);
    // Two producers, one field each. A native tick must not reset a
    // still-encoding clip's spinner.
    expect(usePlayerStore.getState().cardStatus).toBe('processing');
  });

  it('follows a changing native status', async () => {
    const { rerender } = await render(<PlayerHost />);
    expect(usePlayerStore.getState().playback).toBe('idle');
    mockStatus.mockReturnValue(nativeSnapshot({ playing: true, isLoaded: true }) as never);
    await act(async () => { await rerender(<PlayerHost />); });
    expect(usePlayerStore.getState().playback).toBe('playing');
  });
});

describe('lock-screen registration', () => {
  it('registers the player as active for lock screen controls', async () => {
    // `setActiveForLockScreen` is required for sustained ANDROID background
    // playback (the OS stops it after ~3 minutes without it), independently of
    // interruptionMode. iOS association is NOT guaranteed under duckOthers,
    // which is a deliberate trade — see audioMode.ts.
    usePlayerStore.setState({ queue: [clip()], activeIndex: 0, playingClipId: 'clip-a' });
    await render(<PlayerHost />);
    expect(lockScreen).toHaveBeenCalledWith(true, expect.anything());
  });

  it('still registers with no clip, so the session is not left dangling', async () => {
    await render(<PlayerHost />);
    expect(lockScreen).toHaveBeenCalledWith(true, undefined);
  });

  it('labels the lock screen with the clip that is actually playing', async () => {
    usePlayerStore.setState({ queue: [clip({ id: 'a', title: 'first' }), clip({ id: 'b', title: 'second' })], activeIndex: 0, playingClipId: 'b' });
    await render(<PlayerHost />);
    const [, metadata] = lockScreen.mock.calls[lockScreen.mock.calls.length - 1] as [boolean, { title?: string; artist?: string }];
    // `playingClipId` wins over the index, so the label cannot drift onto the
    // previous clip during a swipe.
    expect(metadata?.title).toBe('second');
    expect(metadata?.artist).toBe('creator');
  });

  it('omits artwork rather than passing an unreachable URL', async () => {
    usePlayerStore.setState({ queue: [clip()], activeIndex: 0, playingClipId: 'clip-a' });
    await render(<PlayerHost />);
    const [, metadata] = lockScreen.mock.calls[lockScreen.mock.calls.length - 1] as [boolean, Record<string, unknown>];
    // `cover_image` is always null and its URL, when present, is presigned
    // against the container-internal storage endpoint. Passing one would show
    // a broken image on the lock screen.
    expect(metadata).not.toHaveProperty('artworkUri');
  });
});

describe('lifecycle', () => {
  it('renders null', async () => {
    const view = await render(<PlayerHost />);
    expect(view.toJSON()).toBeNull();
  });
});
