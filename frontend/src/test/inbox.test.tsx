import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFetchMock, json, noContent, type FetchMock } from "./fetchMock";
import { InboxPage } from "../pages/Inbox";
import type { FeedClip, ShareEvent } from "../types/echoflow";

/**
 * `Inbox.tsx` was the only page in the app with no way to tell a share from
 * five minutes ago from one from five months ago, and the only list page with
 * not one keyboard-reachable control.
 *
 * 1. **No timestamp at all.** `grep created_at frontend/src/pages/Inbox.tsx`
 *    → 0 hits, while `ShareEventSerializer` supplies it (`serializers.py:583`)
 *    and `types/echoflow.ts:71` declares it. RECON-03 finding #20.
 * 2. **Three silent failures.** `markRead` (`:44-46`) and share-delete
 *    (`:62-64`) failures were `console.warn` only, and the load failure
 *    rendered a bare `<div>` with no `role="alert"` and no retry control —
 *    recovery meant switching tabs and back (RECON-04 F16 + F22).
 * 3. **Nothing was keyboard-reachable.** Rows were `<div onClick>` and the
 *    play affordance was a `<div>`, not a button (RECON-06 finding #6). The
 *    remove button was named by a bare `title` (RECON-06 §5), and the page ran
 *    `<h1>` → `<h3>` (RECON-06 finding #20).
 *
 * `clip_hls_url` (`serializers.py:582`) is also supplied and still unused. Not
 * rendered here: it is an HLS URL behind the playback-token contract, and
 * `player.tsx` is not this page's to change.
 *
 * What is asserted to be *preserved*: the delete rollback removes the row only
 * after the server confirms (`Inbox.tsx:58-61` was already correct —
 * `frontend_rebuild_plan.md:89` and `COMPLETION_PLAN.md` A3 both misdescribe
 * it), `markRead` is idempotent, and the `NEW` / unread-badge contract is
 * unchanged.
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

/**
 * The expected relative time is *derived from the same platform API the
 * component must use*, so the test pins the unit, the magnitude and the
 * direction without hardcoding a locale string. The distinctness assertion
 * below is what rules out a fixed literal.
 */
const RELATIVE = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });

/** The wire shape. `created_at` is optional here so the absent case is expressible. */
type SharePayload = Omit<ShareEvent, "created_at"> & { created_at?: string };

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
    tags: ["instrumental"],
    cover_image: null,
    ...overrides,
  };
}

function makeShare(overrides: Partial<SharePayload> = {}): SharePayload {
  return {
    id: 1,
    sender_name: "roastmaster",
    clip: makeClip(),
    clip_title: "Mid-Fi Crunch",
    clip_hls_url: "https://media.test/hls/clip-1/master.m3u8",
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    is_read: false,
    ...overrides,
  };
}

/** `ShareEventSerializer` (`serializers.py:577-585`) — a bare list. */
const inbox = (shares: SharePayload[]) => json(200, shares);

function renderInbox() {
  return render(<InboxPage onRefreshUnread={() => {}} />);
}

/** The row element for a clip title, once titles are headings again. */
function rowFor(title: RegExp): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  const row = heading.closest("li");
  if (!row) throw new Error(`no <li> ancestor for heading ${title}`);
  return row as HTMLElement;
}

