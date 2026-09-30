/**
 * `stores/player.tsx` — the media player hub.
 *
 * Six defects live in this one file, and four of them are invisible from any
 * single call site:
 *
 *  1. A 60 Hz full-subtree re-render driven by a decorative envelope that ran
 *     forever, including while paused and on a hidden tab.
 *  2. Per-clip media state that was never reset, which fed a stale
 *     `progress >= 0.99` back into `ReelList`'s auto-advance effect and so
 *     re-minted playback tokens until the `playback_token` throttle (300/min)
 *     locked the user out of playback entirely.
 *  3. An auto-advance path that could not work and should not: repairing its
 *     stale closure would have created a skip machine alongside the one live
 *     advance in `ReelList`.
 *  4. `watch_time_ms` — which the server turns into `completion_rate`, 30 % of
 *     the ranking composite — was the media *position*, so seeking to 55 s of
 *     a 60 s clip claimed a 0.92 completion for one second of listening.
 *  5. `playbackError` was set on four conditions and read by nobody, so a
 *     403/404/409 clip rendered as a live-looking card.
 *  6. A fatal HLS network error called `startLoad()` with no bound and never
 *     re-minted, and an expired token lands in exactly that branch.
 *
 * The render-count test is the headline: it counts a real consumer's renders
 * over a fixed window rather than asserting that a `useMemo` exists.
 */

