import React, { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { apiRequest, feedAPI } from "../api/client";
import { usePlayer } from "../stores/player";
import { FeedClip, FeedResponse } from "../types/echoflow";
import { ReelList } from "../components/feed/ReelList";
import { CommentSheet } from "../components/comments/CommentSheet";
import { ShareModal } from "../components/sharing/ShareModal";

interface FeedPageProps {
  onOpenCreatorProfile: (creatorId: number) => void;
  onOpenOnboarding: () => void;
}

/**
 * The value `views/feed.py:124,149` puts in `next` on BOTH the Redis path and
 * the degraded-fallback path. It is a sentinel, not a URL: the queue refills
 * on the next request rather than a cursor being followed.
 *
 * This matters because `apiRequest` passes absolute URLs through untouched
 * (`client.ts:23-25`), so "follow `next` verbatim" — the correct rule on
 * `/suggestions/`, where `FeedCursorPagination` builds a real URL — would
 * `GET /feed/auto_trigger` here and 404. Verified against the source rather
 * than assumed: `/feed/` is a plain `ViewSet` with no pagination class.
 */
const FEED_NEXT_SENTINEL = "auto_trigger";

/** `views/feed.py:96`'s own hint, used only when the response omits it. */
const COLD_FALLBACK_WAIT_MS = 1500;

/**
 * Retry budget for a cold queue: 5 attempts at the server's own interval, so
 * ~7.5 s of asking.
 *
 * Sized against `ai_ml/pipelines/feed_tasks.py:91` — the refill takes a
 * `SETNX` lock with a **30 s** expiry, so a genuinely slow refill can still be
 * in progress well past 7.5 s and the second `lpop` will keep returning
 * nothing. That is exactly the case where "you have no reels" would be a lie,
 * which is why exhausting the budget produces an explicit "still preparing"
 * screen rather than the empty state.
 */
const COLD_RETRY_LIMIT = 5;

/**
 * Granularity of the visible countdown. The server's hint is 1500 ms, so a
 * 250 ms tick is enough to show a number that actually counts down without
 * re-rendering the page four times a second to say so.
 */
const COUNTDOWN_TICK_MS = 250;

/**
 * How long a loaded feed page is reused across a remount.
 *
 * See the `writeFeedPageCache` docstring for why this exists at all. Five
 * minutes is far longer than any tab round trip — the thing this actually
 * stops — and short enough that returning from a break is not reading a
 * quarter-hour-old page. Nothing on screen claims freshness either way.
 */
const FEED_PAGE_CACHE_TTL_MS = 5 * 60 * 1000;

const FEED_PAGE_CACHE_KEY = "echoflow:feed-page:v1";

interface FeedPageCacheEntry {
  at: number;
  clips: FeedClip[];
  next: string | null;
  queueHealth: number | null;
  degraded: boolean;
}

/**
 * The last page this browser session loaded, so a remount does not re-ask.
 *
 * WHY: `App.tsx:80-100` renders `{activeTab === "feed" && <FeedPage …>}` — the
 * page is UNMOUNTED on every tab switch. `Feed.tsx` fetched on mount, and
 * `GET /feed/` is a destructive `lpop(redis_key, 10)` (`views/feed.py:75`):
 * ten ids leave the user's queue per call, and the `except` at `:128-153`
 * serves a trending fallback *after* the ids were already consumed, so a DB
 * error on that path destroys them outright. Every tab switch therefore cost
 * ten clips that nothing puts back. This file cannot fix the remount (that is
 * `App.tsx`), but it can stop paying for it.
 *
 * WHAT IT IS NOT: a fix. A full page reload re-mounts a fresh JS realm but
 * `sessionStorage` survives, so the endpoint is still called at most once per
 * `FEED_PAGE_CACHE_TTL_MS` rather than once per tab switch, and a genuine
 * error, cold response or exhausted retry is never cached — those always
 * re-request. The honest fix is to stop unmounting the page.
 */
function readFeedPageCache(): FeedPageCacheEntry | null {
  try {
    const raw = sessionStorage.getItem(FEED_PAGE_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as FeedPageCacheEntry;
    if (!entry || !Array.isArray(entry.clips) || entry.clips.length === 0) return null;
    if (Date.now() - entry.at > FEED_PAGE_CACHE_TTL_MS) return null;
    return entry;
  } catch (err) {
    // A malformed entry is not worth a crash on the feed. A quota or
    // private-mode failure is logged, not swallowed, because a store that
    // always throws means the F23 mitigation above is silently inert.
    console.warn("Feed page cache unreadable; the feed will be re-requested.", err);
    return null;
  }
}

function writeFeedPageCache(entry: FeedPageCacheEntry | null): void {
  try {
    if (entry) sessionStorage.setItem(FEED_PAGE_CACHE_KEY, JSON.stringify(entry));
    else sessionStorage.removeItem(FEED_PAGE_CACHE_KEY);
  } catch (err) {
    console.warn(
      "Feed page cache unavailable; tab switches will re-request the feed.",
      err,
    );
  }
}

function invalidateFeedPageCache(): void {
  writeFeedPageCache(null);
}

/**
 * A 202 with no results. The `results.length === 0` half is load-bearing and
 * must not be relaxed: a 202 that carries results is a real page that happens
 * to be accepted-not-completed, and treating it as cold would throw away clips
 * that are already on screen.
 */
function isColdResponse(data: FeedResponse): boolean {
  return data.retry_after_ms !== undefined && data.results.length === 0;
}

/**
 * Whether the server has actually said this is the end of the feed.
 *
 * - No `next` at all: the server offered no further page. That is the one
 *   thing `next` being absent legitimately claims.
 * - `next: "auto_trigger"`: the sentinel, so `next` says nothing about
 *   completeness here. The honest signal is `queue_health` — `llen` of this
 *   user's Redis queue, read after the `lpop`, i.e. clips still waiting.
 * - Any other non-empty string: a real cursor from a paginated endpoint, so
 *   there is a further page.
 *
 * `queueHealth === null` never counts as "caught up": it is what a 202 sends
 * (no queue read happened) and what the degraded fallback sends (the Redis read
 * that would have produced it is the thing that failed). Neither is a
 * completeness claim.
 */
function isEndOfFeed(
  next: string | null,
  queueHealth: number | null,
  degraded: boolean,
): boolean {
  if (next === null) return true;
  if (next !== FEED_NEXT_SENTINEL) return false;
  if (degraded) return false;
  return queueHealth === 0;
}

/**
 * What the page is showing. Five states because three different things used to
 * render as one:
 *
 * - `cold` — the server says the queue is warming up. A countdown is running.
 * - `cold-stalled` — the retry budget is spent. Still not "empty".
 * - `failed` — the first request failed and there is nothing to be stale.
 * - `ready` — clips on screen. A failed *refresh* lands here too, with the
 *   error alongside, because the reels are stale, not absent.
 */
type FeedPhase = "loading" | "cold" | "cold-stalled" | "failed" | "ready";

/** A pending wait for a cold queue, with everything the retry needs. */
interface ColdWait {
  waitMs: number;
  attempt: number;
  /** True when the cold answer arrived while reels were on screen. */
  append: boolean;
}

export const FeedPage: React.FC<FeedPageProps> = ({ onOpenCreatorProfile, onOpenOnboarding }) => {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [phase, setPhase] = useState<FeedPhase>("loading");
  const [isDegraded, setIsDegraded] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [queueHealth, setQueueHealth] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [cold, setCold] = useState<ColdWait | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number>(0);

  // Modals state
  const [selectedClipForComments, setSelectedClipForComments] = useState<FeedClip | null>(null);
  const [selectedClipForShare, setSelectedClipForShare] = useState<FeedClip | null>(null);

  const { currentClip, playClip, setQueue, handsFreeMode } = usePlayer();

  /**
   * The rendered clip list, readable synchronously.
   *
   * `loadMore` needs the list it is appending to without taking `clips` as a
   * dependency — a new identity on every append re-arms `ReelList`'s
   * pagination observer each time. `adoptPage` is the ONLY writer of `clips`
   * in this file, and it writes the ref in the same breath, so the two cannot
   * drift.
   */
  const clipsRef = useRef<FeedClip[]>([]);

  const applyPage = useCallback(
    (data: FeedResponse, append: boolean) => {
      const seen = new Set(clipsRef.current.map((c) => c.id));
      const merged = append
        ? [...clipsRef.current, ...data.results.filter((c) => !seen.has(c.id))]
        : data.results;
      clipsRef.current = merged;
      setClips(merged);
      setQueue(merged);
      setIsDegraded(!!data.degraded);
      setNextCursor(typeof data.next === "string" ? data.next : null);
      setQueueHealth(typeof data.queue_health === "number" ? data.queue_health : null);
    },
    [setQueue],
  );

  /** `applyPage` plus the session cache. Only ever called from a response. */
  const adoptPage = useCallback(
    (data: FeedResponse, append: boolean) => {
      applyPage(data, append);
      // Only a page that produced content is cached: an error, a cold 202 and
      // an exhausted retry must all re-request on the next mount, or a failure
      // would be frozen for the rest of the session. The timestamp is the
      // moment the page was FETCHED, never the moment it was read back —
      // re-stamping on a cache hit would let a tab-switch loop keep a page
      // alive for ever.
      writeFeedPageCache(
        clipsRef.current.length > 0
          ? {
              at: Date.now(),
              clips: clipsRef.current,
              next: typeof data.next === "string" ? data.next : null,
              queueHealth: typeof data.queue_health === "number" ? data.queue_health : null,
              degraded: !!data.degraded,
            }
          : null,
      );
    },
    [applyPage],
  );

  const loadFeed = useCallback(
    async (attempt: number, append = false) => {
      if (!append && attempt === 0) {
        const cached = readFeedPageCache();
        if (cached) {
          applyPage(
            {
              results: cached.clips,
              next: cached.next ?? undefined,
              queue_health: cached.queueHealth ?? undefined,
              degraded: cached.degraded,
            },
            false,
          );
          setPhase("ready");
          // Autoplay the first reel only if nothing is playing, exactly as the
          // network path does — a remount must not restart the current track.
          const first = cached.clips[0];
          if (first && !currentClip) playClip(first, cached.clips);
          return;
        }
      }
      // A refresh that keeps the reels on screen must not blank them for a
      // spinner: the previous page is still there, and replacing it with
      // "Loading your feed…" on every refresh is a worse version of the same
      // "the list is not what it was" problem this page keeps running into.
      if (!append && clipsRef.current.length === 0) setPhase("loading");
      setLoadError(null);
      setMoreError(null);
      try {
        const data: FeedResponse = await feedAPI.getFeed();

        if (isColdResponse(data)) {
          if (attempt >= COLD_RETRY_LIMIT) {
            setCold(null);
            // Explicitly "still preparing". The reels on screen, if any, are
            // not discarded; a cold answer carries no results by definition.
            if (!append) setPhase("cold-stalled");
            return;
          }
          setCold({ waitMs: data.retry_after_ms || COLD_FALLBACK_WAIT_MS, attempt, append });
          if (!append && clipsRef.current.length === 0) setPhase("cold");
          return;
        }

        setCold(null);
        adoptPage(data, append);
        setPhase("ready");
      } catch (err: unknown) {
        setCold(null);
        setLoadError(
          err instanceof Error ? err.message : "Failed to load audio feed",
        );
        // A refresh that fails while reels are on screen KEEPS them. They are
        // stale, not absent, and replacing a working feed with an error screen
        // over data already in hand is how a user ends up reading stale reels
        // as current — which is what the old `errorMsg && clips.length === 0`
        // guard did by making the failure invisible instead.
        if (!append) setPhase(clipsRef.current.length > 0 ? "ready" : "failed");
      }
    },
    [applyPage, adoptPage, playClip, currentClip],
  );

  /**
   * The cold-queue countdown and the retry it triggers.
   *
   * Previously `retryCountdown` was set once and never decremented — there was
   * no interval anywhere, so the page read "retrying in 2s" for the whole cold
   * period, which is a countdown that does not count down. And the `setTimeout`
   * had no cleanup, so a tab switch during the wait fired another `GET /feed/`
   * against an unmounted component, on an endpoint that is a destructive
   * `lpop`. Both are handled by the single effect, whose returned cleanup
   * clears the interval and the timeout on unmount and on every re-run.
   *
   * `loadFeed` is deliberately NOT a dependency. It changes identity whenever
   * the player context does, and re-running this effect would restart the wait
   * from zero on every context change — the countdown would never expire. The
   * ref holds the current implementation instead.
   */
  const loadFeedRef = useRef(loadFeed);
  useEffect(() => {
    loadFeedRef.current = loadFeed;
  }, [loadFeed]);

  useEffect(() => {
    if (!cold) return;
    const deadline = Date.now() + cold.waitMs;
    setRetryCountdown(Math.max(1, Math.ceil(cold.waitMs / 1000)));
    const ticker = setInterval(() => {
      setRetryCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, COUNTDOWN_TICK_MS);
    const retry = setTimeout(() => {
      clearInterval(ticker);
      void loadFeedRef.current(cold.attempt + 1, cold.append);
    }, cold.waitMs);
    return () => {
      clearInterval(ticker);
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cold]);

  useEffect(() => {
    void loadFeedRef.current(0);
    // Once per mount, by design. Re-running this whenever `loadFeed` changes
    // would re-issue `GET /feed/` — a destructive `lpop` — on every player
    // context change, and `App.tsx` remounts this page on every tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasMore = !isEndOfFeed(nextCursor, queueHealth, isDegraded);

  /**
   * The page's own next request, for a button the user pressed.
   *
   * A real cursor is followed verbatim, the same rule `Explore.tsx` uses for
   * `/suggestions/`. The `"auto_trigger"` sentinel is NOT a URL, so for it the
   * contract the server described is followed instead: ask again, which is what
   * auto-enqueues the next batch.
   *
   * `hasMore` and `isLoadingMore` are in the guard as well as the dependency
   * list. Without the guard, a second click while page 2 is in flight — the
   * sentinel IntersectionObserver re-arms on every render, so this is
   * reachable without a double click — would pop twenty more ids out of the
   * user's queue and drop ten of them.
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);
    setMoreError(null);
    try {
      const data: FeedResponse =
        nextCursor && nextCursor !== FEED_NEXT_SENTINEL
          ? await apiRequest<FeedResponse>(nextCursor)
          : await feedAPI.getFeed();
      if (isColdResponse(data)) {
        setCold({ waitMs: data.retry_after_ms || COLD_FALLBACK_WAIT_MS, attempt: 0, append: true });
        return;
      }
      adoptPage(data, true);
    } catch (err: unknown) {
      // The reels already on screen stay. Discarding them would turn a failed
      // follow-up into "this feed is empty".
      setMoreError(err instanceof Error ? err.message : "Could not load more reels");
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, nextCursor, adoptPage]);

  /** A page reload, discarding the cached page first. */
  const refresh = useCallback(() => {
    invalidateFeedPageCache();
    void loadFeedRef.current(0);
  }, []);

  /**
   * What the page is saying about the data it is showing, when that is not
   * "here is your feed". A failed refresh must be visible WITHOUT hiding the
   * reels: the user is making like/skip/share decisions on what is on screen.
   */
  const notice = loadError
    ? {
        text: `${loadError} These are the reels that had already loaded, so they may be out of date.`,
        action: refresh,
        actionLabel: "Retry",
      }
    : moreError
      ? {
          text: `${moreError} The reels you already have are unaffected.`,
          // Re-asks for the next page. A full `refresh` here would replace the
          // list with page 1 and silently drop the page the user already read.
          action: () => void loadMore(),
          actionLabel: "Try again",
        }
      : cold
        ? {
            text: `Your next batch is still being prepared. Checking again in ${retryCountdown}s.`,
            action: null,
            actionLabel: "",
          }
        : null;

  if (phase === "cold") {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-[#FF6321]/20 border border-[#FF6321]/40 flex items-center justify-center text-[#FF6321] animate-spin">
          <RefreshCw className="w-8 h-8" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-black uppercase tracking-tight text-white">Preparing your feed…</h2>
          {/*
            The old copy here — "Synthesizing Audio Feed / Populating pgvector
            queue with cosine similarity matrix" — described an internal
            mechanism the response says nothing about. `views/feed.py:91-100`
            returns one fact: the queue is empty and a refill has been queued.
            What is stated now is that fact, plus the server's own retry hint.
          */}
          <p className="text-xs font-mono uppercase text-white/50 max-w-sm">
            Your recommendations are being built — the server asked us to check back in{" "}
            {retryCountdown}s (attempt {(cold?.attempt ?? 0) + 1} of {COLD_RETRY_LIMIT})
          </p>
        </div>
      </div>
    );
  }

  if (phase === "cold-stalled") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-4"
      >
        <div className="w-12 h-12 rounded-2xl bg-[#FF6321]/20 text-[#FF6321] flex items-center justify-center">
          <RefreshCw className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-black uppercase text-white">Still preparing your feed</h2>
          {/*
            NOT "Nothing here yet". After five checks the queue is still cold,
            which is a different fact from "there is nothing for you": the refill
            task holds a 30 s lock (`ai_ml/pipelines/feed_tasks.py:91`) and a
            slow one is exactly what this is. Showing the empty state here told
            a recommender's user that their taste matched nothing.
          */}
          <p className="text-xs text-white/50 max-w-sm mx-auto">
            We checked {COLD_RETRY_LIMIT} times and your queue is still warming up. This is not an
            empty feed — nothing has come back yet.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="px-6 py-2.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
        >
          Check again
        </button>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center text-white/50 space-y-3 font-mono text-xs uppercase">
        <div className="w-10 h-10 border-2 border-[#FF6321] border-t-transparent rounded-full animate-spin" />
        <p>Loading your feed…</p>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-4"
      >
        <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-black uppercase text-white">Couldn't load your feed</h2>
          <p className="text-xs text-white/50">{loadError}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="px-6 py-2.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 md:px-8 py-4 pb-28">
      {/* Degraded mode banner */}
      {isDegraded && (
        <div className="mb-3 p-3 rounded-xl bg-[#FF6321]/15 border border-[#FF6321]/40 text-xs font-mono uppercase text-[#FF6321] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>Cold fallback mode active — Serving trending reels until vector queue warms up</span>
        </div>
      )}

      {/*
        A failed refresh, with the reels still on screen. It used to render
        nothing: the old guard was `errorMsg && clips.length === 0`, so stale
        reels were presented as current and `ReelList`'s error state — and its
        retry — were dead code this file short-circuited before they could run.
        `role="status" aria-live="polite"` is the idiom `ReelCard.tsx:302`
        already uses; `role="alert"` is for content that demands immediate
        interruption, and a feed the user can still browse is not that.
      */}
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="mb-3 p-3 rounded-xl bg-[#111111] border border-rose-500/40 text-xs font-mono uppercase text-rose-400 flex flex-wrap items-center gap-3"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-[12rem] normal-case">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              onClick={notice.action}
              className="px-3 py-1.5 rounded border border-rose-500/50 text-rose-400 font-bold uppercase tracking-wider hover:bg-rose-500/10"
            >
              {notice.actionLabel}
            </button>
          )}
        </div>
      )}

      {/* Top Controls Bar */}
      <div className="flex items-center justify-between gap-3 px-1 mb-3">
        <div className="flex items-center gap-2 text-xs font-mono uppercase text-white/50">
          <Headphones
            className={`w-4 h-4 ${handsFreeMode ? "text-[#FF6321]" : "text-white/50"}`}
            aria-hidden="true"
          />
          {/*
            True now, and true because of a change rather than a reword:
            `ReelList` gates BOTH the viewability autoplay and the
            scroll-advance on `handsFreeMode` (the Header toggle at
            `Header.tsx:182` is the control). With the flag off nothing plays
            by itself and nothing advances. The peer deleting the player-side
            `handleAutoAdvance` is not a precondition for this string.
          */}
          <span>
            {handsFreeMode ? "Hands-Free Auto-advance: ON" : "Manual Navigation Mode"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/*
            A refresh the user can press.
            
            This is the only entry point to a `loadFeed` that can fail while
            reels are on screen, and it is what makes the F12 case reachable by
            a person rather than only by a test: without it the only way back
            into `loadFeed` was the mount and the cold retry, so a failed
            refresh had nowhere to be surfaced from. It also invalidates the
            session page cache, so "refresh" genuinely re-requests instead of
            replaying the same page.
          */}
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] font-mono font-bold uppercase tracking-wider text-white transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={onOpenOnboarding}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] font-mono font-bold uppercase tracking-wider text-white transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#FF6321]" aria-hidden="true" />
            <span>Tune Vector Vibes</span>
          </button>
        </div>
      </div>

      {/* Vertical scroll-snap reel feed with viewability autoplay.
          Replaces the previous two-column "big card + Vector Feed Queue"
          layout: the queue sidebar and its Cosine-Threshold/HNSW-Index footer
          were a desktop-console affordance, and the product is a phone-first
          vertical reel. ReelList also owns autoplay and the auto-advance, which
          the old layout had none of — nothing in src/ used an
          IntersectionObserver, so a clip only played if the user tapped it. */}
      <ReelList
        clips={clips}
        loading={isLoadingMore}
        hasMore={hasMore}
        queueHealth={queueHealth}
        isLoadingMore={isLoadingMore}
        onLoadMore={loadMore}
        onOpenCreatorProfile={onOpenCreatorProfile}
        onOpenComments={setSelectedClipForComments}
        onOpenShare={setSelectedClipForShare}
      />

      {/* Comment Sheet Drawer */}
      <CommentSheet
        clip={selectedClipForComments}
        isOpen={!!selectedClipForComments}
        onClose={() => setSelectedClipForComments(null)}
      />

      {/* Share Modal */}
      <ShareModal
        clip={selectedClipForShare}
        isOpen={!!selectedClipForShare}
        onClose={() => setSelectedClipForShare(null)}
      />
    </div>
  );
};
