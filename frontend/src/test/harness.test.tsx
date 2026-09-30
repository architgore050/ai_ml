import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { SessionNotice, useSessionAnnouncer } from "../components/common/SessionAnnouncer";

function Boom(): never {
  throw new Error("player exploded");
}

function Harness() {
  const { message, dismiss } = useSessionAnnouncer();
  return <SessionNotice message={message} onDismiss={dismiss} />;
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>feed is fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("feed is fine")).toBeInTheDocument();
  });

  it("catches a throw from the tree and announces it as an alert", () => {
    // React logs the caught error; silence it so the test output stays readable.
    const spy = console.error;
    console.error = () => {};
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      console.error = spy;
    }

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something broke");
    expect(alert).toHaveTextContent("player exploded");
  });

  it("offers a real recovery affordance, not a blank page", () => {
    const spy = console.error;
    console.error = () => {};
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      console.error = spy;
    }

    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("supports a custom fallback", () => {
    const spy = console.error;
    console.error = () => {};
    try {
      render(
        <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      console.error = spy;
    }

    expect(screen.getByText("custom: player exploded")).toBeInTheDocument();
  });
});

describe("useSessionAnnouncer", () => {
  it("announces a session expiry assertively, because the user is signed out", () => {
    // This asserted `polite` and the assertion was updated deliberately, not
    // to keep the suite green. Session expiry is a loss of function: the tree is
    // being replaced by a login screen, so a polite announcement queues behind
    // content that is about to be removed and may never be read.
    render(<Harness />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();

    // The listener is a plain window event, so the state update is outside
    // React's event system and has to be wrapped for the re-render to flush.
    act(() => {
      window.dispatchEvent(new CustomEvent("ef_session_expired"));
    });

    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("keeps the message until dismissed", () => {
    render(<Harness />);
    act(() => {
      window.dispatchEvent(new CustomEvent("ef_session_expired"));
    });

    // No auto-expiry. This comment used to point at "NetworkBanner's 2.5 s
    // timer" — that timer was removed, and `navNetworkBanner.test.tsx` proves
    // it by advancing 60 s and finding the notice still there. The only live
    // 2.5 s timer in the app is the upload success redirect.
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });

    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  it("keeps the live region mounted but chrome-free when idle", () => {
    render(<SessionNotice message={null} onDismiss={() => {}} />);
    const region = screen.getByRole("status");
    // Present (so insertions are observed), but not `display: none` and not
    // padded/bordered, so it occupies no space and shows no empty box.
    expect(region).not.toHaveStyle({ display: "none" });
    expect(region.style.padding).toBe("0px");
    expect(region.style.maxWidth).toBe("0");
    expect(region).toBeEmptyDOMElement();
  });
});
