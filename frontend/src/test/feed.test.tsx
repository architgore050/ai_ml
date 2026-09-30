import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { FeedPage } from "../pages/Feed";
import { ReelList } from "../components/feed/ReelList";
import type { FeedClip } from "../types/echoflow";

/**
 * `Feed.tsx` and `ReelList.tsx` told the user things that were not true, and
 * had no way to say what was.
 *
 * 1. **"All caught up" on every feed.** `Feed.tsx` passed `hasMore={false}` as
 *    a hardcoded literal, so `ReelList` rendered the end-of-feed text on first
 *    paint while `views/feed.py:123-127` was returning a `next` and a
 *    `queue_health`. Both fields existed in `types/echoflow.ts:76-77` and were
 *    read by nothing. `ReelList`'s pagination observer was dead code for the
 *    same reason: no `loadMore` prop was ever passed.
 * 2. **The cold queue lied three ways in nine lines.** `retryCountdown` was set
 *    once and never decremented (there is no interval anywhere in the file), so
 *    the page read "retrying in 2s" for the whole cold period. The `setTimeout`
 *    had no cleanup, so a tab switch fired another `GET /feed/` against an
 *    unmounted component — and `GET /feed/` is a destructive
 *    `lpop(redis_key, 10)` (`views/feed.py:75`). And after five retries the
 *    page fell through to `ListEmpty`, telling a recommender's user "Nothing
 *    here yet" when the queue was merely cold.
 * 3. **A failed refresh with reels on screen was silent.** `Feed.tsx` guarded
 *    on `errorMsg && clips.length === 0` and `ReelList.tsx` had the identical
 *    condition, so stale reels were shown as current and `ListError` plus its
 *    `window.location.reload()` retry were unreachable dead code.
 * 4. **`handsFreeMode` controlled nothing.** The flag the Header toggle sets
 *    (`Header.tsx:182`) was read by neither the viewability autoplay nor the
 *    auto-advance, while `Feed.tsx` rendered "Manual Navigation Mode".
 * 5. **The scroll container was keyboard-unreachable** (no `tabIndex`, no
 *    `role`, no key handler) with the scrollbar hidden by
 *    `.scrollbar-hide`, and advancing the feed destroyed focus outright:
 *    `scrollIntoView` moves no focus and each card is a fresh subtree.
 */

/** What `views/feed.py:124` actually puts in `next`: a sentinel, not a URL. */
const AUTO_TRIGGER = "auto_trigger";

/** A DRF `next` link from a genuinely cursor-paginated endpoint. */
const NEXT_URL = "http://localhost:18000/feed/?cursor=cD0yMDI2LTAx";

const player = vi.hoisted(() => ({
  isPlaying: false,
  currentClip: null as FeedClip | null,
  progress: 0,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  audioFrequencies: [0, 0, 0],
  playbackError: null as string | null,
  handsFreeMode: true,
  playClip: vi.fn(),
  togglePlay: vi.fn(),
  seek: vi.fn(),
  skipForward: vi.fn(),
  skipBackward: vi.fn(),
  nextClip: vi.fn(),
  setRate: vi.fn(),
  setQueue: vi.fn(),
}));

vi.mock("../stores/player", () => ({ usePlayer: () => ({ ...player }) }));

vi.mock("../stores/auth", () => ({
  useAuth: () => ({ user: null, isAuthenticated: true }),
}));

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-1",
    title: "Mid-Fi Crunch",
    creator_name: "alex",
    creator_id: 42,
    category: "comedy",
    hls_playlist_url: "https://media.test/hls/clip-1/master.m3u8",
    likes: 3,
    shares: 1,
    skips: 0,
    comment_count: 0,
    is_liked: false,
    is_following: false,
    duration_ms: 7400,
    tags: ["instrumental", "lofi"],
    cover_image: null,
    ...overrides,
  };
}

