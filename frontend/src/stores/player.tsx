import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  /**
   * Why playback is not running, in the user's terms, or `null`.
   *
   * A consumer renders this instead of a live-looking Play button. Every value
   * here is a real server answer, not a guess:
   *
   * - `"Still processing…"` — no encoded media yet (409, or a clip whose
   *   `hls_playlist_url` is still null; the server says 409 for exactly this at
   *   `views/media.py:239-247`).
   * - `"Unavailable"` — refused: unmoderated, non-commercial, or share-alike
   *   (403).
   * - `"Removed"` — gone (404).
   * - `"Playback failed"` — the media pipeline itself failed: a bounded number
   *   of load attempts were exhausted, or the element reported a `MediaError`.
   * - `"Playback unavailable"` — anything else, including a 429 on the token
   *   endpoint and a dead connection.
   *
   * Cleared on a clip change and by a successful play, so a stale failure can
   * never be rendered against the next clip.
   */
  playbackError: string | null;
  /**
   * Read and written by `Header` and rendered as a label by `Feed`. It gates
   * no path here: auto-advance belongs to `ReelList`, and this store never
   * advances the feed. It is exposed unchanged so the peer work gating
   * `ReelList`'s paths on it has something to read.
   */
  handsFreeMode: boolean;
  playClip: (clip: FeedClip, newQueue?: FeedClip[]) => void;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  seek: (seconds: number) => void;
  skipForward: (seconds?: number) => void;
  skipBackward: (seconds?: number) => void;
  /**
   * `"auto"` is gone. The store used to accept it and route it through an
   * 800 ms `setTimeout`, and `ReelList` independently scrolled the feed on
   * `progress >= 0.99`. With both live, every clip longer than 20 s — which is
   * essentially the catalogue, since the cap is 300 s — advanced twice, and
   * the reel the user was meant to watch was skipped. `ReelList`'s scroll is
   * the only advance, and narrowing the type keeps a second trigger from being
   * reintroduced through this one.
   */
  nextClip: (reason?: "manual") => void;
  prevClip: () => void;
  setRate: (rate: number) => void;
  setHandsFreeMode: (val: boolean) => void;
  setQueue: (clips: FeedClip[]) => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Decorative envelope
// ---------------------------------------------------------------------------
// These bars are NOT an audio spectrum. There is no AnalyserNode in the graph
// (an earlier version declared `analyserRef` and `audioContextRef` and never
// built the graph), and the previous implementation synthesised bars from
// Math.sin/Math.random, which both re-rolled on every frame and presented noise
// to the user as if it were measured audio.
//
// Per docs/mobile-rebuild-plan.md §13 the agreed substitution is a
// deterministic pseudo-reactive envelope: smooth, reproducible, and seeded once
// rather than randomised per frame. A real analyser would need
// `createMediaElementSource`, which silences cross-origin media unless the
// storage origin also returns a CORS header — so it is deliberately out of
// scope here rather than half-built.

const BAR_COUNT = 24;
const PHASES = Array.from({ length: BAR_COUNT }, (_, i) => (i / BAR_COUNT) * Math.PI * 2);

/**
 * The paused envelope. Module-level and never reallocated, so a paused player
 * hands every consumer the *same array reference* for the life of the session.
 *
 * That reference identity is the load-bearing part, not tidiness. The old
 * implementation built a fresh array inside an unconditional
 * `requestAnimationFrame` loop, so React saw a new value every frame and
 * committed the whole provider subtree 60 times a second — with nothing playing,
 * and in a background tab. `ReelCard` renders 24 bars and MiniPlayer 5, and the
 * feed mounts ten cards, so that was ~700 element updates a second of pure
 * ornament.
 */
const IDLE_ENVELOPE: number[] = PHASES.map((_, i) => 8 + Math.round((i / BAR_COUNT) * 6));

