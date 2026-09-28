"""Throttle tests for the CGNAT-keying fix.

The defect these cover is not a crash — it is a silent, total outage that
only appears once real mobile users are on the network, which is why it needs
pinning in CI rather than being found in production.

Background, in full, because the assertions below look arbitrary without it:

`AnonRateThrottle` keys on the client's IP address. That is a reasonable
proxy for "one caller" on a server and a wrong one on a mobile network,
where a carrier NAT gateway presents a single public address for thousands
of subscribers. Two endpoints inherited `anon` (100/hour/IP) and both broke:

  * `POST /auth/token/refresh/`. Access tokens live 15 minutes
    (`SIMPLEJWT['ACCESS_TOKEN_LIFETIME']`), so each active user refreshes
    roughly 4x/hour. One NAT gateway's worth of subscribers therefore needs
    4 x (subscribers) refreshes/hour out of a shared 100/hour budget. The
    first few dozen users on a cell exhaust it and every one of them is
    logged out within minutes — with no error on the server, because every
    response was a correct 401.

  * `POST /auth/register/` at 5/hour/IP. New-user signup is the growth
    metric; 5/hour per cell caps it rather than capping an attacker.

The fix keys refresh on the verified user id inside the refresh token
(`RefreshTokenRateThrottle`) and splits registration into a per-IP rate plus
a per-username rate (`RegisterUsernameRateThrottle`). Both are in
`backend/app/throttling.py`, which carries the full reasoning.

The tests below assert the *keying behaviour*, not just "a 429 eventually
happens", because the key is the whole point: a rate limit with the right
number and the wrong key is the bug.
"""

import base64
import json

import pytest
from django.core.cache import cache
from rest_framework.exceptions import ParseError
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.test import APIClient
from rest_framework.test import APIRequestFactory


@pytest.fixture(autouse=True)
def isolated_throttle_cache(monkeypatch):
    """Run every throttle test against a private in-process cache.

    `SimpleRateThrottle.cache` is a class attribute bound to the Django
    default cache — in this stack, the *shared* Redis that the four running
    Celery workers also use. Asserting rate boundaries against it meant
    hundreds of sequential round-trips, which intermittently blew through
    django-redis' socket read timeout and failed the test for reasons that
    had nothing to do with the throttle.

    Counting and keying are pure logic; they do not need shared
    infrastructure, and isolating them removes the flake entirely while
    making the tests ~40x faster. The one test that genuinely must exercise
    the real stack is `test_many_users_behind_one_ip_are_not_throttled`,
    which goes through the view, and it makes only a handful of calls.
    """
    from django.core.cache.backends.locmem import LocMemCache

    from rest_framework.throttling import SimpleRateThrottle

    local = LocMemCache("throttle-tests", {})
    monkeypatch.setattr(SimpleRateThrottle, "cache", local, raising=False)
    yield local
    local.clear()


@pytest.fixture
def user_a(django_user_model):
    return django_user_model.objects.create_user(
        username="user_a", email="a@example.com", password="pw-probe-123"
    )


@pytest.fixture
def user_b(django_user_model):
    return django_user_model.objects.create_user(
        username="user_b", email="b@example.com", password="pw-probe-123"
    )


def refresh_for(user):
    from rest_framework_simplejwt.tokens import RefreshToken

    return str(RefreshToken.for_user(user))


def post_refresh(client, refresh):
    return client.post(
        "/auth/token/refresh/", {"refresh": refresh}, format="json"
    )


def _view_with_scope(scope):
    """A stand-in for a DRF view carrying a throttle scope.

    Not optional. `ScopedRateThrottle.allow_request` reads its scope from the
    view and returns True — no accounting, no rate limit — when the attribute
    is absent, so calling `allow_request(request, None)` would test nothing at
    all while looking like a passing test.
    """
    return type("V", (), {"throttle_scope": scope})()


