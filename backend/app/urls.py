from django.urls import path, include
# DECISION: Regulatory endpoints (/legal/compliance/, /grievance/, /data-subject/, /legal/takedown/) are registered at the router level (not nested under router register) so they remain independent of viewset basename changes and are easily discoverable by compliance scanners. Tradeoff: slightly more verbose urlpatterns vs. clear separation of regulatory vs. content routes.
from rest_framework.routers import DefaultRouter
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.exceptions import TokenError
from .views import (
    AudioUploadViewSet, FastFeedViewSet, ClipInteractionViewSet,
    ShareViewSet, CommentViewSet, FollowViewSet,
    TagsViewSet, SuggestionViewSet, RegisterView, ProfileViewSet,
    GrievanceCreateView, DataSubjectAccessView, DataSubjectErasureView,
    ComplianceContactView, TakedownRequestView, PlaybackTokenView,
    SubscriptionStatusView, SubscriptionSyncView, SubscriptionManageView,
    RevenueCatWebhookView,
)
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from rest_framework.throttling import ScopedRateThrottle

from .throttling import RefreshTokenRateThrottle


class ThrottledTokenObtainPairView(TokenObtainPairView):
    # SECURITY: 10 login attempts/min/IP. Default AnonRateThrottle
    # 100/hour = ~1.7/min — too loose for credential stuffing.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'


class ThrottledTokenRefreshView(TokenRefreshView):
    # SECURITY: refresh is keyed on the *verified user id* inside the refresh
    # token, not on the caller's IP. The previous configuration inherited
    # `AnonRateThrottle` (100/hour/IP), which is fatal on a mobile network:
    # access tokens live 15 minutes, so every active user refreshes ~4x/hour
    # and a single carrier NAT gateway exhausts the cell's 100/hour budget
    # within minutes, logging out every subscriber on that cell at once.
    #
    # `throttle_scope` IS LOAD-BEARING, not decorative. `ScopedRateThrottle`
    # (the base of `RefreshTokenRateThrottle`) reads its scope from the view
    # at request time and returns True — allowing the request with no
    # accounting at all — when the view does not declare one. Dropping this
    # attribute would silently unthrottle the endpoint, which is a worse
    # failure than the original bug because nothing errors.
    # See backend/app/throttling.py and
    # backend/app/tests/test_throttling.py::TestRefreshThrottleWiring.
    throttle_classes = [RefreshTokenRateThrottle]
    throttle_scope = 'token_refresh'

router = DefaultRouter()
router.register(r'feed', FastFeedViewSet, basename='feed')
router.register(r'clips', AudioUploadViewSet, basename='clips')
router.register(r'interactions', ClipInteractionViewSet, basename='interactions')
router.register(r'share', ShareViewSet, basename='share')
router.register(r'comments', CommentViewSet, basename='comments')
router.register(r'follow', FollowViewSet, basename='follow')
router.register(r'tags', TagsViewSet, basename='tags')
router.register(r'suggestions', SuggestionViewSet, basename='suggestions')
router.register(r'profile', ProfileViewSet, basename='profile')


class LogoutView(APIView):
    # SECURITY: Blacklists the provided refresh token. The blacklist table
    # is created by the token_blacklist migration (added to INSTALLED_APPS).
    # Access tokens are short-lived (15 min) so no need to track them; once
    # the refresh token is blacklisted, no new access tokens can be minted.
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            refresh_token = request.data.get('refresh')
            if not refresh_token:
                return Response({'detail': 'refresh token required'}, status=400)
            token = RefreshToken(refresh_token)
            token.blacklist()
            return Response({'detail': 'logged out'})
        except TokenError:
            return Response({'detail': 'invalid refresh token'}, status=400)


urlpatterns = [
    path('', include(router.urls)),
    path('auth/login/', ThrottledTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('auth/register/', RegisterView.as_view(), name='register'),
    path('auth/token/refresh/', ThrottledTokenRefreshView.as_view(), name='token_refresh'),
    path('auth/logout/', LogoutView.as_view(), name='logout'),
    # ISSUE-03 (grievance / compliance) and ISSUE-06 (data-subject rights)
    # TODO: Check if they are rate-limited or throttled. If so, add ScopedRateThrottle and throttle_scope.
    path('legal/compliance/', ComplianceContactView.as_view(), name='legal_compliance'),
    path('legal/takedown/', TakedownRequestView.as_view(), name='legal_takedown'),
    path('grievance/', GrievanceCreateView.as_view(), name='grievance_create'),
    path('data-subject/access/', DataSubjectAccessView.as_view(), name='data_subject_access'),
    path('data-subject/erasure/', DataSubjectErasureView.as_view(), name='data_subject_erasure'),
    path('media/playback-token/<uuid:clip_id>/', PlaybackTokenView.as_view(), name='playback_token'),
    # RevenueCat subscription management endpoints
    path('subscription/', SubscriptionStatusView.as_view(), name='subscription_status'),
    path('subscription/sync/', SubscriptionSyncView.as_view(), name='subscription_sync'),
    path('subscription/manage/', SubscriptionManageView.as_view(), name='subscription_manage'),
    path('webhooks/revenuecat/', RevenueCatWebhookView.as_view(), name='revenuecat_webhook'),
    # NOTE: no /media/ route anymore, on purpose. Media now lives in S3-
    # compatible object storage (see settings.STORAGES["default"]), not on
    # this container's disk — there is nothing local left to serve, and a
    # django.views.static.serve route here would 404 on every request
    # regardless of DEBUG. Playback URLs come from FeedClipSerializer, which
    # asks default_storage for a freshly signed URL per request instead.
]