function playingEnvelope(t: number): number[] {
  return PHASES.map((phase, i) => {
    // Two incommensurable rates so the envelope never visibly repeats.
    const v = Math.sin(t * 2.1 + phase) * 0.5 + Math.sin(t * 0.7 + phase * 2) * 0.5;
    const floor = 0.18 + (i / BAR_COUNT) * 0.5; // taller toward the centre
    return Math.round((0.5 + v * 0.5) * (1 - floor) * 100);
  });
}

/**
 * How often the envelope may reach React state, in ms.
 *
 * `duration-75` on the bars means a 75 ms transition bridges updates up to
 * roughly 12-15 Hz without the motion reading as stepped. Committing every
 * animation frame instead costs 4x the renders to move the bars 4x faster,
 * which nobody can see and everybody pays for.
 */
const ENVELOPE_COMMIT_MS = 120;

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Spec FR-TEL-1's heartbeat cadence. The `telemetry` scope is 60/min. */
const TELEMETRY_INTERVAL_MS = 6000;

/**
 * The most watch time one `timeupdate` tick can be credited.
 *
 * `timeupdate` is specified to fire every 15-250 ms, so a healthy tick is worth
 * a few hundred ms. A gap of 2 s or more means the tick was late — a backgrounded
 * tab, a device sleep, a long GC pause — and crediting the full wall-clock gap
 * would let a stalled page claim eight hours of watching. Clamping errs towards
 * under-reporting, which is the safe direction: the server's divisor is fixed
 * (`services/interactions.py:282-283`) so a smaller numerator is merely a
 * pessimistic completion, while a larger one is a fabricated one.
 */
const MAX_TICK_CREDIT_MS = 1000;

// ---------------------------------------------------------------------------
// Token recovery bounds
// ---------------------------------------------------------------------------

/**
 * How many times one clip's playback token may be re-minted.
 *
 * A clip cannot outlast its token during continuous playback: the cap is 300 s
 * and `MEDIA_TOKEN_TTL_SECONDS` defaults to 600. The real expiry is a long
 * pause or a backgrounded tab, because the cookie's `Max-Age` is the token TTL
 * and the browser drops it on that clock regardless of activity
 * (`views/media.py:264`). One remint covers that. There is deliberately no
 * unauthenticated fallback: the `hls/` prefix is not public-read, so dropping
 * `credentials` or `withCredentials` turns every segment into a 403 rather
 * than into playback.
 */
const MAX_REMINT_ATTEMPTS = 1;

/**
 * How many times a fatal network error may be restarted without a new token.
 *
 * hls.js's own retry policy is finite per load attempt, but it escalates to a
 * fatal error when exhausted — and the old handler answered every fatal network
 * error with `startLoad()`, which resets that counter. The sequence was: retry
 * N times, fatal, `startLoad()`, retry N times, for the life of the session.
 */
const MAX_NETWORK_RESTARTS = 2;

/**
 * The HTTP status of a rejected call, or `undefined` if the failure was not an
 * HTTP response.
 *
 * Read structurally rather than with `instanceof ApiError` so that a change to
 * how `client.ts` throws degrades to `undefined` (the documented default
 * message) instead of silently collapsing every status-specific sentence into
 * one.
 */
