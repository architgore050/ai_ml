"""Content/ingestion view: audio upload.

Stage 2 (relational-to-event-driven plan): the transaction.on_commit
dispatch into Celery is owned by services.uploads.finalize_upload.
"""
import logging

from django.conf import settings
from django.http import HttpResponse
from django.utils.html import escape
from rest_framework import viewsets, permissions, parsers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from ..media_urls import get_hls_playback_url
from ..models import AudioClip, Report, TakedownRequest
from ..serializers import AudioUploadSerializer, FeedClipSerializer, PublicClipSerializer
from ..services import content_moderation as moderation_svc
from ..services import uploads as uploads_svc
from ..services.hls_token import COOKIE_NAME, generate_playback_token, verify_token

logger = logging.getLogger(__name__)


def _wants_json(request) -> bool:
    """True when the caller is an API client rather than a browser/unfurl.

    Deliberately conservative: HTML is served only when the client did not
    ask for JSON. An unfurl sends no ``Accept: application/json``, so it gets
    the card; a mobile app or fetch() sends one and gets JSON.
    """
    accept = (request.META.get("HTTP_ACCEPT") or "").lower()
    if "application/json" in accept:
        return True
    # A browser navigation to the URL directly.
    if "text/html" in accept or "application/xhtml+xml" in accept:
        return False
    # No Accept at all (curl default) — treat as a machine.
    return not accept


