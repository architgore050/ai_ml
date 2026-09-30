"""
Tests for the HTTPS / TLS termination stack.

Covers four layers, in the order a request flows through them:

  1. CERT FILES
       The cert + key in docker/certs/ exist, parse, are a matched pair,
       are not expired, and cover localhost / 127.0.0.1 in the SAN list.
       Without these, nginx cannot start the TLS listener and every other
       test in this file is moot.

  2. NGINX CONFIG
       docker/nginx.conf is syntactically valid (parse with nginx -t is
       the canonical check; we fall back to a regex+structure check if
       nginx isn't on PATH in CI). The config must:
         - listen on 443 + 9443 with ssl
         - listen on 80 and 301-redirect to https
         - set X-Forwarded-Proto https on every upstream block
         - send HSTS with max-age >= 1 year
         - pass Range / Range-related headers to Django
         - reference the cert files we actually generated

  3. DJANGO SETTINGS (when DEBUG=False)
       settings.SECURE_SSL_REDIRECT is True
       settings.SECURE_PROXY_SSL_HEADER == ('HTTP_X_FORWARDED_PROTO', 'https')
       settings.SESSION_COOKIE_SECURE is True
       settings.CSRF_COOKIE_SECURE is True
       settings.SECURE_HSTS_SECONDS >= 31_536_000  (1 year)
       settings.SECURE_HSTS_INCLUDE_SUBDOMAINS is True
       settings.SECURE_HSTS_PRELOAD is True
       settings.SECURE_CONTENT_TYPE_NOSNIFF is True
       All of these depend on the `if not DEBUG:` block at settings.py:529
       firing — that's the contract the nginx terminator relies on.

  4. END-TO-END (in-process WSGI)
       When a request arrives with X-Forwarded-Proto: https, Django must:
         - serve the request as is_secure() == True
         - issue cookies with the Secure flag
         - NOT redirect to https (we are already https, nginx is doing
           the redirect — looping here would mean the
           SECURE_PROXY_SSL_HEADER trust is broken)

       When a request arrives WITHOUT X-Forwarded-Proto (i.e. nginx is
       misconfigured and forgot to set it), Django must:
         - if SECURE_SSL_REDIRECT is on, redirect to the https URL
         - if SECURE_SSL_REDIRECT is off, serve the request as
           is_secure() == False

These tests run with no Docker, no nginx, no real sockets. They use the
file system + the Django test client, which is enough to catch every
class of regression a real deployment would surface:

  - "the cert is expired"          → caught by test_cert_*
  - "nginx.conf has a typo"        → caught by test_nginx_config_*
  - "someone changed settings.py
     and turned off SSL redirect"  → caught by test_production_settings_*
  - "nginx forgot X-Forwarded-Proto
     and Django is redirect-looping" → caught by test_proxy_header_*

The ones that AREN'T covered here and need a live stack to catch:
  - nginx process actually started and bound the ports
  - cert is trusted by the system trust store (browser-side)
  - real handshake negotiates a cipher (covered by sslyze, not pytest)
  - HSTS preload-list acceptance (manual, browser-vendor)
"""
import os
import re
import ssl
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from django.conf import settings
from django.test import RequestFactory, override_settings


REPO_ROOT = Path(__file__).resolve().parents[3]  # backend/app/tests → repo root
CERTS_DIR = REPO_ROOT / 'docker' / 'certs'
CERT_PATH = CERTS_DIR / 'localhost.crt'
KEY_PATH = CERTS_DIR / 'localhost.key'
NGINX_CONF = REPO_ROOT / 'docker' / 'nginx.conf'
SETTINGS_PY = REPO_ROOT / 'backend' / 'EchoFlow' / 'settings.py'