/** A `GET /feed/` page, in the exact shape `views/feed.py:123-127` returns. */
function page(
  results: FeedClip[],
  extra: { next?: string | null; queue_health?: number; degraded?: boolean } = {},
) {
  return json(200, {
    next: extra.next === undefined ? AUTO_TRIGGER : extra.next,
    queue_health: extra.queue_health ?? 24,
    results,
    ...(extra.degraded ? { degraded: true } : {}),
  });
}

/** A cold 202 — `views/feed.py:91-100`. */
function cold(retryAfterMs = 1500) {
  return json(202, {
    results: [],
    message: "Preparing your feed...",
    retry_after_ms: retryAfterMs,
    degraded: true,
  });
}

function renderFeed() {
  return render(
    <FeedPage onOpenCreatorProfile={() => {}} onOpenOnboarding={() => {}} />,
  );
}

function renderReelList(props: Partial<React.ComponentProps<typeof ReelList>> = {}) {
  return render(
    <ReelList
      clips={[makeClip()]}
      loading={false}
      hasMore={false}
      onOpenCreatorProfile={() => {}}
      onOpenComments={() => {}}
      onOpenShare={() => {}}
      {...props}
    />,
  );
}

/** Everything the app says out loud, joined. `role="status"` is the idiom. */
function announced(): string {
  return Array.from(document.querySelectorAll('[role="status"]'))
    .map((el) => el.textContent ?? "")
    .join(" | ");
}

/**
 * Advance the clock in `steps` slices.
 *
 * One large `advanceTimersByTimeAsync` cannot drive the cold chain: the retry
 * timer is not armed until the 202 has resolved and React has re-rendered, so
 * a single 9 s jump lands before the first timer exists and nothing fires.
 */
async function advanceBy(totalMs: number, steps = 1): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(totalMs / steps);
    });
  }
}

/** The reel wrapper the auto-advance / arrow keys move focus to. */
function reelGroup(index: number, total: number, name?: string) {
  return screen.getByRole("group", {
    name: new RegExp(`Reel ${index} of ${total}${name ? `: ${name}` : ""}`, "i"),
  });
}

beforeEach(() => {
  installFetchMock();
  player.isPlaying = false;
  player.currentClip = null;
  player.progress = 0;
  player.currentTime = 0;
  player.duration = 0;
  player.handsFreeMode = true;
  player.playbackError = null;
  for (const fn of [
    player.playClip,
    player.togglePlay,
    player.seek,
    player.skipForward,
    player.skipBackward,
    player.nextClip,
    player.setRate,
    player.setQueue,
  ]) {
    fn.mockClear();
  }
  sessionStorage.clear();
});