/// <reference types="vite/client" />
import React, { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { getLastAudio, setAudioDuration, type MockAudio } from "./mediaMock";
import { PlayerProvider, usePlayer } from "../stores/player";
import type { FeedClip } from "../types/echoflow";

// ---------------------------------------------------------------------------
// hls.js double
// ---------------------------------------------------------------------------
// hls.js is not mocked anywhere in the harness, and the fatal-error path is
// where the bounded remint and the bounded restart live, so the store's
// recovery behaviour is untestable without one. The double records the call
// order against the token mint, because "mint before loadSource" is a security
// ordering and not a preference.

interface HlsErrorData {
  fatal: boolean;
  type: string;
  response?: { code?: number };
}

interface HlsDouble {
  config: { xhrSetup?: (xhr: { withCredentials: boolean }) => void } | undefined;
  loadedUrl: string | null;
  attached: unknown;
  startLoadCalls: number;
  destroyCalls: number;
  emit(event: string, data?: unknown): void;
  fatal(data: Omit<HlsErrorData, "fatal">): void;
}

const hlsMock = vi.hoisted(() => {
  const EVENTS = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
  const TYPES = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
  const order: string[] = [];
  const instances: HlsDouble[] = [];
  let supported = true;

  class Hls {
    config: { xhrSetup?: (xhr: { withCredentials: boolean }) => void } | undefined;
    loadedUrl: string | null = null;
    attached: unknown = null;
    startLoadCalls = 0;
    destroyCalls = 0;
    private handlers = new Map<string, (evt: unknown, data: unknown) => void>();

    constructor(config?: { xhrSetup?: (xhr: { withCredentials: boolean }) => void }) {
      this.config = config;
      order.push("new Hls");
      instances.push(this as unknown as HlsDouble);
    }
    static isSupported(): boolean {
      return supported;
    }

    static Events = EVENTS;
    static ErrorTypes = TYPES;

    loadSource(url: string): void {
      this.loadedUrl = url;
      order.push("loadSource");
    }

    attachMedia(el: unknown): void {
      this.attached = el;
    }

    on(event: string, cb: (evt: unknown, data: unknown) => void): void {
      this.handlers.set(event, cb);
    }

    startLoad(): void {
      this.startLoadCalls += 1;
      order.push("startLoad");
    }

    destroy(): void {
      this.destroyCalls += 1;
    }

    emit(event: string, data: unknown): void {
      this.handlers.get(event)?.({}, data);
    }

    /** The hls.js fatal-error shape, with `fatal` filled in. */
    fatal(data: { type: string; response?: { code?: number } }): void {
      this.emit(EVENTS.ERROR, { fatal: true, ...data });
    }
  }

  return {
    Hls,
    EVENTS,
    TYPES,
    order,
    instances,
    get supported() {
      return supported;
    },
    set supported(v: boolean) {
      supported = v;
    },
    reset() {
      order.length = 0;
      instances.length = 0;
      supported = true;
    },
    last(): HlsDouble | undefined {
      return instances[instances.length - 1];
    },
  };
});

vi.mock("hls.js", () => ({ default: hlsMock.Hls }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClip(id: string, overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id,
    title: `Clip ${id}`,
    creator_name: "alex",
    creator_id: 42,
    category: "music",
    hls_playlist_url: `https://media.example/hls/${id}/master.m3u8`,
    likes: 0,
    shares: 0,
    skips: 0,
    comment_count: 0,
    is_liked: false,
    is_following: false,
    duration_ms: 10_000,
    tags: ["acoustic"],
    cover_image: null,
    ...overrides,
  };
}

let api: FetchMock;

/** Every playback-token mint, in order. */
const mints = (): string[] =>
  api.callsTo(/\/media\/playback-token\//).map((c) => c.url.replace(/.*playback-token\/([^/]+)\/.*/, "$1"));

/** Every telemetry `watch_time_ms`, in send order. */
const telemetryWatchMs = (): number[] =>
  api.callsTo(/\/log-telemetry\//).map((c) => Number(c.body?.watch_time_ms));

const skipCalls = () => api.callsTo(/\/register-skip\//);

let renders: number;
function Probe() {
  renders += 1;
  usePlayer();
  return null;
}

let player: ReturnType<typeof usePlayer>;

function Harness({ children }: { children?: React.ReactNode }) {
  return (
    <PlayerProvider>
      <Probe />
      <Capture />
      {children}
    </PlayerProvider>
  );
}

function Capture() {
  player = usePlayer();
  return null;
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Advance the clock one animation frame at a time, flushing React between
 * frames.
 *
 * A single `advanceTimersByTime(1000)` collapses every `setState` in the
 * window into ONE React commit (automatic batching), so it cannot measure
 * per-frame cost — it reports 1 render for 62 frames' worth of updates. A
 * browser gives each rAF callback its own task and flushes between them, so
 * the test has to as well.
 */
async function frames(count: number, stepMs = 16): Promise<void> {
  for (let i = 0; i < count; i += 1) await tick(stepMs);
}

function audio(): MockAudio {
  const instance = getLastAudio();
  if (!instance) throw new Error("no Audio instance: the provider did not mount");
  return instance;
}

beforeEach(() => {
  vi.useFakeTimers();
  hlsMock.reset();
  api = installFetchMock();
  renders = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. Render cost
// ===========================================================================

describe("render cost — a decorative envelope was re-rendering the feed 60x/second", () => {
  /**
   * Measured against the pre-fix store: **62 renders per 1000 ms, paused**.
   * 62 is the fake clock's rAF cadence, so the loop really was running a React
   * commit per frame with nothing playing.
   */
  it("does not render at all while paused", async () => {
    render(<Harness />);
    setAudioDuration(audio(), 10);
    renders = 0;

    await frames(62);

    expect(renders).toBe(0);
  });

  /**
   * Measured against the pre-fix store: **62 renders per 1000 ms, playing**.
   * The bound below is the rate limit the envelope now commits at, not a
   * "feels smoother" claim — `ENVELOPE_COMMIT_MS` is 120 ms, i.e. ~8/s.
   */
  it("stays far below one render per frame while playing", async () => {
    render(<Harness />);
    setAudioDuration(audio(), 10);
    act(() => {
      audio().play();
    });
    renders = 0;

    await frames(62);

    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThanOrEqual(14);
  });

  it("stops the loop entirely when the tab is hidden", async () => {
    render(<Harness />);
    setAudioDuration(audio(), 10);
    act(() => {
      audio().play();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    renders = 0;

    await frames(62);
    // The one render allowed for is the visibility state change itself.
    expect(renders).toBeLessThanOrEqual(2);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  });

  it("hands the envelope to a paused consumer as one referentially stable array", async () => {
    const seen: number[][] = [];
    render(
      <Harness>
        <SpectrumWatcher onChange={(v) => seen.push(v)} />
      </Harness>,
    );
    await frames(30);
    expect(seen.length).toBe(0);
  });
});

function SpectrumWatcher({ onChange }: { onChange: (v: number[]) => void }) {
  const { audioFrequencies } = usePlayer();
  const previous = useRef<number[] | null>(null);
  useEffect(() => {
    // The first observation is a baseline, not a change.
    if (previous.current === null) {
      previous.current = audioFrequencies;
      return;
    }
    if (previous.current !== audioFrequencies) {
      previous.current = audioFrequencies;
      onChange(audioFrequencies);
    }
  }, [audioFrequencies, onChange]);
  return null;
}

// ===========================================================================
// 2. Per-clip state reset
// ===========================================================================

describe("per-clip state reset", () => {
  it("clears position, progress and duration on a clip change", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clips = [makeClip("a"), makeClip("b")];
    render(<Harness />);

    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 60);
    act(() => audio().advanceTo(55));
    await tick(0);

    expect(player.currentTime).toBe(55);
    expect(player.progress).toBeGreaterThan(0.9);

    act(() => player.playClip(clips[1]!, clips));
    // Same tick, no await: the reset must land with the clip change, not after
    // the new manifest resolves. A reset that is merely eventual is still a
    // window in which the stale progress is readable.
    expect(player.currentClip?.id).toBe("b");
    expect(player.currentTime).toBe(0);
    expect(player.duration).toBe(0);
    expect(player.progress).toBe(0);
  });

  it("ignores timeupdate ticks from a source that is no longer the current clip", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clips = [makeClip("a"), makeClip("b")];
    render(<Harness />);

    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 60);
    act(() => audio().advanceTo(30));
    await tick(0);
    expect(player.currentTime).toBe(30);

    // `hls.destroy()` tears the old source down asynchronously, so a tick from
    // it can still arrive after the switch. Crediting it would carry the
    // previous clip's tail into the new clip's watch time and position.
    act(() => player.playClip(clips[1]!, clips));
    act(() => audio().emitTimeUpdate());
    expect(player.currentTime).toBe(0);
  });

  it("restarts the watched-time total for the new clip", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () => json(200, { status: "ok" }));
    const clips = [
      makeClip("a", { duration_ms: 60_000 }),
      makeClip("b", { duration_ms: 60_000 }),
    ];
    render(<Harness />);

    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 60);
    // Ten seconds of genuine watching.
    for (let i = 1; i <= 10; i += 1) {
      await tick(1000);
      act(() => audio().advanceTo(i, { seek: false }));
    }
    const watchedOnA = telemetryWatchMs().at(-1)!;
    expect(watchedOnA).toBeGreaterThan(0);

    // The switch. `hls.destroy()` detaches the old source asynchronously, so
    // the element still reports clip A's position (10 s) for a window after
    // this point — which is precisely the input a position-based
    // `watch_time_ms` turns into "the new clip was watched for 10 s".
    act(() => player.playClip(clips[1]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    expect(audio().currentTime).toBe(10);

    await tick(1000);
    act(() => audio().emitTimeUpdate());
    await tick(10_000);
    act(() => audio().emitTimeUpdate());
    await tick(0);

    const onB = api
      .callsTo(/\/log-telemetry\//)
      .filter((c) => c.url.includes("/b/"))
      .map((c) => Number(c.body?.watch_time_ms));
    expect(onB.length).toBeGreaterThan(0);
    for (const value of onB) expect(value).toBeLessThanOrEqual(2000);
  });
});

// ===========================================================================
// 3. The self-inflicted 429 spiral
// ===========================================================================

/**
 * A verbatim stand-in for `ReelList.tsx:98-106`, the feed's only live advance
 * trigger: same deps, same `progress >= 0.99` guard, same 1000 ms delay. The
 * scroll is replaced with `playClip` because that is what the scroll causes —
 * `scrollIntoView` moves the next reel past the 0.6 autoplay threshold, whose
 * `IntersectionObserver` calls `playClip(clip, clips)` (`ReelList.tsx:76-95`).
 *
 * Modelled rather than mounted because `ReelList` is not this file to change,
 * and a copy of the effect is the only way to prove the causal chain
 * end-to-end: stale progress -> effect re-arms -> new `playClip` -> new token
 * mint, repeated until the 300/min `playback_token` throttle 429s.
 */
function ReelListAdvanceModel({ clips }: { clips: FeedClip[] }) {
  const { currentClip, progress, playClip } = usePlayer();
  useEffect(() => {
    if (!currentClip || progress < 0.99) return;
    const index = clips.findIndex((c) => c.id === currentClip.id);
    if (index < 0 || index >= clips.length - 1) return;
    const timer = setTimeout(() => {
      playClip(clips[index + 1]!, clips);
    }, 1000);
    return () => clearTimeout(timer);
  }, [currentClip, progress, clips, playClip]);
  return null;
}

describe("the playback-token mint budget", () => {
  it("does not re-mint without bound when a completed clip advances the feed", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clips = Array.from({ length: 6 }, (_, i) => makeClip(`c${i}`, { duration_ms: 10_000 }));
    render(
      <Harness>
        <ReelListAdvanceModel clips={clips} />
      </Harness>,
    );

    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 10);
    act(() => audio().advanceTo(9.95));
    await tick(0);

    // One completion happened, so exactly one advance is owed. Four more
    // advance windows of clock is four more chances to spend the throttle —
    // `playback_token` is 300/min and its window is 60 s.
    for (let i = 0; i < 4; i += 1) await tick(1000);

    expect(mints()).toEqual(["c0", "c1"]);
    expect(player.currentClip?.id).toBe("c1");
  });
});

// ===========================================================================
// 4. Auto-advance ownership
// ===========================================================================

describe("auto-advance ownership", () => {
  const rawModules = import.meta.glob("../stores/player.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /**
   * Comments are stripped before the assertions: a comment that *describes* the
   * mechanism this store used to have is good documentation, and the invariant
   * is about executable code.
   */
  const storeSource = (rawModules["../stores/player.tsx"] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * The path being deleted was already unreachable at runtime, so no
   * behavioural test can be red for it: `handleAutoAdvance` closed over the
   * mount render's `currentClip`, which is `null` from `useState(null)` and
   * never updated, so it returned at its first line. Asserting "nothing
   * happens" passes for a path that is broken as well as for one that is gone.
   * The absence of the code is therefore what has to be asserted.
   *
   * The store also schedules no timer of its own. A `setTimeout` here is how the
   * 800 ms second advance came to exist, so its absence is the invariant that
   * keeps a replacement trigger from being reintroduced quietly.
   */
  it("the player store never advances the feed itself", () => {
    expect(storeSource).not.toContain("handleAutoAdvance");
    expect(storeSource).not.toContain("setTimeout");
    // A call site, not a mention. `nextClip` is defined as
    // `const nextClip = useCallback(` and typed in the context interface, so
    // neither is a call; any `nextClip(` is an advance trigger.
    expect(storeSource.match(/\bnextClip\s*\(/g) ?? []).toHaveLength(0);
    // The `"auto"` reason is gone from the module, not merely unused.
    expect(storeSource).not.toContain('"auto"');
  });
  it("a completed clip does not change the current clip or mint a token", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clips = [makeClip("a"), makeClip("b")];
    render(<Harness />);

    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 10);
    act(() => audio().advanceTo(9.99));
    act(() => audio().end());
    await tick(2000);

    expect(player.currentClip?.id).toBe("a");
    expect(mints()).toEqual(["a"]);
  });
});

// ===========================================================================
// 5. watch_time_ms is a quantity, not a position
// ===========================================================================

describe("watch_time_ms", () => {
  async function playClipFully(clip: FeedClip) {
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), clip.duration_ms / 1000);
  }

  it("reports watched time after a seek, not the position it landed on", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () => json(200, { status: "ok" }));
    await playClipFully(makeClip("a", { duration_ms: 60_000 }));

    // Seek to 0:55 of a 60 s clip, listen for one second.
    await tick(1000);
    act(() => audio().advanceTo(55));
    await tick(1000);
    act(() => audio().emitTimeUpdate());
    await tick(0);
    act(() => player.pause());
    await tick(0);

    const emitted = telemetryWatchMs();
    expect(emitted.length).toBeGreaterThan(0);
    // The whole point: ~2 s of ticks, not 55 000.
    expect(emitted.at(-1)).toBeLessThanOrEqual(2000);
  });

  it("never reports more than the clip can contain", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () => json(200, { status: "ok" }));
    // The element's position is left wherever the test put it and the
    // duration is whatever the source reports; the only clip-bound number that
    // exists on the client is `duration_ms`, so that is the cap.
    await playClipFully(makeClip("a", { duration_ms: 10_000 }));
    setAudioDuration(audio(), 55);

    for (let i = 1; i <= 15; i += 1) {
      await tick(1000);
      act(() => audio().emitTimeUpdate());
    }
    act(() => player.pause());
    await tick(0);

    for (const value of telemetryWatchMs()) {
      expect(value).toBeLessThanOrEqual(10_000);
    }
    expect(telemetryWatchMs().at(-1)).toBe(10_000);
  });

  it("is non-decreasing and does not move when the user seeks", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () => json(200, { status: "ok" }));
    await playClipFully(makeClip("a", { duration_ms: 60_000 }));

    for (let i = 1; i <= 40; i += 1) {
      await tick(1000);
      act(() => audio().advanceTo(i, { seek: false }));
    }
    const beforeSeek = telemetryWatchMs();
    expect(beforeSeek.length).toBeGreaterThan(2);

    // Seek forward by 50 s. Every later claim must still be ~the same total.
    await tick(1000);
    act(() => audio().advanceTo(55));
    for (let i = 0; i < 3; i += 1) {
      await tick(7000);
      act(() => audio().emitTimeUpdate());
    }
    const all = telemetryWatchMs();
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i]).toBeGreaterThanOrEqual(all[i - 1]!);
    }
    expect(all.at(-1)!).toBeLessThanOrEqual(45_000);
  });

  it("reports the watch time, not the position, on a manual skip", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /register-skip/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () => json(200, { status: "ok" }));
    const clips = [makeClip("a", { duration_ms: 60_000 }), makeClip("b")];
    render(<Harness />);
    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    setAudioDuration(audio(), 60);

    // Three seconds of listening, then a scrub forward inside the first 90 %
    // (a skip past 90 % is deliberately NOT recorded as a skip).
    for (let i = 1; i <= 3; i += 1) {
      await tick(1000);
      act(() => audio().advanceTo(i, { seek: false }));
    }
    await tick(1000);
    act(() => audio().advanceTo(30));
    await tick(0);
    act(() => player.nextClip("manual"));
    await tick(0);

    expect(skipCalls()).toHaveLength(1);
    const body = skipCalls()[0]!.body;
    // `listen_duration_ms` is "how long did they listen" and is what
    // `_completion_rate` divides; `reel_position_ms` is where they were and is
    // only a report. The old code sent the position for both.
    expect(body.listen_duration_ms).toBeGreaterThanOrEqual(3000);
    expect(body.listen_duration_ms).toBeLessThanOrEqual(4000);
    expect(body.reel_position_ms).toBe(30_000);
    expect(body.reel_id).toBe("a");
  });

  it("stops the 6 s heartbeat after the server refuses telemetry for good", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    api.on("POST", /log-telemetry/, () =>
      json(403, { detail: "Telemetry is not collected for minors." }),
    );
    await playClipFully(makeClip("a", { duration_ms: 60_000 }));

    for (let i = 1; i <= 12; i += 1) {
      await tick(1000);
      act(() => audio().advanceTo(i, { seek: false }));
    }
    const refusals = api.callsTo(/\/log-telemetry\//).length;
    expect(refusals).toBeGreaterThan(0);

    for (let i = 13; i <= 40; i += 1) {
      await tick(1000);
      act(() => audio().advanceTo(i, { seek: false }));
    }
    expect(api.callsTo(/\/log-telemetry\//).length).toBe(refusals);
  });
});

