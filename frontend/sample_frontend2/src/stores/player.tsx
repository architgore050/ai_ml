import { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { AudioClip, PlayerState } from '../types';
import { interactionsAPI, mediaAPI } from '../api/client';
import Hls from 'hls.js';

const PlayerContext = createContext<PlayerState | null>(null);
export const usePlayer = () => useContext(PlayerContext)!;

interface Props { children: ReactNode; toast?: (msg: string, type?: string) => void; }

export function PlayerProvider({ children }: Props) {
  const [active, setActive] = useState<AudioClip | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [isBuffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const hlsRef = useRef<Hls | null>(null);
  const startRef = useRef<number | null>(null);

  const killHLS = useCallback(() => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    a.ontimeupdate = () => {
      if (a.duration) {
        setProgress(a.currentTime / a.duration);
        setDuration(a.duration);
      }
      if (a.buffered.length) setBuffered(a.buffered.end(a.buffered.length - 1) / (a.duration || 1));
    };
    a.onwaiting = () => setBuffering(true);
    a.onplaying = () => setBuffering(false);
    a.onended = () => { setPlaying(false); setProgress(1); };
    a.onerror = () => { setError('Playback error'); setPlaying(false); };
    return () => { killHLS(); };
  }, [killHLS]);

  const loadSource = useCallback(async (clip: AudioClip) => {
    const a = audioRef.current;
    killHLS();
    a.pause();
    setError(null);
    setProgress(0); setDuration(0); setBuffered(0);
    startRef.current = Date.now();

    const src = clip.hls_playlist_url;
    if (!src) { setError('No stream available'); return; }

    const fullSrc = src.startsWith('http') ? src : (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8005') + src;

    // Try to get playback token first (best-effort)
    try {
      await mediaAPI.getPlaybackToken(clip.id);
    } catch (tokenError) {
      // Token issuance failed (403 unmoderated, 404 not found, network error)
      // Log but continue — we'll try direct HLS load
      console.warn('Playback token unavailable, attempting direct HLS load:', tokenError);
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ startLevel: -1, maxBufferLength: 30 });
      hls.loadSource(fullSrc);
      hls.attachMedia(a);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { a.play().catch(() => {}); setPlaying(true); });
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(); });
      hlsRef.current = hls;
    } else if (a.canPlayType('application/vnd.apple.mpegurl')) {
      a.src = fullSrc; a.play().catch(() => {}); setPlaying(true);
    } else {
      a.src = fullSrc; a.play().catch(() => {}); setPlaying(true);
    }
  }, [killHLS]);

  const play = useCallback(async (clip: AudioClip) => {
    if (active?.id === clip.id) {
      if (playing) { audioRef.current.pause(); setPlaying(false); }
      else { await audioRef.current.play().catch(() => {}); setPlaying(true); startRef.current = Date.now(); }
      return;
    }
    await loadSource(clip);
    setActive(clip);
  }, [active, playing, loadSource]);

  const pause = useCallback(() => { audioRef.current.pause(); setPlaying(false); }, []);
  const seek = useCallback((r: number) => { if (audioRef.current && duration) { audioRef.current.currentTime = r * duration; setProgress(r); } }, [duration]);
  const skipForward = useCallback((s: number = 10) => { if (audioRef.current && duration) { audioRef.current.currentTime = Math.min(audioRef.current.currentTime + s, duration); } }, [duration]);
  const skipBackward = useCallback((s: number = 10) => { if (audioRef.current) { audioRef.current.currentTime = Math.max(audioRef.current.currentTime - s, 0); } }, []);
  const listenMs = useCallback(() => startRef.current ? Date.now() - startRef.current : 0, []);

  // ISSUE-10: Telemetry heartbeat — fire interval every 5s while playing,
  // batch events locally, flush when watch_time_ms >= 5000 or on pause/ended.
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const telemetryBatchRef = useRef<{ clipId: string; watch_time_ms: number; events: Array<{ action_type: string; watch_time_ms: number }> }>({ clipId: '', watch_time_ms: 0, events: [] });

  const flushTelemetry = useCallback(async (clipId: string, finalMs?: number) => {
    const batch = telemetryBatchRef.current;
    if (batch.clipId !== clipId && !finalMs) return;
    const totalMs = finalMs !== undefined ? finalMs : batch.watch_time_ms;
    if (totalMs > 0) {
      try {
        await interactionsAPI.logTelemetry(clipId, { action_type: 'view', watch_time_ms: totalMs });
      } catch {
        // Ignore telemetry errors
      }
    }
    telemetryBatchRef.current = { clipId: '', watch_time_ms: 0, events: [] };
  }, []);

  useEffect(() => {
    if (!active) return;
    telemetryBatchRef.current.clipId = active.id;
    telemetryBatchRef.current.watch_time_ms = 0;
    heartbeatIntervalRef.current = setInterval(() => {
      if (playing && active) {
        const delta = 5000; // 5s interval
        telemetryBatchRef.current.watch_time_ms += delta;
        if (telemetryBatchRef.current.watch_time_ms >= 5000) {
          flushTelemetry(active.id, telemetryBatchRef.current.watch_time_ms);
        }
      }
    }, 5000);
    return () => {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
      if (active) {
        flushTelemetry(active.id, telemetryBatchRef.current.watch_time_ms);
      }
    };
  }, [active, playing, flushTelemetry]);

  useEffect(() => {
    if (!active) return;
    return () => {
      const ms = listenMs();
      if (ms > 800) interactionsAPI.logTelemetry(active.id, { action_type: 'view', watch_time_ms: ms }).catch(() => {});
    };
  }, [active, listenMs]);

  const ctx: PlayerState = {
    active, playing, progress, duration, buffered, isBuffering, error,
    play, pause, seek, skipForward, skipBackward, listenMs,
    destroy: () => { killHLS(); audioRef.current.pause(); setActive(null); setPlaying(false); },
    loadHLSIfNeeded: () => {},
  };

  return <PlayerContext.Provider value={ctx}>{children}</PlayerContext.Provider>;
}