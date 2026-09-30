"""Subscription management views.

Provides Pro entitlement status, manual sync trigger, and the
RevenueCat Customer Portal URL for subscription management.
"""
import hashlib
import hmac
from django.conf import settings
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.viewsets import ViewSet

from ..serializers import SubscriptionStatusSerializer
from ..services.revenuecat import _app_user_id


def _get_limits(user) -> dict:
    """Compute usage limits based on Pro status."""
    is_pro = user.is_pro()
    if is_pro:
        return {
            "daily_uploads_remaining": "unlimited",
            "max_clip_duration_seconds": getattr(settings, "MAX_DURATION_SECONDS", 300),
            "max_upload_size_mb": getattr(settings, "REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE", 10) * 10,
            "hd_quality_allowed": True,
        }
    free_limit = getattr(settings, "REVENUECAT_DAILY_UPLOAD_LIMIT_FREE", 5)
    return {
        "daily_uploads_remaining": str(_free_uploads_remaining(user, free_limit)),
        "max_clip_duration_seconds": getattr(settings, "REVENUECAT_CLIP_DURATION_LIMIT_FREE", 60),
        "max_upload_size_mb": getattr(settings, "REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE", 10),
        "hd_quality_allowed": not getattr(settings, "REVENUECAT_HD_QUALITY_BLOCKED_FREE", True),
    }


def _free_uploads_remaining(user, daily_limit: int) -> int:
    """Count today's uploads for a free user and return remaining quota."""
    from ..models import AudioClip
    today = timezone.now().date()
    created_today = AudioClip.objects.filter(
        creator=user, created_at__date=today
    ).count()
    return max(0, daily_limit - created_today)


class SubscriptionStatusView(APIView):
    """GET /api/v1/subscription/

    Returns the current Pro subscription status and usage limits
    for the authenticated user.
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        user = request.user
        serializer = SubscriptionStatusSerializer(
            {
                # The caller's own App User ID. Sourced from the authenticated
                # request, never from a query parameter, so this endpoint cannot
                # be used to read anyone else's billing identity.
                "app_user_id": _app_user_id(user),
                "is_pro": user.is_pro(),
                "expires_at": user.pro_expires_at,
                "grace_until": user.pro_grace_until,
                "last_synced": user.pro_last_synced,
                "limits": _get_limits(user),
            }
        )
        return Response(serializer.data)


class SubscriptionSyncView(APIView):
    """POST /api/v1/subscription/sync/

    Forces an immediate sync with RevenueCat. Rate-limited to
    prevent abuse (manual sync only).
    """
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'subscription_sync'

    def post(self, request):
        if not getattr(settings, "REVENUECAT_SECRET_KEY", ""):
            return Response(
                {"detail": "RevenueCat not configured."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        from ..tasks import sync_revenuecat_entitlements
        sync_revenuecat_entitlements.delay(str(request.user.id))
        return Response({"detail": "Sync triggered. Check back in a few seconds."})


class SubscriptionManageView(APIView):
    """GET /api/v1/subscription/manage/

    Returns the RevenueCat Customer Portal URL so the frontend can
    redirect the user to manage their subscription.
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from ..services.revenuecat import get_customer_portal_url
        url = get_customer_portal_url(request.user)
        return Response({"url": url})


class RevenueCatWebhookView(APIView):
    """POST /api/v1/webhooks/revenuecat/

    Webhook endpoint for RevenueCat event notifications.

    Phase 1 (free tier): Webhooks are not used — syncing is done via
    REST API polling (sync_revenuecat_entitlements task). This endpoint
    exists for forward-compatibility and returns 200 to satisfy any
    webhook URL configured in the RevenueCat dashboard.

    Phase 2 (Pro plan): HMAC verification will be implemented here
    when webhooks are enabled. The RevenueCat webhook signature is
    passed in the `X-RevenueCat-Signature` header.

    SECURITY: Even though we don't process events yet, we must return
    200 for any valid POST so RevenueCat doesn't retry and mark the
    endpoint as unhealthy. Future implementation will:
      1. Verify the HMAC signature using REVENUECAT_WEBHOOK_SECRET.
      2. Parse the event type and update the User model accordingly.
      3. Return 401 on signature mismatch.
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        signature = request.META.get("HTTP_X_REVENUECAT_SIGNATURE", "")
        event_type = request.data.get("event_type", "unknown")
        logger_msg = f"RevenueCat webhook received: type={event_type}, sig_len={len(signature)}"
        import logging
        logging.getLogger(__name__).info(logger_msg)

        if getattr(settings, "REVENUECAT_WEBHOOK_SECRET", "") and signature:
            # SECURE: Verify HMAC-SHA256 signature when webhook secret is
            # configured. The signature is computed over the raw request body
            # using the shared secret. If verification fails, return 401.
            secret = getattr(settings, "REVENUECAT_WEBHOOK_SECRET", "")
            body = request.body
            expected = hmac.new(
                secret.encode(), body, hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(expected, signature):
                return Response({"detail": "Invalid signature"}, status=401)

        return Response({"status": "received"})
