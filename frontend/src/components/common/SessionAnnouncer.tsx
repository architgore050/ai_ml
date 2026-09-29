import { useEffect, useRef, useState } from "react";

/** Events `src/api/client.ts` dispatches, mapped to what the user is told. */
const ANNOUNCEMENTS: Record<string, string> = {
  ef_session_expired: "Your session expired. Please sign in again.",
};

export interface SessionMessage {
  id: string;
  text: string;
  tone: "info" | "warning";
}

/**
 * Subscribes to app-level `ef_*` events and exposes the last one.
 *
 * `client.ts` dispatches `ef_session_expired` when a token refresh fails, and
 * `auth.tsx` reacts by swapping the tree for `LoginPage`. That transition was
 * silent: the user was signed out with no message and no indication of why, and
 * with no way back to what they were doing.
 *
 * This is the delivery surface. It renders into an `aria-live` region so the
 * reason is announced to a screen reader as well as shown, and keeps the message
 * until the user dismisses it — a timed auto-dismiss (as `NetworkBanner` does at
 * 2.5 s) would defeat the announcement for anyone who looked away.
 */
export function useSessionAnnouncer(): {
  message: SessionMessage | null;
  dismiss: () => void;
} {
  const [message, setMessage] = useState<SessionMessage | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    const handlers = Object.keys(ANNOUNCEMENTS).map((eventName) => {
      const handler = () => {
        counter.current += 1;
        setMessage({
          id: `${eventName}-${counter.current}`,
          text: ANNOUNCEMENTS[eventName] ?? "",
          tone: eventName === "ef_session_expired" ? "warning" : "info",
        });
      };
      window.addEventListener(eventName, handler);
      return { eventName, handler };
    });

    return () => {
      handlers.forEach(({ eventName, handler }) =>
        window.removeEventListener(eventName, handler),
      );
    };
  }, []);

  return { message, dismiss: () => setMessage(null) };
}

/**
 * Renders a session message in a polite live region.
 *
 * The message persists until dismissed. A timed auto-dismiss would be read
 * out for a screen reader only if the user happened not to be navigating, and
 * would then be gone for everyone looking at a login screen with no context.
 */
export function SessionNotice({
  message,
  onDismiss,
}: {
  message: SessionMessage | null;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        zIndex: 9000,
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        // The live region is always mounted. Hiding it with `display: none` and
        // revealing it on the same tick that inserts text is unreliable for
        // screen readers — they observe an already-visible region and can miss
        // the insertion entirely. An empty region with no chrome is 0x0 and
        // harmless, so the region stays live at all times.
        display: message ? "flex" : "block",
        alignItems: "center",
        gap: 12,
        maxWidth: message ? "min(520px, calc(100vw - 32px))" : 0,
        padding: message ? "12px 16px" : 0,
        borderRadius: "var(--radius-sm)",
        background: message ? "var(--surface-container-high)" : "transparent",
        border: message ? "1px solid var(--border-strong)" : "none",
        boxShadow: message ? "0 0 24px var(--accent-glow)" : "none",
        color: "var(--text-primary)",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {message ? (
        <>
          <span>{message.text}</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            style={{
              minWidth: 28,
              minHeight: 28,
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}
