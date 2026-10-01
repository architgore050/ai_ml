import os
from pathlib import Path
import dj_database_url
from celery.schedules import crontab
from django.core.exceptions import ImproperlyConfigured
# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent


# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/6.0/howto/deployment/checklist/

# SECURITY WARNING: keep the secret key used in production secret!
# DECISION: Fail fast on missing DJANGO_SECRET_KEY. Generating a random
# key per process would silently break session/CSRF/signature
# verification across the gunicorn + Celery fleet — every worker would
# have a different key.
#
# DECISION (placeholder guard): also fail on a *documentation* placeholder.
# `if not SECRET_KEY` only catches the empty string, and every tracked env
# template ships `DJANGO_SECRET_KEY=change-me-to-a-long-random-string`
# (.env.example, .env.vps.example) or `<same-as-vps>` (.env.laptop.example).
# An operator who copies an example and deploys it unchanged gets a key that
# is public knowledge in this repository, which breaks session and CSRF
# signing, password-reset tokens, and every `django.core.signing.Signer` use.
#
# The predicate and the escape hatch live in `EchoFlow/secrets.py` so that
# `app/services/hls_token.py` and this module share one vocabulary instead of
# one importing the other. See that module's docstring for the two documented
# bypasses (`ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS=1` and `DJANGO_DEBUG=true`)
# and for the false positives the substring rule accepts on purpose.
from backend.EchoFlow.secrets import require_real_secret, testing_enabled

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    raise ImproperlyConfigured(
        "DJANGO_SECRET_KEY is not set. Application cannot start without it."
    )
SECRET_KEY = require_real_secret(
    "DJANGO_SECRET_KEY",
    SECRET_KEY,
    purpose="Django's signing key (sessions, CSRF, password resets)",
    generate=(
        'python -c "import secrets; print(secrets.token_urlsafe(64))"'
    ),
)

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = os.environ.get('DJANGO_DEBUG', 'False').lower() == 'true'

ALLOWED_HOSTS = os.environ.get('DJANGO_ALLOWED_HOSTS', 'localhost').split(',')
CORS_ALLOWED_ORIGINS = os.environ.get('DJANGO_CORS_ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:5173,http://localhost:3021').split(',')
# DECISION: CORS_ALLOW_ALL_ORIGINS is hard-coded to False; the env-driven
# allowlist above is the single source of truth. Previously this line was
# read from DJANGO_CORS_ALL env var but then unconditionally reassigned
# to False on line 63, making the env var dead code. Removed for clarity.
CORS_ALLOW_ALL_ORIGINS = False

# CORS: match every path EXCEPT /admin/ and /metrics/, which no browser
# origin legitimately calls.
#
# HISTORY — this was previously r'$.^' ("match nothing"), on the reasoning
# that the origin allowlist would still be applied "to all responses that
# flow through its check_origin method". That method does not exist.
# django-cors-headers 4.9.0 gates the entire middleware on
#     is_enabled = re.match(CORS_URLS_REGEX, path_info) or check_signal(req)
# and check_signal() only fires the `check_request_enabled` signal, to which
# nothing in this repo subscribes. So the regex matched nothing, is_enabled
# was always False, and NO response ever carried Access-Control-*.
# In production the frontend is a separate origin by design
# (Cloudflare Pages app.echoflow.in -> API api.echoflow.in), so every
# browser request was rejected at preflight and the deployed app could not
# function at all.
#
# The regex is NOT the security boundary and must not be treated as one.
# CORS_ALLOWED_ORIGINS (above) is: a response only gets
# Access-Control-Allow-Origin when the request's Origin is allowlisted, and
# CORS_ALLOW_ALL_ORIGINS is False. Sending headers to a non-allowlisted
# origin is inert — that origin's JS cannot read them.
#
# Note /auth/ is deliberately NOT excluded, despite an earlier comment
# suggesting it. Login and token refresh are cross-origin browser calls; the
# same is true of /media/playback-token/ for the HLS cookie handshake.
CORS_URLS_REGEX = r'^(?!/(admin|metrics)/).*$'

# Required for the HLS handshake: the playback-token endpoint sets the
# HttpOnly `ef_hls_token` cookie and the client sends
# `credentials: 'include'` (see frontend/src/api/client.ts getPlaybackToken).
# Without this the browser drops the Set-Cookie and every /hls/* request 403s
# even with a valid token. Safe alongside the allowlist: the library echoes
# the specific allowlisted origin, never `*`.
CORS_ALLOW_CREDENTIALS = True

CORS_ALLOW_METHODS = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',  # required for preflight requests
]
CELERY_BROKER_HEARTBEAT = 120 # Increase to 2 minutes
CELERY_BROKER_HEARTBEAT_CHECKRATE = 2

CORS_ALLOW_HEADERS = [
    'accept',
    'authorization',
    'content-type',
    'origin',
    'range',   # ← critical for HLS: browsers send Range headers for partial content
]

CORS_EXPOSE_HEADERS = [
    'Content-Range',   # ← browser needs this to know segment boundaries
    'Accept-Ranges',
    # ← the client is required to honour 429 backoff. DRF sends this on every
    #   throttle response; without exposing it the browser hides it from JS
    #   on a cross-origin request and the client cannot back off.
    'Retry-After',
]

# Application definition
SITE_ID = 1
INSTALLED_APPS = [
    'django_prometheus',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.postgres',  # required for pgvector HnswIndex system checks
    'django_filters',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework.authtoken',
    'rest_framework_simplejwt',
    # SECURITY: token_blacklist enables ROTATE_REFRESH_TOKENS + BLACKLIST_AFTER_ROTATION
    # so a leaked refresh token can be invalidated (used by the /auth/logout/ endpoint).
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',#for frontend
    'storages',#S3-compatible MEDIA storage — see STORAGES["default"] below
    ##
    
    # Local Apps
    'backend.app',
    ##
    'django_redis',
    'django.contrib.sites',
    'allauth',
    'allauth.account',
    'allauth.socialaccount',
    'allauth.socialaccount.providers.google',
    'dj_rest_auth',
    #'rest_framework_simplejwt',
    'dj_rest_auth.registration',
    'django_celery_beat',
    
    
]

MIDDLEWARE = [
    'django_prometheus.middleware.PrometheusBeforeMiddleware',
    'corsheaders.middleware.CorsMiddleware',##
    # CorrelationIdMiddleware is high in the stack so it runs before
    # SecurityMiddleware (which can short-circuit with SECURE_SSL_REDIRECT
    # in production) — every request, even 301s, gets a correlation id.
    'backend.EchoFlow.middleware.CorrelationIdMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'allauth.account.middleware.AccountMiddleware',##
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'django_prometheus.middleware.PrometheusAfterMiddleware',
]

ROOT_URLCONF = 'backend.EchoFlow.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'backend.EchoFlow.wsgi.application'


# Database
# https://docs.djangoproject.com/en/6.0/ref/settings/#databases

