import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { Header } from "../components/common/Header";

/**
 * The header's health indicator was fabricated.
 *
 * It rendered an unconditional `text-green-400` "Workers Active" next to a
 * `bg-green-500 animate-ping` dot. Nothing polled anything, so it read as a
 * live heartbeat to an operator while saying that verbatim even when every
 * Celery worker was dead. `animate-ping` made it worse: a perpetual expanding
 * ring is a visual claim of continuous activity.
 *
 * Two separate lies are pinned below:
 *   1. It never asked the backend. A green state was rendered before any
 *      response could possibly have arrived.
 *   2. Even once polled, `GET /health/` is a Django *liveness* probe and
 *      `GET /ready/` checks *database* connectivity (backend/EchoFlow/health.py).
 *      Neither reports Celery worker liveness, so the replacement must not
 *      reuse the "Workers Active" wording.
 */

vi.mock("../stores/auth", () => ({
  useAuth: () => ({ user: { id: 1, username: "me" }, profile: null, isAuthenticated: true }),
}));

vi.mock("../stores/player", () => ({
  usePlayer: () => ({ handsFreeMode: false, setHandsFreeMode: vi.fn() }),
}));

const POLL_INTERVAL_MS = 30_000;

const HEALTHY_LIVENESS = () => json(200, { status: "healthy", timestamp: 1 });
const HEALTHY_READINESS = () => json(200, { status: "ready", database: "connected", timestamp: 1 });

/**
 * Drains the microtask queue so a settled probe's state update is flushed.
 *
 * `waitFor` is unusable in this file: under `vi.useFakeTimers()` it schedules
 * its own polling on faked timers and deadlocks until the test times out, which
 * looks exactly like "the component never updated". `advanceTimersByTimeAsync(0)`
 * awaits and flushes, so a resolved probe is observable synchronously after.
 */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Let the hook's initial zero-delay probe run. */
async function runInitialProbe() {
  await settle();
}

function renderHeader() {
  return render(
    <Header activeTab="feed" setActiveTab={() => {}} unreadCount={0} />,
  );
}

