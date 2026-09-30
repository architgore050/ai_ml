import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { installFetchMock, type FetchMock } from "./fetchMock";
import { ShareModal } from "../components/sharing/ShareModal";
import type { FeedClip } from "../types/echoflow";

/**
 * `ShareModal` defects, findings #1-#6 of RECON-03 and F9/F13/F14/F15 of
 * RECON-04, plus the a11y items RECON-06 attributes to this file.
 *
 * The headline item is not cosmetic. The component shipped four hardcoded
 * "Network Peers" whose `id`s are real `User` primary keys, rendered whenever
 * no search result was present, each with a live Stream button wired to
 * `POST /share/{id}/send-share/`. `views/social.py:164` resolves that id with
 * `get_object_or_404(User, id=receiver_id)`, so one tap wrote a real
 * `ShareEvent`, bumped `AudioClip.shares`, and put an unread item in a
 * stranger's inbox — and the UI then showed a green "Sent". There is no peer
 * or suggestion endpoint anywhere in the codebase, so the only honest
 * fallback is to render nothing.
 *
 * The other four are all "the UI asserted something the server never said":
 * a "Sent" that belonged to a different clip, an unguarded double-tap against
 * a server with no dedupe, four distinct failures collapsed into "Peer
 * listener not found in directory.", and a green "Copied" over a clipboard
 * write that was never awaited.
 */

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

const PEER = { id: 88, username: "roastmaster" };

function renderModal(clip: FeedClip | null = makeClip(), onClose = () => {}) {
  return render(<ShareModal clip={clip} isOpen onClose={onClose} />);
}

/** Search for `PEER.username` and resolve the lookup. */
async function searchForPeer(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: /listener|username/i }), PEER.username);
  await user.click(screen.getByRole("button", { name: /search/i }));
  await screen.findByRole("button", { name: /^stream$/i });
}

/** `userEvent.setup()` stubs `navigator.clipboard`; force a real failure. */
function rejectClipboardWrite(rejection: unknown) {
  const writeText = vi.fn(() => Promise.reject(rejection));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("ShareModal — invented recipients", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  it("offers no recipient at all before a search succeeds", async () => {
    // THE regression. `DEFAULT_PEERS` rendered four rows whose ids are real
    // `User` PKs, so this screen shipped a one-tap path to writing a
    // `ShareEvent` for an arbitrary stranger.
    renderModal();

    // No fabricated username anywhere on screen.
    for (const invented of ["alex", "roastmaster", "curiosity_lab", "stoic_focus"]) {
      expect(screen.queryByText(new RegExp(`@?${invented}`, "i"))).not.toBeInTheDocument();
    }
    // And nothing that could dispatch a share.
    expect(screen.queryByRole("button", { name: /stream/i })).not.toBeInTheDocument();
    expect(api.callsTo(/send-share/)).toHaveLength(0);

    // The honest alternative: say what to do next.
    expect(
      screen.getByText(/search for a listener by username/i),
    ).toBeInTheDocument();
  });

  it("never reaches send-share while there is no search result", async () => {
    // jsdom does not implement implicit submission from Enter, so the form is
    // driven through its submit button, the way a pointer user does it.
    api.on("GET", /find-user/, () => ({ status: 404, body: { error: "No user found: @ghost" } }));

    const user = userEvent.setup();
    renderModal();

    const field = screen.getByRole("textbox", { name: /listener|username/i });
    await user.type(field, "ghost");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await user.click(screen.getByRole("button", { name: /search/i }));
      // A 404 leaves nothing to act on.
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: /stream|sent/i })).not.toBeInTheDocument();
    }

    expect(api.callsTo(/find-user/)).toHaveLength(3);
    expect(api.callsTo(/send-share/)).toHaveLength(0);
  });
});

