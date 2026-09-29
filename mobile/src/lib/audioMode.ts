import { setAudioModeAsync, type AudioMode } from 'expo-audio';

/**
 * Session-level audio configuration, applied once at app start.
 *
 * WRITTEN AGAINST `expo-audio@57.0.5`'s `AudioMode` type, not from memory.
 * The old expo-av keys (`playsInSilentModeIOS`, `staysActiveInBackground`,
 * `shouldDuckAndroid`) DO NOT EXIST here. In particular `shouldDuckAndroid` was
 * a boolean and `interruptionMode` is a string union — a boolean passed there
 * is a type error, and had it compiled it would have done nothing.
 *
 * Applied ONCE, not per-reel: `setAudioModeAsync` reconfigures the platform
 * audio session, and doing it on every scroll is both wasteful and a source of
 * playback glitches on Android, where the call can drop the focus request.
 */

export const PLAYBACK_AUDIO_MODE: AudioMode = {
  // Play in the ringer-silent state. This is a consumer app; a clip that is
  // silent because the phone is on vibrate reads as broken.
  playsInSilentMode: true,

  // 'duckOthers' — take focus but let the user lower the volume rather than
  // pausing their music outright. 'doNotMix' is hostile; 'mixWithOthers' is
  // wrong here because our own audio would then be inaudible under theirs.
  interruptionMode: 'duckOthers',

  // Continue while backgrounded. expo-audio's config plugin wires
  // AudioControlsService (Android MediaSession) and UIBackgroundMode: audio
  // (iOS), so lock-screen transport controls work.
  //
  // ANDROID CAVEAT, from the SDK's own docs: sustained background playback
  // also needs `setActiveForLockScreen(...)`, without which the OS stops it
  // after ~3 minutes. That is a follow-up — the screen is not the place for it.
  shouldPlayInBackground: true,

  // Explicit, not inherited. Playback must not hold a recording-capable
  // session: it keeps the mic hot and, on iOS, switches the category to
  // playAndRecord so audio routes to the earpiece. Phase 5 flips this to true
  // only while actually recording.
  allowsRecording: false,

  // Route to the speaker. Only meaningful when allowsRecording is true.
  shouldRouteThroughEarpiece: false,
};

let applied: Promise<void> | null = null;

/**
 * Idempotent: repeated calls share the first in-flight promise rather than
 * re-issuing the session configuration.
 */
export function applyPlaybackAudioMode(): Promise<void> {
  if (!applied) {
    applied = setAudioModeAsync(PLAYBACK_AUDIO_MODE);
  }
  return applied;
}

/** Test seam. */
export function __resetAudioModeForTests(): void {
  applied = null;
}
