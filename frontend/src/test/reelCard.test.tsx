import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFetchMock, type FetchMock } from "./fetchMock";
import { ReelCard } from "../components/feed/ReelCard";
import type { FeedClip } from "../types/echoflow";

/**
 * The follow button was destructive.
 *
 * `ReelCard` initialised `useState<boolean>(false)` — a hardcoded literal,
 * not a read of the prop. `is_following` did not exist on `FeedClip` and was
 * not returned by any serializer, so there was nothing to read. The endpoint
 * it calls, `POST /follow/{id}/toggle-follow/`, is a *toggle*.
 *
 * The consequence: a user who already followed a creator saw "Follow".
 * Tapping it called toggle-follow, which **unfollowed** them. No
 * confirmation, no undo, and the button then showed "Follow" again, so the
 * UI looked exactly as it did before the tap.
 *
 * `is_following` was added server-side in 21846fe and shipped with no
 * consumer. These tests are the consumer, and they are the proof the field
 * is actually read — a test that only asserted the server field exists would
 * have passed while the bug stayed live.
 */

const CURRENT_USER_ID = 7;
const CREATOR_ID = 42;

const mockUser = { id: CURRENT_USER_ID, username: "me", email: "me@example.com" };

vi.mock("../stores/auth", () => ({
  useAuth: () => ({ user: mockUser, isAuthenticated: true }),
}));

/**
 * A stateful stand-in for the player store.
 *
 * `seek` has to move the position the card reports. A `vi.fn()` double would
 * leave `aria-valuenow` frozen at 0, and a slider test that cannot observe the
 * value its own keypress changed proves nothing about the slider. The position
 * therefore lives in React state *inside the mock*, so a seek re-renders the
 * card the same way the real store's `setCurrentTime` would — and the test can
 * assert on what the user would actually be told.
 *
 * Everything else is deliberately inert. `audioFrequencies` keeps its original
 * three-zero shape: the card must not need a wider mock to render.
 */
const playerDouble = {
  isPlaying: false,
  currentClip: null as { id: string } | null,
  playClip: vi.fn(),
  togglePlay: vi.fn(),
  nextClip: vi.fn(),
  previousClip: vi.fn(),
  setRate: vi.fn(),
  skipForward: vi.fn(),
  skipBackward: vi.fn(),
  playbackError: null as unknown,
  audioFrequencies: [0, 0, 0],
  playbackRate: 1,
  /** What the media element reports once metadata has loaded. 0 until then. */
  mediaDuration: 0,
  seekCalls: [] as number[],
};

vi.mock("../stores/player", async () => {
  const { useCallback, useState } = await import("react");
  return {
    usePlayer: () => {
      const [position, setPosition] = useState(0);
      const seek = useCallback((seconds: number) => {
        playerDouble.seekCalls.push(seconds);
        setPosition(seconds);
      }, []);
      return {
        ...playerDouble,
        currentTime: position,
        duration: playerDouble.mediaDuration,
        progress:
          playerDouble.mediaDuration > 0 ? position / playerDouble.mediaDuration : 0,
        seek,
      };
    },
  };
});

beforeEach(() => {
  playerDouble.isPlaying = false;
  playerDouble.currentClip = null;
  playerDouble.mediaDuration = 0;
  playerDouble.playbackRate = 1;
  playerDouble.seekCalls = [];
  playerDouble.playClip.mockClear();
  playerDouble.togglePlay.mockClear();
  playerDouble.nextClip.mockClear();
  playerDouble.setRate.mockClear();
  playerDouble.skipForward.mockClear();
  playerDouble.skipBackward.mockClear();
});

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-1",
    title: "A clip",
    creator_name: "alex",
    creator_id: CREATOR_ID,
    category: "music",
    hls_playlist_url: "https://media.example/hls/clip-1/master.m3u8",
    likes: 3,
    shares: 1,
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

function renderCard(
  clip: FeedClip,
  options: { isActive?: boolean; onCreatorClick?: (creatorId: number) => void } = {},
) {
  return render(
    <ReelCard
      clip={clip}
      isActive={options.isActive ?? false}
      onOpenComments={() => {}}
      onOpenShare={() => {}}
      onCreatorClick={options.onCreatorClick}
    />,
  );
}

