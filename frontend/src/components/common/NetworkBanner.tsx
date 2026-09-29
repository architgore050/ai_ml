import { useEffect, useState } from "react";

const AUTO_DISMISS_MS = 2500;

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
 */
export function NetworkBanner() {
  const [offline, setOffline] = useState<boolean>(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  useEffect(() => {
    if (!offline) return;
    const timer = setTimeout(() => setOffline(false), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [offline]);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 glass text-center"
      style={{
        zIndex: 8000,
        top: 72,
        padding: "10px 20px",
        borderRadius: "var(--radius-full)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.04em",
        color: "var(--text-primary)",
        border: "1px solid var(--border)",
        boxShadow: "0 0 24px var(--accent-glow)",
      }}
    >
      No connection — you are offline
    </div>
  );
}
