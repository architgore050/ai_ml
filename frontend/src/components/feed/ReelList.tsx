import { useCallback, useEffect, useRef } from "react";
import { FeedClip } from "../../types/echoflow";
import { usePlayer } from "../../stores/player";
import { ReelCard } from "./ReelCard";

interface Props {
  clips: FeedClip[];
  loading: boolean;
  err: string | null;
  hasMore: boolean;
  loadMore?: () => void;
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
 * Vertical scroll-snap feed with viewability-driven autoplay.
 *
 * Ported from sample_frontend2/src/components/feed/ReelList.tsx (preserved in
 * git as 20451d3). This is the core product interaction and the previous
 * frontend had no autoplay at all — no IntersectionObserver anywhere in src/,
 * so a clip only ever played because the user tapped it.
 *
 * Adapted for the target: `FeedClip` instead of the source's `AudioClip`,
 * `currentClip`/`playClip` instead of `active`/`play`, and the retry prop is
 * honoured rather than shadowed (the source declared a `retry` prop that its
 * own signature dropped, so error retry was always a full page reload).
 */
export function ReelList({
  clips,
  loading,
  err,
  hasMore,
  loadMore,
  onOpenCreatorProfile,
  onOpenComments,
  onOpenShare,
}: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { currentClip, progress, playClip } = usePlayer();
  const currentClipRef = useRef<string | undefined>(currentClip?.id);
  useEffect(() => {
    currentClipRef.current = currentClip?.id;
  }, [currentClip?.id]);

  const retry = useCallback(() => window.location.reload(), []);

  // Pagination sentinel — separate observer from autoplay so that fetching the
  // next page can never start a clip.
  useEffect(() => {
    if (!sentinelRef.current || !loadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting && hasMore && !loading) loadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [clips.length, hasMore, loading, loadMore]);

  // Autoplay the most-visible reel.
  useEffect(() => {
    if (!clips.length) return;
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
  }, [clips, playClip]);

  // Auto-advance on completion.
  useEffect(() => {
    if (!currentClip || progress < 0.99) return;
    const index = clips.findIndex((c) => c.id === currentClip.id);
    if (index < 0 || index >= clips.length - 1) return;
    const timer = setTimeout(() => {
      itemRefs.current[index + 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [currentClip, progress, clips]);

  if (err && !clips.length) return <ListError message={err} onRetry={retry} />;
  if (!loading && !clips.length) return <ListEmpty />;

  return (
    <div
      className="scrollbar-hide flex flex-col overflow-y-auto mx-auto w-full"
      style={{ height: ITEM_HEIGHT, scrollSnapType: "y mandatory", maxWidth: "var(--content-max)" }}
    >
      {clips.map((clip, i) => (
        <div
          key={clip.id}
          data-index={i}
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

      {!hasMore && clips.length > 0 && (
        <p
          className="text-center uppercase"
          style={{
            flex: "0 0 100%",
            color: "var(--text-tertiary)",
            fontSize: 11,
            letterSpacing: "0.08em",
            padding: 24,
          }}
        >
          All caught up
        </p>
      )}
    </div>
  );
}

function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 text-center"
      style={{ padding: "56px 24px" }}
    >
      <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>{message}</p>
      <button
        onClick={onRetry}
        className="border-none cursor-pointer font-bold"
        style={{
          padding: "8px 20px",
          borderRadius: "var(--radius-full)",
          fontSize: 13,
          background: "var(--accent)",
          color: "#000",
        }}
      >
        Retry
      </button>
    </div>
  );
}

function ListEmpty() {
  return (
    <div
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
    </div>
  );
}