DATABASES = {
    'default': dj_database_url.config(
            default=os.environ.get('DATABASE_URL', ''),
            conn_max_age=600,
            conn_health_checks=True,
        )
}
# SEC: per-session safety timeouts. Without these, a single slow
# query (e.g. update_global_metrics over a large AudioClip table) or
# a stuck transaction can hold a backend connection indefinitely.
# With PgBouncer's DEFAULT_POOL_SIZE=25 in front of web/celery, 25
# slow queries would exhaust the pool and the app would stop
# accepting new connections. Each timeout trades a worse error
# (QueryCanceled / lock timeout / fatal "terminating connection due
# to idle-in-transaction timeout") for a better failure mode: the
# connection is freed and the request returns a 5xx the caller can
# retry. See docs/backend-bug-fixs.md item A1 and
# docs/EXPLAIN/decisions/partial-issues-completion-plan.md §1 for
# trade-off analysis.
#
# DECISION: apply these GUCs via the psycopg2 `options='-c ...'`
# connection string. Two requirements to make this work behind
# pgbouncer transaction mode:
#   1. pgbouncer's `ignore_startup_parameters` (set in
#      docker-compose.yml as IGNORE_STARTUP_PARAMETERS=...) must
#      include each of these GUC names. Without that whitelist,
#      pgbouncer rejects the connection at startup with
#        FATAL: unsupported startup parameter in options: statement_timeout
#      and every web/celery container crashes before its first query.
#      pgbouncer does NOT apply these settings itself — it only
#      ignores the unknown name so the client request can pass
#      through to Postgres, which honors the `-c` prefix.
#   2. `connect_timeout` is a libpq *connection* parameter (passed
#      to PQconnectdb), NOT a GUC. It MUST be a top-level psycopg2
#      kwarg. Putting it inside the `-c ...` string raises
#        `unrecognized configuration parameter "connect_timeout"`
#      because the server tries to SET it like a GUC and fails.
#
# The `options`/`connect_timeout` kwargs are psycopg2-specific;
# SQLite (used in tests) does not accept them. Skip when the engine
# is not Postgres. `dj_database_url` may return an empty dict when
# DATABASE_URL is unset; check the engine key to be safe.
if DATABASES['default'].get('ENGINE', '').endswith('postgresql'):
    if 'OPTIONS' not in DATABASES['default']:
        DATABASES['default']['OPTIONS'] = {}
    DATABASES['default']['OPTIONS']['options'] = (
        '-c statement_timeout=30s '
        '-c idle_in_transaction_session_timeout=60s '
        '-c lock_timeout=10s'
    )
    DATABASES['default']['OPTIONS']['connect_timeout'] = 10

# DECISION (placeholder guard): the *effective* database password is guarded
# here, and the earlier claim that it was not reachable in-process was wrong.
#
# `settings.py` does not read the `DB_PASSWORD` env var — it builds DATABASES
# with `dj_database_url.config(DATABASE_URL)`, and every compose file builds
# `DATABASE_URL` *from* `DB_PASSWORD`::
#
#     DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}
#
# so the value the process actually authenticates with is
# `DATABASES['default']['PASSWORD']`. Checking the env var NAME was checking
# the wrong thing: the name is genuinely absent from this module, and the
# secret is not. It is checked here rather than at the top of the file
# because this is the first point at which the value exists.
#
# `.env.example` and `.env.vps.example` ship `DB_PASSWORD=change-me-strong-password`
# and `.env.laptop.example` ships `DB_PASSWORD=<same-as-vps>`, both committed to
# this repository in plain text, so a deployment that copies a template
# unchanged hands anyone who has read the repo the whole database: every user
# row, every password hash, and the DPDP §8(5) erasure records.
#
# An EMPTY password is not a placeholder failure and is deliberately not
# treated as one. There is no `if not SECRET_KEY` raise above for the same
# reason: bare-metal development against a local Postgres that trusts the
# socket, or a `DATABASE_URL` with no credential at all, is a legitimate
# configuration. What is rejected is a value that looks like documentation.
# `require_real_secret` applies the same two documented bypasses as
# `DJANGO_SECRET_KEY` and the Redis passwords — see `EchoFlow/secrets.py`.
_DB_PASSWORD = DATABASES['default'].get('PASSWORD')
if _DB_PASSWORD:
    DATABASES['default']['PASSWORD'] = require_real_secret(
        "DB_PASSWORD",
        _DB_PASSWORD,
        purpose=(
            "the PostgreSQL server (every table, every user row, password "
            "hashes and the DPDP §8(5) erasure records)"
        ),
        generate='python -c "import secrets; print(secrets.token_urlsafe(32))"',
    )

# DECISION: optional 'read' connection for routing pure reads to a
# PostgreSQL streaming replica. See backend/app/db_routers.py and
# docs/EXPLAIN/database/05-read-replica-design.md. The replica is not
# provisioned by docker-compose yet; when READ_DATABASE_URL is unset,
# the router falls back to 'default' and the existing single-DB
# behavior is preserved unchanged. When set, every read on the 'app'
# app that is NOT inside transaction.atomic() and NOT a SELECT FOR
# UPDATE goes to the replica.
if os.environ.get('READ_DATABASE_URL'):
    DATABASES['read'] = dj_database_url.config(
        default=os.environ.get('READ_DATABASE_URL', ''),
        conn_max_age=600,
        # SECURITY: the replica is intended to be read-only. We set the
        # connection option as a defense in depth — if a bug ever causes
        # a write to be routed to 'read' (e.g. router bug, or a
        # developer manually using 'read' from a Celery task), Postgres
        # will refuse the write with
        # `ERROR: cannot execute INSERT in a read-only transaction`.
        conn_health_checks=True,
    )
    # Same psycopg2 `options` parameter pattern as the default
    # connection. Pre-PR, the read block passed `options={...}` as
    # a kwarg to dj_database_url.config(), which the library does
    # not accept — settings would crash the moment READ_DATABASE_URL
    # was set. Fixing in this PR to unblock the A5 read-replica
    # activation plan. Only apply when the engine is Postgres.
    if DATABASES['read'].get('ENGINE', '').endswith('postgresql'):
        if 'OPTIONS' not in DATABASES['read']:
            DATABASES['read']['OPTIONS'] = {}
        DATABASES['read']['OPTIONS']['options'] = '-c default_transaction_read_only=on'

# DECISION: register ReadRouter only when the replica is configured.
# Enabling the router without READ_DATABASE_URL set would route reads
# to a non-existent connection and every read would fail with
# "connection does not exist" — a worse failure mode than today.
if 'read' in DATABASES:
    DATABASE_ROUTERS = ['backend.app.db_routers.ReadRouter']

REDIS_URL_DEFAULT = 'redis://localhost:6379/1'
REDIS_URL = os.getenv("REDIS_URL", REDIS_URL_DEFAULT)

