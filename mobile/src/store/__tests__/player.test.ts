import { createAudioPlayer } from 'expo-audio';

import {
  getPlayer,
  getPlayerOrNull,
  loadClip,
  msToSeconds,
  pause,
  releasePlayer,
  resume,
  secondsToMs,
  seekToSeconds,
  playbackStateFrom,
  usePlayerStore,
  type LoadResult,
  type NativeStatusSnapshot,
} from '../player';
import type { FeedClip } from '../../api/schema';

/**
 * `player.ts` owns the only native resource in the app and the only place the
 * token meets the player. It had **0% coverage** while the suite reported
 * green — the file that owns playback was the file nothing tested.
 *
 * `expo-audio` is mocked at the module boundary because it is the native edge.
 * The store, the URL handling, the token header, the unit conversions and the
 * release/resurrect behaviour are all the real shipped code.
 */

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));

const mockCreate = createAudioPlayer as jest.MockedFunction<typeof createAudioPlayer>;

type FakePlayer = {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  remove: jest.Mock;
};

const makeFakePlayer = (): FakePlayer => ({
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  remove: jest.fn(),
});

const clip = (over: Partial<FeedClip> = {}): FeedClip => ({
  id: 'clip-a',
  title: 'a clip',
  creator_name: 'someone',
  creator_id: 1,
  category: 'music',
  hls_playlist_url: 'https://media.example/hls/clip-a/master.m3u8',
  likes: 0,
  shares: 0,
  skips: 0,
  comment_count: 0,
  is_liked: false,
  ...over,
});

let player: FakePlayer;

beforeEach(() => {
  player = makeFakePlayer();
  mockCreate.mockReset();
  mockCreate.mockImplementation(() => player as never);
  usePlayerStore.getState().reset();
});

afterEach(() => {
  releasePlayer();
});

describe('units', () => {
  // The single most dangerous thing in this file. expo-audio is in SECONDS
  // (`seekTo(seconds)`, `currentTime`, `duration`); the backend is in
  // MILLISECONDS (`clip.duration_ms`). A factor-of-1000 slip corrupts the
  // completion-rate telemetry that drives the recommender, with no visible
  // symptom on screen.
  it('converts backend ms to expo-audio seconds', () => {
    expect(msToSeconds(60_000)).toBe(60);
    expect(msToSeconds(90_500)).toBe(90.5);
    expect(msToSeconds(0)).toBe(0);
  });

  it('converts expo-audio seconds back to backend ms', () => {
    expect(secondsToMs(60)).toBe(60_000);
    expect(secondsToMs(90.5)).toBe(90_500);
  });

  it('rounds on the way back so the backend never sees a float', () => {
    expect(Number.isInteger(secondsToMs(1 / 3))).toBe(true);
    expect(secondsToMs(0.0015)).toBe(2);
  });

  it('round-trips a whole-second duration', () => {
    expect(secondsToMs(msToSeconds(123_000))).toBe(123_000);
  });
});