describe("ShareModal — the find-user → Stream flow", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  it("sends exactly one share, to the id the lookup returned", async () => {
    // The id must come from the response body. Hardcoding it is the same
    // fabrication as `DEFAULT_PEERS`, one indirection away.
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, () => ({ status: 201, body: { status: "shared successfully" } }));

    const user = userEvent.setup();
    renderModal(makeClip({ id: "clip-42" }));
    await searchForPeer(user);

    await user.click(screen.getByRole("button", { name: /^stream$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sent/i })).toBeInTheDocument();
    });

    const sends = api.callsTo(/send-share/);
    // One call, the right clip, POST, and the id the *server* returned.
    expect(sends).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/clip-42/),
        method: "POST",
        body: { receiver_id: PEER.id },
      }),
    ]);
  });

  it("sends one share when Stream is double-tapped", async () => {
    // `services/shares.py:31` is an unconditional `ShareEvent.objects.create`
    // with no dedupe, and the old handler flipped `sentUsers` only *after* the
    // await — so a double-tap wrote two inbox rows and bumped the counter
    // twice. The only guard is client-side, so it has to be in the handler.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, async () => {
      await gate;
      return { status: 201, body: { status: "shared successfully" } };
    });

    const user = userEvent.setup();
    renderModal();
    await searchForPeer(user);

    const stream = screen.getByRole("button", { name: /stream|sending/i });
    await user.click(stream);
    await user.click(stream);
    await user.click(stream);

    expect(api.callsTo(/send-share/)).toHaveLength(1);

    release?.();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sent/i })).toBeInTheDocument();
    });
  });

  it("marks the row unavailable while the share is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, async () => {
      await gate;
      return { status: 201, body: { status: "shared successfully" } };
    });

    const user = userEvent.setup();
    renderModal();
    await searchForPeer(user);

    await user.click(screen.getByRole("button", { name: /stream/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sending/i })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

    release?.();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sent/i })).toBeInTheDocument();
    });
  });

  it("surfaces a failed share instead of leaving the button reading Stream", async () => {
    // The old catch was `console.warn` only, so a 403 "This clip may not be
    // shared" was indistinguishable from success until the user checked their
    // inbox. RECON-06 #13 lists this as a silent failure on a core step.
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, () => ({
      status: 403,
      body: { error: "This clip may not be shared" },
    }));

    const user = userEvent.setup();
    renderModal();
    await searchForPeer(user);

    await user.click(screen.getByRole("button", { name: /^stream$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/may not be shared/i);
    // Still offered, because nothing was sent.
    expect(screen.getByRole("button", { name: /^stream$/i })).toBeInTheDocument();
  });

  it("can retry after a failed share", async () => {
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, () => ({ status: 500, body: { error: "boom" } }));

    const user = userEvent.setup();
    renderModal();
    await searchForPeer(user);

    await user.click(screen.getByRole("button", { name: /^stream$/i }));
    await screen.findByRole("alert");
    expect(api.callsTo(/send-share/)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /^stream$/i }));
    await waitFor(() => {
      expect(api.callsTo(/send-share/)).toHaveLength(2);
    });
  });
});