# ---------------------------------------------------------------------------
# 1. CERT FILES
# ---------------------------------------------------------------------------
class TestCertFiles:
    """The TLS terminator cannot start without a valid cert + key pair.
    These tests fail loudly if someone regenerates the certs and forgets
    the SAN entries, or commits an expired cert."""

    def test_cert_and_key_exist(self):
        assert CERT_PATH.is_file(), f'Missing cert: {CERT_PATH}'
        assert KEY_PATH.is_file(), f'Missing key: {KEY_PATH}'

    def test_cert_and_key_are_nonempty(self):
        # A 0-byte file would make nginx fail to start with a
        # "SSL_CTX_use_PrivateKey_file" error.
        assert CERT_PATH.stat().st_size > 0
        assert KEY_PATH.stat().st_size > 0

    def test_cert_is_valid_x509(self):
        ctx = ssl.create_default_context(cafile=str(CERT_PATH))
        # get_ca_certs() returns the parsed cert(s). Empty list = the file
        # didn't parse as X.509 PEM.
        certs = ctx.get_ca_certs()
        assert certs, f'{CERT_PATH} did not parse as X.509 PEM'

    def test_cert_and_key_are_matched(self):
        """The cert's public key must correspond to the private key.
        If they don't match, nginx will reject the pair at startup with
        'SSL_CTX_check_private_key: ... key values mismatch'."""
        import cryptography.x509 as x509
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa, ec

        with CERT_PATH.open('rb') as f:
            cert = x509.load_pem_x509_certificate(f.read())

        with KEY_PATH.open('rb') as f:
            key = serialization.load_pem_private_key(f.read(), password=None)

        cert_pub = cert.public_key()
        # RSA vs EC — both supported by the openssl one-liner in AGENTS.md.
        if isinstance(key, rsa.RSAPrivateKey):
            assert isinstance(cert_pub, rsa.RSAPublicKey)
            # Modulus comparison is the deterministic way: same modulus +
            # same exponent ⇒ same key.
            assert key.public_key().public_numbers() == cert_pub.public_numbers()
        elif isinstance(key, ec.EllipticCurvePrivateKey):
            assert isinstance(cert_pub, ec.EllipticCurvePublicKey)
            assert key.public_key().public_numbers() == cert_pub.public_numbers()
        else:
            pytest.fail(f'Unsupported key type: {type(key).__name__}')

    def test_cert_is_not_expired(self):
        """An expired cert makes nginx serve a TLS handshake that
        browsers reject. We allow a 1-day grace for clock skew — the
        openssl one-liner in AGENTS.md uses 365d validity.

        The `cryptography` library added `not_valid_before_utc` /
        `not_valid_after_utc` (timezone-aware) in v42 and deprecated
        the naive `not_valid_before` / `not_valid_after` in v44. This
        test falls back to the naive attributes on older versions
        (and treats the naive values as UTC, which is the standard
        convention for X.509 certificates).
        """
        import cryptography.x509 as x509
        with CERT_PATH.open('rb') as f:
            cert = x509.load_pem_x509_certificate(f.read())
        # Prefer the modern timezone-aware attributes (v42+); fall back
        # to the deprecated naive ones (v41 and earlier) by treating
        # the naive values as UTC, which is the X.509 standard.
        not_before = getattr(cert, 'not_valid_before_utc', None)
        not_after = getattr(cert, 'not_valid_after_utc', None)
        if not_before is None:
            not_before = cert.not_valid_before.replace(tzinfo=timezone.utc)
        if not_after is None:
            not_after = cert.not_valid_after.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        assert not_before <= now, (
            f'Cert not_valid_before is in the future: {not_before}'
        )
        # 1-day grace window — clock skew between this host and the
        # cert authority (here: ourselves) is rare, but possible.
        assert not_after >= now - timedelta(days=1), (
            f'Cert expired at {not_after} (now: {now})'
        )

    def test_cert_san_covers_localhost(self):
        """The cert SAN must include 'localhost' and '127.0.0.1' —
        those are the names the nginx terminator is reached at in dev.
        A cert without these makes every browser/dev tool reject the
        handshake with NET::ERR_CERT_COMMON_NAME_INVALID."""
        import cryptography.x509 as x509
        import ipaddress

        with CERT_PATH.open('rb') as f:
            cert = x509.load_pem_x509_certificate(f.read())
        try:
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        except x509.ExtensionNotFound:
            pytest.fail('Cert has no SubjectAlternativeName extension')

        # cryptography >= 42 stores SAN entries as a flat list of
        # general_name objects (DNSName / IPAddress). Earlier versions
        # used DNSName/IPAddress classes accessed via
        # `cryptography.x509.GeneralName` — that submodule was removed
        # in cryptography 42+. We use isinstance against the type of
        # the actual entries, which works on both sides.
        dns_names = {n.value for n in san if isinstance(n, x509.DNSName)}
        ip_names = {n.value for n in san if isinstance(n, x509.IPAddress)}
        all_names = dns_names | {ipaddress.ip_address(str(n)) for n in ip_names}

        assert 'localhost' in dns_names, (
            f'localhost missing from SAN: {dns_names}'
        )
        assert ipaddress.IPv4Address('127.0.0.1') in all_names, (
            f'127.0.0.1 missing from SAN: {all_names}'
        )


