import React, { useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./stores/auth";
import { PlayerProvider, usePlayer } from "./stores/player";
import { Header } from "./components/common/Header";
import { BottomNav } from "./components/navigation/BottomNav";
import { NetworkBanner } from "./components/common/NetworkBanner";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { SessionNotice, useSessionAnnouncer } from "./components/common/SessionAnnouncer";
import { MiniPlayer } from "./components/feed/MiniPlayer";
import { OnboardingModal } from "./components/feed/OnboardingModal";
import { FeedPage } from "./pages/Feed";
import { ExplorePage } from "./pages/Explore";
import { UploadPage } from "./pages/Upload";
import { InboxPage } from "./pages/Inbox";
import { ProfilePage } from "./pages/Profile";
import { LoginPage } from "./pages/Login";
import { ApiError, apiRequest, getStoredTokens, mediaAPI, shareAPI } from "./api/client";
import { FeedClip } from "./types/echoflow";

/**
 * The five destinations, and the name each one is announced and titled by.
 *
 * `document.title` was a single static string from `index.html:6` for all five
 * "routes" (RECON-06 #28, WCAG 2.4.2 Page Titled), and nothing announced a tab
 * change at all (#29, §3). Both are driven from this one table so the visible
 * nav label, the `<nav aria-current>` mark that `Header`/`BottomNav` already
 * render, the live-region text and the document title cannot drift apart.
 */
const TAB_LABELS: Record<string, string> = {
  feed: "Live Feed",
  explore: "Discover",
  upload: "Creator Studio",
  inbox: "Inbox",
  profile: "Profile",
};

const SHARED_CLIP_PARAM = "clip";

/**
 * How long a failed share-link resolution waits for the feed's first page
 * before it will conclude that the clip is unavailable.
 *
 * The cap exists for exactly one case, and it is a real one: `Feed.tsx` serves
 * a **cold** queue as `202` with no results, and a failed feed serves an error
 * page. In both, `player.queue` never changes from `[]`, so "the feed has
 * answered and it is not in there" is never signalled by anything `App.tsx`
 * can see. Without a cap, a share link opened during a cold feed would sit on
 * "Opening the shared clip…" for ever behind a feed that is itself waiting on
 * `refill_user_feed`.
 *
 * The value is `Feed.tsx`'s own `COLD_FALLBACK_WAIT_MS`: one cold-feed tick.
 * Longer than that and the share link is waiting on something the feed page
 * has already given up on; shorter and a merely slow feed turns a working link
 * into "not available on your account". The wait costs nothing at all in the
 * normal case, because a feed page with clips in it ends it immediately.
 */
const DEEP_LINK_FEED_GRACE_MS = 1500;

/**
 * `AudioClip.id` is `UUIDField(primary_key=True, default=uuid.uuid4)` —
 * `backend/app/models.py:109`. A canonical, version-4, RFC-4122 variant UUID.
 *
 * This is a boundary, not a type assertion. The value comes from the URL of a
 * link that anybody can edit before sending it, and it is interpolated into a
 * request path. A regex is the only thing standing between `?clip=../../admin`
 * and a request the client made on purpose. The version and variant nibbles are
 * checked as well as the shape because `uuid.uuid4` guarantees both, so a value
 * that fails them was not produced by this API — it was typed or forged by a
 * human, and there is no honest use for it.
 */
const CLIP_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Truncated so a server-sent `detail` cannot push a layout out of shape. */
function shortMessage(reason: unknown, max = 160): string {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  const trimmed = text.trim();
  if (!trimmed) return "no further detail";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ---------------------------------------------------------------------------
// ?clip= — the share deep link
// ---------------------------------------------------------------------------

type DeepLink =
  | { kind: "absent" }
  | { kind: "resolving" }
  | { kind: "ready"; clip: FeedClip }
  | { kind: "failed"; message: string; canRetry: boolean };

/**
 * Reads `?clip=` and removes it from the URL in the same breath.
 *
 * Two properties, and both are the reason this is one function:
 *
 * 1. **The parameter is stripped before anything is awaited.** A refresh
 *    during a slow resolve must not re-trigger the deep link, and the Back
 *    button must not walk into a history entry whose only content is a query
 *    parameter. `replaceState` rather than `pushState` for the same reason: the
 *    shared link was not a navigation the user performed inside the app, so it
 *    does not belong in their history at all.
 * 2. **An unparseable value is indistinguishable from no value.** A link with
 *    `?clip=nonsense` is a broken link, not an error the user can act on, so it
 *    falls straight through to the feed. The parameter is still stripped, so a
 *    bad link does not survive a reload either.
 *
 * Returns the raw value, or `null`. Validation is the caller's business.
 */
function consumeClipParam(): string | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(SHARED_CLIP_PARAM);
  if (raw === null) return null;

  url.searchParams.delete(SHARED_CLIP_PARAM);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return raw;
}

/**
 * Turns a failed playback-token request into the sentence the user can act on.
 *
 * `POST /media/playback-token/<id>/` answers four different failures with four
 * different situations, and `player.tsx:219-222` says collapsing them "loses the
 * only signal the user can act on". It then sets that signal on
 * `playbackError`, which no component reads (RECON-06 #12) — so at the deep-link
 * boundary there was nothing for the user to read at all.
 *
 * The mapping is the one `player.tsx` already documents, kept identical on
 * purpose:
 *
 * - **403** `views/media.py:214,232` — the clip is unmoderated, or
 *   `resolve_clip_access` refused it (licence-restricted, or reachable only
 *   through a share). Not going to become available by waiting.
 * - **404** `views/media.py:208` — no such clip. Gone.
 * - **409** `views/media.py:238` — no `hls_playlist_url` yet. The media worker
 *   has not produced output. This is the one that *is* worth retrying, so it is
 *   the one that gets the retry control.
 * - **network / timeout** — never reached the server, which says nothing about
 *   the clip and everything about the connection.
 */
function playbackFailureMessage(err: unknown): { message: string; canRetry: boolean } {
  const status = err instanceof ApiError ? err.status : undefined;
  if (err instanceof ApiError && (err.kind === "network" || err.kind === "timeout")) {
    return {
      message: "Could not reach EchoFlow. Check your connection, then try again.",
      canRetry: true,
    };
  }
  if (status === 403) {
    return {
      message:
        "This clip cannot be played on your account. It may not be approved, or its licence does not allow playback here.",
      canRetry: false,
    };
  }
  if (status === 404) {
    return { message: "This clip no longer exists.", canRetry: false };
  }
  if (status === 409) {
    return {
      message: "This clip is still being processed. Its audio is not ready yet.",
      canRetry: true,
    };
  }
  return { message: `Playback unavailable (${shortMessage(err, 80)}).`, canRetry: true };
}

// ---------------------------------------------------------------------------
// Unread share count
// ---------------------------------------------------------------------------

/**
 * "We have not asked yet", "we asked and the answer is zero", and "we asked
 * and the request failed" are three different facts, and the previous state
 * collapsed the last two.
 *
 * `setUnreadCount(data.unread || 0)` sat inside `catch {}` that did nothing,
 * so a dead poll left the badge at its initial `0` — which the badge renders as
 * *absent*, i.e. "you have no unread shares". A user whose inbox was unreachable
 * was told their inbox was empty.
 *
 * `Header.tsx` and `BottomNav.tsx` take `unreadCount: number` and are owned by
 * other agents, so the honest "unknown" state is rendered here rather than in
 * the badge. See `UnreadStatus` below.
 */
type UnreadState =
  | { status: "checking" }
  | { status: "known"; count: number }
  | { status: "stale"; count: number }
  | { status: "unknown" };

// ---------------------------------------------------------------------------
// Small presentational surfaces
// ---------------------------------------------------------------------------

/**
 * Live region for a tab change.
 *
 * Built to the idiom already established twice in this codebase —
 * `NetworkBanner.tsx:82` and `SessionAnnouncer.tsx:73` both keep the region
 * **mounted when empty** and vary only presentation, because a region inserted
 * at the same tick as its text is unreliable: a screen reader can observe a
 * region that was never there and miss the insertion entirely. A third idiom
 * here would be a third thing for the next reader to reconcile.
 *
 * The text is keyed by a counter, which is the other half of that idiom: a live
 * region whose accessible text does not change is not re-announced, so
 * navigating to the same tab twice has to produce a different subtree. That is
 * the same defect `SessionAnnouncer.tsx:37-39` fixed for its own message.
 */
function TabAnnouncer({ message }: { message: { id: number; text: string } | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tab-announcer"
      style={{
        position: "fixed",
        zIndex: 8000,
        bottom: 96,
        left: "50%",
        transform: "translateX(-50%)",
        display: message ? "flex" : "block",
        alignItems: "center",
        gap: 12,
        maxWidth: message ? "min(520px, calc(100vw - 32px))" : 0,
        padding: message ? "10px 20px" : 0,
        borderRadius: "var(--radius-full)",
        fontSize: 12,
        fontWeight: 600,
        color: "var(--text-primary)",
        background: message ? "var(--surface-container-high)" : "transparent",
        border: message ? "1px solid var(--border-strong)" : "none",
      }}
    >
      {message ? <span key={message.id}>{message.text}</span> : null}
    </div>
  );
}

/**
 * Says out loud what the unread badge cannot.
 *
 * The badge is a number or it is absent, and absent means zero. When the poll
 * fails, the truthful answer is neither, so it is stated here instead: a
 * dismissible note that the count could not be checked, with the reason's own
 * words behind it.
 *
 * `stale` is deliberately not `unknown`. A poll that succeeded ten seconds ago
 * and one that just failed are not the same fact, and throwing away a number we
 * are confident in because the latest refresh failed would be its own kind of
 * lie. The last known count keeps rendering in the badge; this note says it is
 * out of date.
 */
function UnreadStatus({
  state,
  onRetry,
}: {
  state: UnreadState;
  onRetry: () => void;
}) {
  const message =
    state.status === "unknown"
      ? "Unread shares: could not be checked."
      : state.status === "stale"
        ? `Unread shares: showing the last known count — the latest check failed.`
        : null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: message ? "flex" : "block",
        alignItems: "center",
        gap: 12,
        maxWidth: message ? "min(520px, calc(100vw - 32px))" : 0,
        padding: message ? "6px 12px" : 0,
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-secondary)",
      }}
    >
      {message ? (
        <>
          <span>{message}</span>
          <button
            type="button"
            onClick={onRetry}
            className="underline cursor-pointer"
            style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}
          >
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The shared-clip surface.
 *
 * Rendered in place of `FeedPage` while a `?clip=` deep link is being resolved
 * or is resolved, for one reason that is not cosmetic: **`ReelList` autoplays
 * whatever is most visible, from an `IntersectionObserver` that fires the
 * moment it mounts.** A deep link that called `playClip` while the feed was
 * also on screen would be overwritten by the observer within a frame, and the
 * user would hear the top of their feed instead of the clip somebody sent them.
 * There is no prop on `FeedPage` to inject a clip and no way to suppress that
 * observer, and both files belong to other agents — so the feed is not mounted
 * while a deep link is up, and this view is the only owner of the player.
 *
 * It is deliberately plain. The honest scope of a shared clip is: who made it,
 * what it is called, and a control that plays it.
 */
function SharedClipView({
  state,
  onBack,
  onRetry,
}: {
  state: DeepLink;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { currentClip, isPlaying, playClip, togglePlay, queue } = usePlayer();
  const clip = state.kind === "ready" ? state.clip : null;
  const isThisClip = !!clip && currentClip?.id === clip.id;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 md:px-8 py-10 space-y-6">
      <p className="text-[10px] uppercase font-mono font-bold tracking-[0.18em] text-[#FF6321]">
        Shared clip
      </p>

      {state.kind === "resolving" && (
        <p role="status" className="text-sm text-white/50">
          Opening the shared clip…
        </p>
      )}

      {state.kind === "failed" && (
        <div role="alert" className="space-y-3">
          <h1 className="text-xl font-black uppercase tracking-tight text-white">
            This shared link did not open
          </h1>
          <p className="text-sm text-white/50">{state.message}</p>
          <div className="flex flex-wrap gap-3">
            {state.canRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-5 py-2.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={onBack}
              className="px-5 py-2.5 rounded border border-white/20 text-white text-xs font-black uppercase tracking-wider"
            >
              Back to feed
            </button>
          </div>
        </div>
      )}

      {clip && (
        <div className="space-y-5">
          <div className="space-y-2">
            <h1 className="text-2xl font-black tracking-tight text-white">{clip.title}</h1>
            <p className="text-xs font-mono uppercase text-white/50">
              @{clip.creator_name}
              {clip.category ? ` · ${clip.category}` : ""}
            </p>
          </div>

          {isThisClip ? (
            <p className="text-xs text-white/50" role="status">
              {isPlaying ? "Playing this clip." : "Ready to play."}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => playClip(clip, [clip, ...queue])}
              className="px-6 py-3 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
            >
              Play
            </button>
          )}

          {isThisClip && (
            <button
              type="button"
              onClick={togglePlay}
              className="px-5 py-2.5 rounded border border-white/20 text-white text-xs font-black uppercase tracking-wider"
            >
              {isPlaying ? "Pause" : "Resume"}
            </button>
          )}

          <button
            type="button"
            onClick={onBack}
            className="block px-5 py-2.5 rounded border border-white/20 text-white/50 text-xs font-black uppercase tracking-wider"
          >
            Back to feed
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main shell
// ---------------------------------------------------------------------------

const MainContent: React.FC = () => {
  const { queue, playClip } = usePlayer();
  const [activeTab, setActiveTab] = useState<string>("feed");
  const [unread, setUnread] = useState<UnreadState>({ status: "checking" });
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const [targetProfileUserId, setTargetProfileUserId] = useState<number | null>(null);
  const [deepLink, setDeepLink] = useState<DeepLink>({ kind: "absent" });
  const [pendingClipId, setPendingClipId] = useState<string | null>(null);
  const [tabAnnouncement, setTabAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const [feedEverShown, setFeedEverShown] = useState<boolean>(false);

  const mainRef = useRef<HTMLElement | null>(null);
  const announcementCount = useRef<number>(0);
  const deepLinkConsumed = useRef<boolean>(false);
  const deepLinkGeneration = useRef<number>(0);
  const queueRef = useRef<FeedClip[]>([]);
  const playClipRef = useRef(playClip);
  const mountedRef = useRef<boolean>(false);
  /** Pending "the feed has answered" waiters, each with its own cap timer. */
  const feedWaiters = useRef<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }[]>(
    [],
  );

  /**
   * Releases every pending "the feed has answered" waiter.
   *
   * Called from the queue-sync effect below and from each waiter's own cap
   * timer. The queue is copied into `queueRef` first, so a waiter that wakes up
   * from the effect reads the page that just landed, not the one before it.
   */
  const settleFeedWaiters = useCallback(() => {
    const waiters = feedWaiters.current;
    feedWaiters.current = [];
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.resolve();
    });
  }, []);

  useEffect(() => {
    queueRef.current = queue;
    settleFeedWaiters();
  }, [queue, settleFeedWaiters]);

  useEffect(() => {
    playClipRef.current = playClip;
  }, [playClip]);

  /**
   * Nothing in flight may write state after this component is gone.
   *
   * The generation bump is what makes that true for `openSharedClip`, whose
   * awaits can outlive the unmount — a share link that resolves after the user
   * has navigated away is a `setState` on a dead component and a `playClip`
   * that starts audio nobody asked for. The waiters are flushed rather than
   * dropped so their promises settle instead of leaking.
   */
  useEffect(() => {
    return () => {
      deepLinkGeneration.current += 1;
      settleFeedWaiters();
    };
  }, [settleFeedWaiters]);

  // Poll unread count every 30s as specified in Section 4.7
  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await shareAPI.getUnreadCount();
      setUnread({ status: "known", count: typeof data.unread === "number" ? data.unread : 0 });
    } catch {
      // Not swallowed into a zero. See `UnreadState`.
      setUnread((prev) =>
        prev.status === "known" ? { status: "stale", count: prev.count } : { status: "unknown" },
      );
    }
  }, []);

  useEffect(() => {
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [refreshUnreadCount]);

  // Check onboarding on new user register
  useEffect(() => {
    if (sessionStorage.getItem("ef_new_user") === "1") {
      setIsOnboardingOpen(true);
    }
  }, []);

  // -------------------------------------------------------------------------
  // The share deep link
  // -------------------------------------------------------------------------

  /**
   * Resolves when the feed's first page has landed, or after the cap.
   *
   * This is what makes the in-feed answer *authoritative* rather than a race.
   * See `openSharedClip` for why a metadata failure is not an answer on its
   * own.
   */
  const whenFeedAnswers = useCallback((): Promise<void> => {
    // A page with clips in it has already answered. A `[]` queue has not — it
    // is identical before the load and after a cold or failed one, which is
    // the whole reason the cap below exists.
    if (queueRef.current.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      feedWaiters.current.push({
        resolve,
        timer: setTimeout(settleFeedWaiters, DEEP_LINK_FEED_GRACE_MS),
      });
    });
  }, [settleFeedWaiters]);

  /**
   * The only writer of the "opened" state.
   *
   * It claims the generation itself, so whichever of the two resolutions gets
   * here first ends the race and the other is discarded on its next check.
   * Funnelling both through one function is what makes "the in-feed answer
   * wins" a property of the code rather than of the order two `await`s happen
   * to settle in.
   */
  const openResolvedClip = useCallback((clip: FeedClip, nextQueue: FeedClip[]) => {
    deepLinkGeneration.current += 1;
    setDeepLink({ kind: "ready", clip });
    playClipRef.current(clip, nextQueue);
  }, []);

  const openSharedClip = useCallback(
    async (clipId: string) => {
      // Two things can resolve a deep link and they race: this fetch, and the
      // feed queue arriving with the clip already in it. Each resolution claims
      // a generation number, and a resolution that has been superseded does
      // not write state. Without it, a fast `GET /clips/{id}/resolve/` would
      // overwrite the in-feed answer and start the same clip over.
      const generation = ++deepLinkGeneration.current;
      const isCurrent = () => deepLinkGeneration.current === generation;
      const inQueue = () => queueRef.current.find((c) => c.id === clipId) ?? null;

      // Checked before the request, not only after it. A feed that already
      // holds the clip is a complete answer on its own — the feed's copy is the
      // same `FeedClipSerializer` payload — so this path issues no request at
      // all, which is what "already in the loaded feed" should mean.
      const alreadyLoaded = inQueue();
      if (alreadyLoaded) {
        openResolvedClip(alreadyLoaded, queueRef.current);
        return;
      }

      setDeepLink({ kind: "resolving" });
      let clip: FeedClip;
      try {
        // **`/clips/{id}/resolve/`, not `/clips/{id}/`.** `retrieve` is
        // creator-scoped — `AudioUploadViewSet.get_queryset` is
        // `filter(creator=self.request.user)` (`views/content.py:117-120`) — so
        // it 404s for every clip the recipient did not upload, which is every
        // real share. `resolve_clip` (`views/content.py:535`) is gated on
        // `resolve_clip_access` instead, which is the same rule the playback
        // token uses, so metadata and playback cannot disagree about who may
        // see a clip.
        clip = await apiRequest<FeedClip>(`/clips/${clipId}/resolve/`);
      } catch (err) {
        if (!isCurrent()) return;

        // **A metadata failure is not yet an answer, and this is the whole
        // reason the in-feed path is authoritative.** This page load mounts the
        // feed on its first commit, so a `GET /feed/` is already in flight and
        // its `setQueue` can arrive a moment after this catch block runs. When
        // the resolve request is a single indexed PK lookup it usually wins
        // the race — measured here: the 404 was handled with `queue` still
        // `[]`, and the feed's page landed on the next commit. The old code
        // therefore wrote `failed`, the in-feed effect was gated off by
        // `deepLink.kind !== "resolving"`, and a link that works was reported
        // as "not available on your account" on the one screen whose job is to
        // open what somebody sent. Waiting for the feed's page before
        // concluding anything makes the outcome a function of the data rather
        // than of the network's timing.
        await whenFeedAnswers();
        if (!isCurrent()) return;
        const fromQueue = inQueue();
        if (fromQueue) {
          openResolvedClip(fromQueue, queueRef.current);
          return;
        }

        if (err instanceof ApiError && (err.kind === "network" || err.kind === "timeout")) {
          setDeepLink({
            kind: "failed",
            message: "Could not reach EchoFlow. Check your connection, then try again.",
            canRetry: true,
          });
          return;
        }
        // 404 here is deliberately NOT reported as "this clip does not exist".
        // `resolve_clip` answers 404 for both "never created" and "not
        // available to you" (`views/content.py:588,594`) precisely so the
        // endpoint is not an existence oracle. Telling those two apart would be
        // a false claim and an oracle to go with it.
        setDeepLink({
          kind: "failed",
          message:
            "This shared clip is not available on your account. The link may be for a different account, or the clip may have been removed.",
          canRetry: false,
        });
        return;
      }

      // The feed may have supplied the clip while the request was in flight,
      // and its copy carries the feed's own `is_liked` / `is_following`
      // annotations, so it is preferred over the fetched body.
      if (!isCurrent()) return;
      const fromQueue = inQueue();
      if (fromQueue) {
        openResolvedClip(fromQueue, queueRef.current);
        return;
      }

      // Access probe. `playClip` mints its own token; probing first is what lets
      // this view say *which* of the four refusals it hit instead of leaving the
      // user with a silent player. `playback_token` is throttled at 300/min
      // (`settings.py:802`) and a deep link mints at most two, once, on purpose.
      //
      // No queue consultation on this path: the clip is already in hand, so
      // "the feed might have it" cannot change the answer, and the probe is the
      // authoritative one by design — `resolve_clip` deliberately does not gate
      // on `status` (`views/content.py:568-572`) so an approved-but-encoding
      // clip comes back with its real status and this 409 stands.
      try {
        await mediaAPI.getPlaybackToken(clipId);
      } catch (err) {
        if (!isCurrent()) return;
        setDeepLink({ kind: "failed", ...playbackFailureMessage(err) });
        return;
      }
      if (!isCurrent()) return;

      // The shared clip leads the queue so "next reel" walks into the feed
      // instead of replaying the shared clip for ever. It is deliberately NOT
      // put at the end: `nextClip` computes `findIndex`, so a clip absent from
      // the queue would send "next" to `queue[0]` and "previous" to
      // `queue[n - 2]`.
      openResolvedClip(clip, [clip, ...queueRef.current]);
    },
    [whenFeedAnswers, openResolvedClip],
  );

  useEffect(() => {
    if (deepLinkConsumed.current) return;
    deepLinkConsumed.current = true;

    const raw = consumeClipParam();
    if (raw === null) return;

    if (!CLIP_UUID_V4.test(raw)) {
      // A malformed link is a broken link, not a failure with an action behind
      // it. No request is made and no error is shown; the user gets the feed.
      return;
    }
    setPendingClipId(raw);
    setActiveTab("feed");
    void openSharedClip(raw);
  }, [openSharedClip]);

  /**
   * Resolves as soon as the feed has the clip, for the case the deep link names
   * a clip the recipient's own feed already served.
   *
   * `Feed.tsx:216` calls `setQueue(merged)`, so the player store's `queue` *is*
   * the loaded feed. Reading it here is what makes "find it in the loaded feed"
   * possible without `App.tsx` taking ownership of the feed's fetch — a prop on
   * `FeedPage` would be a second way for two files to decide what the feed is.
   *
   * The metadata fetch above is not deferred waiting for this, and the two are
   * not ordered against each other: `queue` is `[]` both before the feed has
   * loaded and after a cold or failed load, so there is no state in which "the
   * feed is done and the clip is not in it" is observable from here. Running
   * them in parallel costs one request on the path where the feed is cold and
   * saves the entire round trip on the path where the user is not looking at a
   * spinner.
   *
   * **This effect is the fast path, not the authority.** It claims the
   * generation through `openResolvedClip`, so if it gets there first the
   * response is discarded. The authority is `openSharedClip`'s failure path,
   * which waits for the feed's first page before concluding the clip is
   * unavailable — which is why a `deepLink.kind !== "resolving"` gate here is
   * not a hole: `failed` cannot be reached while this effect is still able to
   * answer.
   */
  useEffect(() => {
    if (deepLink.kind !== "resolving" || !pendingClipId) return;
    const inFeed = queue.find((clip) => clip.id === pendingClipId);
    if (!inFeed) return;

    openResolvedClip(inFeed, queue);
  }, [deepLink, pendingClipId, queue, openResolvedClip]);

  const dismissDeepLink = useCallback(() => {
    setPendingClipId(null);
    setDeepLink({ kind: "absent" });
  }, []);

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const goToTab = useCallback((tab: string) => {
    // A shared-clip view belongs to the feed tab only. Navigating away
    // releases it, and the parameter is already gone from the URL, so returning
    // to the feed shows the feed.
    if (tab !== "feed") dismissDeepLink();
    setActiveTab(tab);
    announcementCount.current += 1;
    setTabAnnouncement({
      id: announcementCount.current,
      text: `${TAB_LABELS[tab] ?? tab} loaded`,
    });
  }, [dismissDeepLink]);

  /**
   * What the nav bars call.
   *
   * The `targetProfileUserId = null` on "profile" is the nav's own rule — tapping
   * Profile anywhere means *your* profile — so it lives here rather than in
   * `goToTab`, which `handleOpenCreatorProfile` also calls. Putting it in
   * `goToTab` made the creator-profile path clear the id it had just set, one
   * statement later.
   */
  const handleNavSelect = (tab: string) => {
    if (tab === "profile") setTargetProfileUserId(null);
    goToTab(tab);
  };

  /**
   * Focus follows the content.
   *
   * Changing `activeTab` used to swap the page inside `<main>` and do nothing
   * else: no focus move, no announcement, no title change (RECON-06 §3). A
   * screen-reader user's cursor stayed on the nav button — which is right — but
   * the new page was never announced, so pressing "Creator Studio" was
   * indistinguishable from pressing nothing.
   *
   * `<main>` is the target rather than the new page's heading, because the
   * headings are not a stable contract: the feed renders one `<h1>` per
   * `ReelCard`, Profile has no `<h1>` at all and jumps h2→h4, and three of the
   * five pages skip a level (RECON-06 #20). Focusing the region that changed is
   * the one target that exists on every tab.
   *
   * Deliberately skipped on the first render: stealing focus on load moves it
   * away from wherever the user was, and on a deep link it would race the
   * resolve. `tabIndex={-1}` makes `<main>` focusable without adding a tab stop.
   */
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    mainRef.current?.focus();
  }, [activeTab, deepLink.kind]);

  useEffect(() => {
    // A failed deep link is still not the feed. "Live Feed" in the tab title
    // while a share link is on screen is the same class of lie as a badge that
    // reads zero because the poll failed.
    const label = deepLink.kind === "absent" ? TAB_LABELS[activeTab] ?? "EchoFlow" : "Shared clip";
    document.title = `EchoFlow — ${label}`;
  }, [activeTab, deepLink.kind]);

  const handleOpenCreatorProfile = (creatorId: number) => {
    setTargetProfileUserId(creatorId);
    goToTab("profile");
  };

  const handleBackToMyProfile = () => {
    setTargetProfileUserId(null);
  };

  /**
   * Keep the feed mounted once it has been shown.
   *
   * `GET /feed/` is a destructive `lpop(user_feed:{id}, 10)`
   * (`views/feed.py:71`) whose cold fallback serves trending *after* the ids
   * were consumed (`:127-131`). `App.tsx` used to render `{activeTab === "feed"
   * && <FeedPage/>}`, so every tab switch unmounted the feed and its remount
   * fetched again: a user flipping between two tabs permanently drained their
   * own queue, and a database error after the `lpop` destroyed those ten clips
   * for good (RECON-04 F23).
   *
   * `FeedPage` stays mounted and is hidden with the `hidden` attribute. Why
   * this and not the alternatives:
   *
   * - **Hoisting the feed state above the tab switch** stops the fetch but not
   *   the unmount, so `ReelList`'s scroll position, its `IntersectionObserver`
   *   and `FeedPage`'s selected-modal state are all still lost. It also means
   *   two files own the feed.
   * - **Buffering the last page client-side** fixes the destructive half only.
   *   The ids are still consumed from Redis on every visit, so the queue keeps
   *   draining server-side; it just stops being *visible*.
   * - **Mounting all five pages and hiding them** would fix the feed and
   *   multiply every other page's mount-time fetch. `Explore.tsx:134`,
   *   `Inbox.tsx:152`, `Upload.tsx:244` and `Profile.tsx` each fetch on mount,
   *   so a cold start would fire four extra requests for screens nobody is
   *   looking at. Only the feed is pinned.
   *
   * What it costs, stated plainly:
   *
   * - One page's DOM is retained for the session. Bounded, and it is the
   *   screen the user spends the most time on.
   * - `hidden` is `display: none`, so the feed is correctly removed from the
   *   accessibility tree and a screen reader will not read it. Focus cannot be
   *     lost *into* it either: the only way to change tab is to activate a
   *     control in the header or the bottom nav, so focus is on that control,
   *     not inside the subtree being hidden.
   * - `FeedPage`'s cold-queue retry timer keeps running while the feed is
   *     hidden. That is a real cost and it is a benefit in the cold case — the
   *     queue warms up while the user is elsewhere — but it is also a request
   *     the user did not ask for. `Feed.tsx` is owned by another agent and owns
   *     that timer; see the report.
   * - Playback is unaffected either way. The `<audio>` element is created in
   *     `PlayerProvider`'s mount effect with an empty dep list and is only torn
   *     down when the provider unmounts, so unmounting `FeedPage` never stopped
   *     the audio before this change either.
   */
  // Every non-`absent` state owns the feed tab, INCLUDING `failed`. Leaving the
  // feed mounted under a failure would let `ReelList`'s observer autoplay over
  // the explanation, and would show the user a feed after they asked for one
  // specific clip.
  //
  // **The first commit still mounts the feed, and that is load-bearing.** On a
  // `?clip=` load `deepLink` is `absent` and `activeTab` is `feed` for the
  // first render, because the deep link is consumed from a `useEffect` and
  // `setDeepLink` cannot reach the render that scheduled it. So `FeedPage`
  // mounts once, its `useEffect` fires `GET /feed()`, and the very next commit
  // unmounts it — `setDeepLink({kind:"resolving"})` runs synchronously inside
  // `openSharedClip` before its first `await`, so no response can beat it.
  // `ReelList` therefore never renders on a deep link (the page is still in its
  // `loading` phase, which returns before `ReelList`), which is the property
  // `SharedClipView` depends on, and the request is what makes the in-feed
  // lookup in `openSharedClip` a real answer rather than a hope.
  //
  // It is one `lpop` of ten ids that this page load would have spent on the
  // feed anyway the moment the user pressed "Back to feed", and that remount is
  // free: `adoptPage` wrote the page to the session cache (`Feed.tsx:234`), so
  // it is served from `sessionStorage` rather than re-requested. Net cost of a
  // share link: no extra `lpop`. It would be a real cost if the deep-link
  // surface were entered without ever leaving the app, which is why the
  // in-feed answer is allowed to short-circuit the resolve request entirely
  // when the queue is already warm.
  const deepLinkActive = deepLink.kind !== "absent";
  const feedIsCurrentTab = activeTab === "feed" && !deepLinkActive;
  const renderFeed = !deepLinkActive && (feedIsCurrentTab || feedEverShown);

  useEffect(() => {
    if (feedIsCurrentTab) setFeedEverShown(true);
  }, [feedIsCurrentTab]);

  // No auth gate here. This used to carry a second copy of it —
  // `if (!isAuthenticated && !isLoading) return <LoginPage/>` — which is what
  // disagreed with `AuthenticatedApp`'s `isAuthenticated`-only check and
  // produced the loading flash. `AuthenticatedApp` is now the single gate and
  // renders this component only for an authenticated user, so a second
  // predicate here cannot be reached; it would only be able to disagree with
  // the first one again the next time the gate changed.

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5] flex flex-col selection:bg-[#FF6321] selection:text-black font-sans">
      {/* Connectivity banner — FRONTEND-REQUIREMENTS.md §4.9 */}
      <NetworkBanner />

      {/* Tab-change announcement. Mounted always, empty when idle — see
          `TabAnnouncer`. */}
      <TabAnnouncer message={tabAnnouncement} />

      {/* Unread-count honesty. The badge cannot render "unknown", so the unknown
          state is stated here rather than being drawn as a zero. */}
      <UnreadStatus state={unread} onRetry={refreshUnreadCount} />

      {/* Top App Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={handleNavSelect}
        unreadCount={badgeCount(unread)}
      />

      {/* Main Tab Screen. `tabIndex={-1}` makes this the focus target for a tab
          change without putting a stop in the tab order. */}
      <main
        ref={mainRef}
        tabIndex={-1}
        className="flex-1 w-full flex flex-col focus:outline-none"
      >
        {/* The feed and the deep-link view are mutually exclusive by
            construction: `renderFeed` and `deepLinkActive` both require
            `!deepLinkActive`, and the feed is additionally `hidden` unless it is
            the current tab. The four other pages are gated only on the tab, so a
            feed that stays mounted never suppresses them. */}
        {renderFeed && (
          <div hidden={!feedIsCurrentTab}>
            <FeedPage
              onOpenCreatorProfile={handleOpenCreatorProfile}
              onOpenOnboarding={() => setIsOnboardingOpen(true)}
            />
          </div>
        )}

        {deepLinkActive && (
          <SharedClipView
            state={deepLink}
            onBack={dismissDeepLink}
            onRetry={() => pendingClipId && void openSharedClip(pendingClipId)}
          />
        )}

        {!deepLinkActive && activeTab === "explore" && (
          <ExplorePage onOpenFeed={() => goToTab("feed")} />
        )}
        {!deepLinkActive && activeTab === "upload" && (
          <UploadPage onUploadSuccess={() => goToTab("feed")} />
        )}
        {!deepLinkActive && activeTab === "inbox" && (
          <InboxPage onRefreshUnread={refreshUnreadCount} />
        )}
        {!deepLinkActive && activeTab === "profile" && (
          <ProfilePage
            targetUserId={targetProfileUserId}
            onBackToMyProfile={handleBackToMyProfile}
          />
        )}
      </main>

      {/* Persistent Mini Player (visible on other tabs when audio is loaded) */}
      {activeTab !== "feed" && (
        <MiniPlayer onOpenFeed={() => goToTab("feed")} />
      )}

      {/* Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        setActiveTab={handleNavSelect}
        unreadCount={badgeCount(unread)}
      />

      {/* Cold Start Vector Onboarding Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onInitialized={() => {
          setIsOnboardingOpen(false);
          goToTab("feed");
        }}
      />
    </div>
  );
};

/**
 * The number the badge may legitimately render.
 *
 * `Header.tsx` and `BottomNav.tsx` take `unreadCount: number` and draw a chip
 * only when it is `> 0`, so an unknown count is passed as `0` — the value that
 * makes the chip disappear. That is the remaining half of the problem, and both
 * files are owned by other agents: the fix is `unreadCount: number | null` in
 * both prop types, a chip that renders `?` with an accessible name of "unread
 * count unknown" when it is `null`, and this function replaced by
 * `unread.status === "known" || unread.status === "stale" ? unread.count : null`
 * at the two call sites. Until then `UnreadStatus` above carries the truth and
 * the badge's silence is no longer the only signal.
 */
function badgeCount(state: UnreadState): number {
  return state.status === "known" || state.status === "stale" ? state.count : 0;
}

// ---------------------------------------------------------------------------
// Global unhandled error / rejection surface
// ---------------------------------------------------------------------------

interface AppLevelFailure {
  id: number;
  text: string;
}

/**
 * The last unhandled rejection or uncaught exception, with a way to clear it.
 *
 * **Why this exists.** `ErrorBoundary` catches render-phase throws and nothing
 * else. React 19 does not route an event-handler throw, a `useEffect` throw or
 * an async rejection to any boundary, and a throw inside an async callback is
 * not an error the framework ever sees. `grep -rn "unhandledrejection|
 * window.onerror" src/` returned nothing before this (RECON-04 F19), so the
 * app's entire class of "it silently did nothing" failures terminated in the
 * console.
 *
 * **Where it is reported, and why there is nowhere else to report it.**
 * There is no browser error destination in this project:
 *
 * - `AGENTS.md`'s Sentry integration is `sentry-sdk[django,celery]` initialised
 *   per Python process. There is no `@sentry/react` dependency, no DSN is
 *   exposed to the browser, and `send_default_pii=False` is the configured
 *   posture. Wiring one up is a new dependency, a new environment variable, a
 *   new data path and a DPDP question about what a browser may transmit — not
 *   a resilience fix.
 * - There is no generic error endpoint on the API. The only 4xx/5xx receivers
 *   are clip-scoped (`POST /interactions/{id}/log-telemetry/`, 60/min) and
 *   would reject a non-clip error, or abuse a ranking signal to carry it.
 * - `navigator.sendBeacon` to a new path is the same problem with less
 *   ceremony: a new endpoint plus a new egress.
 *
 * So this is **console + a visible surface, and nothing leaves the device.**
 * The trade-off is explicit: nothing is aggregated, so a rejection that only
 * happens on one user's phone is invisible to everyone else and is not
 * triaged. That is the correct trade for a frontend with no telemetry budget
 * and no privacy review, and it is strictly better than today, where the same
 * rejection was not even shown to the user it happened to. When a destination
 * is funded, this is the single place it plugs in — `report()` below.
 *
 * **What is shown.** `Error.message` only, truncated. That is the same class of
 * thing the rest of the app already renders (`Feed.tsx:64`, `Profile.tsx:37`,
 * `Login.tsx:82` all surface `err.message`), so no new category of data
 * reaches the screen. The full object — stack, cause, `ApiError.data` — goes to
 * the console for whoever has devtools open, and stops there.
 */
function useAppLevelFailures(): { failure: AppLevelFailure | null; dismiss: () => void } {
  const [failure, setFailure] = useState<AppLevelFailure | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    const record = (label: string, reason: unknown) => {
      // Not swallowed: devtools is where the stack is, and this is the only
      // place the original object is preserved.
      console.error(label, reason);
      counter.current += 1;
      setFailure({ id: counter.current, text: shortMessage(reason) });
    };

    const onRejection = (event: Event) => {
      record("Unhandled promise rejection:", (event as Event & { reason?: unknown }).reason);
    };
    const onError = (event: Event) => {
      record("Uncaught error:", (event as Event & { error?: unknown }).error ?? event);
    };

    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return { failure, dismiss: () => setFailure(null) };
}

/**
 * Renders the app-level failure. Mounted always, per the established idiom.
 *
 * Deliberately a sibling of `AuthenticatedApp` rather than a child of
 * `MainContent`: a session expiry is exactly the moment a request is most
 * likely to reject, and a surface inside the authenticated tree would be torn
 * down by the transition it is supposed to explain. Same reasoning as
 * `SessionNotice` at the line below.
 */
function AppLevelFailureNotice() {
  const { failure, dismiss } = useAppLevelFailures();

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        zIndex: 9500,
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        display: failure ? "flex" : "block",
        alignItems: "center",
        gap: 12,
        maxWidth: failure ? "min(560px, calc(100vw - 32px))" : 0,
        padding: failure ? "10px 16px" : 0,
        borderRadius: "var(--radius-sm)",
        background: failure ? "var(--surface-container-high)" : "transparent",
        border: failure ? "1px solid var(--border-strong)" : "none",
        color: "var(--text-primary)",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {failure ? (
        <>
          <span key={failure.id}>Something didn't finish: {failure.text}</span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss error"
            style={{
              minWidth: 28,
              minHeight: 28,
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Gate between the authenticated app and the login page.
 *
 * The session notice lives here rather than inside `MainContent` because
 * session expiry is the event that *causes* `MainContent` to render
 * `LoginPage` — a notice rendered inside the authenticated tree would be torn
 * down by the very transition it needs to explain. `AppLevelFailureNotice` is
 * a sibling for the same reason.
 *
 * **The loading window.** This gate used to test `isAuthenticated` alone, while
 * `MainContent` tested `!isAuthenticated && !isLoading`. Those disagree for the
 * whole of the auth-loading window whenever tokens exist but `ef_user` does
 * not, and `isAuthenticated` is `!!user` with `user` seeded synchronously from
 * `sessionStorage` (`stores/auth.tsx:25,117`) — so a page load in that state
 * rendered the whole login form, announced nothing, and then replaced it. Focus,
 * if the user had tabbed into the form, sat on a node that was about to be
 * unmounted.
 *
 * The gate is now `hasStoredSession() && isLoading` first, which is the same
 * predicate `AuthProvider` itself uses to decide whether to fetch a profile at
 * all (`auth.tsx:46-52`). The splash is shown for that case only, so a
 * first-time visitor with no tokens still gets the login form on first paint
 * rather than a spinner they have to wait out.
 */
function hasStoredSession(): boolean {
  return getStoredTokens() !== null;
}

/**
 * The auth gate's loading state.
 *
 * Not a spinner with no content: it carries `role="status"` and its own text so
 * the wait is announced rather than silent, and it is `aria-busy` on the region
 * that will hold the app. Text is `text-white/50` (5.29:1) — the floor the rest
 * of the app settled on; `text-white/40` is 3.77:1 and `text-white/30` is
 * 2.61:1, both under WCAG 1.4.3.
 */
function AuthLoadingScreen() {
  return (
    <div
      className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5] flex items-center justify-center"
      aria-busy="true"
    >
      <p role="status" className="text-xs font-mono uppercase text-white/50">
        Signing you in…
      </p>
    </div>
  );
}

const AuthenticatedApp: React.FC = () => {
  const { message, dismiss } = useSessionAnnouncer();
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <>
      <SessionNotice message={message} onDismiss={dismiss} />
      <AppLevelFailureNotice />
      {hasStoredSession() && isLoading ? (
        <AuthLoadingScreen />
      ) : isAuthenticated ? (
        <MainContent />
      ) : (
        <LoginPage />
      )}
    </>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <PlayerProvider>
          <AuthenticatedApp />
        </PlayerProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