describe("ShareModal — state must not leak between clips", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  function MountedHarness() {
    // Mirrors `Feed.tsx:179-183`: one mounted instance, `isOpen` flips, and
    // `clip` is the source of the "which clip is this" identity.
    const [selected, setSelected] = useState<FeedClip | null>(null);
    return (
      <>
        <button type="button" onClick={() => setSelected(makeClip({ id: "clip-a" }))}>
          Share clip A
        </button>
        <button type="button" onClick={() => setSelected(makeClip({ id: "clip-b" }))}>
          Share clip B
        </button>
        <ShareModal
          clip={selected}
          isOpen={selected !== null}
          onClose={() => setSelected(null)}
        />
      </>
    );
  }

  it("shows Stream again for a different clip", async () => {
    // RECON-04 F9. `sentUsers` was keyed on the recipient alone and the
    // component is never unmounted, so the row stayed disabled and green for
    // every later clip.
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, () => ({ status: 201, body: { status: "shared successfully" } }));

    const user = userEvent.setup();
    render(<MountedHarness />);

    await user.click(screen.getByRole("button", { name: /share clip a/i }));
    await searchForPeer(user);
    await user.click(screen.getByRole("button", { name: /^stream$/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sent/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(screen.getByRole("button", { name: /share clip b/i }));

    // Fresh dialog, fresh recipient state, and no leftover "Sent".
    expect(screen.queryByRole("button", { name: /sent/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/search for a listener by username/i),
    ).toBeInTheDocument();
  });

  it("does not mark a new clip as sent when the previous share resolves late", async () => {
    // The in-flight request outlives the close. Its `setState` lands after the
    // reset, so a recipient-only key would poison the *new* clip's row.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));
    api.on("POST", /send-share/, async () => {
      await gate;
      return { status: 201, body: { status: "shared successfully" } };
    });

    const user = userEvent.setup();
    render(<MountedHarness />);

    await user.click(screen.getByRole("button", { name: /share clip a/i }));
    await searchForPeer(user);
    await user.click(screen.getByRole("button", { name: /stream|sending/i }));
    expect(api.callsTo(/send-share/)).toHaveLength(1);

    // Close and reopen for a different clip while the request is still open.
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(screen.getByRole("button", { name: /share clip b/i }));

    release?.();

    await waitFor(() => {
      expect(api.callsTo(/send-share/)).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /sent/i })).not.toBeInTheDocument();

    // And clip B can still be shared to the same person.
    await searchForPeer(user);
    await user.click(screen.getByRole("button", { name: /^stream$/i }));
    await waitFor(() => {
      expect(api.callsTo(/send-share/)).toHaveLength(2);
    });
  });
});

describe("ShareModal — honest failure reporting", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  it("does not claim the listener was not found when the server 500s", async () => {
    // `client.ts` reads a 5xx body as text; with DEBUG=False that is the whole
    // HTML error page. Whatever the body, a 5xx is not "not found".
    api.on("GET", /find-user/, () => ({
      status: 500,
      body: "<html><h1>Server Error (500)</h1></html>",
      headers: { "content-type": "text/html" },
    }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByRole("textbox", { name: /listener|username/i }), "ghost");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/server/i);
    expect(alert).not.toHaveTextContent(/not found/i);
  });

  it("reports a transport failure as a network failure", async () => {
    // No `status` on the error at all: fetch never got a response. Nothing is
    // known about whether the username exists.
    api.fail("GET", /find-user/, new TypeError("Failed to fetch"));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByRole("textbox", { name: /listener|username/i }), "ghost");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not reach the server|connection/i);
    expect(alert).not.toHaveTextContent(/not found/i);
  });

  it("distinguishes a throttled search from a missing listener", async () => {
    api.on("GET", /find-user/, () => ({
      status: 429,
      body: { error: "Request was throttled." },
      headers: { "retry-after": "60" },
    }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByRole("textbox", { name: /listener|username/i }), "ghost");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too many|wait a moment|throttl/i);
    expect(alert).not.toHaveTextContent(/not found/i);
  });

  it("does report a genuine 404 as a missing listener", async () => {
    // The control for the three above: when the server really says 404,
    // "not found" is the true message and must still be shown.
    api.on("GET", /find-user/, () => ({ status: 404, body: { error: "No user found: @ghost" } }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByRole("textbox", { name: /listener|username/i }), "ghost");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no user found|not found/i);
  });

  it("rejects a self-share with the server's own reason", async () => {
    // `views/social.py:122` returns 400 {"error": "You can't share with
    // yourself"}. Collapsing that into "not found" was the whole defect.
    api.on("GET", /find-user/, () => ({
      status: 400,
      body: { error: "You can't share with yourself" },
    }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByRole("textbox", { name: /listener|username/i }), "me");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/share with yourself/i);
  });
});

