import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NetworkBanner } from "../components/common/NetworkBanner";
import { BottomNav } from "../components/navigation/BottomNav";

/**
 * Leaf-component defects from docs/frontend_rebuild_plan.md §3.5.
 *
 * The banner's auto-dismiss was not only an a11y violation (WCAG 2.2.1 — a
 * time limit on content with no way to extend or suppress it). It also broke the
 * state machine: it wrote `setOffline(false)` while the device was still
 * offline, so the banner claimed connectivity for the rest of the outage and
 * then vanished. The failure mode a user actually experiences is a generic
 * "Failed to load audio feed" with the banner gone and nothing to connect that
 * line of reasoning to the cause.
 *
 * `BottomNav` had `focus:outline-none` with nothing in its place — a deliberate
 * deletion of the browser focus ring on the app's primary action — and no
 * `aria-current` anywhere, so assistive tech could not tell which of the five
 * destinations was showing.
 */

/** Drives a connectivity transition the way the browser does. */
function goOffline() {
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
}

function goOnline() {
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
}

function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

afterEach(() => {
  setNavigatorOnline(true);
});

describe("NetworkBanner", () => {
  it("does not auto-expire while still offline", async () => {
    // THE regression. 2500 ms was the whole lifetime of the notice, and it
    // expired even though the underlying condition was unchanged.
    vi.useFakeTimers();
    try {
      render(<NetworkBanner />);
      goOffline();
      expect(screen.getByText("No connection — you are offline")).toBeInTheDocument();

      // Far past the old auto-dismiss, with no connectivity change at all.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText("No connection — you are offline")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be dismissed by the user, and the control is named", () => {
    render(<NetworkBanner />);
    goOffline();

    // Not dismissible at all before this pass, which is what made the timer
    // look like the only available action.
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    expect(dismiss).toBeInTheDocument();

    act(() => {
      dismiss.click();
    });

    expect(screen.queryByText("No connection — you are offline")).not.toBeInTheDocument();
  });

  it("announces through a live region that is mounted before the text exists", () => {
    render(<NetworkBanner />);

    // Present and empty on a healthy load. A region inserted at the same time
    // as its text is unreliable for screen readers: they can observe a region
    // that was never there and miss the insertion entirely.
    const region = screen.getByRole("status");
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).not.toHaveTextContent("No connection");
    expect(region).not.toHaveTextContent("Back online");

    goOffline();
    expect(region).toHaveTextContent("No connection — you are offline");
  });

  it("confirms recovery when connectivity returns", () => {
    render(<NetworkBanner />);

    goOffline();
    expect(screen.getByText("No connection — you are offline")).toBeInTheDocument();

    goOnline();

    // The offline notice must clear, and the outage must be explicitly closed
    // out. Previously the same transition happened via the timer with no
    // confirmation at all, so it was indistinguishable from the banner simply
    // giving up.
    expect(screen.queryByText("No connection — you are offline")).not.toBeInTheDocument();
    expect(screen.getByText("Back online")).toBeInTheDocument();
  });

  it("confirms recovery even if the user had dismissed the offline notice", () => {
    // This is the case that carries the information. With the banner dismissed
    // there is no other on-screen change when the outage ends, so a
    // self-clearing confirmation would leave a dismissed user with no signal at
    // all — the original defect, one message over.
    render(<NetworkBanner />);
    goOffline();

    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    expect(screen.queryByText("No connection — you are offline")).not.toBeInTheDocument();

    goOnline();
    expect(screen.getByText("Back online")).toBeInTheDocument();
  });

  it("does not claim recovery on a load that was never offline", () => {
    setNavigatorOnline(true);
    render(<NetworkBanner />);
    expect(screen.queryByText("Back online")).not.toBeInTheDocument();
    expect(screen.queryByText("No connection — you are offline")).not.toBeInTheDocument();
  });

  it("re-raises the notice for a new outage after the previous one was dismissed", () => {
    // Dismissal must be scoped to one connectivity episode, or muting the
    // banner during a flaky lift silently disables it for the rest of the
    // session.
    render(<NetworkBanner />);

    goOffline();
    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    goOnline();
    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });

    goOffline();
    expect(screen.getByText("No connection — you are offline")).toBeInTheDocument();
  });

  it("shows the notice immediately when the page loads already offline", () => {
    // The initial read of `navigator.onLine` was already correct; this pins
    // that the user-controlled dismissal did not introduce a mount-time delay.
    setNavigatorOnline(false);
    render(<NetworkBanner />);
    expect(screen.getByText("No connection — you are offline")).toBeInTheDocument();
  });
});

describe("BottomNav", () => {
  const renderNav = (activeTab = "feed") =>
    render(<BottomNav activeTab={activeTab} setActiveTab={() => {}} unreadCount={0} />);

  it("marks the active destination with aria-current", () => {
    renderNav("inbox");

    expect(screen.getByRole("button", { name: /inbox/i })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Exactly one current destination, and it is the active one — an
    // `aria-current` on every item would be worse than none.
    const current = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName(/inbox/i);
  });

  it("marks the highlighted Studio tab too, not only the plain items", () => {
    // The "Create" tab is a separate JSX branch, so an attribute added to the
    // ordinary branch would silently skip it.
    renderNav("upload");
    expect(screen.getByRole("button", { name: /create/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("leaves aria-current off the inactive items", () => {
    renderNav("feed");
    expect(screen.getByRole("button", { name: /profile/i })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("restores a focus-visible ring on the highlighted tab", () => {
    renderNav("feed");
    const create = screen.getByRole("button", { name: /create/i });

    // The original class was `focus:outline-none` with no replacement of any
    // kind, which deleted the browser's focus ring outright.
    expect(create.className).not.toMatch(/(^|\s)focus:outline-none(\s|$)/);

    // ...and the replacement must be scoped to focus-visible so it does not
    // follow every mouse click.
    expect(create.className).toMatch(/focus-visible:ring-\d/);

    // The ring must contrast with this tab's fill, which is `bg-[#FF6321]` in
    // BOTH its active and inactive states. A brand-coloured ring here would
    // restore the focus indicator in name only — invisible in practice, which
    // is the defect the bare `focus:outline-none` was.
    const ringColours = create.className.match(/focus-visible:ring-(\S+)/g) ?? [];
    expect(ringColours.join(" ")).not.toMatch(/FF6321|#ff753b/i);
  });

  it("names every destination", () => {
    renderNav("feed");
    for (const label of [/live feed/i, /discover/i, /create/i, /inbox/i, /profile/i]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });
});