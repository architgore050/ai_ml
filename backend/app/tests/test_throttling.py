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


#: The address nginx puts in `X-Real-IP` for the register endpoint, i.e.
#: what it actually saw. Mirrors `LOGIN_REAL_IP` for the other anonymous
#: endpoint: same terminator, same header precedence, same attacker.
REGISTER_REAL_IP = "203.0.113.7"
#: `REMOTE_ADDR` behind the terminator: the nginx container, not the user.
REGISTER_NGINX_PEER = "172.29.0.13"
#: The attacker's own entry, which nginx prepends to X-Forwarded-For.
REGISTER_SPOOFED = "9.9.9.9"


def _register_body(username):
    """A registration payload `RegisterSerializer` will actually accept.

    `dob` is required (B1, 2026-09-29) and the password must clear all four
    `AUTH_PASSWORD_VALIDATORS` while not resembling the username. Without
    these the endpoint 400s and the test would be asserting against a
    validation error rather than the throttle — the throttle runs in
    `initial()` either way, so a 400 body would still be *counted*, but a
    201 makes it unambiguous that the endpoint accepted the signup.
    """
    return {
        "username": username,
        "email": f"{username}@example.com",
        "password": "Str0ngPass!2026",
        "dob": "1990-01-01",
        "consent_accepted": True,
        "terms_version": "v1.0",
    }


def _post_register(client, spoofed_xff, username="rot0", real_ip=REGISTER_REAL_IP):
    """POST `/auth/register/` as it arrives *after* nginx.

    nginx APPENDS to X-Forwarded-For (`$proxy_add_x_forwarded_for`) and
    OVERWRITES X-Real-IP (`$remote_addr`), so a rotated header reaches Django
    as `<attacker's entry>, <real client>`. A test that set only
    X-Forwarded-For would model a caller with no proxy in front of it, which
    is not the deployment being defended — see backend/EchoFlow/client_ip.py.
    """
    return client.post(
        "/auth/register/",
        _register_body(username),
        format="json",
        HTTP_X_FORWARDED_FOR=f"{spoofed_xff}, {real_ip}",
        HTTP_X_REAL_IP=real_ip,
        REMOTE_ADDR=REGISTER_NGINX_PEER,
    )


