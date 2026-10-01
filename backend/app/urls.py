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

from .throttling import (
    LoginUsernameRateThrottle,
    RefreshTokenRateThrottle,
    TrustedProxyRateThrottle,
)


class ThrottledTokenObtainPairView(TokenObtainPairView):
    # SECURITY: 10 login attempts/min/IP. Default AnonRateThrottle
    # 100/hour = ~1.7/min — too loose for credential stuffing.
    #
    # `TrustedProxyRateThrottle`, not a bare `ScopedRateThrottle`: the bare
    # class derives its identity from DRF's `get_ident`, which returns the
    # client-supplied `X-Forwarded-For` header. nginx *appends* to that
    # header (`$proxy_add_x_forwarded_for`), so a client-chosen prefix
    # survives to here and every rotation is a brand-new, never-before-seen
    # bucket — one HTTP header defeats the credential-stuffing gate without
    # any load. `TrustedProxyRateThrottle` resolves through
    # `EchoFlow.client_ip.get_client_ip` instead, preferring the `X-Real-IP`
    # that nginx *overwrites* from `$remote_addr` and which therefore cannot
    # be spoofed through the terminator.
    #
    # The scope and the rate are unchanged — both are still declared on the
    # view and in `DEFAULT_THROTTLE_RATES`; `TrustedProxyRateThrottle` reads
    # the scope from the view exactly as `ScopedRateThrottle` does, so
    # 'login' and 10/min are carried over as-is. It also inherits the
    # fail-closed 503 from that class, so a dead cache no longer surfaces as
    # a 500 on this endpoint.
    #
    # `NUM_PROXIES = 1` in settings is the backstop that made the bare class
    # survivable, not the fix: it is one line, easy to delete by accident, and
    # silently re-breaks if a second proxy is added in front. See
    # backend/app/throttling.py and
    # backend/app/tests/test_throttling.py::TestLoginThrottleWiring.
    #
    # SECURITY (2026-09-30): `LoginUsernameRateThrottle` runs alongside it, on
    # `login_username` at 10/hour, keyed on the username in the body. The IP
    # bucket cannot be removed — login is anonymous, so there is no verified
    # subject to key on the way `token_refresh` has one — but one IP is a
    # carrier NAT gateway carrying thousands of subscribers, so 'login' is one
    # 10/min budget for the whole cell and the 11th genuine user on a busy
    # morning gets a 429. The per-account bucket is the half of the
    # credential-stuffing gate that is not NAT-bound. It pins its own scope
    # through `UsernameKeyedRateThrottle.resolve_scope`; without that it would
    # inherit this view's 'login' and be indistinguishable from the IP limit.
    # See backend/app/throttling.py and
    # backend/app/tests/test_throttle_scopes_and_db_password.py.
    throttle_classes = [TrustedProxyRateThrottle, LoginUsernameRateThrottle]
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