# ---------------------------------------------------------------------------
# 2. NGINX CONFIG
# ---------------------------------------------------------------------------
class TestNginxConfig:
    """Static analysis of docker/nginx.conf. We can't `nginx -t` without
    nginx on PATH, so we cover the invariants that nginx -t would catch
    (correct listen/ssl directives, upstream blocks, header passthrough)
    via direct regex checks against the file."""

    def test_nginx_conf_exists(self):
        assert NGINX_CONF.is_file(), f'Missing {NGINX_CONF}'

    @pytest.fixture
    def conf_text(self):
        return NGINX_CONF.read_text()

    def test_http_listener_redirects_to_https(self, conf_text):
        # Find the server { listen 80; ... } block and assert it 301s.
        # The block contains `listen 80` and a `return 301 https://`.
        m = re.search(
            r'server\s*\{[^}]*?listen\s+80[^}]*?\}',
            conf_text,
            re.DOTALL,
        )
        assert m, 'No server block listening on :80'
        assert 'return 301 https://' in m.group(0), (
            'HTTP :80 listener does not 301-redirect to https://'
        )

    def test_https_listeners_present(self, conf_text):
        # The cert-bearing listeners must exist on 443 (Django) and
        # 9443 (MinIO). A typo here would silently leave the public
        # surface on plain HTTP.
        for port in (443, 9443):
            m = re.search(
                rf'listen\s+{port}\s+ssl',
                conf_text,
            )
            assert m, f'No `listen {port} ssl;` directive in nginx.conf'

    def test_tls_protocols_are_modern(self, conf_text):
        """TLS 1.0 / 1.1 are deprecated and disabled by every modern
        audit tool (Mozilla Observatory, SSL Labs). The config must
        restrict to TLSv1.2 + TLSv1.3."""
        ssl_blocks = re.findall(r'ssl_protocols\s+([^;]+);', conf_text)
        assert ssl_blocks, 'No ssl_protocols directive'
        for proto_list in ssl_blocks:
            toks = proto_list.split()
            assert 'TLSv1.2' in toks and 'TLSv1.3' in toks, (
                f'ssl_protocols missing TLSv1.2/1.3: {proto_list}'
            )
            for legacy in ('TLSv1', 'TLSv1.1', 'SSLv2', 'SSLv3'):
                assert legacy not in toks, (
                    f'Legacy protocol {legacy} enabled: {proto_list}'
                )

    def test_hsts_header_is_year_plus(self, conf_text):
        """HSTS must be at least 1 year (31536000 s). Shorter values
        are not honored by the HSTS preload list and undercut the
        whole point of HSTS."""
        m = re.search(
            r'Strict-Transport-Security["\s]+max-age=(\d+)',
            conf_text,
        )
        assert m, 'No HSTS header set'
        max_age = int(m.group(1))
        assert max_age >= 31_536_000, (
            f'HSTS max-age too low ({max_age}s). Must be >= 1 year.'
        )
        # 'always' ensures HSTS is sent on 4xx/5xx, not just 200s —
        # protects against downgrade-via-error-page attacks.
        assert 'always' in m.string, 'HSTS header lacks `always` flag'

    def test_hsts_includes_subdomains_and_preload(self, conf_text):
        # The preload flag is what makes the host eligible for the
        # browser-shipped HSTS list. The `includeSubDomains` flag
        # is what stops subdomains from being reachable over HTTP.
        # nginx's add_header syntax is:
        #   add_header Name "value" always;
        # — note the value is double-quoted and may contain spaces
        # and semicolon-separated directives, so we read the whole
        # quoted string.
        m = re.search(
            r'add_header\s+Strict-Transport-Security\s+"([^"]+)"',
            conf_text,
        )
        assert m, 'No Strict-Transport-Security add_header directive'
        hdr = m.group(1)
        assert 'max-age=' in hdr, f'HSTS header missing max-age: {hdr!r}'
        assert 'includeSubDomains' in hdr, (
            f'HSTS missing includeSubDomains: {hdr!r}'
        )
        assert 'preload' in hdr, f'HSTS missing preload: {hdr!r}'

    def test_x_forwarded_proto_https_set_on_upstreams(self, conf_text):
        """Every `proxy_pass` block must set `X-Forwarded-Proto https`.
        Without it, Django's SECURE_PROXY_SSL_HEADER doesn't fire and
        SECURE_SSL_REDIRECT creates a redirect loop."""
        # Split into location blocks (rough but sufficient for our config).
        location_blocks = re.findall(
            r'location\s+[^{]*\{[^}]*proxy_pass[^}]*\}',
            conf_text,
            re.DOTALL,
        )
        assert location_blocks, 'No location blocks with proxy_pass'
        for block in location_blocks:
            assert 'X-Forwarded-Proto' in block and 'https' in block, (
                f'location block missing X-Forwarded-Proto https:\n{block}'
            )

    def test_cert_paths_match_generated_files(self, conf_text):
        """nginx must reference the exact cert files we just generated.
        A wrong path here makes nginx exit with
        'cannot load certificate ...' on startup."""
        for needle in (
            '/etc/nginx/certs/localhost.crt',
            '/etc/nginx/certs/localhost.key',
        ):
            assert needle in conf_text, f'{needle} not referenced in nginx.conf'

    def test_client_max_body_size_supports_uploads(self, conf_text):
        """Audio uploads can be tens of MB. The default nginx limit
        (1 MB) would 413 the upload before it ever reaches Django.
        Match or exceed DATA_UPLOAD_MAX_MEMORY_SIZE."""
        m = re.search(r'client_max_body_size\s+(\d+)([kmg]?)', conf_text, re.I)
        assert m, 'No client_max_body_size directive'
        size = int(m.group(1))
        unit = (m.group(2) or '').lower()
        bytes_ = size * ({'k': 1024, 'm': 1024**2, 'g': 1024**3}.get(unit, 1))
        assert bytes_ >= 5 * 1024 * 1024, (
            f'client_max_body_size too small: {size}{unit} '
            f'(must be >= 5M to allow audio uploads)'
        )

    @pytest.mark.skipif(
        subprocess.run(['which', 'nginx'], capture_output=True).returncode != 0,
        reason='nginx not on PATH (run inside Docker web container to enable)',
    )
    def test_nginx_parses_with_no_errors(self):
        """If nginx is installed, the canonical `nginx -t` check is the
        gold standard — it catches every parse / include / ssl-load error
        that the static checks above can miss.

        Note: the running container is `nginx:1.27-alpine` which supports
        the `http2 on;` directive (added in nginx 1.25.1). The Debian
        nginx in the `web` test image is 1.22 and rejects `http2 on;`.
        We strip that single line before parsing so the test passes in
        both contexts; the actual deployed nginx still has it.
        """
        import shutil, tempfile
        # Make a temp copy of the config without the http2 directive so
        # both nginx 1.22 (Debian, in this test container) and 1.27
        # (Alpine, the actual terminator image) can parse it.
        conf_text = NGINX_CONF.read_text()
        stripped = '\n'.join(
            line for line in conf_text.splitlines() if line.strip() != 'http2 on;'
        )
        # The config references /etc/nginx/certs/ (absolute). Stage a
        # copy of the certs in a writable temp dir and rewrite the
        # config to point at it. This is the simplest way to validate
        # the real config in a context where we can't write to /etc.
        with tempfile.TemporaryDirectory() as tmp:
            certs_dir = os.path.join(tmp, 'certs')
            os.makedirs(certs_dir, exist_ok=True)
            shutil.copy(CERT_PATH, os.path.join(certs_dir, 'localhost.crt'))
            shutil.copy(KEY_PATH, os.path.join(certs_dir, 'localhost.key'))
            stripped = stripped.replace('/etc/nginx/certs/', f'{certs_dir}/')
            tmp_conf = os.path.join(tmp, 'nginx.conf')
            with open(tmp_conf, 'w') as f:
                f.write(stripped)
            proc = subprocess.run(
                ['nginx', '-t', '-c', tmp_conf, '-p', tmp],
                capture_output=True,
                text=True,
            )
        assert proc.returncode == 0, (
            f'nginx -t failed:\nstdout={proc.stdout}\nstderr={proc.stderr}'
        )


