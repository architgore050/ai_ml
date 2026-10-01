"""CORS configuration tests — Block 0 commit 1.

REGESSION: CORS was completely non-functional in production.

`CORS_URLS_REGEX` was set to `r'$.^'` ("match nothing") on the reasoning
documented at the old settings.py:42-43, which claimed the middleware would
"still apply CORS_ALLOWED_ORIGINS to all responses that flow through its
check_origin method".

**`CorsMiddleware` has no `check_origin` method.** django-cors-headers
4.9.0 gates the whole middleware on:

    is_enabled = re.match(CORS_URLS_REGEX, request.path_info) or check_signal(request)

and `check_signal()` only sends the `check_request_enabled` signal, to which
nothing in this repo subscribes. So with a never-matching regex, `is_enabled`
was always False and **no response ever carried an `Access-Control-*` header**.

That is not a latent bug. The documented production topology is cross-origin
by design — the React app is served from Cloudflare Pages at
`https://app.echoflow.in` and the API is `https://api.echoflow.in`
(`.env.vps.example:17-21`) — and nginx does not serve the frontend, so there
is no same-origin path. Every browser request from the production frontend
was rejected at preflight. The deployed app could not function at all.

These tests assert on **response headers observed through the real
middleware stack**, not on the regex alone, because the bug lived in the
interaction between the regex and `is_enabled`. A regex-only test would
have passed against the broken configuration.
"""
import re

import pytest
from django.conf import settings
from django.test import Client

# An origin that must be in CORS_ALLOWED_ORIGINS for the allowlist assertions
# below to be meaningful. Derived from the setting rather than hardcoded so
# the test still exercises the middleware if the env changes the list.
ALLOWED = settings.CORS_ALLOWED_ORIGINS[0].rstrip('/')
DENIED = 'https://definitely-not-allowed.example.com'


def _get(path, origin):
    return Client().get(path, HTTP_ORIGIN=origin)


def _is_enabled(path, origin=ALLOWED):
    """Call the real `CorsMiddleware.is_enabled`.

    A real instance is required, not a bare `None`: the expression is
    `re.match(...) or self.check_signal(request)`, so `self.check_signal` is
    only skipped when the regex MATCHES. Passing None therefore works for a
    CORS-enabled path purely by short-circuit and raises AttributeError for an
    excluded one. A lambda `get_response` keeps both branches real.
    """
    from corsheaders.middleware import CorsMiddleware
    from django.test import RequestFactory

    mw = CorsMiddleware(lambda request: None)
    req = RequestFactory().get(path)
    req.META['HTTP_ORIGIN'] = origin
    return mw.is_enabled(req)


class TestCorsHeadersAreEmitted:
    """The core regression. Each of these returned no CORS header before."""

    def test_allowed_origin_gets_allow_origin_header(self):
        r = _get('/health/', ALLOWED)
        assert r.status_code == 200
        assert r.headers.get('Access-Control-Allow-Origin') == ALLOWED, (
            "No Access-Control-Allow-Origin for an allowlisted origin. The "
            "browser will block every cross-origin read. Check "
            "CORS_URLS_REGEX — a never-matching regex disables the entire "
            "middleware, because nothing subscribes to the "
            "`check_request_enabled` signal that is_enabled() falls back to."
        )

    def test_allowed_origin_gets_allow_credentials(self):
        """Required for the HLS handshake: playback-token sets the HttpOnly
        `ef_hls_token` cookie and the client sends credentials:'include'.
        Without this header the browser discards the Set-Cookie and every
        /hls/* request 403s despite a valid token."""
        r = _get('/health/', ALLOWED)
        assert r.headers.get('Access-Control-Allow-Credentials') == 'true'

    def test_allowed_origin_header_is_the_specific_origin_not_a_wildcard(self):
        """Echoing `*` alongside credentials is rejected by browsers, and
        would defeat the allowlist. The library should echo the origin."""
        r = _get('/health/', ALLOWED)
        assert r.headers.get('Access-Control-Allow-Origin') != '*'

    def test_vary_origin_is_set(self):
        """Without Vary: Origin a shared cache can serve one origin's headers
        to another origin — a real cache-poisoning vector once responses are
        cacheable. Compared case-insensitively: the library emits lowercase
        `origin`, and Vary field names are case-insensitive per RFC 9110."""
        r = _get('/health/', ALLOWED)
        vary_fields = [v.strip().lower() for v in r.headers.get('Vary', '').split(',')]
        assert 'origin' in vary_fields, (
            f"Vary is {r.headers.get('Vary')!r}; 'Origin' must be listed or a "
            "shared cache can serve one origin's CORS headers to another."
        )


