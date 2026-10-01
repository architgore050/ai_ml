// EchoFlow HLS Token Worker — Token Validation Logic
//
// Validates tokens using the EXACT same algorithm as
// backend/app/services/hls_token.py (Django).
//
// Token format: base64url(payload_json).base64url(hmac_sha256(secret, payload_b64))
//
// Payload (JSON, sorted keys — matches json.dumps(sort_keys=True)):
//   { "c": string, "exp": number, "iat": number, "u": number, "v": 1 }
//   c   = clip key prefix (e.g. "hls/abc-123")
//   exp = expiry epoch (seconds)
//   iat = issued-at epoch (seconds)
//   u   = user_id
//   v   = token version (always 1)
//
// NOTE: Key order in the JSON must match Python's sort_keys=True output:
//   c, exp, iat, u, v  (alphabetical)
// The HMAC is computed over the base64url-encoded payload string,
// NOT over the raw JSON — matches Django's payload_b64.encode("ascii").

const TOKEN_VERSION = 1;
const COOKIE_NAME = "ef_hls_token";

// ---------------------------------------------------------------------------
// Base64url helpers (RFC 4648 §5, no padding — matches Python's rstrip("="))
// ---------------------------------------------------------------------------

function b64urlDecode(input: string): Uint8Array {
  // Add padding back (Python strips it with rstrip(b"="))
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  // Replace URL-safe chars with standard base64 chars
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 verification using WebCrypto
// Matches: hmac.new(secret, payload_b64.encode("ascii"), hashlib.sha256).digest()
// ---------------------------------------------------------------------------

async function verifyHmac(
  secret: string,
  payloadB64: string,
  receivedSigB64: string
): Promise<boolean> {
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),         // secret.encode("utf-8") in Python
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  let receivedSig: Uint8Array;
  try {
    receivedSig = b64urlDecode(receivedSigB64);
  } catch {
    return false;
  }

  // WebCrypto verify is timing-safe — matches hmac.compare_digest()
  return crypto.subtle.verify(
    "HMAC",
    key,
    receivedSig,
    enc.encode(payloadB64)      // payload_b64.encode("ascii") in Python
  );
}

// ---------------------------------------------------------------------------
// Token payload type
// ---------------------------------------------------------------------------

interface TokenPayload {
  c: string;    // clip key prefix
  exp: number;  // expiry epoch (seconds)
  iat: number;  // issued-at epoch (seconds)
  u: number;    // user_id
  v: number;    // token version
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a playback token.
 *
 * Matches Django's validate_playback_token() exactly:
 *   1. Split on "." — must have exactly 2 parts
 *   2. HMAC-SHA256 verify (timing-safe)
 *   3. Decode payload
 *   4. Version check (v === 1)
 *   5. Expiry check (now > exp → invalid)
 *   6. Clip-scope check (requestPath must start with "/<c>/")
 *
 * Returns the decoded payload if valid, null otherwise.
 */
export async function validatePlaybackToken(
  token: string,
  requestPath: string,
  secret: string
): Promise<TokenPayload | null> {
  if (!token || !token.includes(".")) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;

  // --- HMAC verification (timing-safe via WebCrypto) ---
  const valid = await verifyHmac(secret, payloadB64, sigB64);
  if (!valid) return null;

  // --- Payload decoding ---
  let payload: TokenPayload;
  try {
    const payloadBytes = b64urlDecode(payloadB64);
    const payloadJson = new TextDecoder().decode(payloadBytes);
    payload = JSON.parse(payloadJson) as TokenPayload;
  } catch {
    return null;
  }

  // --- Version check ---
  if (payload.v !== TOKEN_VERSION) return null;

  // --- Expiry check ---
  // matches: if int(time.time()) > payload["exp"]: return None
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > payload.exp) return null;

  // --- Clip-scope check ---
  // matches: expected_prefix = "/" + payload["c"] + "/"
  //          if not request_path.startswith(expected_prefix): return None
  const expectedPrefix = "/" + payload.c + "/";
  if (!requestPath.startsWith(expectedPrefix)) return null;

  return payload;
}

/**
 * Extract ef_hls_token value from a Cookie header string.
 * Matches Django's extract_token_from_cookie() exactly.
 */
export function extractTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(COOKIE_NAME + "=")) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

/**
 * Header a native player uses to present the token, because a native HTTP
 * stack has no browser cookie jar.
 *
 * Must stay in sync with `NATIVE_CLIENT_HEADER` / the header the API tells
 * the client to send — see backend/app/views/media.py::_token_response_body.
 */
export const MEDIA_TOKEN_HEADER = "X-EchoFlow-Media-Token";

/**
 * Extract the playback token from a request, whichever transport carried it.
 *
 * TWO TRANSPORTS, ONE CREDENTIAL.
 *
 * 1. Cookie — the web path. `ef_hls_token` is HttpOnly and set by the API
 *    origin, so a browser attaches it to every /hls/* request automatically
 *    and no script can read it.
 *
 * 2. `X-EchoFlow-Media-Token` — the native path. AVPlayer (iOS) does not read
 *    `NSHTTPCookieStorage`, and ExoPlayer's `DefaultHttpDataSource` (Android)
 *    sends no `Cookie` header at all, so a React Native client cannot get a
 *    cookie attached to a media request even if it wanted to. It receives the
 *    same token from `GET /media/playback-token/<id>/` in the JSON body and
 *    replays it here as a per-source header.
 *
 * PRECEDENCE IS COOKIE-FIRST, deliberately. A web page's own script cannot
 * read the HttpOnly cookie, but it *can* set an arbitrary request header, so
 * making the header authoritative would let any script on `app.echoflow.in`
 * override which credential the edge validates. Falling through to the header
 * only when there is no cookie keeps the web path byte-identical to its
 * previous behaviour and adds native as strictly the otherwise-unauthenticated
 * case.
 *
 * Security is unchanged either way: both carriers deliver the same HMAC
 * string, and `validatePlaybackToken` still enforces signature, version,
 * `exp` and per-clip path scope.
 */
export function extractTokenFromRequest(request: Request): string | null {
  const fromCookie = extractTokenFromCookie(request.headers.get("Cookie"));
  if (fromCookie) return fromCookie;
  return request.headers.get(MEDIA_TOKEN_HEADER);
}
