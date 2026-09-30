// EchoFlow HLS Token Worker — fetch handler
//
// Validates the ef_hls_token cookie — or, for native players, the
// X-EchoFlow-Media-Token header carrying the same value — on every /hls/*
// request, then fetches from storage. Handles CORS and OPTIONS preflight
// internally since R2's bucket CORS policy is bypassed when using a Worker
// binding (the binding is a server-side call, not an HTTP request from the
// browser).
//
// Request flow:
//   Browser  → Cookie: ef_hls_token ─┐
//   Native   → X-EchoFlow-Media-Token ┴→ Worker (media.echoflow.in)
//     → validatePlaybackToken() [token.ts]
//       → getStorage(env).get() [storage.ts — R2 binding in prod,
//                                 S3/MinIO over SigV4 under `wrangler dev`]
//         → stream response back to client with CORS headers

import { validatePlaybackToken, extractTokenFromRequest } from "./token";
import { getStorage, assertTokenSecret, StorageUnavailable, type Env } from "./storage";

export type { Env };

// ---------------------------------------------------------------------------
// Allowed origins — add localhost variants for local dev
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "https://app.echoflow.in",
  "https://echoflow.in",
  "https://www.echoflow.in",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // Local docker-compose stack: the nginx :9443 / :19443 media listener.
  "https://localhost:9443",
  "https://localhost:19443",
  "https://app.localhost:18443",
  "https://app.localhost:19443",
]);

// ---------------------------------------------------------------------------
// CORS headers
//
// Access-Control-Allow-Credentials MUST be "true" and origin MUST be a
// specific value (not "*") because hls.js sends the cookie as a credential.
// Access-Control-Allow-Headers MUST include "Range" — HLS seeking uses
// byte-range requests; without it, seeking and ABR switching silently break.
// ---------------------------------------------------------------------------

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Match, If-None-Match",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type",
    "Access-Control-Max-Age": "3600",
  };
}

function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && ALLOWED_ORIGINS.has(origin);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = isAllowedOrigin(origin);

    // --- Health ---
    // Reported before the method and path checks so it answers to a plain GET
    // from a container healthcheck. It names the active storage backend and
    // reports whether the token secret is configured, but never emits a
    // credential. A 503 here is the fast way to catch a missing/stale
    // .dev.vars before staring at a wall of 403s.
    if (url.pathname === "/healthz") {
      try {
        const storage = getStorage(env);
        return Response.json({ status: "ok", backend: storage.name });
      } catch (err) {
        return Response.json(
          {
            status: "misconfigured",
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 503 }
        );
      }
    }

    // Fail loudly on a missing token secret. Without this the HMAC would be
    // computed over an EMPTY key and every request would 403, looking
    // identical to a Django-side token bug.
    try {
      assertTokenSecret(env);
    } catch (err) {
      return errorResponse(
        503,
        err instanceof Error ? err.message : String(err),
        origin,
        allowed
      );
    }

    // --- OPTIONS preflight ---
    // Must be handled explicitly — R2 CORS config is bypassed for Worker bindings.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: allowed && origin ? corsHeaders(origin) : {},
      });
    }

    // --- Only serve GET and HEAD ---
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // --- Only serve /hls/* paths ---
    // All other paths (healthcheck, root, etc.) get a 404.
    if (!url.pathname.startsWith("/hls/")) {
      return new Response("Not found", { status: 404 });
    }

    // --- Extract and validate token ---
    //
    // Cookie for the web (HttpOnly, set by the API origin, attached by the
    // browser automatically); `X-EchoFlow-Media-Token` header for native
    // players, which have no cookie jar to share with the HTTP client. Both
    // carry the same HMAC string, so everything below is identical either
    // way — only the envelope differs.
    //
    // Precedence and the reasoning behind it live with the helper:
    // extractTokenFromRequest() in token.ts.
    const token = extractTokenFromRequest(request);

    if (!token) {
      return errorResponse(403, "Missing playback token", origin, allowed);
    }

    // url.pathname is the request path passed to scope check:
    //   "/hls/<clip_id>/master.m3u8" must start with "/hls/<clip_id>/"
    const payload = await validatePlaybackToken(
      token,
      url.pathname,
      env.MEDIA_TOKEN_SECRET
    );

    if (!payload) {
      return errorResponse(403, "Invalid or expired playback token", origin, allowed);
    }

    // --- Fetch the object from storage ---
    // The object key is the pathname without the leading "/":
    //   pathname "/hls/abc-123/master.m3u8" → key "hls/abc-123/master.m3u8"
    const objectKey = url.pathname.slice(1);

    let object;
    try {
      object = await getStorage(env).get(objectKey, request);
    } catch (err) {
      // Auth already passed at this point. A storage fault must never be
      // reported as 403, or a broken backend looks like a rejected token.
      if (err instanceof StorageUnavailable) {
        return errorResponse(502, err.message, origin, allowed);
      }
      throw err;
    }

    if (object === null) {
      return errorResponse(404, "Not found", origin, allowed);
    }

    // --- Build response headers ---
    const responseHeaders = new Headers(object.headers);

    if (object.etag) {
      responseHeaders.set("ETag", object.etag);
    }

    // Cache HLS segments aggressively (they are immutable once uploaded).
    // Master and variant playlists are short-lived because they may update.
    const isSegment =
      objectKey.endsWith(".ts") ||
      objectKey.endsWith(".m4s") ||
      objectKey.endsWith(".aac");
    responseHeaders.set(
      "Cache-Control",
      isSegment ? "public, max-age=31536000, immutable" : "public, max-age=5"
    );

    // Add CORS headers to actual response
    if (allowed && origin) {
      for (const [k, v] of Object.entries(corsHeaders(origin))) {
        responseHeaders.set(k, v);
      }
    }

    // 304 means the client's cached copy is still valid — pass it through
    // with no body, but keep the ETag so the browser can revalidate.
    if (object.status === 304) {
      return new Response(null, { status: 304, headers: responseHeaders });
    }

    return new Response(object.body, {
      status: object.status,
      headers: responseHeaders,
    });
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(
  status: number,
  message: string,
  origin: string | null,
  allowed: boolean
): Response {
  const headers = new Headers({ "Content-Type": "text/plain" });
  if (allowed && origin) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      headers.set(k, v);
    }
  }
  return new Response(message, { status, headers });
}

// ---------------------------------------------------------------------------
// Env interface — declared in storage.ts (which owns the storage vars) and
// re-exported above, so storage.ts need not import from this module.
// ---------------------------------------------------------------------------