"""User-clip interaction views (likes, skips, telemetry).

DECISION: Split out of monolithic views.py in 2026-09. Single class
because all three actions share the same queryset (AudioClip) and
the same throttle_scope plumbing.

Stage 2 (relational-to-event-driven plan): all ORM writes go through
backend.app.services.interactions. The view is now a pure controller.
"""
import logging
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from ..models import AudioClip
from ..serializers import SkipActionSerializer, InteractionTelemetrySerializer
from ..services import interactions as interactions_svc

logger = logging.getLogger(__name__)


class ClipInteractionViewSet(viewsets.GenericViewSet):
    queryset = AudioClip.objects.all()
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'interaction'

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