// ===========================================================================
describe("end-of-feed honesty", () => {
  it("does not claim the feed is over when the server says clips are still queued", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { queue_health: 24 }));

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /load more reels/i })).toBeInTheDocument();
  });

  it("surfaces queue_health, which the server sends and nothing read", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { queue_health: 24 }));

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    // `llen(user_feed:{id})` read after the lpop — clips still waiting.
    expect(screen.getByText(/24 more reels queued for you/i)).toBeInTheDocument();
  });

  it("says the feed is over only when the server reports an empty queue", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { queue_health: 0 }));

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more reels/i })).not.toBeInTheDocument();
  });

  it("does not claim the feed is over on a degraded page, where the queue read is what failed", async () => {
    // `views/feed.py:148-153` returns `queue_health: 0` on the fallback path —
    // but the Redis read that would have produced a real number is the thing
    // that failed. "All caught up" over 20 trending clips is a claim the server
    // never made.
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () =>
      page([makeClip()], { queue_health: 0, degraded: true }),
    );

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it("treats a missing `next` as the end", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { next: null }));

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it("treats a real cursor as more, even when queue_health is 0", async () => {
    // A paginated endpoint's `next` is a claim about pages, and it is the only
    // one that means anything there. `queue_health` is a `/feed/` field; a
    // response carrying a URL in `next` is not a drained queue.
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { next: NEXT_URL, queue_health: 0 }));

    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it("follows a real cursor verbatim and appends the page", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return page([makeClip()], { next: NEXT_URL, queue_health: 0 });
      return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], {
        next: null,
        queue_health: 0,
      });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    await user.click(screen.getByRole("button", { name: /load more reels/i }));
    await screen.findByRole("heading", { level: 2, name: /late night loop/i });

    // The cursor is used as sent, not re-derived: `apiRequest` passes absolute
    // URLs through untouched, and hand-assembling query parameters would
    // re-derive an ordering contract the cursor already encodes.
    expect(api.calls[1]?.url).toBe(NEXT_URL);
    // Both pages are on screen, in order.
    expect(screen.getByRole("group", { name: /reel 1 of 2/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /reel 2 of 2/i })).toBeInTheDocument();
    // And the end-of-feed state arrives only now.
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it("does not issue a second request while the next page is in flight", async () => {
    const api: FetchMock = installFetchMock();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let call = 0;
    api.on("GET", /\/feed\//, async () => {
      call += 1;
      if (call === 1) return page([makeClip()], { next: NEXT_URL, queue_health: 0 });
      await gate;
      return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], {
        next: null,
        queue_health: 0,
      });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    await user.click(screen.getByRole("button", { name: /load more reels/i }));
    await user.click(screen.getByRole("button", { name: /loading/i }));

    expect(api.callsTo(/feed/)).toHaveLength(2);

    release?.();
    await screen.findByRole("heading", { level: 2, name: /late night loop/i });
  });

  it("never starts a clip by fetching a page", async () => {
    // Must-preserve: the pagination path is a separate observer from the
    // autoplay path precisely so that loading a page cannot begin playback.
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return page([makeClip()], { next: NEXT_URL, queue_health: 0 });
      return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], {
        next: null,
        queue_health: 0,
      });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
    player.playClip.mockClear();

    await user.click(screen.getByRole("button", { name: /load more reels/i }));
    await screen.findByRole("heading", { level: 2, name: /late night loop/i });

    expect(player.playClip).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("the cold queue", () => {
  it("counts the retry down", async () => {
    const api: FetchMock = installFetchMock();
    vi.useFakeTimers();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      return call === 1 ? cold(3000) : page([makeClip()]);
    });

    renderFeed();
    await advanceBy(1);

    // 3000 ms of hint, shown as a whole number of seconds.
    expect(screen.getByText(/check back in 3s/i)).toBeInTheDocument();

    await advanceBy(1500, 2);
    // A different number, not merely a different rendering of the same one.
    expect(screen.getByText(/check back in 2s/i)).toBeInTheDocument();
    expect(screen.queryByText(/check back in 3s/i)).not.toBeInTheDocument();

    await advanceBy(1500, 2);
    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
  });

  it("clears the pending retry on unmount, so no request is made afterwards", async () => {
    const api: FetchMock = installFetchMock();
    vi.useFakeTimers();
    api.on("GET", /\/feed\//, () => cold(1500));

    const view = renderFeed();
    await advanceBy(1);
    expect(screen.getByText(/check back in/i)).toBeInTheDocument();
    expect(api.callsTo(/feed/)).toHaveLength(1);

    // The tab switch: `App.tsx` unmounts this page. `GET /feed/` is a
    // destructive `lpop`, so a request fired after unmount drains ten more ids
    // out of a queue the user cannot see.
    view.unmount();
    await advanceBy(10_000, 10);

    expect(api.callsTo(/feed/)).toHaveLength(1);
  });

  it("asks the server's number of times, then says the queue is still cold", async () => {
    const api: FetchMock = installFetchMock();
    vi.useFakeTimers();
    api.on("GET", /\/feed\//, () => cold(1500));

    renderFeed();
    await advanceBy(1500 * 7, 7);

    // Six requests: the first, plus the five retries.
    expect(api.callsTo(/feed/)).toHaveLength(6);
    expect(screen.getByText(/still preparing your feed/i)).toBeInTheDocument();
    // THE assertion. "Nothing here yet" is the most damaging wrong conclusion
    // a recommender can show: it reads as "my taste matched nothing" when the
    // truth is that a refill is still in flight.
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
  });

  it("can check again after the retry budget is spent", async () => {
    const api: FetchMock = installFetchMock();
    vi.useFakeTimers();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      return call > 6 ? page([makeClip()]) : cold(1500);
    });

    renderFeed();
    await advanceBy(1500 * 7, 7);
    expect(screen.getByText(/still preparing your feed/i)).toBeInTheDocument();

    // `fireEvent`, not `userEvent`: this test's clock is fake, and userEvent's
    // inter-event waits are `setTimeout` calls the fake clock will not flush.
    // The click is a plain `onClick`; the keyboard affordance is covered
    // elsewhere in this file.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
  });

  it("does not treat a 202 that carries results as a cold queue", async () => {
    // MUST-PRESERVE. The guard is `results.length === 0`: a 202 is "accepted,
    // not finished", not "empty", and this endpoint's 202 shape is decided by
    // the body. Relaxing it would throw away clips that are already servable.
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () =>
      json(202, { next: AUTO_TRIGGER, queue_health: 8, results: [makeClip()], retry_after_ms: 1500 }),
    );

    renderFeed();

    // No cold screen, and the reels from the 202 are on the page.
    expect(screen.queryByText(/check back in/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
  });

  it("does not navigate away from a 202, and leaves the spinner on the response's own timing", async () => {
    const api: FetchMock = installFetchMock();
    vi.useFakeTimers();
    const href = window.location.href;
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      return call === 1 ? cold(2000) : page([makeClip()]);
    });

    renderFeed();
    await advanceBy(1);
    expect(window.location.href).toBe(href);
    // It is genuinely in the waiting state first, on the server's own hint.
    expect(screen.getByText(/check back in 2s/i)).toBeInTheDocument();

    // One hint, one follow-up request — not a retry storm and not a navigation.
    await advanceBy(2000, 4);
    expect(api.callsTo(/feed/)).toHaveLength(2);
    expect(window.location.href).toBe(href);

    // And the spinner is gone because the response said so, not because some
    // unrelated timer fired.
    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
    expect(screen.queryByText(/check back in/i)).not.toBeInTheDocument();
  });

  it("keeps the reels on screen when a refresh finds the queue cold", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      return call === 1 ? page([makeClip()], { queue_health: 0 }) : cold(1500);
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    await user.click(screen.getByRole("button", { name: /^refresh$/i }));

    // A 202 carries no results by definition. Replacing the list with it would
    // be the "nothing here yet" lie in a different costume.
    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
    expect(announced()).toMatch(/still being prepared/i);
  });
});

