import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { OnboardingModal } from "../components/feed/OnboardingModal";

/**
 * `OnboardingModal` — the cold-start dialog, and the first thing a new account
 * ever sees.
 *
 * ## What it used to be
 *
 * A `<div className="fixed inset-0">` with no `role="dialog"`, no `aria-modal`,
 * no title association, no focus move, no Escape, no focus restore and no focus
 * trap. `ShareModal` and `CommentSheet` have since had exactly that treatment,
 * and this brings the third modal onto the same shape and the same names
 * (`DIALOG_TITLE_ID`, `FOCUSABLE_SELECTOR`, `handleDialogKeyDown`) so the three
 * read as one implementation.
 *
 * The tag grid conveyed its selected state by colour alone: border, ring,
 * background tint, and a `<Check>` glyph that was not exposed as state.
 *
 * The submit button was `disabled` at zero tags, which both dropped focus to
 * `<body>` (WCAG 2.4.3) and made the `selectedTags.length === 0` guard in the
 * submit handler unreachable.
 *
 * ## The vocabulary is the server's
 *
 * The dialog shipped eight hardcoded ids and preselected two of them. They were
 * `AudioClip.category` values passed to `POST /tags/initialize/` as `tags`,
 * which matches with exact JSONB containment (`tags @> '["tag"]'`). Measured:
 * zero of the eight could be matched by any clip, so every submission resolved
 * to `400 {"error": "Not enough data to build baseline."}` — and
 * `app_user.long_term_semantic` was NULL for every row, so it had never once
 * succeeded. The user was told their taste was the problem.
 *
 * The tags the pipeline actually writes are Whisper-transcript KeyBERT unigrams
 * (`backend/app/tasks.py:353-360`). The picker now renders whatever
 * `GET /tags/available/` returns — tags on more than one clip, served from the
 * same population the matcher draws from — and asserts here that no hardcoded
 * id survives in the DOM.
 *
 * ## Mock discipline
 *
 * `installFetchMock` resolves the FIRST matching route, so every test installs
 * its own instance and registers only the routes that test needs. A `beforeEach`
 * happy path registered before a per-test failure route silently shadows it, and
 * the test then fails (or passes) for entirely the wrong reason.
 */

const DIALOG_NAME = /vector cold-start/i;

/** The eight ids that used to be hardcoded in the component's source. */
const RETIRED_IDS = [
  "comedy",
  "science",
  "motivation",
  "music",
  "quotes",
  "instrumental",
  "tech",
  "mindset",
];

interface StubTag {
  tag: string;
  clips: number;
}

/** A real-shaped `GET /tags/available/` body: unigrams, ordered clips DESC. */
const STUB_TAGS: StubTag[] = [
  { tag: "rain", clips: 3 },
  { tag: "listen", clips: 2 },
  { tag: "feel", clips: 2 },
];

function renderModal(onClose = () => {}, onInitialized = () => {}) {
  return render(
    <OnboardingModal isOpen onClose={onClose} onInitialized={onInitialized} />,
  );
}

/** Register the vocabulary route. Returns the mock so the caller can add more. */
function mockVocabulary(api: FetchMock, tags: StubTag[] = STUB_TAGS): FetchMock {
  return api.on("GET", /tags\/available/, () => json(200, { tags }));
}

/** Resolves once the picker is on screen, i.e. the vocabulary has landed. */
async function awaitPicker(tags: StubTag[] = STUB_TAGS) {
  return screen.findByRole("button", { name: new RegExp(tags[0]!.tag, "i") });
}

// ---------------------------------------------------------------------------