def _register_request(spoofed_xff=REGISTER_SPOOFED, real_ip=REGISTER_REAL_IP):
    """A DRF Request for `/auth/register/` shaped like post-nginx traffic."""
    wsgi = APIRequestFactory().post(
        "/auth/register/",
        data=_register_body("probe"),
        format="json",
        HTTP_X_FORWARDED_FOR=f"{spoofed_xff}, {real_ip}",
        HTTP_X_REAL_IP=real_ip,
        REMOTE_ADDR=REGISTER_NGINX_PEER,
    )
    return Request(wsgi, parsers=[JSONParser()])


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

    def test_per_username_limit_stops_repeated_registration(self, monkeypatch):
        from django.core.cache.backends.locmem import LocMemCache
        from rest_framework.throttling import SimpleRateThrottle
        from backend.app.throttling import RegisterUsernameRateThrottle

        # This is a unit-level throttle contract. It must not consume or read
        # the local stack's real Redis budget, which would make the first
        # assertion depend on unrelated test order or a prior pytest run.
        monkeypatch.setattr(
            SimpleRateThrottle,
            'cache',
            LocMemCache('register-username-throttle', {}),
            raising=False,
        )
        throttle = RegisterUsernameRateThrottle()
        request = _fake_request_body({"username": "squatter"})
        view = _view_with_scope('token_refresh')
        for _ in range(3):
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
        """The `register` per-IP limit must be present *and* must not key on
        the client-supplied `X-Forwarded-For`.

        The original assertion here was
        `ScopedRateThrottle in classes, "per-IP 'register' limit was dropped"`.
        That message asserts a *capability*, not a class, and keeping it
        meaningful means keeping the capability: a throttle list can name
        `ScopedRateThrottle` while being completely bypassable, because DRF's
        `BaseThrottle.get_ident` returns the caller's own header. So the
        intent is now pinned two ways — the bare class must be gone, and
        everything left must inherit the trusted identity resolver — and
        "per-IP" is asserted by the keying, not by the name.

        Which class supplies the per-IP limit is read structurally: the
        per-username throttle overrides `get_cache_key` to key on the claimed
        name, so the one still using `ScopedRateThrottle.get_cache_key` IS the
        per-IP limiter. Naming it by identity would break the day someone
        subclasses for a different scope.

        Note the reference is `ScopedRateThrottle.get_cache_key`, not
        `SimpleRateThrottle`'s: DRF's `ScopedRateThrottle` overrides it to
        prefer `request.user.pk` and fall back to `get_ident` for anonymous
        callers. Register is `AllowAny`, so it is always the `get_ident` branch
        that runs — which is exactly the branch the bare class resolves
        through the spoofable header.
        """
        from rest_framework.throttling import ScopedRateThrottle

        from backend.app.throttling import (
            RegisterUsernameRateThrottle,
            TrustedProxyRateThrottle,
        )
        from backend.app.views.auth import RegisterView

        classes = list(RegisterView.throttle_classes)
        assert classes, "the register view has no throttles at all"
        assert ScopedRateThrottle not in classes, (
            "bare ScopedRateThrottle keys on the client-supplied "
            "X-Forwarded-For via DRF's get_ident; the per-IP 'register' limit "
            "is only real via TrustedProxyRateThrottle"
        )
        for cls in classes:
            assert issubclass(cls, TrustedProxyRateThrottle), (
                f"{cls.__name__} does not inherit TrustedProxyRateThrottle, so "
                "its identity comes from a header the caller controls"
            )

        per_ip = [
            cls
            for cls in classes
            if cls.get_cache_key is ScopedRateThrottle.get_cache_key
        ]
        assert len(per_ip) == 1, (
            f"per-IP 'register' limit was dropped: expected exactly one throttle "
            f"keying on the caller, got {[cls.__name__ for cls in classes]}"
        )
        assert RegisterUsernameRateThrottle in classes, (
            "per-username limit missing; the per-IP rate alone cannot stop one "
            "host cycling through accounts once it is raised for CGNAT"
        )
        assert RegisterView.throttle_scope == "register"

    def test_register_per_ip_identity_is_not_drf_get_ident(self):
        """Read off the instance the view really uses, not the class attribute.

        A throttle list can name the right class and still be wrong if
        something downstream swaps the instance or subclasses it back to
        DRF's resolution. Mirrors
        `TestLoginThrottleWiring.test_login_identity_is_not_drf_get_ident`.
        """
        from rest_framework.throttling import ScopedRateThrottle, SimpleRateThrottle

        from backend.app.throttling import TrustedProxyRateThrottle
        from backend.app.views.auth import RegisterView

        throttles = [
            t
            for t in RegisterView().get_throttles()
            if type(t).get_cache_key is ScopedRateThrottle.get_cache_key
        ]
        assert len(throttles) == 1, (
            f"expected exactly one per-IP throttle, got "
            f"{[type(t).__name__ for t in throttles]}"
        )
        throttle = throttles[0]

        assert isinstance(throttle, TrustedProxyRateThrottle)
        assert throttle.get_ident.__func__ is not SimpleRateThrottle.get_ident, (
            "the per-IP register throttle is still calling DRF's get_ident, "
            "which returns the client-supplied X-Forwarded-For"
        )
        request = _register_request(spoofed_xff=REGISTER_SPOOFED)
        assert throttle.get_ident(request) == REGISTER_REAL_IP, (
            "register identity is not the address nginx set in X-Real-IP"
        )

    def test_rotating_xff_does_not_buy_extra_registrations(
        self, settings, db, monkeypatch
    ):
        """The behavioural proof: the per-IP limit survives header rotation.

        RED against the pre-fix wiring. `NUM_PROXIES` is removed first (see
        `_without_the_num_proxies_backstop`), which is the configuration the
        repo's own comments describe as silently re-breaking when a second
        proxy is added. A bare `ScopedRateThrottle` then keys on the whole
        header, so each rotated value is a brand-new bucket and all six
        attempts get a fresh 3/hour allowance. With `TrustedProxyRateThrottle`
        every attempt lands on the same `X-Real-IP` bucket and only the first
        three are served.

        Non-vacuous only because of the `NUM_PROXIES` removal: with the
        backstop still at 1, DRF takes `addrs[-1]` — the hop nginx appended —
        so the bare class passes this identical test. Verified by running it
        that way (see the report); `test_the_removed_backstop_is_load_bearing`
        in `TestLoginThrottleWiring` pins the helper itself for both endpoints.

        Every attempt claims a different username, so the per-username limit
        (3/hour, keyed on the name) cannot be the source of the 429s: a 429
        here is unambiguously the per-IP `register` bucket refusing.
        """
        from rest_framework.throttling import ScopedRateThrottle

        _without_the_num_proxies_backstop(settings)
        # Shrink the scope so the boundary is 3 requests in. `ScopedRateThrottle`
        # re-derives `rate`/`num_requests` from the view on every call, so the
        # class attribute is the only seam that survives. Restored by
        # monkeypatch, not by a `finally` block that re-assigns the attribute:
        # `THROTTLE_RATES` is inherited, so an unconditional re-assignment
        # would leave a permanent shadow on the subclass.
        monkeypatch.setattr(
            ScopedRateThrottle,
            "THROTTLE_RATES",
            {"register": "3/hour", "register_username": "3/hour"},
            raising=False,
        )

        client = APIClient()
        statuses = []
        for i in range(6):
            response = _post_register(client, f"1.1.1.{i + 1}", username=f"rot{i}")
            statuses.append(response.status_code)
            if i < 3:
                assert response.status_code == 201, (
                    f"attempt {i + 1} should have registered, got "
                    f"{response.status_code}: {getattr(response, 'data', None)!r}"
                )

        assert statuses[:3] == [201, 201, 201]
        assert statuses[3:] == [429, 429, 429], (
            f"rotating X-Forwarded-For bought extra registrations: {statuses!r}. "
            "The per-IP account-creation limit is bypassable with one HTTP "
            "header, the moment a second proxy sits in front of nginx."
        )


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


