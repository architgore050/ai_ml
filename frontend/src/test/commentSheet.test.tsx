import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { installFetchMock, type FetchMock } from "./fetchMock";
import { CommentSheet } from "../components/comments/CommentSheet";
import type { FeedClip } from "../types/echoflow";

/**
 * `CommentSheet` — findings #11-#13 and #30-#31 of RECON-03, F3/F4 of
 * RECON-04, and the CommentSheet rows of RECON-06 §2/§3/§4/§5/§6/§8.
 *
 * The two HIGH items are the same defect wearing different clothes: a failure
 * was rendered as a fact.
 *
 *  - The fetch's `catch` was `console.warn`, leaving `comments` at `[]`. The
 *    list then rendered "No comments yet / Be the first to share your reaction
 *    on this audio reel" — on a thread with 340 comments, whose real total was
 *    on the `ReelCard` button the user had just tapped. The app showed two
 *    different numbers for one fact and the copy invited a duplicate comment.
 *  - The POST's `catch` was `console.warn` too. The draft was correctly kept,
 *    so a retry was possible, but nothing said the send had failed: a user on a
 *    flaky connection would reasonably assume it posted.
 *
 * Both are load-time/post-time lies, so the fix is three distinct states
 * (loading, error, genuinely empty) plus an announced, retryable failure for
 * each write — not more `console.warn`.
 *
 * The header count was a page length. `CommentCursorPagination.page_size` is 20
 * (`views/_pagination.py:10-12`), the frontend fetches exactly one page and
 * discards `next`, so "Discussions (20)" sat under a reel labelled 340.
 *
 * And the list was flat: `parent` was never read, so replies rendered as
 * top-level siblings indistinguishable from roots, and the `reply_count` the
 * serializer supplies was thrown away.
 */

const mockUser = { id: 7, username: "me", email: "me@example.com" };

vi.mock("../stores/auth", () => ({
  useAuth: () => ({ user: mockUser, profile: null, isAuthenticated: true }),
}));

const VIEWER_ID = 7;
const OTHER_ID = 42;

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const REPLY_ID = "22222222-2222-4222-8222-222222222222";
const ORPHAN_REPLY_ID = "33333333-3333-4333-8333-333333333333";
/** A parent that is NOT in the fetched page — the common case at a page edge. */
const OFF_PAGE_PARENT_ID = "44444444-4444-4444-8444-444444444444";

interface CommentPayload {
  id: string;
  clip: string;
  author_username: string;
  author_id: number;
  parent: string | null;
  text: string;
  reply_count: number;
  created_at: string;
}

