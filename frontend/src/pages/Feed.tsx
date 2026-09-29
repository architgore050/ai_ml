import React, { useEffect, useState, useCallback } from "react";
import { Headphones, AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { feedAPI } from "../api/client";
import { usePlayer } from "../stores/player";
import { FeedClip, FeedResponse } from "../types/echoflow";
import { ReelList } from "../components/feed/ReelList";
import { CommentSheet } from "../components/comments/CommentSheet";
import { ShareModal } from "../components/sharing/ShareModal";

interface FeedPageProps {
  onOpenCreatorProfile: (creatorId: number) => void;
  onOpenOnboarding: () => void;
}

export const FeedPage: React.FC<FeedPageProps> = ({ onOpenCreatorProfile, onOpenOnboarding }) => {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isColdPreparing, setIsColdPreparing] = useState<boolean>(false);
  const [retryCountdown, setRetryCountdown] = useState<number>(0);
  const [isDegraded, setIsDegraded] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modals state
  const [selectedClipForComments, setSelectedClipForComments] = useState<FeedClip | null>(null);
  const [selectedClipForShare, setSelectedClipForShare] = useState<FeedClip | null>(null);

  const { currentClip, playClip, setQueue, handsFreeMode } = usePlayer();

  const loadFeed = useCallback(async (retryCount = 0) => {
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const data: FeedResponse = await feedAPI.getFeed();

      // Spec FR-FEED-1: Handle 202 cold queue response
      if (data.retry_after_ms && data.results.length === 0) {
        setIsColdPreparing(true);
        const waitMs = data.retry_after_ms || 1500;
        setRetryCountdown(Math.ceil(waitMs / 1000));

        if (retryCount < 5) {
          setTimeout(() => {
            loadFeed(retryCount + 1);
          }, waitMs);
        } else {
          setIsColdPreparing(false);
          setIsLoading(false);
        }
        return;
      }

      setIsColdPreparing(false);
      setIsDegraded(!!data.degraded);
      setClips(data.results);
      setQueue(data.results);

      // Auto-play the first reel if none playing
      const firstClip = data.results[0];
      if (firstClip && !currentClip) {
        playClip(firstClip, data.results);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to load audio feed");
    } finally {
      setIsLoading(false);
    }
  }, [currentClip, playClip, setQueue]);

  useEffect(() => {
    loadFeed();
    // Feed initialization should happen once for this page. Player callbacks
    // are intentionally not dependencies because they are context actions.
    // Re-running this effect on every provider render causes an update loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isColdPreparing) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-[#FF6321]/20 border border-[#FF6321]/40 flex items-center justify-center text-[#FF6321] animate-spin">
          <RefreshCw className="w-8 h-8" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-black uppercase tracking-tight text-white">Synthesizing Audio Feed...</h2>
          <p className="text-xs font-mono uppercase text-white/40 max-w-sm">
            Populating pgvector queue with cosine similarity matrix (retrying in {retryCountdown}s)
          </p>
        </div>
      </div>
    );
  }

  if (isLoading && clips.length === 0) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center text-white/40 space-y-3 font-mono text-xs uppercase">
        <div className="w-10 h-10 border-2 border-[#FF6321] border-t-transparent rounded-full animate-spin" />
        <p>Loading 384-dimensional audio stream...</p>
      </div>
    );
  }

  if (errorMsg && clips.length === 0) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-black uppercase text-white">Connection Interrupted</h2>
          <p className="text-xs text-white/50">{errorMsg}</p>
        </div>
        <button
          type="button"
          onClick={() => loadFeed(0)}
          className="px-6 py-2.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
        >
          Retry Connection
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

      {/* Top Controls Bar */}
      <div className="flex items-center justify-between px-1 mb-3">
        <div className="flex items-center gap-2 text-xs font-mono uppercase text-white/40">
          <Headphones className={`w-4 h-4 ${handsFreeMode ? "text-[#FF6321]" : "text-white/30"}`} />
          <span>
            {handsFreeMode ? "Hands-Free Auto-advance: ON" : "Manual Navigation Mode"}
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenOnboarding}
          className="flex items-center gap-1.5 px-3 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] font-mono font-bold uppercase tracking-wider text-white transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#FF6321]" />
          <span>Tune Vector Vibes</span>
        </button>
      </div>

      {/* Vertical scroll-snap reel feed with viewability autoplay.
          Replaces the previous two-column "big card + Vector Feed Queue"
          layout: the queue sidebar and its Cosine-Threshold/HNSW-Index footer
          were a desktop-console affordance, and the product is a phone-first
          vertical reel. ReelList also owns autoplay, which the old layout had
          none of — nothing in src/ used an IntersectionObserver, so a clip only
          played if the user tapped it. */}
      <ReelList
        clips={clips}
        loading={isLoading}
        err={errorMsg}
        hasMore={false}
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