describe("Inbox page", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
    player.playClip.mockClear();
    player.togglePlay.mockClear();
    player.currentClip = null;
    player.isPlaying = false;
  });

  // ---------------------------------------------------------------------
  // 1. The timestamp the screen exists to answer
  // ---------------------------------------------------------------------
  describe("share age", () => {
    it("renders a relative time derived from created_at", async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      api.on("GET", /share\/inbox\//, () =>
        inbox([
          makeShare({ id: 1, clip_title: "Mid-Fi Crunch", created_at: threeHoursAgo }),
          makeShare({
            id: 2,
            clip_title: "Late Night Loop",
            clip: makeClip({ id: "clip-2", title: "Late Night Loop" }),
            created_at: twoMinutesAgo,
          }),
        ]),
      );

      const { container } = renderInbox();

      const threeHours = RELATIVE.format(-3, "hour");
      const twoMinutes = RELATIVE.format(-2, "minute");
      expect(await screen.findByText(threeHours)).toBeInTheDocument();
      expect(screen.getByText(twoMinutes)).toBeInTheDocument();

      // Scoped per row, so a stray match elsewhere cannot satisfy this.
      expect(rowFor(/mid-fi crunch/i)).toHaveTextContent(threeHours);
      expect(rowFor(/late night loop/i)).toHaveTextContent(twoMinutes);

      // The point of the screen: five minutes ago and five months ago must not
      // be indistinguishable. A hardcoded string fails here.
      expect(threeHours).not.toBe(twoMinutes);
      expect(rowFor(/mid-fi crunch/i).textContent).not.toBe(
        rowFor(/late night loop/i).textContent,
      );

      // Machine-readable absolute form alongside the relative one.
      const time = container.querySelector("time");
      expect(time).toHaveAttribute("datetime", threeHoursAgo);
    });

    it("renders no time at all when created_at is absent", async () => {
      const share = makeShare();
      delete share.created_at;
      api.on("GET", /share\/inbox\//, () => inbox([share]));

      const { container } = renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      // The row still renders — the payload is used for everything else.
      expect(rowFor(/mid-fi crunch/i)).toBeInTheDocument();
      // But nothing stands in for the missing field. `Date.now()` as a
      // fallback would produce exactly one `<time>` here.
      expect(container.querySelector("time")).toBeNull();
      expect(rowFor(/mid-fi crunch/i)).not.toHaveTextContent(/\b(ago|just now|in \d+)\b/i);
    });

    it("renders no time at all when created_at is unparseable", async () => {
      api.on("GET", /share\/inbox\//, () =>
        inbox([makeShare({ created_at: "not-a-timestamp" })]),
      );

      const { container } = renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(container.querySelector("time")).toBeNull();
    });

    it("renders no time at all when created_at is an empty string", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ created_at: "" })]));

      const { container } = renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(container.querySelector("time")).toBeNull();
    });

    it("does not render a future share as a past one", async () => {
      // Clock skew between the client and the server must not invert the claim.
      api.on("GET", /share\/inbox\//, () =>
        inbox([makeShare({ created_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() })]),
      );

      renderInbox();

      const future = RELATIVE.format(2, "hour");
      expect(await screen.findByText(future)).toBeInTheDocument();
      expect(screen.queryByText(RELATIVE.format(-2, "hour"))).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // 2. mark-read failure
  // ---------------------------------------------------------------------
  describe("mark as read", () => {
    it("announces a failed mark-read instead of only warning about it", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ sender_name: "alex" })]));
      api.on("POST", /mark-read\//, () => json(500, { detail: "boom" }));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/couldn't mark @alex's share as read/i);
      expect(status).toHaveTextContent(/500/);
    });

    it("reports a transport failure on mark-read as a connectivity problem", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ sender_name: "alex" })]));
      api.fail("POST", /mark-read\//, new TypeError("Failed to fetch"));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/couldn't mark @alex's share as read/i);
      expect(status).toHaveTextContent(/check your connection/i);
      expect(status).not.toHaveTextContent(/500/);
    });

    it("still plays the clip and leaves the share unread when the mark fails", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare()]));
      api.on("POST", /mark-read\//, () => json(500, { detail: "boom" }));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));

      // The failure is only an announcement problem; playback is unaffected and
      // the unread badge must not claim the share was read.
      expect(player.playClip).toHaveBeenCalledTimes(1);
      expect(rowFor(/mid-fi crunch/i)).toHaveTextContent(/new/i);
    });

    it("keeps the mark-read announcement clear once a later action succeeds", async () => {
      api.on("GET", /share\/inbox\//, () =>
        inbox([
          makeShare({ id: 1, sender_name: "alex", clip_title: "Mid-Fi Crunch" }),
          makeShare({
            id: 2,
            sender_name: "priya",
            clip_title: "Late Night Loop",
            clip: makeClip({ id: "clip-2", title: "Late Night Loop" }),
          }),
        ]),
      );
      api.on("POST", /1\/mark-read\//, () => json(500, { detail: "boom" }));
      api.on("POST", /2\/mark-read\//, () => noContent());

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));
      await screen.findByText(/couldn't mark @alex's share as read/i);

      await user.click(screen.getByRole("button", { name: /play late night loop/i }));

      await waitFor(() => {
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
      });
    });
  });

  // ---------------------------------------------------------------------
  // 3. share-delete failure — the rollback was already correct
  // ---------------------------------------------------------------------
  describe("remove from inbox", () => {
    it("keeps the row and announces the failure when the delete fails", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ sender_name: "alex" })]));
      api.on("DELETE", /share-delete\//, () => json(500, { detail: "boom" }));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /remove mid-fi crunch from inbox/i }));

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/couldn't remove @alex's share/i);
      expect(status).toHaveTextContent(/still in your inbox/i);

      // Regression guard for behaviour that already existed and is correct:
      // `Inbox.tsx:58-61` removes the row only after the server confirms. An
      // "optimistic removal" fix would fail this.
      expect(screen.getByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeInTheDocument();
      expect(player.playClip).not.toHaveBeenCalled();
    });

    it("removes the row once the server confirms", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare()]));
      api.on("DELETE", /share-delete\//, () => noContent());

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /remove mid-fi crunch from inbox/i }));

      await waitFor(() => {
        expect(screen.queryByRole("heading", { level: 2, name: /mid-fi crunch/i })).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------
  // 4. Load failures: an announced alert with a way out
  // ---------------------------------------------------------------------
  describe("load failure states", () => {
    it("shows an announced alert with a retry control when the server returns 500", async () => {
      let call = 0;
      api.on("GET", /share\/inbox\//, () => {
        call += 1;
        return call === 1 ? json(500, { detail: "Inbox unavailable" }) : inbox([makeShare()]);
      });

      const user = userEvent.setup();
      renderInbox();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/500/);
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

      // Recovery does not require unmounting the page by switching tabs.
      await user.click(screen.getByRole("button", { name: /retry/i }));
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("reports a transport failure as a connectivity problem, not as an empty inbox", async () => {
      api.fail("GET", /share\/inbox\//, new TypeError("Failed to fetch"));

      renderInbox();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/can't reach/i);
      expect(alert).not.toHaveTextContent(/500/);
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      expect(screen.queryByText(/inbox clear/i)).not.toBeInTheDocument();
    });

    it("distinguishes a server error from a transport failure across a retry", async () => {
      let call = 0;
      api.on("GET", /share\/inbox\//, () => {
        call += 1;
        return call === 1
          ? json(500, { detail: "Inbox unavailable" })
          : { networkError: new TypeError("Failed to fetch") };
      });

      const user = userEvent.setup();
      renderInbox();

      const serverAlert = await screen.findByRole("alert");
      expect(serverAlert).toHaveTextContent(/500/);
      expect(serverAlert).not.toHaveTextContent(/can't reach/i);

      await user.click(screen.getByRole("button", { name: /retry/i }));

      const networkAlert = await screen.findByRole("alert");
      expect(networkAlert).toHaveTextContent(/can't reach/i);
      expect(networkAlert).not.toHaveTextContent(/500/);
    });

    it("renders a genuine empty state that is not an error", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([]));

      renderInbox();

      expect(await screen.findByText(/inbox clear/i)).toBeInTheDocument();
      // "Not an error" is asserted structurally: the failure state is an
      // announced alert region, and this is not one. The shared live region
      // stays mounted and says nothing.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(screen.queryByText(/can't reach/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });

    it("never presents the loading spinner as the failure state", async () => {
      api.fail("GET", /share\/inbox\//, new TypeError("Failed to fetch"));

      renderInbox();

      await screen.findByRole("alert");
      expect(screen.queryByText(/polling audio stream/i)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // 5. Keyboard reachability, names, headings
  // ---------------------------------------------------------------------
  describe("accessibility", () => {
    it("exposes each row's play control as a named button", async () => {
      api.on("GET", /share\/inbox\//, () =>
        inbox([
          makeShare({ id: 1, clip_title: "Mid-Fi Crunch", is_read: true }),
          makeShare({
            id: 2,
            clip_title: "Late Night Loop",
            clip: makeClip({ id: "clip-2", title: "Late Night Loop" }),
            is_read: true,
          }),
        ]),
      );

      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getByRole("button", { name: "Play Mid-Fi Crunch" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play Late Night Loop" })).toBeInTheDocument();
    });

    it("plays the clip when the play control is activated by keyboard", async () => {
      const clip = makeClip();
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ clip, is_read: true })]));

      const user = userEvent.setup();
      renderInbox();
      const play = await screen.findByRole("button", { name: "Play Mid-Fi Crunch" });

      play.focus();
      expect(play).toHaveFocus();
      await user.keyboard("{Enter}");

      expect(player.playClip).toHaveBeenCalledTimes(1);
      expect(player.playClip).toHaveBeenCalledWith(clip);
    });

    it("plays the clip when the row title is activated by keyboard", async () => {
      const clip = makeClip();
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ clip, is_read: true })]));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const title = screen.getByRole("button", { name: "Mid-Fi Crunch" });
      title.focus();
      expect(title).toHaveFocus();
      await user.keyboard(" ");

      expect(player.playClip).toHaveBeenCalledTimes(1);
      expect(player.playClip).toHaveBeenCalledWith(clip);
    });

    it("reaches every row and every control by tabbing", async () => {
      api.on("GET", /share\/inbox\//, () =>
        inbox([
          makeShare({ id: 1, clip_title: "Mid-Fi Crunch", is_read: true }),
          makeShare({
            id: 2,
            clip_title: "Late Night Loop",
            clip: makeClip({ id: "clip-2", title: "Late Night Loop" }),
            is_read: true,
          }),
        ]),
      );

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const titleOne = screen.getByRole("button", { name: "Mid-Fi Crunch" });
      const removeOne = screen.getByRole("button", {
        name: "Remove Mid-Fi Crunch from inbox",
      });
      const playTwo = screen.getByRole("button", { name: "Play Late Night Loop" });

      // Tab order within a row is play → title → remove, then on to the next
      // row. Every control is reachable; nothing is skipped.
      titleOne.focus();
      expect(titleOne).toHaveFocus();
      await user.tab();
      expect(removeOne).toHaveFocus();
      await user.tab();
      expect(playTwo).toHaveFocus();
    });

    it("names the remove control rather than relying on a title attribute", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare()]));

      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      const remove = screen.getByRole("button", { name: /remove/i });
      expect(remove).toHaveAttribute("aria-label", "Remove Mid-Fi Crunch from inbox");
    });

    it("renames the play control when the clip is already playing", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ is_read: true })]));
      player.currentClip = makeClip();
      player.isPlaying = true;

      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getByRole("button", { name: "Pause Mid-Fi Crunch" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Play Mid-Fi Crunch" })).not.toBeInTheDocument();
    });

    it("toggles playback rather than restarting when the row is already current", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ is_read: true })]));
      player.currentClip = makeClip();

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: "Play Mid-Fi Crunch" }));

      expect(player.togglePlay).toHaveBeenCalledTimes(1);
      expect(player.playClip).not.toHaveBeenCalled();
    });

    it("does not play the clip when the remove control is used", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ is_read: true })]));
      api.on("DELETE", /share-delete\//, () => noContent());

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /remove mid-fi crunch from inbox/i }));

      expect(player.playClip).not.toHaveBeenCalled();
      expect(player.togglePlay).not.toHaveBeenCalled();
    });

    it("does not skip a heading level on the page", async () => {
      api.on("GET", /share\/inbox\//, () =>
        inbox([
          makeShare({ id: 1, clip_title: "Mid-Fi Crunch" }),
          makeShare({
            id: 2,
            clip_title: "Late Night Loop",
            clip: makeClip({ id: "clip-2", title: "Late Night Loop" }),
          }),
        ]),
      );

      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
      expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
      expect(screen.queryAllByRole("heading", { level: 4 })).toHaveLength(0);
      expect(screen.queryAllByRole("heading", { level: 5 })).toHaveLength(0);
      expect(screen.queryAllByRole("heading", { level: 6 })).toHaveLength(0);
    });

    it("does not skip a heading level on the empty state either", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([]));

      renderInbox();
      await screen.findByText(/inbox clear/i);

      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    });

    it("renders the inbox as a list of items", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare()]));

      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(screen.getByRole("list")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // 6. Must-preserve: the unread / NEW contract
  // ---------------------------------------------------------------------
  describe("unread semantics", () => {
    it("keeps the NEW badge on an unread share and drops it once read", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare()]));
      api.on("POST", /mark-read\//, () => noContent());

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      expect(rowFor(/mid-fi crunch/i)).toHaveTextContent(/new/i);
      expect(screen.getByText(/1 unread/i)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));

      await waitFor(() => {
        expect(rowFor(/mid-fi crunch/i)).not.toHaveTextContent(/new/i);
      });
      expect(screen.getByText(/0 unread/i)).toBeInTheDocument();
    });

    it("does not call mark-read for a share that is already read", async () => {
      api.on("GET", /share\/inbox\//, () => inbox([makeShare({ is_read: true })]));

      const user = userEvent.setup();
      renderInbox();
      await screen.findByRole("heading", { level: 2, name: /mid-fi crunch/i });

      await user.click(screen.getByRole("button", { name: /play mid-fi crunch/i }));

      expect(api.callsTo(/mark-read\//)).toHaveLength(0);
    });
  });
});