# Build Redis URL from components if full URL not provided
def build_redis_url(prefix: str) -> str:
    """Build Redis URL from individual components.

    Components exist at all because Redis passwords in this repo are base64
    and contain `+`, `/` and `=`, which break Kombo's URL parsing. So
    `{prefix}_HOST` / `_PORT` / `_PASSWORD` are the compose-managed form and
    the URL is assembled (and password-encoded) here.

    DECISION (fail closed on a missing credential): the old code was

        if host and password:
            return f"redis://:{quote(password)}@{host}:{port}/0"
        return REDIS_URL

    so `HOST` set with a blank `PASSWORD` silently returned `REDIS_URL` —
    whose default is the *unauthenticated* `redis://localhost:6379/1`. That
    is a fail-open on a credential: no log, no warning, and it lands on a
    different server than the one that was configured. A known password is
    better than no password and an operator error, so this now raises.

    The legitimate password-less case — neither `HOST` nor `PASSWORD` set,
    which is bare-metal `redis-server` on localhost — is untouched and still
    falls back to `REDIS_URL`.
    """
    from urllib.parse import quote

    host = os.getenv(f"{prefix}_HOST")
    port = os.getenv(f"{prefix}_PORT", "6379")
    # `not password` misses whitespace-only, which is truthy and would produce
    # a URL with an empty credential — a silent fail-open again.
    password = (os.getenv(f"{prefix}_PASSWORD") or "").strip()
    if host and not password:
        raise ImproperlyConfigured(
            f"{prefix}_HOST is set to {host!r} but {prefix}_PASSWORD is empty. "
            f"Refusing to fall back to REDIS_URL ({REDIS_URL!r}), which is "
            f"usually an unauthenticated local Redis: that would be a "
            f"fail-open on a credential — silent, and pointed at a different "
            f"server than the one you configured. Either set {prefix}_PASSWORD "
            f"to the value in the Redis service's config, or unset "
            f"{prefix}_HOST as well to use the single-Redis REDIS_URL form "
            f"for non-Docker development."
        )
    if host and password:
        # DECISION (placeholder guard): a non-empty password is not
        # automatically a real one. `.env.vps.example` ships
        # `REDIS_BROKER_PASSWORD=change-me-strong-password` and
        # `.env.laptop.example` ships `<same-as-vps>` for both, so a copied
        # template would otherwise give anyone who has read this repository
        # full access to the broker (arbitrary task injection) and the cache.
        # Reusing `require_real_secret` keeps one vocabulary across
        # DJANGO_SECRET_KEY, MEDIA_TOKEN_SECRET and these two.
        password = require_real_secret(
            f"{prefix}_PASSWORD",
            password,
            purpose=(
                f"the {prefix.lower()} Redis service (task injection and "
                f"cache/session contents)"
            ),
            generate=(
                f"python -c \"import secrets; "
                f"print(secrets.token_urlsafe(32))\""
            ),
        )
        # URL-encode the password to handle special characters
        encoded_password = quote(password, safe='')
        return f"redis://:{encoded_password}@{host}:{port}/0"
    return REDIS_URL


def resolve_redis_url(prefix: str) -> str:
    """Resolve a Redis URL, with an explicit and non-obvious precedence.

    DECISION (2026-09-29): ``{prefix}_HOST`` wins over ``{prefix}_URL``.

    This inverts what the code did before, and the reason is that the old
    order was actively wrong. Every compose service sets::

        REDIS_BROKER_HOST: redis_broker_local
        REDIS_BROKER_PORT: 6379

    deliberately, because Redis passwords here contain base64 characters
    (``+``, ``/``, ``=``) that break Kombo URL parsing — that split exists
    precisely so the password is URL-encoded at use time. But the
    assignment read::

        REDIS_BROKER_URL = os.getenv("REDIS_BROKER_URL", build_redis_url("REDIS_BROKER"))

    so a *stale* ``REDIS_BROKER_URL`` left in ``.env.local`` silently
    overrode the host compose had just specified, defeating the split.

    Consequence found the hard way: the local stack was publishing to a
    broker belonging to a *different* compose project, so two independent
    codebases raced for the same ``celery`` queue. Six identical task
    publishes gave 2 SUCCESS and 4 NotRegistered — the foreign worker wins
    the coin flip and rejects task names it does not know. That presents as
    "my new Celery task never runs", which is a very misleading symptom for
    a stale env var.

    All three shipped env templates set exactly one form, so this changes
    nothing for them:
      * ``.env.example``         — neither, relies on HOST/PORT
      * ``.env.vps.example``     — URL only, no HOST
      * ``.env.laptop.example``  — URL only, no HOST

    Order: HOST/PORT (compose-managed) > URL (hand-written templates) >
    ``REDIS_URL`` (single-Redis non-Docker dev).
    """
    if os.getenv(f"{prefix}_HOST"):
        built = build_redis_url(prefix)
        if built != REDIS_URL:
            return built
    return os.getenv(f"{prefix}_URL") or REDIS_URL

# DECISION: Two Redis URLs in Docker (broker vs cache) so a feed-queue spike
# can't evict queued Celery tasks and vice versa. In Docker compose the broker
# runs with `--maxmemory-policy noeviction` (can't lose queued tasks) and the
# cache with `allkeys-lru` (feed queues evictable since refill is idempotent).
# Non-Docker dev collapses both to REDIS_URL — a single Redis on localhost is
# fine for one developer.
REDIS_BROKER_URL = resolve_redis_url("REDIS_BROKER")
REDIS_CACHE_URL = resolve_redis_url("REDIS_CACHE")


# DECISION (2026-09-30): under the test suite the cache moves to its own Redis
# database index, so a test run cannot destroy live development state.
#
# `django_redis.cache.RedisCache.clear()` is FLUSHDB, not a prefix scan, and
# conftest's `clear_throttle_cache` calls it precisely so one file's rate-limit
# spend cannot fail another. Against the default index that is a FLUSHDB of the
# *live* cache: throttle budgets, `user_feed:*` queues, `user_vectors:*` and
# every `clip:*` counter go together. `counter_store.drain()` (`KEYS clip:*` +
# `DEL`) is a second door into that same shared keyspace, so two concurrent
# runs delete each other's state even without a flush. Postgres is already
# isolated per run by TEST_DB_NAME, which is what made this read as flakiness
# rather than as a gap: three runs of identical, unmodified code produced three
# different failure sets.
#
# WHY IT LIVES HERE AND NOT IN conftest.py: pytest-django calls
# `django.setup()` from its own `pytest_load_initial_conftests`, while
# `_pytest.config`'s implementation of that same hook is `trylast`, so the
# rootdir conftest's module body has not run yet. An `os.environ[...]` assigned
# there cannot reach CACHES — this module is imported *inside*
# `django.setup()`. `backend/app/tests/test_redis_isolation.py` pins both
# halves of that claim (the env var does work; a late one provably does not).
#
# The gate is `testing_enabled()`, the signal `secrets.py` already uses: true
# under pytest, or with `ECHOFLOW_TESTING=1`. Neither is set by any compose
# file, so gunicorn and all four Celery services keep the configured index.
#
# Precedence, all read from the process environment at settings-import time so
# that `docker compose exec -e TEST_REDIS_CACHE_DB=14` works:
#   TEST_REDIS_CACHE_URL  a full URL, for a CI runner with its own Redis
#   TEST_REDIS_CACHE_DB   the index alone, which keeps the base64 password
#                         (it contains `+`, `/` and `=`) out of the command line
#   default               TEST_REDIS_CACHE_DB_DEFAULT
#
# Index 0 is refused rather than honoured: in every stack it *is* the live
# cache, so accepting it would be the defect rather than an escape from it.
# The default is 13 because 0 is the live cache and 14/15 are FLUSHed by the
# `redis_scratch` fixture in `test_telemetry_flush_integrity.py`; the server
# ships `databases 16`, so 1-13 are unclaimed.
TEST_REDIS_CACHE_DB_DEFAULT = 13