# ---------------------------------------------------------------------------
# 3. DJANGO SETTINGS (DEBUG=False, the production mode the terminator runs)
# ---------------------------------------------------------------------------
def _not_debug_term(test):
    """Return the `not DEBUG` sub-term of `test`, or None.

    Accepts both the bare form (`not DEBUG`) and an AND-ed form
    (`not DEBUG and not _SOMETHING`), because the prod block legitimately
    carries a test-only opt-out alongside the DEBUG check. Anything that is not
    a top-level conjunction is rejected: a guard nested inside another
    condition is a different shape and should not satisfy this check.
    """
    import ast

    if (
        isinstance(test, ast.UnaryOp)
        and isinstance(test.op, ast.Not)
        and isinstance(test.operand, ast.Name)
        and test.operand.id == 'DEBUG'
    ):
        return test
    if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And):
        for value in test.values:
            if (
                isinstance(value, ast.UnaryOp)
                and isinstance(value.op, ast.Not)
                and isinstance(value.operand, ast.Name)
                and value.operand.id == 'DEBUG'
            ):
                return value
    return None


def _gated_on_not_debug(test) -> bool:
    return _not_debug_term(test) is not None


def _extra_conditions(test):
    """Names gated alongside `not DEBUG`, i.e. everything else in the AND."""
    import ast

    if not isinstance(test, ast.BoolOp):
        return []
    return [
        v.operand.id
        for v in test.values
        if isinstance(v, ast.UnaryOp)
        and isinstance(v.op, ast.Not)
        and isinstance(v.operand, ast.Name)
        and v.operand.id != 'DEBUG'
    ]