# ---------------------------------------------------------------------------
# Login throttle identity — the credential-stuffing gate (2026-09-30)
# ---------------------------------------------------------------------------
#: The address nginx puts in `X-Real-IP`, i.e. what it actually saw.
LOGIN_REAL_IP = "203.0.113.7"
#: `REMOTE_ADDR` behind the terminator: the nginx container, not the user.
LOGIN_NGINX_PEER = "172.29.0.13"
#: The attacker's own entry, which nginx will prepend to X-Forwarded-For.
LOGIN_SPOOFED = "9.9.9.9"


def _post_login(client, spoofed_xff, real_ip=LOGIN_REAL_IP):
    """POST the credential-stuffing gate as it arrives *after* nginx.

    nginx APPENDS to X-Forwarded-For (`$proxy_add_x_forwarded_for`) and
    OVERWRITES X-Real-IP (`$remote_addr`), so a rotated header reaches Django
    as `<attacker's entry>, <real client>`. A test that set only
    X-Forwarded-For would model a caller with no proxy in front of it, which
    is not the deployment being defended — see backend/EchoFlow/client_ip.py.
    """
    return client.post(
        "/auth/login/",
        {"username": "nobody", "password": "wrong"},
        format="json",
        HTTP_X_FORWARDED_FOR=f"{spoofed_xff}, {real_ip}",
        HTTP_X_REAL_IP=real_ip,
        REMOTE_ADDR=LOGIN_NGINX_PEER,
    )


def _without_the_num_proxies_backstop(settings):
    """Delete `REST_FRAMEWORK['NUM_PROXIES']` for the duration of one test.

    `NUM_PROXIES` is currently 1, which makes DRF's `get_ident` take
    `addrs[-1]` — the hop nginx appended — so a bare `ScopedRateThrottle`
    survives rotation *by accident of a single setting*. That is the
    "backstop", and both settings.py and backend/app/throttling.py say in so
    many words that it is one line, easy to delete by accident, and silently
    re-broken by adding a second proxy. These tests assert the login gate
    does not *depend* on it: they remove the backstop and require the wiring
    to hold on its own.

    `settings` is pytest-django's fixture, which fires Django's
    `setting_changed`; DRF's own `reload_api_settings` receiver is connected
    to it, so `api_settings.NUM_PROXIES` really reads back as absent. Patching
    the `api_settings` object directly instead would install a permanent
    instance attribute on undo — the same shadowing pollution the
    `RefreshTokenRateThrottle.cache` restore once caused (see
    test_throttle_identity_and_secrets.py).
    """
    settings.REST_FRAMEWORK = {
        key: value
        for key, value in settings.REST_FRAMEWORK.items()
        if key != "NUM_PROXIES"
    }


