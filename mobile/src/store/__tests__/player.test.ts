import { createAudioPlayer } from 'expo-audio';

import {
  clampSeekTime,
  coerceNativeTimes,
  getPlayer,
  getPlayerOrNull,
  loadClip,
  msToSeconds,
  pause,
  releasePlayer,
  resume,
  secondsToMs,
  seekToSeconds,
  skipBy,
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
  // `AudioPlayer extends SharedObject<AudioEvents>`
  // (expo-audio/build/AudioModule.types.d.ts:24), so `release()` comes from
  // the base class. It has to be on the fake: the store's real teardown path
  // calls it, and a fake without it is a fake that cannot catch the store
  // reverting to `remove()`.
  release: jest.Mock;
};

const makeFakePlayer = (): FakePlayer => ({
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  remove: jest.fn(),
  release: jest.fn(),
});

/** A native status snapshot with sane "nothing is happening" defaults. */
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

  it('releases the native player and clears the store', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer({
      currentTime: 3, duration: 30, playing: true,
      isBuffering: false, isLoaded: true, didJustFinish: false, error: null,
    });
    expect(usePlayerStore.getState().playback).toBe('playing');
    expect(usePlayerStore.getState().playingClipId).toBe('clip-a');

    releasePlayer();

    expect(player.release).toHaveBeenCalledTimes(1);
    expect(getPlayerOrNull()).toBeNull();
    // Without this the store keeps claiming audio is playing, no dependency
    // changes, and no load is ever re-triggered — reachable on any Fast
    // Refresh of the root layout.
    expect(usePlayerStore.getState().cardStatus).toBe('idle');
    expect(usePlayerStore.getState().playback).toBe('idle');
    expect(usePlayerStore.getState().playingClipId).toBeNull();
  });

  it('calls release(), never remove(), because remove() is not a teardown', async () => {
    // `remove()` is a one-line dictionary delete on both platforms
    // (ios/AudioModule.swift:251-253 -> `players.removeValue(forKey:)`,
    // AudioModule.kt:544-546 -> `players.remove(player.id)`). The real teardown
    // is `sharedObjectWillRelease()` (ios/AudioPlayer.swift:506-518), reached
    // only via `release()`. Calling `remove()` instead leaves the AVPlayer /
    // ExoPlayer alive and still pushing events into a store that now claims
    // `playback: 'idle'`, and the next getPlayer() makes a SECOND one.
    await loadClip(clip(), 'tok');
    releasePlayer();
    expect(player.remove).not.toHaveBeenCalled();
  });

  it('does not release twice — release() is terminal', async () => {
    // After release() the native object is detached and any further native call
    // throws InvalidSharedObjectIdException
    // (expo-modules-core/.../SharedObjectRegistry.kt:87-98). `afterEach` calls
    // releasePlayer() too, so an unguarded second call would fire on every
    // test in this file.
    await loadClip(clip(), 'tok');
    releasePlayer();
    releasePlayer();
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('still clears the store when there is no player to release', () => {
    // releasePlayer() is a public cleanup entry point (app/_layout.tsx). "No
    // player to release" must not be a reason to leave the store asserting
    // that audio is playing.
    expect(getPlayerOrNull()).toBeNull();
    usePlayerStore.setState({ playback: 'playing', playingClipId: 'clip-a' });
    releasePlayer();
    expect(player.release).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playback).toBe('idle');
    expect(usePlayerStore.getState().playingClipId).toBeNull();
  });

  it('clears the store even when the native teardown throws', async () => {
    // release() is a much bigger native call than remove() was — Android
    // releases the ExoPlayer, the MediaSession and the visualizer and unbinds
    // the playback service (AudioPlayer.kt:279-286) — so it can throw. If the
    // reset is skipped when it does, we are worse off than the bug this
    // function exists to prevent: the store keeps asserting 'playing' for a
    // player that is gone, and no dependency ever changes again.
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ playing: true, isLoaded: true, duration: 30 }));
    player.release.mockImplementation(() => {
      throw new Error('unbind failed');
    });

    expect(() => releasePlayer()).toThrow('unbind failed');
    expect(usePlayerStore.getState().playback).toBe('idle');
    expect(usePlayerStore.getState().playingClipId).toBeNull();
  });

  it('does not resurrect a released player on a second getPlayer()', async () => {
    // The second native player is the observable consequence of the leak: a
    // `remove()`-only teardown would leave the first one running, so the store
    // would be driving two players.
    await loadClip(clip(), 'tok');
    releasePlayer();
    mockCreate.mockClear();
    const second = getPlayer();
    expect(second).toBe(player as never);
    expect(mockCreate).toHaveBeenCalledTimes(1);
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

  it('copes with a native throw that is not an Error', async () => {
    // The bridge can reject with a string or a plain object; `err.message`
    // would be `undefined` and the card would render "could not play this
    // clip" with no reason at all.
    player.replace.mockImplementation(() => {
      throw 'not an Error instance';
    });
    const result: LoadResult = await loadClip(clip(), 'tok');
    expect(result).toBe('failed');
    expect(usePlayerStore.getState().error).toBe('playback failed');
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

describe('coerceNativeTimes — the numbers every consumer depends on', () => {
  // Both bad values come out of expo-audio itself, so the coercion has to be in
  // the store rather than in whichever view happens to read the value first.
  it('turns a NaN currentTime into 0', () => {
    // iOS guards the *property* (ios/AudioPlayer.swift:62-70,
    // `seconds.isNaN ? 0.0 : seconds`) but the periodic observer merges the
    // raw value with no guard (ios/AudioPlayer.swift:482-488,
    // `"currentTime": time.seconds`). A NaN is an invalid RN style value for
    // the progress width and poisons `currentTime / duration` telemetry.
    expect(coerceNativeTimes(Number.NaN, 30).currentTime).toBe(0);
  });

  it('turns a non-finite duration into 0', () => {
    expect(coerceNativeTimes(5, Number.NaN).duration).toBe(0);
    expect(coerceNativeTimes(5, Number.POSITIVE_INFINITY).duration).toBe(0);
  });

  it('clamps a currentTime beyond the duration down to it', () => {
    // Android emits the raw, unclamped position on a seek discontinuity
    // (BaseAudioPlayer.kt:114-122, `newPosition.positionMs / 1000.0`). Seek to
    // duration + 10 and that is what the store used to receive.
    expect(coerceNativeTimes(40, 30).currentTime).toBe(30);
  });

  it('clamps a negative currentTime up to 0', () => {
    expect(coerceNativeTimes(-7, 30).currentTime).toBe(0);
  });

  it('leaves an in-range value untouched, unrounded', () => {
    expect(coerceNativeTimes(12.5, 90)).toEqual({ currentTime: 12.5, duration: 90 });
  });

  it('does not clamp against a duration of 0 — there is no upper bound yet', () => {
    // The store reports 0 duration until the source reports its own, and a live
    // stream reports 0 for ever. Clamping to 0 would pin the position.
    expect(coerceNativeTimes(42, 0)).toEqual({ currentTime: 42, duration: 0 });
  });

  it('coerces BOTH numbers, so a NaN duration cannot enable the clamp', () => {
    expect(coerceNativeTimes(Number.NaN, Number.NaN)).toEqual({
      currentTime: 0,
      duration: 0,
    });
  });

  it('reaches the store, not just the helper', () => {
    usePlayerStore.getState().syncFromPlayer(
      snap({ currentTime: Number.NaN, duration: 30, playing: true, isLoaded: true }),
    );
    expect(usePlayerStore.getState().currentTime).toBe(0);

    usePlayerStore.getState().syncFromPlayer(
      snap({ currentTime: 99, duration: 30, playing: true, isLoaded: true }),
    );
    expect(usePlayerStore.getState().currentTime).toBe(30);
  });
});

describe('the ended latch', () => {
  // `didJustFinish` is a single-event pulse on BOTH native platforms:
  // ios/AudioPlayer.swift:146 hardcodes it false in currentStatus() and only
  // the end-notification override sets it true (:467); AudioPlayer.kt:211 does
  // the same and `justFinished` (BaseAudioPlayer.kt:99-102) is true only for
  // the callback that transitions INTO STATE_ENDED. Web only latches by
  // accident (src/AudioUtils.web.ts:70, HTMLMediaElement.ended is sticky).
  //
  // So un-latched, `ended` lasts one 500 ms tick and PlayerHost's re-sync turns
  // it into `paused` — and the plan's auto-advance and `progress >= 0.99`
  // pacing rule both key on `ended`, so neither would ever fire.
  const loadAndTick = async (o: Partial<NativeStatusSnapshot> = {}) => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap(o));
  };

  it('still reports ended on the tick AFTER the finish pulse', async () => {
    await loadAndTick({ didJustFinish: true, isLoaded: true, playing: false, currentTime: 30, duration: 30 });
    expect(usePlayerStore.getState().playback).toBe('ended');

    // The very next healthy tick is what a real device delivers 500 ms later,
    // and the native side now says didJustFinish: false, isLoaded: true.
    usePlayerStore.getState().syncFromPlayer(
      snap({ didJustFinish: false, isLoaded: true, playing: false, currentTime: 30, duration: 30 }),
    );
    expect(usePlayerStore.getState().playback).toBe('ended');
  });

  it('survives many ticks, not just one', async () => {
    await loadAndTick({ didJustFinish: true, isLoaded: true, duration: 30 });
    for (let i = 0; i < 5; i += 1) {
      usePlayerStore.getState().syncFromPlayer(snap({ isLoaded: true, duration: 30 }));
    }
    expect(usePlayerStore.getState().playback).toBe('ended');
  });

  it('records which clip finished, so the latch is scoped', async () => {
    await loadAndTick({ didJustFinish: true, isLoaded: true, duration: 30 });
    expect(usePlayerStore.getState().endedForClipId).toBe('clip-a');
  });

  it('is cleared by the next loadClip', async () => {
    await loadAndTick({ didJustFinish: true, isLoaded: true, duration: 30 });
    expect(usePlayerStore.getState().playback).toBe('ended');

    await loadClip(clip({ id: 'clip-b' }), 'tok-2');
    // Not "paused" and not "ended": the new source has not reported yet. The
    // whole point is that clip-b is NOT ended, or the pacing rule would treat
    // its first frame as a completion.
    expect(usePlayerStore.getState().playback).not.toBe('ended');
    expect(usePlayerStore.getState().endedForClipId).toBeNull();

    usePlayerStore.getState().syncFromPlayer(snap({ isLoaded: true, playing: true, duration: 20 }));
    expect(usePlayerStore.getState().playback).toBe('playing');
  });

  it('is cleared by reset()', () => {
    usePlayerStore.setState({ endedForClipId: 'clip-a' });
    usePlayerStore.getState().reset();
    expect(usePlayerStore.getState().endedForClipId).toBeNull();
  });

  it('is NOT armed when no clip is loaded', () => {
    // playingClipId is null, so there is nothing for the latch to be scoped to.
    usePlayerStore.getState().syncFromPlayer(snap({ didJustFinish: true, isLoaded: true }));
    expect(usePlayerStore.getState().playback).toBe('ended');
    expect(usePlayerStore.getState().endedForClipId).toBeNull();
  });

  it('still lets an error win, matching playbackStateFrom', async () => {
    await loadAndTick({ didJustFinish: true, isLoaded: true, duration: 30 });
    usePlayerStore.getState().syncFromPlayer(snap({ error: 'decoder died', isLoaded: true }));
    // The reason the user hears nothing outranks a completion that already
    // happened.
    expect(usePlayerStore.getState().playback).toBe('error');
  });

  it('leaves playbackStateFrom pure — the pulse still maps to ended on its own', () => {
    // The latch is deliberately NOT in playbackStateFrom: that function stays a
    // pure mapping of the snapshot it is given, so the platform's single-tick
    // pulse is not rewritten for its unit tests or its other callers.
    expect(playbackStateFrom(snap({ didJustFinish: true, playing: false }))).toBe('ended');
    expect(playbackStateFrom(snap({ didJustFinish: false, isLoaded: true }))).toBe('paused');
  });
});

describe('buffering with nothing loaded', () => {
  // ios/AudioUtils.swift:197-209: the isBuffering extension returns a bare
  // `true` when `currentItem == nil`. getPlayer() constructs with
  // `source = null`, so on iOS that is true for the app's ENTIRE
  // pre-first-clip life, and isBuffering outranks playing in
  // playbackStateFrom -> a permanent spinner. Android disagrees
  // (AudioPlayer.kt:198: isBuffering is `playbackState == STATE_BUFFERING`,
  // and STATE_IDLE is not that), so the same snapshot means different things
  // per platform.
  //
  // The gate is the STORE's `playingClipId`, not the native `isLoaded`. That is
  // the correction these tests exist to pin: an earlier revision gated on
  // `isLoaded`, which is `currentItem?.status == .readyToPlay` on iOS
  // (ios/AudioPlayer.swift:86-88) but `playbackState == STATE_READY` on
  // Android (AudioPlayer.kt:197). A REAL stall is therefore isLoaded:true on
  // iOS and isLoaded:FALSE on Android, so that gate would have hidden exactly
  // the spinner Android needs. The last test below is the regression guard.
  it('reports idle, not buffering, when no clip has been loaded', () => {
    expect(usePlayerStore.getState().playingClipId).toBeNull();
    usePlayerStore.getState().syncFromPlayer(snap({ isBuffering: true }));
    expect(usePlayerStore.getState().playback).toBe('idle');
  });

  it('keeps a REAL buffering report once a clip is loaded', () => {
    // The fix must not swallow the spinner it was added to fix.
    usePlayerStore.setState({ playingClipId: 'clip-a' });
    usePlayerStore.getState().syncFromPlayer(snap({ isBuffering: true, playing: true }));
    expect(usePlayerStore.getState().playback).toBe('buffering');
  });

  it('still reports buffering on ANDROID, where a real stall has isLoaded:false', () => {
    // Android: isBuffering === (playbackState == STATE_BUFFERING), and
    // isLoaded === (playbackState == STATE_READY) — mutually exclusive states.
    // A genuine Android stall is therefore isLoaded:false + isBuffering:true.
    // Gating on isLoaded would report `playing` here and hide the spinner.
    usePlayerStore.setState({ playingClipId: 'clip-a' });
    usePlayerStore.getState().syncFromPlayer(
      snap({ isBuffering: true, isLoaded: false, playing: true }),
    );
    expect(usePlayerStore.getState().playback).toBe('buffering');
  });

  it('leaves playbackStateFrom reporting buffering from the raw snapshot', () => {
    // Untouched on purpose: the sanitisation happens in syncFromPlayer so this
    // function keeps its documented, independently-tested contract.
    expect(playbackStateFrom(snap({ isBuffering: true, playing: true }))).toBe('buffering');
  });
});

describe('clampSeekTime', () => {
  // No platform clamps for us: ios/AudioPlayer.swift:179-198 builds a CMTime
  // from whatever it is given, Playable.kt:31 is a bare
  // `player.seekTo((seconds * 1000L).toLong())`, and src/AudioPlayer.web.ts:
  // 169-175 assigns `media.currentTime = seconds`.
  it('passes an in-range target through', () => {
    expect(clampSeekTime(12.5, 30)).toBe(12.5);
  });

  it('clamps a negative target to 0', () => {
    // A -10 s skip at t=3 is the case that matters: unclamped this becomes
    // CMTime(seconds: -7.0).
    expect(clampSeekTime(-7, 30)).toBe(0);
  });

  it('clamps a target past the end to the duration', () => {
    expect(clampSeekTime(999, 30)).toBe(30);
  });

  it('refuses when duration is 0 — nothing is loaded', () => {
    // On Android a seek issued while still STATE_IDLE is stored by ExoPlayer
    // and applied to the NEXT item, so this must be a refusal, not a seek to 0.
    expect(clampSeekTime(5, 0)).toBeNull();
  });

  it('refuses a non-finite target', () => {
    expect(clampSeekTime(Number.NaN, 30)).toBeNull();
    expect(clampSeekTime(Number.POSITIVE_INFINITY, 30)).toBeNull();
  });

  it('refuses a non-finite duration', () => {
    expect(clampSeekTime(5, Number.NaN)).toBeNull();
  });
});

describe('skipBy — the +-10s button', () => {
  it('seeks forward by the delta from the store position', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 20, duration: 60, playing: true, isLoaded: true }));
    expect(skipBy(10)).toBe(30);
    expect(player.seekTo).toHaveBeenCalledWith(30);
  });

  it('seeks backward by the delta from the store position', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 20, duration: 60, playing: true, isLoaded: true }));
    expect(skipBy(-10)).toBe(10);
    expect(player.seekTo).toHaveBeenCalledWith(10);
  });

  it('clamps a backward skip near the start to 0', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 3, duration: 60, playing: true, isLoaded: true }));
    // Unclamped this is CMTime(seconds: -7.0) on iOS.
    expect(skipBy(-10)).toBe(0);
    expect(player.seekTo).toHaveBeenCalledWith(0);
  });

  it('clamps a forward skip past the end to the duration', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 55, duration: 60, playing: true, isLoaded: true }));
    expect(skipBy(10)).toBe(60);
    expect(player.seekTo).toHaveBeenCalledWith(60);
  });

  it('refuses and does not seek when nothing is loaded', async () => {
    // No loadClip: duration is 0, and on Android the seek would be stored and
    // applied to the NEXT clip.
    expect(skipBy(10)).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('refuses when a clip is loaded but has not reported a duration yet', async () => {
    await loadClip(clip(), 'tok');
    // loadClip deliberately starts duration at 0 rather than trusting the
    // feed's duration_ms.
    expect(usePlayerStore.getState().duration).toBe(0);
    expect(skipBy(10)).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('does not resurrect a released player', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 20, duration: 60, playing: true, isLoaded: true }));
    releasePlayer();
    mockCreate.mockClear();
    skipBy(10);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not write currentTime optimistically', async () => {
    // A seek emits a status update on all three platforms
    // (ios/AudioPlayer.swift:189-194, BaseAudioPlayer.kt:119-121), so the next
    // tick corrects the store. An optimistic write would be a second source of
    // truth that can disagree with native.
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 20, duration: 60, playing: true, isLoaded: true }));
    skipBy(10);
    expect(usePlayerStore.getState().currentTime).toBe(20);
  });

  it('uses seconds, not milliseconds', async () => {
    await loadClip(clip(), 'tok');
    usePlayerStore.getState().syncFromPlayer(snap({ currentTime: 20, duration: 60, playing: true, isLoaded: true }));
    skipBy(10);
    // If the store ever held ms, this would be 30000 — a 1000x overshoot that
    // is silent on screen.
    expect(player.seekTo).toHaveBeenCalledWith(30);
  });

  it('leaves the unclamped seekToSeconds primitive alone', async () => {
    // Kept for absolute seeks, but it does NOT clamp: no production caller
    // exists (grepped src/ and app/ as of 2026-09-30).
    await loadClip(clip(), 'tok');
    seekToSeconds(12.5);
    expect(player.seekTo).toHaveBeenCalledWith(12.5);
  });
});
