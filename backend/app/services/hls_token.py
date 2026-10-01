"""HLS playback token service.

Generates short-lived, per-clip, user-bound HMAC tokens for HLS playback
access. The token is a signed cookie that browsers send automatically on
all HLS subrequests (master.m3u8, variant playlists, segments) — unlike
query-string signatures, cookies are not stripped by RFC 3986
relative-reference resolution (§5.2.2), which is why they are the only
viable token mechanism for multi-file HLS streams.

Token format:
    base64url(payload_json) . base64url(hmac_sha256(secret, payload_b64))

Payload (JSON, sorted keys for deterministic encoding):
    { "c": "hls/<clip_id>", "exp": int, "iat": int, "u": int, "v": 1 }

The validation counterparts live in:
  - workers/hls-token-worker/src/token.ts  (production Cloudflare Worker)
  - docker/nginx/hls_auth.js               (dev nginx + njs)

Both MUST match this file's algorithm exactly.

DECISION: Using HMAC-SHA256 with a symmetric key rather than JWT because:
  1. The Worker uses WebCrypto API (no JWT library dependency)
  2. Smaller token size than JWT (no base64 JSON header)
  3. Symmetric key is sufficient — issuer and validator share one secret
"""
import base64
import hashlib
import hmac
import json
import time

from django.conf import settings

# The placeholder vocabulary and the guard that uses it live in
# `EchoFlow/secrets.py`, which now also guards DJANGO_SECRET_KEY and both
# Redis passwords at settings-import time. They used to live here, and this
# file was their only consumer — which is why the two far more damaging
# secrets had no guard at all.
#
# `is_placeholder_secret` is re-exported (not merely imported) because
# `backend/app/tests/test_hls_token.py` imports it from this module path.
# Behaviour is unchanged: same predicate, same vocabulary, same fail-closed
# direction. The docstring there carries the trade-off — the substring list
# includes "example" and "todo", so a real secret containing those words is
# rejected on purpose.
from backend.EchoFlow.secrets import (
    _PLACEHOLDER_SECRETS,  # noqa: F401  kept importable from this module
    _PLACEHOLDER_SUBSTRINGS,  # noqa: F401  kept importable from this module
    is_placeholder_secret,  # noqa: F401  re-exported for existing callers
)

COOKIE_NAME = "ef_hls_token"
TOKEN_VERSION = 1


