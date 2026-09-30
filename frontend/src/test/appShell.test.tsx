import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { FeedClip } from "../types/echoflow";

/**
 * `App.tsx` — the app shell: the share deep link, the tab shell's navigation
 * semantics, the unread-count honesty, and the global unhandled-rejection
 * surface.
 *
 * Harness notes, so the shape here is not mistaken for a second convention:
 *
 * - `../stores/auth` and `../stores/player` are the two module-level
 *   singletons, so they are replaced with controllable fakes exactly as
 *   `backendHealth.test.tsx:24-30` does. Both fakes are real
 *   `useSyncExternalStore` stores rather than frozen objects, because several of
 *   the assertions below are about *state after a transition* — a frozen mock
 *   would make "the player was not stopped" unfalsifiable.
 * - `../components/feed/ReelList` is stubbed and the other four pages are
 *   stubbed because two other agents own them and their work is in flight. The
 *   real `pages/Feed.tsx` is used on purpose: the destructive-`lpop` regression
 *   test has to count real `GET /feed/` requests through the real
 *   `feedAPI.getFeed`, not count component mounts of a double.
 * - `installFetchMock` is the shared `fetch` harness (see `fetchMock.ts`); the
 *   first matching route wins, so narrow routes are registered before broad
 *   ones.
 */

/** A canonical v4 UUID, as `AudioClip.id` (`models.py:109`) produces. */
const CLIP_ID = "3f2b1c9e-4d5a-4b7c-8e9f-0a1b2c3d4e5f";
const OTHER_CLIP_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const player = vi.hoisted(() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  return {
    listeners,
    state: {
      currentClip: null as FeedClip | null,
      isPlaying: false,
      queue: [] as FeedClip[],
    },
    /**
     * Bumped on every mutation. The snapshot cache is keyed on it rather than on
     * a field comparison: comparing `currentClip` by identity silently reused a
     * stale snapshot whenever a test flipped a *different* field back to the
     * value it already had, and the resulting failure looked like a bug in the
     * component under test.
     */
    version: 0,
    /** Set by the mocked `PlayerProvider` in the boundary-placement test. */
    providerShouldThrow: false,
    notify() {
      player.version += 1;
      player.listeners.forEach((l) => l());
    },
    spies: {
      playClip: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      togglePlay: vi.fn(),
      setQueue: vi.fn(),
      setHandsFreeMode: vi.fn(),
      nextClip: vi.fn(),
      prevClip: vi.fn(),
      seek: vi.fn(),
      skipForward: vi.fn(),
      skipBackward: vi.fn(),
      setRate: vi.fn(),
    },
  };
});

const auth = vi.hoisted(() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  return {
    listeners,
    state: {
      user: { id: 1, username: "me" } as { id: number; username: string } | null,
      profile: null as unknown,
      isAuthenticated: true,
      isLoading: false,
    },
    version: 0,
    notify() {
      auth.version += 1;
      auth.listeners.forEach((l) => l());
    },
  };
});

vi.mock("../stores/player", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    player.listeners.add(listener);
    return () => player.listeners.delete(listener);
  };
  let cached = { version: -1, value: { ...player.state } };
  const getSnapshot = () => {
    if (cached.version !== player.version) {
      cached = { version: player.version, value: { ...player.state } };
    }
    return cached.value;
  };

  return {
    PlayerProvider: ({ children }: { children: React.ReactNode }) => {
      if (player.providerShouldThrow) {
        throw new Error("player provider exploded");
      }
      return <>{children}</>;
    },
    usePlayer: () => {
      const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      return { ...value, ...player.spies };
    },
  };
});

vi.mock("../stores/auth", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  };
  let cached = { version: -1, value: { ...auth.state } };
  const getSnapshot = () => {
    if (cached.version !== auth.version) {
      cached = { version: auth.version, value: { ...auth.state } };
    }
    return cached.value;
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAuth: () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
  };
});

/** Stubs for the four non-feed pages, so switching tabs costs one fetch, not five. */
vi.mock("../pages/Explore", () => ({
  ExplorePage: () => <h2>Explore page</h2>,
}));
vi.mock("../pages/Upload", () => ({
  UploadPage: () => <h2>Upload page</h2>,
}));
vi.mock("../pages/Inbox", () => ({
  InboxPage: () => <h2>Inbox page</h2>,
}));
vi.mock("../pages/Profile", () => ({
  ProfilePage: () => <h2>Profile page</h2>,
}));
vi.mock("../pages/Login", () => ({
  LoginPage: () => <h2>Sign in to EchoFlow</h2>,
}));

