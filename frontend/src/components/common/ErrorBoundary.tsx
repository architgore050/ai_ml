import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered instead of the default panel. Use for route-scoped boundaries. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Label for the recovery button, e.g. "Back to feed". */
  label?: string;
  /** Called on every caught error, e.g. to hand it to a reporter. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level error boundary.
 *
 * There was no boundary anywhere in this app, so a single throw inside
 * `usePlayer` or `useAuth` unmounted the whole React tree to a blank page with
 * no explanation and no way back short of a manual reload. This wraps the
 * application content and offers a real recovery affordance.
 *
 * It is a class component because React has no hook equivalent for
 * `componentDidCatch` — this is not a style regression.
 *
 * Boundary placement is deliberate: it sits *inside* the providers, so a throw
 * in the providers themselves is not caught here (see the note in `App.tsx`).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
    // Deliberately not swallowed: an unhandled error in devtools is the only
    // place the component stack is visible, and this is not wired to Sentry
    // (AGENTS.md's Sentry integration is Python-only, and send_default_pii=False
    // would reject browser-source events anyway).
    console.error("Unhandled error in React tree:", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    const { error } = this.state;
    const { children, fallback, label = "Try again" } = this.props;

    if (!error) return children;
    if (fallback) return fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="min-h-screen flex flex-col items-center justify-center text-center px-8"
        style={{ background: "var(--background)", color: "var(--text-primary)" }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Something broke</h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            maxWidth: 420,
            marginBottom: 24,
            lineHeight: 1.5,
          }}
        >
          EchoFlow hit an unexpected error and stopped rendering. Your session and any
          unsent telemetry may be stale.
        </p>
        <pre
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            maxWidth: 520,
            maxHeight: 160,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            marginBottom: 24,
            textAlign: "left",
          }}
        >
          {error.message}
        </pre>
        <div style={{ display: "flex", gap: 12 }}>
          <button
            type="button"
            onClick={this.reset}
            style={{
              minHeight: 44,
              padding: "0 24px",
              borderRadius: "var(--radius-full)",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
              background: "var(--accent)",
              color: "var(--on-error)",
            }}
          >
            {label}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              minHeight: 44,
              padding: "0 24px",
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--border-strong)",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
              background: "transparent",
              color: "var(--text-primary)",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