def resolve_test_redis_cache_url(resolved: str) -> str:
    """Point a resolved cache URL at this test run's own Redis database.

    ``resolved`` is the cache URL as the *process* would use it in production;
    only the database path component is replaced, so the host and the
    percent-encoded credential compose supplied are carried through untouched.
    That is deliberate — an index swap must not become a different server,
    because `tasks.flush_telemetry_stream` builds its own client from
    `CACHES['default']['LOCATION']` and the end-to-end tests need real Redis.

    Splitting the URL with ``str.rpartition('/')`` would be wrong: in
    ``redis://host:6379`` the last ``/`` precedes the *port*.
    """
    from urllib.parse import urlsplit, urlunsplit

    override = (os.getenv("TEST_REDIS_CACHE_URL") or "").strip()
    if override:
        return override

    raw = (os.getenv("TEST_REDIS_CACHE_DB") or "").strip()
    if not raw:
        index = TEST_REDIS_CACHE_DB_DEFAULT
    else:
        try:
            index = int(raw)
        except ValueError:
            raise ImproperlyConfigured(
                f"TEST_REDIS_CACHE_DB={raw!r} is not an integer database index. "
                "A value that does not parse would leave the suite on the live "
                "cache index, which is the failure this setting exists to "
                "prevent. Redis here serves 16 databases: use 1-15."
            )
        if not 1 <= index <= 15:
            raise ImproperlyConfigured(
                f"TEST_REDIS_CACHE_DB={index} is out of range. Index 0 is the "
                "live development cache in every stack, and flushing it is the "
                "defect this setting exists to prevent. Redis here serves 16 "
                "databases: use 1-15."
            )

    parts = urlsplit(resolved)
    return urlunsplit(parts._replace(path=f"/{index}"))


if testing_enabled():
    REDIS_CACHE_URL = resolve_test_redis_cache_url(REDIS_CACHE_URL)

# DECISION (2026-09-30): the *broker* is deliberately NOT retargeted for
# tests, unlike the cache above. Nothing in the suite publishes to a real
# broker — every reachable path is stubbed at the seam the code reads
# (`services.uploads.publish`, `tasks.sync_revenuecat_entitlements`) and
# `tasks.py`'s own `.delay()` only runs inside a worker. The one consumer that
# does talk to a real Redis, `flush_telemetry_stream`, builds its client from
# `CACHES['default']['LOCATION']`, i.e. the cache, so it is already isolated.
# Moving the broker would put test-published tasks in a database no worker
# reads (silent, unbounded accumulation) and would desynchronise
# `celery inspect ping` (the compose worker healthcheck) and
# `views/system_health.py` from the Redis the tests were writing to.

# This is how you connect Redis to Django
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_CACHE_URL,
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        }
   }
}
CELERY_TASK_ROUTES = {
    'backend.app.tasks.process_audio_to_hls': {'queue': 'heavy_media'},
    'backend.app.tasks.refill_user_feed': {'queue': 'fast_feed'},
}
# 3. CELERY CONFIGURATION
CELERY_BROKER_URL = REDIS_BROKER_URL
CELERY_RESULT_BACKEND = REDIS_BROKER_URL
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_WORKER_STATE_DB = None
CELERY_WORKER_POOL = 'prefork'
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_ACKNOWLEDGE_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True

# 4. MEDIA FILES (uploaded originals + generated HLS segments)
#
# DIAGNOSIS: every media bug this week (dead /media/ route under DEBUG=False,
# celery_media unable to see files web wrote, the wrong image entirely being
# served to a worker) traced back to one root assumption: that every
# container processing a clip shares one filesystem with the container that
# received the upload. That's only true in this specific docker-compose
# setup, and only true today because of a dev-convenience bind mount — it is
# NOT true of a real deployment (separate machines/nodes for web vs workers,
# autoscaled worker pools, no shared disk). Rather than keep patching volume
# paths to make the shared-filesystem assumption hold a little longer, we're
# removing the assumption: media now lives in S3-compatible object storage
# that every container reaches over the network, identically, in every
# environment. No shared volume, no bind-mount coincidence, no "works on my
# machine" — MEDIA_ROOT / FileSystemStorage no longer used for user content
# at all.
MEDIA_URL = '/media/'  # unused by S3Storage (which generates its own URLs);
                       # kept only because a few Django internals reference it
# DECISION: 300s default (5 min). EchoFlow is short-form audio.
MAX_DURATION_SECONDS = int(os.getenv('MAX_DURATION_SECONDS', '300'))

# Password validation
# https://docs.djangoproject.com/en/6.0/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# Celery Beat — periodic task schedule
CELERY_BEAT_SCHEDULE = {
    'update-global-metrics': {
        'task': 'backend.app.tasks.update_global_metrics',
        'schedule': 300.0,  # every 5 minutes
    },
    'evolve-user-baselines': {
        # DECISION: Hourly is too aggressive — with limit=100 per user and
        # select_related('clip'), this scans 100 interactions per user per
        # hour. At 100k users that's 10M interaction reads/hour. Daily (86400s)
        # is the design intent. Use crontab in django_celery_beat for 3:00 AM
        # if exact timing matters.
        'task': 'backend.app.tasks.evolve_long_term_user_baselines',
        'schedule': 86400.0,  # every 24 hours
    },
    'cleanup-stuck-processing': {
        # SECURITY/RELIABILITY: A clip stuck in 'processing' past 15 minutes
        # means its Celery task never completed (Redis broker hiccup, worker
        # OOM, network drop). Without this task the clip is abandoned.
        # Re-enqueue and let the retry decorators handle transient failures.
        'task': 'backend.app.tasks.cleanup_stuck_processing',
        'schedule': 300.0,  # every 5 minutes
    },
    'flush-telemetry-stream': {
        # Stream consumer. Primary path. XREADGROUP drains
        # stream:interaction.events every 10s with 5s BLOCK, dedups
        # via processed_event:{event_id} SETNX (24h TTL), bulk-inserts
        # UserInteraction rows, XACKs, and routes poison messages to
        # stream:interaction.events:dlq. Fast cadence is cheap with
        # consumer groups; replaces the per-request row-lock contention
        # that the architecture audit flags as the #1 scalability risk.
        'task': 'backend.app.tasks.flush_telemetry_stream',
        'schedule': 10.0,  # every 10 seconds
    },
    'flush-telemetry-legacy': {
        # Legacy LIST consumer. Kept for one operational cycle as a
        # safety net while the stream consumer proves itself. Drains
        # the 'telemetry:queue' Redis list (the producer's LIST fallback
        # when ECHOFLOW_TELEMETRY_STREAM=off or the stream is unhealthy).
        # TODO: remove after one cycle of stable operation.
        'task': 'backend.app.tasks.flush_telemetry_legacy',
        'schedule': 30.0,  # every 30 seconds
    },
    'rebuild-global-exploit-pool': {
        # P2.2: Global candidate pool. Single SELECT + ZADD rebuild
        # of the feed:exploit_pool ZSET. See
        # backend/app/services/feed_pool.py and
        # docs/EXPLAIN/recommendation/03-feed-pre-computation.md.
        'task': 'backend.app.tasks.rebuild_global_exploit_pool',
        'schedule': 300.0,  # every 5 minutes
    },
    'dispatch-user-pool-rebuilds': {
        # P2.2: Per-user explore pool fan-out. Runs hourly;
        # internally enqueues per-user rebuilds with a 0..3600s
        # countdown so the workers absorb them gradually.
        'task': 'backend.app.tasks.dispatch_user_pool_rebuilds',
        'schedule': 3600.0,  # every hour
    },
    'cleanup-orphan-hls': {
        # Group B item 12: defense-in-depth for post_delete signal
        # failures. Scans hls/ for prefixes whose clip_id is not
        # in AudioClip and deletes them. Bounded to 1000/run so
        # a runaway situation cannot page the operator. Daily at
        # 03:00 UTC (off-peak; uses crontab below instead of float
        # schedule to pin the hour).
        'task': 'backend.app.tasks.cleanup_orphan_hls',
        'schedule': crontab(minute=0, hour=3),
    },
    'flush-counters-to-pg': {
        # Group B item 9: drain the Redis counter store and apply
        # to Postgres (or just drain during Phase 1 dual-write).
        # Every 5 minutes; matches update_global_metrics cadence.
        # Phase 1 (default): the F() in UserInteraction.save() also
        # runs, so this task is a read-and-discard. Phase 2 (set
        # ECHOFLOW_DUAL_WRITE_COUNTERS=False in compose env): the
        # F() is bypassed and this task becomes the only path.
        'task': 'backend.app.tasks.flush_counters_to_pg',
        'schedule': 300.0,
    },
    'sync-revenuecat-entitlements': {
        # Pro subscription sync via RevenueCat REST API polling.
        # Polls every REVENUECAT_SYNC_INTERVAL_MINUTES (default: 360 = 6h).
        # No webhooks in Phase 1 (free RevenueCat plan limitation).
        'task': 'backend.app.tasks.sync_revenuecat_entitlements',
        'schedule': int(os.environ.get('REVENUECAT_SYNC_INTERVAL_MINUTES', '360')) * 60,
    },
}
CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'