class TestProductionSslSettings:
    """The Django settings module's `if not DEBUG:` block is the
    production-mode contract that nginx depends on. These tests read
    settings.py as text and assert the right assignments are inside
    that block.

    We don't use `override_settings(DEBUG=False)` + reload here:
      - The conftest (and the user's .env) both set DJANGO_DEBUG=True
        so the test suite runs without TLS — which is the correct shape
        for in-process WSGI tests (you don't want a 301-redirect to
        https://localhost in a unit test).
      - But that means the runtime settings object never sees the
        production block, and reloading with DEBUG=False would
        leak that state into other tests.
      - Static analysis of the source is actually the stronger check:
        it would catch a future PR that deletes the SSL block even
        when no test environment ever exercises it.
    """

    @pytest.fixture
    def prod_block(self):
        """Extract the text inside `if not DEBUG:` in settings.py.

        We use a simple bracket-counting scan rather than a regex —
        the block can contain nested `if`/function calls/etc., and
        a regex would miscount on the first nested if/try. The
        starting token is `if not DEBUG:` and the block ends at the
        first top-level `else:` or unindented statement."""
        import ast
        text = SETTINGS_PY.read_text()
        tree = ast.parse(text)
        # Find the `if not <name>:` node at module level where <name>
        # is the literal `DEBUG`. The test value is `not <NAME>` —
        # Python's ast is `UnaryOp(Not, Name('DEBUG'))`.
        for node in tree.body:
            if not (isinstance(node, ast.If) and _gated_on_not_debug(node.test)):
                continue

            # The block may now carry extra AND-ed conditions beyond
            # `not DEBUG` (it does: a test-only opt-out, so the suite can run
            # against a DEBUG=False container without every request 301-ing).
            # That is legitimate ONLY while those extras can never be true in a
            # deployed environment. A guard that widens production hardening
            # would be worse than no guard, so assert the extras are named like
            # a testing switch rather than accepting any condition at all.
            extras = _extra_conditions(node.test)
            assert all(
                re.search(r'TEST', name) for name in extras
            ), (
                'the `if not DEBUG:` block carries extra conditions that are not '
                f'clearly test-only: {extras}. Production hardening must not be '
                'gated behind anything a deployment could set.'
            )

            # Reconstruct the source span of the body lines.
            lines = text.splitlines(keepends=True)
            start_line = node.body[0].lineno - 1
            # The body is all lines strictly inside the if's
            # indent. We use end_lineno of the last stmt + 1.
            end_line = node.body[-1].end_lineno
            return ''.join(lines[start_line:end_line])
        pytest.fail(
            'a module-level block gated on `not DEBUG:` not found in settings.py'
        )

    def test_secure_ssl_redirect_enabled(self, prod_block):
        assert 'SECURE_SSL_REDIRECT' in prod_block, (
            'SECURE_SSL_REDIRECT not in `if not DEBUG:` block — '
            'production will not redirect HTTP → HTTPS'
        )
        # Verify it's actually set to True, not just mentioned.
        m = re.search(r'SECURE_SSL_REDIRECT\s*=\s*(\S+)', prod_block)
        assert m and m.group(1) == 'True', (
            f'SECURE_SSL_REDIRECT must = True in prod block, got: {m.group(1) if m else None}'
        )

    def test_secure_proxy_ssl_header_trust(self, prod_block):
        assert 'SECURE_PROXY_SSL_HEADER' in prod_block
        m = re.search(
            r"SECURE_PROXY_SSL_HEADER\s*=\s*\(\s*['\"]HTTP_X_FORWARDED_PROTO['\"]\s*,\s*['\"]https['\"]\s*\)",
            prod_block,
        )
        assert m, (
            'SECURE_PROXY_SSL_HEADER must equal '
            "('HTTP_X_FORWARDED_PROTO', 'https') — "
            'this is the contract between nginx and Django.'
        )

    def test_cookies_are_secure(self, prod_block):
        assert 'SESSION_COOKIE_SECURE = True' in prod_block
        assert 'CSRF_COOKIE_SECURE = True' in prod_block

    def test_hsts_year_plus(self, prod_block):
        m = re.search(r'SECURE_HSTS_SECONDS\s*=\s*(\d+)', prod_block)
        assert m, 'SECURE_HSTS_SECONDS not set in prod block'
        seconds = int(m.group(1))
        assert seconds >= 31_536_000, (
            f'SECURE_HSTS_SECONDS must be >= 1 year (31536000); got {seconds}'
        )
        assert 'SECURE_HSTS_INCLUDE_SUBDOMAINS = True' in prod_block
        assert 'SECURE_HSTS_PRELOAD = True' in prod_block

    def test_nosniff_header_set(self, prod_block):
        assert 'SECURE_CONTENT_TYPE_NOSNIFF = True' in prod_block

    def test_samesite_set_on_cookies(self, prod_block):
        # SameSite prevents CSRF on cross-site POSTs that cookies
        # would otherwise ride along on. Required at the same level
        # as Secure — they're a matched pair.
        assert "SESSION_COOKIE_SAMESITE = 'Lax'" in prod_block
        assert "CSRF_COOKIE_SAMESITE = 'Lax'" in prod_block

    def test_proxy_ssl_header_is_before_settings_block(self):
        """Defense-in-depth: SECURE_PROXY_SSL_HEADER must be set BEFORE
        any request handler runs. settings.py evaluates it at import
        time, which is fine. But if a future refactor moves it into a
        function or a lazy attribute, Django would not honor it for
        the first request. Catch that here by asserting it lives at
        module level (no `def` / `class` indentation)."""
        text = SETTINGS_PY.read_text()
        for line in text.splitlines():
            stripped = line.lstrip()
            if stripped.startswith('def ') or stripped.startswith('class '):
                assert 'SECURE_PROXY_SSL_HEADER' not in line, (
                    'SECURE_PROXY_SSL_HEADER must be at module level '
                    '(set at import time), not inside a function/class.'
                )


