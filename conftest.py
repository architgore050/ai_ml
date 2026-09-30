"""Pytest fixtures and configuration for the EchoFlow test suite.

ALL tests run against PostgreSQL inside the Docker `web` container.
No SQLite fallback, no stub migrations, no bare-metal test mode.

The test database is `echoflow_test` — created automatically on first
run by this conftest (using psycopg2 to connect to the Postgres instance
and CREATE DATABASE). It is dropped on session teardown.

Pgvector extension is installed on `template1` so every CREATE DATABASE
inherits it — no migration hackery needed.
"""
import os
import sys
import time
from pathlib import Path

# Set required env vars BEFORE django.setup() — settings.py reads them.
os.environ.setdefault('DJANGO_SECRET_KEY', 'test-secret-key-not-for-prod')
os.environ.setdefault('DJANGO_DEBUG', 'True')
os.environ.setdefault('AWS_STORAGE_BUCKET_NAME', 'test-bucket')
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'test')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'test')

# RevenueCat test defaults (no real API calls in unit tests).
os.environ.setdefault('REVENUECAT_SECRET_KEY', '')
os.environ.setdefault('REVENUECAT_PUBLIC_KEY', 'test-public-key')
os.environ.setdefault('REVENUECAT_PROJECT_TOKEN', 'test-project')
os.environ.setdefault('REVENUECAT_ENTITLEMENT_ID', 'pro')
os.environ.setdefault('REVENUECAT_SYNC_INTERVAL_MINUTES', '360')
# Point the suite at the TEST database, reached on POSTGRES DIRECTLY.
#
# The app goes through pgbouncer (or, in the local stack, straight to
# `db_local`), but pgbouncer whitelists only DB_NAME, so CREATE DATABASE and
# CREATE EXTENSION for the test DB are refused through it. That is why
# TEST_DB_HOST/TEST_DB_PORT exist separately from DB_HOST/DB_PORT rather than
# being derived by guessing "strip the pgbouncer token off the hostname" --
# the postgres service is called `db` in one stack and `db_local` in another,
# and no amount of string surgery on the app's URL knows which.
#
# Everything here comes from the environment. Nothing is hardcoded: the
# service names, the port and the test DB name all differ per stack, and a
# hardcoded one made the suite unrunnable outside the main compose project
# ("could not translate host name \"db\"").
import urllib.parse as _urlparse


def _env(name, default=None, required=True):
    value = os.environ.get(name, default)
    if not value and required:
        raise RuntimeError(
            f'[conftest] {name} is not set. The test harness needs it to reach '
            f'postgres directly. It is defined in .env / .env.example — see '
            f'TEST_DB_HOST, TEST_DB_PORT, TEST_DB_NAME.'
        )
    return value


TEST_DB_NAME = _env('TEST_DB_NAME', 'echoflow_test', required=False)
TEST_DB_HOST = _env('TEST_DB_HOST', 'db')
TEST_DB_PORT = _env('TEST_DB_PORT', '5432', required=False)

_existing_url = os.environ.get('DATABASE_URL', '')
if _existing_url:
    _parsed = _urlparse.urlparse(_existing_url)
    # Keep the credentials from the app's own URL (they are the same role);
    # replace only host, port and database name.
    _netloc_host = f'{TEST_DB_HOST}:{TEST_DB_PORT}'
    if _parsed.username:
        _netloc_host = (
            f'{_parsed.username}:{_parsed.password}@{_netloc_host}'
            if _parsed.password else f'{_parsed.username}@{_netloc_host}'
        )
    _test_url = _urlparse.urlunparse(
        _parsed._replace(netloc=_netloc_host, path=f'/{TEST_DB_NAME}'))
    os.environ['DATABASE_URL'] = _test_url
    # Also set PG* env vars that some tooling reads directly (bypasses
    # Django's settings cache when subprocesses are spawned).
    os.environ['PGHOST'] = TEST_DB_HOST
    os.environ['PGPORT'] = str(TEST_DB_PORT)
    os.environ['PGDATABASE'] = TEST_DB_NAME
    print(f'[conftest] DATABASE_URL overridden to: {_test_url}', file=sys.stderr)
