import React from "react";
import { Play, Pause, SkipForward, RotateCw } from "lucide-react";
import { usePlayer } from "../../stores/player";

interface MiniPlayerProps {
  onOpenFeed: () => void;
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({ onOpenFeed }) => {
  const {
    currentClip,
    isPlaying,
    togglePlay,
    progress,
    audioFrequencies,
    skipForward,
    nextClip,
  } = usePlayer();

  if (!currentClip) return null;

  return (
    // `role="region"` + a name, so the persistent player is a boundary a screen
    // reader can find and jump to. It matters more than usual here: there is no
    // <audio> element in the accessibility tree at all — `player.tsx` does
    // `new Audio()` and never attaches it — so this region is the only place
    // "what is playing" is exposed anywhere in the app.
    <div
      role="region"
      aria-label="Now playing"
      className="fixed bottom-16 md:bottom-6 left-0 right-0 z-30 px-4 pb-1"
    >
      <div className="max-w-2xl mx-auto bg-[#111111]/95 backdrop-blur-xl border border-white/15 rounded-2xl p-3 shadow-2xl flex items-center gap-3 relative overflow-hidden">
        {/* Progress Bar Top Rim — purely visual. The elapsed/duration text is
            not rendered here at all, so the fill carries no information a
            screen reader could be given; `ReelCard` is where position is
            exposed, and even there it is not. */}
        <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-0.5 bg-white/10">
          <div
            className="h-full bg-[#FF6321] transition-all duration-200"
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>

        {/* Audio Visualizer Box */}
        <div
          onClick={onOpenFeed}
          className="relative w-11 h-11 rounded-lg bg-black border border-white/15 flex items-center justify-center cursor-pointer overflow-hidden flex-shrink-0 group"
        >
          {/* The bars are a decorative pseudo-reactive envelope, re-rendered on
              every one of the player's ~60 rAF ticks. Un-hidden, they put five
              meaningless elements into the accessibility tree sixty times a
              second, and there is no `AnalyserNode` behind them to describe. */}
          <div aria-hidden="true" className="flex items-end gap-0.5 h-6 px-1">
            {audioFrequencies.slice(0, 5).map((freq, idx) => (
              <span
                key={idx}
                className="w-1 bg-[#FF6321] transition-all duration-75"
                style={{ height: `${Math.max(4, Math.min(22, (freq / 80) * 22))}px` }}
              />
            ))}
          </div>
        </div>

        {/* Clip Info */}
        <div onClick={onOpenFeed} className="flex-1 min-w-0 cursor-pointer">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase font-black tracking-widest text-[#FF6321] px-1 py-0.2 rounded bg-[#FF6321]/15">
              {currentClip.category}
            </span>
            <span className="text-[10px] font-mono uppercase text-white/50 truncate">
              @{currentClip.creator_name}
            </span>
          </div>
          <p className="text-xs font-black uppercase tracking-tight text-white truncate mt-0.5">
            {currentClip.title}
          </p>
        </div>

        {/* Controls.
            All three were `title`-only, or — in the play/pause case — unnamed
            outright. `title` is a fallback, not a name: it is never exposed on
            touch and is suppressed by some screen-reader/browser combinations.
            The play/pause label is dynamic so it names the action it will
            perform rather than the state it is in. */}
        <div className="flex items-center gap-1.5">
          {/* Skip 10s */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              skipForward(10);
            }}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            aria-label="Skip 10 seconds"
            title="Skip 10s"
          >
            <RotateCw className="w-4 h-4" aria-hidden="true" />
          </button>

          {/* Play/Pause — the persistent player's primary control. It had no
              accessible name at all: no text, no aria-label, no title, just a
              16px glyph. A screen-reader user tabbing here found an unnamed
              button and could not tell it was pause. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause" : "Play"}
            className="w-9 h-9 rounded-full bg-[#FF6321] hover:bg-[#ff763a] text-black flex items-center justify-center shadow-[0_0_15px_rgba(255,99,33,0.3)] transition-transform active:scale-95"
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-black" aria-hidden="true" />
            ) : (
              <Play className="w-4 h-4 fill-black ml-0.5" aria-hidden="true" />
            )}
          </button>

          {/* Next Reel */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              nextClip("manual");
            }}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            aria-label="Next reel"
            title="Next Reel"
          >
            <SkipForward className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
