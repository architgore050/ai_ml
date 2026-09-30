import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { ExplorePage } from "../pages/Explore";
import type { FeedClip } from "../types/echoflow";

/**
 * `Explore.tsx` told three lies and offered no way out of a failure.
 *
 * 1. `{Math.max(15, clip.likes + clip.shares * 2)} Listens` — there is no view
 *    or listen counter on `AudioClip` (`backend/app/models.py:108-171`;
 *    `grep listen_count|view_count|play_count|total_plays backend/ --include=*.py`
 *    returns nothing). The `Math.max(15, …)` floor asserts a minimum audience
 *    for a clip with zero engagement.
 * 2. "clustered by semantic embeddings and acoustic vectors" +
 *    `CLUSTER_INDEX: PGVECTOR_384D`. `views/feed.py:207-222` only annotates
 *    `combined_distance` when `get_user_vectors(user)` returns BOTH vectors;
 *    a cold-start user gets a silent `order_by('-engagement_velocity')`. The
 *    response carries nothing that says which path ran, so the badge cannot be
 *    made honest — only deleted.
 * 3. `res.next` was discarded (`Explore.tsx:37-38`), so a `page_size=10` page
 *    rendered as if it were the whole category. No consumer of `next` exists
 *    anywhere in `src/`.
 *
 * Plus: the whole grid was `<div onClick>` with a `<div>` play affordance (not
 * one keyboard-reachable control, R6 finding #5), h1→h3 skipped a level, the
 * category tabs signalled selection by colour alone, and a failed request
 * rendered its error text with no retry — recoverable only by unmounting the
 * component (R4 F22).
 */

const player = vi.hoisted(() => ({
  playClip: vi.fn(),
  togglePlay: vi.fn(),
  currentClip: null as FeedClip | null,
  isPlaying: false,
}));

vi.mock("../stores/player", () => ({
  usePlayer: () => ({ ...player }),
}));

/** A DRF `next` link: absolute, cursor-bearing, exactly as `build_absolute_uri` emits. */
const NEXT_URL = "http://api.test/api/v1/suggestions/?category=all&cursor=cD0yMDI2LTAx";

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-1",
    title: "Mid-Fi Crunch",
    creator_name: "alex",
    creator_id: 42,
    category: "comedy",
    hls_playlist_url: "https://media.test/hls/clip-1/master.m3u8",
    likes: 3,
    shares: 1,
    skips: 0,
    comment_count: 0,
    is_liked: false,
    is_following: false,
    duration_ms: 7400,
    tags: ["instrumental", "lofi"],
    cover_image: null,
    ...overrides,
  };
}

/** `CursorPaginated` — `FeedClipSerializer` results plus both cursors. */
function page(results: FeedClip[], next: string | null = null) {
  return json(200, { next, previous: null, results });
}

function renderExplore() {
  return render(<ExplorePage onOpenFeed={() => {}} />);
}

