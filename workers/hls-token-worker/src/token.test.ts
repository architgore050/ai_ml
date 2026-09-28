/**
 * Tests for token transport extraction.
 *
 * The security-relevant property here is PRECEDENCE, not just extraction:
 * a page's own script on app.echoflow.in can set an arbitrary request header
 * but cannot read the HttpOnly cookie, so the cookie has to win. If it ever
 * stops winning, any script on the web origin can choose which credential
 * the edge validates — which turns "the user is authenticated by a token
 * scoped to this clip" into "the page chooses".
 *
 * These are pure unit tests — no storage, no env, no fetch handler.
 */
import { describe, expect, it } from "vitest";
import {
  MEDIA_TOKEN_HEADER,
  extractTokenFromCookie,
  extractTokenFromRequest,
} from "./token";

const GOOD = "eyJjIjoiaGxzL2FiYyJ9.c2ln";

function req(headers: Record<string, string>): Request {
  return new Request("https://media.echoflow.in/hls/abc/master.m3u8", { headers });
}

describe("extractTokenFromCookie", () => {
  it("finds the token among other cookies", () => {
    expect(extractTokenFromCookie(`a=1; ef_hls_token=${GOOD}; b=2`)).toBe(GOOD);
  });

  it("returns null when absent", () => {
    expect(extractTokenFromCookie("session=x")).toBeNull();
    expect(extractTokenFromCookie(null)).toBeNull();
  });
});

describe("extractTokenFromRequest", () => {
  it("reads the cookie on the web path", () => {
    expect(extractTokenFromRequest(req({ Cookie: `ef_hls_token=${GOOD}` }))).toBe(GOOD);
  });

  it("reads the header on the native path", () => {
    expect(
      extractTokenFromRequest(req({ [MEDIA_TOKEN_HEADER]: GOOD }))
    ).toBe(GOOD);
  });

  it("returns null when neither transport carries a token", () => {
    expect(extractTokenFromRequest(req({}))).toBeNull();
  });

  // The one that matters.
  it("prefers the cookie over the header when both are present", () => {
    const cookie = `${GOOD}`;
    const header = "eyJjIjoiaGxzL2V2aWwifQ.b3RoZXJzaWc";
    const token = extractTokenFromRequest(
      req({ Cookie: `ef_hls_token=${cookie}`, [MEDIA_TOKEN_HEADER]: header })
    );
    expect(token).toBe(cookie);
  });

  it("falls back to the header when the cookie is present but unrelated", () => {
    // A browser sends every cookie it has for the host, so 'Cookie' being
    // present does not mean our cookie is. The fallback has to key on the
    // extracted value, not on the header's presence.
    const token = extractTokenFromRequest(
      req({
        Cookie: "session=abc; other=def",
        [MEDIA_TOKEN_HEADER]: GOOD,
      })
    );
    expect(token).toBe(GOOD);
  });

  it("is unaffected by header name casing from the transport", () => {
    // HTTP header names are case-insensitive and Cloudflare normalises them;
    // Request/Headers.get already handles this, but the pairing is worth
    // pinning because a typo in MEDIA_TOKEN_HEADER would 403 every request.
    expect(MEDIA_TOKEN_HEADER).toBe("X-EchoFlow-Media-Token");
    expect(
      extractTokenFromRequest(req({ "x-echoflow-media-token": GOOD }))
    ).toBe(GOOD);
  });
});
