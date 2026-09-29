import React, { useState } from "react";
import {
  Heart,
  MessageSquare,
  Share2,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  SkipForward,
  UserPlus,
  UserCheck,
  Gauge,
  Activity,
} from "lucide-react";
import { followAPI, interactionsAPI } from "../../api/client";
import { useAuth } from "../../stores/auth";
import { usePlayer } from "../../stores/player";
import { FeedClip } from "../../types/echoflow";

interface ReelCardProps {
  clip: FeedClip;
  isActive: boolean;
  onOpenComments: (clip: FeedClip) => void;
  onOpenShare: (clip: FeedClip) => void;
  onCreatorClick?: (creatorId: number) => void;
}

export const ReelCard: React.FC<ReelCardProps> = ({
  clip,
  isActive,
  onOpenComments,
  onOpenShare,
  onCreatorClick,
}) => {
  const { user } = useAuth();
  const {
    isPlaying,
    currentClip,
    playClip,
    togglePlay,
    progress,
    currentTime,
    duration,
    seek,
    skipForward,
    skipBackward,
    nextClip,
    playbackRate,
    setRate,
    audioFrequencies,
  } = usePlayer();

  const [isLiked, setIsLiked] = useState<boolean>(clip.is_liked);
  const [likesCount, setLikesCount] = useState<number>(clip.likes);
  const [isFollowing, setIsFollowing] = useState<boolean>(false);
  const [isLikePending, setIsLikePending] = useState<boolean>(false);

  const isCurrentPlaying = isActive && currentClip?.id === clip.id && isPlaying;
  const isSelf = user?.id === clip.creator_id;

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLikePending) return;

    // Optimistic toggle
    const nextLiked = !isLiked;
    setIsLiked(nextLiked);
    setLikesCount((prev) => (nextLiked ? prev + 1 : Math.max(0, prev - 1)));
    setIsLikePending(true);

    try {
      const res = await interactionsAPI.toggleLike(clip.id);
      setIsLiked(res.status === "liked");
    } catch (err) {
      setIsLiked(!nextLiked);
      setLikesCount((prev) => (!nextLiked ? prev + 1 : Math.max(0, prev - 1)));
    } finally {
      setIsLikePending(false);
    }
  };

  const handleFollowToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSelf) return;

    try {
      const res = await followAPI.toggleFollow(clip.creator_id);
      setIsFollowing(res.status === "followed");
    } catch (err) {
      console.warn("Follow toggle failed:", err);
    }
  };

  const handlePlayCard = () => {
    if (currentClip?.id === clip.id) {
      togglePlay();
    } else {
      playClip(clip);
    }
  };

  const cycleSpeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    const speeds = [1, 1.25, 1.5, 2];
    const nextIndex = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    setRate(speeds[nextIndex] ?? 1);
  };

  const formatTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  // Generate pseudorandom vector hash string based on clip ID
  const shortId = clip.id.replace(/-/g, "").slice(0, 8).toUpperCase();
  const vectorStr = `v[0.${((clip.likes * 13) % 89 + 10)}, -0.${((clip.shares * 19) % 79 + 10)}, 0.99]`;
  const similarityScore = (0.92 + (clip.likes % 7) * 0.01).toFixed(3);

  // Split title to apply stylized bold color highlight on key word
  const titleWords = clip.title.split(" ");
  const lastWord = titleWords.pop() || "";
  const mainTitle = titleWords.join(" ");

  return (
    <div
      onClick={handlePlayCard}
      className="relative w-full min-h-[580px] max-h-[720px] rounded-2xl md:rounded-3xl bg-[#0A0A0A] border border-white/10 shadow-2xl overflow-hidden flex flex-col justify-between p-6 md:p-8 select-none cursor-pointer transition-all hover:border-white/20"
    >
      {/* Top Header: Category Tag & Vector Metadata */}
      <div className="flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <span className="px-3 py-1 bg-[#FF6321] text-black text-[10px] font-black uppercase tracking-wider rounded">
            {clip.category}
          </span>
          <span className="text-[10px] font-mono uppercase text-white/40">
            CLIP_ID: EF-{shortId}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Speed Toggle */}
          <button
            type="button"
            onClick={cycleSpeed}
            className="px-2.5 py-1 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition-colors"
            title="Toggle Playback Speed"
          >
            <Gauge className="w-3 h-3 text-[#FF6321]" />
            <span>{playbackRate}X</span>
          </button>
        </div>
      </div>

      {/* Creator Bar */}
      <div className="flex items-center justify-between z-10 pt-2">
        <div
          onClick={(e) => {
            e.stopPropagation();
            onCreatorClick?.(clip.creator_id);
          }}
          className="flex items-center gap-2.5 group/creator"
        >
          <div className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center font-black text-xs text-[#FF6321]">
            {clip.creator_name[0]?.toUpperCase()}
          </div>
          <span className="text-xs font-black uppercase tracking-wider text-white group-hover/creator:text-[#FF6321] transition-colors">
            @{clip.creator_name}
          </span>
        </div>

        {!isSelf && (
          <button
            type="button"
            onClick={handleFollowToggle}
            className={`px-3 py-1 rounded text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${
              isFollowing
                ? "bg-white/10 text-white/50 border border-white/10"
                : "bg-white/10 hover:bg-[#FF6321] hover:text-black text-white border border-white/20"
            }`}
          >
            {isFollowing ? (
              <>
                <UserCheck className="w-3 h-3 text-[#FF6321]" />
                Following
              </>
            ) : (
              <>
                <UserPlus className="w-3 h-3" />
                Follow
              </>
            )}
          </button>
        )}
      </div>

      {/* Center Display: Giant Bold Typography Headline & Audio Waveform */}
      <div className="my-auto py-4 z-10">
        {/* Massive Bold Headline with Italic Accent */}
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase italic tracking-tighter leading-[0.9] text-[#F5F5F5] mb-4">
          {mainTitle}{" "}
          <span className="text-[#FF6321] not-italic">{lastWord}</span>
        </h1>

        {/* Dynamic Architectural Audio Waveform Bars */}
        <div className="flex items-end gap-1 sm:gap-1.5 h-20 md:h-24 w-full my-3 px-1">
          {audioFrequencies.map((freq, idx) => {
            const isPeak = idx % 4 === 0;
            const barHeight = isCurrentPlaying
              ? Math.max(12, Math.min(100, (freq / 75) * 100))
              : ((idx * 17) % 65) + 20;

            const isAccent = isCurrentPlaying && (idx === 3 || idx === 4 || idx === 9 || idx === 10);

            return (
              <div
                key={idx}
                className={`flex-1 transition-all duration-75 ${
                  isAccent
                    ? "bg-[#FF6321]"
                    : isCurrentPlaying
                    ? idx % 2 === 0
                      ? "bg-white/60"
                      : "bg-white/30"
                    : isPeak
                    ? "bg-white/30"
                    : "bg-white/10"
                }`}
                style={{ height: `${barHeight}%` }}
              />
            );
          })}
        </div>

        {/* Transcript / Sound Bite Quote with bold accent border */}
        <p className="text-xs sm:text-sm font-medium text-white/60 max-w-lg border-l-4 border-[#FF6321] pl-4 my-2 leading-relaxed">
          &ldquo;Sound travels without pixels. Listen attentively as the vector engine streams pure lossless thought.&rdquo;
        </p>

        {/* Acoustic Vector Telemetry Strip */}
        <div className="hidden sm:flex items-center gap-6 pt-3 mt-3 border-t border-white/10 text-[10px] font-mono uppercase">
          <div className="flex flex-col">
            <span className="text-white/30 font-bold mb-0.5">Acoustic Vector</span>
            <span className="text-white/80">{vectorStr}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white/30 font-bold mb-0.5">Similarity Score</span>
            <span className="text-white/80">{similarityScore} Match</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white/30 font-bold mb-0.5">HLS Stream</span>
            <span className="text-green-400 font-bold">192kbps ABR</span>
          </div>
        </div>
      </div>

      {/* Bottom Stage: Scrubber, Play Controls & Social */}
      <div className="w-full z-10 pt-2 border-t border-white/10">
        {/* Scrubber Bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between text-[10px] font-mono text-white/40 mb-1">
            <span>{formatTime(isActive && currentClip?.id === clip.id ? currentTime : 0)}</span>
            <span>{formatTime(isActive && currentClip?.id === clip.id ? duration : clip.duration_ms / 1000)}</span>
          </div>

          <div
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const clickPos = (e.clientX - rect.left) / rect.width;
              seek(clickPos * (duration || clip.duration_ms / 1000));
            }}
            className="h-1.5 w-full bg-white/10 cursor-pointer overflow-hidden rounded-full"
          >
            <div
              className="h-full bg-[#FF6321] transition-all duration-150"
              style={{
                width: `${
                  isActive && currentClip?.id === clip.id
                    ? Math.min(100, Math.max(0, progress * 100))
                    : 0
                }%`,
              }}
            />
          </div>
        </div>

        {/* Main Controls Row */}
        <div className="flex items-center justify-between">
          {/* Earphone skip buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                skipBackward(10);
              }}
              className="w-10 h-10 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 flex items-center justify-center transition-colors"
              title="Skip -10s"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* Huge Orange Play Button from Design Spec */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePlayCard();
              }}
              className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#FF6321] text-black flex items-center justify-center shadow-[0_0_25px_rgba(255,99,33,0.35)] hover:scale-105 active:scale-95 transition-transform"
              title="Play / Pause Reel"
            >
              {isCurrentPlaying ? (
                <Pause className="w-6 h-6 md:w-7 md:h-7 fill-black" />
              ) : (
                <Play className="w-6 h-6 md:w-7 md:h-7 fill-black ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                skipForward(10);
              }}
              className="w-10 h-10 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 flex items-center justify-center transition-colors"
              title="Skip +10s"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                nextClip("manual");
              }}
              className="px-3 py-2 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 text-[10px] font-black uppercase tracking-wider flex items-center gap-1 transition-colors"
              title="Next Reel"
            >
              <span>Next</span>
              <SkipForward className="w-3.5 h-3.5 text-[#FF6321]" />
            </button>
          </div>

          {/* Social Engagement Actions */}
          <div className="flex items-center gap-4">
            {/* Like */}
            <button
              type="button"
              onClick={handleLike}
              className="flex flex-col items-center group/btn"
              title="Like Reel"
            >
              <div
                className={`w-9 h-9 rounded-full border flex items-center justify-center transition-all ${
                  isLiked
                    ? "border-[#FF6321] bg-[#FF6321]/20 text-[#FF6321]"
                    : "border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40"
                }`}
              >
                <Heart className={`w-4 h-4 ${isLiked ? "fill-[#FF6321]" : ""}`} />
              </div>
              <span className="text-[10px] font-mono font-bold text-white/60 mt-1">
                {likesCount}
              </span>
            </button>

            {/* Comment */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenComments(clip);
              }}
              className="flex flex-col items-center group/btn"
              title="Comments"
            >
              <div className="w-9 h-9 rounded-full border border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40 flex items-center justify-center transition-all">
                <MessageSquare className="w-4 h-4" />
              </div>
              <span className="text-[10px] font-mono font-bold text-white/60 mt-1">
                {clip.comment_count}
              </span>
            </button>

            {/* Share */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenShare(clip);
              }}
              className="flex flex-col items-center group/btn"
              title="Share Reel"
            >
              <div className="w-9 h-9 rounded-full border border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40 flex items-center justify-center transition-all">
                <Share2 className="w-4 h-4" />
              </div>
              <span className="text-[10px] font-mono font-bold text-white/60 mt-1">
                {clip.shares}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