function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  const status = (err as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** The user-facing sentence for a token that could not be minted. */
function messageForTokenFailure(err: unknown): string {
  // 409 = media still processing, 403 = unmoderated or unavailable,
  // 404 = gone, 401 = session expired. These are distinguished because they
  // are the only signals the user can act on: a 409 resolves by itself, a 403
  // never will, and a 404 means the reel is not coming back.
  const status = httpStatus(err);
  if (status === 409) return "Still processing…";
  if (status === 403) return "Unavailable";
  if (status === 404) return "Removed";
  return "Playback unavailable";
}

/**
 * Whether a second mint of the same clip could plausibly succeed.
 *
 * 401 only. `getPlaybackToken` is a raw `fetch` that deliberately does not
 * enter the access-token refresh path (`client.ts:753-783`), so a 401 there
 * means the JWT itself is stale — the exact condition a re-mint rides over,
 * because the cookie is set by the response and not by the access token.
 *
 * A 403 from the *mint* is a rights decision — unmoderated, non-commercial, or
 * share-alike (`views/media.py`) — not an expired credential. The identical
 * request returns the identical 403, so retrying it spends the 300/min
 * `playback_token` budget to learn nothing: the same reasoning that forbids
 * retrying a 409 until the encode finishes. The 401/403 that genuinely
 * expires is the *edge's* answer to an `/hls/*` request, and that arrives
 * through hls.js, not through here — see `onSourceFailure`.
 */
function isRemintable(err: unknown): boolean {
  return httpStatus(err) === 401;
}

export const PlayerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentClip, setCurrentClip] = useState<FeedClip | null>(null);
  const [queue, setQueue] = useState<FeedClip[]>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [volume, _setVolume] = useState<number>(1);
  const [audioFrequencies, setAudioFrequencies] = useState<number[]>(IDLE_ENVELOPE);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [handsFreeMode, setHandsFreeMode] = useState<boolean>(true);
  /**
   * A hidden tab has no compositor, so its animation frames buy nothing: they
   * cost a React commit per frame for ornament that is not on screen. Tracked as
   * state so the envelope effect can stop scheduling frames at all, rather than
   * waking up 60 times a second to decide there is nothing to draw.
   */
  const [isVisible, setIsVisible] = useState<boolean>(() => !document.hidden);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playbackRateRef = useRef<number>(1);
  /**
   * Latched when the server refuses telemetry outright, so the 6 s heartbeat
   * stops rather than retrying a decision that will not change. It records that
   * the server said no, not anything about who the user is: a minor's telemetry
   * is refused permanently (`views/interactions.py:65-72`), and inferring or
   * transmitting minority status from the client is exactly what DPDP §9 rules
   * out. A 429 or a network blip leaves this unset, because those can pass.
   */
  const telemetryRefusedRef = useRef<boolean>(false);

  /**
   * Every mutable fact the media event handlers need, in one place.
   *
   * The event listeners are registered once, in a `[]` effect, so a handler that
   * closed over render state would read the values from the mount render for
   * the life of the provider. That is not a style complaint: it is why the old
   * `handleAutoAdvance` was permanently dead — it closed over a `currentClip`
   * that was `null` on the mount render and never became anything else — and it
   * is why `nextClip`'s own `currentClip`/`queue` reads were equally dead. Every
   * value below is either a ref, a `useState` setter, or a module function, so
   * no handler can be stale.
   */
  const session = useRef({
    /** The clip the UI considers current. Set synchronously by `playClip`. */
    clip: null as FeedClip | null,
    /** The clip whose source is attached to the element, if any. */
    sourceClip: null as FeedClip | null,
    /**
     * Whether the element's `currentTime`/`duration` belong to `sourceClip`
     * yet.
     *
     * A clip switch attaches the new source to the same element, and the
     * element keeps reporting the *outgoing* source's position until the
     * incoming one publishes metadata. Reading it in that window shows the new
     * clip at the old clip's position — a visible jump in the scrubber, and a
     * stale position landing in the new clip's watch time.
     */
    sourceReady: false,
    currentTime: 0,
    durationSecs: 0,
    /**
     * Accumulated watch time for the current clip, in ms.
     *
     * This is the fix for `watch_time_ms` being the media *position*.
     * `services/interactions.py:282-283` computes
     * `completion_rate = min(watch_time_ms / clip.duration_ms, 1.0)` and that
     * feeds `AudioClip.avg_completion_rate`, which is 30 % of the ranking
     * composite. Sending `audio.currentTime * 1000` therefore let a user seek
     * to 0:55 of a 60 s clip and record a 0.92 completion for one second of
     * listening. Wall-clock deltas between ticks are immune to seeking, are
     * monotone, and make `completion_rate` mean what the server computes it to
     * mean. The residual is inherent: a client can still *under*-report, and
     * nothing in a browser can verify watch time.
     */
    watchedMs: 0,
    lastTickAt: 0,
    lastTelemetryAt: 0,
    remints: 0,
    networkRestarts: 0,
  });

  useEffect(() => {
    const onVisibilityChange = () => setIsVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  /**
   * The `watch_time_ms` value to send for `clip`: accumulated watch time,
   * capped at the clip's length.
   *
   * Both caps are the smaller of the two lengths the client knows — the media
   * element's and the server's own `duration_ms` — so a stale element (a paused
   * tab reporting the previous clip's duration) or a rounded encoder duration
   * cannot produce a numerator that divides above 1.0. The server clamps
   * anyway (`min(..., 1.0)`); this makes the claim true before it is sent rather
   * than after it is stored.
   */
  const reportableWatchedMs = useCallback((clip: FeedClip | null): number => {
    const watched = Math.max(0, Math.round(session.current.watchedMs));
    if (!clip) return watched;
    const elementMs =
      Number.isFinite(session.current.durationSecs) && session.current.durationSecs > 0
        ? Math.round(session.current.durationSecs * 1000)
        : 0;
    const clipMs = clip.duration_ms;
    const cap = elementMs > 0 ? (clipMs > 0 ? Math.min(elementMs, clipMs) : elementMs) : clipMs;
    return cap > 0 ? Math.min(watched, cap) : watched;
  }, []);

  const sendViewTelemetry = useCallback(() => {
    const { clip } = session.current;
    if (!clip || telemetryRefusedRef.current) return;
    const watchTimeMs = reportableWatchedMs(clip);
    if (watchTimeMs <= 0) return;
    // Telemetry is never allowed to break playback, so this stays a catch-all.
    // It is not a silent catch: the 403 branch stops a retry that cannot
    // succeed, which is the one thing here worth acting on.
    interactionsAPI
      .logTelemetry(clip.id, { action_type: "view", watch_time_ms: watchTimeMs })
      .catch((err: unknown) => {
        if (httpStatus(err) === 403) telemetryRefusedRef.current = true;
      });
  }, [reportableWatchedMs]);

  const failPlayback = useCallback((message: string) => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPlaybackError(message);
  }, []);

  /**
   * Where the built source is attached. A ref, not a direct call, because
   * `startClip` needs it and the fatal-error handler needs `startClip`: the two
   * are mutually recursive and one of them has to be reached indirectly. Both
   * are stable `useCallback`s, so the ref is written once, after mount, and
   * never changes.
   */
  const mountSourceRef = useRef<(clip: FeedClip, url: string) => void>(() => {});

  const startClip = useCallback((clip: FeedClip, url: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    session.current.sourceClip = clip;

    // SECURITY: the `hls/` prefix is not public-read. Mint the per-clip
    // credential before loading; the response sets an HttpOnly cookie that the
    // edge validates on the manifest and every segment. There is no
    // unauthenticated fallback — a token failure is terminal for this clip.
    mediaAPI
      .getPlaybackToken(clip.id)
      .then(() => {
        if (session.current.clip?.id !== clip.id) return; // superseded
        mountSourceRef.current(clip, url);
      })
      .catch((err: unknown) => {
        if (session.current.clip?.id !== clip.id) return;
        if (isRemintable(err) && session.current.remints < MAX_REMINT_ATTEMPTS) {
          session.current.remints += 1;
          startClip(clip, url);
          return;
        }
        setPlaybackError(messageForTokenFailure(err));
      });
  }, []);

  const onSourceFailure = useCallback(
    (clip: FeedClip, url: string, data: { type: string; response?: { code?: number } }) => {
      const { sourceClip, remints, networkRestarts } = session.current;
      if (sourceClip?.id !== clip.id) return; // superseded by a newer clip

      const status = data.response?.code;
      if (status === 401 || status === 403) {
        // The credential the edge validates is gone. An expired token surfaces
        // here as a non-2xx, i.e. a fatal NETWORK_ERROR, which is precisely why
        // the old handler could never recover: it answered those with
        // `startLoad()` and no re-mint, for ever.
        if (remints < MAX_REMINT_ATTEMPTS) {
          session.current.remints += 1;
          startClip(clip, url);
          return;
        }
        failPlayback("Playback failed");
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (networkRestarts < MAX_NETWORK_RESTARTS) {
          session.current.networkRestarts += 1;
          hlsRef.current?.startLoad();
          return;
        }
        failPlayback("Playback failed");
        return;
      }

      // A media error is not recoverable: the stream itself is undecodable.
      failPlayback("Playback failed");
    },
    [failPlayback, startClip],
  );

  const mountSource = useCallback(
    (clip: FeedClip, url: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      if (url.includes(".m3u8") && Hls.isSupported()) {
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
        // Used VERBATIM. Never prefix the API base onto it: the HLS origin is the
        // storage/edge host (often a different host AND port from the API), and
        // in `edge` url style the bucket is not part of the path. See
        // FRONTEND-REQUIREMENTS.md §4.7 and docs/EXPLAIN/backend/07-media-urls.md.
        hls.loadSource(url);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (session.current.clip?.id !== clip.id) return;
          session.current.sourceReady = true;
          setPlaybackError(null);
          audio.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          onSourceFailure(clip, url, data);
        });
      } else {
        // Safari and any non-MSE browser take the native path. The cookie still
        // has to travel, and `crossOrigin="anonymous"` will NOT send it to a
        // cross-origin URL (credentials mode is same-origin) —
        // "use-credentials" is what makes the edge accept the request.
        audio.crossOrigin = "use-credentials";
        audio.src = url;
        audio.playbackRate = playbackRateRef.current;
        audio.play().catch((err) => {
          console.warn("Auto-play blocked, waiting for user gesture:", err);
        });
      }
    },
    [onSourceFailure],
  );

  useEffect(() => {
    mountSourceRef.current = mountSource;
  }, [mountSource]);

  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      const { sourceClip, clip, sourceReady } = session.current;
      // A clip switch tears the old source down asynchronously — `hls.destroy()`
      // detaches the element and the new manifest is a network round trip — so
      // the element can still be reporting the *outgoing* source's position
      // after `currentClip` has already changed. Reading it would carry the
      // previous clip's position into the new clip's state and its watch time.
      if (!sourceClip || sourceClip.id !== clip?.id || !sourceReady) return;

      const now = Date.now();
      const elementDuration = audio.duration;
      if (Number.isFinite(elementDuration) && elementDuration > 0) {
        if (elementDuration !== session.current.durationSecs) {
          session.current.durationSecs = elementDuration;
          setDuration(elementDuration);
        }
      }
      session.current.currentTime = audio.currentTime;
      setCurrentTime(audio.currentTime);

      const lastTickAt = session.current.lastTickAt;
      session.current.lastTickAt = now;
      if (lastTickAt > 0) {
        const delta = now - lastTickAt;
        if (delta > 0) {
          session.current.watchedMs += Math.min(delta, MAX_TICK_CREDIT_MS);
        }
      }

      // Periodic heartbeat telemetry every ~6 seconds (Spec FR-TEL-1)
      if (now - session.current.lastTelemetryAt > TELEMETRY_INTERVAL_MS) {
        session.current.lastTelemetryAt = now;
        sendViewTelemetry();
      }
    };

    const handleLoadedMetadata = () => {
      // The element now has metadata, so the values it reports belong to the
      // source that is attached. `sourceReady` is deliberately not reset here:
      // a `loadedmetadata` from the outgoing source can still land after the
      // swap, and the only wrong outcome is one early tick being attributed to
      // the new clip — which `sourceClip.id === clip.id` still holds.
      if (session.current.sourceClip) {
        session.current.sourceReady = true;
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      // The element is playing, so any earlier failure state is stale. This is
      // the only "success" signal on the native path: `audio.play()` rejects
      // rather than firing `play` when the gesture is missing or the source is
      // dead, so the error state cannot be cleared by a failure.
      setPlaybackError(null);
    };

    const handlePause = () => {
      setIsPlaying(false);
      // Final telemetry on pause. `watchedMs` is already clamped and is what
      // makes this a quantity, so the previous clip's position cannot be
      // reported against this clip. The cadence moves with it so a
      // pause-then-resume inside the window does not claim the same total twice.
      session.current.lastTelemetryAt = Date.now();
      sendViewTelemetry();
    };

    const handleElementError = () => {
      // hls.js reports its own failures through `Hls.Events.ERROR`; while it is
      // driving the element, an element-level `MediaError` is not the signal.
      // On the native path there was no listener at all, so a 403 manifest
      // produced a dead player with no error and no way to tell.
      if (hlsRef.current) return;
      failPlayback("Playback failed");
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("error", handleElementError);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("error", handleElementError);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [failPlayback, sendViewTelemetry]);

  // The decorative envelope. Gated on both conditions under which it has
  // nothing to say — paused, and a hidden tab — and rate-limited to
  // `ENVELOPE_COMMIT_MS` when it does. A paused player hands out the same
  // frozen array and commits nothing at all.
  useEffect(() => {
    if (!isPlaying || !isVisible) {
      setAudioFrequencies(IDLE_ENVELOPE);
      return;
    }

    let frame: number | null = null;
    let lastCommit = 0;

    const update = () => {
      frame = requestAnimationFrame(update);
      const now = Date.now();
      if (now - lastCommit < ENVELOPE_COMMIT_MS) return;
      lastCommit = now;
      setAudioFrequencies(playingEnvelope(session.current.currentTime));
    };

    frame = requestAnimationFrame(update);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isPlaying, isVisible]);

  const playClip = useCallback(
    (clip: FeedClip, newQueue?: FeedClip[]) => {
      if (newQueue) {
        setQueue(newQueue);
      }
      setCurrentClip(clip);
      // A failure belongs to the clip that produced it. Leaving it set would
      // have the next clip render a 403 it never received.
      setPlaybackError(null);

      // Reset the per-clip media state in the same commit as the clip itself.
      //
      // This is not tidiness. `ReelList`'s auto-advance effect
      // (`ReelList.tsx:98-106`) depends on `[currentClip, progress, clips]` and
      // arms a 1000 ms scroll on `progress >= 0.99`. With `currentTime` and
      // `duration` left at the previous clip's values, `progress` was still
      // ~1.0 at the moment `currentClip` changed, so the guard passed on stale
      // data, a fresh timer was armed for the *new* clip's successor, the scroll
      // fired, the `IntersectionObserver` autoplayed it, and each of those
      // called `playClip` — which mints a token. The feed re-armed itself once
      // per second until the `playback_token` throttle (300/min) refused every
      // subsequent play. One stale field locked the user out of playback.
      const s = session.current;
      s.clip = clip;
      s.sourceClip = null;
      s.sourceReady = false;
      s.currentTime = 0;
      s.durationSecs = 0;
      s.watchedMs = 0;
      s.lastTickAt = 0;
      s.lastTelemetryAt = Date.now();
      s.remints = 0;
      s.networkRestarts = 0;
      setCurrentTime(0);
      setDuration(0);
      // `hls.destroy()` does not reliably fire `pause` (it detaches the element
      // and resets it, which fires `emptied`, not `pause`), so without this the
      // next clip would report as playing before it had a source.
      setIsPlaying(false);

      const audio = audioRef.current;
      if (!audio) return;

      if (!clip.hls_playlist_url) {
        // The server reports this exact condition as 409 — there is no HLS key
        // to scope a token to (`views/media.py:239-247`) — and the feed does
        // not filter on `status='ready'`, so a share or a profile row can
        // hand `playClip` a clip with no stream. It used to `console.warn` and
        // return, which left a card that looked playable and never played.
        console.warn("Clip has no playable stream URL yet.");
        setPlaybackError("Still processing…");
        return;
      }

      startClip(clip, clip.hls_playlist_url);
    },
    [startClip],
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || session.current.clip === null) return;

    // The element's own `paused` is the state of record, not `isPlaying`: it
    // cannot lag a `pause` the element has already applied, which is how the
    // card's play/pause label and the control could disagree.
    if (audio.paused) {
      if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
        audio.load();
      }
      audio.play().catch((err) => {
        console.warn("Playback requires a user gesture or failed to load:", err);
      });
    } else {
      audio.pause();
    }
  }, []);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const resume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      audio.load();
    }
    audio.play().catch((err) => {
      console.warn("Playback failed:", err);
    });
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, Math.min(seconds, audio.duration || 100));
    audio.currentTime = target;
  }, []);

  const skipForward = useCallback((seconds = 10) => {
    const audio = audioRef.current;
    if (!audio) return;
    seek(audio.currentTime + seconds);
  }, [seek]);

  const skipBackward = useCallback((seconds = 10) => {
    const audio = audioRef.current;
    if (!audio) return;
    seek(audio.currentTime - seconds);
  }, [seek]);

  const nextClip = useCallback(
    (reason: "manual" = "manual") => {
      const { clip, currentTime, durationSecs } = session.current;
      if (!clip) return;
      const index = queue.findIndex((c) => c.id === clip.id);
      // A clip that is not in the queue (played from Inbox, or from a card that
      // passed no queue) has no "next" here: the old code computed -1 and
      // wrapped to index 0, which jumped into the feed's first clip.
      if (index < 0 || queue.length === 0) return;

      // Spec FR-TEL-2: Send skip telemetry if user manually skipped before completion
      if (reason === "manual" && currentTime < (durationSecs || 20) * 0.9) {
        interactionsAPI
          .registerSkip(clip.id, {
            // `listen_duration_ms` is the quantity `_completion_rate` divides by
            // the clip duration (`services/interactions.py:167-188`), so it is
            // the watch time. `reel_position_ms` is where the user was and stays
            // the position — the server stopped using it as the divisor in
            // 20f6e7e, and it is the only record of the seek.
            listen_duration_ms: reportableWatchedMs(clip),
            reel_position_ms: Math.floor(currentTime * 1000),
            reel_id: clip.id,
          })
          .catch(() => {});
      }

      const next = queue[(index + 1) % queue.length];
      if (next) playClip(next);
    },
    [playClip, queue, reportableWatchedMs],
  );

  const prevClip = useCallback(() => {
    const { clip } = session.current;
    if (!clip) return;
    const index = queue.findIndex((c) => c.id === clip.id);
    if (index < 0 || queue.length === 0) return;
    const prev = queue[(index - 1 + queue.length) % queue.length];
    if (prev) playClip(prev);
  }, [playClip, queue]);

  const setRate = useCallback((rate: number) => {
    playbackRateRef.current = rate;
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  const progress = duration > 0 ? currentTime / duration : 0;

  /**
   * One memoized value object.
   *
   * React re-renders every consumer of a context whenever the context *value*
   * changes identity — not the fields a particular consumer read. The old value
   * was a fresh object literal on every render, so a 60 Hz state change
   * re-rendered all ten consumers whether or not they used the field that
   * changed. Memoized, the value only changes identity when one of these
   * inputs does, which is why a paused, hidden, idle provider now commits
   * nothing at all.
   */
  const value = useMemo<PlayerContextType>(
    () => ({
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
    }),
    // `setRate`, `setHandsFreeMode` and `setQueue` are omitted: all three are
    // `useCallback`/`useState` identities that can never change.
    [
      audioFrequencies,
      currentClip,
      currentTime,
      duration,
      handsFreeMode,
      isPlaying,
      nextClip,
      playClip,
      playbackError,
      playbackRate,
      prevClip,
      progress,
      queue,
      resume,
      seek,
      skipBackward,
      skipForward,
      togglePlay,
      volume,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
};