# Feed candidate pool — pre-computation knobs
# (Group A item 7 in docs/unfixed-issues-2026-09-03.md)
# See docs/EXPLAIN/recommendation/03-feed-pre-computation.md for the
# full design (memory cost, staleness budget, fallback contract).
FEED_POOL_GLOBAL_TOP_N = int(os.environ.get('FEED_POOL_GLOBAL_TOP_N', '10000'))
FEED_POOL_USER_TOP_N = int(os.environ.get('FEED_POOL_USER_TOP_N', '1000'))
FEED_POOL_GLOBAL_TTL = int(os.environ.get('FEED_POOL_GLOBAL_TTL', '300'))
FEED_POOL_USER_TTL = int(os.environ.get('FEED_POOL_USER_TTL', '86400'))
FEED_POOL_REBUILD_CHUNK_SIZE = int(
    os.environ.get('FEED_POOL_REBUILD_CHUNK_SIZE', '1000')
)


# Internationalization
# https://docs.djangoproject.com/en/6.0/topics/i18n/

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/6.0/howto/static-files/

STATIC_URL = 'static/'
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')

# Enable WhiteNoise's compression and caching features.
# DECISION: STORAGES dict, not STATICFILES_STORAGE — that setting was removed
# in Django 5.1 and is silently ignored (no manifest would ever be generated).
STORAGES = {
    # Object storage, not the local disk — every service (web, every celery
    # worker, beat) reaches this over the network identically, so nothing
    # depends on which container wrote a file or which container reads it
    # back. Works against real S3, Cloudflare R2, or (for local dev) MinIO —
    # anything speaking the S3 API. See docker-compose.yml's `minio` service
    # for the local equivalent, and .env.example for the required vars.
    "default": {
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": os.environ["AWS_STORAGE_BUCKET_NAME"],
            "region_name": os.getenv("AWS_S3_REGION_NAME", "auto"),
            # None -> talks to real AWS S3. Set to MinIO/R2's endpoint for
            # anything else. This one var is the entire prod/dev difference —
            # there is no separate code path for "local mode".
            "endpoint_url": os.getenv("AWS_S3_ENDPOINT_URL") or None,
            "access_key": os.environ["AWS_ACCESS_KEY_ID"],
            "secret_key": os.environ["AWS_SECRET_ACCESS_KEY"],
            # Bucket is private. We hand out short-lived signed URLs instead
            # of a public bucket + permanent links, so a leaked/scraped URL
            # stops working after AWS_S3_QUERYSTRING_EXPIRE seconds.
            "default_acl": None,
            "querystring_auth": True,
            "querystring_expire": int(os.getenv("AWS_S3_QUERYSTRING_EXPIRE", "3600")),
            "file_overwrite": False,
            # path-style addressing (bucket.region.host/bucket/key style off)
            # is required for MinIO and most non-AWS S3-compatible endpoints;
            # real AWS accepts it too, so one setting covers both.
            "addressing_style": "path",
        },
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"
    },
}

# SECURITY / REGULATORY: Enforce India S3 region for DPDP / RBI compliance.
# DECISION: Runtime assertion rather than silent fallback; production must
# explicitly set ap-south-1 (or ap-south-2) or the app fails to start.
assert STORAGES["default"]["OPTIONS"]["region_name"] in ("ap-south-1", "ap-south-2", "auto"), 'STORAGES region must be set to ap-south-1, ap-south-2 (AWS S3 / DPDP / RBI) or "auto" (Cloudflare R2). Set AWS_S3_REGION_NAME in .env.'
# PUBLIC_MEDIA_ENDPOINT_URL: the endpoint a BROWSER can actually reach, as
# opposed to AWS_S3_ENDPOINT_URL above (which is what containers use to talk
# to the bucket over the Docker-internal network). These are frequently
# different hosts even in production — e.g. app servers reaching storage over
# a private/VPC endpoint while users need a public-facing URL — so this
# isn't a dev-only hack, it's the general shape of the problem.
#
# Locally: AWS_S3_ENDPOINT_URL=http://minio:9000 (container DNS name),
# PUBLIC_MEDIA_ENDPOINT_URL=http://localhost:9000 (host-published port) —
# same MinIO instance, reached two different ways depending on who's asking.
# In prod against real S3 these are typically identical (or you leave
# PUBLIC_MEDIA_ENDPOINT_URL unset and it falls back to AWS_S3_ENDPOINT_URL).
PUBLIC_MEDIA_ENDPOINT_URL = os.getenv("PUBLIC_MEDIA_ENDPOINT_URL") or os.getenv("AWS_S3_ENDPOINT_URL") or None

# PUBLIC_HLS_ENDPOINT_URL: the origin a BROWSER uses for HLS playlists and
# segments, which in a token-gated deployment is the validating EDGE (the
# Cloudflare Worker on media.echoflow.in, or the Worker via nginx on
# :9443/:19443 locally) — not the object store.
#
# This is deliberately a SEPARATE setting from PUBLIC_MEDIA_ENDPOINT_URL and
# the two must not be collapsed:
#
#   PUBLIC_HLS_ENDPOINT_URL    -> edge origin. HLS URLs are BUCKET-LESS,
#                                 because an edge that fronts the bucket
#                                 (an R2 custom domain, or the Worker) does
#                                 not expose the bucket as a path segment.
#   PUBLIC_MEDIA_ENDPOINT_URL  -> raw storage origin. Presigned `uploads/`
#                                 URLs need the bucket in the path, and the
#                                 edge serves nothing but /hls/*.
#
# Consequence: setting this to a host OTHER than the one serving the API also
# requires MEDIA_TOKEN_COOKIE_DOMAIN (below) to be set, or the token cookie
# will be host-only and never sent to the media host. Those two are a pair.
#
# Unset -> falls back to PUBLIC_MEDIA_ENDPOINT_URL, which preserves the
# previous bucket-prefixed behaviour for deployments with no edge in front.
PUBLIC_HLS_ENDPOINT_URL = os.getenv("PUBLIC_HLS_ENDPOINT_URL") or PUBLIC_MEDIA_ENDPOINT_URL

