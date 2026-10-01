/**
 * Tests for the HLS token Worker.
 *
 * Two things are tested here, and only one of them is new.
 *
 * 1. TRANSPORT EXTRACTION (pre-existing) — the security-relevant property is
 *    PRECEDENCE, not just extraction: a page's own script on app.echoflow.in
 *    can set an arbitrary request header but cannot read the HttpOnly cookie,
 *    so the cookie has to win. If it ever stops winning, any script on the web
 *    origin can choose which credential the edge validates — which turns "the
 *    user is authenticated by a token scoped to this clip" into "the page
 *    chooses".
 *
 * 2. VALIDATION (`validatePlaybackToken`) — the whole security boundary of
 *    every paid byte of media. Mirrors
 *    `backend/app/tests/test_hls_token.py::TestValidatePlaybackToken`; parity
 *    with the Python issuer/validator is the point, so the mint helper below
 *    re-implements `hls_token.py:143-163` rather than hard-coding fixtures.
 *
 * These are pure unit tests — no storage, no env, no fetch handler. `index.ts`
 * and the storage backends' `get()` are NOT covered (see README "Tests").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_TOKEN_HEADER,
  extractTokenFromCookie,
  extractTokenFromRequest,
  validatePlaybackToken,
} from "./token";

// ---------------------------------------------------------------------------
// Minting helpers — the issuer side, re-implemented from
// backend/app/services/hls_token.py:92-163.
//
// Deliberately NOT hard-coded token strings: a fixture can only prove that one
// blob validates. Re-deriving the token means these tests also pin the wire
// format (sorted JSON keys, HMAC over the base64 *string* and not the raw
// bytes, unpadded base64url) — if token.ts or hls_token.py ever drifts on any
// of those, every case below fails at once.
// ---------------------------------------------------------------------------

/** A fixed key. The Worker only checks presence, never strength. */
const SECRET = "0f8c1d2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";

/** Frozen wall clock. Only `Date` is faked, so WebCrypto is untouched. */
const FROZEN_NOW_S = 1_700_000_000;
const FROZEN_NOW_MS = FROZEN_NOW_S * 1000;

/** RFC 4648 §5 base64url, no padding — `_b64url_encode` in hls_token.py. */
function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeText(text: string): string {
  return b64urlEncode(new TextEncoder().encode(text));
}

/**
 * `json.dumps(payload, separators=(",", ":"), sort_keys=True)`.
 *
 * JSON.stringify's array form of the replacer both filters and ORDERS keys by
 * the array, so listing the payload's own keys sorted gives byte-identical
 * output to Python. Payloads are flat, so the filter does no damage.
 */
function pyJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

async function signPayloadB64(payloadB64: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64) // payload_b64.encode("ascii")
  );
  return b64urlEncode(new Uint8Array(sig));
}

/** Mint a token exactly the way `generate_playback_token` does. */
async function mint(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const payloadB64 = b64urlEncodeText(pyJson(payload));
  return `${payloadB64}.${await signPayloadB64(payloadB64, secret)}`;
}

/** A well-formed, unexpired, correctly-scoped payload for a single clip. */
function goodPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { u: 1, c: "hls/abc-123", exp: FROZEN_NOW_S + 600, iat: FROZEN_NOW_S, v: 1, ...over };
}

const CLIP_PATH = "/hls/abc-123/master.m3u8";

// ---------------------------------------------------------------------------
// Transport extraction (pre-existing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// validatePlaybackToken
//
// Mirrors backend/app/tests/test_hls_token.py::TestValidatePlaybackToken.
// Time is frozen so the expiry and boundary cases are exact rather than
// "probably still within the same second" — a 1-second window test is a
// flake waiting for a loaded CI box.
// ---------------------------------------------------------------------------

