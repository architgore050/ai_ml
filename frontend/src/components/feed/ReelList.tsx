import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { FeedClip } from "../../types/echoflow";
import { usePlayer } from "../../stores/player";
import { ReelCard } from "./ReelCard";

interface Props {
  clips: FeedClip[];
  loading: boolean;
  hasMore: boolean;
  /**
   * `llen(user_feed:{user_id})`, read by the server AFTER the destructive
   * `lpop` (`views/feed.py:103`) — how many clips are still queued for this
   * user. `null` when the server did not say (a 202 cold response, or the
   * degraded fallback where the Redis read itself failed).
   */
  queueHealth?: number | null;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onOpenCreatorProfile: (creatorId: number) => void;
  onOpenComments: (clip: FeedClip) => void;
  onOpenShare: (clip: FeedClip) => void;
}

/** Viewport height minus the header + bottom-nav allowance. */
const ITEM_HEIGHT = "calc(100vh - 156px)";
/** Ported from sample_frontend2. Comfortably above the 0.5 threshold that makes
 *  a reel flip mid-watch on a phone with a system scrollbar. */
const AUTOPLAY_THRESHOLD = 0.6;
/** Pacing: hold a beat after the clip finishes before advancing, so
 *  auto-advance does not feel like a skip. */
const ADVANCE_DELAY_MS = 1000;

/**
 * `scroll-behavior` is `smooth` globally (`tokens.css:163`) and the two calls
 * below ask for it explicitly, which is 2.2.2 "Animation from Interactions"
 * (WCAG A) failing for anyone who has asked their OS to stop moving things.
 *
 * This is only the half of RECON-06 #17 that lives in this file — the global
 * `html { scroll-behavior: smooth }` and the seven keyframe animations in
 * `tokens.css` are a single app-wide pass, and are not touched here. Read once
 * per call rather than subscribing, so a mid-session change to the OS setting
 * is picked up without a listener.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Vertical scroll-snap feed with viewability-driven autoplay.
 *
 * Ported from sample_frontend2/src/components/feed/ReelList.tsx (preserved in
 * git as 20451d3). This is the core product interaction and the previous
 * frontend had no autoplay at all — no IntersectionObserver anywhere in src/,
 * so a clip only ever played because the user tapped it.
 *
 * Adapted for the target: `FeedClip` instead of the source's `AudioClip`,
 * `currentClip`/`playClip` instead of `active`/`play`.
 *
 * The source declared a `retry` prop that its own signature dropped, so error
 * retry was always a full page reload. There is no `retry`/`err` prop here any
 * more either: the component that owns the request (`Feed.tsx`) owns both the
 * error surface and the retry, so a failure can never be invisible here (it
 * used to be — `Feed.tsx` short-circuited on `errorMsg && clips.length === 0`
 * before this file's `ListError` could ever render, making it dead code).
 */