// ===========================================================================
describe("a failure while reels are on screen", () => {
  it("shows the error, keeps the reels, and leaves a reachable retry", async () => {
    // RECON-04 F12. `Feed.tsx` guarded on `errorMsg && clips.length === 0` and
    // `ReelList.tsx` had the identical condition, so a refresh that failed with
    // reels on screen rendered nothing at all: the user read stale reels as
    // current and made engagement decisions on them.
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return page([makeClip()], { queue_health: 12 });
      return json(500, { detail: "Internal Server Error" });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    await user.click(screen.getByRole("button", { name: /^refresh$/i }));

    // The failure is announced...
    await waitFor(() => expect(announced()).toMatch(/internal server error/i));
    // ...the reels are still there...
    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
    // ...and the page does not claim to be complete, because the response that
    // would justify that claim never arrived.
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    // The retry is reachable, and it is a real retry rather than a reload.
    const retry = screen.getByRole("button", { name: /^retry$/i });
    expect(retry).toBeEnabled();
  });

  it("recovers when the retry succeeds", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call < 3) return call === 1 ? page([makeClip()], { queue_health: 12 }) : json(500, { detail: "Internal Server Error" });
      return page([makeClip({ id: "clip-9", title: "Fresh On Retry" })], { queue_health: 0 });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    await user.click(screen.getByRole("button", { name: /^refresh$/i }));
    await waitFor(() => expect(announced()).toMatch(/internal server error/i));

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByRole("heading", { level: 2, name: /fresh on retry/i })).toBeInTheDocument();
    expect(announced()).not.toMatch(/internal server error/i);
  });

  it("keeps the reels when a load-more fails, and retries the next page", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return page([makeClip()], { next: NEXT_URL, queue_health: 12 });
      if (call === 2) return json(503, { detail: "Service Unavailable" });
      return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], { next: null, queue_health: 0 });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
    await user.click(screen.getByRole("button", { name: /load more reels/i }));

    await waitFor(() => expect(announced()).toMatch(/service unavailable/i));
    expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();

    // The retry re-asks for the next page. A full refresh would have replaced
    // the list with page 1 and dropped the page the user had already read.
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { level: 2, name: /late night loop/i })).toBeInTheDocument();
    expect(api.calls[1]?.url).toBe(NEXT_URL);
  });

  it("shows a full error state when the very first request fails, with a retry", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return json(500, { detail: "Internal Server Error" });
      return page([makeClip()], { queue_health: 0 });
    });

    const user = userEvent.setup();
    renderFeed();

    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
    // Nothing on screen to be stale, so no empty feed and no "caught up".
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
  });
});