describe("ReelCard follow button", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("shows Following when the API says the creator is already followed", () => {
    // THE regression. With the old hardcoded `false` this rendered "Follow"
    // and the first tap unfollowed them.
    renderCard(makeClip({ is_following: true }));
    expect(screen.getByRole("button", { name: /following/i })).toBeInTheDocument();
  });

  it("shows Follow when the API says the creator is not followed", () => {
    renderCard(makeClip({ is_following: false }));
    expect(screen.getByRole("button", { name: /^follow$/i })).toBeInTheDocument();
  });

  it("does not unfollow an already-followed creator on tap", async () => {
    // The server is the authority: it would report "unfollowed" for a tap on
    // an already-followed creator, which is the destructive outcome. Asserting
    // the response is *followed* pins that the client's initial state no
    // longer flips a follow into an unfollow.
    fetchMock.on("POST", /toggle-follow/, () => ({
      status: 200,
      body: { status: "followed" },
    }));

    const user = userEvent.setup();
    renderCard(makeClip({ is_following: true }));

    await user.click(screen.getByRole("button", { name: /following/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /following/i })).toBeInTheDocument();
    });
  });

  it("flips to Following after following someone new", async () => {
    fetchMock.on("POST", /toggle-follow/, () => ({
      status: 200,
      body: { status: "followed" },
    }));

    const user = userEvent.setup();
    renderCard(makeClip({ is_following: false }));

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /following/i })).toBeInTheDocument();
    });
  });

  it("rolls back and says so when the toggle fails", async () => {
    // Previously the catch was `console.warn` and nothing else, so a failed
    // follow was indistinguishable from a successful one.
    fetchMock.on("POST", /toggle-follow/, () => ({ status: 500, body: { detail: "boom" } }));

    const user = userEvent.setup();
    renderCard(makeClip({ is_following: false }));

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/could not update follow/i);
    });
    // Rolled back to the server truth, not left optimistically "Following".
    expect(screen.getByRole("button", { name: /^follow$/i })).toBeInTheDocument();
  });

  it("ignores a second tap while the first is in flight", async () => {
    // Two toggles land back on the original state, so "Follow" tapped twice
    // silently unfollows — the exact surprise this whole commit removes.
    let resolveToggle: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveToggle = resolve;
    });
    fetchMock.on("POST", /toggle-follow/, async () => {
      await gate;
      return { status: 200, body: { status: "followed" } };
    });

    const user = userEvent.setup();
    renderCard(makeClip({ is_following: false }));
    const button = screen.getByRole("button", { name: /^follow$/i });

    await user.click(button);
    // The optimistic update renames the button, so grab the live one.
    const optimistic = screen.getByRole("button", { name: /following/i });
    await user.click(optimistic);

    expect(fetchMock.callsTo(/toggle-follow/)).toHaveLength(1);

    resolveToggle?.();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /following/i })).toBeInTheDocument();
    });
  });

  it("hides the follow button on your own clips", () => {
    renderCard(makeClip({ creator_id: CURRENT_USER_ID, is_following: false }));
    expect(screen.queryByRole("button", { name: /follow/i })).not.toBeInTheDocument();
  });

  it("re-syncs when the same card receives new server state", () => {
    // Cards are keyed by a stable clip.id, so useState(clip.is_following) is
    // captured at first paint and never re-read. A feed refresh that changes
    // the answer must update the button.
    const { rerender } = renderCard(makeClip({ is_following: false }));
    expect(screen.getByRole("button", { name: /^follow$/i })).toBeInTheDocument();

    rerender(
      <ReelCard
        clip={makeClip({ is_following: true })}
        isActive={false}
        onOpenComments={() => {}}
        onOpenShare={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /following/i })).toBeInTheDocument();
  });
});

/**
 * The card displayed measurements that were never measured.
 *
 * `Acoustic Vector` and `Similarity Score` were arithmetic on `likes` and
 * `shares` — so two clips whose like counts were congruent modulo 7 both read
 * "0.920 Match". "192kbps ABR" described an encode that produces a single
 * 128 kbps variant with no `var_stream_map`, i.e. no adaptive bitrate at all.
 * The quote was a hardcoded string rendered in a quote-marked block that read
 * as a transcript; no transcript field exists on the model or the serializer.
 *
 * The freed space renders `tags` and `duration_ms`, which the API has been
 * sending all along and which nothing displayed.
 */
describe("ReelCard data truthfulness", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("renders no invented transcript", () => {
    const { container } = renderCard(makeClip());
    expect(container.textContent).not.toMatch(/Sound travels without pixels/i);
  });

  it("invents no clip id", () => {
    // `clip.id` is a UUID4 and the card prefixed it with a made-up "EF-",
    // truncated to 8 hex characters — presented as a resolvable identifier,
    // resolving to nothing.
    const { container } = renderCard(makeClip({ id: "0f2c9a1b-4d5e-4f60-8123-456789abcdef" }));
    expect(container.textContent).not.toMatch(/EF-/i);
    expect(container.textContent).not.toMatch(/CLIP_ID/i);
  });

  it("claims no bitrate and no adaptive bitrate", () => {
    const { container } = renderCard(makeClip());
    expect(container.textContent).not.toMatch(/kbps/i);
    expect(container.textContent).not.toMatch(/ABR/);
  });

  it("renders no vector or similarity telemetry", () => {
    const { container } = renderCard(makeClip());
    expect(container.textContent).not.toMatch(/Acoustic Vector/i);
    expect(container.textContent).not.toMatch(/Similarity Score/i);
  });

  it("renders the tags and duration the API already sends", () => {
    // Both values are in `FeedClipSerializer`. Neither was rendered anywhere in
    // the app before this. Scoping the assertion to the block that replaced the
    // telemetry strip is what proves the substitute data is actually consumed —
    // the scrubber already showed a duration, so an unscoped "1:15 is on
    // screen" would have passed before the change too.
    renderCard(makeClip({ tags: ["instrumental"], duration_ms: 75_000 }));

    const facts = screen.getByText("Duration").closest("div");
    expect(facts).not.toBeNull();
    expect(facts).toHaveTextContent("1:15");
    expect(facts).toHaveTextContent("instrumental");
  });
});