# HLS_URL_STYLE: whether the bucket is a path segment in browser-facing HLS
# URLs. Two shapes exist, and guessing between them is how this broke before:
#
#   "bucket" -> {origin}/{bucket}/hls/...   plain S3/MinIO, nothing in front
#   "edge"   -> {origin}/hls/...            the bucket is fronted by a
#                                            validating edge (Cloudflare Worker
#                                            on media.echoflow.in, or the
#                                            Worker via nginx locally), and
#                                            such an edge does NOT expose the
#                                            bucket as a path segment
#
# Defaults to "edge" when PUBLIC_HLS_ENDPOINT_URL is set, else "bucket", so
# existing deployments are unchanged and pointing HLS at an edge is all that
# is needed. Set it explicitly to override.
HLS_URL_STYLE = os.getenv("HLS_URL_STYLE") or (
    "edge" if os.getenv("PUBLIC_HLS_ENDPOINT_URL") else "bucket"
)

# HLS token protection settings (see docs/EXPLAIN/storage/04-hls-token-protection.md)
# MEDIA_TOKEN_SECRET: HMAC signing key shared between Django (token issuance)
#   and the Cloudflare Worker (token validation). Must be identical or all HLS
#   playback returns 403. The Worker fails loudly at /healthz when unset;
#   it cannot detect a *mismatched* value, so scripts/run-hls-worker-local.sh
#   generates the Worker's .dev.vars from this same value.
# MEDIA_TOKEN_TTL_SECONDS: token lifetime in seconds (default 600 = 10 min).
# MEDIA_TOKEN_COOKIE_DOMAIN: cookie Domain attribute. Leave empty for dev
#   (localhost does not support domain cookies). REQUIRED in prod when the
#   media origin is a different host from the API (api.echoflow.in issuing
#   for media.echoflow.in) — see the note above.
MEDIA_TOKEN_SECRET = os.getenv("MEDIA_TOKEN_SECRET", "")
MEDIA_TOKEN_TTL_SECONDS = int(os.getenv("MEDIA_TOKEN_TTL_SECONDS", "600"))
# A4 (2026-09-29) — share tokens. A shared link must survive being passed
# around, so it lives for days; MEDIA_TOKEN_TTL_SECONDS (600s) is sized for
# a stream currently playing and is deliberately NOT reused here.
#
# 30 days is a deliberate middle ground, not "forever". `exp` is the only
# automatic revocation mechanism this design has: when a clip is un-approved
# (an ISSUE-04 takedown) or a share is regretted, nothing else invalidates a
# token already in someone's hand. At 600s that self-heals in minutes; at
# forever it never does. 30 days keeps a shared link useful while bounding
# the exposure window, at no extra implementation cost.
SHARE_TOKEN_TTL_SECONDS = int(os.getenv("SHARE_TOKEN_TTL_SECONDS", str(30 * 24 * 3600)))
# PUBLIC_APP_BASE_URL: the origin that shared clip links point at. Kept
# separate from PUBLIC_HLS_ENDPOINT_URL because that one is the *media*
# origin and is deliberately bucket-less/edge-shaped; prepending an API or
# media base to a share link is a bug the AGENTS.md notes have already been
# made in two frontends.
#
# If unset, the share-link endpoint returns a relative path plus the raw
# token rather than inventing an absolute URL. Emitting a plausible-looking
# but wrong absolute link is worse than emitting an obviously incomplete one,
# because the client would not check.
PUBLIC_APP_BASE_URL = (os.getenv("PUBLIC_APP_BASE_URL") or "").rstrip("/")
MEDIA_TOKEN_COOKIE_DOMAIN = os.getenv("MEDIA_TOKEN_COOKIE_DOMAIN", "")
AUTH_USER_MODEL = 'app.User' # for Custom user model
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