class TestPreflight:
    """A browser sends OPTIONS before the real request. If the preflight
    lacks these, the actual request is never sent."""

    def test_preflight_for_hls_token_endpoint_succeeds(self):
        r = Client().options(
            '/media/playback-token/1/',
            HTTP_ORIGIN=ALLOWED,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS='authorization,content-type',
        )
        assert r.status_code in (200, 204)
        assert r.headers.get('Access-Control-Allow-Origin') == ALLOWED
        assert r.headers.get('Access-Control-Allow-Credentials') == 'true'

    def test_preflight_advertises_range_header(self):
        """hls.js sends Range for partial segment content. Omitting it from
        the allowed headers breaks every HLS segment request cross-origin."""
        r = Client().options(
            '/hls/anything/master.m3u8',
            HTTP_ORIGIN=ALLOWED,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='GET',
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS='range',
        )
        allowed = r.headers.get('Access-Control-Allow-Headers', '')
        assert 'range' in allowed.lower()

    def test_preflight_exposes_retry_after(self):
        """DRF sends Retry-After on every 429. The client is required to
        honour the backoff, but a browser hides non-safelisted response
        headers from cross-origin JS."""
        r = Client().options(
            '/auth/login/',
            HTTP_ORIGIN=ALLOWED,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
        )
        exposed = r.headers.get('Access-Control-Expose-Headers', '')
        assert 'retry-after' in exposed.lower(), (
            "Retry-After is not in CORS_EXPOSE_HEADERS, so the client cannot "
            "read it cross-origin and cannot honour throttle backoff."
        )


class TestOriginAllowlistStillEnforced:
    """Restoring the regex must not have turned CORS into a wildcard."""

    def test_non_allowlisted_origin_gets_no_allow_origin_header(self):
        r = _get('/health/', DENIED)
        assert 'Access-Control-Allow-Origin' not in r.headers

    def test_allow_all_origins_is_false(self):
        assert settings.CORS_ALLOW_ALL_ORIGINS is False

    def test_missing_origin_header_gets_no_cors_header(self):
        """A same-origin or curl request should not be decorated."""
        r = Client().get('/health/')
        assert 'Access-Control-Allow-Origin' not in r.headers


class TestAdminAndMetricsExcluded:
    """The original N14 intent was to keep CORS off /admin/ and /metrics/.
    That intent is honoured by the negative lookahead.

    The exclusion is a property of `is_enabled`, so it is asserted there
    rather than by making live requests: rendering /admin/ pulls in
    `get_current_site()` and needs the database, which is irrelevant to
    whether a CORS header was attached.
    """

    @pytest.mark.parametrize('path', [
        '/admin/', '/admin/login/', '/admin/auth/user/1/change/',
        '/metrics/', '/metrics/all',
    ])
    def test_admin_and_metrics_are_excluded_by_the_middleware(self, path):
        assert _is_enabled(path) is False, (
            f"{path} must not be CORS-enabled — no browser origin "
            "legitimately calls it, and /admin/ is a staff surface."
        )

    def test_metrics_live_request_carries_no_cors_header(self):
        r = _get('/metrics/', ALLOWED)
        assert 'Access-Control-Allow-Origin' not in r.headers

    def test_auth_paths_are_not_excluded(self):
        """An earlier comment proposed excluding /auth/ as well. That would
        break login and token refresh, which ARE cross-origin browser calls.
        This test stops that idea from being reintroduced."""
        r = _get('/auth/login/', ALLOWED)
        assert r.headers.get('Access-Control-Allow-Origin') == ALLOWED


class TestRegexIsNotTheSecurityBoundary:
    """Guard the root cause directly: `is_enabled` must be True for an
    ordinary API path. This is the exact predicate that was False forever."""

    @pytest.mark.parametrize('path', [
        '/feed/', '/auth/login/', '/media/playback-token/1/',
        '/clips/', '/share/inbox/',
    ])
    def test_middleware_is_enabled_for_ordinary_api_paths(self, path):
        assert _is_enabled(path) is True, (
            f"CorsMiddleware.is_enabled() is False for {path} — the middleware "
            "is inert and no response will carry CORS headers."
        )

    def test_regex_is_not_a_never_matcher(self):
        """A direct guard against reintroducing r'$.^' or equivalent."""
        assert re.match(settings.CORS_URLS_REGEX, '/feed/')
        assert re.match(settings.CORS_URLS_REGEX, '/auth/login/')
        assert re.match(settings.CORS_URLS_REGEX,
                        '/media/playback-token/1/')
        assert not re.match(settings.CORS_URLS_REGEX, '/admin/')
        assert not re.match(settings.CORS_URLS_REGEX, '/metrics/')

    def test_settings_allow_credentials_is_explicitly_true(self):
        """django-cors-headers defaults CORS_ALLOW_CREDENTIALS to False when
        the setting is absent, so an unset value is indistinguishable from a
        deliberate False. Assert the explicit value."""
        assert settings.CORS_ALLOW_CREDENTIALS is True
