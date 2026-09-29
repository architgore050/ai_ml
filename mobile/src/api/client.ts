import Constants from 'expo-constants';

import type { TokenPair } from './schema';

/**
 * API client. The single-flight refresh mutex is salvaged from the old app's
 * api.ts:75-114 (see SALVAGE.ts) and rewritten. Everything else is new.
 *
 * Rotated refresh tokens: `ROTATE_REFRESH_TOKENS: True` and
 * `BLACKLIST_AFTER_ROTATION: True` (backend/EchoFlow/settings.py:776-777). Every
 * refresh therefore returns a NEW refresh token and blacklists the old one, so
 * this **requires** `data.refresh` and must not fall back to the previous value.
 * The old client's `data.refresh || tokens.refresh` fallback could never fire
 * while rotation is on, and would resurrect an already-blacklisted token if
 * rotation were ever disabled — so it is a latent logout loop, not a safety net.
 *
 * Refresh throttling: keyed on the verified token subject, not IP, at 120/hour
 * (backend/app/throttling.py). The old `anon` 100/hour/IP was fatal on a mobile
 * network. Nothing here should reintroduce IP-keyed refresh.
 */

/* ------------------------------------------------------------------ */
/* Base URL — D9, https only                                            */
/* ------------------------------------------------------------------ */

/**
 * SECURITY: https is mandatory. nginx :443 is the only supported entrypoint;
 * `web:8005` is a plaintext debug escape hatch that AGENTS.md says to drop.
 *
 * The value is injected at build time by app.config.ts, which already refuses a
 * non-https `EXPO_PUBLIC_API_BASE_URL` at config-evaluation time. This second
 * check exists because `Constants.expoConfig` can be null in some contexts (a
 * bare Jest run, for one), and silently falling back to plaintext is exactly
 * the failure mode the old app shipped.
 */
function resolveBaseUrl(): string {
  const fromConfig = Constants.expoConfig?.extra?.apiBaseUrl;
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  const raw = (fromConfig ?? fromEnv ?? '').trim();

  if (!raw) {
    throw new Error(
      'API base URL is unset. Set EXPO_PUBLIC_API_BASE_URL (https://…) — see mobile/README.md.',
    );
  }
  if (!raw.startsWith('https://')) {
    throw new Error(
      `API base URL must be https, got "${raw}". nginx :443 is the only supported entrypoint (plan D9).`,
    );
  }
  return raw.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveBaseUrl();

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

export type FieldErrors = Record<string, string[]>;

/** Structured error. DRF validation errors are `{field: [msg, …]}`. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly fieldErrors: FieldErrors;
  readonly isNetwork: boolean;
  readonly isTimeout: boolean;

  constructor(init: {
    status: number;
    body: unknown;
    message?: string;
    isNetwork?: boolean;
    isTimeout?: boolean;
  }) {
    super(init.message ?? `API error ${init.status}`);
    this.name = 'ApiError';
    this.status = init.status;
    this.body = init.body;
    this.fieldErrors = extractFieldErrors(init.body);
    this.isNetwork = init.isNetwork ?? false;
    this.isTimeout = init.isTimeout ?? false;
  }

  /** 401 after a refresh attempt — the caller should sign out. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

function extractFieldErrors(body: unknown): FieldErrors {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const out: FieldErrors = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value as string[];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Token storage — injected, so tests can swap it                       */
/* ------------------------------------------------------------------ */

export interface TokenStore {
  getAccess(): Promise<string | null>;
  getRefresh(): Promise<string | null>;
  set(pair: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Emits when a session ends for good — a 401 that survived a refresh, or a
 * 7-day refresh-token expiry. Distinct from "this request failed", and distinct
 * from logout, so the UI can say "please sign in again" rather than "something
 * went wrong". Phase 1's auth store subscribes to this.
 */
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(fn: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(fn);
  return () => sessionExpiredListeners.delete(fn);
}

function emitSessionExpired(): void {
  sessionExpiredListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A misbehaving listener must not break the sign-out path.
    }
  });
}

/* ------------------------------------------------------------------ */
/* Refresh — single-flight mutex                                        */
/* ------------------------------------------------------------------ */

let refreshPromise: Promise<string | null> | null = null;