REST_FRAMEWORK = {
    # SECURITY (identity, not rate): how many proxies sit in front of Django.
    #
    # Unset (None) makes `BaseThrottle.get_ident` fall through to
    # `''.join(xff.split()) if xff else remote_addr` — the *whole*
    # client-supplied X-Forwarded-For header as the throttle identity. nginx
    # APPENDS to that header (`$proxy_add_x_forwarded_for`), so a client
    # sending `X-Forwarded-For: 9.9.9.9` reaches DRF as `9.9.9.9,<real-ip>`
    # and every distinct value is a brand-new, never-before-seen bucket. One
    # header defeated every IP-keyed limit here (login 10/min, anon
    # 100/hour, register 200/hour, clip_public 120/min) with no volume and no
    # infrastructure pressure. Measured, not theorised: the pre-fix key for
    # the login endpoint was literally `throttle_login_9.9.9.9,203.0.113.7`.
    #
    # 1 is correct: there is exactly one nginx in front
    # (docs/EXPLAIN/docker/05-https-tls-termination.md), and with
    # `num_proxies == 1` DRF takes the `addrs[-min(1, len(addrs))]` branch,
    # i.e. the LAST hop — the one nginx appended from `$remote_addr`. The
    # earlier entries are whatever the client sent and are never consulted.
    #
    # This is the *backstop*, not the complete fix. It only reads
    # X-Forwarded-For, it validates nothing, and it silently re-breaks if a
    # second proxy is ever placed in front. `backend.app.throttling.
    # TrustedProxyRateThrottle` resolves the identity through
    # `EchoFlow.client_ip.get_client_ip` instead (X-Real-IP first, which nginx
    # overwrites and which therefore cannot be spoofed through the
    # terminator, each candidate validated as a real IP). Prefer it for any
    # new throttle.
    #
    # If a second proxy is added, this must become 2. Nothing errors if it
    # does not — the bypass just quietly returns.
    'NUM_PROXIES': 1,
    # SECURITY: a dead cache must not be a 500.
    #
    # `django_redis` raises `ConnectionInterrupted`, which subclasses bare
    # `Exception` and not `APIException`, so DRF's default handler returns
    # None, the exception is re-raised, and every throttled endpoint (and
    # anything else that reads the cache) answers 500 — a full traceback page
    # when DJANGO_DEBUG=True. 503 is honest and retryable; 500 tells the
    # client the request is broken, and fail-*open* (allow) would delete the
    # rate limit for exactly as long as the outage lasts. The handler
    # delegates every non-Redis exception to DRF's own, unchanged.
    #
    # `backend.app.throttling.TrustedProxyRateThrottle.allow_request` raises
    # the same 503 independently, so the two custom throttles do not depend on
    # this key being present.
    'EXCEPTION_HANDLER': 'backend.EchoFlow.exception_handlers.cache_unavailable_handler',
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ],
    # SECURITY: per-scope rates for abuse-prone endpoints. Each ViewSet
    # opts in with `throttle_scope = 'X'` to inherit its rate. These are
    # defaults — the architecture audit calls log_telemetry the #1 abuse
    # vector (viewbot / engagement-velocity manipulation), so its rate is
    # the tightest. Override via env vars if needed.
    'DEFAULT_THROTTLE_RATES': {
        'anon': '100/hour',
        'user': '1000/hour',
        'telemetry': '60/min',      # log_telemetry: 1/second max sustained
        'upload': '20/hour',        # AudioUploadViewSet.create: prevent storage abuse
        # Registration is anonymous, so the key has to be the caller's IP.
        # Raised 5 -> 200 on 2026-09-28: 5/hour/IP caps new-user signup
        # behind a single mobile carrier NAT gateway rather than capping an
        # attacker. The per-IP cap on actual spam is now carried by
        # 'register_username' below, which is per-account and therefore
        # cannot be shared by unrelated users behind one NAT.
        'register': '200/hour',
        # Per-username, applied alongside 'register' by RegisterView. Catches
        # what the IP key cannot express: one host cycling through many
        # usernames, and the repeated re-registration used to squat or
        # reclaim a handle. 3/hour leaves room for a genuine user who typos a
        # name twice and then succeeds on the third attempt.
        'register_username': '3/hour',
        'login': '10/min',          # TokenObtainPairView: prevent credential stuffing
        # Per-username, applied alongside 'login' by ThrottledTokenObtainPairView.
        # 'login' has to stay IP-keyed — it is the credential-stuffing gate and
        # login is anonymous, so unlike token refresh there is no verified
        # subject to key on — but one IP is a carrier NAT gateway on a mobile
        # network, so 10/min is one budget for everyone behind that address.
        # This is the half of the gate that is not NAT-bound: one account, one
        # bucket. 10/hour is far above a human's real behaviour (a handful of
        # typos, then success) and 60x below what a credential-stuffing run
        # needs against a single account.
        'login_username': '10/hour',
        # Per VERIFIED refresh-token subject, not per IP — see
        # backend/app/throttling.py. Sized for a 15-minute access token: ~4
        # refreshes/hour is the steady state, so 120/hour is ~30x headroom
        # for clock skew, retries and multi-device sign-in, while still
        # bounding a single abusive token.
        'token_refresh': '120/hour',
        'comment': '60/hour',       # CommentViewSet.create
        'share_send': '100/hour',   # ShareViewSet.send_share (anti-spam)
        'share_poll': '1000/hour',  # ShareViewSet inbox/unread/mark-read (client polling)
        'interaction': '60/min',    # toggle_like, register_skip
        'legal': '30/hour',       # ComplianceContactView / TakedownRequestView (issue-03/05)
        'grievance': '10/hour',   # GrievanceCreateView (issue-03)
        'data_subject': '5/hour', # DataSubjectAccessView / Erasure (issue-06)
        'subscription_sync': '10/hour',  # manual RevenueCat sync trigger
        # A3 (2026-09-29): PlaybackTokenView previously declared no
        # throttle_scope, so ScopedRateThrottle silently allowed everything
        # and the endpoint fell through to the shared `user` (1000/hour)
        # bucket — which a scrolling feed burns at ~1 token per clip.
        # 300/min is sized for a fast scroll (a clip every ~200ms is far
        # beyond human play rate) while leaving headroom for a user
        # flipping through a long feed plus retries. Scoped rather than
        # IP-keyed: the caller is authenticated here, so keying on the
        # verified principal is both stricter and NAT-safe.
        'playback_token':      '300/min',
        # A4 (2026-09-29). These five actions previously inherited 'upload'
        # (20/hour) because the viewset declared one scope for everything.
        # A shared link's landing page 429ing after 20 views is a share
        # feature that appears to work and then silently stops.
        #
        # 'clip_public' is generous and IP-keyed: it is unauthenticated, and
        # a chat client re-fetches a preview. 'clip_play' is 60/min because a
        # legitimate recipient presses play once; the cap exists to stop a
        # harvested share link being used as a token-minting oracle.
        # 'clip_approve' is tight — it triggers HLS encoding, i.e. compute.
        'clip_public':         '120/min',
        'clip_play':           '60/min',
        'share_link':          '60/hour',
        'clip_report':         '20/hour',
        'clip_approve':        '20/hour',
        # FIX (2026-09-29): reads on a clip. Before this, `GET /clips/{id}/` and
        # `GET /clips/` resolved to the 'upload' scope (20/hour) because the
        # per-action map in views/content.py was keyed on url_path while DRF
        # sets self.action to the method name, so no custom action ever matched
        # and every read fell through to the upload cap. A client polling clip
        # status during an HLS encode (mobile Phase 5 upload pipeline) 429s
        # after 20 polls. Reads are cheap and not storage-abuse vectors, so
        # they get their own bucket rather than sharing the upload cap.
        'clip_read':           '120/min',
        # TagsViewSet (2026-09-30). The viewset declared NO throttle_scope at
        # all, and ScopedRateThrottle.allow_request returns True — no counter,
        # no accounting — when the view it is asked about has no scope. Both of
        # its actions ran on the shared `user` (1000/hour) bucket alone.
        #
        # 'tags_initialize' is the one that matters: it OR's one JSONB
        # containment clause per selected tag (up to _MAX_SELECTED_TAGS = 20)
        # across app_audioclip — which has no GIN index on `tags`, so every
        # clause is a sequential-scan containment check — and publishes a
        # refill_user_feed task on each success. A free account could therefore
        # loop the one-shot cold-start endpoint as a read amplifier and as a
        # Celery task-fan-out amplifier. 10/hour: the product flow is one
        # submit per account for the whole of onboarding, so 10 leaves room for
        # a double-tap, a retry after a dropped response, and a user
        # deliberately re-running it, while bounding the fan-out to something
        # that cannot saturate a worker queue. Analogous existing rates:
        # register_username 3/hour (per-account spam), clip_approve 20/hour
        # (triggers a compute-heavy encode).
        #
        # 'tags_available' is a read, but not a cheap or a free one: it
        # aggregates the whole eligible corpus (jsonb_array_elements + GROUP BY)
        # and it is the only endpoint that discloses the corpus's tag
        # vocabulary, so it is bounded well below the generic 1000/hour and
        # well below 'clip_read' (120/min — a single-row lookup). 60/hour is
        # ~6x what a user needs at one call per modal open, which is the only
        # thing the frontend does with it.
        'tags_initialize':     '10/hour',
        'tags_available':      '60/hour',
    },
}
# lets set lifetimes for tokens
from datetime import timedelta

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    # SECURITY: Rotate refresh tokens on every /token/refresh/ call. The previous
    # refresh token is blacklisted (if 'token_blacklist' is in INSTALLED_APPS).
    # Tradeoff: clients must update their stored refresh token on every refresh,
    # but a stolen refresh token is single-use.
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
}