describe("ShareModal — clipboard honesty", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  it("confirms the copy only when the write resolved", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole("button", { name: /copy audio reel link/i }));

    await waitFor(() => {
      expect(screen.getByText(/direct stream url copied/i)).toBeInTheDocument();
    });
  });

  it("does not claim success when the clipboard write rejects", async () => {
    // The old handler never awaited `writeText` and had no `.catch`, so a
    // permission rejection became an unhandled promise rejection *and* the
    // button still said "Copied".
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      const user = userEvent.setup();
      // `userEvent.setup()` installs its own clipboard stub, so the double has
      // to be layered on top of it rather than before it.
      const writeText = rejectClipboardWrite(new DOMException("denied", "NotAllowedError"));

      renderModal();
      await user.click(screen.getByRole("button", { name: /copy audio reel link/i }));

      await waitFor(() => {
        expect(screen.getByText(/clipboard/i)).toBeInTheDocument();
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
      // The promise is handled, so nothing escapes to the window.
      expect(rejections).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });

  it("does not claim success when the clipboard API is unavailable", async () => {
    // `navigator.clipboard` is `undefined` on a non-secure origin
    // (`http://<LAN-IP>:5173`), where the old handler threw synchronously and
    // the crash skipped `setCopied` — leaving the button mid-transition with no
    // feedback at all.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    renderModal();
    await user.click(screen.getByRole("button", { name: /copy audio reel link/i }));

    await waitFor(() => {
      expect(screen.getByText(/clipboard/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
  });
});

describe("ShareModal — accessibility", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
  });

  it("gives the username field an accessible name", async () => {
    // The `<label>` had no `htmlFor` and the `<input>` no `id` — the field's
    // accessible name fell back to the placeholder, so its purpose was never
    // announced.
    renderModal();

    const field = screen.getByRole("textbox", { name: /listener|username/i });
    expect(field).toHaveAccessibleName(/find listener by username/i);

    const label = document.querySelector(`label[for="${field.id}"]`);
    expect(label).not.toBeNull();
    expect(field.id).not.toBe("");
  });

  it("names the two icon-only buttons", async () => {
    renderModal();

    // Both were icon-only with no text, no `aria-label` and no `title`, so a
    // screen reader announced "button" for each.
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  it("associates the search error with the field that caused it", async () => {
    api.on("GET", /find-user/, () => ({ status: 404, body: { error: "No user found: @ghost" } }));

    const user = userEvent.setup();
    renderModal();

    const field = screen.getByRole("textbox", { name: /listener|username/i });
    expect(field).not.toHaveAttribute("aria-invalid");

    await user.type(field, "ghost");
    await user.click(screen.getByRole("button", { name: /search/i }));

    const alert = await screen.findByRole("alert");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).not.toBe("");
  });

  it("exposes itself as a modal dialog with a real title", () => {
    renderModal();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy as string);
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent(/dispatch to peer queue/i);
  });

  it("moves focus into the dialog on open", async () => {
    renderModal();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveFocus();
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    renderModal(makeClip(), onClose);

    const user = userEvent.setup();
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger when it closes", async () => {
    const onClose = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open share
          </button>
          <ShareModal
            clip={makeClip()}
            isOpen={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          />
        </>
      );
    }

    const user = userEvent.setup();
    render(<Host />);
    const trigger = screen.getByRole("button", { name: /open share/i });

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
    api.on("GET", /find-user/, () => ({ status: 200, body: PEER }));

    const user = userEvent.setup();
    renderModal();
    await searchForPeer(user);

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

    // Forward from the last control wraps to the first.
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    // Backward from the first control wraps to the last.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("does not leave the modal body unnamed or unlabelled", () => {
    const { container } = renderModal();

    // The dialog is labelled by the <h3>; nothing in the panel is a bare
    // heading-less region any more.
    const heading = within(container).getByRole("heading", { level: 3 });
    expect(heading.id).not.toBe("");
  });
});
