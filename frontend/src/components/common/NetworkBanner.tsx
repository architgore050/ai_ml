import { useEffect, useState } from "react";

const OFFLINE_MESSAGE = "No connection — you are offline";
const RECONNECTED_MESSAGE = "Back online";

/**
 * Connectivity banner.
 *
 * Ported from sample_frontend2/src/components/common/NetworkBanner.tsx
 * (preserved in git as 20451d3).
 *
 * Correction to the original: its copy read "NO CONNECTION — demo mode
 * active", which is false. Going offline does not switch the app into any
 * alternative mode; it just means requests fail. FRONTEND-REQUIREMENTS.md §4.9
 * asks for a "Backend not reachable" affordance, so that is what this says.
 *
 * Correction to the auto-dismiss: the banner used to clear itself after
 * `AUTO_DISMISS_MS = 2500`. That is WCAG 2.2.1 — a time limit on content with
 * no way to extend or turn it off — but the timer broke the *state machine*,
 * not just the announcement. It set `offline` back to `false` while the device
 * was still offline, so for the whole remaining outage the banner asserted the
 * opposite of the truth and then disappeared, leaving anyone who had looked
 * away with a generic "Failed to load audio feed" and no way to connect that
 * line of reasoning to the cause.
 *
 * There is now no timer anywhere in this file. Nothing here expires on its own:
 * the offline notice persists until the user dismisses it or connectivity
 * actually returns, and the "Back online" confirmation persists until dismissed
 * too. A timer on the *positive* confirmation would reintroduce the same defect
 * for the one user who most needs it — the user who already dismissed the
 * offline banner and would otherwise get no signal whatsoever that the outage
 * was over.
 *
 * Dismissal is scoped to one connectivity episode and resets on every
 * transition, so muting the banner during a flaky lift does not mute it for the
 * next outage.
 *
 * `navigator.onLine` is the only signal here and it is weak: it reports whether
 * the device has *a* network interface, not whether anything is reachable, and
 * it stays `true` for a Wi-Fi link that is associated but has no upstream. It
 * is the standard primitive for this and it is what the app already assumes
 * elsewhere; it is not a reachability probe. Whether the *backend* is up is a
 * separate question, answered by `useBackendHealth`.
 */
export function NetworkBanner() {
  const [offline, setOffline] = useState<boolean>(!navigator.onLine);

  // True only after an offline -> online transition, so a page load while
  // already connected does not greet the user with "Back online".
  const [reconnected, setReconnected] = useState(false);

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      setReconnected(false);
      setDismissed(false);
    };
    const goOnline = () => {
      setOffline(false);
      setReconnected(true);
      setDismissed(false);
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  const message = dismissed
    ? null
    : offline
      ? OFFLINE_MESSAGE
      : reconnected
        ? RECONNECTED_MESSAGE
        : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass fixed left-1/2 -translate-x-1/2 text-center"
      style={{
        zIndex: 8000,
        top: 72,
        // The live region stays mounted. Revealing a `display: none` region on
        // the same tick that inserts its text is unreliable for screen readers
        // — they observe an already-rendered region and can miss the insertion.
        // Idle, this is an empty 0x0 box (`.glass` sets only a background), so
        // keeping it mounted costs nothing on screen.
        display: message ? "flex" : "block",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: message ? "10px 20px" : 0,
        borderRadius: "var(--radius-full)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.04em",
        color: "var(--text-primary)",
        border: message ? "1px solid var(--border)" : "none",
        boxShadow: message ? "0 0 24px var(--accent-glow)" : "none",
      }}
    >
      {message ? (
        <>
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
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