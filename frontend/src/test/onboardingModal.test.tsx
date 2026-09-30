import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { installFetchMock, type FetchMock } from "./fetchMock";
import { OnboardingModal } from "../components/feed/OnboardingModal";

/**
 * `OnboardingModal` — the cold-start dialog, and the first thing a new account
 * ever sees.
 *
 * It was a `<div className="fixed inset-0">` with no `role="dialog"`, no
 * `aria-modal`, no title association, no focus move, no Escape, no focus
 * restore and no focus trap. `ShareModal` and `CommentSheet` have since had
 * exactly that treatment, and this brings the third modal onto the same shape
 * and the same names (`DIALOG_TITLE_ID`, `FOCUSABLE_SELECTOR`,
 * `handleDialogKeyDown`) so the three read as one implementation.
 *
 * The tag grid conveyed its selected state by colour alone: border, ring,
 * background tint, and a `<Check>` glyph that was not exposed as state. There
 * was exactly one `aria-pressed` in the whole app.
 *
 * The submit button was `disabled` at zero tags, which both dropped focus to
 * `<body>` (WCAG 2.4.3) and made the `selectedTags.length === 0` guard in the
 * submit handler unreachable — the app had a message for a state it could not
 * reach. See the note on that test below.
 */

const DIALOG_NAME = /vector cold-start/i;

function renderModal(onClose = () => {}, onInitialized = () => {}) {
  return render(
    <OnboardingModal isOpen onClose={onClose} onInitialized={onInitialized} />,
  );
}

describe("OnboardingModal — dialog semantics", () => {
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
});

describe("OnboardingModal — tag selection is exposed as state", () => {
  it("exposes pressed state on every tag", () => {
    // Selection was border + ring + background tint + an unexposed <Check>:
    // colour alone (WCAG 1.4.1), so a screen-reader user could neither see nor
    // hear which vibes were armed.
    renderModal();

    const comedy = screen.getByRole("button", { name: /comedy/i });
    expect(comedy).toHaveAttribute("aria-pressed", "true");

    const quotes = screen.getByRole("button", { name: /deep quotes/i });
    expect(quotes).toHaveAttribute("aria-pressed", "false");
  });

  it("flips pressed state when a tag is toggled", async () => {
    renderModal();
    const user = userEvent.setup();

    const music = screen.getByRole("button", { name: /beat snippets/i });
    expect(music).toHaveAttribute("aria-pressed", "false");

    await user.click(music);
    expect(music).toHaveAttribute("aria-pressed", "true");

    await user.click(music);
    expect(music).toHaveAttribute("aria-pressed", "false");
  });

  it("groups the tag grid under a name", () => {
    renderModal();
    expect(screen.getByRole("group", { name: /vibe/i })).toBeInTheDocument();
  });

  it("announces the armed count instead of leaving it as static text", () => {
    // "N Vibes Armed" was a bare <span>: it changed on every tap and told a
    // screen-reader user nothing.
    renderModal();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/vibes armed/i);
  });
});

describe("OnboardingModal — the zero-tag state is reachable and explained", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("keeps submit focusable at zero tags instead of dropping focus to body", async () => {
    const user = userEvent.setup();
    renderModal();

    // Deselect the two defaults, leaving none.
    await user.click(screen.getByRole("button", { name: /comedy/i }));
    await user.click(screen.getByRole("button", { name: /science bites/i }));

    const submit = screen.getByRole("button", { name: /initialize feed/i });
    // A natively `disabled` button leaves the tab order and drops focus to
    // <body> (WCAG 2.4.3), which is what happened on every attempt.
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveAttribute("aria-disabled", "true");
  });

  it("says why nothing can be initialized yet, instead of failing silently", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: /comedy/i }));
    await user.click(screen.getByRole("button", { name: /science bites/i }));

    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    // Before this, the submit button was `disabled` at zero tags, so the
    // `selectedTags.length === 0` guard in the handler was unreachable and the
    // message it set could never be shown.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/at least one/i);
  });

  it("does not call the API for an empty selection", async () => {
    const api: FetchMock = installFetchMock();
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: /comedy/i }));
    await user.click(screen.getByRole("button", { name: /science bites/i }));
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    expect(api.callsTo(/tags\/initialize/)).toHaveLength(0);
  });
});

describe("OnboardingModal — a real submission", () => {
  let api: FetchMock;

  beforeEach(() => {
    api = installFetchMock();
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
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    await waitFor(() => {
      expect(onInitialized).toHaveBeenCalledTimes(1);
    });
    const sent = api.callsTo(/tags\/initialize/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ selected_tags: ["comedy", "science"] });
  });

  it("surfaces a server failure in an announced region", async () => {
    // The catch was `console.warn`-equivalent in effect: `setErrorMsg` rendered
    // into a bare <div> with no role, so a rejected cold-start was silent.
    api.on("POST", /tags\/initialize/, () => ({
      status: 400,
      body: { error: "Not enough data to build baseline." },
    }));
    const onInitialized = vi.fn();
    renderModal(() => {}, onInitialized);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /initialize feed/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not enough data/i);
    expect(onInitialized).not.toHaveBeenCalled();
  });
});
