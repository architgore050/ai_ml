import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { interactionsAPI, mediaAPI } from "../api/client";
import { FeedClip } from "../types/echoflow";

interface PlayerContextType {
  currentClip: FeedClip | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  progress: number;
  playbackRate: number;
  volume: number;
  queue: FeedClip[];
  audioFrequencies: number[];
  playbackError: string | null;
  handsFreeMode: boolean;
  playClip: (clip: FeedClip, newQueue?: FeedClip[]) => void;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  seek: (seconds: number) => void;
  skipForward: (seconds?: number) => void;
  skipBackward: (seconds?: number) => void;
  nextClip: (reason?: "manual" | "auto") => void;
  prevClip: () => void;
  setRate: (rate: number) => void;
  setHandsFreeMode: (val: boolean) => void;
  setQueue: (clips: FeedClip[]) => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export const PlayerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentClip, setCurrentClip] = useState<FeedClip | null>(null);
  const [queue, setQueue] = useState<FeedClip[]>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [volume, _setVolume] = useState<number>(1);
  const [audioFrequencies, setAudioFrequencies] = useState<number[]>(new Array(24).fill(10));
  const [handsFreeMode, setHandsFreeMode] = useState<boolean>(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const watchTimeRef = useRef<number>(0);
  const lastTelemetryRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(0);
  const currentClipRef = useRef<FeedClip | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(() => {
    currentClipRef.current = currentClip;
  }, [currentClip]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      const cur = audio.currentTime;
      const dur = audio.duration || 1;
      setCurrentTime(cur);
      setDuration(dur);
      watchTimeRef.current += 250; // increment watch time

      // Periodic heartbeat telemetry every ~6 seconds (Spec FR-TEL-1)
      const now = Date.now();
      const clip = currentClipRef.current;
      if (now - lastTelemetryRef.current > 6000 && clip) {
        lastTelemetryRef.current = now;
        interactionsAPI.logTelemetry(clip.id, {
          action_type: "view",
          watch_time_ms: Math.floor(cur * 1000),
        }).catch(() => {});
      }

      // Auto-advance when near end
      if (dur > 0 && cur / dur >= 0.99) {
        handleAutoAdvance();
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => {
      setIsPlaying(false);
      // Final telemetry on pause
      const clip = currentClipRef.current;
      if (clip && audio.currentTime > 0) {
        interactionsAPI.logTelemetry(clip.id, {
          action_type: "view",
          watch_time_ms: Math.floor(audio.currentTime * 1000),
        }).catch(() => {});
      }
    };

    const handleEnded = () => {
      handleAutoAdvance();
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, []);

  // Decorative playback envelope. This is NOT an audio spectrum — there is no
  // AnalyserNode in the graph (an earlier version declared `analyserRef` and
  // `audioContextRef` and never built the graph), and the previous
  // implementation synthesised bars from Math.sin/Math.random, which both
  // re-rolled on every frame and presented noise to the user as if it were
  // measured audio.
  //
  // Per docs/mobile-rebuild-plan.md §13 the agreed substitution is a
  // deterministic pseudo-reactive envelope: smooth, reproducible, and seeded
  // once rather than randomised per frame. A real analyser would need
  // `createMediaElementSource`, which silences cross-origin media unless the
  // storage origin also returns a CORS header — so it is deliberately out of
  // scope here rather than half-built.
  useEffect(() => {
    const BAR_COUNT = 24;
    const PHASES = Array.from({ length: BAR_COUNT }, (_, i) => (i / BAR_COUNT) * Math.PI * 2);
    let raf: number | null = null;

    const update = () => {
      if (isPlaying) {
        const t = currentTimeRef.current;
        setAudioFrequencies(
          PHASES.map((phase, i) => {
            // Two incommensurable rates so the envelope never visibly repeats.
            const v = Math.sin(t * 2.1 + phase) * 0.5 + Math.sin(t * 0.7 + phase * 2) * 0.5;
            const floor = 0.18 + (i / BAR_COUNT) * 0.5; // taller toward the centre
            return Math.round((0.5 + v * 0.5) * (1 - floor) * 100);
          }),
        );
      } else {
        setAudioFrequencies(PHASES.map((_, i) => 8 + Math.round((i / BAR_COUNT) * 6)));
      }
      raf = requestAnimationFrame(update);
    };

    raf = requestAnimationFrame(update);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [isPlaying]);

  const handleAutoAdvance = () => {
    if (!currentClip) return;
    // Log complete view telemetry
    interactionsAPI.logTelemetry(currentClip.id, {
      action_type: "view",
      watch_time_ms: Math.floor(duration * 1000),
    }).catch(() => {});

    // Advance to next clip
    setTimeout(() => {
      nextClip("auto");
    }, 800);
  };

  const playClip = (clip: FeedClip, newQueue?: FeedClip[]) => {
    if (newQueue) {
      setQueue(newQueue);
    }
    setCurrentClip(clip);
    watchTimeRef.current = 0;
    lastTelemetryRef.current = Date.now();

    const audio = audioRef.current;
    if (!audio) return;

    if (!clip.hls_playlist_url) {
      console.warn("Clip has no playable stream URL yet.");
      return;
    }

    // Used VERBATIM. Never prefix the API base onto it: the HLS origin is the
    // storage/edge host (often a different host AND port from the API), and in
    // `edge` url style the bucket is not part of the path. See
    // FRONTEND-REQUIREMENTS.md §4.7 and docs/EXPLAIN/backend/07-media-urls.md.
    const url = clip.hls_playlist_url;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // SECURITY: the `hls/` prefix is not public-read. Mint the per-clip
    // credential before loading; the response sets an HttpOnly cookie that the
    // edge validates on the manifest and every segment. There is no
    // unauthenticated fallback — a token failure is terminal for this clip.
    mediaAPI
      .getPlaybackToken(clip.id)
      .then(() => {
        if (currentClipRef.current?.id !== clip.id) return; // superseded
        loadSource(audio, url);
      })
      .catch((err: any) => {
        if (currentClipRef.current?.id !== clip.id) return;
        // 409 = media still processing (retry), 403 = unmoderated or
        // unavailable, 404 = gone, 401 = session expired. The UI distinguishes
        // these; collapsing them into "playback failed" loses the only signal
        // the user can act on.
        setPlaybackError(
          err?.status === 409
            ? "Still processing…"
            : err?.status === 403
              ? "Unavailable"
              : err?.status === 404
                ? "Removed"
                : "Playback unavailable",
        );
      });
  };

  const loadSource = (audio: HTMLAudioElement, url: string) => {
    const isHls = url.includes(".m3u8");

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        // SECURITY: the media origin is cross-site in production (`media.` vs
        // `api.`), so the ef_hls_token cookie must be attached to the manifest
        // AND every segment. Without this the manifest 200s and each segment
        // 403s. This was IMP-TODO.md and was not implemented.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPlaybackError(null);
        audio.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else {
          hls.destroy();
          hlsRef.current = null;
          setPlaybackError("Playback failed");
        }
      });
    } else {
      // Safari and any non-MSE browser take the native path. The cookie still
      // has to travel, and `crossOrigin="anonymous"` will NOT send it to a
      // cross-origin URL (credentials mode is same-origin) — "use-credentials"
      // is what makes the edge accept the request.
      audio.crossOrigin = "use-credentials";
      audio.src = url;
      audio.playbackRate = playbackRate;
      setPlaybackError(null);
      audio.play().catch((err) => {
        console.warn("Auto-play blocked, waiting for user gesture:", err);
      });
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
        audio.load();
      }
      audio.play().catch((err) => {
        console.warn("Playback requires a user gesture or failed to load:", err);
      });
    }
  };

  const pause = () => audioRef.current?.pause();
  const resume = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      audio.load();
    }
    audio.play().catch((err) => {
      console.warn("Playback failed:", err);
    });
  };

  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, Math.min(seconds, audio.duration || 100));
    audio.currentTime = target;
  };

  const skipForward = (seconds = 10) => {
    const audio = audioRef.current;
    if (!audio) return;
    seek(audio.currentTime + seconds);
  };

  const skipBackward = (seconds = 10) => {
    const audio = audioRef.current;
    if (!audio) return;
    seek(audio.currentTime - seconds);
  };

  const nextClip = (reason: "manual" | "auto" = "manual") => {
    if (!currentClip || queue.length === 0) return;

    // Spec FR-TEL-2: Send skip telemetry if user manually skipped before completion
    if (reason === "manual" && currentTime < (duration || 20) * 0.9) {
      interactionsAPI.registerSkip(currentClip.id, {
        listen_duration_ms: Math.floor(currentTime * 1000),
        reel_position_ms: Math.floor(currentTime * 1000),
        reel_id: currentClip.id,
      }).catch(() => {});
    }

    const currentIndex = queue.findIndex((c) => c.id === currentClip.id);
    const nextIndex = (currentIndex + 1) % queue.length;
    const next = queue[nextIndex];
    if (next) playClip(next);
  };

  const prevClip = () => {
    if (!currentClip || queue.length === 0) return;
    const currentIndex = queue.findIndex((c) => c.id === currentClip.id);
    const prevIndex = (currentIndex - 1 + queue.length) % queue.length;
    const prev = queue[prevIndex];
    if (prev) playClip(prev);
  };

  const setRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <PlayerContext.Provider
      value={{
        currentClip,
        isPlaying,
        currentTime,
        duration,
        progress,
        playbackRate,
        volume,
        queue,
        audioFrequencies,
        playbackError,
        handsFreeMode,
        playClip,
        togglePlay,
        pause,
        resume,
        seek,
        skipForward,
        skipBackward,
        nextClip,
        prevClip,
        setRate,
        setHandsFreeMode,
        setQueue,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
};
