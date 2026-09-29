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
  it("announces a session expiry in a polite live region", () => {
    render(<Harness />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
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

    // No auto-expiry: unlike NetworkBanner's 2.5 s timer, the reason the user
    // was signed out must not vanish on its own.
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