# RevenueCat test defaults (no real API calls in unit tests).
os.environ.setdefault('REVENUECAT_SECRET_KEY', '')
os.environ.setdefault('REVENUECAT_PUBLIC_KEY', 'test-public-key')
os.environ.setdefault('REVENUECAT_PROJECT_TOKEN', 'test-project')
os.environ.setdefault('REVENUECAT_ENTITLEMENT_ID', 'pro')
os.environ.setdefault('REVENUECAT_SYNC_INTERVAL_MINUTES', '360')

# Add the repo root to sys.path so 'backend.EchoFlow.settings' resolves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import django
from django.conf import settings

django.setup()

# Force test database name. Conftest auto-creates `echoflow_test` if it
# doesn't exist, so the real migrations run against a clean Postgres DB.
# This is the root-cause fix for the previous 178 `auth_group does not exist`
# errors: we no longer fight pytest-django's hook ordering with SQLite
# overrides. We just use Postgres with real migrations.
import sys as _sys
print(f'[conftest] BEFORE override: NAME={settings.DATABASES["default"].get("NAME")!r}', file=_sys.stderr)
if settings.DATABASES['default'].get('NAME') != TEST_DB_NAME:
    db = settings.DATABASES['default'].copy()
    db['NAME'] = TEST_DB_NAME
    # Also set TEST['NAME'] so pytest-django doesn't re-prefix with 'test_'
    if 'TEST' not in db:
        db['TEST'] = {}
    db['TEST']['NAME'] = TEST_DB_NAME
    # Bypass pgbouncer for tests: it whitelists only `echoflow_db`.
    db['HOST'] = TEST_DB_HOST
    db['PORT'] = TEST_DB_PORT
    settings.DATABASES['default'] = db
print(f'[conftest] AFTER override: NAME={settings.DATABASES["default"].get("NAME")!r} HOST={settings.DATABASES["default"].get("HOST")!r}', file=sys.stderr)


import psycopg2
import pytest
import sys as _sys

print(f'[conftest] Final DATABASES: {settings.DATABASES["default"]!r}', file=_sys.stderr)
print(f'[conftest] env DATABASE_URL: {os.environ.get("DATABASE_URL")}', file=_sys.stderr)

# Patch dj_database_url.config so any later re-eval of settings.py gets
# the test-DB values too.
import dj_database_url as _dju
_orig_config = _dju.config


def _patched_config(*args, **kwargs):
    result = _orig_config(*args, **kwargs)
    if isinstance(result, dict) and 'HOST' in result:
        result['HOST'] = TEST_DB_HOST
        result['PORT'] = TEST_DB_PORT
        result['NAME'] = TEST_DB_NAME
    return result
_dju.config = _patched_config

# Patch the existing default DatabaseWrapper's settings_dict. pytest-django
# instantiates DatabaseWrapper from the original DATABASES dict at startup;
# our conftest override of settings.DATABASES doesn't reach into the
# wrapper's settings_dict. We patch it directly so the wrapper's
# get_connection_params() returns the TEST_DB_* values.
from django.db import connection as _default_connection
from contextlib import contextmanager
from django.test.utils import CaptureQueriesContext
_orig_settings_dict = _default_connection.settings_dict
_default_connection.settings_dict = {
    **_orig_settings_dict,
    'HOST': TEST_DB_HOST,
    'PORT': TEST_DB_PORT,
    'NAME': TEST_DB_NAME,
    'TEST': {**_orig_settings_dict.get('TEST', {}), 'NAME': TEST_DB_NAME},
}
# Also reset the cached connection so the next ensure_connection uses
# the new settings.
_default_connection.connection = None
print(f'[conftest] Patched default connection settings_dict: '
      f'HOST={_default_connection.settings_dict.get("HOST")} '
      f'NAME={_default_connection.settings_dict.get("NAME")}', file=_sys.stderr)