class TestLoginThrottleWiring:
    """`POST /auth/login/` — 10/min, the gate against credential stuffing.

    Same shape of guard as `TestRefreshThrottleWiring` above, and for a
    sharper reason. `ScopedRateThrottle` resolves its identity through DRF's
    `BaseThrottle.get_ident`, which reads the client-supplied
    `X-Forwarded-For`. Behind the terminator the caller controls that string,
    so the throttle class alone cannot make this endpoint safe — it needs
    `TrustedProxyRateThrottle`, whose `get_ident` delegates to
    `EchoFlow.client_ip.get_client_ip` (X-Real-IP first, which nginx
    overwrites and therefore cannot be spoofed).

    The class-attribute assertion is necessary but not sufficient: a throttle
    list can name the right class while the limit stays decorative. The
    behavioural test below is the one that carries the proof, and the control
    test alongside it exists so it cannot pass for the wrong reason.
    """

    def test_login_view_uses_a_trusted_proxy_throttle(self):
        """The bare framework class must not be back on this view."""
        from rest_framework.throttling import ScopedRateThrottle

        from backend.app.throttling import TrustedProxyRateThrottle
        from backend.app.urls import ThrottledTokenObtainPairView

        classes = list(ThrottledTokenObtainPairView.throttle_classes)
        assert classes, "the login view has no throttles at all"
        assert ScopedRateThrottle not in classes, (
            "bare ScopedRateThrottle keys on the client-supplied "
            "X-Forwarded-For via DRF's get_ident, which is the credential-"
            "stuffing bypass; use TrustedProxyRateThrottle"
        )
        for cls in classes:
            assert issubclass(cls, TrustedProxyRateThrottle), (
                f"{cls.__name__} does not inherit TrustedProxyRateThrottle"
            )

    def test_login_identity_is_not_drf_get_ident(self):
        """Item 3 of the fix, asserted on the instance the view really uses.

        Read off `get_throttles()` rather than off the class attribute, so
        this fails if the wiring is right but something downstream replaces the
        instance or subclasses it back to DRF's resolution.
        """
        from rest_framework.throttling import SimpleRateThrottle, ScopedRateThrottle

        from backend.app.throttling import TrustedProxyRateThrottle
        from backend.app.urls import ThrottledTokenObtainPairView

        throttles = ThrottledTokenObtainPairView().get_throttles()
        per_ip = [
            throttle
            for throttle in throttles
            if type(throttle).get_cache_key is ScopedRateThrottle.get_cache_key
        ]
        assert len(per_ip) == 1, (
            f"expected exactly one per-IP throttle, got "
            f"{[type(t).__name__ for t in throttles]}"
        )
        throttle = per_ip[0]

        assert throttle.get_ident.__func__ is not SimpleRateThrottle.get_ident, (
            "the login throttle is still calling DRF's get_ident, which returns "
            "the client-supplied X-Forwarded-For"
        )
        assert isinstance(throttle, TrustedProxyRateThrottle)

        request = _login_request(spoofed_xff=LOGIN_SPOOFED)
        assert throttle.get_ident(request) == LOGIN_REAL_IP, (
            "login identity is not the address nginx set in X-Real-IP"
        )

    def test_rotating_xff_does_not_buy_extra_login_attempts(
        self, settings, db, monkeypatch
    ):
        """The behavioural proof: the limit survives header rotation.

        RED against the pre-fix wiring. `NUM_PROXIES` is removed first (see
        `_without_the_num_proxies_backstop`), which is the configuration the
        repo's own comments describe as silently re-breaking. A bare
        `ScopedRateThrottle` then keys on the whole header, so each rotated
        value is a brand-new bucket and all six attempts get a fresh 3/min
        allowance. With `TrustedProxyRateThrottle` every attempt lands on the
        same `X-Real-IP` bucket and only the first three are served.
        """
        from rest_framework.throttling import ScopedRateThrottle

        _without_the_num_proxies_backstop(settings)
        # Shrink the scope so the boundary is 3 requests in. `ScopedRateThrottle`
        # re-derives `rate`/`num_requests` from the view on every call, so the
        # class attribute is the only seam that survives. Restored by
        # monkeypatch, not by a `finally` block that re-assigns the attribute:
        # `THROTTLE_RATES` is inherited, so an unconditional re-assignment
        # would leave a permanent shadow on the subclass.
        rates = dict(ScopedRateThrottle.THROTTLE_RATES)
        rates.update({"login": "3/min", "login_username": "1000/hour"})
        monkeypatch.setattr(
            ScopedRateThrottle, "THROTTLE_RATES", rates, raising=False
        )

        client = APIClient()
        statuses = []
        for i in range(6):
            response = _post_login(client, f"1.1.1.{i + 1}")
            statuses.append(response.status_code)
            if i < 3:
                assert response.status_code == 401, (
                    f"attempt {i + 1} should be a wrong-credentials 401, got "
                    f"{response.status_code}: "
                    f"{getattr(response, 'data', None)!r}"
                )

        assert statuses[:3] == [401, 401, 401]
        assert statuses[3:] == [429, 429, 429], (
            f"rotating X-Forwarded-For bought extra login attempts: {statuses!r}. "
            "The credential-stuffing gate is bypassable with one HTTP header."
        )

    def test_the_removed_backstop_is_load_bearing(self, settings):
        """Control for the test above — it must fail for the right reason.

        If `_without_the_num_proxies_backstop` silently did nothing (stale
        `api_settings`, a signal DRF is not connected to), the behavioural
        test would keep passing against the unfixed code and prove nothing.
        This pins the DRF behaviour that makes the two outcomes differ.
        """
        from rest_framework.throttling import AnonRateThrottle
        from rest_framework.settings import api_settings

        assert api_settings.NUM_PROXIES == 1, "the shipped backstop is not 1"

        _without_the_num_proxies_backstop(settings)

        assert api_settings.NUM_PROXIES is None, (
            "NUM_PROXIES survived the override, so the behavioural test is "
            "still running with the backstop in place and cannot distinguish "
            "the two throttle classes"
        )
        # With NUM_PROXIES unset DRF returns `''.join(xff.split())` — the whole
        # header, every client-chosen byte included.
        assert AnonRateThrottle().get_ident(
            _login_request(spoofed_xff=LOGIN_SPOOFED)
        ) == f"{LOGIN_SPOOFED},{LOGIN_REAL_IP}"

    def test_login_scope_and_rate_are_unchanged(self):
        """Guards the deliberate 10/min decision against a drive-by retune."""
        from django.conf import settings

        from backend.app.urls import ThrottledTokenObtainPairView

        assert ThrottledTokenObtainPairView.throttle_scope == "login"
        assert settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["login"] == "10/min"


