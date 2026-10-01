/// <reference types="vite/client" />

import {
  AuthTokens,
  Comment,
  CursorPaginated,
  FeedClip,
  FeedResponse,
  OwnProfile,
  PublicProfile,
  ShareEvent,
  User,
} from "../types/echoflow";

const STORAGE_KEY_ACCESS = "ef_access_token";
const STORAGE_KEY_REFRESH = "ef_refresh_token";
const STORAGE_KEY_USER = "ef_user";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:18000"
).replace(/\/+$/, "");

function apiUrl(endpoint: string): string {
  return endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;
}

export function getStoredTokens(): AuthTokens | null {
  const access = sessionStorage.getItem(STORAGE_KEY_ACCESS);
  const refresh = sessionStorage.getItem(STORAGE_KEY_REFRESH);
  if (access && refresh) {
    return { access, refresh };
  }
  return null;
}

export function setStoredTokens(tokens: AuthTokens | null) {
  if (tokens) {
    sessionStorage.setItem(STORAGE_KEY_ACCESS, tokens.access);
    sessionStorage.setItem(STORAGE_KEY_REFRESH, tokens.refresh);
  } else {
    sessionStorage.removeItem(STORAGE_KEY_ACCESS);
    sessionStorage.removeItem(STORAGE_KEY_REFRESH);
  }
}

