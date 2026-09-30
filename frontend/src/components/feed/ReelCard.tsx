import React, { useEffect, useState } from "react";
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
  const [isFollowing, setIsFollowing] = useState<boolean>(clip.is_following);
  const [isLikePending, setIsLikePending] = useState<boolean>(false);
  const [isFollowPending, setIsFollowPending] = useState<boolean>(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [likeError, setLikeError] = useState<string | null>(null);

  // `duration`/`currentTime` come from the media element and are 0 until the
  // browser has metadata. Until then the card's own `duration_ms` is the only
  // honest length to show — and it is what the scrubber's max has to be, or a
  // not-yet-loaded clip reports a zero-length track.
  const isThisClipLoaded = isActive && currentClip?.id === clip.id;
  const clipDurationSecs = clip.duration_ms / 1000;
  const effectiveDuration = isThisClipLoaded && duration > 0 ? duration : clipDurationSecs;
  const effectivePosition = isThisClipLoaded
    ? Math.min(currentTime, effectiveDuration)
    : 0;

  const isCurrentPlaying = isThisClipLoaded && isPlaying;
  const isSelf = user?.id === clip.creator_id;

  // Cards are keyed by a stable clip.id, so useState(clip.x) is captured once
  // and never re-read. Without this, a feed refresh that updates the server's
  // follow state leaves the button showing the state from first paint. Keyed on
  // the prop itself, so an optimistic local update is not immediately undone.
  useEffect(() => {
    setIsLiked(clip.is_liked);
  }, [clip.is_liked]);

  useEffect(() => {
    setLikesCount(clip.likes);
  }, [clip.likes]);

  useEffect(() => {
    setIsFollowing(clip.is_following);
  }, [clip.is_following]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLikePending) return;

    // Optimistic toggle
    const nextLiked = !isLiked;
    setLikeError(null);
    setIsLiked(nextLiked);
    setLikesCount((prev) => (nextLiked ? prev + 1 : Math.max(0, prev - 1)));
    setIsLikePending(true);

    try {
      const res = await interactionsAPI.toggleLike(clip.id);
      setIsLiked(res.status === "liked");
    } catch (err) {
      setIsLiked(!nextLiked);
      setLikesCount((prev) => (!nextLiked ? prev + 1 : Math.max(0, prev - 1)));
      // Without this the heart silently un-fills and the only signal is the
      // animation the user just watched reverse itself. Same reasoning as the
      // follow failure below: the rollback is invisible unless it is said.
      setLikeError("Could not update like. Try again.");
      console.warn("Like toggle failed:", err);
    } finally {
      setIsLikePending(false);
    }
  };

  const handleFollowToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSelf) return;
    // Without this guard, a double-tap issues two toggles and lands back on
    // the original state — so "Follow" tapped twice silently unfollows. That
    // is the same class of surprise the hydration above exists to remove.
    if (isFollowPending) return;

    const previous = isFollowing;
    setFollowError(null);
    setIsFollowPending(true);
    setIsFollowing(!previous); // optimistic

    try {
      const res = await followAPI.toggleFollow(clip.creator_id);
      setIsFollowing(res.status === "followed");
    } catch (err) {
      setIsFollowing(previous); // roll back
      setFollowError("Could not update follow. Try again.");
      console.warn("Follow toggle failed:", err);
    } finally {
      setIsFollowPending(false);
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

  const seekTo = (seconds: number) => {
    seek(Math.max(0, Math.min(seconds, effectiveDuration)));
  };

  // WAI-ARIA slider pattern. ArrowLeft/Right ±5 s, Home/End to the ends.
  // Up/Down are included because the APG slider maps them to the same
  // increase/decrease as Right/Left — a horizontal-only slider is unusual
  // enough that omitting them is a defect, not a simplification.
  const handleScrubberKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const stepSeconds = 5;
    let target: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        target = effectivePosition + stepSeconds;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        target = effectivePosition - stepSeconds;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = effectiveDuration;
        break;
      default:
        return;
    }
    e.preventDefault();
    // The card behind the scrubber is itself a click target for play/pause;
    // arrow keys must not reach it.
    e.stopPropagation();
    seekTo(target);
  };

  // Split title to apply stylized bold color highlight on key word
  const titleWords = clip.title.split(" ");
  const lastWord = titleWords.pop() || "";
  const mainTitle = titleWords.join(" ");

  const playLabel = isCurrentPlaying ? "Pause reel" : "Play reel";
  // Toggle-button naming: the label names the action, `aria-pressed` carries
  // the state. Changing the label to "Unlike" *and* exposing `aria-pressed`
  // would announce the state twice and contradict the APG convention that a
  // toggle button's label is stable across states.
  const likeLabel = `Like reel, ${likesCount} ${likesCount === 1 ? "like" : "likes"}`;
  const commentLabel = `Comments, ${clip.comment_count} ${
    clip.comment_count === 1 ? "comment" : "comments"
  }`;
  const shareLabel = `Share reel, ${clip.shares} ${clip.shares === 1 ? "share" : "shares"}`;

  return (
    <div
      onClick={handlePlayCard}
      className="relative w-full min-h-[580px] max-h-[720px] rounded-2xl md:rounded-3xl bg-[#0A0A0A] border border-white/10 shadow-2xl overflow-hidden flex flex-col justify-between p-6 md:p-8 select-none cursor-pointer transition-all hover:border-white/20"
    >
      {/* Top Header: Category Tag */}
      <div className="flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <span className="px-3 py-1 bg-[#FF6321] text-black text-[10px] font-black uppercase tracking-wider rounded">
            {clip.category}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Speed Toggle */}
          <button
            type="button"
            onClick={cycleSpeed}
            className="px-2.5 py-1 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition-colors"
            title="Toggle Playback Speed"
            aria-label={`Playback speed, ${playbackRate}x`}
          >
            <Gauge className="w-3 h-3 text-[#FF6321]" aria-hidden="true" />
            <span aria-hidden="true">{playbackRate}X</span>
          </button>
        </div>
      </div>

      {/* Creator Bar */}
      <div className="flex items-center justify-between z-10 pt-2">
        {/* A real button, not a div with a click handler: this is the only
            route from the feed to another creator's profile (Header's avatar
            goes to *your own* profile), so a keyboard or screen-reader user
            had no way to open a profile at all. `stopPropagation` is kept so
            tapping the creator does not also fire the card's play/pause. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreatorClick?.(clip.creator_id);
          }}
          aria-label={`View @${clip.creator_name}'s profile`}
          className="flex items-center gap-2.5 group/creator"
        >
          <span
            aria-hidden="true"
            className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center font-black text-xs text-[#FF6321]"
          >
            {clip.creator_name[0]?.toUpperCase()}
          </span>
          <span className="text-xs font-black uppercase tracking-wider text-white group-hover/creator:text-[#FF6321] transition-colors">
            @{clip.creator_name}
          </span>
        </button>

        {!isSelf && (
          <div className="flex flex-col items-end gap-1">
            {/* `aria-busy` was removed: it means "this region's content is
                updating", not "an action is in flight", so it was describing
                the wrong thing. `disabled` already announces the in-flight
                state, and the button's own text carries the follow state. */}
            <button
              type="button"
              onClick={handleFollowToggle}
              disabled={isFollowPending}
              className={`px-3 py-1 rounded text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                isFollowing
                  ? "bg-white/10 text-white/50 border border-white/10"
                  : "bg-white/10 hover:bg-[#FF6321] hover:text-black text-white border border-white/20"
              } ${isFollowPending ? "opacity-60" : ""}`}
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
            {/* Announced rather than silently swallowed. There is no global
                toast in this app, and a follow that silently fails looks
                identical to one that succeeded. */}
            <span
              role="status"
              aria-live="polite"
              className="text-[9px] font-bold uppercase tracking-wider text-red-400"
            >
              {followError ?? ""}
            </span>
          </div>
        )}
      </div>

      {/* Center Display: Giant Bold Typography Headline & Audio Waveform */}
      <div className="my-auto py-4 z-10">
        {/* h2, not h1. The feed renders N of these, so an h1 per card meant the
            page had N competing top-level headings and none of its own.
            `Feed.tsx:85,110` already use h2 for this route's loading and error
            states, so h2 also keeps the card from skipping a level once a
            page-level h1 is added upstream. */}
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase italic tracking-tighter leading-[0.9] text-[#F5F5F5] mb-4">
          {mainTitle}{" "}
          <span className="text-[#FF6321] not-italic">{lastWord}</span>
        </h2>

        {/* Decorative bars. There is no AnalyserNode in the player store — the
            heights are a deterministic envelope — so this is ornament, and it
            is hidden from assistive tech rather than announced as a spectrum.
            The orange "peak" bars are gone for the same reason: they implied a
            measured signal that does not exist. The 60 fps redraw that drives
            them comes from the rAF loop in stores/player.tsx, not from here. */}
        <div
          className="flex items-end gap-1 sm:gap-1.5 h-20 md:h-24 w-full my-3 px-1"
          aria-hidden="true"
        >
          {audioFrequencies.map((freq, idx) => {
            const barHeight = isCurrentPlaying
              ? Math.max(12, Math.min(100, (freq / 75) * 100))
              : ((idx * 17) % 65) + 20;

            return (
              <div
                key={idx}
                className={`flex-1 transition-all duration-75 ${
                  isCurrentPlaying
                    ? idx % 2 === 0
                      ? "bg-white/60"
                      : "bg-white/30"
                    : idx % 4 === 0
                    ? "bg-white/30"
                    : "bg-white/10"
                }`}
                style={{ height: `${barHeight}%` }}
              />
            );
          })}
        </div>

        {/* Real clip facts. This block replaces a quote-marked paragraph
            styled as a transcript (a hardcoded string, identical on every
            clip — no transcript field exists) and an "Acoustic Vector /
            Similarity Score / HLS Stream" strip whose values were arithmetic
            on `likes` and `shares` plus a bitrate claim for a single-variant
            128 kbps encode. `tags` and `duration_ms` are both in
            FeedClipSerializer and both were rendered nowhere. */}
        <div className="hidden sm:flex flex-wrap items-center gap-x-6 gap-y-1 pt-3 mt-3 border-t border-white/10 text-[10px] font-mono uppercase">
          <span className="flex items-baseline gap-1.5">
            <span className="text-white/40 font-bold">Duration</span>
            <span className="text-white/80">{formatTime(effectiveDuration)}</span>
          </span>
          {clip.tags.length > 0 && (
            <span className="flex items-baseline gap-1.5">
              <span className="text-white/40 font-bold">Tags</span>
              <span className="text-white/80">{clip.tags.join(" · ")}</span>
            </span>
          )}
        </div>
      </div>

      {/* Bottom Stage: Scrubber, Play Controls & Social */}
      <div className="w-full z-10 pt-2 border-t border-white/10">
        {/* Scrubber Bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between text-[10px] font-mono text-white/40 mb-1">
            <span>{formatTime(effectivePosition)}</span>
            <span>{formatTime(effectiveDuration)}</span>
          </div>

          {/* role="slider" + tabIndex: this is a seek control, and it used to
              be a div with only an onClick, so there was no way to seek with a
              keyboard at all. Arrow/Home/End are the APG key set. */}
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek reel"
            aria-valuemin={0}
            aria-valuemax={Math.round(effectiveDuration)}
            aria-valuenow={Math.round(effectivePosition)}
            onKeyDown={handleScrubberKeyDown}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const clickPos = (e.clientX - rect.left) / rect.width;
              seekTo(clickPos * effectiveDuration);
            }}
            className="h-1.5 w-full bg-white/10 cursor-pointer overflow-hidden rounded-full"
          >
            <div
              className="h-full bg-[#FF6321] transition-all duration-150"
              style={{
                width: `${
                  isThisClipLoaded
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
              aria-label="Skip back 10 seconds"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
            </button>

            {/* Huge Orange Play Button from Design Spec */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePlayCard();
              }}
              className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#FF6321] text-black flex items-center justify-center shadow-[0_0_25px_rgba(255,99,33,0.35)] hover:scale-105 active:scale-95 transition-transform"
              title={playLabel}
              aria-label={playLabel}
            >
              {isCurrentPlaying ? (
                <Pause className="w-6 h-6 md:w-7 md:h-7 fill-black" aria-hidden="true" />
              ) : (
                <Play className="w-6 h-6 md:w-7 md:h-7 fill-black ml-0.5" aria-hidden="true" />
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
              aria-label="Skip forward 10 seconds"
            >
              <RotateCw className="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                nextClip("manual");
              }}
              className="px-3 py-2 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 text-[10px] font-black uppercase tracking-wider flex items-center gap-1 transition-colors"
              title="Next Reel"
              aria-label="Next reel"
            >
              <span aria-hidden="true">Next</span>
              <SkipForward className="w-3.5 h-3.5 text-[#FF6321]" aria-hidden="true" />
            </button>
          </div>

          {/* Social Engagement Actions */}
          <div className="flex items-center gap-4">
            {/* Like. `aria-label` is required because a button's accessible
                name is computed from its content *before* `title` — so the old
                `title="Like Reel"` never applied and this control was
                announced as "3". `aria-pressed` carries liked/unliked, which
                until now was signalled by the heart's fill colour alone
                (WCAG 1.4.1). */}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={handleLike}
                className="flex flex-col items-center group/btn"
                title="Like Reel"
                aria-label={likeLabel}
                aria-pressed={isLiked}
              >
                <span
                  className={`w-9 h-9 rounded-full border flex items-center justify-center transition-all ${
                    isLiked
                      ? "border-[#FF6321] bg-[#FF6321]/20 text-[#FF6321]"
                      : "border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40"
                  }`}
                >
                  <Heart
                    className={`w-4 h-4 ${isLiked ? "fill-[#FF6321]" : ""}`}
                    aria-hidden="true"
                  />
                </span>
                {/* Hidden from AT because the button's accessible name already
                    carries the count; announcing it twice is worse than not. */}
                <span className="text-[10px] font-mono font-bold text-white/60 mt-1" aria-hidden="true">
                  {likesCount}
                </span>
              </button>

              {/* A failed like rolls the heart back, and the rollback alone is
                  indistinguishable from a successful un-like. Same reasoning,
                  and the same pattern, as the follow failure above. */}
              {likeError && (
                <span
                  role="status"
                  aria-live="polite"
                  className="text-[9px] font-bold uppercase tracking-wider text-red-400"
                >
                  {likeError}
                </span>
              )}
            </div>

            {/* Comment */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenComments(clip);
              }}
              className="flex flex-col items-center group/btn"
              title="Comments"
              aria-label={commentLabel}
            >
              <span className="w-9 h-9 rounded-full border border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40 flex items-center justify-center transition-all">
                <MessageSquare className="w-4 h-4" aria-hidden="true" />
              </span>
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
              aria-label={shareLabel}
            >
              <span className="w-9 h-9 rounded-full border border-white/15 bg-white/5 text-white/40 group-hover/btn:text-[#FF6321] group-hover/btn:border-[#FF6321]/40 flex items-center justify-center transition-all">
                <Share2 className="w-4 h-4" aria-hidden="true" />
              </span>
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
