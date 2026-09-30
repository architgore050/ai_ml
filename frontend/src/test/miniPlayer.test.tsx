import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MiniPlayer } from "../components/feed/MiniPlayer";
import type { FeedClip } from "../types/echoflow";

/**
 * `MiniPlayer` — the persistent player, the one piece of chrome that follows
 * the user across every tab.
 *
 * Its primary control, play/pause, had no accessible name at all: no text, no
 * `aria-label`, no `title`, just a bare 16px lucide glyph inside a button. A
 * screen-reader user tabbing to it found an unnamed button and could not tell
 * it was pause. Its two siblings were named only by `title`, which is a
 * fallback rather than a name — never exposed on touch, and suppressed by some
 * screen-reader/browser combinations.
 *
 * The five visualiser bars are decorative and re-render at 60 fps. Not being
 * `aria-hidden`, they put five meaningless elements into the accessibility tree
 * on every frame of playback.
 */

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-a",
    title: "A clip",
    creator_name: "midnight_dj",
    creator_id: 3,
    category: "music",
    hls_playlist_url: "https://media.example/hls/clip-a/master.m3u8",
    likes: 1,
    shares: 0,
    skips: 0,
    comment_count: 0,
    is_liked: false,
    is_following: false,
    duration_ms: 4000,
    tags: ["acoustic"],
    cover_image: null,
    ...overrides,
  };
}

/**
 * A stateful player double: `isPlaying` has to actually change, because the
 * whole point of the control is that its name says which of the two actions it
 * will perform. A frozen `vi.fn()` double would let a component that ignored
 * the state pass the naming test.
 */
const playerDouble = {
  currentClip: makeClip() as FeedClip | null,
  isPlaying: false,
  progress: 0.25,
  audioFrequencies: [10, 40, 70, 30, 55],
  togglePlay: vi.fn(),
  skipForward: vi.fn(),
  nextClip: vi.fn(),
};

vi.mock("../stores/player", () => ({
  usePlayer: () => playerDouble,
}));

function renderPlayer(onOpenFeed = () => {}) {
  return render(<MiniPlayer onOpenFeed={onOpenFeed} />);
}

describe("MiniPlayer — the primary control is named", () => {
  it("names the play/pause control when paused", () => {
    // THE regression: no text, no aria-label, no title.
    playerDouble.isPlaying = false;
    renderPlayer();
    expect(screen.getByRole("button", { name: /^play$/i })).toBeInTheDocument();
  });

  it("renames the control when playing, so it says what it will do", () => {
    playerDouble.isPlaying = true;
    renderPlayer();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^play$/i })).not.toBeInTheDocument();
  });

  it("does not let the name be derived from the icon", () => {
    playerDouble.isPlaying = true;
    renderPlayer();
    const button = screen.getByRole("button", { name: /^pause$/i });
    // A name that came from content would be empty here, because the only
    // child is an <svg>.
    expect(button.textContent).toBe("");
  });

  it("names the skip and next controls on something better than a title", () => {
    playerDouble.isPlaying = false;
    renderPlayer();
    // Both were `title`-only, which is a fallback, not a name.
    expect(screen.getByRole("button", { name: /skip 10 seconds/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next reel/i })).toBeInTheDocument();
  });

  it("toggles playback", () => {
    playerDouble.isPlaying = false;
    playerDouble.togglePlay = vi.fn();
    renderPlayer();

    act(() => {
      screen.getByRole("button", { name: /^play$/i }).click();
    });
    expect(playerDouble.togglePlay).toHaveBeenCalledTimes(1);
  });
});

describe("MiniPlayer — there is a now-playing region to find", () => {
  it("labels a region so the player is a findable boundary", () => {
    // There is no <audio> element in the accessibility tree at all —
    // `player.tsx` does `new Audio()` and never attaches it — so this region is
    // the only way a screen reader can find "what is playing".
    playerDouble.isPlaying = true;
    renderPlayer();

    const region = screen.getByRole("region");
    expect(region).toHaveAccessibleName(/now playing/i);
  });
});

describe("MiniPlayer — the visualiser is decorative", () => {
  it("hides the five frequency bars from assistive technology", () => {
    playerDouble.isPlaying = true;
    renderPlayer();

    const region = screen.getByRole("region");
    const hidden = region.querySelectorAll('[aria-hidden="true"]');
    // Five bars, all decorative, all re-rendering at 60 fps.
    expect(hidden.length).toBeGreaterThanOrEqual(5);
  });

  it("puts nothing meaningful in the tree for the bar heights", () => {
    playerDouble.isPlaying = true;
    renderPlayer();

    // The bars carry no text, so a screen reader has nothing to say about them
    // beyond "span" five times per frame.
    const region = screen.getByRole("region");
    for (const bar of region.querySelectorAll('[aria-hidden="true"]')) {
      expect(bar.textContent).toBe("");
    }
  });
});

describe("MiniPlayer — nothing to show", () => {
  it("renders nothing when there is no clip", () => {
    playerDouble.currentClip = null;
    try {
      const { container } = renderPlayer();
      expect(container).toBeEmptyDOMElement();
    } finally {
      playerDouble.currentClip = makeClip();
    }
  });
});
