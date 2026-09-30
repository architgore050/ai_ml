"""User-clip interaction views (likes, skips, telemetry).

DECISION: Split out of monolithic views.py in 2026-09. Single class
because all three actions share the same queryset (AudioClip) and
the same throttle_scope plumbing.

Stage 2 (relational-to-event-driven plan): all ORM writes go through
backend.app.services.interactions. The view is now a pure controller.
"""
import logging
from django.db.models import Q
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from ..models import AudioClip
from ..serializers import SkipActionSerializer, InteractionTelemetrySerializer
from ..services import interactions as interactions_svc

logger = logging.getLogger(__name__)


class ClipInteractionViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'interaction'

    def get_queryset(self):
        """Clips this caller may interact with. R5-02 (2026-09-30).

        The class body used to declare ``queryset = AudioClip.objects.all()``,
        and all three actions resolve through ``self.get_object()``, so
        ``POST /interactions/{any_uuid}/register-skip/`` wrote a ``skips``
        increment and a completion sample onto any clip in the table —
        including ``moderation_approved=False`` clips, which no feed will ever
        serve. ``flush_counters_to_pg`` then folds those into
        ``AudioClip.avg_completion_rate`` (30% of the recommendation composite,
        ``feed_pool.py:151-153``) and, via a forged like, into
        ``engagement_velocity`` (25%). It was a write-IDOR and a
        ranking-poisoning primitive against unpublished content, at 60
        requests/minute.

        The scope is not "clips I created" — any authenticated user may like,
        skip and log telemetry on a clip the feed served them, and most clips in
        anyone's feed come from authors they do not follow
        (``services/entitlements.py`` docstring, "What this deliberately does
        NOT do"). It is "clips this caller may legitimately act on", and that
        rule already exists in one place: ``resolve_clip_access``. Re-deriving
        it as an independent filter would be a second answer to the same
        question, which is the drift this file's own docstring warns about.

        Translated to SQL, the predicate is:

            creator == me
            OR (moderation_approved
                AND (a ShareEvent sent it to me OR it is licence-clean))

        Clause by clause, against ``services/entitlements.py``:

        * ``creator == me`` — ``ACCESS_OWNER`` (:105-106). Unconditional,
          including before moderation. This is the ONE divergence from
          ``resolve_clip_access``, which gates ``moderation_approved`` on
          everyone (:102-103) because *playback* of an unapproved clip is
          withheld from its uploader. Interaction is not playback: an
          unmoderated clip has exactly one owner, and the v1 flow has that
          owner self-approve it (``views/content.py:262-264``). Scoping
          someone out of their own draft would be a functional regression, and
          would break ``test_security_and_validation.py::TestInteractions``,
          which likes and logs telemetry against the unmoderated
          ``ready_clip`` fixture. ``test_interaction_scoping.py`` pins this
          divergence explicitly instead of leaving it implicit.
        * ``moderation_approved`` (:102-103) — including the share branch. A
          takedown clears the flag, and a takedown must stop a share from
          being a durable capability over withdrawn content; the ShareEvent row
          outlives the reversal.
        * ``a ShareEvent sent it to me`` — ``ACCESS_SHARED_WITH_ME``
          (:108-110), and like the owner branch it is exempt from the licence
          filter, because ``resolve_clip_access`` returns before
          ``is_license_restricted`` is consulted. The share inbox is a
          first-class surface that hands the recipient a playable HLS URL, so
          refusing to let them like what the app just sent them is the "the
          link works for you, then stops working" failure mode.
        * ``licence-clean`` — ``is_license_restricted`` (:60-67), the same
          NC/SA pair the feed filters on (``views/feed.py:111-115``). This is
          the only clause that closes the reported exploit, and it is the one
          place where interaction and playback agree without an exemption.

        NOT in the scope, deliberately: ``following`` and prior interaction.
        ``_follows_author`` and ``_has_interaction`` are consulted *after* the
        licence check and only to label the log line, never to grant access
        (:115-119). If either were honoured here, a licence-restricted clip
        would become interactable by following its author.

        ``status='ready'`` is also deliberately absent: the feed page's own
        filter is ``moderation_approved`` + licence-clean without it
        (``views/feed.py:111-115``), and ``resolve_clip_access`` does not
        require it either, so adding it here would be a third variant of
        "what is servable" rather than a copy of an existing one.

        A denied clip 404s rather than 403s, because ``get_object()`` raises
        ``Http404`` (so the non-leaking answer costs no extra code) and a 403
        would confirm the clip exists — UUIDs are the only identifier here.
        Same reasoning as ``views/content.py:255-258``.
        """
        user = self.request.user
        return AudioClip.objects.filter(
            Q(creator=user)
            | (
                Q(moderation_approved=True)
                & (
                    Q(shareevent__receiver=user)
                    | Q(is_noncommercial=False, requires_share_alike=False)
                )
            )
            # The ShareEvent join can multiply rows; without this a clip shared
            # by three senders raised `MultipleObjectsReturned` out of
            # get_object()'s `.get()` — a 500. Pinned by
            # `test_three_senders_of_one_clip_does_not_500`.
        ).distinct()

    @action(detail=True, methods=['post'], url_path='toggle-like')
    def toggle_like(self, request, pk=None):
        clip = self.get_object()
        interaction, _created = interactions_svc.record_like_toggle(request.user, clip)
        status_text = 'liked' if interaction.is_active else 'unliked'
        return Response({'status': status_text}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='register-skip')
    def register_skip(self, request, pk=None):
        clip = self.get_object()
        serializer = SkipActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        interactions_svc.record_skip(
            request.user,
            clip,
            listen_duration_ms=serializer.validated_data['listen_duration_ms'],
            reel_position_ms=serializer.validated_data['reel_position_ms'],
        )
        return Response({"status": "skip/view registered"}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='log-telemetry')
    def log_telemetry(self, request, pk=None):
        # B1 (2026-09-29): DPDP §9 behavioural-monitoring gate. EchoFlow's
        # recommendation path consumes watch_time_ms, completion rate and
        # reel position, which is behavioural monitoring of a child. A
        # minor's telemetry must not reach it.
        #
        # Gated on is_minor rather than minor_consent_verified because
        # nothing can set the latter True yet (no parental-verification
        # flow exists — see RegisterSerializer). Gating on
        # minor_consent_verified alone would therefore admit every minor,
        # which is the opposite of the intent.
        #
        # Likes and skips are NOT blocked: they are explicit user actions
        # rather than passive tracking, and blocking them would stop a
        # minor participating in the app at all.
        if request.user.is_minor:
            logger.info(
                "telemetry refused for minor: user=%s clip=%s",
                request.user.pk, pk,
            )
            return Response(
                {"detail": "Telemetry is not collected for accounts of users under 18."},
                status=status.HTTP_403_FORBIDDEN,
            )

        clip = self.get_object()
        serializer = InteractionTelemetrySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        interactions_svc.record_telemetry(
            request.user,
            clip,
            action_type=serializer.validated_data['action_type'],
            watch_time_ms=serializer.validated_data['watch_time_ms'],
        )
        return Response({"status": "telemetry logged"}, status=status.HTTP_202_ACCEPTED)

    def get_throttles(self):
        # SECURITY: log_telemetry is the architecture audit's #1 abuse vector
        # (viewbot / engagement-velocity manipulation). Override the default
        # 'interaction' scope with the tighter 'telemetry' scope for this action.
        if self.action == 'log_telemetry':
            return [ScopedRateThrottle()]
        return super().get_throttles()

    @property
    def throttle_scope(self):
        return 'telemetry' if self.action == 'log_telemetry' else 'interaction'
