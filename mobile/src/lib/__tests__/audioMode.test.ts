import { setAudioModeAsync, type AudioPlayer } from 'expo-audio';

import {
  PLAYBACK_AUDIO_MODE,
  __resetAudioModeForTests,
  applyPlaybackAudioMode,
} from '../audioMode';
import { getPlayer, releasePlayer } from '../../store/player';

/**
 * The audio session config, and the two things about it that are easy to get
 * wrong and invisible until a device is in someone's hand.
 *
 * This file was 0% covered. Its real test is a type check — the keys come from
 * `expo-audio@57.0.5`'s `AudioMode`, not from the expo-av names the salvage
 * list carried — but "the key exists" and "the value is right" are different
 * questions and only the first was ever checked.
 */

jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(),
  createAudioPlayer: jest.fn(() => ({
    replace: jest.fn(), play: jest.fn(), pause: jest.fn(), seekTo: jest.fn(), remove: jest.fn(),
    // `setActiveForLockScreen` is a method on AudioPlayer, NOT a top-level
    // export of `expo-audio` (AudioModule.types.d.ts:174). Importing it as a
    // named import is a compile error, which is a cheap way to prove the call
    // site is wrong before wiring it in the root layout.
    setActiveForLockScreen: jest.fn(),
  })),
}));

const mockSetMode = setAudioModeAsync as jest.MockedFunction<typeof setAudioModeAsync>;

beforeEach(() => {
  jest.clearAllMocks();
  __resetAudioModeForTests();
  mockSetMode.mockResolvedValue(undefined);
});

describe('the audio mode', () => {
  it('plays in the ringer-silent state', () => {
    // A clip silent because the phone is on vibrate reads as broken.
    expect(PLAYBACK_AUDIO_MODE.playsInSilentMode).toBe(true);
  });

  it('ducks rather than pausing the user\'s own music', () => {
    // 'doNotMix' would pause their music outright; 'mixWithOthers' would make
    // our own audio inaudible under theirs. An owner decision, 2026-09-29.
    expect(PLAYBACK_AUDIO_MODE.interruptionMode).toBe('duckOthers');
  });

  it('keeps playing while backgrounded', () => {
    expect(PLAYBACK_AUDIO_MODE.shouldPlayInBackground).toBe(true);
  });

  it('does not hold a recording-capable session', () => {
    // Phase 5 flips this to true only while actually recording. On iOS a
    // true value switches the category to playAndRecord and routes audio to
    // the earpiece.
    expect(PLAYBACK_AUDIO_MODE.allowsRecording).toBe(false);
  });

  it('does not route through the earpiece', () => {
    expect(PLAYBACK_AUDIO_MODE.shouldRouteThroughEarpiece).toBe(false);
  });

  it('uses only keys that exist on expo-audio AudioMode', () => {
    // The salvage list named `playsInSilentModeIOS`, `staysActiveInBackground`
    // and `shouldDuckAndroid` — none of which exist here. A `shouldDuckAndroid`
    // boolean is a *type* error against the string union, and had it compiled
    // it would have done nothing.
    const allowed = new Set([
      'playsInSilentMode',
      'interruptionMode',
      'allowsRecording',
      'shouldPlayInBackground',
      'shouldRouteThroughEarpiece',
    ]);
    for (const key of Object.keys(PLAYBACK_AUDIO_MODE)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe('applyPlaybackAudioMode', () => {
  it('configures the session with the mode', async () => {
    await applyPlaybackAudioMode();
    expect(mockSetMode).toHaveBeenCalledWith(PLAYBACK_AUDIO_MODE);
  });

  it('is idempotent, sharing the first in-flight promise', async () => {
    // Reconfiguring the session on every scroll is wasteful and a source of
    // playback glitches on Android, where the call can drop the focus request.
    await Promise.all([applyPlaybackAudioMode(), applyPlaybackAudioMode()]);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
  });

  it('does not re-issue after a successful apply', async () => {
    await applyPlaybackAudioMode();
    await applyPlaybackAudioMode();
    expect(mockSetMode).toHaveBeenCalledTimes(1);
  });

  it('re-raises a rejected apply so it is not silently cached', async () => {
    // A rejected promise cached as `applied` would mean audio is never
    // configured for the rest of the process, with no error anywhere.
    mockSetMode.mockRejectedValueOnce(new Error('no audio session'));
    await expect(applyPlaybackAudioMode()).rejects.toThrow('no audio session');
  });
});

describe('lock-screen controls', () => {
  it('registers the active player so the OS will show transport controls', () => {
    // The SDK states lock-screen association requires `interruptionMode` to be
    // 'doNotMix'; that is NOT our chosen mode (we duck the user's music), so
    // iOS association is unreliable and is documented as such rather than
    // claimed to work.
    //
    // `setActiveForLockScreen` is still required for ANDROID sustained
    // background playback: without it the OS stops playback after ~3 minutes
    // (`AudioMode.shouldPlayInBackground` in expo-audio's own docs).
    const player = getPlayer() as AudioPlayer & {
      setActiveForLockScreen: (active: boolean, metadata?: unknown) => void;
    };
    expect(typeof player.setActiveForLockScreen).toBe('function');
  });

  it('does not switch interruptionMode to doNotMix behind the owner\'s back', () => {
    // The owner chose 'duckOthers' over lock-screen reliability. Silently
    // flipping this would pause the user's music mid-clip.
    expect(PLAYBACK_AUDIO_MODE.interruptionMode).not.toBe('doNotMix');
  });
});