describe("validatePlaybackToken", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("accepts", () => {
    it("returns the full payload for a matching path", async () => {
      const payload = goodPayload();
      const token = await mint(payload);

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toEqual({
        u: 1,
        c: "hls/abc-123",
        exp: FROZEN_NOW_S + 600,
        iat: FROZEN_NOW_S,
        v: 1,
      });
    });

    it("accepts every path under the clip prefix, at any depth", async () => {
      // One cookie, every subrequest: the master playlist, variant playlists
      // and segments all arrive as separate requests and all have to pass.
      const token = await mint(goodPayload());
      for (const path of [
        "/hls/abc-123/master.m3u8",
        "/hls/abc-123/segment_1.ts",
        "/hls/abc-123/sub/variant.m3u8",
        "/hls/abc-123/a/b/c/d/segment_900.m4s",
      ]) {
        await expect(
          validatePlaybackToken(token, path, SECRET)
        ).resolves.not.toBeNull();
      }
    });

    it("accepts a path that is EXACTLY the scope prefix", async () => {
      // The boundary of `startsWith("/" + c + "/")`. The trailing slash is
      // part of the prefix, so this passes while "/hls/abc-123" (no trailing
      // slash) does not — see "rejects" below.
      const token = await mint(goodPayload());
      await expect(
        validatePlaybackToken(token, "/hls/abc-123/", SECRET)
      ).resolves.not.toBeNull();
    });

    it("ignores the user id entirely", async () => {
      // `u` is 0 for anonymous share recipients and a real id otherwise; the
      // edge is documented as never reading it (hls_token.py:115-120), so the
      // authorisation decision is HMAC + version + exp + clip scope only.
      const token = await mint(goodPayload({ u: 0 }));
      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.not.toBeNull();
    });
  });

  describe("rejects a bad signature", () => {
    it("rejects a payload edited under an untouched signature", async () => {
      // The classic forgery: bump the user id, keep the signature. The HMAC is
      // over the base64 STRING, so any edit invalidates it.
      const [payloadB64, sigB64] = (await mint(goodPayload())).split(".");
      const forged = { ...goodPayload(), u: 999 };
      const forgedB64 = b64urlEncodeText(pyJson(forged));

      await expect(
        validatePlaybackToken(`${forgedB64}.${sigB64}`, CLIP_PATH, SECRET)
      ).resolves.toBeNull();
      // Sanity: the untouched original still passes, so the rejection above is
      // the edit and not a broken fixture.
      expect(payloadB64).not.toBe(forgedB64);
      await expect(
        validatePlaybackToken(`${payloadB64}.${sigB64}`, CLIP_PATH, SECRET)
      ).resolves.not.toBeNull();
    });

    it("rejects a signature from a different payload", async () => {
      // A decodable, correctly-sized, wrong signature — this is the real
      // mismatch branch (token.ts:120), not the b64urlDecode catch at :64.
      const sigOfOtherPayload = (await mint(goodPayload({ u: 2 }))).split(".")[1];
      const token = await mint(goodPayload());

      await expect(
        validatePlaybackToken(`${token.split(".")[0]}.${sigOfOtherPayload}`, CLIP_PATH, SECRET)
      ).resolves.toBeNull();
    });

    it("rejects a signature minted with a different secret", async () => {
      const otherSecret = "9".repeat(64);
      const sigB64 = (await mint(goodPayload(), otherSecret)).split(".")[1];
      const token = await mint(goodPayload());

      await expect(
        validatePlaybackToken(`${token.split(".")[0]}.${sigB64}`, CLIP_PATH, SECRET)
      ).resolves.toBeNull();
    });

    it("rejects an undecodable signature without throwing", async () => {
      const token = await mint(goodPayload());
      await expect(
        validatePlaybackToken(`${token.split(".")[0]}.!!!!`, CLIP_PATH, SECRET)
      ).resolves.toBeNull();
    });
  });

  describe("rejects expiry", () => {
    it("rejects a token that expired one second ago", async () => {
      const token = await mint(goodPayload({ exp: FROZEN_NOW_S - 1 }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("accepts a token whose exp is exactly now", async () => {
      // The comparison is `nowSeconds > exp` — STRICTLY greater — so the second
      // in which the token expires is still served. This mirrors Python's
      // `int(time.time()) > payload["exp"]` (hls_token.py:217) exactly, and
      // both therefore grant one second more than the TTL. Documented, not
      // accidental: an off-by-one *inward* (rejecting at == exp) would break
      // playback for a second on every segment at the end of a long stream.
      const token = await mint(goodPayload({ exp: FROZEN_NOW_S }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.not.toBeNull();
    });
  });

  describe("rejects clip-scope mismatch", () => {
    it("rejects a path for a different clip", async () => {
      const token = await mint(goodPayload());

      await expect(
        validatePlaybackToken(token, "/hls/xyz-789/master.m3u8", SECRET)
      ).resolves.toBeNull();
    });

    it("rejects a clip key that is a PREFIX of the requested clip", async () => {
      // The off-by-one class, called out explicitly: `c = "hls/abc"` must not
      // unlock `/hls/abcdef/`. It does not, because the prefix carries a
      // trailing slash — but a "strip the slash" or "endsWith" refactor would
      // silently turn a scoped token into a wildcard over every clip whose id
      // starts with the same characters.
      const token = await mint(goodPayload({ c: "hls/abc" }));

      await expect(
        validatePlaybackToken(token, "/hls/abcdef/master.m3u8", SECRET)
      ).resolves.toBeNull();
      // ...and the reverse direction: a longer token must not unlock a shorter
      // path either.
      await expect(
        validatePlaybackToken(token, "/hls/ab/master.m3u8", SECRET)
      ).resolves.toBeNull();
      // The exact clip still works, so the two rejections above are the scope
      // check and not a broken fixture.
      await expect(
        validatePlaybackToken(token, "/hls/abc/master.m3u8", SECRET)
      ).resolves.not.toBeNull();
    });

    it("rejects a sibling key sharing a long common prefix", async () => {
      // UUID-shaped ids make the partial case easy to hit by accident.
      const token = await mint(
        goodPayload({ c: "hls/9f8e7d6c-5b4a-3210-fedc-ba9876543210" })
      );

      await expect(
        validatePlaybackToken(
          token,
          "/hls/9f8e7d6c-5b4a-3210-fedc-ba9876543211/master.m3u8",
          SECRET
        )
      ).resolves.toBeNull();
    });

    it("requires the prefix at the START of the path, not anywhere in it", async () => {
      // `startsWith`, not `includes`. Otherwise a path traversal that embeds
      // the scoped prefix later in the string would pass.
      const token = await mint(goodPayload());

      await expect(
        validatePlaybackToken(token, "/x/hls/abc-123/master.m3u8", SECRET)
      ).resolves.toBeNull();
    });

    it("rejects the clip path with the trailing slash missing", async () => {
      // The slash is a path separator, not decoration: "/hls/abc-123" is the
      // clip itself, not something inside it. Matches
      // TestValidatePlaybackToken::test_no_clipping_path_slash_accepted.
      const token = await mint(goodPayload());

      await expect(
        validatePlaybackToken(token, "/hls/abc-123", SECRET)
      ).resolves.toBeNull();
    });

    it("rejects paths with no clip segment at all", async () => {
      const token = await mint(goodPayload());

      for (const path of ["", "/", "/hls", "/hls/", "/master.m3u8", "/hls/master.m3u8"]) {
        await expect(
          validatePlaybackToken(token, path, SECRET)
        ).resolves.toBeNull();
      }
    });

    it("rejects a token whose c is an empty string", async () => {
      const token = await mint(goodPayload({ c: "" }));

      await expect(
        validatePlaybackToken(token, CLIP_PATH, SECRET)
      ).resolves.toBeNull();
    });
  });

  describe("rejects malformed tokens", () => {
    it("rejects an empty string", async () => {
      await expect(validatePlaybackToken("", CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects a string with no '.' separator", async () => {
      await expect(validatePlaybackToken("not-a-token", CLIP_PATH, SECRET)).resolves.toBeNull();
      // Reachable in practice: `extractTokenFromCookie` returns whatever sits
      // after 'ef_hls_token=' with no shape check at all.
      await expect(validatePlaybackToken("a", CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects 3 or more dot-separated parts", async () => {
      for (const token of ["a.b.c", "a.b.c.d", `${CLIP_PATH}.x.y`]) {
        await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
      }
    });

    it("rejects a VALID token with anything appended after the signature", async () => {
      // The arity check is only load-bearing if the first two parts are
      // themselves a valid token. Junk-only inputs like "a.b.c" are rejected by
      // the HMAC stage anyway, so they pass even if `parts.length !== 2` is
      // broken — these three are the ones that actually pin it. A `> 2` /
      // `>= 2` slip here would silently make the signature the last segment and
      // everything before it attacker-supplied padding.
      const token = await mint(goodPayload());

      for (const candidate of [`${token}.extra`, `${token}.`, `.${token}`, `${token}.a.b`]) {
        await expect(
          validatePlaybackToken(candidate, CLIP_PATH, SECRET)
        ).resolves.toBeNull();
      }
    });

    it("rejects a correctly-signed payload that is not base64", async () => {
      // Signed first, decoded second — so this exercises the b64urlDecode
      // catch in token.ts:128 rather than dying at the HMAC stage.
      const payloadB64 = "!!!";
      const token = `${payloadB64}.${await signPayloadB64(payloadB64)}`;

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects a correctly-signed payload that is not JSON", async () => {
      const payloadB64 = b64urlEncodeText("this is not json");
      const token = `${payloadB64}.${await signPayloadB64(payloadB64)}`;

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects correctly-signed JSON that is not an object", async () => {
      for (const raw of ["123", '"a string"', "[1,2,3]", "true"]) {
        const payloadB64 = b64urlEncodeText(raw);
        const token = `${payloadB64}.${await signPayloadB64(payloadB64)}`;
        // `v` is undefined, so the version check rejects it.
        await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
      }
    });
  });

  describe("rejects the wrong version", () => {
    it("rejects v: 2", async () => {
      const token = await mint(goodPayload({ v: 2 }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects a missing version", async () => {
      const payload = goodPayload();
      delete payload.v;
      const token = await mint(payload);

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("rejects v: 0", async () => {
      // `!==` rather than `>=`: a downgrade must not be accepted either.
      const token = await mint(goodPayload({ v: 0 }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // KNOWN DIVERGENCES FROM PYTHON.
  //
  // Everything in this block asserts the WORKER's CURRENT behaviour, and every
  // assertion is a behaviour nobody designed deliberately. They are here so
  // the divergences are visible in the test suite rather than discovered in
  // production, and so that fixing the source turns them red on purpose.
  // Do not read any of these expectations as a specification.
  // -------------------------------------------------------------------------
  describe("KNOWN DIVERGENCES from backend/app/services/hls_token.py", () => {
    it("rejects a version sent as the STRING \"1\" (Python accepts it)", async () => {
      // token.ts:133 uses `payload.v !== TOKEN_VERSION` (strict, so "1" !== 1).
      // hls_token.py:213 uses `payload.get("v") != TOKEN_VERSION` (Python's
      // `!=` is value equality across types, so "1" == 1 → ACCEPTED).
      //
      // The Worker is the stricter of the two, and stricter is the right
      // direction for an authorization check, so this is a latent asymmetry
      // rather than a live hole: nothing in the repo emits a string version,
      // because json.dumps of an int emits a number. It is pinned because the
      // two implementations claim to match "exactly", and they do not.
      const token = await mint(goodPayload({ v: "1" }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("ACCEPTS a string exp (Python raises TypeError)", async () => {
      // `nowSeconds > "1700000600"` coerces the string to a number, so a string
      // exp that is in the future passes. Python's
      // `int(time.time()) > payload["exp"]` raises TypeError instead, and
      // `validate_playback_token` does NOT wrap it (unlike `verify_token`,
      // which guards with try/except at hls_token.py:293-297) — so Django 500s
      // on the same token. Requires a valid signature, so it is not
      // attacker-reachable; it is a fail-open shape waiting for an issuer bug.
      const token = await mint(goodPayload({ exp: String(FROZEN_NOW_S + 600) }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.not.toBeNull();
    });

    it("ACCEPTS a token with NO exp at all (Python raises KeyError)", async () => {
      // `nowSeconds > undefined` is NaN, and every NaN comparison is false, so
      // the expiry check is skipped entirely: a validly-signed token with no
      // `exp` never expires. Python raises KeyError on the same payload.
      // Again signature-gated, so not attacker-reachable — but this is the one
      // to fix first, because "no expiry field" silently means "eternal", and
      // the type signature (`TokenPayload`) is a cast, not a runtime check.
      const payload = goodPayload();
      delete payload.exp;
      const token = await mint(payload);

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.not.toBeNull();
    });

    it("rejects a null exp", async () => {
      // The one malformed-exp case that IS caught: `null` coerces to 0, and
      // 1970 is in the past. Asserted so the asymmetry above is visible —
      // null is rejected while undefined and "1700000600" are not.
      const token = await mint(goodPayload({ exp: null }));

      await expect(validatePlaybackToken(token, CLIP_PATH, SECRET)).resolves.toBeNull();
    });

    it("THROWS on a correctly-signed payload of literal null", async () => {
      // `JSON.parse("null")` is `null`, and `payload.v` on null is a TypeError
      // that escapes `validatePlaybackToken` — the cast to TokenPayload at
      // token.ts:127 is not a runtime check. In index.ts this is an unhandled
      // rejection inside the fetch handler (a Worker error, not a 403).
      // Signature-gated, so not attacker-reachable, and the Python issuer
      // cannot produce it (json.dumps always emits an object). Kept because
      // "the validator throws" is the sort of thing that surfaces as a 500 the
      // first time the payload shape changes.
      const payloadB64 = b64urlEncodeText("null");
      const token = `${payloadB64}.${await signPayloadB64(payloadB64)}`;

      await expect(
        validatePlaybackToken(token, CLIP_PATH, SECRET)
      ).rejects.toThrow(TypeError);
    });
  });
});