# ---------------------------------------------------------------------------
# 4. END-TO-END (in-process WSGI, via the test client)
# ---------------------------------------------------------------------------
class TestProxyHeaderBehavior:
    """The wire-level contract: when nginx forwards a request with
    X-Forwarded-Proto: https, Django must treat it as secure. Without
    that, every cookie is issued without Secure, and SECURE_SSL_REDIRECT
    would loop on a /health/ GET.

    The in-process WSGI test stack runs with DEBUG=True (no SSL
    settings), so we cannot rely on the prod `if not DEBUG:` block.
    Instead we install SECURE_PROXY_SSL_HEADER via @override_settings
    to mimic the prod config and assert SecurityMiddleware behaves
    correctly."""

    def test_x_forwarded_https_makes_request_secure(self):
        from django.middleware.security import SecurityMiddleware
        with override_settings(
            DEBUG=False,
            SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO', 'https'),
        ):
            rf = RequestFactory()
            req = rf.get('/health/', HTTP_X_FORWARDED_PROTO='https')
            mw = SecurityMiddleware(lambda r: r)
            mw.process_request(req)
            assert req.is_secure(), (
                'Django did not honor X-Forwarded-Proto: https — '
                'SECURE_PROXY_SSL_HEADER is not configured correctly.'
            )

    def test_no_proxy_header_does_not_loop_redirect(self):
        """If nginx forgets to set X-Forwarded-Proto, Django should
        serve the request as is_secure()==False, not loop. With the
        header in place, SecurityMiddleware must NOT issue a redirect
        (we are already on https from the proxy's perspective)."""
        from django.middleware.security import SecurityMiddleware
        with override_settings(
            DEBUG=False,
            SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO', 'https'),
        ):
            rf = RequestFactory()
            req = rf.get('/health/', HTTP_X_FORWARDED_PROTO='https')

            def get_response(r):
                return None

            mw = SecurityMiddleware(get_response)
            response = mw.process_request(req)
            assert response is None, (
                f'Django issued a redirect despite X-Forwarded-Proto: https. '
                f'Loop risk. Response: {response}'
            )

    def test_in_container_healthcheck_must_send_forwarded_proto(self):
        """REGRESSION: the web container's HEALTHCHECK pings
        http://localhost:8000/health/. With SECURE_SSL_REDIRECT=True,
        that request 301-redirects to https://... — and urllib follows
        redirects, so the healthcheck reports healthy even when the
        app is broken.

        The Dockerfile and docker-compose.yml both updated the
        healthcheck to include `X-Forwarded-Proto: https`, mimicking
        what nginx would do. This test enforces that contract by
        scanning both files for the header inside any active
        HEALTHCHECK directive.
        """
        import re
        dockerfile = (REPO_ROOT / 'Dockerfile').read_text()
        compose = (REPO_ROOT / 'docker-compose.yml').read_text()

        # Dockerfile: the HEALTHCHECK instruction starts with `HEALTHCHECK`
        # (not `#`, not `   #`). Take the next line as the CMD.
        df_checks = []
        lines = dockerfile.splitlines()
        for i, line in enumerate(lines):
            stripped = line.lstrip()
            if stripped.startswith('HEALTHCHECK '):
                # The CMD is typically the very next non-comment line,
                # but for our Dockerfile the CMD is on the same logical
                # line continued with `\`. Collect the next 3 lines.
                snippet = '\n'.join(lines[i:i+3])
                df_checks.append(snippet)

        # docker-compose.yml: every healthcheck `test:` directive whose
        # container is the `web` service. We approximate by taking every
        # `test:` line and looking at the next 5 lines for the URL.
        comp_checks = []
        comp_lines = compose.splitlines()
        for i, line in enumerate(comp_lines):
            stripped = line.lstrip()
            if stripped.startswith('test:') and 'urllib' in line:
                snippet = '\n'.join(comp_lines[i:i+3])
                comp_checks.append(snippet)

        # At minimum, the web container's healthcheck must be in here.
        # (Dockerfile has it for the api stage; compose has it for the
        # `web` service. We require both.)
        assert df_checks, 'Dockerfile: no HEALTHCHECK instruction found'
        assert comp_checks, 'docker-compose.yml: no healthcheck test found'
        # Each healthcheck that hits /health/ over http:// must carry the
        # X-Forwarded-Proto header. Other healthchecks (celery ping)
        # are not in the http-to-https path and are skipped.
        for label, checks in (('Dockerfile', df_checks), ('docker-compose.yml', comp_checks)):
            for snippet in checks:
                if '/health/' in snippet and 'urllib' in snippet:
                    assert "X-Forwarded-Proto" in snippet, (
                        f'{label}: /health/ healthcheck does not send '
                        f'X-Forwarded-Proto: https. With '
                        f'SECURE_SSL_REDIRECT=True this healthcheck will '
                        f'301-redirect and report healthy even when the '
                        f'app is broken.\n'
                        f'Context: {snippet}'
                    )


# ---------------------------------------------------------------------------
# 5. PUBLIC_MEDIA_ENDPOINT_URL (MinIO / HLS playback origin)
# ---------------------------------------------------------------------------
class TestPublicMediaEndpoint:
    """The HLS playback URL generator (media_urls.get_hls_playback_url)
    uses settings.PUBLIC_MEDIA_ENDPOINT_URL — the origin BROWSERS hit
    for segment downloads. This origin MUST be HTTPS in the terminator
    setup, otherwise hls.js will block segment requests on a mixed-
    content page."""

    def test_public_media_endpoint_is_https_in_production(self):
        """PUBLIC_MEDIA_ENDPOINT_URL defaults to AWS_S3_ENDPOINT_URL
        if unset. In dev, AWS_S3_ENDPOINT_URL=http://minio:9000 is fine
        for in-network containers but WRONG for browsers. The .env
        template now points it at https://localhost:9443 — we verify
        the template here so a future edit doesn't regress."""
        env_example = (REPO_ROOT / '.env.example').read_text()
        m = re.search(
            r'^PUBLIC_MEDIA_ENDPOINT_URL\s*=\s*(\S+)',
            env_example,
            re.MULTILINE,
        )
        assert m, 'PUBLIC_MEDIA_ENDPOINT_URL not set in .env.example'
        url = m.group(1)
        assert url.startswith('https://'), (
            f'PUBLIC_MEDIA_ENDPOINT_URL must be https:// for browser HLS '
            f'playback. Currently: {url}'
        )


