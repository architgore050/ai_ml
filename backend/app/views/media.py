"""Media playback token issuance endpoint.

Serves short-lived HMAC tokens for HLS playback, validated by the Cloudflare
Worker edge (``workers/hls-token-worker/``), which fronts the bucket both in
production and -- via the nginx :9443 listener -- in the local stack.

TWO TRANSPORTS, ONE TOKEN.

``Set-Cookie`` (the default, and what the web client uses). The cookie is
HttpOnly, Secure, SameSite=Lax, and expires with the token. A browser sends
it automatically on all /hls/* requests to the media endpoint, and no script
can read it.

``X-EchoFlow-Media-Token`` request header (opt-in, via
``X-EchoFlow-Client: native``). Native players cannot consume a browser
cookie — AVPlayer does not read ``NSHTTPCookieStorage`` and ExoPlayer's
default data source sends no ``Cookie`` header at all — so an RN client has
no way to obtain the token value from an HttpOnly cookie. It receives the
same token in the response body and attaches it as a request header on
every edge request instead. The edge accepts either. See
``_token_response_body()`` for the full reasoning.

The token itself is identical in both cases: same HMAC, same
``MEDIA_TOKEN_TTL_SECONDS`` TTL, same per-clip scope, same signature and
expiry checks at the edge. Only the carrier differs.

DECISION: Token issuance is a separate API call from the clip fetch rather
than embedded in the clip serializer, because:
  1. Issuing early would widen the replay window — a token handed out during
     a feed fetch is valid for clips the user may never open.
  2. Only one client at a time can usefully be playing a given clip, so
     there is nothing to gain from pre-issuing.
"""
import logging

from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from ..models import AudioClip
from ..services.entitlements import resolve_clip_access
from ..services.hls_token import generate_playback_token, COOKIE_NAME

logger = logging.getLogger(__name__)


def _extract_clip_key(hls_playlist_url):
    """Derive the clip key prefix from the stored hls_playlist_url.

    AudioClip.hls_playlist_url stores a relative key like
    ``"hls/abc-123/master.m3u8"``. The token's ``c`` field must be the
    directory prefix without the filename, so we strip the trailing
    ``master.m3u8``.

    Returns None for a null/blank value -- the field is ``null=True``, so a
    clip whose HLS processing has not run has None here and ``rsplit`` would
    raise AttributeError, turning a 404 into a 500.
    """
    if not hls_playlist_url:
        return None
    return hls_playlist_url.rsplit("/", 1)[0]


# SECURITY: the header a native client sends to opt in to receiving the token
# value in the response body. See _token_response_body() for why this is
# opt-in and why the default is unchanged.
NATIVE_CLIENT_HEADER = "X-EchoFlow-Client"
NATIVE_CLIENT_VALUE = "native"


def _token_response_body(request, token):
    """Build the JSON body, including the raw token only for native clients.

    THE PROBLEM: the cookie contract is unsatisfiable off-browser.

    ``Set-Cookie`` is honoured by a *browser* cookie jar. The two native
    players this product uses — AVPlayer on iOS and ExoPlayer/Media3 on
    Android — are not a browser and have no shared cookie store with the
    HTTP client that made this request:

      - iOS: ``NSHTTPCookieStorage`` is consulted by ``NSURLSession``, not by
        ``AVPlayer``. An ``AVPlayerItem`` carries its own header set and
        does not inherit the app's cookies.
      - Android: ExoPlayer's default ``DefaultHttpDataSource`` sends no
        ``Cookie`` header at all. Supplying one requires building a
        ``ResolvingDataSource`` with an explicit ``DefaultHttpDataSource``,
        which React Native's audio module does not expose.

    A React Native app also cannot simply read the cookie back out and
    re-attach it: it is ``HttpOnly``, and ``Secure=True`` means it is dropped
    outright over the plaintext-HTTP development stack. So a native client
    has no way to obtain the token *value* at all, and therefore no way to
    present it.

    THE FIX: the same HMAC token, delivered one more way. The native client
    sends ``X-EchoFlow-Client: native`` and receives ``{"token": "..."}``; it
    then attaches it as the ``X-EchoFlow-Media-Token`` request header on
    every request it makes to the edge, via the player's per-source headers.
    The validating edge accepts the header alongside the cookie. Same
    cryptography, same TTL, same per-clip scope, same path check — only the
    transport differs.

    WHY THIS IS OPT-IN, NOT UNCONDITIONAL: the default body stays
    ``{"status": "ok"}`` for every request that does not send the header.
    The token remains a bearer credential, and echoing a bearer credential
    into a body that a browser-side bug (a logging interceptor, an error
    reporter capturing response bodies, an XHR wrapper logging JSON) could
    capture is a real, if small, widening of exposure. `HttpOnly` is
    specifically the property that stops script from reading it, so
    overriding that default should require the caller to say it is a native
    stack, not arrive as a side effect of adding a field.

    A caller that forges the header from a browser gains nothing: the token
    is already scoped to the single clip the user was served, and the edge
    validates scope, expiry and signature exactly as it does for a cookie.
    This is a transport change, not a privilege change.
    """
    body = {"status": "ok"}
    if request.headers.get(NATIVE_CLIENT_HEADER) == NATIVE_CLIENT_VALUE:
        body["token"] = token
    return body