/** `ReelList` is owned by another agent; the shell tests do not exercise it. */
vi.mock("../components/feed/ReelList", () => ({
  ReelList: ({ clips }: { clips: FeedClip[] }) => (
    <div data-testid="reel-list">
      {clips.map((clip) => (
        <p key={clip.id}>{clip.title}</p>
      ))}
    </div>
  ),
}));

import App from "../App";

function makeClip(id: string, title: string): FeedClip {
  return {
    id,
    title,
    creator_name: "alice",
    creator_id: 1,
    category: "lofi",
    hls_playlist_url: `https://media.example/hls/${id}/master.m3u8`,
    likes: 3,
    shares: 1,
    skips: 0,
    comment_count: 2,
    is_liked: false,
    is_following: false,
    duration_ms: 42_000,
    tags: ["lofi"],
    cover_image: null,
  };
}

const FEED_CLIP = makeClip(OTHER_CLIP_ID, "Feed clip one");
const TARGET_CLIP = makeClip(CLIP_ID, "The clip somebody sent me");

/** `history.replaceState` is how `App.tsx` reads and clears `?clip=`. */
function setQuery(query: string) {
  window.history.replaceState({}, "", `/${query}`);
}

function resetPlayer() {
  player.state.currentClip = null;
  player.state.isPlaying = false;
  player.state.queue = [];
  Object.values(player.spies).forEach((spy) => spy.mockClear());
  player.providerShouldThrow = false;
  player.spies.playClip.mockImplementation((clip: FeedClip, queue?: FeedClip[]) => {
    player.state.currentClip = clip;
    if (queue) player.state.queue = queue;
    player.notify();
  });
  player.spies.setQueue.mockImplementation((queue: FeedClip[]) => {
    player.state.queue = queue;
    player.notify();
  });
  player.spies.togglePlay.mockImplementation(() => {
    player.state.isPlaying = !player.state.isPlaying;
    player.notify();
  });
  player.notify();
}

/**
 * Writing `auth.state` directly is not enough: the mocked `useAuth` memoises its
 * snapshot against a version counter, so every write has to bump it. The helper
 * exists so no test can forget — a forgotten bump produced a failure that read
 * as "the component ignores `isLoading`", which was the test's bug, not the
 * component's.
 */
function setAuth(patch: Partial<typeof auth.state>) {
  Object.assign(auth.state, patch);
  auth.notify();
}

function resetAuth() {
  setAuth({
    user: { id: 1, username: "me" },
    profile: null,
    isAuthenticated: true,
    isLoading: false,
  });
}

let api: FetchMock;