// ===========================================================================
// 6. playbackError
// ===========================================================================

describe("playbackError", () => {
  it("reports a clip with no playable stream instead of a dead-looking card", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a", { hls_playlist_url: null as unknown as string });
    render(<Harness />);

    act(() => player.playClip(clip, [clip]));
    await tick(0);

    // The same condition the server reports as 409: `views/media.py:239-247`
    // returns 409 when there is no HLS key to scope a token to. A 403/404/409
    // clip used to render as a normal card with a live Play button.
    expect(player.playbackError).toBe("Still processing…");
  });

  it("observes a MediaError on the native path, which nothing listened to", async () => {
    hlsMock.supported = false;
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);

    act(() => player.playClip(clip, [clip]));
    await tick(0);
    expect(player.playbackError).toBeNull();

    act(() => audio().fail(4));
    await tick(0);

    expect(player.playbackError).toBe("Playback failed");
  });

  it("is cleared by a clip change and by a successful play", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clips = [makeClip("a"), makeClip("b")];
    render(<Harness />);

    api.reset();
    api.on("POST", /playback-token/, () => json(409, { detail: "Clip media is not ready." }));
    act(() => player.playClip(clips[0]!, clips));
    await tick(0);
    expect(player.playbackError).toBe("Still processing…");

    api.reset();
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    act(() => player.playClip(clips[1]!, clips));
    // Before the new manifest resolves. A failure state that only clears once
    // playback actually starts is carried across the whole switch, and it is
    // what a consumer would be rendering for the new clip.
    expect(player.playbackError).toBeNull();

    await tick(0);
    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    await tick(0);

    expect(player.playbackError).toBeNull();
  });
});

