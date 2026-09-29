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

// ReelCard pulls a large surface out of the player store. Only the fields it
// touches on first render need to be real; the rest are inert.
vi.mock("../stores/player", () => ({
  usePlayer: () => ({
    isPlaying: false,
    currentClip: null,
    playClip: vi.fn(),
    togglePlay: vi.fn(),
    nextClip: vi.fn(),
    previousClip: vi.fn(),
    seek: vi.fn(),
    setRate: vi.fn(),
    audioFrequencies: [0, 0, 0],
    playbackError: null,
  }),
}));

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

function renderCard(clip: FeedClip) {
  return render(
    <ReelCard
      clip={clip}
      isActive={false}
      onOpenComments={() => {}}
      onOpenShare={() => {}}
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