def _install_pgvector_on_template1():
    """Install pgvector extension on template1 so every new DB inherits it.

    The real 0001_initial.py runs `CREATE EXTENSION IF NOT EXISTS vector;`
    which is Postgres-only. By installing it on template1, every CREATE
    DATABASE (including echoflow_test) is born with `vector` already loaded.
    """
    db = settings.DATABASES['default']
    if not db.get('ENGINE', '').endswith('postgresql'):
        return

    target_user = db.get('USER', '')
    target_password = db.get('PASSWORD', '')
    target_host = db.get('HOST', '') or 'localhost'
    target_port = db.get('PORT', '') or TEST_DB_PORT

    # Connect to template1 as the test DB user to install pgvector.
    # If that user lacks superuser privileges, fall back to connecting
    # as the default postgres superuser (common in Docker setups).
    admin_user = target_user or 'postgres'
    admin_password = target_password or ''
    admin_host = target_host or 'localhost'
    admin_port = target_port or str(TEST_DB_PORT)

    try:
        admin_conn = psycopg2.connect(
            host=admin_host,
            port=admin_port,
            user=admin_user,
            password=admin_password,
            dbname='template1',
        )
    except psycopg2.OperationalError:
        # Fallback: try connecting without password (trust auth)
        try:
            admin_conn = psycopg2.connect(
                host=admin_host,
                port=admin_port,
                user=admin_user,
                dbname='template1',
            )
        except psycopg2.OperationalError:
            # If we can't connect to template1, pgvector may already be
            # installed or the test user has superuser on the target DB.
            # Skip — tests will fail with a clear error if extension is missing.
            return

    admin_conn.autocommit = True
    try:
        with admin_conn.cursor() as cur:
            cur.execute('CREATE EXTENSION IF NOT EXISTS vector;')
    finally:
        admin_conn.close()


def _create_test_database():
    """Create `echoflow_test` if it doesn't already exist.

    Connects to the Postgres instance (defaulting to `postgres` DB) and
    runs CREATE DATABASE if the test DB is missing. This lets developers
    run tests without manually creating the DB first.
    """
    db = settings.DATABASES['default']
    test_name = db.get('NAME', TEST_DB_NAME)
    if not test_name:
        return

    if not db.get('ENGINE', '').endswith('postgresql'):
        return

    target_user = db.get('USER', 'postgres')
    target_password = db.get('PASSWORD', '')
    target_host = db.get('HOST', 'localhost') or 'localhost'
    target_port = db.get('PORT', TEST_DB_PORT) or TEST_DB_PORT

    # Connect to the default `postgres` DB to check/create the test DB.
    try:
        admin_conn = psycopg2.connect(
            host=target_host,
            port=target_port,
            user=target_user,
            password=target_password,
            dbname='postgres',
        )
    except psycopg2.OperationalError:
        # Fallback: try without password
        try:
            admin_conn = psycopg2.connect(
                host=target_host,
                port=target_port,
                user=target_user,
                dbname='postgres',
            )
        except psycopg2.OperationalError:
            # Can't connect — assume DB exists or will be created by CI.
            return

    admin_conn.autocommit = True
    try:
        with admin_conn.cursor() as cur:
            # Check if test DB exists
            cur.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s;",
                (test_name,),
            )
            if not cur.fetchone():
                cur.execute(f'CREATE DATABASE "{test_name}";')
    finally:
        admin_conn.close()


