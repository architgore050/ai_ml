"""Three defects that all failed silently, and none of them raised.

1. `RegisterUsernameRateThrottle.scope` was dead. `ScopedRateThrottle.allow_request`
   opens with `self.scope = getattr(view, 'throttle_scope', None)`, so
   `RegisterView`'s `'register'` overwrote the class's `'register_username'`
   before the rate was read. The per-username bucket was real; its 3/hour was
   not — it ran at the view's 200/hour.

2. `login: 10/min` is one budget per carrier NAT gateway, and there is no
   verified subject to key on the way `token_refresh` has one. Fixed by adding
   `LoginUsernameRateThrottle` alongside it, not by raising the IP rate.

3. The `DB_PASSWORD` guard did not exist, and the docstring in
   `EchoFlow/secrets.py` claimed it could not: it checked that the env var
   NAME is absent from `settings.py`, which is true, instead of checking the
   effective value `settings.DATABASES['default']['PASSWORD']`, which is not
   absent at all.

Each section below was run RED against the unfixed source first; the measured
output is quoted in the class docstrings.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from django.core.cache.backends.locmem import LocMemCache
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework.throttling import (
    ScopedRateThrottle,
    SimpleRateThrottle,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def _username_keyed_resolve_scope():
    """The one implementation of "pin my own scope", by reference.

    Used as the marker for "this throttle ignores the view's scope" rather
    than as a name the guard has to keep in sync with a docstring.
    """
    from backend.app.throttling import UsernameKeyedRateThrottle

    return UsernameKeyedRateThrottle.resolve_scope


UsernameKeyedResolveScope = _username_keyed_resolve_scope()


@pytest.fixture(autouse=True)
def isolated_throttle_cache(monkeypatch):
    """Point the throttle counter at a private in-process cache.

    `SimpleRateThrottle.cache` is the Django default cache — in this stack the
    Redis the four running Celery workers also use. The rate-boundary tests
    here walk a whole window's worth of requests, which is slow enough against
    a shared cache to hit django-redis' socket read timeout and fail for
    reasons that have nothing to do with the throttle.

    `monkeypatch.setattr` on `SimpleRateThrottle` rather than on a subclass:
    the attribute is defined there, so the restore writes back the original
    instead of leaving a permanent shadow on the subclass that later fixtures
    would not see.
    """
    local = LocMemCache("throttle-scope-tests", {})
    monkeypatch.setattr(SimpleRateThrottle, "cache", local, raising=False)
    yield local
    local.clear()


def _body_request(path, payload, ip="10.0.0.1"):
    """A DRF Request with a pre-parsed JSON body and a pinned client address."""
    wsgi = APIRequestFactory().post(path, data=payload, format="json")
    wsgi.META = dict(wsgi.META, REMOTE_ADDR=ip, HTTP_X_FORWARDED_FOR=None)
    request = Request(wsgi, parsers=[JSONParser()])
    request._full_data = payload
    return request


class _Clock:
    """A throttle timer the test moves by hand.

    `SimpleRateThrottle.timer` is `time.time`, and `allow_request` prunes the
    window against it. A wall clock cannot tell '10/min' from '10/hour' inside
    a single test, so the two rates are told apart by advancing this past the
    shorter window and asking whether the budget came back.
    """

    def __init__(self, now=1_700_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


# ---------------------------------------------------------------------------
# DEFECT 1 — the dead class scope
# ---------------------------------------------------------------------------
class TestRegisterUsernameScopeIsEnforced:
    """3/hour is actually the rate in force, not 200/hour.

    RED against the unfixed source: the throttle reported
    `num_requests == 200, duration == 3600` and `allow_request` returned True
    for all 200 attempts.
    """

    @staticmethod
    def _register_view():
        from backend.app.views.auth import RegisterView

        return RegisterView()

    def _throttle(self):
        from backend.app.throttling import RegisterUsernameRateThrottle

        view = self._register_view()
        return [t for t in view.get_throttles()
                if isinstance(t, RegisterUsernameRateThrottle)][0], view

    def test_drf_does_overwrite_a_class_scope_with_the_views(self):
        """Pins the upstream behaviour the defect was built on.

        If a DRF upgrade ever stopped doing this, the rest of this class would
        keep passing for the wrong reason — a bare
        `ScopedRateThrottle` with a class scope is exactly what the guard test
        at the bottom of this file exists to catch, and it must fail loudly if
        the framework's behaviour changes underneath it.
        """
        throttle = ScopedRateThrottle()
        assert throttle.scope is None

        class _View:
            throttle_scope = "register"

        throttle.allow_request(_body_request("/auth/register/", {"username": "x"}),
                               _View())

        assert throttle.scope == "register"

    def test_the_enforced_scope_is_the_one_the_class_declares(self):
        throttle, view = self._throttle()
        assert view.throttle_scope == "register", (
            "RegisterView's own scope changed; this test's whole premise is "
            "that it differs from the per-username scope"
        )
        assert throttle.resolve_scope(view) == "register_username"

    def test_the_rate_in_force_is_three_per_hour_not_the_views_rate(self):
        throttle, view = self._throttle()
        request = _body_request("/auth/register/", {"username": "squatter"})

        assert throttle.allow_request(request, view) is True
        assert (throttle.num_requests, throttle.duration) == (3, 3600), (
            f"the throttle is enforcing {throttle.num_requests} per "
            f"{throttle.duration}s; expected 3 per 3600s. The class scope is "
            "being overwritten by the view's."
        )

    def test_the_fourth_attempt_on_one_username_is_refused(self):
        throttle, view = self._throttle()
        request = _body_request("/auth/register/", {"username": "squatter"})

        assert [throttle.allow_request(request, view) for _ in range(3)] == [
            True, True, True
        ]
        assert throttle.allow_request(request, view) is False

    def test_it_is_not_running_at_the_views_200_per_hour(self):
        """The boundary has to be inside the view's rate, not at it.

        Under the dead scope all 200 attempts succeed. 10 is enough to tell
        those apart and keeps the loop short.
        """
        throttle, view = self._throttle()
        request = _body_request("/auth/register/", {"username": "squatter"})

        statuses = [throttle.allow_request(request, view) for _ in range(10)]
        assert statuses == [True, True, True] + [False] * 7, (
            f"{statuses!r}: the per-username limit is not being enforced at "
            "3/hour"
        )

    def test_a_second_username_has_its_own_budget(self):
        """Pinning the scope must not merge every registration into one bucket."""
        throttle, view = self._throttle()
        first = _body_request("/auth/register/", {"username": "alice"})
        second = _body_request("/auth/register/", {"username": "bob"})

        for _ in range(3):
            assert throttle.allow_request(first, view) is True
        assert throttle.allow_request(first, view) is False
        assert throttle.allow_request(second, view) is True

    def test_the_key_still_names_the_username_not_the_address(self):
        throttle, _ = self._throttle()
        key = throttle.get_cache_key(
            _body_request("/auth/register/", {"username": "Alice"}), None
        )
        assert "username:alice" in key


@pytest.mark.django_db
class TestRegisterEndpointEnforcesThePerUsernameRate:
    """End-to-end through the view, not just the throttle instance."""

    @staticmethod
    def _payload(username):
        return {
            "username": username,
            "email": f"{username}@example.com",
            "password": "Str0ngPass!2026",
            "dob": "1990-01-01",
            "consent_accepted": True,
            "terms_version": "v1.0",
        }

    def test_three_distinct_names_are_all_served(self):
        """One IP per-username limit must not become one IP global limit."""
        client = APIClient()
        statuses = [
            client.post("/auth/register/", self._payload(f"user{i}"),
                        format="json").status_code
            for i in range(3)
        ]
        assert statuses == [201, 201, 201], (
            f"{statuses!r}: three registrations from one address were refused"
        )

    def test_fourth_attempt_on_one_name_is_429(self):
        """`dob` is omitted so every attempt is a 400 the serializer produces.

        The point is only *where* the request stops: the throttle runs in
        `APIView.initial()`, before the serializer, so the first three are
        counted and the fourth never reaches validation. Using a payload the
        serializer accepts would make the answer depend on the duplicate-
        username rule instead — the second and third would 400 on `username`
        for an unrelated reason.
        """
        payload = self._payload("squatter")
        del payload["dob"]
        client = APIClient()
        statuses = [
            client.post("/auth/register/", payload, format="json").status_code
            for _ in range(4)
        ]
        assert statuses == [400, 400, 400, 429], (
            f"{statuses!r}: POST /auth/register/ is not enforcing the "
            "per-username 3/hour limit"
        )


# ---------------------------------------------------------------------------
# DEFECT 2 — the per-account login limit
# ---------------------------------------------------------------------------
class TestLoginUsernameThrottle:
    """`login_username` is the scope in force, at its own rate.

    RED against the unwired/unscoped source: `LoginUsernameRateThrottle` did
    not exist, and the equivalent check against `RegisterUsernameRateThrottle`
    reported `num_requests == 10, duration == 60` — the view's `login` scope —
    for a scope that claims to be per hour.
    """

    @staticmethod
    def _login_view():
        from backend.app.urls import ThrottledTokenObtainPairView

        return ThrottledTokenObtainPairView()

    def _throttle(self):
        from backend.app.throttling import LoginUsernameRateThrottle

        view = self._login_view()
        matched = [t for t in view.get_throttles()
                   if isinstance(t, LoginUsernameRateThrottle)]
        assert matched, (
            "LoginUsernameRateThrottle is not wired onto "
            "ThrottledTokenObtainPairView; the per-account limit does not exist"
        )
        return matched[0], view

    def test_the_login_view_wires_both_limits(self):
        from backend.app.throttling import (
            LoginUsernameRateThrottle,
            TrustedProxyRateThrottle,
        )

        classes = list(self._login_view().throttle_classes)
        assert TrustedProxyRateThrottle in classes, (
            "the per-IP 'login' bucket is gone; login must stay IP-keyed or a "
            "carrier NAT shares nothing and a single host is unbounded"
        )
        assert LoginUsernameRateThrottle in classes

    def test_the_rate_is_registered_in_settings(self):
        """An unregistered scope makes `get_rate()` raise, which surfaces as a
        500 on every login rather than a 429."""
        from django.conf import settings

        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        assert "login_username" in rates

    def test_the_enforced_scope_is_login_username_not_login(self):
        throttle, view = self._throttle()
        assert view.throttle_scope == "login"
        assert throttle.resolve_scope(view) == "login_username", (
            "the per-account throttle is running under the view's 'login' "
            "scope, which makes it indistinguishable from the per-IP limit"
        )

    def test_the_rate_in_force_is_ten_per_hour(self):
        throttle, view = self._throttle()
        throttle.allow_request(
            _body_request("/auth/login/", {"username": "victim"}), view
        )
        assert (throttle.num_requests, throttle.duration) == (10, 3600), (
            f"enforcing {throttle.num_requests} per {throttle.duration}s; "
            "expected 10 per 3600s"
        )

    def test_the_eleventh_password_for_one_username_is_refused(self):
        throttle, view = self._throttle()
        allowed = [
            throttle.allow_request(
                _body_request("/auth/login/", {"username": "victim",
                                               "password": f"guess{i}"}),
                view,
            )
            for i in range(11)
        ]
        assert allowed == [True] * 10 + [False], (
            f"{allowed!r}: one account is not bounded at 10 attempts"
        )

    def test_it_is_not_the_ip_rates_ten_per_minute(self, monkeypatch):
        """The discriminating test.

        `login_username` is 10/hour and `login` is 10/min, so a burst of ten
        cannot tell them apart — the *only* difference is whether the budget
        returns after a minute. Advance the clock past one minute and the
        per-hour bucket must still be spent. Under the view's scope this
        assertion fails: attempts 11 through 20 come back True.
        """
        from backend.app.throttling import LoginUsernameRateThrottle

        clock = _Clock()
        monkeypatch.setattr(LoginUsernameRateThrottle, "timer", clock)
        throttle, view = self._throttle()

        def attempt(index):
            return throttle.allow_request(
                _body_request("/auth/login/", {"username": "victim",
                                               "password": f"guess{index}"}),
                view,
            )

        assert [attempt(i) for i in range(10)] == [True] * 10
        clock.advance(61)
        assert attempt(10) is False, (
            "the per-account budget came back after 61 seconds, so this is "
            "running at the view's 10/min and not its own 10/hour"
        )
        clock.advance(3600)
        assert attempt(11) is True, (
            "the window never reopened, so this is not a rolling 10/hour"
        )

    def test_distinct_usernames_are_not_charged_to_one_account(self):
        throttle, view = self._throttle()
        for i in range(10):
            assert throttle.allow_request(
                _body_request("/auth/login/", {"username": f"user{i}"}), view
            ) is True

    def test_case_variants_are_one_account(self):
        throttle, view = self._throttle()
        for _ in range(10):
            assert throttle.allow_request(
                _body_request("/auth/login/", {"username": "Victim"}), view
            ) is True
        assert throttle.allow_request(
            _body_request("/auth/login/", {"username": "victim"}), view
        ) is False

    def test_a_body_with_no_username_falls_back_to_the_address(self):
        throttle, _ = self._throttle()
        key = throttle.get_cache_key(
            _body_request("/auth/login/", {"password": "x"}, ip="10.0.0.9"), None
        )
        assert "ip:10.0.0.9" in key


class TestLoginIpBucketStillStopsTheFlood:
    """The other half: the per-IP `login` bucket is what bounds many names.

    An attacker rotating usernames walks straight through a per-username bucket,
    so it must be the IP key that stops them — and it must keep working
    unchanged after the per-account limit was added alongside it.
    """

    def _ip_throttle(self):
        from backend.app.throttling import TrustedProxyRateThrottle

        view = TestLoginUsernameThrottle._login_view()
        matched = [t for t in view.get_throttles()
                   if type(t) is TrustedProxyRateThrottle]
        assert matched, "the per-IP 'login' throttle is not wired"
        return matched[0], view

    def test_eleven_distinct_usernames_from_one_address_are_refused(self):
        throttle, view = self._ip_throttle()
        allowed = [
            throttle.allow_request(
                _body_request("/auth/login/", {"username": f"user{i}",
                                               "password": "x"}),
                view,
            )
            for i in range(11)
        ]
        assert allowed == [True] * 10 + [False], (
            f"{allowed!r}: one source address is not bounded to 10 attempts/min"
        )
        assert (throttle.num_requests, throttle.duration) == (10, 60)

    def test_a_different_address_has_its_own_ten(self):
        throttle, view = self._ip_throttle()
        for _ in range(10):
            assert throttle.allow_request(
                _body_request("/auth/login/", {"username": "a"},
                              ip="10.0.0.1"),
                view,
            ) is True
        assert throttle.allow_request(
            _body_request("/auth/login/", {"username": "a"}, ip="10.0.0.2"),
            view,
        ) is True


# ---------------------------------------------------------------------------
# The guard: no throttle may declare a scope the view silently overwrites
# ---------------------------------------------------------------------------
def _views_using_throttle():
    """(view, throttle class, len(the view's throttle list)) for every
    throttle DRF would run.

    Read off the URLconf and the viewsets behind it rather than off a
    hand-written list, so a view added later is covered automatically. A
    ViewSet is expanded per action because `get_throttles` and `throttle_scope`
    both read `self.action`, which only `dispatch` sets.
    """
    from django.urls import get_resolver

    pairs = []
    seen = set()

    def walk(patterns):
        for pattern in patterns:
            if hasattr(pattern, "url_patterns"):
                walk(pattern.url_patterns)
                continue
            cls = getattr(getattr(pattern, "callback", None), "cls", None)
            if cls is None or cls in seen:
                continue
            seen.add(cls)
            # `ViewSetMixin.as_view` publishes its action map on the view
            # function; DRF's `dispatch` is what copies an entry out of it into
            # `self.action`, which is what `get_throttles` and `throttle_scope`
            # read. A ViewSet therefore has to be walked one action at a time.
            actions = list(
                getattr(getattr(pattern, "callback", None), "actions", None)
                or [None]
            )
            for action in actions:
                view = cls()
                if action is not None:
                    view.action = action
                throttles = view.get_throttles()
                pairs.extend((view, type(t), len(throttles)) for t in throttles)

    walk(get_resolver().url_patterns)
    return pairs


class TestNoThrottleDeclaresAScopeTheViewClobbers:
    """The guard against DEFECT 1 recurring.

    A class-level `scope` on a `ScopedRateThrottle` is a default the view
    overwrites, not a limit. Nothing raises when that happens: the throttle
    keeps running, on the right key, at the wrong rate. This asserts the
    property rather than the shape, by asking each in-use throttle which scope
    it would enforce for the view that actually lists it.
    """

    def test_every_in_use_throttle_enforces_the_scope_it_declares(self):
        offenders = []
        checked = 0
        for view, throttle_class, _count in _views_using_throttle():
            # `ScopedRateThrottle` and not `SimpleRateThrottle`: DRF's
            # `AnonRateThrottle` and `UserRateThrottle` also carry a `scope`
            # class attribute, but their `allow_request` never reads the view's
            # `throttle_scope`, so there is nothing to overwrite. Only the
            # `ScopedRateThrottle` family clobbers.
            if not issubclass(throttle_class, ScopedRateThrottle):
                continue
            declared = throttle_class.__dict__.get("scope")
            if declared is None:
                # `__dict__` on purpose: a scope inherited from a parent is
                # that parent's business, and the parent is visited on its own
                # wherever it is used.
                continue
            checked += 1
            enforced = throttle_class().resolve_scope(view)
            if enforced != declared:
                offenders.append(
                    f"{throttle_class.__name__} declares scope {declared!r} "
                    f"but {type(view).__name__} makes it enforce {enforced!r}"
                )
        assert not offenders, "\n  ".join(offenders)
        assert checked, "no throttle class was found; the walk is broken"

    def test_a_throttle_listed_alongside_another_must_pin_its_own_scope(self):
        """The configuration that produced both defects.

        `RegisterUsernameRateThrottle` and `LoginUsernameRateThrottle` are each
        the second entry in a two-throttle list whose first entry owns the
        view's `throttle_scope`. That is exactly the arrangement in which a
        class `scope` is silently overwritten, so for those the class attribute
        has to be pinned rather than read from the view.

        A view that lists one throttle is exempt: `RefreshTokenRateThrottle`
        declares `scope = 'token_refresh'` as documentation and genuinely reads
        it from `ThrottledTokenRefreshView`, which `test_..._enforces_the_scope_
        it_declares` pins by comparing the two. It must keep doing so — pinning
        it would break `test_throttling.py::TestRefreshThrottleWiring::
        test_a_view_without_a_scope_is_unthrottled`, which documents that a
        scope-less view on that endpoint is deliberately left unthrottled.
        """
        offenders = []
        for view, throttle_class, count in _views_using_throttle():
            if not issubclass(throttle_class, ScopedRateThrottle):
                continue
            declared = throttle_class.__dict__.get("scope")
            if declared is None or count < 2:
                continue
            if getattr(throttle_class, "resolve_scope", None) is not (
                UsernameKeyedResolveScope
            ):
                offenders.append(throttle_class.__name__)
        assert not offenders, (
            "these throttles are listed alongside another throttle on a view "
            f"that declares its own scope, but do not pin theirs: {offenders}. "
            "Override `resolve_scope` (see `UsernameKeyedRateThrottle`)."
        )

    def test_the_two_username_throttles_are_both_in_use(self):
        """Control: the walk must actually reach the classes under test."""
        in_use = {cls for _, cls, _ in _views_using_throttle()}
        from backend.app.throttling import (
            LoginUsernameRateThrottle,
            RegisterUsernameRateThrottle,
        )

        assert RegisterUsernameRateThrottle in in_use
        assert LoginUsernameRateThrottle in in_use


# ---------------------------------------------------------------------------
# DEFECT 3 — the effective DB password
# ---------------------------------------------------------------------------
def _import_settings(env_overrides):
    """Import `backend.EchoFlow.settings` in a fresh interpreter.

    The guard runs at settings-import time, so it cannot be observed from
    inside an already-imported process — and `pytest` being in `sys.modules` is
    itself one of the documented bypasses. A subprocess is the only way to see
    what an operator would see.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS",
            "ECHOFLOW_TESTING",
            "DJANGO_DEBUG",
            "PYTEST_CURRENT_TEST",
        }
    }
    env.update(env_overrides)
    env["DJANGO_SETTINGS_MODULE"] = "backend.EchoFlow.settings"
    return subprocess.run(
        [sys.executable, "-c", "from django.conf import settings;"
         " print(settings.DATABASES['default'].get('PASSWORD'))"],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=env,
    )


