import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Compass, Hash, Heart, Pause, Play, RefreshCw } from "lucide-react";
import { apiRequest, feedAPI } from "../api/client";
import { usePlayer } from "../stores/player";
import { CursorPaginated, FeedClip } from "../types/echoflow";

interface ExplorePageProps {
  onOpenFeed: () => void;
}

const CATEGORIES = [
  { id: "all", label: "All Hubs" },
  { id: "comedy", label: "Comedy & Roasts" },
  { id: "science", label: "Science Bites" },
  { id: "motivation", label: "Motivation" },
  { id: "music", label: "Beat Loops" },
  { id: "quotes", label: "Deep Quotes" },
  { id: "instrumental", label: "Focus Waves" },
];

/**
 * `apiRequest` throws two unrelated shapes: an `Error` carrying `.status` and
 * `.data` when the server answered, and the raw transport error (a
 * `TypeError`) when `fetch` itself rejected. Rendering one sentence for both
 * tells a user on a dead connection to go hunting for a server bug that does
 * not exist — the RECON-04 F15 error-laundering shape. So the failure is
 * classified, not stringified.
 */
type LoadFailure =
  | { kind: "offline" }
  | { kind: "server"; status: number; detail: string };

function classifyFailure(err: unknown): LoadFailure {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") {
    return {
      kind: "server",
      status,
      detail: err instanceof Error ? err.message : "",
    };
  }
  return { kind: "offline" };
}