describe("OnboardingModal — dialog semantics", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("is exposed as a modal dialog with a real title", () => {
    renderModal();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy as string);
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent(DIALOG_NAME);
    expect(dialog).toHaveAccessibleName(DIALOG_NAME);
  });

  it("moves focus into the dialog on open", () => {
    renderModal();
    // Before this, focus stayed on the trigger behind the overlay, so Tab
    // walked out of the dialog and into the page behind it.
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    renderModal(onClose);

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
            Open onboarding
          </button>
          <OnboardingModal
            isOpen={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onInitialized={() => setOpen(false)}
          />
        </>
      );
    }

    const user = userEvent.setup();
    render(<Host />);
    const trigger = screen.getByRole("button", { name: /open onboarding/i });

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
    const user = userEvent.setup();
    renderModal();
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });

    for (let i = 0; i < 24; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    for (let i = 0; i < 4; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("keeps every one of those guarantees once the vocabulary has loaded", async () => {
    // The fetch runs after the dialog is on screen, so "it is a dialog" has to
    // still be true once the tag grid is in it — a picker full of `<div>`s is
    // the obvious way to regress this while adding the request.
    const api = mockVocabulary(installFetchMock());
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await awaitPicker();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(DIALOG_NAME);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.callsTo(/tags\/available/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — the picker renders the server's vocabulary", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("renders exactly the tags the endpoint returned", async () => {
    mockVocabulary(installFetchMock(), [
      { tag: "rain", clips: 3 },
      { tag: "listen", clips: 2 },
    ]);

    renderModal();

    expect(await screen.findByRole("button", { name: /rain/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /listen/i })).toBeInTheDocument();
    // Order is the server's to decide; the client must not invent rows.
    expect(screen.getAllByRole("group")[0]!.querySelectorAll("button")).toHaveLength(2);
  });

  it("puts no hardcoded id anywhere in the DOM", async () => {
    // The defect in one assertion: the eight ids below were compiled into this
    // file and could not be matched by any clip, so every selection they
    // produced 400'd. Anything rendered here must have come from the wire.
    mockVocabulary(installFetchMock());
    renderModal();
    await awaitPicker();

    const text = document.body.textContent ?? "";
    for (const id of RETIRED_IDS) {
      expect(text.toLowerCase()).not.toContain(id);
    }
  });

  it("shows how many clips each tag is on, so the choice is informed", async () => {
    mockVocabulary(installFetchMock());
    renderModal();

    // The clip count is the only thing this screen knows about a tag, and it
    // is why the tag is offered at all.
    expect(await screen.findByRole("button", { name: /rain 3 tracks/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /listen 2 tracks/i })).toBeInTheDocument();
  });

  it("opens with nothing selected rather than a hardcoded guess", async () => {
    // Preselected `["comedy", "science"]`: two ids no clip carried, so the
    // dialog opened pre-armed with a selection that could only ever 400.
    mockVocabulary(installFetchMock());
    renderModal();
    await awaitPicker();

    for (const tag of STUB_TAGS) {
      const button = await screen.findByRole("button", { name: new RegExp(tag.tag, "i") });
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("status")).toHaveTextContent(/0 vibes armed/i);
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — the vocabulary request can fail", () => {
  it("announces that it is loading, instead of showing an empty picker", async () => {
    // Rendering an empty grid while the answer is in flight says "there is
    // nothing for you" about a request that has not come back yet.
    let release: (() => void) | null = null;
    const api = installFetchMock();
    api.on("GET", /tags\/available/, () =>
      new Promise((resolve) => {
        release = () => resolve(json(200, { tags: STUB_TAGS }));
      }),
    );

    renderModal();

    await waitFor(() => {
      expect(release).not.toBeNull();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/loading tags/i);
    expect(screen.queryByRole("group", { name: /vibe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /initialize feed/i })).not.toBeInTheDocument();
    // Skip is always available: a slow vocabulary is not a reason to trap
    // someone in a dialog they cannot leave.
    expect(screen.getByRole("button", { name: /skip/i })).toBeInTheDocument();

    release!();
    await awaitPicker();
    expect(screen.getByRole("status")).toHaveTextContent(/0 vibes armed/i);
    expect(api.callsTo(/tags\/available/)).toHaveLength(1);
  });

  it("reports a server error with a retry, not an empty picker", async () => {
    const api = installFetchMock();
    api.on("GET", /tags\/available/, () => json(500, { error: "upstream unavailable" }));

    renderModal();

    // An empty grid would read as "no audio matches your taste". The truth is
    // that a request did not come back.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/error/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /initialize feed/i })).not.toBeInTheDocument();
  });

  it("tells a transport failure apart from a server error", async () => {
    // `apiRequest` throws one `ApiError` class for a 500, a dead socket and a
    // blown deadline. Those are not the same news, and collapsing them is what
    // `pages/Explore.tsx:232-240` stopped doing.
    const server = installFetchMock();
    server.on("GET", /tags\/available/, () => json(500, { error: "upstream unavailable" }));
    const { unmount } = renderModal();
    const serverCopy = (await screen.findByRole("alert")).textContent ?? "";
    unmount();

    const offline = installFetchMock();
    offline.fail("GET", /tags\/available/, new TypeError("Failed to fetch"));
    renderModal();
    const offlineCopy = (await screen.findByRole("alert")).textContent ?? "";

    expect(offlineCopy).not.toEqual(serverCopy);
    expect(offlineCopy).toMatch(/connection|reach/i);
    expect(offlineCopy).not.toMatch(/error \(\d+\)/);
  });

  it("tells a timeout apart from both, instead of blaming the connection", async () => {
    const api = installFetchMock();
    api.hang("GET", /tags\/available/);

    renderModal();

    // `client.ts:265` gives every request a 15s deadline, so a hang resolves
    // itself — the user is told it was slow, not that they are offline. The
    // test timeout is raised to match, because the deadline under test IS the
    // 15s one and vitest's 5s default would cut it off mid-flight.
    const alert = await screen.findByRole("alert", undefined, { timeout: 20_000 });
    expect(alert).toHaveTextContent(/too long|did not answer/i);
    expect(alert).not.toHaveTextContent(/check your connection/i);
  }, 30_000);

  it("recovers when Retry succeeds", async () => {
    const api = installFetchMock();
    let attempt = 0;
    api.on("GET", /tags\/available/, () => {
      attempt += 1;
      return attempt === 1 ? json(503, { error: "warming up" }) : json(200, { tags: STUB_TAGS });
    });

    const user = userEvent.setup();
    renderModal();
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /retry/i }));

    await awaitPicker();
    expect(api.callsTo(/tags\/available/)).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not report a broken response shape as an empty catalogue", async () => {
    const api = installFetchMock();
    api.on("GET", /tags\/available/, () => json(200, { results: [] }));

    renderModal();

    // A body with no `tags` array is a broken contract, not "nothing
    // qualifies". Reading it as empty would tell the user their taste matched
    // nothing when the truth is that nothing was read.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/read|understand/i);
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — an empty catalogue gets an honest state", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("says the catalogue is too small, and never that the user matched nothing", async () => {
    mockVocabulary(installFetchMock(), []);

    renderModal();

    expect(
      await screen.findByRole("heading", { name: /not enough audio yet/i }),
    ).toBeInTheDocument();
    // No picker at all: an empty grid of buttons would read as "there is
    // nothing here for you", which is the false statement this state exists to
    // avoid.
    expect(screen.queryByRole("group", { name: /vibe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /initialize feed/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/nothing (here|matches|matched)/i);
    expect(document.body.textContent).not.toMatch(/your taste matched/i);
    expect(document.body.textContent).not.toMatch(/no (tags|vibes|results) found/i);
  });

  it("says skipping works, and offers a way to the feed", async () => {
    // `ai_ml/pipelines/recommendation.py:280-293` is the cold-start path: it
    // needs no user vectors. So this is not a consolation prize, and telling
    // the user to skip is genuinely the right advice rather than a brush-off.
    mockVocabulary(installFetchMock(), []);
    renderModal();
    await screen.findByRole("heading", { name: /not enough audio yet/i });

    expect(document.body.textContent).toMatch(/popular/i);
    expect(screen.getByRole("button", { name: /browse the feed/i })).toBeInTheDocument();
  });

  it("routes to the feed and stops re-arming the modal", async () => {
    mockVocabulary(installFetchMock(), []);
    sessionStorage.setItem("ef_new_user", "1");
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await screen.findByRole("heading", { name: /not enough audio yet/i });

    await user.click(screen.getByRole("button", { name: /browse the feed/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("ef_new_user")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — tag selection is exposed as state", () => {
  beforeEach(() => {
    mockVocabulary(installFetchMock());
  });

  it("exposes pressed state on every tag", async () => {
    // Selection was border + ring + background tint + an unexposed <Check>:
    // colour alone (WCAG 1.4.1), so a screen-reader user could neither see nor
    // hear which vibes were armed.
    renderModal();
    const rain = await awaitPicker();

    expect(rain).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /listen/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("flips pressed state when a tag is toggled, and announces the count", async () => {
    renderModal();
    const user = userEvent.setup();
    const rain = await awaitPicker();

    expect(screen.getByRole("status")).toHaveTextContent(/0 vibes armed/i);

    await user.click(rain);
    expect(rain).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/1 vibes armed/i);

    await user.click(rain);
    expect(rain).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent(/0 vibes armed/i);
  });

  it("groups the tag grid under a name", async () => {
    renderModal();
    await awaitPicker();
    expect(screen.getByRole("group", { name: /vibe/i })).toBeInTheDocument();
  });

  it("announces the armed count instead of leaving it as static text", async () => {
    // "N Vibes Armed" was a bare <span>: it changed on every tap and told a
    // screen-reader user nothing.
    renderModal();
    await awaitPicker();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/vibes armed/i);
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — the zero-tag state is reachable and explained", () => {
  beforeEach(() => {
    mockVocabulary(installFetchMock());
  });

  it("keeps submit focusable at zero tags instead of dropping focus to body", async () => {
    const user = userEvent.setup();
    renderModal();
    const rain = await awaitPicker();

    // Arm and disarm, so this is the same journey the two preselected defaults
    // used to force on every user.
    await user.click(rain);
    await user.click(rain);

    const submit = screen.getByRole("button", { name: /initialize feed/i });
    // A natively `disabled` button leaves the tab order and drops focus to
    // <body> (WCAG 2.4.3), which is what happened on every attempt.
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveAttribute("aria-disabled", "true");
  });

  it("says why nothing can be initialized yet, instead of failing silently", async () => {
    const user = userEvent.setup();
    renderModal();
    await awaitPicker();

    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    // Before this, the submit button was `disabled` at zero tags, so the
    // `selectedTags.length === 0` guard in the handler was unreachable and the
    // message it set could never be shown.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/at least one/i);
  });

  it("does not call the API for an empty selection", async () => {
    const api = mockVocabulary(installFetchMock());
    const user = userEvent.setup();
    renderModal();
    await awaitPicker();

    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    expect(api.callsTo(/tags\/initialize/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — a real submission", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = mockVocabulary(installFetchMock());
  });

  it("sends the selected tags and reports success through the caller", async () => {
    api.on("POST", /tags\/initialize/, () => ({
      status: 200,
      body: { status: "Algorithm initialized. Feed is ready." },
    }));
    const onInitialized = vi.fn();
    const onClose = vi.fn();
    renderModal(onClose, onInitialized);

    const user = userEvent.setup();
    await awaitPicker();
    await user.click(screen.getByRole("button", { name: /listen/i }));
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    await waitFor(() => {
      expect(onInitialized).toHaveBeenCalledTimes(1);
    });
    const sent = api.callsTo(/tags\/initialize/);
    expect(sent).toHaveLength(1);
    // The payload is the server's own vocabulary, not a client constant.
    expect(sent[0]?.body).toMatchObject({ selected_tags: ["listen"] });
  });

  it("surfaces a server failure in an announced region", async () => {
    // MUST-PRESERVE. The catch was `console.warn`-equivalent in effect:
    // `setErrorMsg` rendered into a bare <div> with no role, so a rejected
    // cold-start was silent. The server's own `{"error": ...}` text is quoted
    // verbatim — `serverMessage` exists so the human diagnosis comes from the
    // server, not from a guess in this file.
    api.on("POST", /tags\/initialize/, () => ({
      status: 400,
      body: { error: "Not enough data to build baseline." },
    }));
    const onInitialized = vi.fn();
    renderModal(() => {}, onInitialized);

    const user = userEvent.setup();
    await awaitPicker();
    await user.click(screen.getByRole("button", { name: /listen/i }));
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not enough data/i);
    expect(onInitialized).not.toHaveBeenCalled();
    // A rejected cold-start keeps the modal open, so the user can change the
    // selection rather than being dropped back to the cold queue.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("OnboardingModal — dismissing stops the modal re-arming", () => {
  beforeEach(() => {
    mockVocabulary(installFetchMock());
  });

  it("clears ef_new_user on Skip", async () => {
    // The permanent dead end. `ef_new_user` was removed only inside the `try`
    // of a successful initialize, and a successful initialize had never
    // happened — `select count(*) from app_user where long_term_semantic is
    // not null` was 0. So Skip left the flag set and `App.tsx:509-513` re-armed
    // this dialog on every reload, for ever.
    sessionStorage.setItem("ef_new_user", "1");
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await awaitPicker();

    await user.click(screen.getByRole("button", { name: /skip/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("ef_new_user")).toBeNull();
  });

  it("clears it on Escape too, since Escape is the same dismissal", async () => {
    sessionStorage.setItem("ef_new_user", "1");
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await awaitPicker();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("ef_new_user")).toBeNull();
  });

  it("does not initialize anything on the way out", async () => {
    const api = mockVocabulary(installFetchMock());
    sessionStorage.setItem("ef_new_user", "1");
    const user = userEvent.setup();
    renderModal();
    await awaitPicker();

    await user.click(screen.getByRole("button", { name: /listen/i }));
    await user.click(screen.getByRole("button", { name: /skip/i }));

    // A tag was armed and the modal still closed without a request: Skip is
    // "not now", not "do this for me".
    expect(api.callsTo(/tags\/initialize/)).toHaveLength(0);
  });

  it("keeps the flag after a rejected cold-start, so the user can retry", async () => {
    const api = mockVocabulary(installFetchMock());
    api.on("POST", /tags\/initialize/, () =>
      json(400, { error: "Not enough data to build baseline." }),
    );
    sessionStorage.setItem("ef_new_user", "1");
    const user = userEvent.setup();
    renderModal();
    await awaitPicker();

    await user.click(screen.getByRole("button", { name: /listen/i }));
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));
    await screen.findByRole("alert");

    // A 400 is not a dismissal. Clearing here would drop the user into an
    // unpersonalised feed with no way back into this dialog.
    expect(sessionStorage.getItem("ef_new_user")).toBe("1");
  });
});