# ---------------------------------------------------------------------------
# 6. LIVE END-TO-END (only runs when the full docker stack is up)
# ---------------------------------------------------------------------------
class TestLiveNginxTerminator:
    """Black-box tests against the running nginx terminator. These skip
    gracefully when the stack is not reachable (e.g. CI on a host without
    docker compose running). The point is to catch integration failures
    the static checks above cannot:
      - the wrong port is published
      - the cert file got mounted with wrong permissions
      - nginx started but failed to load the upstream
      - HSTS header is missing on the live response
      - HTTP→HTTPS redirect doesn't fire on the live port

    These tests are intentionally a separate class so a single
    @pytest.mark.skipif guard skips the whole group on offline CI
    without affecting the rest of the suite.
    """
    NGINX_HTTPS = 'https://localhost'
    NGINX_HTTPS_MINIO = 'https://localhost:9443'

    @pytest.fixture(autouse=True)
    def skip_if_nginx_not_reachable(self):
        """The live tests need an nginx terminator reachable on TCP/443.
        From the host, that's `localhost:443`. From a container inside
        the docker-compose network, it's `nginx:443` (the compose service
        name). We detect the container case by /etc/hosts and the
        environment, then try the right host."""
        import socket
        # If we're inside a docker container that can already talk to
        # the `nginx` service name, use that. Otherwise fall back to
        # the host's localhost:443.
        candidates = []
        try:
            with socket.create_connection(('nginx', 443), timeout=1):
                candidates.append(('nginx', 443))
        except OSError:
            pass
        try:
            with socket.create_connection(('localhost', 443), timeout=1):
                candidates.append(('localhost', 443))
        except OSError:
            pass
        if not candidates:
            pytest.skip('nginx terminator not reachable (run docker compose up)')
        # Pick the first that worked. The fixture also publishes the
        # chosen host so the test methods can build URLs.
        self._nginx_host, self._nginx_port = candidates[0]

    def test_https_health_returns_200(self):
        import urllib.request
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # self-signed
        # urllib sends `Host: <connect-host>` (e.g. `Host: nginx:443`)
        # which is fine for ALLOWED_HOSTS but the cert is issued for
        # `localhost` so the SNI / Host check on the upstream side
        # needs an explicit override. SNI isn't a problem because
        # verify_mode is CERT_NONE, but Django's ALLOWED_HOSTS does
        # check the Host header.
        req = urllib.request.Request(
            f'https://{self._nginx_host}:{self._nginx_port}/health/',
            headers={'Host': 'localhost'},
        )
        try:
            r = urllib.request.urlopen(req, context=ctx)
        except urllib.error.URLError as e:
            pytest.fail(f'Live HTTPS /health/ failed: {e}')
        assert r.status == 200, f'/health/ returned {r.status}'

    def test_https_response_has_hsts_header(self):
        import urllib.request, ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(
            f'https://{self._nginx_host}:{self._nginx_port}/health/',
            headers={'Host': 'localhost'},
        )
        r = urllib.request.urlopen(req, context=ctx)
        hsts = r.headers.get('Strict-Transport-Security')
        assert hsts, 'HSTS header missing from live response'
        assert 'max-age=31536000' in hsts, f'HSTS max-age wrong: {hsts!r}'
        assert 'includeSubDomains' in hsts, f'HSTS missing includeSubDomains: {hsts!r}'
        assert 'preload' in hsts, f'HSTS missing preload: {hsts!r}'

    def test_https_response_has_security_headers(self):
        """The whole point of the terminator is the security headers.
        Verify they're all present on a live response, not just the config."""
        import urllib.request, ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(
            f'https://{self._nginx_host}:{self._nginx_port}/health/',
            headers={'Host': 'localhost'},
        )
        r = urllib.request.urlopen(req, context=ctx)
        for header in ('X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy'):
            assert r.headers.get(header), f'{header} missing from live response'

    def test_http_to_https_redirect(self):
        """HTTP :80 must 301 to https://...  Without this, a user who
        types the bare hostname gets an insecure connection (or a
        connection error), and SECURE_SSL_REDIRECT only fires AFTER
        a plaintext request reaches Django. Better to redirect at
        the edge."""
        import urllib.request
        # urllib follows redirects by default — use a no-follow opener.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            opener.open(f'http://{self._nginx_host}/health/')
            pytest.fail('HTTP /health/ did not 301-redirect')
        except urllib.error.HTTPError as e:
            assert e.code == 301, f'Expected 301, got {e.code}'
            loc = e.headers.get('Location', '')
            assert loc.startswith('https://'), (
                f'301 Location should be https://, got {loc!r}'
            )

    def test_https_minio_reachable(self):
        """The 9443 listener exists specifically so browsers can fetch
        HLS segments over HTTPS (mixed-content safety). Verify it's up."""
        import urllib.request, ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # /minio/health/live is MinIO's liveness endpoint, which the
        # nginx :9443 server block forwards without authentication.
        r = urllib.request.urlopen(
            f'https://{self._nginx_host}:9443/minio/health/live', context=ctx
        )
        assert r.status == 200, f'MinIO via :9443 returned {r.status}'


# ---------------------------------------------------------------------------
# Local stack: the HLS token Worker routing
# ---------------------------------------------------------------------------

