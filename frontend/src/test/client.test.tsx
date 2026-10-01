/**
 * The API client's error contract and session lifecycle.
 *
 * `client.ts` is the request path for 27 of the app's 30 call sites (RECON-04
 * §7). Everything downstream — whether a user is signed out, whether a page
 * shows "check your connection" or "the server returned an error" — is decided
 * here, so the four properties pinned here are the ones a later wave has to be
 * able to rely on:
 *
 * 1. **Only a genuine credential rejection ends the session.** A 429 or a 5xx
 *    from `/auth/token/refresh/` means the throttle was hit or the deploy is
 *    mid-restart, not that the user signed out. Treating them the same signed
 *    every user out during a four-second deploy (F5).
 * 2. **A transport failure does end it, loudly.** Tokens were unreachable, so
 *    without `ef_session_expired` the app kept rendering the signed-in shell
 *    with every action 401ing into a `console.warn` — a zombie app whose only
 *    cure was a manual reload (F6).
 * 3. **A request that never returns returns.** `fetch` has no timeout of its
 *    own, so every spinner in the app was unbounded (F8).
 * 4. **A 429 says how long to wait.** `CORS_EXPOSE_HEADERS` exposes
 *    `Retry-After` with a comment saying the client is required to honour it,
 *    and nothing read it (F7).
 *
 * The `ApiError` shape is asserted through the same structural reads the
 * Wave-1 call sites use — `typeof err.status === "number"` for "the server
 * answered" (`Explore.tsx:34`, `Inbox.tsx:93`, `ShareModal.tsx:46`,
 * `CommentSheet.tsx:72`) — so a change that breaks them breaks these too.
 *
 * Route registration: `fetchMock` matches the FIRST registered route, and the
 * instance is recreated per test, so a route from a previous test can never
 * match by accident.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  apiRequest,
  getStoredTokens,
  mediaAPI,
  REQUEST_TIMEOUT_MS,
  shareAPI,
  UPLOAD_TIMEOUT_MS,
  type ApiError,
} from "../api/client";
import App from "../App";
import { installFetchMock, json, tooManyRequests, type FetchMock } from "./fetchMock";

const ACCESS = "access-token-1";
const REFRESH = "refresh-token-1";

let api: FetchMock;

/** Seeds a signed-in session: tokens plus the cached user `auth.tsx` reads. */
function signIn(access = ACCESS, refresh = REFRESH) {
  sessionStorage.setItem("ef_access_token", access);
  sessionStorage.setItem("ef_refresh_token", refresh);
  sessionStorage.setItem(
    "ef_user",
    JSON.stringify({ id: 7, username: "listener", email: "listener@echoflow.in" }),
  );
}

/**
 * Records every `ef_session_expired` dispatch. Calling the returned function
 * detaches the listener and reports how many were seen.
 */
function watchSessionExpiry(): () => number {
  let count = 0;
  const handler = () => {
    count += 1;
  };
  window.addEventListener("ef_session_expired", handler);
  return () => {
    window.removeEventListener("ef_session_expired", handler);
    return count;
  };
}

/** The tokens still in storage, or `null` if they were cleared. */
function storedAccessToken(): string | null {
  return sessionStorage.getItem("ef_access_token");
}

/** Narrows an unknown rejection to the `ApiError` the client is contracted to throw. */
async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("Expected the request to reject, but it resolved.");
}

beforeEach(() => {
  api = installFetchMock();
});

// ---------------------------------------------------------------------------
// F5 — which refresh failures mean the session is over
// ---------------------------------------------------------------------------

