"""Auth view: registration."""
# DECISION: RegisterView uses AllowAny (public endpoint) with a scoped throttle rather than IsAuthenticated. This aligns with DPDP consent capture at registration time — every user must be able to create an account, but account-creation spam is rate-limited. Tradeoff: open endpoint requires robust validation in RegisterSerializer (consent + copyright acknowledgment) rather than relying on auth boundary.
#
# SECURITY (revised 2026-09-28): two independent limits, and the per-IP rate
# was raised from 5/hour. The original 5/hour was chosen against a desktop
# threat model where one IP is one person, but on a mobile network one IP is
# one carrier NAT gateway carrying thousands of subscribers — 5 signups/hour
# per cell caps the growth metric, not the attacker. See
# backend/app/throttling.py for the full CGNAT analysis.
from django.contrib.auth import get_user_model
from rest_framework import generics
from rest_framework.permissions import AllowAny
from rest_framework.throttling import ScopedRateThrottle

from ..serializers import RegisterSerializer
from ..throttling import RegisterUsernameRateThrottle

User = get_user_model()


class RegisterView(generics.CreateAPIView):
    queryset = User.objects.all()
    # Everyone must be able to hit this endpoint to sign up!
    permission_classes = (AllowAny,)
    serializer_class = RegisterSerializer

    # SECURITY: two limits, both required, because registration is anonymous
    # and therefore unavoidably IP-keyed.
    #
    #   ScopedRateThrottle           -> scope 'register', 200/hour, keyed on
    #                                   the caller's IP. Bounds how much
    #                                   traffic one source address can
    #                                   generate, and is sized to let a
    #                                   carrier NAT onboard normally.
    #   RegisterUsernameRateThrottle -> scope 'register_username', 3/hour,
    #                                   keyed on the username being claimed.
    #                                   This is the limit the IP key cannot
    #                                   express: it stops one host churning
    #                                   through 200 accounts, and stops the
    #                                   repeated-re-registration attack used
    #                                   to squat or reclaim a handle.
    #
    # `AnonRateThrottle` is deliberately dropped from this list. It was
    # implicitly active before via DEFAULT_THROTTLE_CLASSES at 100/hour,
    # which is looser than the new 'register' rate, so retaining it would
    # only make the effective limit the tighter of the two for no gain. The
    # per-IP bound is still enforced — 'register' is itself IP-keyed.
    throttle_classes = [ScopedRateThrottle, RegisterUsernameRateThrottle]
    throttle_scope = 'register'