/**
 * One refresh at a time. Concurrent 401s (a feed page and a profile query
 * failing together) must not fire N refreshes: with rotation on, each refresh
 * blacklists the previous token, so a second concurrent refresh would present an
 * already-blacklisted token and log the user out.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refresh = await tokenStore.getRefresh();
    if (!refresh) return null;

    try {
      // rawFetch returns the PARSED BODY and already throws on any non-2xx — it
      // does not hand back a Response — so there is no `.ok`/`.json()` to
      // inspect. The first draft of this function checked `response.ok`, which
      // was dead code on a TokenPair: a 401 from this endpoint fell into the
      // generic catch and returned null WITHOUT clearing tokens or emitting
      // session-expired. That is the exact case the signal exists for, so the
      // status is read from the thrown ApiError instead.
      const data = await rawFetch<TokenPair>('/auth/token/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
        // skipAuth: a refresh must not recurse into the 401 handler.
        skipAuth: true,
      });

      if (!data.access || !data.refresh) {
        // Rotation is on, so a missing `refresh` is a contract break, not a
        // version quirk. Fail closed rather than storing a half-pair: the old
        // refresh is already blacklisted server-side by this point.
        await tokenStore.clear();
        emitSessionExpired();
        return null;
      }

      await tokenStore.set({ access: data.access, refresh: data.refresh });
      return data.access;
    } catch (err) {
      // 401/400: the refresh token is expired (7-day lifetime), blacklisted by a
      // previous rotation, or malformed. The session is genuinely over.
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
        await tokenStore.clear();
        emitSessionExpired();
      }
      // Anything else — a network blip, a 5xx — is NOT a session expiry. Returning
      // null without clearing is what keeps a flaky connection from logging the
      // user out mid-session.
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Omit the Authorization header (register, login, legal). */
  skipAuth?: boolean;
  /** Per-request timeout override, ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Number of 401 replays. Default 1. */
  retryOn401?: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;

async function rawFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    skipAuth = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    retryOn401 = true,
  } = options;

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers,
  };

  // FormData must set its own multipart boundary, so Content-Type is only
  // forced when the body is not FormData.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isFormData && !('Content-Type' in requestHeaders)) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  if (!skipAuth) {
    const access = await tokenStore.getAccess();
    if (access) requestHeaders.Authorization = `Bearer ${access}`;
  }

  // AbortController is the only way to bound a fetch on RN — there is no
  // built-in timeout, and a hung request otherwise leaves a spinner forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    // Annotated rather than inferred: react-native's global fetch types resolve
    // to `unknown` under this tsconfig, which pushed every `response.status`
    // below into an error cascade for no real reason.
    response = (await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      body:
        body === undefined
          ? undefined
          : isFormData
            ? (body as FormData)
            : JSON.stringify(body),
      signal: controller.signal,
    })) as Response;
  } catch (err) {
    if (signal?.aborted) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError({
      status: 0,
      body: null,
      message: aborted ? `Request timed out after ${timeoutMs}ms` : 'Network request failed',
      isNetwork: !aborted,
      isTimeout: aborted,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  // 204: no body to parse. The old client fell through to response.text() and
  // returned '' as if it were data. `null` rather than `undefined` so callers
  // can write `data?.status` without a typeof guard on every 204-returning
  // endpoint (DELETE, PATCH-with-no-content).
  if (response.status === 204) return null as T;

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const parsed: unknown = response.ok
    ? isJson
      ? await response.json()
      : await response.text()
    : isJson
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

  if (response.ok) return parsed as T;

  if (response.status === 401 && !skipAuth && retryOn401) {
    const newAccess = await refreshAccessToken();
    if (newAccess) {
      // Replay ONCE. An infinite replay loop is how a dead session turns into a
      // request storm.
      return rawFetch<T>(path, { ...options, retryOn401: false });
    }
    throw new ApiError({ status: 401, body: parsed });
  }

  // 429 carries Retry-After; the caller decides the backoff, but the value is
  // preserved on the error so it does not have to be re-derived.
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new ApiError({
      status: 429,
      body: parsed,
      message: retryAfter ? `Rate limited; retry after ${retryAfter}s` : 'Rate limited',
    });
  }

  throw new ApiError({ status: response.status, body: parsed });
}

/* ------------------------------------------------------------------ */
/* Token store binding                                                  */
/* ------------------------------------------------------------------ */

/**
 * Injected by src/api/tokenStore.ts (the SecureStore implementation) so this
 * module has no hard dependency on a native module and stays testable.
 */
let tokenStore: TokenStore = {
  async getAccess() {
    return null;
  },
  async getRefresh() {
    return null;
  },
  async set() {},
  async clear() {},
};

export function setTokenStore(store: TokenStore): void {
  tokenStore = store;
}

export function getTokenStore(): TokenStore {
  return tokenStore;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return rawFetch<T>(path, options);
}

/** Exposed for tests: the mutex must settle even after a failed refresh. */
export function __resetRefreshMutexForTests(): void {
  refreshPromise = null;
}