function baseRoutes(unread: { unread: number } = { unread: 0 }) {
  api.on("GET", /\/health\//, () => json(200, { status: "healthy", timestamp: 1 }));
  api.on("GET", /\/ready\//, () => json(200, { status: "ready", database: "connected" }));
  api.on("GET", /\/share\/unread-count\//, () => json(200, unread));
}

/**
 * The feed's payload.
 *
 * Registered before `baseRoutes` and separately, because `fetchMock` resolves
 * the FIRST matching route — a broad `/feed/` registered ahead of a narrow one
 * would silently win and the test would assert against the wrong data.
 */
function feedRoute(clips: FeedClip[]) {
  api.on("GET", /\/feed\//, () => json(200, { results: clips, next: null }));
}

function playbackTokenRoute(status = 200) {
  api.on(
    "POST",
    /\/media\/playback-token\//,
    () => (status === 200 ? json(200, { status: "ok" }) : json(status, { detail: "no" })),
  );
}

/**
 * `GET /clips/{id}/resolve/` — the share-link resolver.
 *
 * **`/clips/{id}/` also matches `/clips/{id}/resolve/`.** A matcher written for
 * the creator-scoped `retrieve` keeps passing after the endpoint is swapped, so
 * the test silently stops describing the thing it names — the "patching a name
 * that exists" failure, in route-matcher form. Every deep-link route is
 * therefore registered through this function, and `creatorScopedCalls` below
 * asserts the other endpoint is never reached at all.
 */
function resolveRoute(clipId: string, status: number, body: unknown) {
  api.on("GET", new RegExp(`/clips/${clipId}/resolve/`), () => json(status, body));
}

/**
 * Requests to `GET /clips/{clipId}/` that are *not* the resolver.
 *
 * The negative lookahead stops at the next `/`, so it matches the bare
 * `retrieve` path and nothing else. This is the assertion that pins the bug
 * this whole deep-link surface was found to have: `retrieve` is
 * `filter(creator=self.request.user)` (`views/content.py:117-120`), so it 404s
 * for every clip the recipient did not upload — which is every real share.
 */
function creatorScopedCalls(clipId: string) {
  return api.callsTo(new RegExp(`/clips/${clipId}/(?![^/]*resolve)`));
}

function resolveCalls(clipId: string) {
  return api.callsTo(new RegExp(`/clips/${clipId}/resolve/`));
}

/**
 * Both nav bars carry the same five destinations, so every label matches twice
 * (`Header`'s desktop `<nav>` and `BottomNav`, which is `md:hidden` and
 * therefore still in the DOM below that width). The first match is the header's;
 * both call the same handler, so which one is clicked does not matter — what
 * matters is that the count is not silently one.
 */
async function clickNav(name: RegExp) {
  const buttons = screen.getAllByRole("button", { name });
  const first = buttons[0];
  if (!first) throw new Error(`No button matching ${name}`);
  await act(async () => {
    first.click();
  });
}

beforeEach(() => {
  api = installFetchMock();
  resetPlayer();
  resetAuth();
  setQuery("");
  feedRoute([FEED_CLIP]);
  baseRoutes();
});

afterEach(() => {
  setQuery("");
  document.title = "";
});

// ---------------------------------------------------------------------------

describe("?clip= — the share deep link", () => {
  it("opens a clip that is already in the loaded feed, even when the resolver says it is not there", async () => {
    // The whole point of `ShareModal.tsx:188` copying `${origin}/?clip=${id}`.
    // Before this the parameter was read by nothing, so every shared link
    // opened the generic feed and the deep link was thrown away.
    //
    // **`/resolve/` answers 404 here on purpose.** It is the case the old code
    // got wrong: this page load mounts the feed, `GET /feed/` is already in
    // flight, and the resolve request — a single indexed PK lookup — settles
    // first. Measured before the fix: the 404 was handled with `player.queue`
    // still `[]`, the app wrote `failed`, the in-feed effect was gated off by
    // `deepLink.kind !== "resolving"`, and a link that opens fine was reported
    // as "not available on your account". A 404 is not the *literal* response
    // for a feed item (a feed item is approved, so `resolve_clip_access` allows
    // it and answers 200) — it is the strongest available way to say "the
    // metadata fetch failed, and the feed's answer must survive that".
    feedRoute([FEED_CLIP, TARGET_CLIP]);
    // `installFetchMock` resolves the FIRST matching route, so the default feed
    // payload registered in `beforeEach` has to be replaced rather than shadowed.
    api.reset();
    feedRoute([FEED_CLIP, TARGET_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 404, { error: "Clip not found." });
    setQuery(`?clip=${TARGET_CLIP.id}`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: TARGET_CLIP.title })).toBeInTheDocument();
    // The failure state must never have been shown, and the wait means it is
    // not shown *late* either — the heading is present without an alert ever
    // replacing it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The feed is not mounted behind it. `ReelList` autoplays whatever is most
    // visible from an IntersectionObserver that fires on mount, so a feed
    // rendered underneath would overwrite the shared clip within a frame.
    expect(screen.queryByTestId("reel-list")).not.toBeInTheDocument();

    // `Feed.tsx` autoplays `results[0]` on its own; the deep link is the one
    // that has to be last, or the recipient hears the top of their feed.
    const playedIds = player.spies.playClip.mock.calls.map((call) => call[0].id);
    expect(playedIds.at(-1)).toBe(TARGET_CLIP.id);
  });

  it("never asks the creator-scoped endpoint, on either resolution path", async () => {
    // `GET /clips/{id}/` cannot resolve a share: `get_queryset` is
    // `filter(creator=self.request.user)`, so `retrieve` answers 404 for every
    // clip the recipient did not upload. The app has to use `/resolve/`, and
    // asserting "no call to the other path" is what makes that a property of
    // the code rather than of which route the mock happened to answer.
    api.reset();
    feedRoute([FEED_CLIP, TARGET_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);
    expect(await screen.findByRole("heading", { name: TARGET_CLIP.title })).toBeInTheDocument();

    expect(resolveCalls(CLIP_ID).length).toBeGreaterThan(0);
    expect(creatorScopedCalls(CLIP_ID)).toHaveLength(0);
  });

  it("issues no request at all when the player's queue already holds the clip", async () => {
    // The other way the in-feed answer can be available: the queue is warm
    // before the deep link starts, so the loaded feed is a *complete* answer —
    // the same `FeedClipSerializer` payload — and there is nothing to fetch.
    // This is the path that makes the deep link free for a user who is already
    // browsing, and it is only reachable because the check happens before the
    // request rather than racing it.
    player.state.queue = [FEED_CLIP, TARGET_CLIP];
    player.notify();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: TARGET_CLIP.title })).toBeInTheDocument();
    expect(api.callsTo(/\/clips\//)).toHaveLength(0);
    // No probe either: the queue's copy came from the feed, and the feed's own
    // cards play without one. `playClip` mints its own token when it has to.
    expect(api.callsTo(/media\/playback-token/)).toHaveLength(0);
    expect(player.state.currentClip?.id).toBe(CLIP_ID);
  });

  it("fetches the clip by id when the feed does not have it", async () => {
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: TARGET_CLIP.title })).toBeInTheDocument();
    expect(resolveCalls(CLIP_ID)).toHaveLength(1);
    expect(creatorScopedCalls(CLIP_ID)).toHaveLength(0);

    expect(player.spies.playClip).toHaveBeenCalledWith(
      TARGET_CLIP,
      expect.arrayContaining([TARGET_CLIP]),
    );
  });

  it("refuses a malformed ?clip= without a request and without an error state", async () => {
    setQuery("?clip=../../admin");

    render(<App />);

    // It falls through to the feed rather than showing a failure: a broken link
    // is not a failure the user can act on.
    expect(await screen.findByTestId("reel-list")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /did not open/i })).not.toBeInTheDocument();

    // The unvalidated string never reached a request path. (`api.calls` is not
    // zero here and must not be: the header's health probe and the unread poll
    // both fire on mount. The claim is about *these* two paths.)
    expect(api.callsTo(/\/clips\//)).toHaveLength(0);
    expect(api.callsTo(/media\/playback-token/)).toHaveLength(0);
  });

  it("rejects a non-v4 UUID as well as a non-UUID", async () => {
    // `AudioClip.id` is `default=uuid.uuid4` (`models.py:109`), so a
    // version-1 UUID was not produced by this API. It is a human-typed string
    // and there is no honest use for it.
    setQuery("?clip=00000000-0000-1000-8000-000000000000");

    render(<App />);

    expect(await screen.findByTestId("reel-list")).toBeInTheDocument();
    expect(api.callsTo(/\/clips\//)).toHaveLength(0);
    expect(api.callsTo(/media\/playback-token/)).toHaveLength(0);
  });

  it("clears the parameter once handled, so a reload does not re-trigger and Back is clean", async () => {
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    const { unmount } = render(<App />);
    expect(await screen.findByRole("heading", { name: TARGET_CLIP.title })).toBeInTheDocument();

    // Stripped before any await, so a refresh mid-resolve cannot re-fire it.
    expect(window.location.search).toBe("");

    // A reload is the next mount with the same URL: it must not resolve again.
    unmount();
    render(<App />);
    await act(async () => {});

    expect(resolveCalls(CLIP_ID)).toHaveLength(1);
  });

  it("reports a well-formed id the server does not have as unavailable, with no retry to press", async () => {
    // Distinct from "the link is broken". A v4 UUID that resolves to nothing is
    // a real request that got a real answer, and the answer is permanent:
    // `/resolve/` answers 404 for "never created" and for "not available to you"
    // (`views/content.py:588,594`) so the endpoint is not an existence oracle,
    // and offering "Try again" for a clip that does not exist is a control that
    // cannot work.
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 404, { error: "Clip not found." });
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not available on your account/i);
    // Not "no such clip": the endpoint deliberately does not distinguish the two.
    expect(alert).not.toHaveTextContent(/does not exist|no longer exists/i);
    expect(within(alert).queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: /back to feed/i })).toBeInTheDocument();
  });

  it("distinguishes 403, 404 and 409 from the playback probe", async () => {
    // `views/media.py` answers four different situations and the user can act
    // on three of them differently. Collapsing them into one sentence is what
    // RECON-04 calls "losing the only signal the user can act on".
    const cases: { label: string; status: number; expected: RegExp }[] = [
      { label: "playback 403 (refused)", status: 403, expected: /cannot be played on your account/i },
      { label: "playback 404 (gone)", status: 404, expected: /no longer exists/i },
      { label: "playback 409 (still encoding)", status: 409, expected: /still being processed/i },
    ];

    const seen: string[] = [];
    for (const testCase of cases) {
      api.reset();
      feedRoute([FEED_CLIP]);
      baseRoutes();
      resolveRoute(CLIP_ID, 200, TARGET_CLIP);
      playbackTokenRoute(testCase.status);
      setQuery(`?clip=${CLIP_ID}`);

      const { unmount } = render(<App />);
      const alert = await screen.findByRole("alert");
      const text = alert.textContent ?? "";
      expect(text, testCase.label).toMatch(testCase.expected);
      seen.push(text);
      unmount();
    }

    // Not merely three different regexes matching one message.
    expect(new Set(seen).size).toBe(cases.length);
    // And 409 is the one that is worth retrying — the media worker has not
    // produced output yet, unlike a refusal or a deletion.
    expect(seen.find((s) => /still being processed/i.test(s))).toBeDefined();
  });

  it("ends the wait the moment the feed answers, rather than holding the error for the cap", async () => {
    // The feed is gated, so "before the feed answered" and "after" are two
    // distinguishable states. That is what stops the test passing vacuously: on
    // the code this replaced, the resolve 404 committed `failed` immediately
    // and the alert was already up while the feed was still in flight — so the
    // first assertion below is the one that fails without the wait, and the
    // second is the one that fails without the in-feed answer being consulted.
    //
    // `DEEP_LINK_FEED_GRACE_MS` is 1500 ms and this test never advances a
    // timer, so the second assertion also pins the bound: the wait ends when
    // the feed answers, not when the cap fires.
    let releaseFeed: (() => void) | null = null;
    api.reset();
    api.on("GET", /\/feed\//, async () => {
      await new Promise<void>((resolve) => {
        releaseFeed = resolve;
      });
      return json(200, { results: [FEED_CLIP], next: null });
    });
    baseRoutes();
    resolveRoute(CLIP_ID, 404, { error: "Clip not found." });
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    // The resolve request has been answered and refused. The feed has not.
    await act(async () => {});
    expect(resolveCalls(CLIP_ID)).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/opening the shared clip/i)).toBeInTheDocument();

    await act(async () => {
      releaseFeed?.();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/not available on your account/i);
  });

  it("gives up on a feed that never produces a page, instead of waiting for ever", async () => {
    // A cold queue: `results: []` with a `retry_after_ms` (`Feed.tsx:128-130`).
    // `FeedPage` sets a countdown and never calls `setQueue`, so `player.queue`
    // stays `[]` — indistinguishable, from `App.tsx`, from a feed that has not
    // answered yet. The cap is the only thing that can end the wait here, which
    // is why it is one cold-feed tick and not a retry loop.
    api.reset();
    api.on("GET", /\/feed\//, () => json(200, { results: [], retry_after_ms: 1500, next: null }));
    baseRoutes();
    resolveRoute(CLIP_ID, 404, { error: "Clip not found." });
    setQuery(`?clip=${CLIP_ID}`);

    vi.useFakeTimers();
    try {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Still waiting on a feed that has nothing. Not an error yet — that would
      // be a conclusion drawn before the evidence exists.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/opening the shared clip/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      // `getByRole`, not `findByRole`: `waitFor` is unusable under fake timers
      // (see the note in `backendHealth.test.tsx:40-44`), and the advance above
      // has already let every settled promise flush.
      expect(screen.getByRole("alert")).toHaveTextContent(/not available on your account/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the playing clip alone when the shared link cannot be opened", async () => {
    // A share link that arrives in a chat and turns out to be dead must not
    // cost the user whatever they were already listening to.
    player.state.currentClip = FEED_CLIP;
    player.state.isPlaying = true;
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 404, { error: "Clip not found." });
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    await screen.findByRole("alert");
    expect(player.state.currentClip).toBe(FEED_CLIP);
    expect(player.state.isPlaying).toBe(true);
    expect(player.spies.pause).not.toHaveBeenCalled();
    expect(player.spies.resume).not.toHaveBeenCalled();
  });

  it("swaps the source through playClip rather than by stopping the player", async () => {
    player.state.currentClip = FEED_CLIP;
    player.state.isPlaying = true;
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);

    await screen.findByRole("heading", { name: TARGET_CLIP.title });
    // Compared by id, not by identity: the clip arrived as a parsed JSON body,
    // so it is a structurally-equal copy, not the fixture object.
    expect(player.state.currentClip?.id).toBe(TARGET_CLIP.id);
    expect(player.spies.pause).not.toHaveBeenCalled();
  });

  it("shows the shared clip and the feed side by side only after going back", async () => {
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);
    await screen.findByRole("heading", { name: TARGET_CLIP.title });

    await act(async () => {
      const back = screen.getAllByRole("button", { name: /back to feed/i })[0];
      if (!back) throw new Error("No 'back to feed' button");
      back.click();
    });

    // The feed mounts for the first time here — the deep link kept it unmounted,
    // so its `lpop` happens once, not twice.
    expect(await screen.findByTestId("reel-list")).toBeInTheDocument();
    expect(api.callsTo(/\/feed\//)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("tab navigation", () => {
  it("moves focus to the content it just swapped, and says so", async () => {
    render(<App />);
    await screen.findByTestId("reel-list");

    await clickNav(/discover/i);

    expect(await screen.findByRole("heading", { name: "Explore page" })).toBeInTheDocument();
    // Focus follows the content. The nav button stays valid (it is what the
    // user pressed) but the new page was previously never announced at all.
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("announces the new tab in a live region that is mounted before the text exists", async () => {
    render(<App />);
    await screen.findByTestId("reel-list");

    // The NetworkBanner / SessionNotice idiom: mounted and empty on a healthy
    // load, varying only presentation. A region inserted at the same tick as its
    // text is unreliable — a screen reader can observe a region that was never
    // there and miss the insertion entirely.
    //
    // Asserted against `TabAnnouncer`'s own node, not against "some element
    // with role=status and no text". Several regions are mounted empty at once
    // (the banner, the unread note, the header's liveness label), so a generic
    // query is satisfied by any of them and would pass whether or not the tab
    // announcer existed.
    const region = screen.getByTestId("tab-announcer");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByText("Discover loaded")).not.toBeInTheDocument();

    await clickNav(/discover/i);
    expect(await screen.findByText("Discover loaded")).toBeInTheDocument();
    expect(screen.getByTestId("tab-announcer")).toHaveTextContent("Discover loaded");
  });

  it("re-announces the same tab on a second visit", async () => {
    // A live region whose accessible text does not change is not re-announced.
    // The message is keyed by a counter for exactly this reason, the same fix
    // `SessionAnnouncer.tsx:37-39` made for its own message.
    render(<App />);
    await screen.findByTestId("reel-list");

    await clickNav(/discover/i);
    const first = await screen.findByText("Discover loaded");

    await clickNav(/live feed/i);
    await clickNav(/discover/i);
    const second = await screen.findByText("Discover loaded");

    expect(second).not.toBe(first);
  });

  it("changes document.title per tab", async () => {
    render(<App />);
    await screen.findByTestId("reel-list");
    expect(document.title).toBe("EchoFlow — Live Feed");

    await clickNav(/creator studio/i);
    expect(document.title).toBe("EchoFlow — Creator Studio");

    await clickNav(/inbox/i);
    expect(document.title).toBe("EchoFlow — Inbox");

    await clickNav(/profile/i);
    expect(document.title).toBe("EchoFlow — Profile");
  });

  it("titles the shared-clip surface for what it is", async () => {
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes();
    resolveRoute(CLIP_ID, 200, TARGET_CLIP);
    playbackTokenRoute();
    setQuery(`?clip=${CLIP_ID}`);

    render(<App />);
    await screen.findByRole("heading", { name: TARGET_CLIP.title });

    // "Live Feed" would be false: the feed is not mounted.
    expect(document.title).toBe("EchoFlow — Shared clip");
  });

  it("does not re-issue GET /feed/ when the user moves between tabs", async () => {
    // THE regression. `App.tsx` rendered `{activeTab === "feed" && <FeedPage/>}`,
    // so every tab switch unmounted the feed and its remount called
    // `feedAPI.getFeed()` again. `GET /feed/` is a destructive
    // `lpop(user_feed:{id}, 10)` (`views/feed.py:71`) whose cold fallback
    // serves trending *after* the ids were consumed (`:127-131`) — so flipping
    // between two tabs permanently drained the user's own queue.
    //
    // The count is a REQUEST count through the real `feedAPI.getFeed` and the
    // shared `fetch` mock, not a mount count of a test double.
    render(<App />);
    await screen.findByTestId("reel-list");
    expect(api.callsTo(/\/feed\//)).toHaveLength(1);

    await clickNav(/discover/i);
    await clickNav(/live feed/i);
    await clickNav(/creator studio/i);
    await clickNav(/live feed/i);
    await clickNav(/inbox/i);
    await clickNav(/live feed/i);

    expect(api.callsTo(/\/feed\//)).toHaveLength(1);
  });

  it("keeps the feed mounted but out of the accessibility tree while another tab is up", async () => {
    render(<App />);
    await screen.findByTestId("reel-list");

    await clickNav(/discover/i);
    await screen.findByRole("heading", { name: "Explore page" });

    // Still in the DOM — that is what stops the remount — but `hidden` is
    // `display: none`, which correctly removes it from the a11y tree.
    const feed = screen.getByTestId("reel-list");
    expect(feed).toBeInTheDocument();
    expect(feed.closest("[hidden]")).not.toBeNull();
  });

  it("keeps the session notice alive across the sign-out transition", async () => {
    // MUST PRESERVE. `SessionNotice` is mounted outside the auth conditional
    // precisely so it survives the transition it explains — and a peer just made
    // a network throw dispatch `ef_session_expired`, which is the case that
    // needs it most.
    render(<App />);
    await screen.findByTestId("reel-list");

    act(() => {
      window.dispatchEvent(new CustomEvent("ef_session_expired"));
    });
    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();

    // What `stores/auth.tsx:53-57` does on that event.
    act(() => {
      setAuth({ isAuthenticated: false });
    });

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("still catches a provider render throw, which pins the boundary placement", async () => {
    // MUST PRESERVE. `ErrorBoundary` is outermost, so a throw inside
    // `AuthProvider` or `PlayerProvider` is caught. Moving the boundary inside
    // the providers — as an inverted comment once claimed it was — would leave
    // a blank page on a provider throw.
    const spy = console.error;
    console.error = () => {};
    try {
      player.providerShouldThrow = true;
      render(<App />);
    } finally {
      console.error = spy;
    }

    expect(screen.getByRole("alert")).toHaveTextContent("player provider exploded");
  });
});

// ---------------------------------------------------------------------------

describe("the auth-loading window", () => {
  it("does not flash the login form while a stored session is still being checked", async () => {
    // `AuthenticatedApp` used to test `isAuthenticated` alone while
    // `MainContent` tested `!isAuthenticated && !isLoading`, so a load with
    // tokens but no cached `ef_user` rendered the whole login form, announced
    // nothing, and then replaced it — with focus on a node about to unmount.
    sessionStorage.setItem("ef_access_token", "access");
    sessionStorage.setItem("ef_refresh_token", "refresh");
    setAuth({ isAuthenticated: false, isLoading: true });

    render(<App />);

    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/signing you in/i)).toBeInTheDocument();
    // Nothing was fetched on the strength of a session we have not confirmed.
    expect(api.calls).toHaveLength(0);
  });

  it("still shows the login form immediately to a visitor with no session at all", async () => {
    // The loading screen must not become a permanent gate in front of the form.
    setAuth({ isAuthenticated: false, isLoading: true });

    render(<App />);

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("unhandled rejections and uncaught errors", () => {
  /**
   * jsdom implements no `PromiseRejectionEvent` constructor, so the event is
   * built the way the browser delivers one: a plain `Event` with the standard
   * `reason` property hanging off it. That is the shape `App.tsx` reads.
   */
  function fireRejection(reason: unknown) {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: reason });
    act(() => {
      window.dispatchEvent(event);
    });
  }

  it("surfaces an unhandled promise rejection instead of leaving the user with nothing", () => {
    // RECON-04 F19: `grep -rn "unhandledrejection|window.onerror" src/` returned
    // nothing. `ErrorBoundary` catches render-phase throws only — React 19 does
    // not route an event-handler throw, an effect throw or an async rejection to
    // any boundary — so the whole class of "it silently did nothing" failures
    // ended in the console.
    render(<App />);
    expect(screen.queryByText(/didn't finish/i)).not.toBeInTheDocument();

    // No manual `mockRestore`: the suite config sets `restoreMocks: true` and
    // `setupTests.ts` calls `vi.restoreAllMocks()` in `afterEach`. Restoring
    // here would also clear the call history the assertion below reads.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fireRejection(new Error("Failed to fetch"));

    expect(screen.getByText(/didn't finish/i)).toHaveTextContent("Failed to fetch");
    // The whole object — stack, cause — is preserved for devtools.
    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled promise rejection:",
      expect.objectContaining({ message: "Failed to fetch" }),
    );
  });

  it("surfaces an uncaught error too, and can be dismissed", () => {
    render(<App />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      const event = new Event("error");
      Object.defineProperty(event, "error", { value: new Error("boom") });
      window.dispatchEvent(event);
    });

    const notice = screen.getByText(/didn't finish/i);
    expect(notice).toHaveTextContent("boom");

    act(() => {
      screen.getByRole("button", { name: /dismiss error/i }).click();
    });
    expect(screen.queryByText(/didn't finish/i)).not.toBeInTheDocument();
  });

  it("renders nothing visible while healthy", () => {
    render(<App />);
    expect(screen.queryByText(/didn't finish/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss error/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("unread share count", () => {
  it("does not report zero when the poll has never succeeded", async () => {
    // `setUnreadCount(data.unread || 0)` sat inside a `catch {}` that did
    // nothing, so the badge stayed at its initial 0 — which both nav bars render
    // as *absent*, i.e. "you have no unread shares".
    api.reset();
    feedRoute([FEED_CLIP]);
    api.fail("GET", /\/share\/unread-count\//, new TypeError("Failed to fetch"));
    baseRoutes();

    render(<App />);

    expect(await screen.findByText(/unread shares: could not be checked/i)).toBeInTheDocument();
    // The badge's rendering is `Header`'s and `BottomNav`'s; the claim that
    // there is nothing unread must not be made anywhere.
    expect(screen.queryByText(/no unread/i)).not.toBeInTheDocument();
  });

  it("says nothing about unread when the poll genuinely answers zero", async () => {
    api.reset();
    feedRoute([FEED_CLIP]);
    baseRoutes({ unread: 0 });

    render(<App />);

    await waitFor(() => expect(api.callsTo(/unread-count/)).toHaveLength(1));
    expect(screen.queryByText(/unread shares/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/i)).not.toBeInTheDocument();
  });

  it("keeps the last known count and says it is out of date when a later poll fails", async () => {
    // Unknown, stale and zero are three different facts. Discarding a number we
    // are confident in because the newest refresh failed would be its own lie.
    //
    // Fake timers so the 30 s interval is what triggers the second poll, rather
    // than a Retry control — there is nothing to retry from while the state is
    // still `known`, and waiting 30 s of real time is not a test.
    let fail = false;
    api.reset();
    feedRoute([FEED_CLIP]);
    api.on("GET", /\/share\/unread-count\//, () =>
      fail ? json(503, { detail: "down" }) : json(200, { unread: 3 }),
    );
    baseRoutes();

    vi.useFakeTimers();
    try {
      render(<App />);
      // `advanceTimersByTimeAsync(0)` both flushes the settled poll's state
      // update and runs the header's own first probe. `waitFor` is unusable
      // under fake timers — see the note in `backendHealth.test.tsx:40-44`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByText("3 unread").length).toBeGreaterThan(0);

      fail = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText(/showing the last known count/i)).toBeInTheDocument();
    // The count the badge already had is not thrown away.
    expect(screen.getAllByText("3 unread").length).toBeGreaterThan(0);
    // And it is not the "we have never asked" message either.
    expect(screen.queryByText(/could not be checked/i)).not.toBeInTheDocument();
  });

  it("recovers to the known state when a retry succeeds", async () => {
    let fail = true;
    api.reset();
    feedRoute([FEED_CLIP]);
    api.on("GET", /\/share\/unread-count\//, () =>
      fail ? json(503, { detail: "down" }) : json(200, { unread: 2 }),
    );
    baseRoutes();

    render(<App />);
    await screen.findByText(/could not be checked/i);

    fail = false;
    act(() => {
      screen.getByRole("button", { name: /retry/i }).click();
    });

    expect((await screen.findAllByText("2 unread")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not be checked/i)).not.toBeInTheDocument();
  });
});
