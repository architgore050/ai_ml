/**
 * A route-based `fetch` mock.
 *
 * `apiRequest` in `src/api/client.ts` layers these behaviours on top of
 * `fetch`, and the tests assert against all of them: the `Authorization`
 * header, single-flight 401 refresh + replay, `202` passthrough, the
 * `Retry-After` read, the offline/timeout error classification, and the
 * request deadline. Mocking at the `fetch` boundary (rather than mocking
 * `apiRequest` or the API modules) keeps those behaviours under test.
 *
 * Usage:
 *   const api = installFetchMock();
 *   api.on("POST", /\/auth\/login\//, () => json(200, { detail: "ok" }));
 *   api.fail("GET", /\/feed\//, new TypeError("NetworkError"));
 *
 * Two things to know before adding a route:
 *
 * - **The FIRST matching route wins** (`routes.find`, below), not the most
 *   specific one. Register the narrow route before the broad one, and give
 *   `installFetchMock()` a fresh instance per test so a previous test's routes
 *   cannot match by accident.
 * - **The signal is ignored.** `init.signal` is recorded but never observed, so
 *   a handler that would hang stays hung after an abort. That is deliberate:
 *   it reproduces the transport that ignores `AbortSignal`, which is why
 *   `apiRequest` cannot rely on the abort alone. Use `hang: true` to model a
 *   half-open connection.
 */

import { vi } from "vitest";

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a transport failure. */
  networkError?: Error;
  /**
   * Never settle. Models a half-open connection: the request is in flight and
   * no byte ever comes back, so only a deadline can end it.
   */
  hang?: boolean;
}

export type RouteHandler = (request: {
  url: string;
  method: string;
  body: any;
  headers: Headers;
}) => MockResponseSpec | Promise<MockResponseSpec>;

interface Route {
  method: string;
  matcher: RegExp | string;
  handler: RouteHandler;
}

export interface FetchMock {
  on(method: string, matcher: RegExp | string, handler: RouteHandler): FetchMock;
  /** Register a route that rejects — the network-throw path. */
  fail(method: string, matcher: RegExp | string, error: Error): FetchMock;
  /** Register a route that never settles — the half-open-connection path. */
  hang(method: string, matcher: RegExp | string): FetchMock;
  calls: FetchCall[];
  /** Calls whose URL matches, for focused assertions. */
  callsTo(matcher: RegExp | string): FetchCall[];
  reset(): void;
  mock: ReturnType<typeof vi.fn>;
}

/**
 * A recorded request.
 *
 * `credentials` is included because it is load-bearing for exactly one caller:
 * `mediaAPI.getPlaybackToken` needs `credentials: "include"` for the HLS cookie
 * handshake, and nothing else in the app does. Without it in the record, that
 * contract is asserted by reading the source rather than by running it.
 */
export interface FetchCall {
  url: string;
  method: string;
  body: any;
  credentials: string;
  /** The `Authorization` header as sent, for asserting refresh rotation. */
  authorization: string | null;
  signal: AbortSignal | null | undefined;
}

function toMatcher(matcher: RegExp | string): RegExp {
  return typeof matcher === "string" ? new RegExp(escapeRegExp(matcher)) : matcher;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches(route: Route, method: string, url: string): boolean {
  if (route.method !== "*" && route.method.toUpperCase() !== method.toUpperCase()) return false;
  const m = toMatcher(route.matcher);
  m.lastIndex = 0;
  return m.test(url);
}

async function parseBody(init: RequestInit | undefined): Promise<any> {
  if (!init || typeof init.body !== "string") return init?.body ?? null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

function buildResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  const hasBody = spec.body !== undefined && status !== 204;
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const payload = hasBody
    ? typeof spec.body === "string"
      ? spec.body
      : JSON.stringify(spec.body)
    : null;
  return new Response(payload, { status, headers });
}

export function installFetchMock(): FetchMock {
  const routes: Route[] = [];
  const calls: FetchCall[] = [];

  const mock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = await parseBody(init);
    const requestHeaders = new Headers(init?.headers ?? {});
    calls.push({
      url,
      method,
      body,
      credentials: init?.credentials ?? "same-origin",
      authorization: requestHeaders.get("Authorization"),
      signal: init?.signal,
    });

    const route = routes.find((r) => matches(r, method, url));
    if (!route) {
      return buildResponse({
        status: 404,
        body: { detail: `No fetch mock registered for ${method} ${url}` },
      });
    }

    const spec = await route.handler({
      url,
      method,
      body,
      headers: requestHeaders,
    });

    if (spec.hang) {
      // Never settles. Deliberately ignores `init.signal`, so this is also the
      // transport that does not honour an abort — see the note at the top.
      return new Promise<Response>(() => {});
    }
    if (spec.networkError) throw spec.networkError;
    return buildResponse(spec);
  });

  globalThis.fetch = mock as unknown as typeof fetch;

  return {
    on(method, matcher, handler) {
      routes.push({ method, matcher, handler });
      return this;
    },
    fail(method, matcher, error) {
      routes.push({
        method,
        matcher,
        handler: () => ({ networkError: error }),
      });
      return this;
    },
    hang(method, matcher) {
      routes.push({ method, matcher, handler: () => ({ hang: true }) });
      return this;
    },
    calls,
    callsTo(matcher) {
      const m = toMatcher(matcher);
      m.lastIndex = 0;
      return calls.filter((c) => m.test(c.url));
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
      mock.mockClear();
    },
    mock,
  };
}

/** Convenience: a JSON response spec. */
export function json(status: number, body: unknown, headers?: Record<string, string>): MockResponseSpec {
  return { status, body, headers };
}

/** Convenience: a 204 no-content response. */
export function noContent(): MockResponseSpec {
  return { status: 204, body: undefined };
}

/**
 * A 429 carrying `Retry-After`, in the delta-seconds form DRF's throttles
 * actually send (`SimpleRateThrottle.wait` → `Retry-After: <n>`).
 *
 * `apiRequest` reads this header and puts it on the thrown error as
 * `retryAfterSeconds`; pass the value you want to assert against and read it
 * back off the error, so the test pins the header the server sent rather than
 * a constant invented here.
 *
 * For a 429 with NO `Retry-After` (a proxy, or a throttle response that lost
 * the header) use `json(429, { detail: "..." })` — that is a different case and
 * must not be modelled by passing a made-up number.
 */
export function tooManyRequests(retryAfterSeconds: number): MockResponseSpec {
  return {
    status: 429,
    body: { detail: "Request was throttled." },
    headers: { "retry-after": String(retryAfterSeconds) },
  };
}