function makeComment(overrides: Partial<CommentPayload> = {}): CommentPayload {
  return {
    id: PARENT_ID,
    clip: "clip-a",
    author_username: "alice",
    author_id: OTHER_ID,
    parent: null,
    text: "this loop is unreal",
    reply_count: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-a",
    title: "A clip",
    creator_name: "midnight_dj",
    creator_id: 3,
    category: "music",
    hls_playlist_url: "https://media.example/hls/clip-a/master.m3u8",
    likes: 3,
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

let api: FetchMock;

/**
 * Register `GET /comments/`, branching on the `parent` query parameter the way
 * the real endpoint does (`views/comments.py:52` filterset_fields).
 */
function mockCommentPage(rootResults: CommentPayload[], next: string | null = null) {
  return api.on("GET", /comments/, ({ url }) => {
    const parentMatch = /[?&]parent=([^&]+)/.exec(url);
    if (parentMatch) {
      const parentId = decodeURIComponent(parentMatch[1] as string);
      return {
        status: 200,
        body: {
          next: null,
          previous: null,
          results: rootResults.filter((c) => c.parent === parentId),
        },
      };
    }
    return { status: 200, body: { next, previous: null, results: rootResults } };
  });
}

async function renderSheet(clip: FeedClip = makeClip(), onClose: () => void = () => {}) {
  const user = userEvent.setup();
  render(<CommentSheet clip={clip} isOpen onClose={onClose} />);
  return user;
}

describe("CommentSheet — a failed load is not an empty thread", () => {
  beforeEach(() => {
    api = installFetchMock();
  });

  it("shows an error with a retry control instead of the empty-state copy", async () => {
    api.fail("GET", /comments/, new TypeError("NetworkError"));

    const user = await renderSheet(makeClip({ comment_count: 340 }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not load comments/i);

    // The load-time lie: a failed request rendered "No comments yet / Be the
    // first to share your reaction" on a thread with 340 comments.
    expect(screen.queryByText(/no comments yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/be the first to share/i)).not.toBeInTheDocument();

    // And a control that actually retries.
    const retry = within(alert).getByRole("button", { name: /try again/i });
    expect(retry).toBeEnabled();
    await user.click(retry);
  });

  it("re-runs the fetch when the retry control is used", async () => {
    let attempt = 0;
    api.on("GET", /comments/, () => {
      attempt += 1;
      if (attempt === 1) return { networkError: new TypeError("NetworkError") };
      return { status: 200, body: { next: null, previous: null, results: [makeComment()] } };
    });

    const user = await renderSheet();
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/this loop is unreal/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows the empty state only when the page really is empty", async () => {
    mockCommentPage([]);

    await renderSheet();

    expect(await screen.findByText(/no comments yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discards a response that arrives after the sheet moved to another clip", async () => {
    // `Feed.tsx` selects one clip at a time, so moving on means closing the
    // sheet and opening it on the next reel while the first request is still in
    // flight. Without a guard the slow response lands last and the previous
    // clip's comments are rendered under this clip's title.
    let call = 0;
    const release: { first: (() => void) | null } = { first: null };
    api.on("GET", /comments/, async () => {
      call += 1;
      if (call === 1) {
        await new Promise<void>((resolve) => {
          release.first = resolve;
        });
        return {
          status: 200,
          body: {
            next: null,
            previous: null,
            results: [makeComment({ text: "stale, from the previous clip" })],
          },
        };
      }
      return {
        status: 200,
        body: {
          next: null,
          previous: null,
          results: [makeComment({ text: "the comment on THIS clip" })],
        },
      };
    });

    function Host() {
      const [open, setOpen] = useState(false);
      const [clipId, setClipId] = useState("clip-a");
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open A
          </button>
          <button
            type="button"
            onClick={() => {
              setClipId("clip-b");
              setOpen(true);
            }}
          >
            Open B
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
          <CommentSheet
            clip={open ? makeClip({ id: clipId }) : null}
            isOpen={open}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }

    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByRole("button", { name: /open a/i }));
    await screen.findByText(/loading thoughts/i);
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    await user.click(screen.getByRole("button", { name: /open b/i }));
    expect(await screen.findByText(/the comment on THIS clip/i)).toBeInTheDocument();

    // The first request now completes, far too late to be relevant.
    release.first?.();
    await waitFor(() => {
      expect(screen.queryByText(/stale, from the previous clip/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/the comment on THIS clip/i)).toBeInTheDocument();
  });
});

describe("CommentSheet — the header count is a total, not a page length", () => {
  beforeEach(() => {
    api = installFetchMock();
  });

  it("reads clip.comment_count, not the 20 rows it fetched", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) =>
      makeComment({ id: `c-${i}`, text: `comment number ${i}` }),
    );
    mockCommentPage(twenty, "http://localhost:18000/comments/?cursor=abc");

    await renderSheet(makeClip({ comment_count: 340 }));

    const heading = screen.getByRole("heading", { level: 2 });
    await waitFor(() => {
      expect(heading).toHaveTextContent(/340/);
    });
    expect(heading).not.toHaveTextContent(/\(20\)/);
  });

  it("says plainly that older comments are not loaded", async () => {
    mockCommentPage([makeComment()], "http://localhost:18000/comments/?cursor=abc");

    await renderSheet(makeClip({ comment_count: 340 }));

    // `next` is discarded by `client.ts`, so the honest statement is the only
    // thing available. Claiming a total it cannot back would be a second lie.
    expect(await screen.findByText(/not loaded/i)).toHaveTextContent(/340/);
  });
});

describe("CommentSheet — replies are replies", () => {
  beforeEach(() => {
    api = installFetchMock();
  });

  it("nests a reply under its parent and surfaces reply_count", async () => {
    // The backend orders `-created_at` (`views/_pagination.py:11`), so a reply
    // is NEWER than its parent and arrives FIRST in the page. The flat renderer
    // made the two indistinguishable.
    mockCommentPage([
      makeComment({ id: REPLY_ID, parent: PARENT_ID, text: "agreed, the drop at 0:12", reply_count: 0 }),
      makeComment({ id: PARENT_ID, text: "this loop is unreal", reply_count: 1 }),
    ]);

    await renderSheet();

    const roots = await screen.findByRole("list", { name: /comments/i });
    // Direct children only: a nested reply is a listitem too, but it must not
    // be a *sibling* of the parent.
    expect(roots.querySelectorAll(":scope > li")).toHaveLength(1);
    const root = roots.querySelector(":scope > li") as HTMLElement;
    expect(within(root).getByText(/this loop is unreal/i)).toBeInTheDocument();

    const replies = within(root).getByRole("list", { name: /replies to @alice/i });
    expect(within(replies).getByText(/agreed, the drop at 0:12/i)).toBeInTheDocument();
    // Two rows are rendered, and exactly one of them is a top-level row.
    expect(within(roots).getAllByRole("listitem")).toHaveLength(2);

    // `reply_count` is supplied at `serializers.py:529-532` and was discarded.
    // All three replies are on screen here, so the count is stated rather than
    // offered as a fetch that would return nothing new.
    expect(within(root).getByText(/1 reply\b/i)).toBeInTheDocument();
  });

  it("fetches the rest of a thread when the affordance is used", async () => {
    mockCommentPage([
      makeComment({ id: REPLY_ID, parent: PARENT_ID, text: "agreed, the drop at 0:12", reply_count: 0 }),
      makeComment({ id: PARENT_ID, text: "this loop is unreal", reply_count: 3 }),
    ]);

    const user = await renderSheet();
    await screen.findByRole("list", { name: /comments/i });

    // `reply_count` is 3 and one reply is on the page, so exactly two are
    // unloaded — the affordance counts the gap, not the thread.
    await user.click(screen.getByRole("button", { name: /show 2 more replies/i }));

    // `client.ts` already supports `parent`; it was never sent.
    const parentCalls = api.callsTo(/parent=/);
    expect(parentCalls).toHaveLength(1);
    expect(parentCalls[0]?.url).toContain(`parent=${PARENT_ID}`);
  });

  it("renders a reply whose parent is off the page as a reply, not as a root", async () => {
    // A parent cut off at the bottom of the page is not a rare edge case: with
    // `-created_at` ordering the replies come first, so the parent is the row
    // that falls off. Dropping these rows would hide comments; promoting them
    // to roots would lie about the thread.
    mockCommentPage([
      makeComment({
        id: ORPHAN_REPLY_ID,
        parent: OFF_PAGE_PARENT_ID,
        author_username: "bob",
        text: "replying to someone above the page edge",
      }),
      makeComment({ id: PARENT_ID, text: "this loop is unreal", reply_count: 0 }),
    ]);

    await renderSheet();

    const roots = await screen.findByRole("list", { name: /comments/i });
    // The row is still shown — dropping it would hide a comment — but it does
    // not claim to start a discussion of its own.
    expect(roots.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(screen.getByText(/parent comment not loaded/i)).toBeInTheDocument();
  });
});

describe("CommentSheet — write failures are announced", () => {
  beforeEach(() => {
    api = installFetchMock();
  });

  it("keeps the draft and announces a failed post", async () => {
    mockCommentPage([]);
    api.on("POST", /comments/, () => ({ status: 500, body: { detail: "boom" } }));

    const user = await renderSheet();
    const field = await screen.findByRole("textbox", { name: /comment/i });

    await user.type(field, "a genuinely good take");
    await user.click(screen.getByRole("button", { name: /post comment/i }));

    // The draft survives, so a retry is possible...
    expect(screen.getByRole("textbox", { name: /comment/i })).toHaveValue(
      "a genuinely good take",
    );
    // ...and the user is told, rather than assuming it posted. The message sits
    // in a live region and is wired to the field it concerns.
    const error = await screen.findByText(/was not sent/i);
    expect(error).toHaveAttribute("role", "status");
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.id).not.toBe("");
  });

  it("keeps focus on the submit control after a failed post", async () => {
    mockCommentPage([]);
    api.on("POST", /comments/, () => ({ status: 500, body: { detail: "boom" } }));

    const user = await renderSheet();
    const field = await screen.findByRole("textbox", { name: /comment/i });
    await user.type(field, "hello");

    const submit = screen.getByRole("button", { name: /post comment/i });
    await user.click(submit);
    await screen.findByText(/was not sent/i);

    // `disabled` on submit removed the control from the tab order and dropped
    // focus to <body> — on every single submit attempt.
    expect(document.body).not.toHaveFocus();
    expect(submit).toHaveFocus();
  });

  it("announces a failed delete and leaves the row in place", async () => {
    mockCommentPage([makeComment({ author_id: VIEWER_ID })]);
    api.on("DELETE", /comments/, () => ({ status: 500, body: { detail: "boom" } }));

    const user = await renderSheet();
    await screen.findByText(/this loop is unreal/i);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    const error = await screen.findByText(/could not delete/i);
    expect(error).toHaveAttribute("role", "status");
    expect(error.getAttribute("aria-live")).toBe("polite");
    // The delete failed, so the comment is still there. Removing the row on a
    // failure would be the same lie in the other direction.
    expect(screen.getByText(/this loop is unreal/i)).toBeInTheDocument();
  });

  it("removes the row once the delete succeeds", async () => {
    mockCommentPage([makeComment({ author_id: VIEWER_ID })]);
    api.on("DELETE", /comments/, () => ({ status: 204, body: undefined }));

    const user = await renderSheet();
    await screen.findByText(/this loop is unreal/i);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/this loop is unreal/i)).not.toBeInTheDocument();
    });
  });

  it("removes a fetched reply row when that reply is deleted", async () => {
    // The reply is not in `comments`; it lives in the per-parent bundle. A
    // delete that only filtered `comments` would report success and leave the
    // row on screen.
    mockCommentPage([
      makeComment({ id: REPLY_ID, parent: PARENT_ID, author_username: "bob", author_id: VIEWER_ID, text: "delete me" }),
      makeComment({ id: PARENT_ID, text: "this loop is unreal", reply_count: 1 }),
    ]);
    api.on("DELETE", /comments/, () => ({ status: 204, body: undefined }));

    const user = await renderSheet();
    await screen.findByRole("list", { name: /comments/i });

    const replies = screen.getByRole("list", { name: /replies to @alice/i });
    await user.click(within(replies).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/delete me/i)).not.toBeInTheDocument();
    });
  });
});