describe("Explore page", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
    player.playClip.mockClear();
    player.togglePlay.mockClear();
    player.currentClip = null;
    player.isPlaying = false;
  });

  // ---------------------------------------------------------------------
  // 1. The fabricated "Listens" count, and its real replacements
  // ---------------------------------------------------------------------
  describe("listen count", () => {
    it("renders no listen count at all", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.queryByText(/listens/i)).not.toBeInTheDocument();
    });

    it("renders the payload's own duration_ms instead", async () => {
      api.on("GET", /suggestions/, () => page([makeClip({ duration_ms: 7400 })]));

      renderExplore();
      const card = await screen.findByRole("heading", {
        level: 2,
        name: /mid-fi crunch/i,
      });

      // 7400 ms renders as 0:07. Scoped to the card so a stray match
      // elsewhere on the page cannot satisfy this.
      expect(card.closest("li")).toHaveTextContent("0:07");
    });

    it("renders the payload's own tags instead", async () => {
      api.on("GET", /suggestions/, () => page([makeClip({ tags: ["instrumental", "lofi"] })]));

      renderExplore();
      const card = await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const item = card.closest("li");
      expect(item).toHaveTextContent("instrumental");
      expect(item).toHaveTextContent("lofi");
      expect(within(item as HTMLElement).queryByText(/listens/i)).not.toBeInTheDocument();
    });

    it("does not claim a minimum audience for a clip with zero engagement", async () => {
      // The `Math.max(15, …)` floor rendered "15 Listens" for a clip nobody
      // had engaged with at all. Nothing about a zero-engagement clip may
      // render an audience number.
      api.on("GET", /suggestions/, () => page([makeClip({ likes: 0, shares: 0 })]));

      renderExplore();
      const card = await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(card.closest("li")).not.toHaveTextContent(/15/);
    });
  });

  // ---------------------------------------------------------------------
  // 2. The vector-ranking claims
  // ---------------------------------------------------------------------
  describe("ranking claims", () => {
    it("does not assert a ranking mechanism the response cannot confirm", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.queryByText(/PGVECTOR/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/cluster/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/embedding/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/vector/i)).not.toBeInTheDocument();
    });

    it("still states plainly that results are ranked", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getByText(/ranked for you/i)).toBeInTheDocument();
    });

    it("does not claim a mechanism while loading either", async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.on("GET", /suggestions/, async () => {
        await gate;
        return page([makeClip()]);
      });

      renderExplore();

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
      expect(screen.queryByText(/clustering/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/embedding/i)).not.toBeInTheDocument();

      release?.();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
    });
  });

  // ---------------------------------------------------------------------
  // 3. The discarded `next` cursor
  // ---------------------------------------------------------------------
  describe("pagination", () => {
    it("offers a load-more control when the server returns a next cursor", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()], NEXT_URL));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
      // And it must not claim the page is everything.
      expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    });

    it("offers no load-more control when the server returns no cursor", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()], null));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    });

    it("follows the server's cursor and appends the next page", async () => {
      let call = 0;
      api.on("GET", /suggestions/, () => {
        call += 1;
        return call === 1
          ? page([makeClip()], NEXT_URL)
          : page([makeClip({ id: "clip-2", title: "Late Night Loop" })], null);
      });

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
      expect(screen.queryByText(/late night loop/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /load more/i }));

      await screen.findByRole("heading", { level: 2, name: /late night loop/i });

      const calls = api.callsTo(/suggestions/);
      expect(calls).toHaveLength(2);
      // The cursor is followed verbatim, not re-derived by hand.
      expect(calls[1]?.url).toBe(NEXT_URL);

      // Second page had no cursor, so the control is gone.
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    });

    it("ignores a second click while the next page is in flight", async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let call = 0;
      api.on("GET", /suggestions/, async () => {
        call += 1;
        if (call === 1) return page([makeClip()], NEXT_URL);
        await gate;
        return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], null);
      });

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const loadMore = screen.getByRole("button", { name: /load more/i });
      await user.click(loadMore);
      await user.click(screen.getByRole("button", { name: /loading/i }));

      expect(api.callsTo(/suggestions/)).toHaveLength(2);

      release?.();
      await screen.findByRole("heading", { level: 2, name: /late night loop/i });
    });

    it("keeps the loaded page and offers a retry when the next page fails", async () => {
      let call = 0;
      api.on("GET", /suggestions/, () => {
        call += 1;
        return call === 1
          ? page([makeClip()], NEXT_URL)
          : json(500, { detail: "cursor exploded" });
      });

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /load more/i }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/500/);
      // The page the user already has is not thrown away by a failed
      // follow-up request.
      expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
    });

    it("does not append a stale page to a category the user has already left", async () => {
      // Race the feature introduces: the previous category's page 2 and the
      // new category's page 1 can be in flight together and resolve in either
      // order. Resolving the old one second must not put the old category's
      // clips under the new category.
      let call = 0;
      let releaseMore: (() => void) | undefined;
      const moreGate = new Promise<void>((resolve) => {
        releaseMore = resolve;
      });
      let releaseScience: (() => void) | undefined;
      const scienceGate = new Promise<void>((resolve) => {
        releaseScience = resolve;
      });
      api.on("GET", /suggestions/, async () => {
        call += 1;
        if (call === 1) return page([makeClip()], NEXT_URL);
        if (call === 2) {
          await moreGate;
          return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], null);
        }
        await scienceGate;
        return page(
          [makeClip({ id: "clip-3", title: "Rocket Science", category: "science" })],
          null,
        );
      });

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      // In flight: old category's page 2, deliberately held.
      await user.click(screen.getByRole("button", { name: /load more/i }));
      await screen.findByRole("button", { name: /loading/i });

      // In flight: new category's page 1, deliberately held.
      await user.click(screen.getByRole("button", { name: /science bites/i }));
      await waitFor(() => expect(api.callsTo(/suggestions/)).toHaveLength(3));

      // New category lands first, then the stale page resolves.
      releaseScience?.();
      await screen.findByRole("heading", { level: 2, name: /rocket science/i });
      releaseMore?.();

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { level: 2, name: /rocket science/i }),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByRole("heading", { level: 2, name: /late night loop/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { level: 2, name: /mid-fi crunch/i }),
      ).not.toBeInTheDocument();
    });

    it("discards the accumulated page and cursor when the category changes", async () => {
      // Must-preserve: the category filter still drives the request. New
      // requirement: switching category must not keep appending to the
      // previous category's cursor.
      let call = 0;
      api.on("GET", /suggestions/, () => {
        call += 1;
        if (call === 1) return page([makeClip()], NEXT_URL);
        if (call === 2)
          return page([makeClip({ id: "clip-2", title: "Late Night Loop" })], null);
        return page([makeClip({ id: "clip-3", title: "Rocket Science", category: "science" })], null);
      });

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
      await user.click(screen.getByRole("button", { name: /load more/i }));
      await screen.findByRole("heading", { level: 2, name: /late night loop/i });

      await user.click(screen.getByRole("button", { name: /science bites/i }));

      await screen.findByRole("heading", { level: 2, name: /rocket science/i });

      const calls = api.callsTo(/suggestions/);
      expect(calls[2]?.url).toContain("category=science");
      // Previous category's page is gone.
      expect(screen.queryByRole("heading", { level: 2, name: /mid-fi crunch/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 2, name: /late night loop/i })).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // 4. Error states with a way out
  // ---------------------------------------------------------------------
  describe("failure states", () => {
    it("shows an alert with a retry control when the server returns 500", async () => {
      let call = 0;
      api.on("GET", /suggestions/, () => {
        call += 1;
        return call === 1 ? json(500, { detail: "Suggestion service unavailable" }) : page([makeClip()]);
      });

      const user = userEvent.setup();
      renderExplore();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/500/);
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

      // Recovery does not require unmounting the component.
      await user.click(screen.getByRole("button", { name: /retry/i }));
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("distinguishes a server error from a transport failure", async () => {
      let call = 0;
      api.on("GET", /suggestions/, () => {
        call += 1;
        return call === 1
          ? json(500, { detail: "Suggestion service unavailable" })
          : { networkError: new TypeError("Failed to fetch") };
      });

      const user = userEvent.setup();
      renderExplore();

      const serverAlert = await screen.findByRole("alert");
      expect(serverAlert).toHaveTextContent(/500/);
      expect(serverAlert).not.toHaveTextContent(/can't reach/i);

      await user.click(screen.getByRole("button", { name: /retry/i }));

      const networkAlert = await screen.findByRole("alert");
      expect(networkAlert).toHaveTextContent(/can't reach/i);
      expect(networkAlert).not.toHaveTextContent(/500/);
    });

    it("reports a transport failure as a connectivity problem, not as no results", async () => {
      api.fail("GET", /suggestions/, new TypeError("Failed to fetch"));

      renderExplore();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/can't reach/i);
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      expect(screen.queryByText(/no audio reels/i)).not.toBeInTheDocument();
    });

    it("renders a genuine empty state that is not an error", async () => {
      api.on("GET", /suggestions/, () => page([], null));

      renderExplore();

      expect(await screen.findByText(/no audio reels/i)).toBeInTheDocument();
      // "Not an error" is asserted structurally: the failure state is an
      // announced alert region, and this is not one. The old empty copy also
      // claimed a cluster exists ("found in this category cluster") when the
      // category may hold nothing at all.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/can't reach/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/cluster/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });

    it("never presents the loading spinner as the failure state", async () => {
      api.fail("GET", /suggestions/, new TypeError("Failed to fetch"));

      renderExplore();

      await screen.findByRole("alert");
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // 5. Keyboard reachability, names, headings, selected state
  // ---------------------------------------------------------------------
  describe("accessibility", () => {
    it("exposes the play control as a named button", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(
        screen.getByRole("button", { name: "Play Mid-Fi Crunch" }),
      ).toBeInTheDocument();
    });

    it("plays the clip when the play control is activated by keyboard", async () => {
      const clip = makeClip();
      api.on("GET", /suggestions/, () => page([clip]));

      const user = userEvent.setup();
      renderExplore();
      const play = await screen.findByRole("button", { name: "Play Mid-Fi Crunch" });

      play.focus();
      expect(play).toHaveFocus();
      await user.keyboard("{Enter}");

      // Both the clip and the queue it was handed, so "plays this clip" is
      // asserted rather than "something was called".
      expect(player.playClip).toHaveBeenCalledTimes(1);
      expect(player.playClip).toHaveBeenCalledWith(clip, [clip]);
    });

    it("plays the clip when the grid item title is activated by keyboard", async () => {
      const clip = makeClip();
      api.on("GET", /suggestions/, () => page([clip]));

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const title = screen.getByRole("button", { name: "Mid-Fi Crunch" });
      title.focus();
      expect(title).toHaveFocus();
      await user.keyboard(" ");

      expect(player.playClip).toHaveBeenCalledTimes(1);
      expect(player.playClip).toHaveBeenCalledWith(clip, [clip]);
    });

    it("reaches every grid item and every play control by tabbing", async () => {
      api.on("GET", /suggestions/, () =>
        page([
          makeClip({ id: "clip-1", title: "Mid-Fi Crunch" }),
          makeClip({ id: "clip-2", title: "Late Night Loop" }),
        ]),
      );

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      // The grid is a list of items — not a div soup of click handlers.
      expect(screen.getByRole("list")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);

      for (const name of ["Mid-Fi Crunch", "Late Night Loop"]) {
        expect(screen.getByRole("button", { name: `Play ${name}` })).toBeInTheDocument();
        expect(screen.getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("renames the play control when the clip is already playing", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));
      player.currentClip = makeClip();
      player.isPlaying = true;

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(
        screen.getByRole("button", { name: "Pause Mid-Fi Crunch" }),
      ).toBeInTheDocument();
    });

    it("does not skip a heading level between the page title and the clips", async () => {
      api.on("GET", /suggestions/, () => page([makeClip(), makeClip({ id: "clip-2", title: "B" })]));

      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    });

    it("exposes the selected category as pressed state, not colour alone", async () => {
      api.on("GET", /suggestions/, () => page([makeClip()]));

      const user = userEvent.setup();
      renderExplore();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const all = screen.getByRole("button", { name: "All Hubs" });
      const comedy = screen.getByRole("button", { name: "Comedy & Roasts" });
      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(comedy).toHaveAttribute("aria-pressed", "false");

      await user.click(comedy);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Comedy & Roasts" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      });
      expect(screen.getByRole("button", { name: "All Hubs" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });
});