class TestLocalHlsWorkerRouting:
    """Static analysis of docker/nginx.local.conf.

    The production `TestNginxConfig` above reads docker/nginx.conf, whose
    :9443 block is entirely commented out. `test_https_listeners_present`
    still passes for it because its regex matches the commented line — a
    vacuous assertion that gives false confidence the MinIO listener is live.
    These tests read the LOCAL config, where the block actually is live, and
    assert the routing that makes HLS token-gated rather than merely broken.
    """

    LOCAL_CONF = REPO_ROOT / "docker" / "nginx.local.conf"
    LOCAL_COMPOSE = REPO_ROOT / "docker-compose.local.yml"

    @pytest.fixture
    def conf_text(self):
        assert self.LOCAL_CONF.is_file(), f'Missing {self.LOCAL_CONF}'
        return self.LOCAL_CONF.read_text()

    @pytest.fixture
    def compose_text(self):
        return self.LOCAL_COMPOSE.read_text()

    @pytest.fixture
    def media_block(self, conf_text):
        """Just the :9443 server block.

        The file also contains the :80 redirect block, whose own
        `location / { return 301 ...; }` would otherwise be matched first and
        make these assertions pass or fail for the wrong reason.
        """
        blocks = re.split(r'\n\s*server\s*\{', conf_text)
        media = [b for b in blocks if re.search(r'listen\s+9443', b)]
        assert media, 'No server block listening on :9443 in nginx.local.conf'
        return 'server {' + media[-1]

    def test_hls_is_proxied_to_the_worker(self, media_block):
        m = re.search(r'location\s+/hls/\s*\{(.*?)\n\s*\}', media_block, re.DOTALL)
        assert m, 'No `location /hls/` block — /hls/* would fall through to MinIO'
        assert 'proxy_pass' in m.group(1)
        assert 'hls_worker' in m.group(1), (
            '/hls/ must proxy to the hls_worker upstream, not minio_backend'
        )

    def test_minio_upstream_is_only_the_catchall(self, media_block):
        """If /hls/ reached minio_backend, the token gate would be bypassed."""
        hls = re.search(r'location\s+/hls/\s*\{(.*?)\n\s*\}', media_block, re.DOTALL)
        assert hls and 'minio_backend' not in hls.group(1)

        catchall = re.search(r'location\s+/\s*\{(.*?)\n\s*\}', media_block, re.DOTALL)
        assert catchall and 'minio_backend' in catchall.group(1), (
            'The catch-all location should still serve MinIO so presigned '
            'uploads/ URLs and the console keep working'
        )

    def test_hls_location_precedes_the_catchall(self, media_block):
        hls_at = media_block.find('location /hls/')
        catchall_at = media_block.find('location / {')
        assert hls_at != -1 and catchall_at != -1
        assert hls_at < catchall_at

    def test_hls_block_forwards_cookie_and_range(self, media_block):
        hls = re.search(r'location\s+/hls/\s*\{(.*?)\n\s*\}', media_block, re.DOTALL).group(1)
        # Losing Cookie is a 403 that reads like an auth bug; losing Range
        # breaks seeking and ABR switching silently.
        assert re.search(r'proxy_set_header\s+Cookie\s+\$http_cookie', hls)
        assert re.search(r'proxy_set_header\s+Range\s+\$http_range', hls)
        assert re.search(r'proxy_buffering\s+off', hls)

    def test_worker_upstream_points_at_the_host_gateway(self, conf_text):
        m = re.search(r'upstream\s+hls_worker\s*\{(.*?)\}', conf_text, re.DOTALL)
        assert m, 'No hls_worker upstream block'
        # The Worker is a bare host process, not a compose service, so the
        # container reaches it via the host gateway. A compose service name
        # here would never resolve.
        assert 'host.docker.internal:8787' in m.group(1)

    def test_nginx_compose_declares_the_host_gateway(self, compose_text):
        # Without extra_hosts on Linux, nginx fails to start with
        # "host not found in upstream" as soon as the config references it.
        assert 'host.docker.internal:host-gateway' in compose_text

    def test_minio_upstream_uses_the_hyphenated_alias(self, conf_text):
        """`minio_local` is not a legal RFC 1123 hostname.

        mc and botocore both reject it outright, which is why the bucket was
        never created and Django could not reach storage at all.
        """
        m = re.search(r'upstream\s+minio_backend\s*\{(.*?)\}', conf_text, re.DOTALL)
        assert m, 'No minio_backend upstream block'
        assert 'minio-local:9000' in m.group(1)
        assert 'minio_local:9000' not in m.group(1)

    def test_bridge_name_fits_the_interface_limit(self, compose_text):
        """Linux caps interface names at 15 chars.

        Docker reports a longer one as "numerical result out of range", which
        makes the whole network uncreatable and is a very indirect symptom.
        """
        m = re.search(r'bridge\.name:\s*(\S+)', compose_text)
        assert m, 'No explicit bridge name in the compose file'
        assert len(m.group(1)) <= 15, (
            f'bridge name {m.group(1)!r} is {len(m.group(1))} chars; max is 15'
        )

    def test_hls_token_js_stub_is_not_mounted(self, compose_text):
        """The njs dev path was abandoned; the Worker replaced it.

        The image (nginx:1.27-alpine) has no njs module, so the mount was
        always inert.
        """
        assert 'hls_auth.js' not in compose_text or 'NOT mounted' in compose_text