// ===========================================================================
describe("the destructive remount", () => {
  it("does not re-request the feed when the page is remounted in the same session", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { queue_health: 12 }));

    const first = renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
    expect(api.callsTo(/feed/)).toHaveLength(1);

    // `App.tsx:80-100` unmounts this page on every tab switch. Each remount
    // used to re-issue `GET /feed/`, which is `lpop(user_feed:{id}, 10)`.
    first.unmount();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

    expect(api.callsTo(/feed/)).toHaveLength(1);
  });

  it("re-requests after the cached page has expired", async () => {
    const api: FetchMock = installFetchMock();
    api.on("GET", /\/feed\//, () => page([makeClip()], { queue_health: 12 }));
    vi.useFakeTimers();

    const first = renderFeed();
    await advanceBy(1);
    expect(api.callsTo(/feed/)).toHaveLength(1);

    first.unmount();
    await advanceBy(5 * 60 * 1000 + 1, 3);
    renderFeed();
    await advanceBy(1);

    expect(api.callsTo(/feed/)).toHaveLength(2);
  });
});

// ===========================================================================
describe("the scroll container is a keyboard surface", () => {
  it("is focusable, named, and in the tab order before the reel's own controls", async () => {
    renderReelList();

    const region = screen.getByRole("region", { name: /reel feed/i });
    expect(region).toHaveAttribute("tabindex", "0");
    // Tabbing from the control before the list lands on the list, not past it.
    const user = userEvent.setup();
    const before = document.createElement("button");
    region.parentElement?.insertBefore(before, region);
    before.focus();
    await user.tab();
    expect(region).toHaveFocus();
  });

  it("moves reel to reel on the arrow keys and says which reel it landed on", async () => {
    renderReelList({
      clips: [makeClip(), makeClip({ id: "clip-2", title: "Late Night Loop" })],
    });

    const user = userEvent.setup();
    const region = screen.getByRole("region", { name: /reel feed/i });
    region.focus();

    await user.keyboard("{ArrowDown}");
    expect(reelGroup(2, 2, "Late Night Loop")).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(reelGroup(1, 2, "Mid-Fi Crunch")).toHaveFocus();

    await user.keyboard("{End}");
    expect(reelGroup(2, 2, "Late Night Loop")).toHaveFocus();

    await user.keyboard("{Home}");
    expect(reelGroup(1, 2, "Mid-Fi Crunch")).toHaveFocus();

    // Silent movement is the failure mode; the live region is the fix.
    await waitFor(() => expect(announced()).toMatch(/reel 1 of 2: mid-fi crunch/i));
  });

  it("does not move focus on a key it does not handle", async () => {
    renderReelList({
      clips: [makeClip(), makeClip({ id: "clip-2", title: "Late Night Loop" })],
    });

    const user = userEvent.setup();
    const region = screen.getByRole("region", { name: /reel feed/i });
    region.focus();

    await user.keyboard("a");
    expect(region).toHaveFocus();
  });
});