describe("ReelCard accessibility", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  /**
   * The card has two live regions: the follow failure (always mounted) and the
   * like failure. `getByRole("status")` cannot disambiguate them, so these
   * assertions look the region up by what it is announcing.
   */
  function statusAnnouncing(text: RegExp): HTMLElement | undefined {
    return screen
      .getAllByRole("status")
      .find((el) => text.test(el.textContent ?? ""));
  }

  it("announces a failed like instead of silently un-filling the heart", async () => {
    fetchMock.on("POST", /toggle-like/, () => ({ status: 500, body: { detail: "boom" } }));

    const user = userEvent.setup();
    renderCard(makeClip());
    // Located by `title` rather than by accessible name: this test is about the
    // announcement, so it must not also depend on the naming fix, or it would
    // go red for someone else's reason.
    const like = screen.getByTitle("Like Reel");
    const initialName = like.getAttribute("aria-label");

    await user.click(like);

    await waitFor(() => {
      expect(statusAnnouncing(/could not update like/i)).toBeDefined();
    });
    // …and the optimistic state is genuinely rolled back, not left lying.
    expect(like).toHaveAccessibleName(initialName);
  });

  it("exposes the creator as a keyboard-reachable button", async () => {
    // This bar is the only route from the feed to another creator's profile;
    // `Header`'s avatar button goes to the signed-in user's own profile. As a
    // div-with-onClick it had no role, no tab stop and no key handler, so a
    // keyboard user could not open a profile at all.
    const onCreatorClick = vi.fn();
    const user = userEvent.setup();
    renderCard(makeClip(), { onCreatorClick });

    const creator = screen.getByRole("button", { name: /@alex/i });
    creator.focus();
    expect(creator).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onCreatorClick).toHaveBeenCalledWith(CREATOR_ID);
  });

  it("exposes the scrubber as a slider and seeks with the keyboard", async () => {
    playerDouble.currentClip = { id: "clip-1" };
    playerDouble.mediaDuration = 30;

    const user = userEvent.setup();
    renderCard(makeClip({ duration_ms: 30_000 }), { isActive: true });

    const slider = screen.getByRole("slider", { name: /seek/i });
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "30");
    expect(slider).toHaveAttribute("aria-valuenow", "0");

    slider.focus();
    await user.keyboard("{ArrowRight}");

    // The value the control *reports* has to move, not merely the seek call:
    // an aria-valuenow frozen at 0 is the whole reason this was invisible.
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuenow", "5");
    });
    expect(playerDouble.seekCalls).toEqual([5]);
  });

  it("names the like button and exposes liked/unliked as state", async () => {
    fetchMock.on("POST", /toggle-like/, () => ({ status: 200, body: { status: "liked" } }));

    const user = userEvent.setup();
    renderCard(makeClip());

    // Content outranks `title` in name computation, so the button's only
    // children — an icon and the bare count — made it "3 likes" / "3".
    const like = screen.getByRole("button", { name: /like reel/i });
    expect(like).toHaveAccessibleName("Like reel, 3 likes");
    expect(like).toHaveAttribute("aria-pressed", "false");

    await user.click(like);

    await waitFor(() => {
      expect(like).toHaveAttribute("aria-pressed", "true");
    });
    expect(like).toHaveAccessibleName("Like reel, 4 likes");
  });

  it("hides the decorative waveform from assistive tech", () => {
    // There is no AnalyserNode behind these bars; they are ornament. Left in
    // the accessibility tree they are read as a spectrum analyser.
    const { container } = renderCard(makeClip());

    const bars = Array.from(container.querySelectorAll<HTMLElement>('div[style*="height"]'));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it("does not render a top-level heading per card", () => {
    // The feed renders N cards, so an <h1> per card meant the page had N
    // competing top-level headings and none of its own.
    const { container } = renderCard(makeClip());
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).not.toBeNull();
  });
});