describe('the player instance', () => {
  it('is created once and reused', () => {
    const a = getPlayer();
    const b = getPlayer();
    expect(a).toBe(b);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('requests a 500ms update interval, which is milliseconds', () => {
    getPlayer();
    // iOS divides it by 1000 (`interval / 1000`), Android uses it directly as
    // ms. Passing 0.5 here would poll 1000x too often on Android.
    expect(mockCreate).toHaveBeenCalledWith(null, { updateInterval: 500 });
  });

  it('getPlayerOrNull does not create one', () => {
    expect(getPlayerOrNull()).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('removes the native player on release and clears the store', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer({
      currentTime: 3, duration: 30, playing: true,
      isBuffering: false, isLoaded: true, didJustFinish: false, error: null,
    });
    expect(usePlayerStore.getState().playback).toBe('playing');
    expect(usePlayerStore.getState().playingClipId).toBe('clip-a');

    releasePlayer();

    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(getPlayerOrNull()).toBeNull();
    // Without this the store keeps claiming audio is playing, no dependency
    // changes, and no load is ever re-triggered — reachable on any Fast
    // Refresh of the root layout.
    expect(usePlayerStore.getState().cardStatus).toBe('idle');
    expect(usePlayerStore.getState().playback).toBe('idle');
    expect(usePlayerStore.getState().playingClipId).toBeNull();
  });
});

describe('loadClip — the token and URL contract', () => {
  it('uses hls_playlist_url verbatim, never rebuilt or prefixed', async () => {
    const url = 'https://media.example:19443/hls/deadbeef/master.m3u8';
    await loadClip(clip({ hls_playlist_url: url }), 'tok');
    expect(player.replace).toHaveBeenCalledWith(
      expect.objectContaining({ uri: url }),
    );
    // Guard the classic bug: prefixing with the API base, or adding a bucket.
    const passed = player.replace.mock.calls[0][0] as { uri: string };
    expect(passed.uri).toBe(url);
    expect(passed.uri).not.toContain('18443');
    expect(passed.uri).not.toContain('echoflow/');
  });

  it('sends the token as a per-source header on every load', async () => {
    await loadClip(clip(), 'tok-1');
    expect(player.replace).toHaveBeenLastCalledWith({
      uri: 'https://media.example/hls/clip-a/master.m3u8',
      headers: { 'X-EchoFlow-Media-Token': 'tok-1' },
    });

    // A fresh source object per load, so a second clip cannot inherit the
    // first clip's header.
    await loadClip(clip({ id: 'clip-b' }), 'tok-2');
    const second = player.replace.mock.calls[1][0] as { headers: Record<string, string> };
    expect(second.headers['X-EchoFlow-Media-Token']).toBe('tok-2');
  });

  it('records the clip and resets the position, but does NOT claim to be playing', async () => {
    await loadClip(clip(), 'tok');
    expect(player.play).toHaveBeenCalledTimes(1);
    const s = usePlayerStore.getState();
    expect(s.playingClipId).toBe('clip-a');
    expect(s.error).toBeNull();
    expect(s.currentTime).toBe(0);
    // `playback` stays whatever the native side says. `replace()` does not
    // throw when the manifest 403s, so writing 'playing' here would assert
    // success for a silent clip — and on iOS nothing could ever correct it,
    // because currentStatus() hardcodes error: nil.
    expect(s.playback).toBe('idle');
    expect(s.cardStatus).toBe('idle');
  });

  it('fails without touching the player when the clip has no playlist', async () => {
    const result = await loadClip(clip({ hls_playlist_url: null }), 'tok');
    expect(result).toBe('failed');
    expect(player.replace).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().cardStatus).toBe('error');
  });

  it('reports a native failure as an error rather than throwing', async () => {
    player.replace.mockImplementation(() => {
      throw new Error('AVPlayer blew up');
    });
    const result: LoadResult = await loadClip(clip(), 'tok');
    expect(result).toBe('failed');
    expect(usePlayerStore.getState().cardStatus).toBe('error');
    expect(usePlayerStore.getState().error).toBe('AVPlayer blew up');
  });

  it('clears a previous error on a successful load', async () => {
    usePlayerStore.getState().setCardStatus('error', 'stale failure');
    await loadClip(clip(), 'tok');
    expect(usePlayerStore.getState().error).toBeNull();
  });
});

describe('transport controls do not resurrect a released player', () => {
  // Each of these used to call getPlayer(), which constructs a fresh
  // AVPlayer/ExoPlayer with no source purely to pause nothing — after a root
  // layout Fast Refresh, which is reachable in development and looks like
  // "playback randomly dies".
  it('pause is a no-op with no player', () => {
    pause();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('resume is a no-op with no player', () => {
    resume();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('seek is a no-op with no player', () => {
    seekToSeconds(12);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('pause does not create a player after release', async () => {
    await loadClip(clip(), 'tok');
    releasePlayer();
    pause();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('pause records paused, without touching the card status', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().setCardStatus('processing');
    pause();
    expect(player.pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().playback).toBe('paused');
    // The card's own state is the token lifecycle's; pausing must not claim a
    // still-encoding clip is merely paused.
    expect(usePlayerStore.getState().cardStatus).toBe('processing');
  });

  it('seek passes seconds straight through, unrounded', async () => {
    await loadClip(clip(), 'tok');
    seekToSeconds(12.5);
    // NOT ms. Passing duration_ms here would seek 1000x too far.
    expect(player.seekTo).toHaveBeenCalledWith(12.5);
  });
});

describe('store', () => {
  it('resets to its initial state', () => {
    usePlayerStore.getState().setQueue([clip()]);
    usePlayerStore.getState().setActiveIndex(4);
    usePlayerStore.getState().setCardStatus('gone');
    usePlayerStore.getState().syncFromPlayer({
      currentTime: 5, duration: 10, playing: true,
      isBuffering: false, isLoaded: true, didJustFinish: false, error: null,
    });
    usePlayerStore.getState().reset();

    const s = usePlayerStore.getState();
    expect(s.queue).toEqual([]);
    expect(s.activeIndex).toBe(0);
    expect(s.cardStatus).toBe('idle');
    expect(s.playback).toBe('idle');
    expect(s.currentTime).toBe(0);
    expect(s.duration).toBe(0);
    expect(s.playingClipId).toBeNull();
  });

  it('toggles hands-free', () => {
    const before = usePlayerStore.getState().handsFree;
    usePlayerStore.getState().toggleHandsFree();
    expect(usePlayerStore.getState().handsFree).toBe(!before);
  });

  it('setCardStatus clears the error when not given one', () => {
    usePlayerStore.getState().setCardStatus('error', 'boom');
    usePlayerStore.getState().setCardStatus('minting');
    expect(usePlayerStore.getState().error).toBeNull();
  });
});

describe('playbackStateFrom — the native status mapping', () => {
  // The single most consequential function added in this stage. Before it,
  // `loadClip` asserted "playing" from its own optimism and nothing could
  // correct it, so a 403'd manifest showed "Now playing" for ever.
  const snap = (o: Partial<NativeStatusSnapshot> = {}): NativeStatusSnapshot => ({
    currentTime: 0,
    duration: 0,
    playing: false,
    isBuffering: false,
    isLoaded: false,
    didJustFinish: false,
    error: null,
    ...o,
  });

  it('reports an error above everything else', () => {
    // Even while "playing": a native error is the reason the user hears
    // nothing, so it must not be masked by a stale playing flag.
    expect(playbackStateFrom(snap({ error: '403', playing: true, isLoaded: true }))).toBe('error');
  });

  it('reports natural completion as ended, not paused', () => {
    // The plan's pacing rule keys on progress >= 0.99, and Phase 3 must not
    // report a finished clip as a skip. `ended` is what makes that
    // distinguishable.
    expect(playbackStateFrom(snap({ didJustFinish: true, playing: false }))).toBe('ended');
  });

  it('reports buffering ahead of playing', () => {
    // A stalled stream is still flagged `playing` on Android, so checking
    // playing first would hide the spinner.
    expect(playbackStateFrom(snap({ isBuffering: true, playing: true }))).toBe('buffering');
  });

  it('reports playing', () => {
    expect(playbackStateFrom(snap({ playing: true, isLoaded: true }))).toBe('playing');
  });

  it('reports a loaded but stopped player as paused', () => {
    expect(playbackStateFrom(snap({ isLoaded: true }))).toBe('paused');
  });

  it('reports nothing loaded as idle', () => {
    expect(playbackStateFrom(snap())).toBe('idle');
  });
});

describe('syncFromPlayer', () => {
  const snap = (o: Partial<NativeStatusSnapshot> = {}): NativeStatusSnapshot => ({
    currentTime: 0, duration: 0, playing: false, isBuffering: false,
    isLoaded: false, didJustFinish: false, error: null, ...o,
  });

  it('mirrors currentTime and duration in SECONDS', () => {
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 12.5, duration: 90 }));
    const s = usePlayerStore.getState();
    // Never milliseconds. `clip.duration_ms` is the backend's own measure and
    // is NOT the same value, so it is not used here.
    expect(s.currentTime).toBe(12.5);
    expect(s.duration).toBe(90);
  });

  it('does not disturb the card status', () => {
    usePlayerStore.getState().setCardStatus('processing');
    usePlayerStore.getState().syncFromPlayer(snap({ playing: true, isLoaded: true }));
    // The two have different producers; a native tick must not reset a
    // still-encoding clip's spinner to "playing".
    expect(usePlayerStore.getState().cardStatus).toBe('processing');
    expect(usePlayerStore.getState().playback).toBe('playing');
  });

  it('surfaces a native error message', () => {
    usePlayerStore.getState().syncFromPlayer(snap({ error: 'manifest 403' }));
    expect(usePlayerStore.getState().playback).toBe('error');
    expect(usePlayerStore.getState().error).toBe('manifest 403');
  });

  it('clears a previous native error on the next healthy tick', () => {
    usePlayerStore.getState().syncFromPlayer(snap({ error: 'boom' }));
    usePlayerStore.getState().syncFromPlayer(snap({ playing: true, isLoaded: true }));
    expect(usePlayerStore.getState().error).toBeNull();
  });

  it('does not wipe a card-level error set by the token lifecycle', () => {
    usePlayerStore.getState().setCardStatus('unavailable');
    usePlayerStore.getState().syncFromPlayer(snap({ isLoaded: true }));
    expect(usePlayerStore.getState().error).toBeNull();
    expect(usePlayerStore.getState().cardStatus).toBe('unavailable');
  });
});