def _get_secret() -> bytes:
    """Return the HMAC secret as bytes.

    SECURITY: Uses a dedicated env var (MEDIA_TOKEN_SECRET), not
    DJANGO_SECRET_KEY. The Worker and nginx must share this secret;
    they do NOT have access to Django's settings module.

    DECISION: reject documentation placeholders, not just the empty string.
    Every env example in this repo ships
    `MEDIA_TOKEN_SECRET=change-me-to-a-long-random-string`. The previous
    guard raised only when the value was empty, so a copied example
    deployed unchanged produced a publicly-known HMAC key — anyone could
    mint a valid `{"c": "hls/<any_clip>", ...}` token for any clip. A
    placeholder secret is a total compromise, so it is treated exactly like
    a missing one.
    """
    secret = getattr(settings, "MEDIA_TOKEN_SECRET", "")
    if not secret:
        raise RuntimeError(
            "MEDIA_TOKEN_SECRET is not set — HLS token protection is "
            "unavailable. Set it in .env."
        )
    if is_placeholder_secret(secret):
        raise RuntimeError(
            "MEDIA_TOKEN_SECRET is still a documentation placeholder — HLS "
            "token protection is unavailable. Generate a real key with "
            "`python -c \"import secrets; print(secrets.token_urlsafe(32))\"` "
            "and set the same value on the validating edge "
            "(`npx wrangler secret put MEDIA_TOKEN_SECRET`). A placeholder key "
            "is public knowledge and lets anyone mint playback tokens for any "
            "clip."
        )
    return secret.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    """Base64url encode without padding (RFC 4648 §5)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    """Base64url decode, adding padding back if stripped."""
    padding = 4 - (len(data) % 4)
    if padding < 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


def _ttl_seconds() -> int:
    """Return configured token TTL in seconds."""
    return int(getattr(settings, "MEDIA_TOKEN_TTL_SECONDS", 600))


def generate_playback_token(
    user_id: int, clip_key: str, ttl: int | None = None
) -> str:
    """Generate an HMAC playback token for a clip's HLS output.

    Args:
        user_id: The Django user's ID, or 0 for a token issued to an
            anonymous share recipient. The Worker and nginx never read this
            field (they check HMAC, ``v``, ``exp`` and the ``c`` prefix
            only), so 0 is a safe sentinel — see the share pipeline.
        clip_key: The object storage key prefix for this clip's HLS output.
            Example: "hls/abc-123-def-456".
        ttl: Override for the token lifetime, in seconds. ``None`` uses
            ``MEDIA_TOKEN_TTL_SECONDS`` (600s), which is correct for a user
            who is watching *now*.

            A4 (2026-09-29): the share pipeline needs a much longer lifetime
            — a link shared on Monday must still open on Saturday. Adding a
            per-call override is what lets that happen without touching the
            payload format, and therefore without touching the Cloudflare
            Worker or the nginx njs validator. The schema is unchanged
            (``{"c", "exp", "iat", "u", "v"}``), so the three implementations
            that must agree still agree.

            SECURITY: the two lifetimes are deliberately different objects —
            a short one for a stream in progress, a long one for a capability
            that is handed to someone else. Do not "simplify" by making both
            long; see docs/EXPLAIN/storage/04-hls-token-protection.md on why
            ``exp`` is the only automatic revocation mechanism.

    Returns:
        Token string: ``base64url(payload).base64url(signature)``
    """
    now = int(time.time())
    effective_ttl = _ttl_seconds() if ttl is None else int(ttl)
    payload = {
        "u": user_id,
        "c": clip_key,
        "exp": now + effective_ttl,
        "iat": now,
        "v": TOKEN_VERSION,
    }
    # sort_keys=True ensures deterministic encoding across Python/TypeScript
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = _b64url_encode(payload_json.encode("utf-8"))

    signature = hmac.new(
        _get_secret(),
        payload_b64.encode("ascii"),
        hashlib.sha256,
    ).digest()
    sig_b64 = _b64url_encode(signature)

    return f"{payload_b64}.{sig_b64}"


def validate_playback_token(token: str, request_path: str) -> dict | None:
    """Validate a playback token.

    Args:
        token: The token string (``payload_b64.signature_b64``).
        request_path: The full request path (e.g.
            ``/hls/abc-123/master.m3u8``). The token's ``c`` field defines
            an allowed prefix — the request path must start with
            ``/<clip_key>/``.

    Returns:
        The decoded payload dict if valid, ``None`` if the token is
        missing, malformed, expired, scope-mismatched, or has a bad
        signature.
    """
    if not token or "." not in token:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None

    payload_b64, sig_b64 = parts

    # --- HMAC verification (timing-safe) ---
    try:
        received_sig = _b64url_decode(sig_b64)
    except Exception:
        return None

    expected_sig = hmac.new(
        _get_secret(),
        payload_b64.encode("ascii"),
        hashlib.sha256,
    ).digest()

    if not hmac.compare_digest(expected_sig, received_sig):
        return None

    # --- Payload decoding ---
    try:
        payload_json = _b64url_decode(payload_b64)
        payload = json.loads(payload_json)
    except Exception:
        return None

    # --- Version check ---
    if payload.get("v") != TOKEN_VERSION:
        return None

    # --- Expiry check ---
    if int(time.time()) > payload["exp"]:
        return None

    # --- Clip-scope check ---
    # The token's 'c' field is like "hls/abc-123".
    # The request path is like "/hls/abc-123/master.m3u8".
    # The request path must start with "/<clip_key>/".
    expected_prefix = "/" + payload["c"] + "/"
    if not request_path.startswith(expected_prefix):
        return None

    return payload


def verify_token(token: str) -> dict | None:
    """Verify signature, version and expiry, and return the payload.

    This is :func:`validate_playback_token` minus the path-prefix check, and
    it exists for callers that need to *inspect* a token rather than authorise
    a request for it.

    A4 (2026-09-29): the share pipeline needs this. ``POST
    /public/clips/{id}/play/`` receives a share token as a query parameter
    and must confirm two things before minting a short-lived media token for
    an anonymous caller:

    1. the token is genuinely one we signed, and has not expired; and
    2. it was issued *for this clip* — i.e. ``payload["c"]`` is the
       ``hls/<clip_id>`` key of the clip in the URL.

    Without (2), any valid token would unlock any clip: a recipient could
    take the ``?s=`` value from the link they were sent and rewrite the clip
    id in the path. That is the whole "is this actually a reel which was
    shared to the user" check, and it is a string comparison, not new crypto.

    SECURITY: the caller must compare the returned ``c`` against the clip it
    intends to serve. This function does not do it, because it has no idea
    what "the clip" means.
    """
    if not token or "." not in token:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None

    payload_b64, sig_b64 = parts

    try:
        received_sig = _b64url_decode(sig_b64)
    except Exception:
        return None

    expected_sig = hmac.new(
        _get_secret(),
        payload_b64.encode("ascii"),
        hashlib.sha256,
    ).digest()

    if not hmac.compare_digest(expected_sig, received_sig):
        return None

    try:
        payload_json = _b64url_decode(payload_b64)
        payload = json.loads(payload_json)
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    if payload.get("v") != TOKEN_VERSION:
        return None

    # KeyError/TypeError guarded: a token signed by us but malformed would
    # otherwise raise out of an authorization path and turn into a 500.
    try:
        if int(time.time()) > int(payload["exp"]):
            return None
    except (KeyError, TypeError, ValueError):
        return None

    if not isinstance(payload.get("c"), str) or not payload["c"]:
        return None

    return payload


def extract_token_from_cookie(cookie_header: str) -> str | None:
    """Extract the ef_hls_token value from a Cookie header string.

    Args:
        cookie_header: The raw ``Cookie`` header value (e.g.
            "ef_hls_token=abc.def; session=ghi").

    Returns:
        The token string if found, ``None`` otherwise.
    """
    if not cookie_header:
        return None

    for pair in cookie_header.split(";"):
        pair = pair.strip()
        if pair.startswith(COOKIE_NAME + "="):
            return pair[len(COOKIE_NAME) + 1:]
    return None