describe("refresh: a genuine credential rejection ends the session", () => {
  it("signs out on 401 from the refresh endpoint, clears storage and says why", async () => {
    signIn();
    const expiries = watchSessionExpiry();

    api.on("GET", /\/share\/inbox\//, () => json(401, { detail: "Given token not valid" }));
    api.on("POST", /\/auth\/token\/refresh\//, () => json(401, { detail: "Token is blacklisted" }));

    const err = await captureError(shareAPI.getInbox());

    expect(expiries()).toBe(1);
    expect(storedAccessToken()).toBeNull();
    expect(getStoredTokens()).toBeNull();
    // The caller is told the truth: its own request was rejected, and the
    // session really is gone, so the 401 is the correct thing to hand back.
    expect(err.status).toBe(401);
  });

  it("signs out on 400 from the refresh endpoint, because that token can never work", async () => {
    // simplejwt's `TokenRefreshSerializer` raises `InvalidToken` -> 400 for a
    // refresh token it cannot parse. Keeping it would re-enter this branch on
    // every later request and fail identically each time.
    signIn();
    const expiries = watchSessionExpiry();
    api.on("GET", /\/share\/inbox\//, () => json(401, { detail: "Given token not valid" }));
    api.on("POST", /\/auth\/token\/refresh\//, () => json(400, { code: "token_not_valid" }));

    await captureError(shareAPI.getInbox());

    expect(expiries()).toBe(1);
    expect(storedAccessToken()).toBeNull();
  });
});

describe("F5 — a throttle is not a session expiry", () => {
  it("keeps the session and surfaces the 429 when the refresh endpoint throttles", async () => {
    signIn();
    const expiries = watchSessionExpiry();
    api.on("GET", /\/share\/inbox\//, () => json(401, { detail: "Given token not valid" }));
    api.on("POST", /\/auth\/token\/refresh\//, () => tooManyRequests(37));

    const err = await captureError(shareAPI.getInbox());

    // Nothing is cleared and nothing is announced: the tokens in storage are
    // still good, and the next request can rotate them.
    expect(expiries()).toBe(0);
    expect(storedAccessToken()).toBe(ACCESS);
    expect(getStoredTokens()).toEqual({ access: ACCESS, refresh: REFRESH });
    // The error the caller sees is the one the server actually sent last, with
    // the wait attached — not the 401 that caused the refresh in the first place.
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(37);
  });

  it.each([500, 502, 503])(
    "keeps the session and surfaces the %i when the backend is unavailable",
    async (status) => {
      signIn();
      const expiries = watchSessionExpiry();
      api.on("GET", /\/share\/inbox\//, () => json(401, { detail: "Given token not valid" }));
      // A 5xx body with DEBUG=False is an HTML page, not JSON.
      api.on("POST", /\/auth\/token\/refresh\//, () => ({
        status,
        body: "<!doctype html><html><body>Bad Gateway</body></html>",
        headers: { "content-type": "text/html" },
      }));

      const err = await captureError(shareAPI.getInbox());

      expect(expiries()).toBe(0);
      expect(storedAccessToken()).toBe(ACCESS);
      expect(err.status).toBe(status);
      // A deploy that takes four seconds must not produce "Your session
      // expired", and must not put an HTML page in front of a human either.
      expect(err.message).not.toContain("<");
    },
  );
});

// ---------------------------------------------------------------------------
// F6 — a transport failure inside the refresh must not leave a zombie app
// ---------------------------------------------------------------------------

describe("F6 — a transport failure inside the refresh ends the session loudly", () => {
  it("dispatches the event, clears storage and throws a network error", async () => {
    signIn();
    const expiries = watchSessionExpiry();
    api.on("GET", /\/share\/inbox\//, () => json(401, { detail: "Given token not valid" }));
    api.fail("POST", /\/auth\/token\/refresh\//, new TypeError("Failed to fetch"));

    const err = await captureError(shareAPI.getInbox());

    // Before the fix this cleared storage and returned null, so the app kept
    // rendering the signed-in shell with no credentials and no way back.
    expect(expiries()).toBe(1);
    expect(storedAccessToken()).toBeNull();
    // `status` is absent, so `Explore`/`Inbox`/`ShareModal`/`CommentSheet`
    // classify it as "could not reach the server" rather than a server error.
    expect(err.status).toBeUndefined();
    expect(err.kind).toBe("network");
  });

  it("reaches the login screen: the event tears down the authenticated tree", async () => {
    // The killer case from RECON-02 §1. Asserting the event fired proves
    // nothing about the UI; this asserts the tree actually changed. On mount
    // `auth.tsx` reads the cached user out of storage, so the app believes it
    // is signed in — and only `ef_session_expired` can take that away. Before
    // the fix the refresh's network throw cleared storage but not React state,
    // so this rendered the full signed-in shell and the user was stuck in it.
    signIn();
    api.on("GET", /\/profile\/me\//, () => json(401, { detail: "Given token not valid" }));
    api.fail("POST", /\/auth\/token\/refresh\//, new TypeError("Failed to fetch"));
    api.on("GET", /\/feed\//, () => json(200, { results: [] }));
    // First match wins, so this is registered last: everything the shell
    // polls while it is still (briefly) authenticated.
    api.on("*", /.*/, () => json(200, {}));

    render(<App />);

    // The shell is gone and the login form is up...
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Authentication mode" })).toBeInTheDocument(),
    );
    // ...with the notice that explains why, which is mounted outside the
    // `isAuthenticated` conditional for exactly this transition.
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// F7 — Retry-After
// ---------------------------------------------------------------------------

describe("F7 — a 429 carries the wait the server asked for", () => {
  it("surfaces the exact Retry-After seconds the server sent", async () => {
    signIn();
    const throttle = tooManyRequests(37);
    api.on("POST", /\/interactions\/.*\/toggle-like\//, () => throttle);

    const err = await captureError(
      apiRequest("/interactions/clip-1/toggle-like/", { method: "POST" }),
    );

    expect(err.status).toBe(429);
    // The real header value, not a number invented by the client.
    expect(err.retryAfterSeconds).toBe(37);
    expect(err.retryAfterSeconds).toBe(
      Number.parseInt(String(throttle.headers?.["retry-after"]), 10),
    );
  });

  it("reads the wait only when the server actually sent one", async () => {
    // All three cases in one test on purpose. Asserting only the two negative
    // cases would pass against a client that never reads the header at all,
    // which is exactly what it did before this change.
    signIn();
    const numeric = tooManyRequests(41);
    api.on("POST", /interactions\/numeric\//, () => numeric);
    api.on("POST", /interactions\/absent\//, () => json(429, { detail: "Request was throttled." }));
    // RFC 7231 also allows an HTTP-date, which is not a number of seconds.
    api.on("POST", /interactions\/date\//, () => ({
      status: 429,
      body: { detail: "Request was throttled." },
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    }));

    const like = (clipId: string) =>
      captureError(apiRequest(`/interactions/${clipId}/toggle-like/`, { method: "POST" }));

    const withHeader = await like("numeric");
    const withoutHeader = await like("absent");
    const withDate = await like("date");

    expect(withHeader.retryAfterSeconds).toBe(41);
    // A missing header means "the server did not say", not "retry now".
    expect(withoutHeader.status).toBe(429);
    expect(withoutHeader.retryAfterSeconds).toBeUndefined();
    // An HTTP-date is dropped rather than guessed at, so a present value is
    // always a real number of seconds a call site can render.
    expect(withDate.status).toBe(429);
    expect(withDate.retryAfterSeconds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F8 — a request that never returns must return
// ---------------------------------------------------------------------------

describe("F8 — every request is bounded", () => {
  it("rejects a hung request with a timeout, distinguishable from a network error", async () => {
    signIn();
    api.hang("GET", /\/feed\//);
    vi.useFakeTimers();

    const pending = captureError(apiRequest("/feed/"));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const err = await pending;

    expect(err.kind).toBe("timeout");
    // No `status`: a timeout is not a server verdict, and the Wave-1 call
    // sites read an absent status as "could not reach the server".
    expect(err.status).toBeUndefined();
    expect(err.message).toContain(String(REQUEST_TIMEOUT_MS));
  });

  it("does not time out a request that answers in time", async () => {
    // The guard against an over-eager deadline: if the timer were not cleared,
    // or the race were wired backwards, this would reject instead of resolving.
    signIn();
    api.on("GET", /\/feed\//, () => json(200, { results: [{ id: "clip-1" }] }));
    vi.useFakeTimers();

    // No timer is advanced: the response arrives on the microtask queue.
    const data = await apiRequest<{ results: { id: string }[] }>("/feed/");

    expect(data.results).toEqual([{ id: "clip-1" }]);
    // And nothing is left armed to fire afterwards.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives an upload a deadline long enough for a 100 MB body", async () => {
    // `POST /clips/` is the one call that moves a hundred megabytes. A single
    // global default would abort every mobile upload, so the FormData callers
    // override it.
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS * 10);
  });
});

// ---------------------------------------------------------------------------
// Must-preserve
// ---------------------------------------------------------------------------

describe("contracts the rest of the app depends on", () => {
  it("passes a 202 through untouched", async () => {
    // Upload and telemetry are built on this: 202 means "accepted, still
    // processing", which must not be turned into a throw.
    signIn();
    const accepted = {
      message: "Clip accepted for processing",
      clip_id: "clip-9",
      status: "processing",
    };
    api.on("POST", /\/clips\//, () => json(202, accepted));

    await expect(apiRequest("/clips/", { method: "POST" })).resolves.toEqual(accepted);
  });

  it("keeps the detail-then-error fallback and the 400 body", async () => {
    signIn();
    // The backend mixes the two keys (`urls.py:79,88` vs `views/social.py:118`).
    api.on("POST", /\/comments\//, () => json(400, { error: "Comment text is required." }));

    const err = await captureError(apiRequest("/comments/", { method: "POST" }));
    expect(err.message).toBe("Comment text is required.");
    expect(err.data).toEqual({ error: "Comment text is required." });
  });

  it("flattens a field-error body into a readable message", async () => {
    signIn();
    api.on("POST", /\/comments\//, () => json(400, { text: ["This field may not be blank."] }));

    const err = await captureError(apiRequest("/comments/", { method: "POST" }));
    expect(err.message).toBe("This field may not be blank.");
  });

  it("keeps a 5xx an HTTP error without putting the HTML page in the message", async () => {
    signIn();
    const page =
      "<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>";
    api.on("GET", /\/profile\/me\//, () => ({
      status: 502,
      body: page,
      headers: { "content-type": "text/html" },
    }));

    const err = await captureError(apiRequest("/profile/me/"));

    // Still a server answer, so a call site may say "EchoFlow returned an
    // error (502)" instead of telling the user to check their connection.
    expect(err.kind).toBe("http");
    expect(err.status).toBe(502);
    expect(err.message).not.toContain("<");
    expect(err.message).toBe("Request failed");
  });

  it("does not put an HTML page in the message when the proxy labels it JSON", async () => {
    // A misconfigured proxy answers 5xx with `content-type: application/json`
    // and an HTML body. `data?.error` used to hand the page straight to the
    // user as the error message.
    signIn();
    api.on("GET", /\/profile\/me\//, () =>
      json(500, { error: "<!doctype html><html><body>Server Error</body></html>" }),
    );

    const err = await captureError(apiRequest("/profile/me/"));
    expect(err.status).toBe(500);
    expect(err.message).toBe("Request failed");
  });

  it("rotates once for two concurrent 401s: the single-flight mutex holds", async () => {
    // Established by a prior fix and pinned here because everything else in
    // this file touches the same function. Both requests 401, the single
    // refresh succeeds, and both must then be replayed with the new token.
    signIn();
    let attempts = 0;
    api.on("GET", /\/share\/unread-count\//, () => {
      attempts += 1;
      return attempts <= 2 ? json(401, { detail: "Given token not valid" }) : json(200, { unread: 0 });
    });
    api.on("POST", /\/auth\/token\/refresh\//, () =>
      json(200, { access: "access-token-2", refresh: "refresh-token-2" }),
    );

    const [first, second] = await Promise.all([
      shareAPI.getUnreadCount(),
      shareAPI.getUnreadCount(),
    ]);

    expect(api.callsTo(/\/auth\/token\/refresh\//)).toHaveLength(1);
    expect(first).toEqual({ unread: 0 });
    expect(second).toEqual({ unread: 0 });
    // Both originals carried the stale token; both replays carried the new one.
    const calls = api.callsTo(/\/share\/unread-count\//);
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.authorization === `Bearer ${ACCESS}`)).toHaveLength(2);
    expect(calls.filter((c) => c.authorization === "Bearer access-token-2")).toHaveLength(2);
    expect(getStoredTokens()).toEqual({ access: "access-token-2", refresh: "refresh-token-2" });
  });

  it("mints the HLS cookie credential without touching the refresh path", async () => {
    // `getPlaybackToken` stays a raw `fetch` on purpose: routing it through
    // `apiRequest` would let a per-clip 401 mint attempt start a refresh, and a
    // feed that mints a token per clip would refresh constantly.
    signIn();
    api.on("POST", /\/media\/playback-token\//, () => json(200, { status: "ok" }));

    await expect(mediaAPI.getPlaybackToken("clip-1")).resolves.toEqual({ status: "ok" });

    expect(api.callsTo(/\/auth\/token\/refresh\//)).toHaveLength(0);
    const mint = api.callsTo(/\/media\/playback-token\//);
    // Dropping `include` makes every `/hls/*` request 403: the cookie is
    // HttpOnly and cross-site, so the browser drops the `Set-Cookie` without it.
    expect(mint.map((c) => c.credentials)).toEqual(["include"]);
    expect(mint.map((c) => c.authorization)).toEqual([`Bearer ${ACCESS}`]);
  });

  it("still tells a 409 on playback-token issuance apart from other failures", async () => {
    // `player.tsx:224-231` maps 409/403/404 to distinct messages, and
    // `find-user` returns 409 on a username case collision (DECISIONS §D7.4).
    signIn();
    api.on("POST", /\/media\/playback-token\//, () =>
      json(409, { detail: "Media is still processing." }),
    );

    const err = await captureError(mediaAPI.getPlaybackToken("clip-1"));
    expect(err.status).toBe(409);
  });
});
