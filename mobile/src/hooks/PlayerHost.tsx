import { useEffect } from 'react';
import { useAudioPlayerStatus, type AudioMetadata } from 'expo-audio';

import { getPlayer, usePlayerStore, type NativeStatusSnapshot } from '../store/player';
import type { FeedClip } from '../api/schema';

/**
 * The app-wide owner of the one `AudioPlayer`, mounted once at the root.
 *
 * ## Why this is a component and not a module
 * A Zustand store cannot call a hook, and the public way to observe a player is
 * the `useAudioPlayerStatus` hook. (The underlying event key,
 * `PLAYBACK_STATUS_UPDATE`, is not exported from `expo-audio`'s public entry
 * point — subscribing to it directly would mean importing from
 * `expo-audio/build/…`, an internal path a patch bump can move.) So a component
 * has to do the subscribing, and the root layout is the only place that mounts
 * for the app's lifetime.
 *
 * ## What it fixes
 * `replace()` and `play()` return `void` and do **not** throw when the manifest
 * 403s or the source is unreachable. `loadClip` therefore used to write
 * "playing" the instant it issued them, and nothing ever corrected it — on iOS
 * `currentStatus()` hardcodes `error: nil`
 * (`ios/AudioPlayer.swift:143`), so a media failure is not even representable.
 * The card read "Now playing" for ever, with no spinner and no error, for a
 * clip that was silent. Every state the user sees now comes from the native
 * side instead of from our own optimism.
 *
 * ## Why it creates the player eagerly
 * The plan puts the player at app root ("one `AudioPlayer`, created once at app
 * root"), and two runtime facts need it there rather than on first clip:
 * lock-screen registration must happen while the player is current, and a
 * bridge that ran before the first `loadClip` would find nothing to observe.
 */
export function PlayerHost(): null {
  const player = getPlayer();
  const status = useAudioPlayerStatus(player);
  const sync = usePlayerStore((s) => s.syncFromPlayer);
  const playingClipId = usePlayerStore((s) => s.playingClipId);
  const queue = usePlayerStore((s) => s.queue);
  const activeIndex = usePlayerStore((s) => s.activeIndex);

  useEffect(() => {
    const next: NativeStatusSnapshot = {
      currentTime: status.currentTime,
      duration: status.duration,
      playing: status.playing,
      isBuffering: status.isBuffering,
      isLoaded: status.isLoaded,
      didJustFinish: status.didJustFinish,
      error: status.error ?? null,
    };
    sync(next);
  }, [status, sync]);

  /**
   * Lock-screen / MediaSession registration.
   *
   * `setActiveForLockScreen` is a method on `AudioPlayer`, not a top-level
   * `expo-audio` export.
   *
   * Being honest about what this buys: the SDK states twice that reliable
   * association requires `interruptionMode: 'doNotMix'`, and the owner chose
   * `duckOthers` on 2026-09-29 so a clip does not pause the user's own music.
   * So iOS control association is NOT guaranteed. It is still worth doing
   * because on **Android** sustained background playback requires it
   * independently of the interruption mode — without it the OS stops playback
   * after ~3 minutes (`AudioMode.shouldPlayInBackground` in the SDK docs).
   */
  useEffect(() => {
    const clip: FeedClip | undefined = playingClipId
      ? queue.find((c) => c.id === playingClipId) ?? queue[activeIndex]
      : queue[activeIndex];
    const metadata: AudioMetadata | undefined = clip
      ? {
          title: clip.title,
          artist: clip.creator_name,
          // No artwork: `cover_image` is always null (there is no upload route
          // and it is absent from `AudioUploadSerializer.Meta.fields`), and
          // passing an unreachable URL is worse than passing none.
        }
      : undefined;
    player.setActiveForLockScreen(true, metadata);
  }, [player, playingClipId, queue, activeIndex]);

  return null;
}
