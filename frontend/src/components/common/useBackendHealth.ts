import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../../api/client";

/**
 * Polls the backend's real health endpoints.
 *
 * Replaces a static "Workers Active" badge that rendered unconditionally and
 * therefore said the opposite of the truth whenever the backend was down.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. **The green state requires BOTH probes.** `GET /health/`
 *    (`backend/EchoFlow/health.py:9`) is a *liveness* probe — it returns 200 as
 *    soon as the Django process can serve a request, so it stays green while
 *    Postgres is down. `GET /ready/` (`health.py:20`) runs
 *    `SELECT 1` and returns 503 otherwise. Reporting on liveness alone would
 *    reproduce the original fabrication with better manners.
 *
 * 2. **Neither endpoint knows anything about Celery workers.** Liveness checks
 *    the Django process; readiness checks the database. Nothing here observes a
 *    worker queue, so callers must not label the healthy state as worker
 *    health — that would be the same lie in new words. There *is* a worker
 *    heartbeat endpoint, `GET /api/v1/health/media-worker/`, but it reports the
 *    laptop media worker only, and it answers **200** with
 *    `{"media_worker_alive": false}` whenever the `media_worker:alive` key is
 *    absent (backend/app/views/system_health.py). Its 503 means Redis was
 *    unreachable, *not* that the hybrid deployment is unused — so on a non-hybrid
 *    stack it reports a permanent, un-actionable false.
 *
 * The initial state is `checking`, never `healthy`. A health indicator that
 * shows green before it has asked anything is worse than no indicator.
 */

export type BackendHealthStatus = "checking" | "healthy" | "unreachable";

export interface BackendHealth {
  status: BackendHealthStatus;
  /** Epoch ms of the last completed probe, or null if none has finished. */
  lastCheckedAt: number | null;
  /** Message from the most recent failure, or null when the last probe passed. */
  lastError: string | null;
}

export const HEALTH_POLL_INTERVAL_MS = 30_000;

/**
 * Bounds a single probe. `apiRequest` takes an `AbortSignal` and `fetch` does
 * not time out on its own, so a half-open connection would leave the indicator
 * on `checking` for ever — a different flavour of the same lie: nothing is
 * coming back, and that is knowable.
 */
export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

const INITIAL_STATE: BackendHealth = {
  status: "checking",
  lastCheckedAt: null,
  lastError: null,
};

interface LivenessBody {
  status?: string;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Health check failed";
}

export interface UseBackendHealthOptions {
  /** Overridable for tests. */
  intervalMs?: number;
  timeoutMs?: number;
  /** When false the hook stops polling entirely and holds the current state. */
  enabled?: boolean;
}

export function useBackendHealth(options: UseBackendHealthOptions = {}): BackendHealth {
  const {
    intervalMs = HEALTH_POLL_INTERVAL_MS,
    timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
    enabled = true,
  } = options;

  const [state, setState] = useState<BackendHealth>(INITIAL_STATE);

  // Kept in a ref so the polling effect can read the current values without
  // re-subscribing: changing the interval should not restart the probe chain.
  const configRef = useRef({ intervalMs, timeoutMs });
  configRef.current = { intervalMs, timeoutMs };

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;

    // `stale` is the write-permission for the probe currently in flight. It is
    // revoked on unmount and on timeout, so a response that arrives after the
    // probe was abandoned cannot overwrite a verdict already reported. Note
    // that `controller.abort()` alone does NOT achieve this: whether `fetch`
    // honours the signal is up to the transport, so a late 200 can still
    // resolve and would otherwise flip the indicator back to healthy.
    let stale = false;

    const probe = async (signal: AbortSignal): Promise<void> => {
      // `skipAuth` keeps the probe off the token-refresh path: a health check
      // must not be able to rotate a session, and must not 401-loop.
      const liveness = await apiRequest<LivenessBody>("/health/", {
        method: "GET",
        skipAuth: true,
        signal,
      });

      // A 200 carrying a proxy's HTML error page is not a healthy backend.
      // `apiRequest` returns text (not JSON) in that case, so the status field
      // is what actually distinguishes the two.
      if (liveness?.status !== "healthy") {
        throw new Error("Liveness probe did not report healthy");
      }

      // 503 here is turned into a throw by `apiRequest`, so reaching the next
      // line means the database answered `SELECT 1`.
      await apiRequest("/ready/", { method: "GET", skipAuth: true, signal });

      if (cancelled || stale) return;
      setState({ status: "healthy", lastCheckedAt: Date.now(), lastError: null });
    };

    const runProbe = async (): Promise<void> => {
      if (cancelled) return;

      stale = false;
      const controller = new AbortController();
      inFlight = controller;
      const { intervalMs: interval, timeoutMs: timeout } = configRef.current;

      // The race is the load-bearing part, not the abort. It guarantees the
      // indicator leaves `checking` on a hung transport regardless of whether
      // the fetch implementation honours the signal. The abort is still
      // issued, so the request stops occupying a socket.
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const expiryRejection = new Promise<never>((_, reject) => {
        expiry = setTimeout(() => {
          stale = true;
          controller.abort();
          reject(new Error(`Health check timed out after ${timeout}ms`));
        }, timeout);
      });

      try {
        await Promise.race([probe(controller.signal), expiryRejection]);
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "unreachable",
          lastCheckedAt: Date.now(),
          lastError: describeFailure(error),
        });
      } finally {
        if (expiry !== undefined) clearTimeout(expiry);
        inFlight = null;
      }

      if (cancelled) return;
      // A chained setTimeout rather than setInterval: a slow probe cannot cause
      // requests to pile up, and the pending handle is a single value to clear.
      timer = setTimeout(() => void runProbe(), interval);
    };

    // Kick off immediately so the first paint is not a full interval of
    // `checking`, but via a timer so there is one scheduling path to reason
    // about and one handle to clear.
    timer = setTimeout(() => void runProbe(), 0);

    return () => {
      cancelled = true;
      stale = true;
      if (timer !== null) clearTimeout(timer);
      // Abort the in-flight request so it stops occupying a connection and its
      // late resolution is discarded by the `cancelled`/`stale` guards.
      inFlight?.abort();
    };
  }, [enabled]);

  return state;
}