describe("CommentSheet — accessibility", () => {
  // `fetchMock` resolves routes first-match-wins, so these tests each register
  // their own page rather than sharing one from `beforeEach`.
  beforeEach(() => {
    api = installFetchMock();
  });

  it("labels the composer with a real label element", async () => {
    mockCommentPage([]);
    await renderSheet();

    const field = await screen.findByRole("textbox", { name: /comment/i });
    const label = screen.getByText(/add a comment/i);

    // `htmlFor` occurred zero times app-wide; the placeholder was the only
    // name, and `placeholder-white/30` is 2.61:1 and vanishes on focus.
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe(field.id);
    expect(field.id).not.toBe("");
  });

  it("names the submit and close buttons", async () => {
    mockCommentPage([]);
    await renderSheet();

    expect(screen.getByRole("button", { name: /post comment/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();

    // The `ReelCard` defect: a button whose only content is a count is
    // announced as that count. No control in the sheet may be named by a number.
    const dialog = screen.getByRole("dialog");
    const names = within(dialog)
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim());
    for (const name of names) {
      expect(name).not.toMatch(/^\d+$/);
    }
  });

  it("exposes itself as a modal dialog with a real title", async () => {
    mockCommentPage([]);
    await renderSheet();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy as string);
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent(/discussions/i);
  });

  it("moves focus into the dialog on open", async () => {
    mockCommentPage([]);
    await renderSheet();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveFocus();
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    mockCommentPage([]);
    await renderSheet(makeClip(), onClose);

    const user = userEvent.setup();
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger when it closes", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open comments
          </button>
          <CommentSheet clip={makeClip()} isOpen={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    mockCommentPage([]);
    const user = userEvent.setup();
    render(<Host />);
    const trigger = screen.getByRole("button", { name: /open comments/i });

    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveFocus();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab inside the dialog", async () => {
    mockCommentPage([]);
    const user = await renderSheet();
    const field = await screen.findByRole("textbox", { name: /comment/i });
    await user.type(field, "hello");

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    );
    expect(focusable.length).toBeGreaterThan(2);

    const first = focusable.at(0);
    const last = focusable.at(focusable.length - 1);
    if (!first || !last) throw new Error("expected at least two focusable controls");

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("gives the three text controls a 24px minimum target", async () => {
    mockCommentPage([makeComment({ author_id: VIEWER_ID })]);
    const user = await renderSheet();
    await screen.findByText(/this loop is unreal/i);

    // WCAG 2.2 AA 2.5.8: 24x24 minimum. These were ~13px tall.
    for (const name of [/^reply$/i, /^delete$/i]) {
      const control = screen.getByRole("button", { name });
      expect(control.getAttribute("class") ?? "").toMatch(/min-h-6\b/);
    }

    await user.click(screen.getByRole("button", { name: /^reply$/i }));
    const cancel = await screen.findByRole("button", { name: /cancel/i });
    expect(cancel.getAttribute("class") ?? "").toMatch(/min-h-6\b/);
  });
});

describe("CommentSheet — author identity and time", () => {
  beforeEach(() => {
    api = installFetchMock();
  });

  it("offers delete on author_id, not on the username", async () => {
    // The old check was `user?.username === comment.author_username`, so a user
    // who renamed lost Delete on their own comments.
    mockCommentPage([
      makeComment({ author_username: "totally-different-name", author_id: VIEWER_ID }),
    ]);

    await renderSheet();

    expect(await screen.findByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("does not offer delete on someone else's comment", async () => {
    mockCommentPage([makeComment({ author_username: "alice", author_id: OTHER_ID })]);

    await renderSheet();

    await screen.findByText(/this loop is unreal/i);
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it("gives a three-week-old comment a date rather than a bare clock time", async () => {
    const createdAt = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
    mockCommentPage([makeComment({ created_at: createdAt, text: "an old one" })]);

    const { container } = render(<CommentSheet clip={makeClip()} isOpen onClose={() => {}} />);

    await screen.findByText(/an old one/i);
    const time = container.querySelector("time");
    expect(time).not.toBeNull();
    // The machine-readable form is the full ISO date.
    expect(time?.getAttribute("datetime")).toBe(createdAt);
    // The visible form is NOT a bare `HH:MM`, which is all `toLocaleTimeString`
    // gave a three-week-old comment.
    expect(time?.textContent ?? "").not.toMatch(/^\d{1,2}:\d{2}/);
  });

  it("shows a relative time for a comment from today", async () => {
    mockCommentPage([makeComment({ text: "a fresh one" })]);

    render(<CommentSheet clip={makeClip()} isOpen onClose={() => {}} />);
    await screen.findByText(/a fresh one/i);

    expect(screen.getByText(/just now|ago/i)).toBeInTheDocument();
  });

  it("renders no time at all when created_at is missing", async () => {
    // Never substitute `Date.now()` — that is the `date_joined || Date.now()`
    // anti-pattern (RECON-03 finding #8) and it fabricates account history.
    mockCommentPage([makeComment({ created_at: "", text: "undated" })]);

    const { container } = render(<CommentSheet clip={makeClip()} isOpen onClose={() => {}} />);
    await screen.findByText(/undated/i);

    expect(container.querySelector("time")).toBeNull();
    expect(screen.getByText(/undated/i)).toBeInTheDocument();
  });
});