export function getStoredUser(): User | null {
  const raw = sessionStorage.getItem(STORAGE_KEY_USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredUser(user: User | null) {
  if (user) {
    sessionStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  } else {
    sessionStorage.removeItem(STORAGE_KEY_USER);
  }
}

// ---------------------------------------------------------------------------
// ERROR CONTRACT
// ---------------------------------------------------------------------------

/**
 * Why a request failed. The question a call site actually has is not "did it
 * throw" but "did the server answer, and if not, why not" — because those
 * three cases need three different sentences and only one of them is the
 * server's fault.
 *
 * - `http`     — the server answered with a non-2xx. `status` is set.
 * - `network`  — no response was ever produced: offline, DNS, a refused
 *                connection, a CORS rejection. `status` is absent.
 * - `timeout`  — no response within the deadline. `status` is absent.
 *
 * `status` is absent rather than `0`/`null` on purpose. The Wave-1 call sites
 * decide "the server answered" with `typeof err.status === "number"`
 * (`Explore.tsx:34`, `Inbox.tsx:93`, `ShareModal.tsx:46`,
 * `CommentSheet.tsx:72`), so a synthetic 0 would tell a user on a dead
 * connection that "EchoFlow returned an error (0)".
 */
export type ApiFailureKind = "http" | "network" | "timeout";

export interface ApiErrorInit {
  kind: ApiFailureKind;
  /** Set only when `kind === "http"`. */
  status?: number;
  /** The response body as the server sent it, parsed when it was JSON. */
  data?: unknown;
  /** `Retry-After` in seconds. Absent when the server did not send one. */
  retryAfterSeconds?: number;
}

/**
 * The only error `apiRequest` and `mediaAPI.getPlaybackToken` throw.
 *
 * Before this, a caller received one of two unrelated things: an `Error` with
 * `.status` and `.data` bolted on when the server answered, or the raw
 * `TypeError` from a failed `fetch`. Nothing could tell them apart, so
 * `ShareModal` mapped a 429, a 500 and a dead connection to the single
 * sentence "Peer listener not found in directory." — false in three of the
 * four cases, and it tells the user their username is wrong when the real
 * problem is their connection.
 */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status?: number;
  readonly data?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(message: string, init: ApiErrorInit, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.data = init.data;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/**
 * The exact message the previous implementation produced when the server said
 * nothing usable.
 *
 * Kept verbatim, not improved. `ShareModal.tsx:59` and `CommentSheet.tsx:85`
 * both treat this string as the signal to substitute their own diagnosis, so
 * changing it would turn a call site's own fallback into a quote the server
 * never sent.
 */
const NO_USABLE_MESSAGE = "Request failed";

/**
 * The server's own words, when it sent any.
 *
 * Precedence is unchanged: `detail`, then `error`, then every value in the body
 * flattened. The backend mixes the two keys arbitrarily — `urls.py:79,88`
 * against `views/social.py:118-225` — so trying both is what stops a new
 * surface from showing the wrong message.
 *
 * The one thing added: markup is refused. A 5xx from a reverse proxy is an HTML
 * page, and a proxy that labels it `application/json` (or a gateway that wraps
 * it as `{"error": "<!doctype html>…"}`) would otherwise hand the user the
 * literal page source as the error message.
 */
function errorMessage(data: unknown): string {
  const record = data as { detail?: unknown; error?: unknown } | null | undefined;
  const candidate =
    record?.detail ||
    record?.error ||
    (typeof data === "object" && data !== null
      ? Object.values(data as Record<string, unknown>)
          .flat()
          .join(" ")
      : NO_USABLE_MESSAGE);
  // `String(...)` reproduces the message `new Error(candidate)` produced for a
  // non-string candidate, so every body that used to render identically still
  // does.
  const message = String(candidate);
  return message.trimStart().startsWith("<") ? NO_USABLE_MESSAGE : message;
}

/**
 * The response body, parsed when it is JSON.
 *
 * Read-then-parse rather than `response.json()`, because a `json()` on a
 * truncated or non-JSON body throws `SyntaxError` and leaves the body disturbed,
 * so the `text()` fallback could not then be read. That is how a proxy's HTML
 * 502 page escaped as an exception instead of an error a page could render.
 */
async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return response.text();
}

/**
 * `Retry-After`, in seconds, exactly as the server stated it.
 *
 * `CORS_EXPOSE_HEADERS` (`backend/EchoFlow/settings.py:89-97`) exposes this
 * header with a comment saying the client is required to honour it, and
 * nothing read it. DRF's throttles send delta-seconds; RFC 7231 also allows an
 * HTTP-date, which is not a number and is dropped rather than guessed at — so a
 * present value is always a real wait a call site can render, and an absent one
 * means the server did not say.
 *
 * Read and displayed only. Automatic retry/backoff is deliberately NOT
 * implemented: `telemetry` and `interaction` are both 60/min
 * (`settings.py:760-767`), so a client that retries on a 429 spends the
 * caller's remaining budget making the throttle worse. RECON-04 §11 defers the
 * enforcement half; nothing in this file performs a retry.
 */
function readRetryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Builds the error for a response the server actually sent. */
async function httpError(response: Response): Promise<ApiError> {
  const data = await readBody(response);
  return new ApiError(errorMessage(data), {
    kind: "http",
    status: response.status,
    // `data` stays verbatim, HTML page and all: it is the server's actual
    // response and is what `Upload.tsx:187-215` reads field errors out of.
    // Truncating it would hide the evidence. It is `message` that reaches a
    // human, and `errorMessage` refuses markup.
    data,
    retryAfterSeconds: readRetryAfterSeconds(response.headers),
  });
}

/**
 * What a request that never got an answer says.
 *
 * The transport's own words are kept, because they are the only description of
 * this failure that is actually true — "Failed to fetch", "NetworkError when
 * attempting to fetch resource." Replacing them with a generic sentence is a
 * downgrade, not a clarification: `Profile.tsx:37` and `Login.tsx:82` render
 * `err.message` for every failure kind, so whatever is dropped here is dropped
 * from the screen. The advice is appended, not substituted.
 */
function networkMessage(cause: unknown): string {
  const fromTransport = cause instanceof Error ? cause.message : "";
  const advice = "Check your connection and try again.";
  return fromTransport ? `${fromTransport}. ${advice}` : `Could not reach the server. ${advice}`;
}

// Single-flight refresh token mutex
let refreshPromise: Promise<string | null> | null = null;

/**
 * Default deadline for one `apiRequest` call, in milliseconds.
 *
 * `fetch` has no timeout of its own (F8): a half-open connection leaves
 * `Login`, `Upload`, `OnboardingModal`, `Explore`, `Inbox`, `Feed`,
 * `CommentSheet`, `Profile` and `ShareModal` on a spinner or a disabled button
 * for ever, and a user cannot tell that from a slow server.
 *
 * 15s is sized for the slowest *small* request in this API, not for the
 * average one. `GET /feed/` pops ten ids from Redis and runs a pgvector
 * similarity search; `GET /profile/me/` is one indexed row. Both are
 * sub-second on the VPS the client actually talks to (see
 * `docs/EXPLAIN/DEPLOYMENT/`), and 15s leaves several multiples of headroom
 * for a congested database or a gunicorn queue. It is long enough that a
 * healthy-but-slow request is never cut off, and short enough that "nothing is
 * coming back" is a state the user reaches in a few seconds.
 *
 * The deadline covers the whole call — the request, the 401 refresh, the replay
 * and reading the body — because that is the operation the user is waiting for.
 * One number, one knob: an endpoint that legitimately needs longer passes an
 * explicit `timeoutMs` rather than the global value being raised for everyone.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Deadline for the two `FormData` callers, `POST /clips/` and
 * `PATCH /profile/me/update/`.
 *
 * A single global default is wrong here. `POST /clips/` accepts up to 100 MB on
 * Pro (`REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE` is 10 MB on free), and 100 MB on a
 * phone link is minutes of transfer, not seconds: aborting at 15s would break
 * every mobile upload to protect a page nobody is waiting on. 5 minutes covers
 * that body at roughly 2.7 Mbit/s, which is a slow-4G rate, and is still a
 * finite, honest failure rather than the unbounded spinner F8 removes.
 *
 * It is not resumable and not progress-reporting. Chunked upload and XHR
 * progress are the real answer and are deliberately out of scope (RECON-04 §11,
 * F26); a user on a very slow link may still need to retry, and will now be
 * told that instead of watching an indefinite bar.
 */
export const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Which non-OK statuses from `/auth/token/refresh/` mean the session is over.
 *
 * The previous check was `if (!res.ok)`, which conflated four unrelated
 * failures into one verdict. A 429 is the `token_refresh` throttle
 * (`settings.py:783`, 120/hour); a 5xx is a deploy, a gunicorn restart or a
 * database blip; a 404/405 means the route moved. Signing every user out
 * because a deploy took four seconds is the bug this replaces, and it is the
 * one that produced "Your session expired. Please sign in again." for users
 * whose tokens were perfectly valid (F5).
 *
 * What is left is a verdict about *the credential*:
 *
 * - **401** — simplejwt rejecting the refresh token: expired, invalidated, or
 *   blacklisted by a rotation another tab already consumed. RECON-02 §1 exit
 *   1c: the only branch that was ever correct.
 * - **400** — `TokenRefreshSerializer` raises `InvalidToken`, which DRF renders
 *   as 400 with `code: "token_not_valid"`. The stored token cannot be parsed,
 *   so it can never succeed; keeping it would re-enter this branch on every
 *   later request and fail identically each time.
 * - **403** — a permission layer or proxy refusing the credential. Not a
 *   throttle (throttles are 429) and not an outage, so the credential is the
 *   only thing in question.
 */
function isSessionOver(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

async function refreshAccessToken(signal: AbortSignal): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens?.refresh) {
    return null;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(apiUrl("/auth/token/refresh/"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: tokens.refresh }),
        signal,
      });

      if (!res.ok) {
        if (isSessionOver(res.status)) {
          setStoredTokens(null);
          setStoredUser(null);
          window.dispatchEvent(new CustomEvent("ef_session_expired"));
          return null;
        }
        // Not the session. Keep the tokens, keep the app signed in, and hand
        // the caller the failure the server actually just produced — including
        // `Retry-After` when a throttle sent one. The 401 that started this is
        // a symptom; the 429 or 502 is the diagnosis.
        throw await httpError(res);
      }

      const data = await res.json();
      const newTokens: AuthTokens = {
        access: data.access,
        refresh: data.refresh || tokens.refresh, // ROTATE_REFRESH_TOKENS
      };
      setStoredTokens(newTokens);
      return newTokens.access;
    } catch (err) {
      if (err instanceof ApiError) throw err;

      if (signal.aborted) {
        // A cancellation is not a verdict about the session. It means the
        // caller's deadline elapsed, or the component unmounted — neither says
        // anything about whether the tokens are valid, and signing the user
        // out on one is the same class of mistake as signing them out on a 502.
        throw new ApiError(
          "The session refresh was cancelled before it completed.",
          { kind: "timeout" },
          { cause: err },
        );
      }

      // A transport failure: no connection, DNS, a refused or reset socket, a
      // CORS rejection. The tokens cannot be read back by anything, so they
      // go — but the app is told, which is the whole point. Before this, the
      // `catch` cleared storage and returned null: the user kept the signed-in
      // shell with no credentials, every action 401ing into a `console.warn`,
      // and a manual reload as the only cure (F6). `ef_session_expired` is the
      // app's one tree-teardown signal, and `SessionNotice` is mounted outside
      // the `isAuthenticated` conditional (`App.tsx:145-146`) precisely so the
      // explanation survives the transition.
      setStoredTokens(null);
      setStoredUser(null);
      window.dispatchEvent(new CustomEvent("ef_session_expired"));
      throw new ApiError(networkMessage(err), { kind: "network" }, { cause: err });
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface ApiRequestOptions extends RequestInit {
  skipAuth?: boolean;
  /**
   * Overrides `REQUEST_TIMEOUT_MS` for this call. Present because a single
   * global default is wrong for the two `FormData` bodies, which are the only
   * callers that move more than a few kilobytes; see `UPLOAD_TIMEOUT_MS`.
   * Nothing else should need it.
   */
  timeoutMs?: number;
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const {
    skipAuth,
    timeoutMs = REQUEST_TIMEOUT_MS,
    headers: customHeaders,
    signal: callerSignal,
    ...rest
  } = options;

  const headers = new Headers(customHeaders || {});
  const isFormData = rest.body instanceof FormData;

  if (!isFormData && !headers.has("Content-Type") && rest.method && rest.method !== "GET") {
    headers.set("Content-Type", "application/json");
  }

  let tokens = getStoredTokens();
  if (!skipAuth && tokens?.access) {
    headers.set("Authorization", `Bearer ${tokens.access}`);
  }

  // The deadline is two mechanisms, and both are load-bearing.
  //
  // The abort stops the request occupying a socket, which a race alone would
  // not. The race is what guarantees the promise rejects at all: whether
  // `fetch` honours the signal is up to the transport, so a late response can
  // still resolve. `useBackendHealth.ts:143-153` says the same thing about its
  // own probe, and copies the pattern for the same reason.
  //
  // `expired` is what distinguishes "our deadline fired" from a cancellation
  // the caller asked for (`useBackendHealth` passes its own signal). Only the
  // former may be reported as a timeout.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  let expired = false;
  let rejectDeadline: ((reason: ApiError) => void) | null = null;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const expiry = setTimeout(() => {
    expired = true;
    controller.abort();
    rejectDeadline?.(
      new ApiError(`Request timed out after ${timeoutMs}ms`, { kind: "timeout" }),
    );
  }, timeoutMs);

  const run = async (): Promise<T> => {
    let response = await fetch(apiUrl(endpoint), {
      ...rest,
      headers,
      signal: controller.signal,
    });

    // Handle 401 with single-flight refresh rotation
    if (response.status === 401 && !skipAuth && tokens?.refresh) {
      const newAccess = await refreshAccessToken(controller.signal);
      if (newAccess) {
        headers.set("Authorization", `Bearer ${newAccess}`);
        response = await fetch(apiUrl(endpoint), {
          ...rest,
          headers,
          signal: controller.signal,
        });
      }
    }

    if (response.status === 204) {
      return null as unknown as T;
    }

    if (!response.ok && response.status !== 202) {
      // 202 passthrough preserved deliberately: `POST /clips/` answers
      // "accepted, still processing" and the upload and telemetry contracts
      // are built on it. A 202 is not a success either — it is not a failure.
      throw await httpError(response);
    }

    return (await readBody(response)) as T;
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    // A fetch that rejected because *we* aborted reports a plain
    // `AbortError`/`TypeError`, which is indistinguishable from a dead network
    // unless the deadline is checked. Without this the two would be reported
    // identically, and "you are offline" is a false statement about a request
    // that was merely slow.
    if (expired) {
      throw new ApiError(
        `Request timed out after ${timeoutMs}ms`,
        { kind: "timeout" },
        { cause: err },
      );
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(networkMessage(err), { kind: "network" }, { cause: err });
  } finally {
    clearTimeout(expiry);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE API METHODS
// ---------------------------------------------------------------------------

export const authAPI = {
  // SECURITY / DPDP §6: consent_accepted and terms_version are REQUIRED by
  // RegisterSerializer (backend/app/serializers.py:496-497). Omitting them
  // returns 400, so registration 400'd for every user until this was fixed
  // (ISSUE-16). termsVersion comes from GET /legal/compliance/ (A1) so that
  // appending a version to TERMS_VERSIONS does not break every client.
  //
  // SECURITY / DPDP §9: `dob` is REQUIRED (serializers.py:512) and `parentEmail`
  // is required when the computed age is under 18. `dob` was previously
  // optional, which was itself the bypass: a client that omitted it was
  // registered as an adult and had its telemetry processed under the adult
  // path. Future dates and dates over 120 years ago are rejected server-side.
  async register(
    username: string,
    email: string,
    password: string,
    termsVersion: string,
    dob: string,
    parentEmail?: string,
  ): Promise<User> {
    const body: Record<string, unknown> = {
      username,
      email,
      password,
      consent_accepted: true,
      terms_version: termsVersion,
      dob,
    };
    if (parentEmail) body.parent_email = parentEmail;
    const user = await apiRequest<User>("/auth/register/", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify(body),
    });
    return user;
  },

  async getCompliance(): Promise<{
    terms_versions: string[];
    current_terms_version: string;
    privacy_version: string;
    physical_address: string;
  }> {
    return apiRequest("/legal/compliance/", { method: "GET", skipAuth: true });
  },

  async login(username: string, password: string): Promise<AuthTokens> {
    const tokens = await apiRequest<AuthTokens>("/auth/login/", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    setStoredTokens(tokens);
    return tokens;
  },

  async logout(): Promise<void> {
    const tokens = getStoredTokens();
    if (tokens?.refresh) {
      try {
        await apiRequest("/auth/logout/", {
          method: "POST",
          body: JSON.stringify({ refresh: tokens.refresh }),
        });
      } catch (err) {
        console.warn("Server logout notification failed:", err);
      }
    }
    setStoredTokens(null);
    setStoredUser(null);
  },
};

export const feedAPI = {
  async getFeed(): Promise<FeedResponse> {
    return apiRequest<FeedResponse>("/feed/");
  },

  async getSuggestions(category: string = "all"): Promise<CursorPaginated<FeedClip>> {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    return apiRequest<CursorPaginated<FeedClip>>(`/suggestions/${q}`);
  },

  async initializeTags(selected_tags: string[]): Promise<{ status: string }> {
    return apiRequest<{ status: string }>("/tags/initialize/", {
      method: "POST",
      body: JSON.stringify({ selected_tags }),
    });
  },
};

export const clipsAPI = {
  async uploadClip(formData: FormData): Promise<{ message: string; clip_id: string; status: string }> {
    return apiRequest<{ message: string; clip_id: string; status: string }>("/clips/", {
      method: "POST",
      body: formData,
      // The one call that can carry 100 MB. The default deadline would abort
      // every mobile upload; see `UPLOAD_TIMEOUT_MS` for the arithmetic.
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  async updateClip(id: string, updates: { title?: string; category?: string }): Promise<FeedClip> {
    return apiRequest<FeedClip>(`/clips/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  },

  async deleteClip(id: string): Promise<void> {
    return apiRequest<void>(`/clips/${id}/`, {
      method: "DELETE",
    });
  },
};

export const interactionsAPI = {
  async toggleLike(clipId: string): Promise<{ status: "liked" | "unliked" }> {
    return apiRequest<{ status: "liked" | "unliked" }>(`/interactions/${clipId}/toggle-like/`, {
      method: "POST",
    });
  },

  async registerSkip(clipId: string, data: { listen_duration_ms: number; reel_position_ms: number; reel_id: string }): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/interactions/${clipId}/register-skip/`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async logTelemetry(clipId: string, data: { action_type: "view" | "like" | "share" | "skip"; watch_time_ms: number }): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/interactions/${clipId}/log-telemetry/`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
};

export const commentsAPI = {
  async getComments(clipId: string, parentId?: string | null): Promise<CursorPaginated<Comment>> {
    const params = new URLSearchParams();
    params.set("clip", clipId);
    if (parentId) {
      params.set("parent", parentId);
    }
    return apiRequest<CursorPaginated<Comment>>(`/comments/?${params.toString()}`);
  },

  async postComment(clip: string, text: string, parent?: string | null): Promise<Comment> {
    return apiRequest<Comment>("/comments/", {
      method: "POST",
      body: JSON.stringify({ clip, text, parent: parent || null }),
    });
  },

  async updateComment(id: string, text: string): Promise<Comment> {
    return apiRequest<Comment>(`/comments/${id}/`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    });
  },

  async deleteComment(id: string): Promise<void> {
    return apiRequest<void>(`/comments/${id}/`, {
      method: "DELETE",
    });
  },
};

export const shareAPI = {
  async findUser(username: string): Promise<{ id: number; username: string }> {
    return apiRequest<{ id: number; username: string }>(`/share/find-user/?username=${encodeURIComponent(username)}`);
  },

  async sendShare(clipId: string, receiverId: number): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/share/${clipId}/send-share/`, {
      method: "POST",
      body: JSON.stringify({ receiver_id: receiverId }),
    });
  },

  async getInbox(): Promise<ShareEvent[]> {
    return apiRequest<ShareEvent[]>("/share/inbox/");
  },

  async getUnreadCount(): Promise<{ unread: number }> {
    return apiRequest<{ unread: number }>("/share/unread-count/");
  },

  // CRITICAL SPEC FIX: Method is POST per backend views/social.py:92-95
  async markRead(shareId: number): Promise<void> {
    return apiRequest<void>(`/share/${shareId}/mark-read/`, {
      method: "POST",
    });
  },

  async deleteShare(shareId: number): Promise<void> {
    return apiRequest<void>(`/share/${shareId}/share-delete/`, {
      method: "DELETE",
    });
  },
};

export const followAPI = {
  async toggleFollow(userId: number): Promise<{ status: "followed" | "unfollowed" }> {
    return apiRequest<{ status: "followed" | "unfollowed" }>(`/follow/${userId}/toggle-follow/`, {
      method: "POST",
    });
  },
};

export const profileAPI = {
  async getMyProfile(): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/profile/me/");
  },

  async updateMyProfile(formData: FormData): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/profile/me/update/", {
      method: "PATCH",
      body: formData,
      // Multipart like the upload, so it gets the same multipart deadline
      // rather than a second, differently-sized one to remember.
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  async getPublicProfile(userId: number): Promise<PublicProfile> {
    return apiRequest<PublicProfile>(`/profile/${userId}/`);
  },

  async getUserClips(userId: number): Promise<CursorPaginated<FeedClip>> {
    return apiRequest<CursorPaginated<FeedClip>>(`/profile/${userId}/clips/`);
  },
};

export const mediaAPI = {
  /**
   * Mints the `ef_hls_token` playback credential for one clip.
   *
   * SECURITY: POST, not GET. Minting a credential must not be a safe method —
   * a GET is CSRF-able (the cookie is SameSite=Lax), prefetchable by browsers
   * and proxies, and cacheable by intermediaries, any of which would mint
   * tokens nobody asked for.
   *
   * SECURITY: `credentials: "include"` is load-bearing. The cookie is HttpOnly
   * and cross-site in production (set by `api.`, sent to `media.`), so without
   * this the browser silently discards the `Set-Cookie` and every `/hls/*`
   * request 403s. This is not the same code path as `apiRequest` above,
   * which never needs the cookie jar.
   *
   * The token is per-clip and short-lived (MEDIA_TOKEN_TTL_SECONDS, default
   * 600s). Switching clips requires a new one. Callers must treat a failure
   * as terminal for that clip — the `hls/` prefix is not public-read and is
   * validated at the edge on every request, so there is no unauthenticated
   * fallback path.
   *
   * KNOWN GAP, deliberately not closed here: this stays a raw `fetch`, so a 401
   * from this endpoint neither refreshes the access token nor dispatches
   * `ef_session_expired`. A user who has been idle past the 15-minute access
   * token sees `playbackError` at `player.tsx:223-231` and nothing else — the
   * app still believes it is signed in. Routing this through `apiRequest` is
   * the obvious fix and is exactly why it is not done: a feed that mints a
   * token per clip would then enter the refresh path per clip, which is the
   * loop this exception exists to avoid. The real fix is a proactive refresh
   * before expiry, which is a separate change to `auth.tsx`.
   */
  async getPlaybackToken(clipId: string): Promise<{ status: string }> {
    const response = await fetch(apiUrl(`/media/playback-token/${clipId}/`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getStoredTokens()?.access || ""}`,
      },
      credentials: "include",
    });

    if (!response.ok) {
      // 409 = media still processing, 403 = unmoderated/unavailable,
      // 404 = gone, 401 = session expired. The player maps these distinctly,
      // and a 409 from `find-user` is a username case collision
      // (`docs/frontend/DECISIONS.md` §D7.4) — both need the status to survive
      // to the call site, which is why this throws the shared `ApiError`
      // rather than a bare `Error` with `.status` bolted on.
      throw new ApiError("Playback token issuance failed", {
        kind: "http",
        status: response.status,
        data: await readBody(response).catch(() => null),
        retryAfterSeconds: readRetryAfterSeconds(response.headers),
      });
    }
    return response.json();
  },
};