class TestDatabasePasswordGuard:
    """`DB_PASSWORD` is guarded, on the value the process authenticates with.

    RED against the unfixed source: every case below imported cleanly,
    including `change-me-strong-password`, the literal shipped in
    `.env.example` and `.env.vps.example`.
    """

    @staticmethod
    def _url(password_fragment):
        return f"postgres://echoflow:{password_fragment}@127.0.0.1:5432/db"

    def test_a_shipped_placeholder_password_is_refused(self):
        result = _import_settings(
            {"DATABASE_URL": self._url("change-me-strong-password")}
        )
        assert result.returncode != 0, (
            "a placeholder DB password imported cleanly:\n"
            f"{result.stdout}{result.stderr}"
        )
        assert "DB_PASSWORD" in result.stderr, (
            "settings failed for some other reason; this test would then pass "
            f"without testing the guard:\n{result.stdout}{result.stderr}"
        )

    def test_a_laptop_template_marker_is_refused(self):
        """`.env.laptop.example` ships `DB_PASSWORD=<same-as-vps>`."""
        result = _import_settings({"DATABASE_URL": self._url("%3Csame-as-vps%3E")})
        assert result.returncode != 0
        assert "DB_PASSWORD" in result.stderr

    def test_a_real_password_imports_and_is_unchanged(self):
        result = _import_settings({"DATABASE_URL": self._url("kR7vQ2nZ9xW4mB8pL3dF")})
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "kR7vQ2nZ9xW4mB8pL3dF"

    def test_an_absent_password_is_not_a_placeholder_failure(self):
        """Bare-metal development against a Postgres that trusts the socket.

        `is_placeholder_secret('')` is True by design — an empty HMAC key is
        worse than none — but an empty *database* password is a legitimate
        configuration, so the caller skips the guard rather than letting it
        fire.
        """
        result = _import_settings(
            {"DATABASE_URL": "postgres://echoflow@127.0.0.1:5432/db"}
        )
        assert result.returncode == 0, (
            f"an absent DB password was treated as a placeholder:\n"
            f"{result.stdout}{result.stderr}"
        )

    def test_the_documented_bypass_still_applies(self):
        """`ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS=1` is what keeps the suite and a
        tooling smoke check running; the new guard must honour it rather than
        inventing a second escape."""
        result = _import_settings({
            "DATABASE_URL": self._url("change-me-strong-password"),
            "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS": "1",
        })
        assert result.returncode == 0, result.stderr
        assert "DB_PASSWORD is a documentation placeholder" in result.stderr

    def test_the_angle_bracket_rule_is_the_shared_one(self):
        """`<same-as-vps>` contains none of the placeholder *words*; it is
        caught by the `<`/`>` rule in `secrets.py`. Passing proves the guard
        reuses that vocabulary instead of a second, narrower list of its own."""
        from backend.EchoFlow.secrets import is_placeholder_secret

        assert is_placeholder_secret("<same-as-vps>")
        assert is_placeholder_secret("change-me-strong-password")
        assert not is_placeholder_secret("kR7vQ2nZ9xW4mB8pL3dF")