# Structured logging configuration
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'filters': {
        # Inject the per-request correlation_id (set by CorrelationIdMiddleware
        # via contextvars) into every log record. Empty string outside a
        # request scope (e.g., Celery workers) — see celery.py to set it
        # from task headers.
        'correlation': {
            '()': 'backend.EchoFlow.logging_filters.CorrelationIdFilter',
        },
    },
    'formatters': {
        'json': {
            '()': 'pythonjsonlogger.jsonlogger.JsonFormatter',
            'fmt': '%(asctime)s %(name)s %(levelname)s %(correlation_id)s user=%(user_id)s ip=%(client_ip)s endpoint=%(endpoint_path)s %(message)s',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'json',
            'filters': ['correlation'],
        },
    },
    'root': {
        'handlers': ['console'],
        'level': os.environ.get('LOG_LEVEL', 'INFO'),
    },
    'loggers': {
        'django': {
            'handlers': ['console'],
            'level': os.environ.get('DJANGO_LOG_LEVEL', 'INFO'),
            'propagate': False,
        },
        'backend.app': {
            'handlers': ['console'],
            'level': os.environ.get('APP_LOG_LEVEL', 'INFO'),
            'propagate': False,
        },
        'celery': {
            'handlers': ['console'],
            'level': os.environ.get('CELERY_LOG_LEVEL', 'INFO'),
            'propagate': False,
        },
    },
}

# SECURITY: Production-only cookie + transport hardening.
# Wrapped in `if not DEBUG:` so the dev server (HTTP) keeps working.
# In any environment that terminates TLS (Traefik / nginx / CloudFront),
# SECURE_PROXY_SSL_HEADER is required or SECURE_SSL_REDIRECT will loop.
#
# ECHOFLOW_TESTING is a THIRD, independent reason to skip this block, and it
# exists because relying on `DJANGO_DEBUG=True` here stopped being reliable.
# `docker-compose.local.yml` used to hardcode `DJANGO_DEBUG=True` as a
# literal, and `conftest.py` sets it with `os.environ.setdefault` — which is a
# no-op the moment the container already exports a value. So the suite's
# ability to run depended on an unoverridable literal in a compose file. That
# literal is now `${DJANGO_DEBUG:-False}`, and once the container is recreated
# the suite would come up with DEBUG=False and `SECURE_SSL_REDIRECT=True`,
# 301-ing every request Django's test client makes to `http://testserver/`
# (the client sends no `X-Forwarded-Proto`).
#
# Gating on an explicit flag rather than on DEBUG also stops the suite from
# lying about the environment: DEBUG now reflects the real container value, so
# the settings in this block are exercised where they are meant to be.
#
# The test detection is `EchoFlow.secrets.testing_enabled`, not a bare env-var
# read here, for a timing reason that is easy to get wrong: pytest-django calls
# django.setup() while loading initial conftests, which is BEFORE the rootdir
# conftest.py module body runs. So an env var that conftest.py sets is not yet
# in os.environ at the moment this line executes. `testing_enabled()` also
# recognises pytest itself, which is imported strictly earlier.
_ECHOfLOW_TESTING = testing_enabled()
if not DEBUG and not _ECHOfLOW_TESTING:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    CSRF_COOKIE_SAMESITE = 'Lax'
    SECURE_SSL_REDIRECT = True
    SECURE_HSTS_SECONDS = 31536000  # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')


# DECISION: Regulatory settings (TERMS_VERSIONS, compliance/grievance/nodal contacts) live in settings.py rather than a DB table so they are env-driven and change without migration. Tradeoff: no audit trail of officer changes (operational, not regulatory requirement); DB table would require migration per change. See models.py Grievance/AuditLog for DB-level audit of grievances and identity.
TERMS_VERSIONS = [
    v.strip() for v in os.environ.get('TERMS_VERSIONS', 'v1.0').split(',') if v.strip()
]
# DECISION: A1 (2026-09-29) — these are now published on
# GET /legal/compliance/ so clients do not have to hardcode them. The
# mobile app was previously forced to send "v1.0" and would 400 the moment
# a version was appended to TERMS_VERSIONS, because
# RegisterSerializer.validate_terms_version rejects anything not in this
# list. Publishing the list is what makes the registration contract
# discoverable instead of tribal knowledge.
#
# Strips whitespace and drops empties, because a trailing comma or a stray
# space in a .env line would otherwise register as a valid version string
# that no client would ever send. `.strip()` above is the fix; previously
# "v1.0,v1.1" produced ['v1.0', 'v1.1'] but "v1.0, v1.1" produced
# ['v1.0', ' v1.1'] — the second silently unusable, so the mismatch was
# invisible until a user hit an inexplicable 400.
COMPLIANCE_OFFICER_NAME = os.environ.get('COMPLIANCE_OFFICER_NAME', 'EchoFlow Compliance Officer')
COMPLIANCE_OFFICER_EMAIL = os.environ.get('COMPLIANCE_OFFICER_EMAIL', 'compliance@echoflow.in')
GRIEVANCE_OFFICER_NAME = os.environ.get('GRIEVANCE_OFFICER_NAME', 'EchoFlow Grievance Officer')
GRIEVANCE_OFFICER_EMAIL = os.environ.get('GRIEVANCE_OFFICER_EMAIL', 'grievance@echoflow.in')
NODAL_CONTACT_NAME = os.environ.get('NODAL_CONTACT_NAME', 'EchoFlow Nodal Contact')
NODAL_CONTACT_EMAIL = os.environ.get('NODAL_CONTACT_EMAIL', 'nodal@echoflow.in')
PHYSICAL_ADDRESS = os.environ.get('PHYSICAL_ADDRESS', '')
# Which policy/terms text is currently in force. Distinct from the list of
# everything ever published: a client must show the current one at
# registration, while the full list is needed to interpret historical
# ConsentAudit rows.
PRIVACY_VERSION = os.environ.get('PRIVACY_VERSION', 'v1.0')

# --- RevenueCat (Pro subscription management) ---
# SECURE: REVENUECAT_SECRET_KEY is backend-only. Never expose this to the
# frontend. The public key (REVENUECAT_PUBLIC_KEY) is safe for browser use
# but is not needed by Django (the SDK uses it client-side only).
REVENUECAT_SECRET_KEY = os.environ.get('REVENUECAT_SECRET_KEY', '')
REVENUECAT_PUBLIC_KEY = os.environ.get('REVENUECAT_PUBLIC_KEY', '')
REVENUECAT_PROJECT_TOKEN = os.environ.get('REVENUECAT_PROJECT_TOKEN', '')
REVENUECAT_ENTITLEMENT_ID = os.environ.get('REVENUECAT_ENTITLEMENT_ID', 'pro')
REVENUECAT_SYNC_INTERVAL_MINUTES = int(os.environ.get('REVENUECAT_SYNC_INTERVAL_MINUTES', '360'))
REVENUECAT_CUSTOMER_PORTAL_URL = os.environ.get('REVENUECAT_CUSTOMER_PORTAL_URL', '')

# Usage limits for free (non-Pro) users. Pro users get unlimited / higher caps.
REVENUECAT_DAILY_UPLOAD_LIMIT_FREE = int(os.environ.get('REVENUECAT_DAILY_UPLOAD_LIMIT_FREE', '5'))
REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE = int(os.environ.get('REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE', '10'))
REVENUECAT_CLIP_DURATION_LIMIT_FREE = int(os.environ.get('REVENUECAT_CLIP_DURATION_LIMIT_FREE', '60'))
REVENUECAT_HD_QUALITY_BLOCKED_FREE = os.environ.get('REVENUECAT_HD_QUALITY_BLOCKED_FREE', 'True').lower() == 'true'

VERSION = '1.0.0'