def _render_share_card(data: dict, request) -> str:
    """Minimal Open Graph page for a shared clip.

    A4 (2026-09-29). Not a web app — just enough for a chat client to render
    a legible card. Every interpolated value goes through ``escape``: the
    title is user-supplied free text and this is an unauthenticated page, so
    an unescaped title would be stored XSS against whoever opens the link.
    """
    title = escape(str(data.get("title") or "EchoFlow clip"))
    creator = escape(str(data.get("creator_name") or ""))
    description = escape(
        f"{data.get('category') or 'audio'} clip by {creator}".strip()
    )
    # A relative cover path is useless to a remote unfurler, so only emit the
    # tag when we have an absolute URL.
    image = data.get("cover_image")
    image_tag = (
        f'<meta property="og:image" content="{escape(str(image))}">' if image else ""
    )
    url = request.build_absolute_uri(request.path)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:type" content="music.song">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{escape(url)}">
{image_tag}
<meta name="robots" content="noindex">
</head><body>
<h1>{title}</h1>
<p>{description}</p>
</body></html>"""


class AudioUploadViewSet(viewsets.ModelViewSet):
    # SECURITY: 20 uploads/hour/user prevents storage-abuse DoS. Each upload
    # is up to 100 MB (AudioUploadSerializer.MAX_SIZE), so default DRF
    # 1000/hour/user would let one account push 100 GB/hour.
    #
    # A4 (2026-09-29): this scope used to apply to *every* action on the
    # viewset, which was wrong for all of them. A shared clip's landing page
    # was capped at 20 views/hour (a link opened in a chat client, or a link
    # preview, 429s), and the play exchange was throttled as though it were an
    # upload. Per-action scopes now dispatch below, matching the pattern in
    # ClipInteractionViewSet and ShareViewSet.
    throttle_scope = 'upload'
    queryset = AudioClip.objects.all()
    serializer_class = AudioUploadSerializer
    permission_classes = [permissions.IsAuthenticated]
    # B4 (2026-09-29): JSONParser added because the viewset is
    # multipart-only for uploads, which meant `/clips/{id}/report/` answered
    # **415 Unsupported Media Type** to every JSON client — the endpoint was
    # effectively callable only with form data.
    #
    # Not scoped to the actions that need it, because per-action parsers
    # cannot be selected here: `APIView.initialize_request` calls
    # `get_parsers()`, and `ViewSetMixin.initialize_request` only sets
    # `self.action` *after* delegating to it, so `self.action` is always None
    # during parser selection. Reaching for it would silently no-op.
    #
    # Safe to add viewset-wide: a JSON body cannot carry a real file, so
    # `original_file` fails in the serializer ("The submitted data was not a
    # file data") and a bad upload gets a 400 that names the missing file —
    # clearer than the 415 it replaces. Size, MIME and magic-byte validation
    # are unaffected because they only run once a real file is present.
    parser_classes = [
        parsers.MultiPartParser,
        parsers.FormParser,
        parsers.JSONParser,
    ]

    def get_queryset(self):
        # For moderation endpoints, operators may need broader access.
        # We keep user-scoped by default but allow override for actions.
        return AudioClip.objects.filter(creator=self.request.user)

    @property
    def throttle_scope(self):
        """Route each action to a rate that matches what it actually does.

        Before A4 every action inherited ``upload`` (20/hour), which is the
        right number for pushing 100 MB files and the wrong number for
        everything else. A shared link's landing page returning 429 after 20
        views is a broken share feature, and it fails in exactly the way that
        is hardest to notice: the link works for you, then stops working.
        """
        return {
            'public': 'clip_public',
            'play': 'clip_play',
            'share-link': 'share_link',
            'report': 'clip_report',
            'approve-moderation': 'clip_approve',
        }.get(self.action, 'upload')

    def get_throttles(self):
        # Actions with their own scope need ScopedRateThrottle; `create` and
        # the plain CRUD actions use the viewset's inherited classes.
        from rest_framework.throttling import ScopedRateThrottle

        if self.action in ('public', 'play', 'share-link', 'report', 'approve-moderation'):
            return [ScopedRateThrottle()]
        return super().get_throttles()

    def create(self, request, *args, **kwargs):
        # Pro gating: check daily upload limit for free users BEFORE
        # serializer validation to fail fast (no wasted work on files
        # that would be rejected).
        if not request.user.is_pro():
            from django.conf import settings as django_settings
            from django.utils import timezone
            from rest_framework.exceptions import PermissionDenied
            daily_limit = getattr(django_settings, "REVENUECAT_DAILY_UPLOAD_LIMIT_FREE", 5)
            today = timezone.now().date()
            created_today = AudioClip.objects.filter(
                creator=request.user, created_at__date=today
            ).count()
            if created_today >= daily_limit:
                raise PermissionDenied(
                    f"Free tier limit of {daily_limit} daily uploads reached. "
                    "Upgrade to Pro for unlimited uploads."
                )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        clip = serializer.save()

        uploads_svc.finalize_upload(clip)

        headers = self.get_success_headers(serializer.data)
        return Response(
            {
                "message": "Audio uploading and processing in background.",
                "clip_id": clip.id,
                "status": clip.status
            },
            status=status.HTTP_202_ACCEPTED,
            headers=headers,
        )

    def update(self, request, *args, **kwargs):
        # N8 fix: PATCH/PUT on a clip must NOT replace original_file.
        # The previous approach (read_only_fields at serializer level)
        # broke the legitimate upload flow because read_only_fields
        # applies to BOTH create and update. Instead: at update time,
        # strip the file from the request data BEFORE the serializer
        # runs. A user who wants to replace their file must delete
        # the clip and re-upload via POST.
        if 'original_file' in request.data:
            # request.data is a QueryDict (immutable). Make a mutable copy
            # and replace the request's internal _full_data so the
            # serializer sees the file-stripped version.
            data = request.data.copy()
            data.pop('original_file')
            request._full_data = data
        return super().update(request, *args, **kwargs)

    @action(detail=True, methods=['post'], url_path='approve-moderation', permission_classes=[permissions.IsAuthenticated])
    def approve_moderation(self, request, pk=None):
        """Operator-facing endpoint to approve moderation for a clip.

        ISSUE-04: Manual moderation approval for v1. After passing,
        HLS processing is triggered.

        SEC-FIX (2026-09-29, Group C): the lookup was
        ``get_object_or_404(AudioClip, pk=pk)`` — unscoped, which silently
        bypassed ``get_queryset()`` (creator-scoped). So **any** authenticated
        user could approve **any** clip, on someone else's upload. That is a
        moderation bypass (it is the step that sets moderation_approved and
        triggers HLS encoding) and a compute-abuse vector, and the old
        docstring admitted it: "For v1, any authenticated user can approve
        (simplified)."

        Now owner-or-staff. Owner is permitted because the mobile upload flow
        self-approves its own clip — that is the current v1 workflow, and
        denying it would leave uploads permanently stuck in `processing` until
        a human looked at them.

        HONEST LIMITATION: with the owner allowed, moderation is not a gate.
        A user can upload, self-approve, and be published after only the
        keyword checks in services/content_moderation.py run. That is the
        accepted v1 state, and this change narrows the abuse surface (from
        anyone to the uploader) without pretending to more. Making it a real
        gate needs either a human review queue or a classifier — the content
        decision tracked as ISSUE-04, not a scoping fix.
        """
        if request.user.is_staff:
            clip = get_object_or_404(AudioClip, pk=pk)
        else:
            # 404 rather than 403 for someone else's clip: a 403 would
            # confirm the clip exists, and UUIDs are the only identifier here.
            clip = get_object_or_404(
                AudioClip.objects.filter(creator=request.user), pk=pk
            )
        approved, reason = moderation_svc.run_moderation_check(clip.id)
        # Reload clip from DB so moderation_approved reflects the update.
        clip.refresh_from_db()
        if approved:
            # Enqueue HLS processing after approval.
            uploads_svc.trigger_hls_processing(clip)
            return Response({
                "status": "approved",
                "message": "Moderation approved. HLS processing started.",
                "clip_id": clip.id,
                "moderation_approved": clip.moderation_approved,
            }, status=status.HTTP_200_OK)
        else:
            return Response({
                "status": "rejected",
                "message": "Moderation check failed.",
                "reason": reason,
                "clip_id": clip.id,
                "moderation_approved": False,
            }, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='report', permission_classes=[permissions.IsAuthenticated])
    def report_clip(self, request, pk=None):
        """User-facing endpoint to report a clip.

        B4 (2026-09-29): this previously created a Report with no link to the
        clip and no reason, so the report was unactionable — an operator queue
        could not tell what was reported or triage it. IT Rules 2021 R3(1)(b)
        requires categorised complaint handling.

        The clip FK and the IT Rules-aligned reason enum are now populated and
        validated, and duplicate reports from the same user are collapsed
        (matching the partial unique constraint on the model).
        """
        clip = get_object_or_404(AudioClip, pk=pk)

        reason = request.data.get('report_reason', '')
        valid_reasons = {code for code, _label in Report.REPORT_REASONS}
        if reason not in valid_reasons:
            return Response(
                {
                    "report_reason": [
                        f"Invalid report reason. Allowed: {sorted(valid_reasons)}"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        content = (request.data.get('content') or '').strip()
        if not content:
            # The body is the only free-text a moderator has, so an empty one
            # is useless. Requiring it also forces the "other" bucket to
            # carry an explanation.
            return Response(
                {"content": ["Please describe the problem."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        title = request.data.get('title') or f"Report: {reason.replace('_', ' ')}"

        # SECURITY: a user must not be able to file a report that is
        # attributed to somebody else. `user` comes from the token, never the
        # body. Reported here as well as enforced at the model, because
        # get_or_create is what makes the duplicate collapse safe.
        report, created = Report.objects.get_or_create(
            user=request.user,
            clip=clip,
            defaults={
                'title': title[:200],
                'content': content,
                'report_reason': reason,
                'status': 'open',
            },
        )
        if not created:
            # Append the new detail to the existing report rather than
            # silently discarding it — the user did tell us something.
            existing = (report.content or '')
            separator = '\n\n' if existing else ''
            report.content = (existing + separator + content)[:4000]
            report.save(update_fields=['content'])

        return Response({
            "status": "reported",
            "message": "Your report has been recorded.",
            "clip_id": clip.id,
            "report_id": report.id,
            "duplicate": not created,
        }, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='public', permission_classes=[permissions.AllowAny])
    def public_view(self, request, pk=None):
        """Shared-clip metadata. Grants no playback credential.

        A4 (2026-09-29). This is the landing surface for a shared link, and it
        is content-negotiated:

        * ``Accept: application/json`` (or a fetch/XHR) -> reduced JSON
          metadata, for the app.
        * anything else (a browser, a chat client unfurling the link) -> a
          small HTML page carrying Open Graph tags.

        The HTML branch is the reason this works today. There is no deployed
        web frontend — nginx is ``server_name _`` proxying only to Django, and
        ``frontend/`` holds samples — so a shared link has no page to land on
        and the only thing that renders a bare URL is a link unfurl. OG tags
        are what make the share legible in WhatsApp/Slack/X without building
        a site first.

        SECURITY: the queryset filter keeps unapproved clips invisible here.
        Filtering in the queryset rather than raising a 403 deliberately —
        a 404/403 split would confirm whether a given UUID exists to someone
        with no entitlement to ask.
        """
        clip = get_object_or_404(
            AudioClip.objects.filter(moderation_approved=True), pk=pk
        )
        data = PublicClipSerializer(clip, context={'request': request}).data

        if _wants_json(request):
            return Response(data)
        return HttpResponse(_render_share_card(data, request), content_type="text/html")

    @action(detail=True, methods=['post'], url_path='share-link',
            permission_classes=[permissions.IsAuthenticated])
    def share_link(self, request, pk=None):
        """Mint a long-lived share link for a clip (A4).

        Returns a URL carrying ``?s=<token>``. The token is an ordinary HLS
        playback token for this clip, minted with
        ``SHARE_TOKEN_TTL_SECONDS`` instead of the 600s media TTL.

        DECISION: no separate share token type, no ``ShareLink`` table, no
        second secret. A share token is simply a media token with a longer
        life, and the "exchange" step collapses because
        ``POST /clips/{id}/play/`` re-mints a short-lived one on the
        recipient's play intent. Those extra parts bought revocation and a
        separate namespace, and cost a second code path that must stay in
        step with the Worker and nginx validators. The trade-off taken instead
        is that a share token is not individually revocable — bounded by
        ``exp``, which is why that is 30 days and not forever.
        """
        if request.user.is_staff:
            clip = get_object_or_404(AudioClip, pk=pk)
        else:
            clip = get_object_or_404(
                AudioClip.objects.filter(creator=request.user), pk=pk
            )

        clip_key = uploads_svc.clip_storage_key(clip)
        if clip_key is None:
            # Nothing has been transcoded, so there is no media to grant.
            return Response(
                {"detail": "Clip media is not ready."}, status=status.HTTP_409_CONFLICT
            )

        token = generate_playback_token(
            user_id=clip.creator_id,
            clip_key=clip_key,
            ttl=settings.SHARE_TOKEN_TTL_SECONDS,
        )
        relative = f"/clips/{clip.id}/public/?s={token}"
        base = getattr(settings, "PUBLIC_APP_BASE_URL", "")
        return Response({
            "clip_id": clip.id,
            # Absolute only when a base is configured. Guessing a host here
            # would emit a plausible-but-wrong link that a client would not
            # second-guess.
            "url": f"{base}{relative}" if base else None,
            "path": relative,
            "token": token,
            "expires_in": settings.SHARE_TOKEN_TTL_SECONDS,
        }, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='play', permission_classes=[permissions.AllowAny])
    def play_shared(self, request, pk=None):
        """Exchange a share token for a short-lived media token (A4).

        This is the "click play" gate the user asked for: nothing is issued
        until an explicit play intent, so opening a shared link mints no
        credential at all.

        Authorization is two checks, and the second is the one that matters:

        1. ``verify_token`` proves the ``?s=`` value is one we signed and has
           not expired.
        2. ``payload["c"]`` must equal this clip's storage key. Without that,
           any valid token would unlock any clip — a recipient could take the
           ``?s=`` from the link they were sent and swap the clip id in the
           path. This is the "is this actually a reel which was shared to the
           user" check.

        The caller is anonymous and gets a short TTL, so the long-lived share
        token never has to be attached to a player.
        """
        clip = get_object_or_404(
            AudioClip.objects.filter(moderation_approved=True), pk=pk
        )
        clip_key = uploads_svc.clip_storage_key(clip)
        if clip_key is None:
            return Response(
                {"detail": "Clip media is not ready."}, status=status.HTTP_409_CONFLICT
            )

        token = request.data.get('s') or request.query_params.get('s')
        payload = verify_token(token) if token else None
        if payload is None:
            return Response(
                {"detail": "A valid share link is required."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if payload.get("c") != clip_key:
            # Deliberately the same message as an invalid token. Distinguishing
            # "expired/invalid" from "valid, but for a different clip" would
            # confirm that some other clip exists.
            logger.warning(
                "share play refused: token scope mismatch clip=%s scope=%s",
                clip.id, payload.get("c"),
            )
            return Response(
                {"detail": "A valid share link is required."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Anonymous recipient. `u` is unused by every validator (Worker and
        # nginx both check HMAC, v, exp and the c-prefix only), so 0 is a safe
        # sentinel rather than a fabricated user id.
        media_token = generate_playback_token(
            user_id=0, clip_key=clip_key
        )
        response = Response({
            "status": "ok",
            "token": media_token,
            "hls_playlist_url": get_hls_playback_url(clip.hls_playlist_url),
        })
        response.set_cookie(
            key=COOKIE_NAME,
            value=media_token,
            max_age=settings.MEDIA_TOKEN_TTL_SECONDS,
            httponly=True,
            secure=True,
            samesite="Lax",
            path="/hls/",
        )
        return response