describe("Header backend health indicator", () => {
  let api: FetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    api = installFetchMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report healthy before the first response arrives", async () => {
    // THE regression. The old markup was static, so "Backend Ready" was on
    // screen from first paint and stayed there regardless of the backend.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /\/health\//, async () => {
      await gate;
      return HEALTHY_LIVENESS();
    });
    api.on("GET", /\/ready\//, async () => {
      await gate;
      return HEALTHY_READINESS();
    });

    renderHeader();

    // Synchronously after mount, before the request is even issued.
    expect(screen.queryByText("Backend Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();

    // Still pending once the request is in flight.
    await runInitialProbe();
    expect(api.callsTo(/health/)).toHaveLength(1);
    expect(screen.queryByText("Backend Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();

    // Only now, with a real 200 behind it.
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Backend Ready")).toBeInTheDocument();
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
  });

  it("reports unreachable when the backend cannot be reached", async () => {
    api.fail("GET", /\/health\//, new TypeError("Failed to fetch"));
    api.fail("GET", /\/ready\//, new TypeError("Failed to fetch"));

    renderHeader();
    await runInitialProbe();

    await settle();
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();
    expect(screen.queryByText("Backend Ready")).not.toBeInTheDocument();
    // And it must not keep claiming health.
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
  });

  it("reports unreachable when the transport hangs and the request times out", async () => {
    // A promise that never settles models a half-open TCP connection. Without
    // an abort the indicator would sit on "Checking" for ever, which is its own
    // lie: we have learned that nothing is coming back, not that all is well.
    api.on("GET", /health|ready/, async () => new Promise(() => {}));

    renderHeader();
    await runInitialProbe();
    expect(screen.getByText("Checking")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText("Not Reachable")).toBeInTheDocument();
  });

  it("does not report ready when liveness passes but the database is not", async () => {
    // /health/ is a liveness probe: it returns 200 even when Postgres is
    // unreachable. Reporting healthy on /health/ alone would be a fabricated
    // green, so both probes must pass.
    api.on("GET", /\/health\//, HEALTHY_LIVENESS);
    api.on("GET", /\/ready\//, () => json(503, { status: "not_ready", database: "error" }));

    renderHeader();
    await runInitialProbe();

    await settle();
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();
    expect(screen.queryByText("Backend Ready")).not.toBeInTheDocument();
  });

  it("does not report ready when /health/ answers 200 with an error page", async () => {
    // A proxy or captive portal can answer 200 with HTML. `apiRequest` hands
    // back text in that case, so the status field has to actually be checked.
    api.on("GET", /\/health\//, () => ({
      status: 200,
      body: "<html>502 Bad Gateway</html>",
      headers: { "content-type": "text/html" },
    }));
    api.on("GET", /\/ready\//, HEALTHY_READINESS);

    renderHeader();
    await runInitialProbe();

    await settle();
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();
  });

  it("does not let a timed-out probe overwrite the verdict when it lands late", async () => {
    // The timeout and the request race each other. When the timeout wins, the
    // request is still outstanding — a real `fetch` would reject on abort, but
    // nothing guarantees the transport honours the signal. If that late
    // success is allowed to write state, the indicator flips to "Backend
    // Ready" for a probe that was already declared dead, and then sits there
    // until the next poll contradicts it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /\/health\//, async () => {
      await gate;
      return HEALTHY_LIVENESS();
    });
    api.on("GET", /\/ready\//, async () => {
      await gate;
      return HEALTHY_READINESS();
    });

    renderHeader();
    await runInitialProbe();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();

    // The abandoned request finally answers 200.
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText("Backend Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();
  });

  it("recovers on its own after a transient failure", async () => {
    let healthy = false;
    api.on("GET", /\/health\//, () =>
      healthy ? HEALTHY_LIVENESS() : { status: 503, body: { detail: "restarting" } },
    );
    api.on("GET", /\/ready\//, () =>
      healthy ? HEALTHY_READINESS() : { status: 503, body: { detail: "restarting" } },
    );

    renderHeader();
    await runInitialProbe();
    await settle();
    expect(screen.getByText("Not Reachable")).toBeInTheDocument();

    healthy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(screen.getByText("Backend Ready")).toBeInTheDocument();
  });

  it("keeps polling on the interval while mounted", async () => {
    api.on("GET", /\/health\//, HEALTHY_LIVENESS);
    api.on("GET", /\/ready\//, HEALTHY_READINESS);

    renderHeader();
    await runInitialProbe();
    expect(api.callsTo(/health/)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });

    expect(api.callsTo(/health/)).toHaveLength(4);
    expect(api.callsTo(/ready/)).toHaveLength(4);
  });

  it("stops polling once unmounted", async () => {
    // A setTimeout chain that outlives its component keeps hitting the network
    // for a header that is no longer on screen, and calls setState on a dead
    // hook. This is the leak the cleanup return exists to prevent.
    api.on("GET", /\/health\//, HEALTHY_LIVENESS);
    api.on("GET", /\/ready\//, HEALTHY_READINESS);

    const { unmount } = renderHeader();
    await runInitialProbe();
    expect(api.callsTo(/health/)).toHaveLength(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    });

    expect(api.callsTo(/health/)).toHaveLength(1);
  });

  it("does not write state after unmount when a probe is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on("GET", /\/health\//, async () => {
      await gate;
      return HEALTHY_LIVENESS();
    });
    api.on("GET", /\/ready\//, async () => {
      await gate;
      return HEALTHY_READINESS();
    });

    const { unmount } = renderHeader();
    await runInitialProbe();
    expect(api.callsTo(/health/)).toHaveLength(1);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();

    // The response lands after the component is gone. React 19 no longer warns
    // on this, so assert the observable effect instead: the request was
    // aborted rather than left to resolve into a dead hook.
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    // No follow-up request was scheduled from the in-flight probe.
    expect(api.callsTo(/health/)).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("polls through the shared API layer, not a raw URL", async () => {
    const seenAuth: (string | null)[] = [];
    const record =
      (spec: () => ReturnType<typeof json>) =>
      async (req: { headers: Headers }) => {
        seenAuth.push(req.headers.get("authorization"));
        return spec();
      };

    api.on("GET", /\/health\//, record(HEALTHY_LIVENESS));
    api.on("GET", /\/ready\//, record(HEALTHY_READINESS));

    renderHeader();
    await runInitialProbe();

    const liveness = api.callsTo(/health/);
    const readiness = api.callsTo(/ready/);
    expect(liveness).toHaveLength(1);
    expect(readiness).toHaveLength(1);

    // Absolute, base-resolved URLs: `apiRequest` runs these through `apiUrl()`,
    // which joins them onto VITE_API_BASE_URL. A hand-written fetch("/health/")
    // would stay relative and a hardcoded origin would ignore the env var.
    expect(liveness[0]?.url).toMatch(/^https?:\/\/.+\/health\/$/);
    expect(readiness[0]?.url).toMatch(/^https?:\/\/.+\/ready\/$/);
    expect(liveness[0]?.method).toBe("GET");

    // Both probes are unauthenticated: a liveness probe must not drag an access
    // token along, and must not arm the 401 single-flight refresh path.
    expect(seenAuth).toEqual([null, null]);
  });
});