export function ReelList({
  clips,
  loading,
  hasMore,
  queueHealth = null,
  isLoadingMore = false,
  onLoadMore,
  onOpenCreatorProfile,
  onOpenComments,
  onOpenShare,
}: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hintId = useId();
  const { currentClip, progress, playClip, handsFreeMode } = usePlayer();
  const currentClipRef = useRef<string | undefined>(currentClip?.id);
  useEffect(() => {
    currentClipRef.current = currentClip?.id;
  }, [currentClip?.id]);

  /**
   * What the feed just did, in words.
   *
   * `scrollIntoView` moves the viewport and nothing else, and each card is a
   * fresh subtree across clips (`key={clip.id}` below), so a keyboard user who
   * tabbed to a control inside the card that just finished had that focus
   * destroyed and dropped to `<body>` — mid-card, with no announcement and no
   * way to tell which reel had started. One polite live region, matching the
   * `role="status" aria-live="polite"` idiom `ReelCard` already uses for its
   * like/follow failures.
   */
  const [announcement, setAnnouncement] = useState("");

  /**
   * Move to a reel, deliberately.
   *
   * Focus follows the viewport because a `role="group"` + `tabIndex={-1}`
   * wrapper can receive focus without joining the tab order, and the
   * announcement says which reel arrived so the change is not silent. Held in a
   * ref so the auto-advance effect below can depend on `clips` without
   * restarting its one-second delay on every render.
   */
  const focusReel = useCallback(
    (index: number, reason: "auto-advance" | "keyboard") => {
      const el = itemRefs.current[index];
      const clip = clips[index];
      if (!el || !clip) return;
      el.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
      });
      el.focus({ preventScroll: true });
      setAnnouncement(
        reason === "auto-advance"
          ? `Next reel, ${index + 1} of ${clips.length}: ${clip.title}`
          : `Reel ${index + 1} of ${clips.length}: ${clip.title}`,
      );
    },
    [clips],
  );
  const focusReelRef = useRef(focusReel);
  useEffect(() => {
    focusReelRef.current = focusReel;
  });

  // Pagination sentinel — separate observer from autoplay so that fetching the
  // next page can never start a clip.
  useEffect(() => {
    if (!sentinelRef.current || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting && hasMore && !loading) onLoadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [clips.length, hasMore, loading, onLoadMore]);

  // Autoplay the most-visible reel.
  useEffect(() => {
    if (!clips.length) return;
    // `handsFreeMode` off means nothing plays until the user asks for it. The
    // observer was ungated, so the flag the Header toggle sets
    // (`Header.tsx:182`) controlled nothing at all on the feed, and
    // `Feed.tsx`'s "Manual Navigation Mode" string was a false statement
    // (RECON-06 #14).
    if (!handsFreeMode) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const index = Number((entry.target as HTMLElement).dataset.index);
          const clip = clips[index];
          // Guard on id, not on isPlaying: several entries can intersect in one
          // callback, and each playClip would restart the source.
          if (clip && currentClipRef.current !== clip.id) {
            playClip(clip, clips);
          }
        });
      },
      { threshold: AUTOPLAY_THRESHOLD },
    );
    itemRefs.current.forEach((ref) => ref && observer.observe(ref));
    return () => observer.disconnect();
  }, [clips, playClip, handsFreeMode]);

  // Auto-advance on completion. The one and only advance trigger on this path.
  useEffect(() => {
    if (!handsFreeMode) return;
    if (!currentClip || progress < 0.99) return;
    const index = clips.findIndex((c) => c.id === currentClip.id);
    if (index < 0 || index >= clips.length - 1) return;
    const timer = setTimeout(
      () => focusReelRef.current(index + 1, "auto-advance"),
      ADVANCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [currentClip, progress, clips, handsFreeMode]);

  /**
   * Reel-to-reel keyboard navigation.
   *
   * The scroll container was a bare `<div className="overflow-y-auto">` with
   * no `tabIndex`, no `role` and no key handler, so it was not in the tab
   * order: arrow keys, PageUp/PageDown, Home and End did nothing, and
   * `.scrollbar-hide` (`tokens.css:263-269`) had removed the visual position
   * indicator too. The only way to reach reel 2 was to tab through all ~11
   * controls of reel 1, with the reel changing as a side effect of tabbing.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = clips.length - 1;
    if (last < 0) return;
    const focused = itemRefs.current.findIndex((el) => el === document.activeElement);
    const from = focused < 0 ? 0 : focused;
    let target: number;
    switch (event.key) {
      case "ArrowDown":
      case "PageDown":
        target = Math.min(last, from + 1);
        break;
      case "ArrowUp":
      case "PageUp":
        target = Math.max(0, from - 1);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusReel(target, "keyboard");
  };

  if (!clips.length) {
    return <ListEmpty hasMore={hasMore} isLoadingMore={isLoadingMore} onLoadMore={onLoadMore} />;
  }

  const endOfFeed = (
    <div
      className="flex flex-col items-center gap-3 text-center"
      style={{ flex: "0 0 100%", padding: 24 }}
    >
      {hasMore && onLoadMore ? (
        <>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="px-6 py-2.5 rounded-xl border border-white/15 bg-[#111111] text-[#F5F5F5] text-xs font-black uppercase tracking-wider hover:border-[#FF6321] hover:text-[#FF6321] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isLoadingMore ? "Loading..." : "Load more reels"}
          </button>
          {queueHealth !== null && queueHealth > 0 && (
            <p className="text-[10px] font-mono uppercase text-white/50">
              {queueHealth} more reel{queueHealth === 1 ? "" : "s"} queued for you
            </p>
          )}
        </>
      ) : (
        // Reached only when the server says this is the end: a response with
        // no `next`, or `queue_health` of 0 on a non-degraded page. It used to
        // be rendered on every feed, unconditionally, from a hardcoded
        // `hasMore={false}`.
        <p
          role="status"
          aria-live="polite"
          className="text-center uppercase text-white/50"
          style={{ fontSize: 11, letterSpacing: "0.08em" }}
        >
          All caught up
        </p>
      )}
    </div>
  );

  return (
    <>
      <div
        role="region"
        aria-label="Reel feed"
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="scrollbar-hide flex flex-col overflow-y-auto mx-auto w-full"
        style={{ height: ITEM_HEIGHT, scrollSnapType: "y mandatory", maxWidth: "var(--content-max)" }}
      >
        {clips.map((clip, i) => (
          <div
            key={clip.id}
            data-index={i}
            tabIndex={-1}
            role="group"
            aria-label={`Reel ${i + 1} of ${clips.length}: ${clip.title}`}
            ref={(el) => {
              itemRefs.current[i] = el;
              // Arm the pagination sentinel one item from the end.
              if (i === clips.length - 2) sentinelRef.current = el;
            }}
            className="flex items-center justify-center relative"
            style={{
              flex: `0 0 ${ITEM_HEIGHT}`,
              minHeight: ITEM_HEIGHT,
              scrollSnapAlign: "center",
            }}
          >
            <ReelCard
              clip={clip}
              isActive={currentClip?.id === clip.id}
              onOpenComments={onOpenComments}
              onOpenShare={onOpenShare}
              onCreatorClick={onOpenCreatorProfile}
            />
          </div>
        ))}

        {loading && (
          <div className="flex items-center justify-center" style={{ flex: `0 0 ${ITEM_HEIGHT}` }}>
            <div className="skeleton h-1 w-3/5" />
          </div>
        )}

        {endOfFeed}
      </div>

      <p id={hintId} className="sr-only">
        Reel feed. Use the up and down arrow keys, Page Up and Page Down, or Home and End to move
        between reels. Reels play automatically while hands-free mode is on.
      </p>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

/**
 * A genuinely empty feed, and the one state that says so.
 *
 * Distinct from a cold queue, which the caller owns: five exhausted retries
 * render an explicit "still preparing" screen, because telling a recommender's
 * user that there is nothing here when the queue is merely cold is the single
 * most damaging wrong conclusion this page can show. `role="status"` copies
 * the idiom at `ReelCard.tsx:302` — the states below announce nothing at all
 * before this.
 */
function ListEmpty({
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-4 text-center"
      style={{ padding: "64px 24px" }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 64,
          height: 64,
          borderRadius: "var(--radius-full)",
          background: "var(--surface-container)",
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth="2"
        >
          <path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v2" />
        </svg>
      </div>
      <p
        style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700 }}
      >
        Nothing here yet
      </p>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 220, lineHeight: 1.5 }}>
        Check back soon for fresh audio reels
      </p>
      {hasMore && onLoadMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          className="px-6 py-2.5 rounded-xl border border-white/15 bg-[#111111] text-[#F5F5F5] text-xs font-black uppercase tracking-wider hover:border-[#FF6321] hover:text-[#FF6321] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isLoadingMore ? "Loading..." : "Load more reels"}
        </button>
      )}
    </div>
  );
}