// ===========================================================================
describe("auto-advance", () => {
  it("moves focus onto the next reel and announces it", async () => {
    vi.useFakeTimers();
    const first = makeClip();
    const clips = [first, makeClip({ id: "clip-2", title: "Late Night Loop" })];
    player.currentClip = first;
    player.progress = 1;
    player.handsFreeMode = true;

    renderReelList({ clips });

    await advanceBy(1000);

    // `scrollIntoView` moves no focus, and each card is a fresh subtree
    // (`key={clip.id}`), so focus inside the finished card used to be
    // destroyed and dropped to <body>.
    expect(reelGroup(2, 2, "Late Night Loop")).toHaveFocus();
    expect(announced()).toMatch(/next reel, 2 of 2: late night loop/i);
  });

  it("does not advance when hands-free mode is off", async () => {
    // The regression test for the gate. With the flag off, `Feed.tsx` renders
    // "Manual Navigation Mode", which was a false statement: neither the
    // autoplay observer nor the advance timer consulted the flag.
    vi.useFakeTimers();
    const first = makeClip();
    const clips = [first, makeClip({ id: "clip-2", title: "Late Night Loop" })];
    player.currentClip = first;
    player.progress = 1;
    player.handsFreeMode = false;

    renderReelList({ clips });

    await advanceBy(10_000, 4);

    expect(reelGroup(1, 2, "Mid-Fi Crunch")).not.toHaveFocus();
    expect(announced()).not.toMatch(/next reel/i);
  });

  it("does not advance past the last reel", async () => {
    vi.useFakeTimers();
    const clips = [makeClip()];
    player.currentClip = clips[0] ?? null;
    player.progress = 1;

    renderReelList({ clips });

    await advanceBy(10_000, 4);

    expect(announced()).not.toMatch(/next reel/i);
  });
});

// ===========================================================================
describe("the empty state announces itself", () => {
  it("is a live region, not a bare div", () => {
    renderReelList({ clips: [] });

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/nothing here yet/i);
  });
});

// ===========================================================================
describe("contrast of the pages these two files render", () => {
  /**
   * A SOURCE-level assertion, deliberately.
   *
   * jsdom computes no styles: `text-white/40` is an inert class name as far as
   * this environment is concerned, so a contrast test here could only assert
   * the class string, and would pass for a file that also had `text-white/30`
   * on the same line. Reading the source is the only version of this assertion
   * that can fail. The measured ratios (`text-white/40` 3.77:1, `/30` 2.61:1,
   * `/50` 5.29:1 on this app's `#0A0A0A`) are in RECON-06 §5.
   */
  it("leaves no text-white/30 or text-white/40 in Feed.tsx or ReelList.tsx", () => {
    for (const file of ["src/pages/Feed.tsx", "src/components/feed/ReelList.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const offenders = source
        .split("\n")
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter(({ text }) => /text-white\/(30|40)\b/.test(text));
      expect(offenders, `${file}: ${offenders.map((o) => `${o.line}: ${o.text.trim()}`).join(" | ")}`).toEqual([]);
    }
  });
});

// ===========================================================================
describe("the notice region", () => {
  it("is a polite live region rather than an interrupting alert", async () => {
    const api: FetchMock = installFetchMock();
    let call = 0;
    api.on("GET", /\/feed\//, () => {
      call += 1;
      if (call === 1) return page([makeClip()], { next: NEXT_URL, queue_health: 12 });
      return json(503, { detail: "Service Unavailable" });
    });

    const user = userEvent.setup();
    renderFeed();
    await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
    await user.click(screen.getByRole("button", { name: /load more reels/i }));

    const notice = await waitFor(() => {
      const found = screen
        .getAllByRole("status")
        .find((el) => /service unavailable/i.test(el.textContent ?? ""));
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    expect(notice).toHaveAttribute("aria-live", "polite");
    // Scoped to the notice: the reels' own text must not be pulled in.
    expect(within(notice).getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
