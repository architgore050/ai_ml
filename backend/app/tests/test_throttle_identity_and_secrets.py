"""Throttle *identity* and placeholder-secret guard.

Two defects, one file, because they share a root cause: **the process was
trusting a value the caller chose.**

DEFECT 1 — every IP-keyed rate limit is rotatable with one HTTP header.
`NUM_PROXIES` is unset, so DRF's `BaseThrottle.get_ident` falls through to::

    return ''.join(xff.split()) if xff else remote_addr

— the *entire* client-supplied `X-Forwarded-For` header, verbatim, as the
throttle identity. nginx appends rather than overwrites
(`$proxy_add_x_forwarded_for`), so a client sending `X-Forwarded-For: 9.9.9.9`
arrives as `9.9.9.9,<real-ip>` and every distinct header value is a distinct,
never-before-seen bucket. That defeats `login` (10/min, the credential-
stuffing gate), `anon` (100/hour), `register` (200/hour), `clip_public`
(120/min) and the IP fallbacks inside the two custom throttles.

Note the asymmetry this closes: `EchoFlow/client_ip.py` already resolves the
caller correctly for *audit* records — `X-Real-IP` first, because nginx
**overwrites** it from `$remote_addr` so it cannot be spoofed through the
terminator. DPDP evidence was attributed to the user while the limits
protecting those same endpoints were keyed on a string the attacker picked.

DEFECT 2 — `is_placeholder_secret()` is a good guard with exactly one call
site. `DJANGO_SECRET_KEY` (which signs sessions, CSRF and password-reset
tokens) and both Redis passwords are read with no such check, and every
tracked `.env*.example` ships a placeholder for them.

A note on the two escape hatches under test, because both are load-bearing
and both are easy to mistake for the guard being weak:

  * `ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS=1` — explicit operator opt-out.
  * `DJANGO_DEBUG=true` — the process has already declared itself
    non-production (Django's own security posture says debug output must
    never be exposed; AGENTS.md says `DJANGO_DEBUG` must be `False` in
    anything behind the terminator).

Both bypasses emit a `logging.WARNING`. Neither is silent. See
`backend/EchoFlow/secrets.py` for why a stricter rule could not be adopted
without breaking the repository's own test harness and dev stack, which
`conftest.py` and `.env.local` pin to a placeholder — neither of which this
change is allowed to edit.

CRITICAL — never patch a module-level name the code does not read. This repo
has been bitten by that: `patch.object(tasks, 'cache')` succeeded while doing
nothing because the function built its own client internally, so every
assertion under the `with` block was vacuous. Every patch below is against a
name that appears **in the body of the code under test**, and the two that
matter assert the patch was actually exercised.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from django.core.cache.backends.locmem import LocMemCache
from django.core.exceptions import ImproperlyConfigured
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework.throttling import SimpleRateThrottle

REPO_ROOT = Path(__file__).resolve().parents[3]

# A documentation address (RFC 5737) and the nginx loopback the client would
# actually see. Kept distinct so an assertion can prove which one was used.
REAL_CLIENT_IP = "203.0.113.7"
ATTACKER_IP = "9.9.9.9"


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------
class _RecordingCache:
    """Private in-process cache that remembers every key it was asked for.

    Two reasons this exists rather than a bare `LocMemCache`:

    1. `SimpleRateThrottle.cache` is a *class attribute* on the DRF base, so
       replacing it isolates every subclass at once and keeps the assertions
       off the shared Redis the four running Celery workers also use (which is
       what made the existing throttle tests slow and intermittently flaky).
    2. Test 2 needs to assert on the **key**, not on a status code. A status
       code proves *that* throttling happened; only the key proves *what* it
       was keyed on, and the key is the entire defect.
    """

    def __init__(self):
        self._inner = LocMemCache("throttle-identity-tests", {})
        self.keys = []

    def get(self, key, default=None):
        self.keys.append(key)
        return self._inner.get(key, default)

    def set(self, key, value, timeout=None, **kwargs):
        self.keys.append(key)
        return self._inner.set(key, value, timeout)

    def delete(self, key):
        return self._inner.delete(key)

    def clear(self):
        self._inner.clear()
        self.keys.clear()


class _ExplodingCache:
    """Cache whose reads raise, standing in for a degraded Redis.

    `django_redis` wraps every client error into `ConnectionInterrupted`
    (`django_redis/client/default.py` re-raises it around every command), so
    this is the exact exception a stale connection pool produces. `get_calls`
    exists so the test can assert the patch was load-bearing.
    """

    def __init__(self, exc_factory):
        self._exc_factory = exc_factory
        self.get_calls = 0

    def get(self, key, default=None):
        self.get_calls += 1
        raise self._exc_factory()

    def set(self, key, value, timeout=None, **kwargs):
        raise self._exc_factory()


@pytest.fixture
def throttle_cache(monkeypatch):
    """Isolate every DRF throttle onto a private, key-recording cache."""
    cache = _RecordingCache()
    monkeypatch.setattr(SimpleRateThrottle, "cache", cache, raising=False)
    yield cache
    cache.clear()


@pytest.fixture
def login_rate(monkeypatch):
    """Shrink the `login` scope so the boundary is reachable in 4 requests.

    `ScopedRateThrottle.__init__` is a no-op and `allow_request` re-derives
    `rate`/`num_requests` from the view on every call, so the class attribute
    `THROTTLE_RATES` is the only seam that survives — assigning `throttle.rate`
    would be silently discarded and the loop count would not match the rate.
    """
    from rest_framework.throttling import ScopedRateThrottle

    rates = dict(ScopedRateThrottle.THROTTLE_RATES)
    rates.update({"login": "3/min", "login_username": "1000/hour"})
    monkeypatch.setattr(
        ScopedRateThrottle,
        "THROTTLE_RATES",
        rates,
        raising=False,
    )


def _post_login(client, spoofed_xff, real_ip=REAL_CLIENT_IP):
    """POST the credential-stuffing gate with a rotated XFF.

    The headers are set to what the request looks like **after** nginx:
    `X-Forwarded-For` carries the attacker's chosen entry first and the
    address nginx saw last (`$proxy_add_x_forwarded_for`), and `X-Real-IP` is
    nginx's overwrite of the same value. A test that sets only
    `X-Forwarded-For` would not reproduce the bug — it would just be a client
    that is already behind no proxy at all.
    """
    return client.post(
        "/auth/login/",
        {"username": "nobody", "password": "wrong"},
        format="json",
        HTTP_X_FORWARDED_FOR=f"{spoofed_xff}, {real_ip}",
        HTTP_X_REAL_IP=real_ip,
        REMOTE_ADDR="172.29.0.13",
    )


def _drf_request(path="/auth/login/", **meta):
    raw = APIRequestFactory().get(path, **meta)
    return Request(raw, parsers=[JSONParser()])


# --------------------------------------------------------------------------
# DEFECT 1a — rotating X-Forwarded-For must not mint a fresh bucket
# --------------------------------------------------------------------------
class TestRotatingXForwardedForDoesNotBypassTheLimit:
    def test_rotating_the_forwarded_header_still_hits_the_same_bucket(
        self, db, throttle_cache, login_rate
    ):
        """The credential-stuffing gate must survive a rotated XFF.

        RED before the fix: `NUM_PROXIES` unset makes `get_ident` return the
        whole header, so requests 1-3 fill the bucket for
        `throttle_login_9.9.9.9,203.0.113.7`, request 4 lands in the brand-new
        bucket `throttle_login_8.8.8.8,203.0.113.7` and returns 401 instead of
        429. The assertion below is what catches it.
        """
        client = APIClient()

        for i in range(3):
            spoofed = f"1.1.1.{i + 1}"
            response = _post_login(client, spoofed)
            assert response.status_code == 401, (
                f"request {i + 1} should be a wrong-credentials 401, got "
                f"{response.status_code}: {getattr(response, 'data', None)!r}"
            )

        # Fourth request, a *different* spoofed address, same real caller.
        response = _post_login(client, "8.8.8.8")
        assert response.status_code == 429, (
            "rotating X-Forwarded-For produced a fresh throttle bucket — the "
            f"limit was bypassed. Got {response.status_code}. Keys written: "
            f"{throttle_cache.keys!r}"
        )

    def test_the_key_is_derived_from_x_real_ip_and_not_the_forwarded_header(
        self, db, throttle_cache, login_rate
    ):
        """The key is the defect. Assert on it, not only on the status code."""
        client = APIClient()
        _post_login(client, ATTACKER_IP)

        assert throttle_cache.keys, (
            "no throttle key was written — the throttle never ran, so this "
            "test would pass vacuously"
        )
        # Login also has a username-keyed companion throttle. This assertion
        # is specifically about the IP-keyed `login` bucket, whose identity
        # must come from nginx's X-Real-IP rather than client-supplied XFF.
        login_keys = [
            key for key in throttle_cache.keys
            if key.startswith("throttle_login_")
            and not key.startswith("throttle_login_username_")
        ]
        assert login_keys, f"no per-IP `login` key among {throttle_cache.keys!r}"

        for key in login_keys:
            assert REAL_CLIENT_IP in key, (
                f"{key!r} is not keyed on the address nginx set in X-Real-IP"
            )
            assert ATTACKER_IP not in key, (
                f"{key!r} contains the client-chosen X-Forwarded-For entry — "
                "the caller is choosing their own bucket"
            )

    def test_two_caller_addresses_do_not_share_one_bucket(
        self, db, throttle_cache, login_rate
    ):
        """Counterpart: the fix must not collapse everyone into one bucket.

        A `get_ident` that always returned a constant would pass the rotation
        test above. This is what keeps the limit *per caller*.
        """
        client = APIClient()
        for _ in range(3):
            _post_login(client, ATTACKER_IP, real_ip=REAL_CLIENT_IP)

        other = APIClient()
        response = _post_login(other, ATTACKER_IP, real_ip="198.51.100.42")
        assert response.status_code == 401, (
            "a second, unrelated caller was throttled by the first caller's "
            f"budget (got {response.status_code}) — identities are collapsing"
        )


# --------------------------------------------------------------------------
# DEFECT 1b — TrustedProxyRateThrottle resolves like the audit trail does
# --------------------------------------------------------------------------
class TestTrustedProxyIdent:
    def test_ident_is_the_x_real_ip_value(self):
        from backend.app.throttling import TrustedProxyRateThrottle

        request = _drf_request(
            HTTP_X_REAL_IP=REAL_CLIENT_IP,
            HTTP_X_FORWARDED_FOR=f"{ATTACKER_IP}, {REAL_CLIENT_IP}",
            REMOTE_ADDR="172.29.0.13",
        )
        assert TrustedProxyRateThrottle().get_ident(request) == REAL_CLIENT_IP

    @pytest.mark.parametrize(
        "real_ip",
        ["", "   ", "not-an-ip", "999.999.999.999", "1.2.3.4; DROP TABLE"],
    )
    def test_malformed_x_real_ip_falls_back_to_the_trusted_peer(
        self, real_ip
    ):
        """A hostile/garbage `X-Real-IP` must not become the identity.

        Behind the terminator `REMOTE_ADDR` is the nginx container, which is
        the correct fail-safe: it over-throttles one nginx instead of
        under-throttling one attacker. The attacker's XFF entry is never
        reachable while a peer address exists.
        """
        from backend.app.throttling import TrustedProxyRateThrottle

        request = _drf_request(
            HTTP_X_REAL_IP=real_ip,
            HTTP_X_FORWARDED_FOR=ATTACKER_IP,
            REMOTE_ADDR="172.29.0.13",
        )
        ident = TrustedProxyRateThrottle().get_ident(request)
        assert ident == "172.29.0.13", (
            f"ident was {ident!r} — the attacker chose it via X-Forwarded-For"
        )

    def test_absent_x_real_ip_and_peer_falls_back_to_the_last_xff_hop(self):
        """No trusted source at all: the last hop, not the first.

        Documented `get_client_ip` behaviour, pinned because it is the one
        branch where a client-influenced value can win, and pinning it means a
        future refactor has to argue with this test.

        `REMOTE_ADDR=""` is explicit because the Django test client injects
        `127.0.0.1` by default, which would win the precedence order and make
        this test pass for the wrong reason.
        """
        from backend.app.throttling import TrustedProxyRateThrottle

        request = _drf_request(
            HTTP_X_REAL_IP="",
            REMOTE_ADDR="",
            HTTP_X_FORWARDED_FOR=f"{ATTACKER_IP}, 10.0.0.5",
        )
        assert request.META.get("REMOTE_ADDR") == "", "test harness leaked a peer"
        assert TrustedProxyRateThrottle().get_ident(request) == "10.0.0.5"

    def test_unresolvable_request_yields_an_empty_ident_not_a_crash(self):
        from backend.app.throttling import TrustedProxyRateThrottle

        request = _drf_request(
            HTTP_X_REAL_IP="", REMOTE_ADDR="", HTTP_X_FORWARDED_FOR="garbage"
        )
        assert TrustedProxyRateThrottle().get_ident(request) == ""

    def test_the_custom_throttles_inherit_the_trusted_resolution(self):
        """Both custom throttles must resolve identity the same way.

        A subclass that quietly overrode `get_ident` back to DRF's would
        reintroduce the defect for exactly the two endpoints that have the
        most careful comments in the repo.
        """
        from backend.app.throttling import (
            RefreshTokenRateThrottle,
            RegisterUsernameRateThrottle,
            TrustedProxyRateThrottle,
        )

        for cls in (RefreshTokenRateThrottle, RegisterUsernameRateThrottle):
            assert issubclass(cls, TrustedProxyRateThrottle), (
                f"{cls.__name__} does not inherit TrustedProxyRateThrottle"
            )
            assert cls.get_ident is TrustedProxyRateThrottle.get_ident, (
                f"{cls.__name__} overrides get_ident and would reintroduce "
                "DRF's spoofable resolution"
            )


# --------------------------------------------------------------------------
# DEFECT 1a — NUM_PROXIES, verified against the installed DRF source
# --------------------------------------------------------------------------
class TestNumProxiesIsSet:
    def test_num_proxies_is_configured(self):
        from rest_framework.settings import api_settings

        assert api_settings.NUM_PROXIES == 1, (
            f"NUM_PROXIES is {api_settings.NUM_PROXIES!r}. With None, DRF "
            "returns the whole X-Forwarded-For header as the throttle "
            "identity and every rate limit is rotatable."
        )

    def test_drf_get_ident_takes_the_last_hop_branch(self):
        """Which branch does `num_proxies == 1` actually take?

        Read out of the *installed* DRF rather than asserted from memory, and
        then executed — the branch is::

            addrs = xff.split(',')
            client_addr = addrs[-min(num_proxies, len(addrs))]

        With `num_proxies == 1`, `min(1, len(addrs))` is 1 whenever the chain
        is non-empty, so the index is `-1`: the LAST hop. That is the entry
        nginx appended from `$remote_addr`, which is the only trustworthy one
        because the earlier entries are whatever the client sent.
        """
        import inspect

        from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle as T
        from rest_framework.settings import api_settings

        source = inspect.getsource(T.get_ident)
        assert "num_proxies" in source, (
            "DRF's get_ident no longer reads NUM_PROXIES — this whole file's "
            f"reasoning about which branch is taken needs re-derivation.\n"
            f"{source}"
        )
        assert api_settings.NUM_PROXIES == 1

        # `SimpleRateThrottle()` refuses to construct without a `rate` or
        # `scope`, and `get_ident` needs neither. `AnonRateThrottle` supplies
        # a rate and inherits the same `get_ident`, so it is the cheapest
        # concrete instance to call the method on.
        throttle = AnonRateThrottle()
        assert throttle.get_ident.__func__ is T.get_ident, (
            "the throttle under test is not calling DRF's NUM_PROXIES branch"
        )
        two_hop = _drf_request(
            HTTP_X_FORWARDED_FOR=f"{ATTACKER_IP}, {REAL_CLIENT_IP}",
            REMOTE_ADDR="172.29.0.13",
        )
        assert throttle.get_ident(two_hop) == REAL_CLIENT_IP, (
            "NUM_PROXIES=1 did not select the last XFF hop"
        )

        # Single-entry chain: `min(1, 1) == 1`, so still the last (only) hop.
        one_hop = _drf_request(
            HTTP_X_FORWARDED_FOR=REAL_CLIENT_IP, REMOTE_ADDR="172.29.0.13"
        )
        assert throttle.get_ident(one_hop) == REAL_CLIENT_IP

        # No XFF at all: REMOTE_ADDR, unvalidated but not client-chosen here.
        none_at_all = _drf_request(REMOTE_ADDR="172.29.0.13")
        assert throttle.get_ident(none_at_all) == "172.29.0.13"


# --------------------------------------------------------------------------
# DEFECT 1c — a degraded throttle cache must be 503, not 500
# --------------------------------------------------------------------------
class TestThrottleCacheFailureIs503:
    def test_login_returns_503_when_the_throttle_cache_read_raises(
        self, db, monkeypatch
    ):
        """`POST /auth/login/` on a dead Redis must be 503, not 500.

        `ConnectionInterrupted` subclasses bare `Exception`, not
        `APIException`, so DRF's default `exception_handler` returns `None`,
        the exception is re-raised, and the client gets a 500 — a full
        traceback page whenever `DJANGO_DEBUG=True`. 503 is honest and
        retryable; 500 invites the client to give up.

        The patch target is the name the code actually reads:
        `SimpleRateThrottle.allow_request` does `self.cache.get(self.key,
        [])`, and `cache` is a class attribute on `SimpleRateThrottle`, which
        every subclass here inherits without shadowing. `get_calls` proves the
        patch was load-bearing rather than vacuous.
        """
        from django_redis.exceptions import ConnectionInterrupted

        exploding = _ExplodingCache(lambda: ConnectionInterrupted(None))
        monkeypatch.setattr(SimpleRateThrottle, "cache", exploding,
                            raising=False)

        client = APIClient()
        response = client.post(
            "/auth/login/",
            {"username": "nobody", "password": "wrong"},
            format="json",
            HTTP_X_REAL_IP=REAL_CLIENT_IP,
        )

        assert exploding.get_calls > 0, (
            "the patched cache was never read — the throttle did not run, so "
            "this test would be vacuous"
        )
        assert response.status_code == 503, (
            f"expected 503, got {response.status_code}: "
            f"{getattr(response, 'data', None)!r}"
        )

    def test_our_own_throttle_raises_503_without_a_view(self, monkeypatch):
        """The `allow_request` override, exercised without going through DRF.

        This is the half that does not depend on the global exception handler
        being installed, so it still holds for the two custom throttles if
        someone removes `EXCEPTION_HANDLER` from settings.
        """
        from django_redis.exceptions import ConnectionInterrupted
        from rest_framework.exceptions import APIException

        from backend.app.throttling import RefreshTokenRateThrottle

        throttle = RefreshTokenRateThrottle()
        # Patch the seam the body of allow_request reads: `self.cache`.
        #
        # Via monkeypatch, and deliberately NOT `original = cls.cache` followed
        # by `cls.cache = original` in a finally. `cache` is *inherited* from
        # SimpleRateThrottle, so the read returns the parent's attribute while
        # the write installs a new one on RefreshTokenRateThrottle itself.
        # The restore then leaves a permanent class attribute shadowing the
        # parent — after which the `throttle_cache` fixture, which patches
        # SimpleRateThrottle, no longer applies to this class at all.
        #
        # The visible symptom was a test that passed alone and failed in-file
        # with "0 of 4 requests allowed": the throttle had been reading and
        # writing the REAL django-redis cache on the live dev stack, so the
        # 2/hour budget was already spent by the previous run. Silent
        # pollution of shared infrastructure, from a cleanup block.
        exploding = _ExplodingCache(lambda: ConnectionInterrupted(None))
        monkeypatch.setattr(
            RefreshTokenRateThrottle, "cache", exploding, raising=False
        )
        view = type("V", (), {"throttle_scope": "token_refresh"})()
        request = _drf_request(HTTP_X_REAL_IP=REAL_CLIENT_IP)
        request._full_data = {}
        with pytest.raises(APIException) as exc:
            throttle.allow_request(request, view)

        assert exploding.get_calls > 0, "patch was not load-bearing"
        assert exc.value.status_code == 503, (
            f"status_code was {exc.value.status_code}, expected 503"
        )
        assert exc.value.status_code != 429, (
            "a broken cache must not be reported as 'you are being "
            "throttled' — the caller did nothing wrong and 429 is not "
            "retryable"
        )

    def test_no_throttle_shadows_the_inherited_cache(self):
        """Guard for the pollution described above.

        `SimpleRateThrottle.cache` is where DRF binds the throttle's cache (at
        import time, as a class attribute). Every test that isolates throttles
        patches *that*. If any class ever grows its own `cache` attribute, those
        fixtures stop applying to it — silently, because the patch still
        succeeds — and the throttle quietly reads and writes the live dev Redis
        instead. That is how a rate-limit test ends up spending a real
        budget on shared infrastructure and failing only on the second run.
        """
        from rest_framework.throttling import SimpleRateThrottle

        from backend.app import throttling as throttling_mod

        subclasses = [
            obj
            for name, obj in vars(throttling_mod).items()
            if isinstance(obj, type)
            and issubclass(obj, SimpleRateThrottle)
        ]
        assert subclasses, "found no throttle classes to check"
        for cls in subclasses:
            assert "cache" not in vars(cls), (
                f"{cls.__name__} defines its own `cache`, shadowing "
                f"{SimpleRateThrottle.__name__}.cache — test isolation patches "
                "the parent and will no longer reach it"
            )

    def test_an_ordinary_drf_error_still_maps_to_its_own_status(self):
        """The new exception handler must be transparent for everything else.

        A custom `EXCEPTION_HANDLER` replaces DRF's for *every* exception, so
        this pins that it delegates rather than swallows.
        """
        from rest_framework.exceptions import NotFound
        from rest_framework.views import exception_handler as drf_handler

        from backend.EchoFlow.exception_handlers import (
            cache_unavailable_handler,
        )

        exc = NotFound()
        assert cache_unavailable_handler(exc, {}).status_code == 404
        # A non-DRF exception must still return None, so Django re-raises it
        # exactly as before.
        assert cache_unavailable_handler(ValueError("boom"), {}) is None
        # And DRF's own handler is the fallback, byte for byte.
        assert cache_unavailable_handler(exc, {}) is not drf_handler(exc, {})


# --------------------------------------------------------------------------
# DEFECT 1 regression guard — refresh must stay keyed on the token subject
# --------------------------------------------------------------------------
class TestRefreshKeyingNotRegressed:
    """`RefreshTokenRateThrottle` keys on the verified token subject.

    Load-bearing: access tokens live 15 minutes, so a carrier NAT gateway
    behind one public address needs ~4 refreshes/hour *per subscriber*. The
    inherited `anon` 100/hour/IP logged out entire cells. Changing the
    identity layer must not move it back onto the address.
    """

    def test_two_users_behind_one_address_get_independent_budgets(
        self, db, throttle_cache, django_user_model
    ):
        from rest_framework_simplejwt.tokens import RefreshToken

        from backend.app.throttling import RefreshTokenRateThrottle

        original = RefreshTokenRateThrottle.THROTTLE_RATES
        RefreshTokenRateThrottle.THROTTLE_RATES = {"token_refresh": "2/hour"}
        try:
            user_a = django_user_model.objects.create_user(
                username="nat_a", password="pw-probe-123"
            )
            user_b = django_user_model.objects.create_user(
                username="nat_b", password="pw-probe-123"
            )
            view = type("V", (), {"throttle_scope": "token_refresh"})()
            meta = {
                "HTTP_X_REAL_IP": "203.0.113.99",
                "HTTP_X_FORWARDED_FOR": f"{ATTACKER_IP}, 203.0.113.99",
                "REMOTE_ADDR": "172.29.0.13",
            }

            def attempt(user):
                request = _drf_request(**meta)
                request._full_data = {"refresh": str(RefreshToken.for_user(user))}
                return RefreshTokenRateThrottle().allow_request(request, view)

            # user_a exhausts their own 2/hour budget...
            assert attempt(user_a) is True
            assert attempt(user_a) is True
            assert attempt(user_a) is False
            # ...and that must say nothing about user_b, who is behind the very
            # same NAT address. Under IP keying this line fails, and every
            # subscriber on the cell is logged out together.
            assert attempt(user_b) is True, (
                "a legitimate second subscriber on the same carrier NAT was "
                "throttled — the per-subject keying has regressed to the "
                "address"
            )
        finally:
            RefreshTokenRateThrottle.THROTTLE_RATES = original

    def test_an_unusable_token_falls_back_to_the_x_real_ip_key(
        self, throttle_cache
    ):
        from backend.app.throttling import RefreshTokenRateThrottle

        throttle = RefreshTokenRateThrottle()
        view = type("V", (), {"throttle_scope": "token_refresh"})()
        request = _drf_request(
            HTTP_X_REAL_IP=REAL_CLIENT_IP,
            HTTP_X_FORWARDED_FOR=f"{ATTACKER_IP}, {REAL_CLIENT_IP}",
            REMOTE_ADDR="172.29.0.13",
        )
        request._full_data = {"refresh": "not.a.token"}

        key = throttle.get_cache_key(request, view)
        assert REAL_CLIENT_IP in key, f"{key!r} is not keyed on X-Real-IP"
        assert ATTACKER_IP not in key, (
            f"{key!r} contains the client-chosen XFF entry"
        )

    def test_rotating_xff_does_not_multiply_the_ip_fallback_budget(
        self, throttle_cache
    ):
        """The fallback path is the one an attacker actually reaches.

        Without a valid token the caller lands on the IP bucket, so that
        bucket must be un-rotatable — otherwise the "verified subject" story
        is fine for honest users and useless against a flood.
        """
        from backend.app.throttling import RefreshTokenRateThrottle

        original = RefreshTokenRateThrottle.THROTTLE_RATES
        RefreshTokenRateThrottle.THROTTLE_RATES = {"token_refresh": "2/hour"}
        try:
            view = type("V", (), {"throttle_scope": "token_refresh"})()
            allowed = 0
            for i in range(4):
                spoofed = f"5.5.5.{i + 1}"
                request = _drf_request(
                    HTTP_X_REAL_IP=REAL_CLIENT_IP,
                    HTTP_X_FORWARDED_FOR=f"{spoofed}, {REAL_CLIENT_IP}",
                    REMOTE_ADDR="172.29.0.13",
                )
                request._full_data = {"refresh": "not.a.token"}
                if RefreshTokenRateThrottle().allow_request(request, view):
                    allowed += 1
            assert allowed == 2, (
                f"{allowed} of 4 rotating-XFF requests were allowed; the rate "
                "is 2/hour, so the header rotation bypassed it"
            )
        finally:
            RefreshTokenRateThrottle.THROTTLE_RATES = original


# --------------------------------------------------------------------------
# DEFECT 2 — placeholder secrets
# --------------------------------------------------------------------------
class TestPlaceholderSecretGuard:
    @pytest.mark.parametrize(
        "value",
        [
            "",
            "   ",
            "\t\n ",
            "change-me-to-a-long-random-string",
            "change-me-strong-password",
            "<same-as-vps>",
            "<generate-me>",
            "your-secret-here",
            "TODO",
        ],
    )
    def test_placeholders_are_rejected(self, value):
        from backend.EchoFlow.secrets import is_placeholder_secret

        assert is_placeholder_secret(value) is True

    @pytest.mark.parametrize(
        "value",
        [
            "x2P5IuWsPOPqZhTzYHEVvvLm1IOqVARnYrcJzRRPcx0",
            "4b7c1e9a2f6d83015ea4cb7d902f1e6a",
            "aB3-xY9_zQ",
            "p/w+=",
        ],
    )
    def test_real_secrets_pass(self, value):
        """Guards against a guard so aggressive it breaks every environment.

        `p/w+=" is not decoration: it is the *shape* of the base64 Redis
        passwords in this repo, and a rule that rejected it would have
        hard-failed the running local stack.
        """
        from backend.EchoFlow.secrets import is_placeholder_secret

        assert is_placeholder_secret(value) is False

    def test_the_hls_service_still_exposes_the_guard(self):
        """`hls_token.is_placeholder_secret` is imported by existing tests.

        `test_hls_token.py` calls it from that module path, so the name must
        survive the move rather than being quietly deleted.
        """
        from backend.app.services import hls_token
        from backend.EchoFlow import secrets

        assert hls_token.is_placeholder_secret is secrets.is_placeholder_secret
        assert hls_token.is_placeholder_secret("change-me") is True

    def test_require_real_secret_raises_with_an_actionable_message(self, monkeypatch):
        from backend.EchoFlow import secrets as secrets_mod

        # conftest.py sets ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS=1 for the suite,
        # and that bypass is checked before anything else, so without clearing
        # it this test asserts nothing — the call returns instead of raising.
        # The guard must be exercised with no bypass in effect.
        monkeypatch.delenv(secrets_mod.BYPASS_ENV_VAR, raising=False)
        monkeypatch.delenv(secrets_mod.DEBUG_ENV_VAR, raising=False)
        monkeypatch.delenv(secrets_mod.TESTING_ENV_VAR, raising=False)

        from backend.EchoFlow.secrets import require_real_secret

        with pytest.raises(ImproperlyConfigured) as exc:
            require_real_secret(
                "DJANGO_SECRET_KEY",
                "change-me-to-a-long-random-string",
                purpose="signing sessions, CSRF tokens and password resets",
                generate="python -c \"import secrets; "
                         "print(secrets.token_urlsafe(64))\"",
                allow_in_debug=False,
            )
        message = str(exc.value)
        assert "DJANGO_SECRET_KEY" in message
        assert "token_urlsafe" in message, (
            "the error must tell the operator how to fix it, not just that "
            "it is wrong"
        )

    def test_the_escape_hatch_needs_an_explicit_value(self, monkeypatch):
        """`=1` only. A typo, or a bare presence check, must not disable it."""
        from backend.EchoFlow.secrets import (
            BYPASS_ENV_VAR,
            guard_is_bypassed,
        )

        for junk in ("", "0", "true", "yes", "True", "I_UNDERSTAND"):
            monkeypatch.setenv(BYPASS_ENV_VAR, junk)
            assert guard_is_bypassed() is False, (
                f"{BYPASS_ENV_VAR}={junk!r} disabled the guard; it must be "
                "exactly '1'"
            )
        monkeypatch.setenv(BYPASS_ENV_VAR, "1")
        assert guard_is_bypassed() is True

    def test_bypassing_still_warns(self, monkeypatch, caplog):
        """A bypass must never be silent."""
        from backend.EchoFlow.secrets import BYPASS_ENV_VAR, require_real_secret

        monkeypatch.setenv(BYPASS_ENV_VAR, "1")
        with caplog.at_level("WARNING"):
            require_real_secret(
                "DJANGO_SECRET_KEY", "change-me", purpose="x", generate="y",
                allow_in_debug=False,
            )
        assert any(
            "DJANGO_SECRET_KEY" in r.getMessage() for r in caplog.records
        ), f"no warning recorded; records were {caplog.records!r}"


class TestShippedExampleSecretsAreRejected:
    """Read the literal values out of the tracked templates.

    Same shape as `test_hls_token.py::...shipped_example_placeholder`, and for
    the same reason: a test that hardcodes the placeholder string stops
    guarding the moment someone edits the example. Reading the file means
    *changing an example to a new placeholder fails the suite*.
    """

    EXAMPLE_FILES = (".env.example", ".env.vps.example", ".env.laptop.example")
    KEYS = (
        "DJANGO_SECRET_KEY",
        "REDIS_BROKER_PASSWORD",
        "REDIS_CACHE_PASSWORD",
    )

    def _values(self):
        found = {}
        for name in self.EXAMPLE_FILES:
            path = REPO_ROOT / name
            if not path.exists():
                continue
            text = path.read_text()
            for key in self.KEYS:
                match = re.search(rf"^{key}=(.*)$", text, re.MULTILINE)
                if match:
                    found[f"{name}:{key}"] = match.group(1).strip()
        return found

    def test_every_shipped_value_is_a_placeholder(self):
        from backend.EchoFlow.secrets import is_placeholder_secret

        values = self._values()
        assert values, (
            "Could not read DJANGO_SECRET_KEY / REDIS_*_PASSWORD out of any "
            "example env file — this test would silently stop guarding."
        )
        for source, value in values.items():
            assert is_placeholder_secret(value), (
                f"{source} ships {value!r}, which the guard does NOT treat as "
                "a placeholder. Deploying a copy unchanged leaves a "
                "repository-known key in production. Fix the guard or change "
                "the example to an obviously-invalid value like <generate-me>."
            )

    def test_the_template_markers_in_laptop_example_are_covered(self):
        """`<same-as-vps>` contains none of the listed substrings.

        Only the angle-bracket rule catches it, which is exactly why that rule
        exists. Pinned so removing it fails loudly.
        """
        from backend.EchoFlow.secrets import is_placeholder_secret

        assert is_placeholder_secret("<same-as-vps>") is True
        assert "<" in (REPO_ROOT / ".env.laptop.example").read_text()


class TestSettingsImportEnforcesTheGuard:
    """Import-time enforcement, verified in a child process.

    A subprocess is the only honest way to test this: Django caches the
    settings module in `sys.modules`, so re-importing in-process would
    exercise nothing. Each test therefore ships a control assertion
    (`test_the_harness_itself_works`) so a subprocess that fails for an
    unrelated reason cannot make the rest pass for the wrong reason.
    """

    REAL_SECRET = "vQ8sTz2mRk5pLw9xYb3nHc7dFs1gJq6Zn4A"
    MARKER = "import backend.EchoFlow.settings; print('IMPORTED-OK')"

    def _run(self, overrides):
        env = dict(os.environ)
        env.update({k: v for k, v in overrides.items() if v is not None})
        for key, value in overrides.items():
            if value is None:
                env.pop(key, None)
        env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-c", self.MARKER],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(REPO_ROOT),
            timeout=180,
        )

    def test_the_harness_itself_works(self):
        """Control. A real secret must import cleanly.

        Without this, a subprocess that fails for an unrelated reason (bad
        PYTHONPATH, missing env) would make every other test in this class
        pass for the wrong reason.
        """
        result = self._run({
            "DJANGO_SECRET_KEY": self.REAL_SECRET,
            "DJANGO_DEBUG": "False",
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": None,
        })
        assert result.returncode == 0, (
            f"control import failed, so the assertions below prove nothing.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "IMPORTED-OK" in result.stdout

    def test_placeholder_django_secret_key_fails_the_import(self):
        result = self._run({
            "DJANGO_SECRET_KEY": "change-me-to-a-long-random-string",
            "DJANGO_DEBUG": "False",
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": None,
            # ECHOFLOW_TESTING is a documented third bypass and conftest.py sets
            # it in the parent, so `_run` (which starts from `dict(os.environ)`)
            # would otherwise hand it to the subprocess and the import would
            # succeed for the wrong reason. A test that claims to prove the
            # guard fires has to clear every bypass, not just the one it
            # remembers.
            "ECHOFLOW_TESTING": None,
        })
        assert result.returncode != 0, (
            "a placeholder DJANGO_SECRET_KEY imported cleanly in a "
            "DJANGO_DEBUG=False process"
        )
        assert "DJANGO_SECRET_KEY" in result.stderr, result.stderr
        assert "token_urlsafe" in result.stderr, result.stderr

    def test_placeholder_redis_password_fails_the_import(self):
        result = self._run({
            "DJANGO_SECRET_KEY": self.REAL_SECRET,
            "DJANGO_DEBUG": "False",
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": None,
            "ECHOFLOW_TESTING": None,
            "REDIS_BROKER_HOST": "redis_broker",
            "REDIS_BROKER_PORT": "6379",
            "REDIS_BROKER_PASSWORD": "change-me-strong-password",
        })
        assert result.returncode != 0, (
            "a placeholder Redis password imported cleanly — anyone who read "
            ".env.vps.example can authenticate to the broker"
        )
        assert "REDIS_BROKER_PASSWORD" in result.stderr, result.stderr

    def test_the_documented_escape_hatch_allows_it(self):
        """The escape hatch has to actually work, or it is not an escape."""
        result = self._run({
            "DJANGO_SECRET_KEY": "change-me-to-a-long-random-string",
            "DJANGO_DEBUG": "False",
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": "1",
        })
        assert result.returncode == 0, (
            "the escape hatch did not work; it must be usable by tooling that "
            f"legitimately needs a dummy value.\nstderr: {result.stderr}"
        )
        assert "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS" in (result.stderr + result.stdout), (
            "the bypass was silent — it must warn"
        )

    def test_debug_mode_tolerates_a_placeholder_but_says_so(self):
        result = self._run({
            "DJANGO_SECRET_KEY": "change-me-to-a-long-random-string",
            "DJANGO_DEBUG": "True",
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": None,
        })
        assert result.returncode == 0, (
            "DJANGO_DEBUG=True must still start, or the repo's own dev stack "
            f"and test harness break.\nstderr: {result.stderr}"
        )
        assert "DJANGO_SECRET_KEY" in (result.stderr + result.stdout), (
            "the debug bypass was silent"
        )


# --------------------------------------------------------------------------
# DEFECT 3 — build_redis_url must fail closed on a missing credential
# --------------------------------------------------------------------------
class TestBuildRedisUrlFailsClosed:
    def test_host_set_with_blank_password_raises(self, monkeypatch):
        """`REDIS_URL` defaults to *unauthenticated* `redis://localhost:6379/1`.

        So the old silent fallback connected somewhere with no credential at
        all — strictly worse than a known password, because it is silent.
        """
        from backend.EchoFlow import settings as s

        monkeypatch.setenv("REDIS_BROKER_HOST", "redis_broker")
        monkeypatch.setenv("REDIS_BROKER_PORT", "6379")
        monkeypatch.setenv("REDIS_BROKER_PASSWORD", "")
        with pytest.raises(ImproperlyConfigured) as exc:
            s.build_redis_url("REDIS_BROKER")
        message = str(exc.value)
        assert "REDIS_BROKER_PASSWORD" in message
        assert "REDIS_BROKER_HOST" in message, (
            "the error must name the variable that *is* set, or the operator "
            "cannot tell which line to fix"
        )

    def test_whitespace_only_password_also_raises(self, monkeypatch):
        """Whitespace is truthy. `if not password` would sail past it."""
        from backend.EchoFlow import settings as s

        monkeypatch.setenv("REDIS_BROKER_HOST", "redis_broker")
        monkeypatch.setenv("REDIS_BROKER_PASSWORD", "   ")
        with pytest.raises(ImproperlyConfigured):
            s.build_redis_url("REDIS_BROKER")

    def test_neither_host_nor_password_still_falls_back(self, monkeypatch):
        """Bare-metal dev with a password-less local Redis must keep working."""
        from backend.EchoFlow import settings as s

        for key in ("REDIS_BROKER_HOST", "REDIS_BROKER_PASSWORD"):
            monkeypatch.delenv(key, raising=False)
        assert s.build_redis_url("REDIS_BROKER") == s.REDIS_URL

    def test_host_and_password_still_build_an_encoded_url(self, monkeypatch):
        """The base64-password encoding must not regress.

        These passwords contain `+ / =`, which is precisely why HOST/PORT/
        PASSWORD exist instead of a URL.
        """
        from urllib.parse import quote

        from backend.EchoFlow import settings as s

        monkeypatch.setenv("REDIS_BROKER_HOST", "redis_broker")
        monkeypatch.setenv("REDIS_BROKER_PORT", "6379")
        monkeypatch.setenv("REDIS_BROKER_PASSWORD", "p/w+=")
        got = s.build_redis_url("REDIS_BROKER")
        assert quote("p/w+=", safe="") in got
        assert "redis_broker" in got

    def test_resolve_redis_url_propagates_the_failure(self, monkeypatch):
        """The raise has to reach the caller that actually connects."""
        from backend.EchoFlow import settings as s

        monkeypatch.setenv("REDIS_BROKER_HOST", "redis_broker")
        monkeypatch.setenv("REDIS_BROKER_PASSWORD", "")
        with pytest.raises(ImproperlyConfigured):
            s.resolve_redis_url("REDIS_BROKER")

    def test_the_url_only_shape_is_untouched(self, monkeypatch):
        """`.env.vps.example` / `.env.laptop.example` set only the URL.

        The 2026-09-29 precedence fix exists because a stale
        `REDIS_BROKER_URL` used to beat compose's service name. That must
        keep working, and setting no HOST must not start raising.
        """
        from backend.EchoFlow import settings as s

        monkeypatch.delenv("REDIS_BROKER_HOST", raising=False)
        monkeypatch.setenv("REDIS_BROKER_URL", "redis://:pw@redis_broker:6379/0")
        assert s.resolve_redis_url("REDIS_BROKER") == "redis://:pw@redis_broker:6379/0"

    def test_the_shipped_local_config_has_no_placeholder(self):
        """The running stack must not trip the new guard.

        Reads the *effective* settings rather than the env template, because
        compose substitutes real values into the container environment.
        """
        from backend.EchoFlow import settings as s

        assert s.REDIS_BROKER_URL, "broker URL is empty"
        assert "change-me" not in s.REDIS_BROKER_URL
        assert "change-me" not in s.REDIS_CACHE_URL