def _drop_test_database():
    """Drop `echoflow_test` on session teardown (optional cleanup).

    Only drops connections if the test DB exists. Skips silently if
    the DB doesn't exist or we can't connect.
    """
    db = settings.DATABASES['default']
    test_name = db.get('NAME', TEST_DB_NAME)
    if not test_name:
        return

    if not db.get('ENGINE', '').endswith('postgresql'):
        return

    target_user = db.get('USER', 'postgres')
    target_password = db.get('PASSWORD', '')
    target_host = db.get('HOST', 'localhost') or 'localhost'
    target_port = db.get('PORT', TEST_DB_PORT) or TEST_DB_PORT

    try:
        admin_conn = psycopg2.connect(
            host=target_host,
            port=target_port,
            user=target_user,
            password=target_password,
            dbname='postgres',
        )
    except psycopg2.OperationalError:
        return

    admin_conn.autocommit = True
    try:
        with admin_conn.cursor() as cur:
            # Terminate existing connections first
            cur.execute(
                """SELECT pg_terminate_backend(pid)
                   FROM pg_stat_activity
                   WHERE datname = %s AND pid <> pg_backend_pid();""",
                (test_name,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{test_name}";')
    finally:
        admin_conn.close()


@pytest.hookimpl(hookwrapper=True)
def pytest_sessionstart(session):
    """Install pgvector on template1 and create echoflow_test DB."""
    _install_pgvector_on_template1()
    _create_test_database()
    yield


@pytest.hookimpl(hookwrapper=True)
def pytest_sessionfinish(session, exitstatus):
    """Drop echoflow_test DB on session teardown.

    Set ECHOFLOW_KEEP_TEST_DB=1 to skip the drop (handy when iterating on
    schema changes — keeps the DB between runs).
    """
    yield
    if not os.environ.get('ECHOFLOW_KEEP_TEST_DB'):
        _drop_test_database()


# ---------------------------------------------------------------------------
# Query-count assertion that excludes per-request middleware overhead
# ---------------------------------------------------------------------------

#: The audit table written by ``CorrelationIdMiddleware``'s ``finally`` block.
AUDIT_LOG_TABLE = "app_auditlog"


@contextmanager
def assert_view_queries(num, connection=None):
    """``assertNumQueries(num)``, minus the audit-log INSERT.

    Why this exists
    ---------------
    ``CorrelationIdMiddleware`` writes one ``AuditLog`` row per request. It
    passed ``user=<int>`` into a ``ForeignKey``, so the INSERT raised
    ``ValueError`` on every authenticated request, the bare ``except``
    swallowed it, and **no audit row was ever written** -- the audit table
    recorded anonymous traffic and nothing else.

    Fixing that (commit ``c12f16b``) made the write real. It now reaches
    Postgres on every request, which added exactly one INSERT to every
    ``assertNumQueries`` budget in the suite and broke 20 assertions.

    Those 20 are measuring the **view**, not the middleware. In
    ``test_tags_initialize_bounds.py`` the assertion is literally
    ``assertNumQueries(0)``: the structural proof that a rejected payload
    never reaches the ORM at all. Raising the budget to ``1`` would destroy
    precisely the property it exists to pin -- and would re-break on the next
    middleware change, because the coupling would still be there.

    So the expected numbers stay exactly what they were: count the queries,
    then subtract the audit write. The intent of every assertion is
    preserved, and none of them is coupled to the middleware stack.

    A budget is *not* a substitute for reading the failure message: the
    message below lists the queries that were counted, excluding the audit
    INSERT, so a regression names its own SQL.
    """
    conn = connection if connection is not None else _default_connection
    with CaptureQueriesContext(conn) as ctx:
        yield
    captured = ctx.captured_queries
    audit = [q for q in captured if AUDIT_LOG_TABLE in q["sql"]]
    counted = [q for q in captured if AUDIT_LOG_TABLE not in q["sql"]]
    detail = "\n".join(f"  {q['sql'][:200]}" for q in counted) or "  (none)"
    assert len(counted) == num, (
        f"Expected {num} view quer{'y' if num == 1 else 'ies'}, got "
        f"{len(counted)} "
        f"({len(audit)} middleware audit INSERT(s) excluded).\n{detail}"
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def user(django_user_model):
    """A standard active user."""
    return django_user_model.objects.create_user(
        username='alice', email='alice@example.com', password='test-pass-1234'
    )


@pytest.fixture
def other_user(django_user_model):
    """A second user for social tests (follow, share, comment)."""
    return django_user_model.objects.create_user(
        username='bob', email='bob@example.com', password='test-pass-1234'
    )


@pytest.fixture
def api_client():
    """An unauthenticated DRF test client."""
    from rest_framework.test import APIClient
    return APIClient()


@pytest.fixture
def auth_client(api_client, user):
    """An authenticated DRF test client (logged in as `user`)."""
    api_client.force_authenticate(user=user)
    return api_client


@pytest.fixture
def ready_clip(user):
    """An AudioClip in 'ready' state with valid vectors."""
    from backend.app.models import AudioClip
    return AudioClip.objects.create(
        title='Test Clip',
        category='comedy',
        creator=user,
        status='ready',
        duration_ms=60_000,
        likes=0, shares=0, skips=0, comment_count=0,
        semantic_vector=[0.1] * 384,
        acoustic_vector=[0.1] * 128,
    )


@pytest.fixture
def processing_clip(user):
    """An AudioClip in 'processing' state (for cleanup_stuck_processing tests).

    The cleanup_stuck_processing task uses created_at to detect clips
    older than `threshold_minutes`. We set created_at to 30 min ago so
    the task considers this clip stuck. (AudioClip has auto_now_add=True
    on created_at, so we must use .update() to bypass the auto-set.)
    """
    from backend.app.models import AudioClip
    from django.utils import timezone
    from datetime import timedelta
    old = timezone.now() - timedelta(minutes=30)
    clip = AudioClip.objects.create(
        title='Stuck Clip',
        category='comedy',
        creator=user,
        status='processing',
        duration_ms=60_000,
    )
    # Bypass auto_now_add by writing directly via .update().
    AudioClip.objects.filter(pk=clip.pk).update(created_at=old)
    clip.refresh_from_db()
    return clip


# ---------------------------------------------------------------------------
# Throttle-budget isolation
# ---------------------------------------------------------------------------

@pytest.fixture
def clear_throttle_cache():
    """Reset DRF throttle counters around a test that makes many requests.

    Why this exists
    ---------------
    The DRF throttle cache is real Redis (``settings.CACHES`` uses
    ``django_redis.cache.RedisCache``), and nothing in this suite clears it.
    So rate-limit budgets accumulate across the whole run *and persist between
    runs*. The first symptom was a set of authorization tests that passed
    alone and failed in a larger combined run: an unrelated file had already
    consumed the shared ``user`` (1000/hour) budget, so the endpoint under
    test answered 429. An authorization test must not be able to fail because
    an unrelated test spent its rate limit.

    Why a retry
    -----------
    Redis on a loaded dev host answers in 300-900ms and occasionally times
    out. Skipping on the first ``RedisError`` therefore turned a transient
    blip into a *silent loss of security coverage* — a test file that reported
    "4 skipped" and nobody read. So: retry a few times, and only skip if
    Redis is genuinely unreachable. If Redis is down, DRF throttling would
    fail the requests anyway, so skipping is more honest than a cascade of
    500s.

    Usage: request it explicitly (``def test_x(self, clear_throttle_cache)``)
    rather than applying it suite-wide, because most tests do not make enough
    requests to care and the clear is not free.
    """
    from django.core.cache import cache
    from redis.exceptions import RedisError

    # Measured on the dev host: 300-930ms per Redis round trip, with
    # occasional timeouts under load. Three tight retries was not enough —
    # runs still reported "2 skipped" intermittently, which is the failure
    # mode this fixture exists to remove.
    def _clear(attempts=6, base_delay=0.5):
        """Return True on success, or the last RedisError on giving up."""
        last = None
        for attempt in range(attempts):
            try:
                cache.clear()
                return True
            except RedisError as exc:
                last = exc
                time.sleep(base_delay * (attempt + 1))
        return last

    problem = _clear()
    if problem is not True:
        # FAIL, not skip.
        #
        # A skip here is a lie of convenience: the test asserts a security
        # property (who may be issued a playback token, which share token
        # unlocks which clip), and a skipped security test reads exactly like
        # a passing one in a summary line. Measured evidence that this
        # happened: a run reporting "27 passed, 4 skipped" that nobody read,
        # where the 4 were share-token scope tests.
        #
        # A loud failure on a wedged Redis is the correct trade here. It is
        # also honest: DRF touches the throttle cache on every one of these
        # requests, so with Redis down the assertions are not merely
        # unverified — the endpoints would not function. If this becomes a
        # problem on a constrained CI runner, the fix is a faster Redis, not
        # a quieter fixture.
        pytest.fail(
            "redis unavailable after retries; refusing to skip a test that "
            f"asserts an authorization property (last error: {problem!r})"
        )
    yield
    try:
        cache.clear()
    except RedisError:
        pass