// ===========================================================================
// 7. Token lifetime and bounded recovery
// ===========================================================================

describe("token recovery", () => {
  it("remints exactly once when the edge answers 403, then plays", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    expect(mints()).toHaveLength(1);

    act(() => hlsMock.last()!.fatal({ type: hlsMock.TYPES.NETWORK_ERROR, response: { code: 403 } }));
    await tick(0);
    expect(mints()).toHaveLength(2);

    act(() => hlsMock.last()!.emit(hlsMock.EVENTS.MANIFEST_PARSED, {}));
    await tick(0);
    expect(player.playbackError).toBeNull();
  });

  it("surfaces a terminal failure instead of retrying a 403 for ever", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    for (let i = 0; i < 6; i += 1) {
      const hls = hlsMock.last();
      if (hls) act(() => hls.fatal({ type: hlsMock.TYPES.NETWORK_ERROR, response: { code: 403 } }));
      await tick(0);
    }

    expect(mints()).toHaveLength(2);
    expect(player.playbackError).toBe("Playback failed");
  });

  it("remints once on a 401 from the token endpoint, which never refreshes", async () => {
    let calls = 0;
    api.on("POST", /playback-token/, () => {
      calls += 1;
      return calls === 1 ? json(401, { detail: "Token is invalid or expired" }) : json(200, { status: "ok" });
    });
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    await tick(0);

    expect(mints()).toHaveLength(2);
    expect(player.playbackError).toBeNull();
  });

  it("stops after one remint when the token endpoint keeps answering 401", async () => {
    api.on("POST", /playback-token/, () => json(401, { detail: "Token is invalid or expired" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    await tick(50);

    expect(mints()).toHaveLength(2);
    expect(player.playbackError).not.toBeNull();
  });

  it("does not re-mint a 403 from the token endpoint: a rights refusal is not a stale token", async () => {
    api.on("POST", /playback-token/, () => json(403, { detail: "Clip is not available." }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    await tick(50);

    expect(mints()).toHaveLength(1);
    expect(player.playbackError).toBe("Unavailable");
  });

  it("bounds the generic network restart that used to loop for the session", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    for (let i = 0; i < 8; i += 1) {
      act(() => hlsMock.last()!.fatal({ type: hlsMock.TYPES.NETWORK_ERROR }));
      await tick(0);
    }

    const restarts = hlsMock.instances.reduce((n, h) => n + h.startLoadCalls, 0);
    expect(restarts).toBeLessThanOrEqual(2);
    expect(player.playbackError).toBe("Playback failed");
  });
});

// ===========================================================================
// 8. Must-preserve contracts
// ===========================================================================

describe("must-preserve: the token handshake", () => {
  it("mints before loadSource, and sends the cookie credential", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);

    act(() => player.playClip(clip, [clip]));
    await tick(0);

    expect(hlsMock.order).toEqual(["new Hls", "loadSource"]);
    const mint = api.callsTo(/playback-token/)[0]!;
    expect(mint.method).toBe("POST");
    expect(mint.credentials).toBe("include");
  });

  it("sets withCredentials on every hls request", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    const setup = hlsMock.last()!.config?.xhrSetup;
    expect(setup).toBeTypeOf("function");
    const xhr = { withCredentials: false };
    setup!(xhr);
    expect(xhr.withCredentials).toBe(true);
  });

  it("uses the credentials CORS mode on the native path", async () => {
    hlsMock.supported = false;
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    expect(audio().crossOrigin).toBe("use-credentials");
    expect(audio().src).toBe(clip.hls_playlist_url);
  });

  it("uses the clip's playlist URL verbatim", async () => {
    api.on("POST", /playback-token/, () => json(200, { status: "ok" }));
    const url = "https://media.example:9443/hls/abc/master.m3u8";
    const clip = makeClip("a", { hls_playlist_url: url });
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    expect(hlsMock.last()!.loadedUrl).toBe(url);
  });
});

describe("must-preserve: the 409 is a server answer, not a client bug", () => {
  it("shows the 409 state and does not retry it", async () => {
    api.on("POST", /playback-token/, () => json(409, { detail: "Clip media is not ready." }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);
    await tick(10_000);

    expect(player.playbackError).toBe("Still processing…");
    expect(mints()).toHaveLength(1);
  });

  it.each([
    [403, "Unavailable"],
    [404, "Removed"],
    [500, "Playback unavailable"],
  ])("maps %i to %s", async (status, message) => {
    api.on("POST", /playback-token/, () => json(status, { detail: "nope" }));
    const clip = makeClip("a");
    render(<Harness />);
    act(() => player.playClip(clip, [clip]));
    await tick(0);

    expect(player.playbackError).toBe(message);
  });
});

describe("must-preserve: handsFreeMode", () => {
  it("is readable and settable through the context", () => {
    render(<Harness />);
    expect(player.handsFreeMode).toBe(true);
    act(() => player.setHandsFreeMode(false));
    expect(player.handsFreeMode).toBe(false);
    act(() => player.setHandsFreeMode(true));
    expect(player.handsFreeMode).toBe(true);
  });
});