class PlaybackTokenView(APIView):
    """Issue a short-lived HLS playback token for a specific clip.

    Endpoint: ``POST /media/playback-token/<uuid:clip_id>/``

    DECISION: ``POST``, not ``GET``, as of 2026-09-29. Minting a playback
    credential is a state-changing act and must not be a safe method:

    * A ``GET`` is CSRF-able. Combined with ``SameSite=Lax`` on the
      ``ef_hls_token`` cookie, a cross-site ``<img>`` or redirect could
      trigger issuance in a logged-in browser without user intent.
    * A ``GET`` is prefetchable. Browsers and some proxies prefetch
      hyperlinks and crawl targets, which would mint tokens nobody asked for
      and burn rate-limit budget.
    * A ``GET`` is cacheable by intermediaries, and the response sets a
      credential cookie. A shared cache must never replay that.

    This is a breaking API change. The only caller,
    ``sample_frontend2/src/api/client.ts``, was updated in the same commit.

    Requires authentication, and the caller must be entitled to the clip —
    see :func:`backend.app.services.entitlements.resolve_clip_access`, which
    is the single source of truth for that decision.

    .. note::
       This docstring previously claimed "Share-link authorization is handled
       separately in ShareViewSet; this endpoint gates on feed visibility".
       Neither was true — ``ShareViewSet`` had no share-link handling and the
       feed queryset was never consulted. Worse, the endpoint authorized on
       ``moderation_approved`` alone while ``FastFeedViewSet`` also filters
       ``is_noncommercial`` and ``requires_share_alike``, so any logged-in
       user could mint a token for an NC/SA clip the feed never served. That
       was a licensing bypass and is now closed.

    Response: ``{"status": "ok"}``, plus ``{"token": "..."}`` when the caller
    sent ``X-EchoFlow-Client: native``. The token is *always* also set as an
    HttpOnly ``ef_hls_token`` cookie, so a native client is not forced to
    give up the cookie path and the web client is not changed at all.
    """

    permission_classes = [IsAuthenticated]
    # A3 (2026-09-29). This was previously absent, and ScopedRateThrottle
    # treats a missing scope as "allow everything" — so the view inherited
    # the shared `user` (1000/hour) bucket via UserRateThrottle. A user
    # scrolling a feed mints ~1 token per clip and shares that budget with
    # every other authenticated endpoint. The rate lives in
    # DEFAULT_THROTTLE_RATES as 'playback_token'.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'playback_token'

    def get(self, request, clip_id):
        """Reject GET explicitly rather than 405-ing with no explanation.

        A bare 405 leaves the caller guessing whether it should retry with
        POST or whether the clip is unavailable. Old clients in the wild
        still issue GET, so the reason matters during rollout.
        """
        return Response(
            {
                "detail": (
                    "Use POST to request a playback token. GET is not "
                    "accepted because issuing a credential must not be a "
                    "safe, prefetchable or cacheable method."
                ),
            },
            status=405,
        )

    def post(self, request, clip_id):
        try:
            clip = AudioClip.objects.get(pk=clip_id)
        except AudioClip.DoesNotExist:
            return Response(
                {"detail": "Clip not found."},
                status=404,
            )

        # SECURITY: Block token issuance for unmoderated / prohibited content.
        # Even if a clip key exists in storage, moderation_approved=False
        # means the content was flagged or not yet reviewed.
        if not clip.moderation_approved:
            return Response(
                {"detail": "Content not available."},
                status=403,
            )

        # SECURITY: Block token issuance for clips the user shouldn't see.
        #
        # 2026-09-29: this check now exists. It previously did not, which was
        # a licensing bypass — FastFeedViewSet filters
        # is_noncommercial=False and requires_share_alike=False and this
        # endpoint applied neither, so any logged-in user could mint a token
        # for an NC/SA clip the feed never serves. resolve_clip_access() is
        # the single source of truth; see its docstring for why it
        # deliberately does not require proof the clip was served.
        allowed, reason = resolve_clip_access(request.user, clip)
        if not allowed:
            logger.warning(
                "playback token denied: user=%s clip=%s reason=%s",
                request.user.pk, clip.pk, reason,
            )
            return Response(
                {"detail": "Clip not available."},
                status=403,
            )

        clip_key = _extract_clip_key(clip.hls_playlist_url)
        if clip_key is None:
            # HLS output has not been produced (or was cleaned up). There is
            # nothing to authorize, so this is a conflict with the clip's
            # current state rather than a missing resource.
            return Response(
                {"detail": "Clip media is not ready."},
                status=409,
            )

        token = generate_playback_token(
            user_id=request.user.id,
            clip_key=clip_key,
        )

        ttl = settings.MEDIA_TOKEN_TTL_SECONDS
        response = Response(_token_response_body(request, token))
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            # Tracks MEDIA_TOKEN_TTL_SECONDS. This was hardcoded to 600 while
            # the comment claimed it followed the setting, so raising the TTL
            # produced a cookie the browser would drop at 600s and playback
            # would break mid-stream. Validation uses the token's own `exp`,
            # so a mismatch here fails closed rather than open.
            max_age=ttl,
            httponly=True,
            secure=True,
            # Lax, not Strict: hls.js loads the master playlist on a top-level
            # navigation, and Strict would withhold the cookie on that request.
            samesite="Lax",
            path="/hls/",
            # SECURITY: omitted entirely unless MEDIA_TOKEN_COOKIE_DOMAIN is
            # explicitly set, which keeps the cookie host-only by default.
            #
            # That default is correct ONLY when the media origin is the same
            # host that serves the API. In production it is not: the cookie is
            # set by api.echoflow.in and the media origin is
            # media.echoflow.in, so a host-only cookie is NEVER sent there and
            # every playback request 403s. Set MEDIA_TOKEN_COOKIE_DOMAIN to the
            # shared parent (".echoflow.in") when PUBLIC_HLS_ENDPOINT_URL points
            # at a different host. In dev both are `localhost` (cookies are
            # host-scoped and ignore ports), so it must stay empty.
            domain=settings.MEDIA_TOKEN_COOKIE_DOMAIN or None,
        )
        return response