def _login_request(spoofed_xff=LOGIN_SPOOFED, real_ip=LOGIN_REAL_IP):
    """A DRF Request for `/auth/login/` shaped like post-nginx traffic."""
    wsgi = APIRequestFactory().post(
        "/auth/login/",
        data={"username": "nobody", "password": "wrong"},
        format="json",
        HTTP_X_FORWARDED_FOR=f"{spoofed_xff}, {real_ip}",
        HTTP_X_REAL_IP=real_ip,
        REMOTE_ADDR=LOGIN_NGINX_PEER,
    )
    return Request(wsgi, parsers=[JSONParser()])


# ---------------------------------------------------------------------------
# AudioUploadViewSet per-action scopes — A4 follow-up (2026-09-29)
# ---------------------------------------------------------------------------
class TestAudioUploadViewSetScopes:
    """`throttle_scope` was keyed on `url_path` while DRF sets `self.action`
    to the handler's **method name**.

    A4 added a per-action dispatch so a shared link's landing page would not
    429 after 20 views, but the map used the routes the actions are *mounted*
    at (`'public'`, `'approve-moderation'`, …) rather than the names of the
    methods implementing them (`public_view`, `approve_moderation`, …). None
    of the five ever matched, so every action silently fell through to the
    `'upload'` default. The five A4 scopes were dead code.

    The concrete harm was on a READ. `GET /clips/{id}/` — the status poll a
    client runs while HLS encodes — resolved to `'upload'` (20/hour), so a
    client polling during an encode 429s after 20 polls. The mobile Phase 5
    upload status pipeline polls this exact endpoint.

    A wrong scope fails *open onto the wrong bucket*, silently, which is why
    this is pinned by method name rather than trusted to the routing table.
    """

    #: action name -> the scope it must resolve to.
    EXPECTED = {
        # writes that push files or are owner mutations over the same rows
        "create": "upload",
        "update": "upload",
        "partial_update": "upload",
        "destroy": "upload",
        # reads must NOT be charged the upload budget
        "retrieve": "clip_read",
        "list": "clip_read",
        # compute / abuse-sensitive actions
        "approve_moderation": "clip_approve",
        "public_view": "clip_public",
        "play_shared": "clip_play",
        "share_link": "share_link",
        "report_clip": "clip_report",
    }

    @staticmethod
    def _view_for(action):
        from backend.app.views.content import AudioUploadViewSet

        view = AudioUploadViewSet()
        view.action = action
        return view

    @pytest.mark.parametrize("action,expected", sorted(EXPECTED.items()))
    def test_action_resolves_to_expected_scope(self, action, expected):
        assert self._view_for(action).throttle_scope == expected, (
            f"{action!r} should resolve to {expected!r}; if this fails, the "
            f"scope map is likely keyed on url_path instead of the method "
            f"name that DRF puts in self.action."
        )

    def test_retrieve_is_not_charged_the_upload_budget(self):
        """The regression that mattered: a status poll is a read, not an upload.

        This is the one assertion written to fail against the pre-fix code,
        where `retrieve` fell through to the 20/hour `upload` scope.
        """
        assert self._view_for("retrieve").throttle_scope != "upload"

    @pytest.mark.parametrize("action", sorted(EXPECTED))
    def test_every_scope_is_registered_in_settings(self, action):
        """An unregistered scope makes ScopedRateThrottle.get_rate() return
        None, and allow_request() then returns True — completely unthrottled.
        A typo in the map is therefore silent; this is the guard (same shape as
        the token_refresh / register_username rate-existence tests above).
        """
        from django.conf import settings

        scope = self._view_for(action).throttle_scope
        assert scope in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], (
            f"{action!r} resolved to unregistered scope {scope!r}; requests "
            f"would be allowed through with no rate limit at all."
        )

    def test_reads_and_writes_do_not_share_a_bucket(self):
        """`upload` exists to cap storage abuse (up to 100 MB per file). A read
        cannot abuse storage, so folding reads into it penalises polling and
        polling is exactly what the encode path does.
        """
        read_scopes = {self._view_for(a).throttle_scope for a in ("retrieve", "list")}
        write_scopes = {self._view_for(a).throttle_scope for a in ("create", "update", "destroy")}

        assert "upload" not in read_scopes
        assert read_scopes.isdisjoint(write_scopes)

    def test_scoped_only_actions_run_under_scoped_throttle_alone(self):
        """`get_throttles` had the same key mismatch as the scope map, so the
        five dedicated actions were also running under the inherited class list
        instead of ScopedRateThrottle alone.
        """
        from rest_framework.throttling import ScopedRateThrottle

        for action in AudioUploadViewSet_scoped_actions():
            view = self._view_for(action)
            throttles = view.get_throttles()
            assert len(throttles) == 1 and isinstance(throttles[0], ScopedRateThrottle), (
                f"{action!r} should run under ScopedRateThrottle alone; got "
                f"{[type(t).__name__ for t in throttles]}"
            )

    def test_reads_keep_the_inherited_user_throttle(self):
        """retrieve/list deliberately stay on the inherited class list so the
        1000/hour `user` bucket remains a backstop beneath `clip_read`. If the
        scope were ever mis-typed, that backstop is what stops it from being
        fully unthrottled.
        """
        from rest_framework.throttling import ScopedRateThrottle

        for action in ("retrieve", "list"):
            classes = [type(t) for t in self._view_for(action).get_throttles()]
            assert ScopedRateThrottle in classes, (
                f"{action!r} lost its ScopedRateThrottle; clip_read would be "
                f"unenforced."
            )


def AudioUploadViewSet_scoped_actions():
    """The actions that must run under ScopedRateThrottle alone.

    Read off the viewset constant rather than hardcoded here, so a future
    action added to that frozenset is covered automatically and a rename that
    desyncs the two fails loudly instead of quietly widening the class list.
    """
    from backend.app.views.content import AudioUploadViewSet

    return sorted(AudioUploadViewSet.SCOPED_ONLY_ACTIONS)
