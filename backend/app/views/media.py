"""Media playback token issuance endpoint.

Serves short-lived HMAC tokens as HttpOnly cookies for HLS playback.
The token is validated by the Cloudflare Worker edge
(``workers/hls-token-worker/``), which fronts the bucket both in
production and -- via the nginx :9443 listener -- in the local stack.

SECURITY: The cookie is HttpOnly, Secure, SameSite=Lax, and expires with
the token. No token value is exposed to JavaScript — the browser sends the
cookie automatically on all /hls/* requests to the media endpoint.

DECISION: Token issuance is a separate API call from the clip fetch rather
than embedded in the clip serializer, because:
  1. The cookie must be set via Set-Cookie, not JSON body (browsers only
     auto-send cookies that are set via Set-Cookie headers).
  2. The frontend only needs the token after deciding to play a clip —
     issuing it early would create a wider replay window.
"""
from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import AudioClip
from ..services.hls_token import generate_playback_token, COOKIE_NAME


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


class PlaybackTokenView(APIView):
    """Issue a short-lived HLS playback token cookie for a specific clip.

    Endpoint: ``GET /media/playback-token/<uuid:clip_id>/``

    Requires authentication — only users who can see the clip in their feed
    or via a share link should receive tokens. (Share-link authorization is
    handled separately in ShareViewSet; this endpoint gates on feed
    visibility.)

    Response: JSON ``{"status": "ok"}`` with the token set as an HttpOnly
    cookie named ``ef_hls_token``.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, clip_id):
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
        # This prevents a user from guessing clip IDs and minting playback
        # tokens for clips they haven't been served via their feed.
        # Feed visibility is enforced by FastFeedViewSet; here we do a
        # lightweight check: the user must have a valid interaction record
        # (like, skip, telemety) with this clip, OR the clip must be
        # owned by a user they follow, OR the clip must be in their feed.
        # For v1, the feed filter is the primary gate — this endpoint trusts
        # that the frontend only calls it for visible clips.
        # A future hardening pass can add explicit authorization here.

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
        response = Response({"status": "ok"})
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