/**
 * `duration_ms` is the payload's own field (`FeedClipSerializer.Meta.fields`,
 * `serializers.py:395-410`) rendered in m:ss, using the same convention as
 * `ReelCard`'s scrubber. This replaces a fabricated audience count: nothing
 * here is derived from engagement, and nothing is invented.
 */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export const ExplorePage: React.FC<ExplorePageProps> = ({ onOpenFeed: _onOpenFeed }) => {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [clips, setClips] = useState<FeedClip[]>([]);
  /**
   * The server's `next` cursor. `FeedCursorPagination` (`_pagination.py:6`)
   * caps a page at 10, and this used to be discarded — so the page rendered as
   * though it were the whole category. Null means the server has no further
   * page for this query, which is the only thing it is treated as claiming:
   * never as "you have seen everything".
   */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [moreFailure, setMoreFailure] = useState<LoadFailure | null>(null);

  const { currentClip, isPlaying, playClip, togglePlay } = usePlayer();

  /**
   * Guards against a stale response landing after the category changed.
   *
   * Once load-more exists there can be two requests in flight at once — the
   * new category's page 1 and the previous category's page 2 — and they can
   * resolve in either order. Without this, resolving the old one second
   * appends the previous category's clips under the newly selected category.
   * Every fetch captures the generation it belongs to and drops its own
   * results if a newer request has started since.
   */
  const generationRef = useRef(0);

  const loadSuggestions = useCallback(async (cat: string) => {
    const generation = ++generationRef.current;
    setIsLoading(true);
    setFailure(null);
    setMoreFailure(null);
    setNextCursor(null);
    try {
      const res = await feedAPI.getSuggestions(cat);
      if (generation !== generationRef.current) return;
      setClips(res.results);
      setNextCursor(res.next);
    } catch (err: unknown) {
      if (generation !== generationRef.current) return;
      setFailure(classifyFailure(err));
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    const generation = generationRef.current;
    setIsLoadingMore(true);
    setMoreFailure(null);
    try {
      // Follow the server's cursor verbatim. DRF builds `next` with
      // `request.build_absolute_uri()` and `apiRequest` passes absolute URLs
      // through untouched; hand-assembling `?category=…&cursor=…` would
      // re-derive the ordering/category contract the cursor already encodes.
      const res = await apiRequest<CursorPaginated<FeedClip>>(nextCursor);
      if (generation !== generationRef.current) return;
      setClips((prev) => {
        const seen = new Set(prev.map((clip) => clip.id));
        return [...prev, ...res.results.filter((clip) => !seen.has(clip.id))];
      });
      setNextCursor(res.next);
    } catch (err: unknown) {
      if (generation !== generationRef.current) return;
      // The already-loaded page stays on screen. Discarding it would turn a
      // failed follow-up into "this category is empty".
      setMoreFailure(classifyFailure(err));
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore]);

  useEffect(() => {
    void loadSuggestions(selectedCategory);
  }, [selectedCategory, loadSuggestions]);

  const handlePlayClip = (clip: FeedClip) => {
    if (currentClip?.id === clip.id) {
      togglePlay();
    } else {
      playClip(clip, clips);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-8 py-6 pb-28 space-y-6">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 border-b border-white/10 pb-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-[#F5F5F5] flex items-center gap-3">
            <Compass className="w-7 h-7 text-[#FF6321]" aria-hidden="true" />
            Explore Hubs
          </h1>
          {/*
            The old line here read "Browse audio reels clustered by semantic
            embeddings and acoustic vectors", next to a
            `CLUSTER_INDEX: PGVECTOR_384D` badge. `views/feed.py:207-222`
            annotates `combined_distance` only when `get_user_vectors(user)`
            returns BOTH vectors and silently falls back to
            `order_by('-engagement_velocity', '-created_at')` otherwise — so a
            cold-start user, the exact population the onboarding modal exists
            for, saw a vector claim over results no vector touched. The badge
            was also wrong when it was true: the ranking blends a 384-dim
            semantic with a 128-dim acoustic vector
            (`models.py:149-150`), and it is a nearest-neighbour query, not
            clustering. The response carries nothing that says which path ran,
            so no client-side derivation is possible: the mechanism claim is
            deleted rather than reworded.

            The `<h1>` said "Vector Hubs" for the same reason — it is the
            largest text on the page and the loudest mechanism claim of all.
            "Hubs" is the product's own word for these categories (it is
            already every label in CATEGORIES below), so only "Vector" went.
          */}
          <p className="text-xs font-mono uppercase tracking-wider text-white/60 mt-1">
            Ranked for you
          </p>
        </div>
      </div>

      {/* Category Pills Slider */}
      {/*
        Selection used to be signalled by background/border colour alone
        (WCAG 1.4.1). `aria-pressed` carries the state programmatically and
        the check glyph carries it visually, so neither depends on hue.
      */}
      <div
        role="group"
        aria-label="Browse categories"
        className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4"
      >
        {CATEGORIES.map((cat) => {
          const isSelected = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              aria-pressed={isSelected}
              className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider whitespace-nowrap transition-all border inline-flex items-center gap-1.5 ${
                isSelected
                  ? "bg-[#FF6321] text-black border-[#FF6321] shadow-[0_0_15px_rgba(255,99,33,0.3)]"
                  : "bg-white/5 text-white/60 hover:text-white border-white/10 hover:bg-white/10"
              }`}
            >
              {isSelected && <Check className="w-3 h-3" aria-hidden="true" />}
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Content Grid */}
      {isLoading ? (
        <div
          role="status"
          className="py-24 flex flex-col items-center justify-center text-white/60 font-mono text-xs uppercase gap-2"
        >
          <div
            className="w-8 h-8 border-2 border-[#FF6321] border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
          <span>Loading hubs...</span>
        </div>
      ) : failure ? (
        <div
          role="alert"
          className="p-6 rounded-2xl bg-[#111111] border border-rose-500/40 text-center space-y-3"
        >
          <AlertTriangle className="w-8 h-8 mx-auto text-rose-400" aria-hidden="true" />
          <p className="text-sm font-black uppercase text-white">
            {failure.kind === "offline"
              ? "Can't reach EchoFlow"
              : `EchoFlow returned an error (${failure.status})`}
          </p>
          <p className="text-xs font-mono text-white/60">
            {failure.kind === "offline"
              ? "The request never completed. Check your connection, then try again."
              : failure.detail || "The server could not return suggestions."}
          </p>
          {/*
            The old error branch rendered the raw message in a bare div with
            no way out — recovery meant unmounting the page by switching tabs
            (RECON-04 F22). This button is that way out.
          */}
          <button
            type="button"
            onClick={() => void loadSuggestions(selectedCategory)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider hover:bg-[#ff753b] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : clips.length === 0 ? (
        <div className="p-12 rounded-3xl bg-[#111111] border border-white/10 text-center text-white/60 text-xs uppercase font-mono">
          No audio reels in this category.
        </div>
      ) : (
        <>
          {/*
            The grid was `<div onClick>` with a `<div>` play affordance inside
            it: not one keyboard-reachable or exposed control on the page
            (RECON-06 finding #5). It is now a list whose items each expose two
            real buttons. The play control is a sibling of the info block
            rather than a descendant — a `<button>` inside a `<button>` is
            invalid and, worse, only the inner one is reachable.
          */}
          <ul role="list" className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {clips.map((clip) => {
              const isThisPlaying = currentClip?.id === clip.id && isPlaying;
              const isThisSelected = currentClip?.id === clip.id;

              return (
                <li
                  key={clip.id}
                  className={`p-5 rounded-2xl border transition-all flex items-center gap-4 group ${
                    isThisSelected
                      ? "bg-[#111111] border-[#FF6321] shadow-[0_0_20px_rgba(255,99,33,0.15)] ring-1 ring-[#FF6321]"
                      : "bg-[#111111]/80 hover:bg-[#111111] border-white/10 hover:border-white/25"
                  }`}
                >
                  {/* Play Button */}
                  <button
                    type="button"
                    onClick={() => handlePlayClip(clip)}
                    aria-label={`${isThisPlaying ? "Pause" : "Play"} ${clip.title}`}
                    className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform ${
                      isThisPlaying
                        ? "bg-[#FF6321] text-black scale-105 shadow-[0_0_15px_rgba(255,99,33,0.35)]"
                        : "bg-white/10 text-white group-hover:bg-[#FF6321] group-hover:text-black"
                    }`}
                  >
                    {isThisPlaying ? (
                      <Pause className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                      <Play className="w-5 h-5 fill-current ml-0.5" aria-hidden="true" />
                    )}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] uppercase font-black tracking-widest text-[#FF6321] px-1.5 py-0.2 rounded bg-[#FF6321]/15">
                        {clip.category}
                      </span>
                      <span className="text-[10px] font-mono uppercase text-white/60 truncate">
                        @{clip.creator_name}
                      </span>
                    </div>
                    {/*
                      `<h3>` directly under the page `<h1>` skipped a level
                      (1.3.1). The grid is a section of the page, so its items
                      are `<h2>` — and the title itself is the second button,
                      which keeps the whole title row clickable as before.
                    */}
                    <h2 className="text-sm font-black uppercase tracking-tight text-white leading-snug line-clamp-2">
                      <button
                        type="button"
                        onClick={() => handlePlayClip(clip)}
                        className="inline-block w-full text-left hover:text-[#FF6321] transition-colors"
                      >
                        {clip.title}
                      </button>
                    </h2>

                    <div className="flex items-center gap-4 text-[10px] font-mono uppercase text-white/60 mt-2">
                      <span className="flex items-center gap-1">
                        <Heart className="w-3 h-3 text-[#FF6321]" aria-hidden="true" />
                        {clip.likes}
                      </span>
                      {/*
                        Replaces `{Math.max(15, clip.likes + clip.shares * 2)} Listens`.
                        There is no view or listen counter anywhere —
                        `AudioClip` (`models.py:108-171`) has likes, shares,
                        skips, comment_count, avg_completion_rate and
                        engagement_velocity, and
                        `grep listen_count|view_count|play_count|total_plays backend/`
                        returns nothing. The old floor asserted a minimum
                        audience for a clip with zero engagement. Both values
                        below are the payload's own; neither is derived.
                      */}
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" aria-hidden="true" />
                        {formatDuration(clip.duration_ms)}
                      </span>
                      {clip.tags.length > 0 && (
                        <span className="flex items-center gap-1 min-w-0">
                          <Hash className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                          <span className="truncate">{clip.tags.join(" · ")}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col items-center gap-3 pt-2">
            {moreFailure && (
              <div
                role="alert"
                className="w-full rounded-xl border border-rose-500/40 bg-[#111111] px-4 py-3 text-center text-xs font-mono text-rose-400"
              >
                {moreFailure.kind === "offline"
                  ? "Couldn't reach EchoFlow to load more."
                  : `Couldn't load more (${moreFailure.status}).`}
              </div>
            )}
            {nextCursor ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
                className="px-6 py-2.5 rounded-xl border border-white/15 bg-[#111111] text-[#F5F5F5] text-xs font-black uppercase tracking-wider hover:border-[#FF6321] hover:text-[#FF6321] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isLoadingMore ? "Loading..." : "Load more"}
              </button>
            ) : (
              <p className="text-[10px] font-mono uppercase text-white/60">
                End of results for this category
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
};
