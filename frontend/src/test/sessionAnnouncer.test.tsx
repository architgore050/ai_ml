import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  SessionNotice,
  useSessionAnnouncer,
} from "../components/common/SessionAnnouncer";

/**
 * `SessionAnnouncer`.
 *
 * Two real defects, both about a live region that is mounted and correct and
 * still fails the person it exists for.
 *
 * 1. Repeat-fire was broken. `SessionMessage.id` was generated
 *    (`${eventName}-${counter.current}`) and never consumed, so a second
 *    session expiry rendered byte-identical text into the same node. A live
 *    region whose text does not change is not re-announced, so the one event a
 *    user most needs to hear about twice is the one they hear once. The `id`
 *    field documented an intent the implementation did not honour.
 *
 * 2. Politeness was `polite` for a loss of function. The user is being signed
 *    out and the whole tree is being replaced by a login screen; `polite`
 *    queues that behind whatever is being read and it may never be read at all.
 *
 * The mounted-when-empty shape is the part that already works and is pinned
 * here so it is not "simplified" away: a region inserted at the same tick as
 * its text is unreliable, because assistive technology can observe an
 * already-rendered region and miss the insertion.
 */

function Harness() {
  const { message, dismiss } = useSessionAnnouncer();
  return <SessionNotice message={message} onDismiss={dismiss} />;
}

/** The element holding the message text, which is what a remount replaces. */
function messageNode(): HTMLElement {
  return screen.getByText(/session expired/i);
}

function fireSessionExpired() {
  act(() => {
    window.dispatchEvent(new CustomEvent("ef_session_expired"));
  });
}

describe("SessionAnnouncer — repeat-fire", () => {
  it("re-announces a second, identical session expiry", () => {
    render(<Harness />);

    fireSessionExpired();
    const first = messageNode();
    expect(first).toBeInTheDocument();

    // The same event again — a reconnect that expires immediately, or a user who
    // signs back in and is signed straight out. The text is identical, so the
    // only thing that can make a live region speak twice is a changed subtree.
    fireSessionExpired();
    const second = messageNode();

    expect(second).toBeInTheDocument();
    expect(second).not.toBe(first);
    expect(second).toHaveTextContent(/session expired/i);
  });

  it("gives each message a distinct identity, as its id field promises", () => {
    // `SessionMessage.id` exists to be an identity. Before this pass it was
    // generated, stored on the object, and read by nothing.
    const seen: string[] = [];
    function Recorder() {
      const { message, dismiss } = useSessionAnnouncer();
      if (message) seen.push(message.id);
      return <SessionNotice message={message} onDismiss={dismiss} />;
    }

    render(<Recorder />);
    fireSessionExpired();
    fireSessionExpired();
    fireSessionExpired();

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("SessionAnnouncer — politeness", () => {
  it("interrupts, because the user is being signed out", () => {
    render(<Harness />);
    // `polite` was wrong: this is a loss of function, not a status update. The
    // tree is about to be replaced by a login page, so a queued announcement
    // competes with content that is about to be removed.
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "assertive");
  });

  it("still exposes itself as a status region", () => {
    // The role is deliberately kept even though the explicit `aria-live` above
    // is assertive: the region has to be findable while it is idle, before there
    // is anything to announce, and `getByRole("status")` is the idiom the rest
    // of this suite (and NetworkBanner) is written in.
    render(<Harness />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("SessionAnnouncer — the shape that must not regress", () => {
  it("keeps the live region mounted when it is empty", () => {
    render(<SessionNotice message={null} onDismiss={() => {}} />);
    const region = screen.getByRole("status");

    expect(region).toBeInTheDocument();
    expect(region).not.toHaveStyle({ display: "none" });
    expect(region.style.padding).toBe("0px");
    expect(region).toBeEmptyDOMElement();
  });

  it("observes an insertion into a region that was already there", () => {
    render(<Harness />);
    const region = screen.getByRole("status");
    expect(region).not.toHaveTextContent(/session expired/i);

    fireSessionExpired();
    expect(region).toHaveTextContent(/session expired/i);
  });

  it("keeps the message until dismissed", () => {
    const onDismiss = vi.fn();
    render(<Harness />);
    fireSessionExpired();
    expect(messageNode()).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });
});