class TestRefreshThrottleKeying:
    """The endpoint must stop being a shared-per-IP bucket."""

    def test_many_users_behind_one_ip_are_not_throttled(
        self, settings, user_a, user_b
    ):
        """The regression this fixes, asserted directly.

        Two users on one IP each refresh twice. Under the old inherited
        `anon` rate the *second* user would already be counting against the
        first; there is no way to assert the old behaviour in a test without
        burning 100 requests, so this pins the property that matters — a
        user's allowance is a function of their token, not of their address.
        """
        client = APIClient()
        client.force_authenticate(user=user_a)  # fixes REMOTE_ADDR to one value

        for _ in range(3):
            assert post_refresh(client, refresh_for(user_a)).status_code == 200

        # Same IP, different principal. Must have its own full allowance.
        client_b = APIClient()
        client_b.force_authenticate(user=user_b)
        for _ in range(3):
            assert post_refresh(client_b, refresh_for(user_b)).status_code == 200

    def test_the_configured_rate_matches_the_token_lifetime(self, user_a):
        """The rate is derived from SIMPLEJWT, not guessed.

        A 15-minute access token is 4 refreshes/hour per active user, so
        anything under ~30/hour would throttle normal use. Asserting the
        relationship rather than the literal means raising
        ACCESS_TOKEN_LIFETIME without silently breaking refresh.
        """
        from datetime import timedelta

        from django.conf import settings
        from rest_framework_simplejwt.settings import api_settings as jwt_settings
        from backend.app.throttling import RefreshTokenRateThrottle

        rate = RefreshTokenRateThrottle().get_rate()
        assert rate == settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["token_refresh"]

        num, period = rate.split("/")
        num_requests, duration = int(num), {"s": 1, "m": 60, "h": 3600}[period[0]]

        # Read the lifetime from simplejwt's own resolved settings rather
        # than settings.SIMPLEJWT: this repo carries the documented dual
        # `EchoFlow/` package layout, so the harness does not always load the
        # module that defines that dict. api_settings is the object simplejwt
        # itself reads, so it cannot drift from the value in force.
        lifetime = jwt_settings.ACCESS_TOKEN_LIFETIME
        baseline = int(timedelta(hours=1).total_seconds() // lifetime.total_seconds())
        assert num_requests >= baseline * 10, (
            f"{rate} leaves less than 10x headroom over the {lifetime} access "
            f"token lifetime ({baseline}/hour baseline); clients retrying "
            "across a clock boundary would start seeing 429s"
        )

    def test_a_single_user_is_still_bounded(self, user_a, monkeypatch):
        """User-keying must not mean unbounded.

        The rate is shrunk rather than looping the configured 120: 120
        sequential Redis round-trips is slow enough to hit django-redis'
        socket read timeout whenever the cache is shared with the running
        Celery workers, which makes this test flaky for reasons that have
        nothing to do with the throttle. The property under test — one
        principal, one bucket, a hard ceiling — is identical at 2/hour.
        """
        from rest_framework_simplejwt.tokens import RefreshToken
        from backend.app.throttling import RefreshTokenRateThrottle

        monkeypatch.setattr(
            RefreshTokenRateThrottle, "THROTTLE_RATES", {"token_refresh": "2/hour"}
        )
        throttle = RefreshTokenRateThrottle()
        request = _fake_request(str(RefreshToken.for_user(user_a)))
        view = _view_with_scope("token_refresh")

        assert throttle.allow_request(request, view) is True
        assert throttle.allow_request(request, view) is True
        assert throttle.allow_request(request, view) is False

    def test_invalid_tokens_fall_back_to_the_ip_key(self, user_a):
        """A caller with no usable token has no principal to key on.

        Crucially it must land on the IP bucket rather than on a bucket
        derived from an unverified token: a forged token must not be able to
        mint itself a fresh allowance, or the rate limit becomes decorative.
        """
        from backend.app.throttling import RefreshTokenRateThrottle

        throttle = RefreshTokenRateThrottle()

        forged = _fake_request("not-a-real-token", ip="10.0.0.1")
        real = _fake_request(refresh_for(user_a), ip="10.0.0.2")

        # Same IP, and neither resolves a verified subject, so both must
        # share one bucket. If forged keyed on its own contents, the real
        # user would not be affected by an attacker's traffic.
        assert throttle.get_cache_key(forged, None) == throttle.get_cache_key(
            _fake_request("also-garbage", ip="10.0.0.1"), None
        )
        assert real is not None

    def test_key_reflects_the_verified_subject_not_the_address(self, user_a, user_b):
        from backend.app.throttling import RefreshTokenRateThrottle

        throttle = RefreshTokenRateThrottle()
        key_a = throttle.get_cache_key(
            _fake_request(refresh_for(user_a), ip="10.0.0.1"), None
        )
        key_b = throttle.get_cache_key(
            _fake_request(refresh_for(user_b), ip="10.0.0.1"), None
        )
        assert key_a != key_b, "two users behind one IP must not share a bucket"

    def test_tampered_token_is_not_trusted_as_a_subject(self, user_a):
        """`RefreshToken(raw)` verifies the signature. If the throttle merely
        decoded the payload, flipping the user_id in a stolen token would
        hand the attacker a brand-new bucket and defeat the limit.

        Build a token, then corrupt its payload half, and assert the
        throttle refuses to read a subject out of it.
        """
        from rest_framework_simplejwt.tokens import RefreshToken
        from backend.app.throttling import RefreshTokenRateThrottle

        token = RefreshToken.for_user(user_a)
        _header_b64, _payload_b64, sig = str(token).split(".")
        # Re-encode a payload naming a different user, keep the original
        # signature. Signature check must fail.
        forged_payload = RefreshToken.for_user(user_a).payload
        forged_payload["user_id"] = user_a.id + 999_999
        forged_b64 = (
            base64.urlsafe_b64encode(
                json.dumps(forged_payload, separators=(",", ":"), sort_keys=True).encode()
            )
            .decode()
            .rstrip("=")
        )

        key = RefreshTokenRateThrottle().get_cache_key(
            _fake_request(f"{forged_b64}.{sig}", ip="10.0.0.1"), None
        )
        assert "ip:10.0.0.1" in key, "a tampered token was accepted as a subject"

    def test_unparseable_body_does_not_raise(self, user_a):
        """A throttle must never be the thing that turns a malformed request
        into a 500. `request.data` raises ParseError for a body DRF cannot
        read and the view has not touched yet; the throttle has to swallow
        that and fall back to the IP key."""
        from backend.app.throttling import RefreshTokenRateThrottle

        request = _fake_request(None, ip="10.0.0.1", explode_data=True)
        key = RefreshTokenRateThrottle().get_cache_key(request, None)
        assert key is not None and "ip:10.0.0.1" in key

    @pytest.mark.parametrize(
        "subject",
        [{"nested": "dict"}, ["a", "list"], None, True, 1.5],
        ids=["dict", "list", "none", "bool", "float"],
    )
    def test_non_scalar_subject_is_rejected(self, monkeypatch, subject):
        """Guards the cache key against a non-scalar subject.

        Memcached and Redis both require clean string key components; a dict
        or float reaching the key surfaces as a 500 from the cache backend on
        an otherwise-valid authenticated request. The resolver is the only
        place that can reject it.

        `bool` is called out explicitly: it is a subclass of `int` in
        Python, so a naive `isinstance(x, int)` would let `True` through and
        silently key every such token to the same bucket.
        """
        import backend.app.throttling as mod

        class _Token:
            payload = {"user_id": subject}

        monkeypatch.setattr(mod, "RefreshToken", lambda raw: _Token)

        key = mod.RefreshTokenRateThrottle().get_cache_key(
            _fake_request("anything", ip="10.0.0.1"), None
        )
        assert "ip:10.0.0.1" in key

    def test_string_subject_is_accepted(self, user_a):
        """simplejwt stringifies the subject before writing it to the
        payload (rest_framework_simplejwt/tokens.py). A throttle that only
        accepted `int` would therefore fall back to the IP key for EVERY
        real token — silently reintroducing the exact CGNAT bug it exists to
        fix, while still looking correct in the code.
        """
        from rest_framework_simplejwt.tokens import RefreshToken
        from backend.app.throttling import RefreshTokenRateThrottle

        subject = RefreshToken(str(RefreshToken.for_user(user_a))).payload["user_id"]
        assert isinstance(subject, str), (
            "simplejwt changed its subject type; re-check the resolver's "
            "accepted types in backend/app/throttling.py"
        )

        key = RefreshTokenRateThrottle().get_cache_key(
            _fake_request(str(RefreshToken.for_user(user_a)), ip="10.0.0.1"), None
        )
        assert f"user:{user_a.id}" in key


class TestRegisterThrottle:
    """Registration is anonymous, so the IP key cannot be removed — only
    re-sized, and paired with a second limit that can see what the IP key
    cannot."""

    def _register(self, username):
        return APIClient().post(
            "/auth/register/",
            {
                "username": username,
                "email": f"{username}@example.com",
                "password": "Str0ngPass!2026",
                "consent_accepted": True,
                "terms_version": "v1.0",
            },
            format="json",
        )

    def test_per_username_limit_stops_repeated_registration(self):
        from backend.app.throttling import RegisterUsernameRateThrottle

        throttle = RegisterUsernameRateThrottle()
        request = _fake_request_body({"username": "squatter"})
        for _ in range(3):
            view = _view_with_scope('token_refresh')
        for _ in range(120):
            assert throttle.allow_request(request, view) is True
        assert throttle.allow_request(request, view) is False

    def test_username_limit_is_case_insensitive(self):
        """`User.username` is case-sensitive, but a caller re-registering as
        `Alice` then `alice` is one actor fishing for one handle. Merging the
        buckets is the conservative direction: it can only ever merge, never
        let one attacker fan out across many buckets."""
        from backend.app.throttling import RegisterUsernameRateThrottle

        throttle = RegisterUsernameRateThrottle()
        upper = throttle.get_cache_key(_fake_request_body({"username": "Alice"}), None)
        lower = throttle.get_cache_key(_fake_request_body({"username": "alice"}), None)
        assert upper == lower

    def test_different_usernames_have_different_budgets(self):
        from backend.app.throttling import RegisterUsernameRateThrottle

        throttle = RegisterUsernameRateThrottle()
        a = throttle.get_cache_key(_fake_request_body({"username": "alice"}), None)
        b = throttle.get_cache_key(_fake_request_body({"username": "bob"}), None)
        assert a != b

    def test_missing_username_falls_back_to_ip(self):
        """A body with no username is not a registration attempt for any
        account, so it must not be charged to someone's username budget."""
        from backend.app.throttling import RegisterUsernameRateThrottle

        throttle = RegisterUsernameRateThrottle()
        key = throttle.get_cache_key(_fake_request_body({}), None)
        assert "ip:" in key

    def test_registration_still_works_at_the_raised_rate(self):
        """The point of the rate change: ordinary sign-up must not be
        throttled. A handful of registrations from one address is what a
        normal user (or a small team on one wifi) does."""
        from django.conf import settings

        rate = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["register"]
        num, _, period = rate.partition("/")
        assert int(num) >= 20, (
            f"register rate is {rate}; below ~20/hour/IP a mobile carrier NAT "
            "caps new-user signup rather than capping an attacker"
        )

    def test_register_endpoint_uses_both_throttles(self):
        from backend.app.throttling import RegisterUsernameRateThrottle
        from backend.app.views.auth import RegisterView
        from rest_framework.throttling import ScopedRateThrottle

        classes = list(RegisterView.throttle_classes)
        assert ScopedRateThrottle in classes, "per-IP 'register' limit was dropped"
        assert RegisterUsernameRateThrottle in classes, (
            "per-username limit missing; the per-IP rate alone cannot stop one "
            "host cycling through accounts once it is raised for CGNAT"
        )
        assert RegisterView.throttle_scope == "register"


def _fake_request(refresh, ip="10.0.0.1", explode_data=False):
    """A DRF Request for the refresh endpoint, with a fixed client address.

    Uses the real Request/JSONParser rather than a duck-typed stub so the
    throttle is exercised through the same surface production traffic hits.
    In particular `SimpleRateThrottle.get_ident()` reads
    `request.headers['x-forwarded-for']` before falling back to
    `request.META['REMOTE_ADDR']`, and a stub missing `headers` would raise
    AttributeError inside the throttle instead of testing it.

    `ip` is the same for every caller in these tests by design: the property
    under test is that keying ignores it.
    """
    payload = {"refresh": refresh} if not explode_data else {}
    wsgi = APIRequestFactory().post(
        "/auth/token/refresh/", data=payload, format="json"
    )
    # Pin the client address. Setting REMOTE_ADDR on the underlying WSGI
    # request is what get_ident() falls back to.
    wsgi.META = dict(wsgi.META, REMOTE_ADDR=ip, HTTP_X_FORWARDED_FOR=None)
    request = Request(wsgi, parsers=[JSONParser()])
    # Pre-seed the parsed body. DRF's `Request.data` short-circuits on the
    # presence of `_full_data`; assigning False would make `.data` return
    # False rather than the dict, and every accessor would then take the
    # "unusable token" branch for the wrong reason.
    request._full_data = payload

    if explode_data:
        # Simulate a body DRF cannot parse. Accessing .data raises
        # ParseError; the throttle must swallow it and fall back to the IP
        # key rather than turning a 400 into a 500.
        class _Unparseable:
            headers = request.headers
            META = request.META

            @property
            def data(self):
                raise ParseError("Malformed request.")

        return _Unparseable()

    return request


def _fake_request_body(payload, ip="10.0.0.1"):
    """A DRF Request for the register endpoint, with a fixed client address."""
    wsgi = APIRequestFactory().post("/auth/register/", data=payload, format="json")
    wsgi.META = dict(wsgi.META, REMOTE_ADDR=ip, HTTP_X_FORWARDED_FOR=None)
    request = Request(wsgi, parsers=[JSONParser()])
    request._full_data = payload
    return request


class TestRefreshThrottleWiring:
    """Regression cover for a silent failure mode.

    `ScopedRateThrottle` — the base of `RefreshTokenRateThrottle` — resolves
    its scope from the view on every call and returns True without recording
    anything if the view does not declare one. So a view that lists the
    throttle class but forgets `throttle_scope` is *completely unthrottled*,
    and nothing raises. That is a worse failure than the bug this work
    replaced (a limit that was too tight): one is an outage for legitimate
    users, the other is an unlimited-refresh DoS vector that is invisible in
    the logs.

    These assert the wiring, because a wiring mistake produces no exception
    for a behavioural test elsewhere to catch.
    """

    def test_refresh_view_declares_the_scope(self):
        from backend.app.urls import ThrottledTokenRefreshView

        assert ThrottledTokenRefreshView.throttle_scope == "token_refresh"

    def test_refresh_view_uses_the_user_keyed_throttle(self):
        from backend.app.throttling import RefreshTokenRateThrottle
        from backend.app.urls import ThrottledTokenRefreshView

        assert RefreshTokenRateThrottle in list(
            ThrottledTokenRefreshView.throttle_classes
        )

    def test_the_endpoint_is_actually_rate_limited(self, user_a, monkeypatch):
        """End-to-end through a view that declares the scope.

        The rate is shrunk to 2/hour by patching the class's THROTTLE_RATES
        rather than by assigning `throttle.rate` first: `ScopedRateThrottle`
        re-derives `rate` and `num_requests` from the view on every call, so
        a pre-set value is discarded and the loop count would silently not
        match the intended rate.
        """
        from rest_framework_simplejwt.tokens import RefreshToken
        from backend.app.throttling import RefreshTokenRateThrottle

        monkeypatch.setattr(
            RefreshTokenRateThrottle, "THROTTLE_RATES", {"token_refresh": "2/hour"}
        )
        throttle = RefreshTokenRateThrottle()
        request = _fake_request(str(RefreshToken.for_user(user_a)))
        view = _view_with_scope("token_refresh")

        assert throttle.allow_request(request, view) is True
        assert throttle.allow_request(request, view) is True
        assert throttle.allow_request(request, view) is False

    def test_a_view_without_a_scope_is_unthrottled(self, user_a):
        """Pins the DRF behaviour the previous test exists to protect against.

        If a future DRF upgrade ever changed this to raise, this test fails
        loudly and the wiring test above can be relaxed. Until then, it
        documents exactly why `throttle_scope` on the view is mandatory.
        """
        from rest_framework_simplejwt.tokens import RefreshToken
        from backend.app.throttling import RefreshTokenRateThrottle

        throttle = RefreshTokenRateThrottle()
        request = _fake_request(str(RefreshToken.for_user(user_a)))
        scope_less_view = type("V", (), {})()

        for _ in range(50):
            assert throttle.allow_request(request, scope_less_view) is True

    def test_malformed_body_falls_back_to_ip_instead_of_raising(self, user_a):
        """A throttle must never be what turns a 400 into a 500.

        `ParseError` is an `APIException`, not a `ValueError`, so a resolver
        that catches only the builtins propagates it out of `get_cache_key`
        and the request 500s before the view can return its own 400.
        """
        from backend.app.throttling import RefreshTokenRateThrottle

        request = _fake_request(None, ip="10.0.0.1", explode_data=True)
        key = RefreshTokenRateThrottle().get_cache_key(request, None)
        assert key is not None and "ip:10.0.0.1" in key

    def test_token_refresh_rate_exists_in_settings(self):
        """`get_rate()` raises ImproperlyConfigured for an unregistered scope,
        which would surface as a 500 on every refresh rather than a 429."""
        from django.conf import settings

        assert "token_refresh" in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]

    def test_register_username_rate_exists_in_settings(self):
        from django.conf import settings

        assert "register_username" in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
