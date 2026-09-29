/**
 * A route-based `fetch` mock.
 *
 * `apiRequest` in `src/api/client.ts` layers four behaviours on top of `fetch`
 * that the tests actually need to assert against: the `Authorization` header,
 * single-flight 401 refresh + replay, `202` passthrough, and `Retry-After`
 * extraction. Mocking at the `fetch` boundary (rather than mocking
 * `apiRequest` or the API modules) keeps those behaviours under test.
 *
 * Usage:
 *   const api = installFetchMock();
 *   api.on("POST", /\/auth\/login\//, () => json(200, { detail: "ok" }));
 *   api.fail("GET", /\/feed\//, new TypeError("NetworkError"));
 */

import { vi } from "vitest";

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a transport failure. */
  networkError?: Error;
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
  calls: { url: string; method: string; body: any }[];
  /** Calls whose URL matches, for focused assertions. */
  callsTo(matcher: RegExp | string): { url: string; method: string; body: any }[];
  reset(): void;
  mock: ReturnType<typeof vi.fn>;
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
  const calls: { url: string; method: string; body: any }[] = [];

  const mock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = await parseBody(init);
    calls.push({ url, method, body });

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
      headers: new Headers(init?.headers ?? {}),
    });

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

/** Convenience: a 429 carrying `Retry-After` (seconds, as the server sends it). */
export function tooManyRequests(retryAfterSeconds: number): MockResponseSpec {
  return {
    status: 429,
    body: { detail: "Request was throttled." },
    headers: { "retry-after": String(retryAfterSeconds) },
  };
}
