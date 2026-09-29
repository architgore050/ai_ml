> **nginx is the only public-facing entrypoint.** It terminates TLS on `:80` (redirect) / `:443` (Django) / `:9443` (MinIO HLS) and forwards plain HTTP to the in-network backends. The `web:8005` and `minio:9000` ports are NOT directly reachable from the host anymore (except `web:8005` which is published as a debug escape hatch). To verify the stack is up: `curl -kI https://localhost/health/`. See [docs/EXPLAIN/docker/05-https-tls-termination.md](docs/EXPLAIN/docker/05-https-tls-termination.md) for the full design.
# EchoFlow — Agent Quick-Start

> ### ⚠️ Always start a stack the same way you found it
>
> `docker-compose.local.yml` **must** be run as
> `docker compose -f docker-compose.local.yml --env-file .env.local up -d`.
>
> - **Omitting `--env-file .env.local`** makes compose interpolate from `.env`,
>   whose `DB_PASSWORD` differs from the one the Postgres volume was created
>   with. Every service then dies with `password authentication failed for
>   user "echoflow"`.
> - **Running plain `docker compose up`** (or merging `.local.yml` with
>   `.vps.yml` / `.laptop.yml` when the stack was started with only
>   `.local.yml`) targets a *different* compose project. Docker Compose's
>   project name is shared across files in the same directory, so a mismatched
>   invocation silently rebuilds the network and orphans every running
>   container. Check with `docker compose ls` before tearing anything down.
> - The local stack's project is `echoflow` and its network is
>   `echoflow_default` (bridge `br-ef-local`, `172.29.0.0/16`).

## Stack
Django 5.2 / DRF 3.18 · PostgreSQL 16 + pgvector (HNSW) · Redis 7 · Celery + Celery Beat · FFmpeg (HLS) · Vite/React (frontend/) · nginx 1.27 (TLS terminator) · Prometheus + Grafana (observability) · Sentry (errors, ready-to-configure)

> **Docker is the only supported way to run EchoFlow locally.** There is no bare-metal install path. The `Dockerfile` and `docker-compose.yml` provision every dependency (Postgres+pgvector, Redis, MinIO, all Celery queues, ffmpeg, Python 3.11, ML libs, nginx, Prometheus, Grafana) in a single `docker compose up --build`. For production at small scale (~$6/month), use the hybrid deployment: `docker-compose.vps.yml` on a VPS + `docker-compose.laptop.yml` on a laptop + Cloudflare R2 for object storage. See [docs/EXPLAIN/DEPLOYMENT/01-hybrid-deployment-overview.md](docs/EXPLAIN/DEPLOYMENT/01-hybrid-deployment-overview.md).

## Docker
```bash
docker compose up --build          # 14 services: db, pgbouncer, redis_broker, redis_cache, minio, minio-init, nginx, web, celery, celery_feed, celery_media, celery_beat, prometheus, grafana
docker compose down                # tear down
docker compose logs -f celery_media
docker compose exec web python manage.py migrate

# Observability endpoints (after `docker compose up`):
#   Prometheus: http://localhost:9090
#   Grafana:    http://localhost:3000  (admin / ${GRAFANA_ADMIN_PASSWORD})
```

> **nginx is the only public-facing entrypoint.** It terminates TLS on `:80` (redirect) / `:443` (Django) / `:9443` (MinIO HLS) and forwards plain HTTP to the in-network backends. The `web:8000` and `minio:9000` ports are NOT directly reachable from the host anymore (except `web:8005` which is published as a debug escape hatch). To verify the stack is up: `curl -kI https://localhost/health/`. See [docs/EXPLAIN/docker/05-https-tls-termination.md](docs/EXPLAIN/docker/05-https-tls-termination.md) for the full design.

## Running Tests

> **All tests run inside the Docker `web` container against PostgreSQL.**
> The test database is `echoflow_test` — auto-created by conftest on first
> run. No SQLite, no stub migrations, no bare-metal test mode.

### Quick start (full stack + tests)

```bash
# Build and start test stack (db, redis, minio, web)
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d

# Run the full test suite (conftest auto-creates echoflow_test DB)
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --tb=short

# Run a single test file
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/test_adversarial_pass3.py -v

# Run a single test class
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/test_adversarial_pass3.py::TestN1CommentAuthorization -v

# Run the migration / config / static checks that CI runs
docker compose exec web python manage.py migrate --noinput
docker compose exec web python manage.py makemigrations --check --dry-run
docker compose exec web python manage.py check --fail-level WARNING
docker compose exec web python manage.py collectstatic --noinput --dry-run

# Inspect coverage (with the pytest-cov plugin — installed in the image)
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --cov=backend.app --cov-report=term-missing

# Tear down test stack
docker compose -f docker-compose.yml -f docker-compose.test.yml down -v
```

### Hybrid Deployment (production at small scale)

The hybrid deployment splits services across a VPS (light services) and a
laptop (heavy media worker), with Cloudflare R2 for object storage:

```bash
# VPS: light services (8 containers)
git checkout feat/hybrid-vps
cp .env.vps.example .env
# Edit .env with real values
bash scripts/vps-deploy.sh

# Laptop: heavy media worker (1 container)
git checkout feat/hybrid-laptop
cp .env.laptop.example .env
# Edit .env with real values (DJANGO_SECRET_KEY must match VPS)
bash scripts/laptop-deploy.sh
```

- `docker-compose.vps.yml` — slimmed 8-service compose (removes pgbouncer,
  minio, celery_media, prometheus, grafana)
- `docker-compose.laptop.yml` — single-service compose (celery_media only)
- `scripts/vps-deploy.sh` — one-shot VPS deploy (build, migrate, collectstatic,
  Tailscale setup, daily backup cron)
- `scripts/laptop-deploy.sh` — one-shot laptop deploy (build media image,
  start worker, start heartbeat)
- `scripts/laptop-heartbeat.sh` — background heartbeat writer to Redis
- `backend/app/views/system_health.py` — `/api/v1/health/media-worker/`
  endpoint reporting laptop worker liveness

See [docs/EXPLAIN/DEPLOYMENT/](docs/EXPLAIN/DEPLOYMENT/) for full setup guides.

### Production stack + tests (when you need nginx/MinIO endpoints)

```bash
# Start full stack (db, pgbouncer, redis, minio, nginx, web, celery, etc.)
docker compose up --build -d

# Run tests against the full stack
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --tb=short

# Tear down
docker compose down
```

## Observability

Two stacks are available after `docker compose up`:

### Prometheus + Grafana (primary)
```bash
# Prometheus: scrape target, query PromQL
open http://localhost:9090/targets      # confirm web target is UP
open http://localhost:9090/graph        # PromQL query editor

# Grafana: dashboards, datasources auto-provisioned
open http://localhost:3000              # admin / ${GRAFANA_ADMIN_PASSWORD}
#   Dashboards > EchoFlow > 01-feed-and-suggestions
#   Dashboards > EchoFlow > 02-celery-health
```

The scraper reads `/metrics/` from `web` every 15s. Two dashboards ship pre-built:
- **01-feed-and-suggestions.json** — p95 of `feed_refill_duration_seconds`, `suggestion_ranking_duration_seconds`, cache hit/miss rate.
- **02-celery-health.json** — `rate(celery_tasks_processed_total[5m])` by queue/task, p95 of `hls_processing_duration_seconds`.

Alert rules are intentionally not shipped in this pass — the audit doc proposes them; this is a follow-up. Add them in `docker/prometheus/alerts.yml` and reload Prometheus when ready.

Full design: [docs/EXPLAIN/observability/03-prometheus-grafana-design.md](docs/EXPLAIN/observability/03-prometheus-grafana-design.md). Activation runbook: [docs/EXPLAIN/observability/04-prometheus-grafana-setup.md](docs/EXPLAIN/observability/04-prometheus-grafana-setup.md).

### Sentry (error capture, ready-to-configure)
`sentry-sdk[django,celery]==2.18.0` is installed; `init_sentry()` runs in each process's `App1Config.ready()`. Errors from web + all 4 celery services are captured when `SENTRY_DSN` is set in `.env`. Gated on `DJANGO_DEBUG=False` so dev/test paths are no-ops.

```bash
# Local: capture_exception is a no-op (no DSN, debug=True)
# Staging/prod: set SENTRY_DSN, SENTRY_ENV in .env
echo 'SENTRY_DSN=https://abc123@sentry.io/456' >> .env
echo 'SENTRY_ENV=production' >> .env
docker compose up -d --force-recreate web celery celery_feed celery_media celery_beat
```

The `capture_exception(exc, **context)` wrapper in `backend/app/services/sentry.py` attaches the current request's `correlation_id` (from `backend.EchoFlow.correlation`) as a Sentry tag, so production errors cross-reference with the worker's correlation_id (Group B item 11). `send_default_pii=False` — user IPs, cookies, and auth headers are NOT sent.

### Observability TUI (dev fallback)
```bash
# Run inside the web container (TUI requires urllib; stdlib only, no extra deps)
docker compose exec web python scripts/observability_tui.py

# One-shot snapshot to stdout (useful for scripting)
docker compose exec web python scripts/observability_tui.py --once

# Point at a different /metrics/ URL (e.g. against a staging server)
docker compose exec web python scripts/observability_tui.py --url http://staging:8005/metrics/

# Refresh every 2 seconds instead of 5
docker compose exec web python scripts/observability_tui.py --interval 2
```

The TUI reads `/metrics/` from the running `web` container and prints a text dashboard of the 6 custom application metrics (`echoflow_feed_refill_duration_seconds`, `echoflow_suggestion_ranking_duration_seconds`, `echoflow_toggle_like_duration_seconds`, `echoflow_cache_get_set_duration_seconds`, `echoflow_hls_processing_duration_seconds`, `echoflow_celery_tasks_processed_total`). Refreshes every N seconds (default 5). It is now a dev fallback — Grafana is the primary observability tool.

**Why `docker compose exec web` and not `docker compose run web`?**
- `exec` runs the command in the already-running `web` service (uses its env, mounted volumes, and depends_on the DB/Redis/MinIO). This matches the actual production-like runtime.
- `run` would spin up a fresh container that doesn't have the dependent services linked unless you pass `--service-ports` and explicitly `depends_on` them — which complicates the command for no benefit.

**When a test genuinely needs bare-metal (rare, e.g. debugging an ML model locally):** run the wheelhouse install documented in commit history of the audit-pass-3 dump, set the same env vars the container uses (DATABASE_URL, REDIS_BROKER_URL, REDIS_CACHE_URL, etc.), and run pytest directly. Document the divergence in the PR description.

### Dockerfile architecture
Single multi-stage `Dockerfile` with five stages (two are build-only):

| Stage | Shipped? | Purpose |
|---|---|---|
| `base` | parent of all | apt union (libpq-dev, gcc, postgresql-client, ffmpeg, libsndfile1), appuser (UID 1000) |
| `py-deps-api` | yes, this is preferred | installs requirements-base.txt offline from wheelhouse into site-packages |
| `py-deps-media` | yes, this is preferred | requirements-media.txt + bakes HuggingFace models into the `echoflow-hf` cache mount, then `cp -a` to `/home/appuser/hf_baked` so the models persist into the layer (see "HuggingFace bake copy-to-layer" below) |
| `api` | yes | web, celery, celery_feed, celery_beat — small image, no wheels/models |
| `media` | yes | celery_media — `COPY --from=py-deps-media /home/appuser/hf_baked /home/appuser/.cache/huggingface`; runtime `HF_HOME=/home/appuser/.cache/huggingface` |

Final images receive dependencies via `COPY --from=py-deps-* /opt/venv /opt/venv`
and source via an explicit allowlist (`backend/` — incl. `wait_for_db.py`
and `gunicorn.conf.py`, `manage.py`) — never a blanket `COPY .`. Stage-specific HEALTHCHECKs are
baked in: `api` probes `GET /health/` (compose overrides it to a Celery ping
for the worker services sharing that image); `media` pings its own Celery node.
HF_TOKEN is delivered ONLY via BuildKit secret mount
(`--mount=type=secret,id=hf_token`) — never `--build-arg`, which would persist
the token in builder layer history readable by `docker history`.

**HuggingFace bake copy-to-layer** (added 2026-09-07, fixed the `celery_media` build):

BuildKit `--mount=type=cache` is **ephemeral** — the cache target is a temporary
overlay that exists only during the `RUN` command. Files written into the
cache mount are saved to the BuildKit cache store (for future build speedup)
but are **not** part of the committed layer's filesystem. A subsequent
`COPY --from=py-deps-media <cache-mount-path>` therefore fails with
`not found` — the path exists during the `RUN` but is invisible to the
layer graph.

The fix: after the model download commands, the `py-deps-media` RUN ends
with `cp -a /home/appuser/.cache/huggingface /home/appuser/hf_baked`. This
materializes the cache contents into a regular filesystem path that **does**
persist into the layer. The `media` stage then `COPY --from=py-deps-media
/home/appuser/hf_baked /home/appuser/.cache/huggingface` lands the baked
models at the runtime `HF_HOME` path unchanged. Runtime env vars
(`HF_HOME`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` in
`docker-compose.yml`) are NOT modified.

Tradeoff: ~250 MB is now in both the BuildKit `echoflow-hf` cache AND the
layer. The BuildKit cache is for cross-build speed (it only costs disk
locally and is not in the image); the layer copy is what's shipped. Final
image size is unchanged at the user-visible layer.

CI guards against regression: `.github/workflows/docker-image.yml` runs a
smoke test on every PR that builds the `media` target, loading the
freshly-built image and asserting the baked HF models load in
`HF_HUB_OFFLINE=1` mode.

```bash
# Build all targets
docker compose build

# Build a single target manually (media consumes HF_TOKEN as a build SECRET)
docker build --target api   -t echoflow-api  .
export HF_TOKEN=hf_xxx   # or: --secret id=hf_token,src=./hf_token.txt
docker build --target media -t echoflow-media . --secret id=hf_token,env=HF_TOKEN

# Override image tag
docker compose build --build-arg TAG=dev
```

### Offline wheelhouse
All pip installs use `--no-index --find-links=/wheelhouse`. The wheelhouse is a local directory of pre-built wheels that makes builds fully offline and deterministic.

**Regenerate the wheelhouse** (run inside a py3.11 container):
```bash
mkdir -p wheelhouse-new
docker run --rm \
  -v "$PWD/requirements-base.txt:/req/requirements-base.txt:ro" \
  -v "$PWD/requirements-media.txt:/req/requirements-media.txt:ro" \
  -v "$PWD/constraints.txt:/req/constraints.txt:ro" \
  -v "$PWD/wheelhouse-new:/out" \
  python:3.11-slim-bookworm sh -c "\
    pip wheel --no-deps -w /out 'dj-rest-auth==7.2.0' && \
    pip download --prefer-binary --retries 10 --timeout 120 \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -c /req/constraints.txt -r /req/requirements-base.txt -d /out && \
    pip download --prefer-binary --retries 10 --timeout 120 \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -c /req/constraints.txt -r /req/requirements-media.txt -d /out"

rm -rf wheelhouse && mv wheelhouse-new wheelhouse
```

**Important rules:**
- After regenerating, `rm -rf wheelhouse && mv wheelhouse-new wheelhouse` swaps the directory.
- If you add/change any pin in `requirements-base.txt`, `requirements-media.txt`, or `constraints.txt`, **re-run the regen script first**.
- The `pip wheel --no-deps dj-rest-auth` step pre-builds a wheel for dj-rest-auth (it is sdist-only on PyPI).
- `librosa==0.11.0` — do NOT bump to 1.x (requires Python >= 3.12).
- `django==5.2.17` — do NOT bump to 6.x (requires Python >= 3.12).
- `sentry-sdk[django,celery]==2.18.0` — added when Sentry integration landed (Group B partial-issues, PR 2 of 3). The wheelhouse regen script must include this.

### Pop!_OS note
Uses Docker Compose V2 (`docker compose`, not `docker-compose`). If you have `docker-compose` installed from an old PPA, it conflicts with the V2 plugin — remove it with `sudo apt remove docker-compose` and use `docker compose` instead.

### BuildKit cache (named, persistent across builds)

The `Dockerfile` declares three **named** BuildKit cache mounts so cold builds skip the expensive network round-trips on subsequent runs:

| Cache ID | Mounted at | What it holds | Saved per build |
|---|---|---|---|
| `echoflow-apt` | `/var/cache/apt/archives` | Downloaded `.deb` files (`libpq-dev`, `gcc`, `ffmpeg`, `libsndfile1`, `libmagic1`, `postgresql-client`) | ~200 MB; ~1-2 min |
| `echoflow-pip`  | `/root/.cache/pip`     | pip's HTTP/wheel metadata index (resolver cache) | Seconds — only helps repeated installs in the same build |
| `echoflow-hf`   | `/home/appuser/.cache/huggingface` | Baked HF model artifacts (Whisper `base`, `all-MiniLM-L6-v2`, KeyBERT) | ~250 MB; ~5 min on `media` rebuild |

A dedicated `wheelhouse-base` stage owns the offline `./wheelhouse/` so both `py-deps-api` and `py-deps-media` reference it via `COPY --from=wheelhouse-base` — wheelhouse bytes enter the layer graph exactly once per build.

**Inspect / manage the caches:**

```bash
docker buildx du                                    # show every named cache and its size
docker buildx du --filter type=buildkit             # only BuildKit-managed caches
docker buildx prune --filter type=buildkit          # safe — never touches named caches by default
docker buildx prune --filter id=echoflow-apt        # nuke one specific cache (e.g. after adding a new apt package)
docker builder prune                                # CAREFUL — wipes dangling builders; named caches survive by default
```

**Cache invalidation rules:**
- Adding/changing a package in `Dockerfile` apt-get list invalidates the `base` stage → next build re-downloads everything → caches are repopulated transparently.
- The `wheelhouse/` directory changing (new wheels added) invalidates `wheelhouse-base` → both py-deps stages rebuild.
- HuggingFace model upgrade → invalidate manually with `docker buildx prune --filter id=echoflow-hf`. There is no automatic signal from inside the build that the upstream model changed.
- CI runners (GitHub Actions) start with empty BuildKit **named** caches (echoflow-apt / echoflow-pip / echoflow-hf) — they only speed up repeated local builds on the same machine. The **layer** cache IS persisted across CI runs via `cache-from: type=gha,scope=${{ matrix.target }}` in `.github/workflows/docker-image.yml`. The scope is per-matrix-target so a source-only change doesn't bust the heavy media layer cache and vice-versa. The named mount caches (especially `echoflow-hf` at ~250 MB) re-download on every CI run; if that becomes a CI cost issue, see `docs/EXPLAIN/docker/01-multi-stage-dockerfile.md` §"BuildKit cache" for the registry-backed upgrade.

**What is intentionally NOT cached:**
- `/var/lib/apt/lists/` — stale package indexes can silently serve vulnerable `.deb` files. `apt-get update` runs on every build; security wins over re-download speed.

### Runtime notes
- Web container runs: `backend/wait_for_db.py → migrate → collectstatic → gunicorn -c backend/gunicorn.conf.py`.
- `gunicorn.conf.py` uses `preload_app=True` with a `post_fork` hook that resets Django DB connections (critical because `EchoFlow/__init__.py` imports Celery, which creates Redis connections in the master process before fork).
- Health checks: `GET /health/` (liveness), `GET /ready/` (readiness — checks DB), `GET /metrics/` (Prometheus).
- Resource limits defined per-service in `docker-compose.yml` under `deploy.resources`.
- Override gunicorn workers/threads with `GUNICORN_WORKERS` and `GUNICORN_THREADS` env vars.
- **Do NOT** mount `huggingface_cache` volume on `celery_media` — models are baked into the image at build time.
- **PgBouncer (Phase 1.0):** web/celery services connect via `pgbouncer:6432` (transaction pool mode, `AUTH_TYPE=scram-sha-256`). Non-Docker dev (`pip install + runserver`) skips pgbouncer and connects to `localhost:5432` directly via `DATABASE_URL` — both paths work.
- **Split Redis (Phase 1.0):** Docker runs `redis_broker` (noeviction, 512MB, `REDIS_BROKER_URL`) and `redis_cache` (LRU, 1GB, `REDIS_CACHE_URL`) as separate services. Non-Docker dev sets `REDIS_URL` only — both URLs fall back to it.

## Environment Variables (required)
| Variable | Purpose |
|---|---|
| `DJANGO_SECRET_KEY` | Django signing key — app fails without it |
| `DJANGO_DEBUG` | **Must be `False` in any environment behind the nginx terminator.** Enables the `if not DEBUG:` block (`SECURE_SSL_REDIRECT`, HSTS, secure cookies). Default: `False` in `.env.example`. |
| `DATABASE_URL` | Docker: `postgres://user:pass@pgbouncer:6432/echoflow_db`. Non-Docker dev: `postgres://user:pass@localhost:5432/echoflow_db` |
| `READ_DATABASE_URL` | Optional. When set, activates the read-replica routing in `backend/app/db_routers.py`. Postgres URL of the streaming replica. See [docs/EXPLAIN/database/05-read-replica-design.md](docs/EXPLAIN/database/05-read-replica-design.md) for the activation playbook. |
| `REDIS_URL` | Non-Docker dev: `redis://localhost:6379/1` (single Redis). Optional in Docker. |
| `REDIS_BROKER_URL` | Broker URL. **Ignored when `REDIS_BROKER_HOST` is set** — compose always sets it, so a stale URL in `.env.local` cannot override the service name. Falls back to `REDIS_URL`. See the gotcha below. |
| `REDIS_CACHE_URL` | Docker: `redis://redis_cache:6379/0`. Falls back to `REDIS_URL`. |
| `HF_TOKEN` | HuggingFace token (model baking at build time). See [docs/EXPLAIN/operations/hf-token-rotation.md](docs/EXPLAIN/operations/hf-token-rotation.md) for the rotation runbook. |
| `OPENAI_API_KEY` | Optional — reserved for OpenAI pipeline branch |
| `FREESOUND_API_KEY` | Required only for freesound scraper |
| `SEED_AUTH_TOKEN` | Auth token for `seed_db.py` |
| `GUNICORN_WORKERS` | Default gunicorn workers (default: 4) |
| `GUNICORN_THREADS` | Default gunicorn threads (default: 4) |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated allowed hosts. Must include every host the nginx terminator is reached at (`localhost`, your prod hostname, any Tailscale/CNAMES). Default: `localhost`. |
| `DJANGO_CORS_ALLOWED_ORIGINS` | Comma-separated **https://** origins. Every browser-reachable origin MUST be `https://` once the terminator is live — `http://` here causes mixed-content / CORS preflight failures. |
| `PUBLIC_MEDIA_ENDPOINT_URL` | Browser-facing MinIO origin for HLS playback. **Must be `https://`** (e.g. `https://localhost:9443` in dev). `AWS_S3_ENDPOINT_URL` (containers' in-network URL) stays `http://minio:9000`. |
| `MEDIA_TOKEN_SECRET` | HMAC signing key for HLS playback tokens. Shared between Django (issuance) and the Cloudflare Worker (validation). Generate: `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Must match the Worker secret set via `npx wrangler secret put MEDIA_TOKEN_SECRET`. For local dev, `scripts/run-hls-worker-local.sh` generates the Worker's `.dev.vars` from this value so the two cannot drift. See `docs/EXPLAIN/storage/04-hls-token-protection.md`. |
| `PUBLIC_HLS_ENDPOINT_URL` | Browser-facing HLS origin when it is the **validating edge** (Worker on `media.echoflow.in`, or the Worker behind nginx `:9443`/`:19443` locally). Leave blank with no edge in front. Its presence also sets `HLS_URL_STYLE=edge`. **Must not** be collapsed into `PUBLIC_MEDIA_ENDPOINT_URL`: presigned `uploads/` URLs still need the bucket in the path and the edge serves only `/hls/*`. |
| `HLS_URL_STYLE` | `edge` → bucket-less `{origin}/hls/...`; `bucket` → `{origin}/{bucket}/hls/...`. Defaults to `edge` when `PUBLIC_HLS_ENDPOINT_URL` is set, else `bucket`. An edge fronting a bucket (R2 custom domain, Worker) does not expose the bucket as a path segment, and the Worker rejects any path not starting `/hls/` — so the bucket-prefixed form 404s there. |
| `DB_HOST` / `DB_PORT` | Where the **app** connects. `pgbouncer`/`6432` in `docker-compose.yml`; `db_local`/`5432` in `docker-compose.local.yml`. `DATABASE_URL` is built from `DB_USER`/`DB_PASSWORD`/`DB_HOST`/`DB_PORT`/`DB_NAME` by compose — it is deliberately **not** in the env file, because compose does not expand `${...}` there. |
| `TEST_DB_HOST` / `TEST_DB_PORT` / `TEST_DB_NAME` | Where `conftest.py` reaches Postgres **directly** for the test database. Separate from `DB_HOST`/`DB_PORT` on purpose: pgbouncer whitelists only `DB_NAME`, so `CREATE DATABASE` for the test DB is refused through it. Never point `TEST_DB_HOST` at a non-local host — conftest issues `CREATE`/`DROP DATABASE` and `CREATE EXTENSION` against it. |
| `MEDIA_TOKEN_TTL_SECONDS` | HLS token time-to-live in seconds. Default `600` (10 min). |
| `MEDIA_TOKEN_COOKIE_DOMAIN` | Cookie `Domain` attribute for the HLS token cookie. Leave empty for dev (`localhost` rejects domain cookies). **Required** in production when `PUBLIC_HLS_ENDPOINT_URL` is a different host from the API: the cookie is set by `api.` and the media origin is `media.`, so a host-only cookie is never sent and every request 403s. Set the shared parent domain, e.g. `.echoflow.in`. |
| `SENTRY_DSN` | Optional. When set, the `sentry-sdk` in each process captures uncaught exceptions. Get a DSN from sentry.io (free tier works). |
| `SENTRY_ENV` | Sentry environment tag (e.g. `production`, `staging`). Default: `production`. |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction of requests traced (0.0-1.0). Default: `0.1`. Lower for high-traffic. |
| `SENTRY_PROFILES_SAMPLE_RATE` | Fraction of profiled requests. Default: `0.05`. |
| `GRAFANA_ADMIN_PASSWORD` | Initial admin password for Grafana (first-boot only). Required — Grafana v11 refuses to start without one. |
| `TERMS_VERSIONS` | Comma-separated consent versions (e.g. `v1.0,v1.1`). Used by `RegisterSerializer` and `ConsentAudit` (`terms_version_id`). Default: `v1.0`. See `settings.py:622`. |
- **Age gate (`dob` is required at registration)**: `RegisterSerializer.dob` is `required=True` as of 2026-09-29. It was optional, which meant a client that omitted it registered as an adult (`is_minor=False`) and had its telemetry processed under the adult path — the optionality *was* the DPDP §9 bypass. Under-18 now requires `parent_email`, sets `is_minor=True`, and `POST /interactions/{id}/log-telemetry/` returns **403** for minors. `minor_consent_verified` is hardcoded `False` (no parental-verification flow exists — no mail backend), so do **not** gate on it; gate on `is_minor`. Likes/skips stay open to minors deliberately. Future and >120-year-old `dob` are rejected (the bound uses `timedelta` arithmetic, not `date.replace(year=...)`, which raises on 29 Feb).
| `COMPLIANCE_OFFICER_NAME` | Chief Compliance Officer name (IT Rules 2021 Rule 4(1)(b)). Served by `/legal/compliance/`. Default: `EchoFlow Compliance Officer`. |
| `COMPLIANCE_OFFICER_EMAIL` | CCO email. Default: `compliance@echoflow.in`. |
| `GRIEVANCE_OFFICER_NAME` | Grievance Officer name (IT Rules 2021 Rule 4(1)(a)). Default: `EchoFlow Grievance Officer`. |
| `GRIEVANCE_OFFICER_EMAIL` | Grievance email. Default: `grievance@echoflow.in`. |
| `NODAL_CONTACT_NAME` | Nodal Contact name (IT Rules 2021 Rule 4(1)(c)). Default: `EchoFlow Nodal Contact`. |
| `NODAL_CONTACT_EMAIL` | Nodal email. Default: `nodal@echoflow.in`. |
| `AWS_S3_REGION_NAME` | **Must be `ap-south-1`** (or `ap-south-2`) for DPDP cross-border + RBI data-localisation compliance. `STORAGES` uses this (`settings.py:467`). Default in `.env.example`: `auto` — production must override. |
| `PHYSICAL_ADDRESS` | Registered office / physical address (IT Rules 2021 / Consumer Protection). Not yet exposed in `/legal/compliance/` endpoint (open). |
| `REVENUECAT_SECRET_KEY` | **Backend-only secret.** RevenueCat secret API key from dashboard → Project Settings → API keys. Never expose to frontend. Required for REST API polling. |
| `REVENUECAT_PUBLIC_KEY` | **Frontend-safe public key.** Used by `@revenuecat/purchases-js` SDK initialization. Safe to expose via `VITE_REVENUECAT_PUBLIC_KEY`. |
| `REVENUECAT_PROJECT_TOKEN` | RevenueCat project token (SDK identifier). |
| `REVENUECAT_ENTITLEMENT_ID` | Entitlement ID string in RevenueCat dashboard (default: `pro`). |
| `REVENUECAT_SYNC_INTERVAL_MINUTES` | Poll interval for Celery Beat task (default: `360` = 6 hours). |
| `REVENUECAT_CUSTOMER_PORTAL_URL` | Optional override for Customer Portal base URL. |
| `REVENUECAT_WEBHOOK_SECRET` | HMAC secret for webhook verification (Phase 2 — configure when enabling webhooks). |
| `REVENUECAT_DAILY_UPLOAD_LIMIT_FREE` | Free tier daily upload limit (default: `5`). |
| `REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE` | Free tier max upload size in MB (default: `10`). |
| `REVENUECAT_CLIP_DURATION_LIMIT_FREE` | Free tier max clip duration in seconds (default: `60`). |
| `REVENUECAT_HD_QUALITY_BLOCKED_FREE` | Block HD quality for free users (default: `True`). |

## Indian Regulatory Compliance

Full compliance details (DPDP Act 2023, IT Rules 2021, CERT-In Directions 2022, Copyright Act 1957, Consumer Protection E-Commerce Rules 2020, RBI Data Localisation) are documented in [docs/INDIA-REGULATORY-READINESS.md](docs/INDIA-REGULATORY-READINESS.md). **Read that doc before touching any of these areas:**

| Scenario / Application | Repo region to check first |
|---|---|
| User registration, consent, age gating | `backend/app/models.py` (User, ConsentAudit), `backend/app/serializers.py` (RegisterSerializer), `backend/app/views/auth.py` |
| Grievance / compliance officer endpoints | `backend/app/models.py` (Grievance, AuditLog), `backend/app/views/data_subject.py` |
| Content moderation pipeline | `backend/app/services/content_moderation.py`, `backend/app/services/uploads.py`, `backend/app/models.py` (AudioClip.moderation_approved) |
| Settings (regulatory contacts, S3 region) | `backend/EchoFlow/settings.py` (lines 622, 643-657, 467-498) |
| Audit logging / CERT-In 180-day retention | `backend/app/models.py` (AuditLog, ConsentAudit), `backend/app/middleware.py` |

## HTTPS / TLS Termination
The stack now ships with an nginx reverse proxy in front of every other service. TLS is terminated at the edge; internal hops (nginx→gunicorn, nginx→minio) stay plain HTTP on the docker bridge. No application code knows TLS exists.

| Concern | Where it lives | Notes |
|---|---|---|
| Public-facing entrypoint | `docker-compose.yml:nginx` (image `nginx:1.27-alpine`) | Three listeners: `:80` (HTTP→HTTPS redirect), `:443` (Django), `:9443` (MinIO for browser HLS). |
| TLS cert + key | `docker/certs/localhost.{crt,key}` (self-signed dev) | Bind-mounted read-only into nginx; never enters the app image. Production swaps in Let's Encrypt material via the same path. |
| TLS config | `docker/nginx.conf` | TLS 1.2/1.3 only, HSTS 1y+includeSubDomains+preload, `X-Forwarded-Proto https` on every upstream block. |
| Django TLS contract | `backend/EchoFlow/settings.py:529-539` `if not DEBUG:` block | `SECURE_SSL_REDIRECT=True`, `SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https')`, `SESSION/CSRF_COOKIE_SECURE=True`, HSTS 1 year. **Requires `DJANGO_DEBUG=False`** — set this in `.env` before going anywhere public. |
| In-container healthcheck | `Dockerfile` + `docker-compose.yml` (web service) | Sends `X-Forwarded-Proto: https` so `SECURE_SSL_REDIRECT` doesn't loop the in-container probe. |
| Test coverage | `backend/app/tests/test_https_termination.py` (32 tests) | Cert, nginx config, prod settings, proxy header, public media endpoint, live terminator. |

**Operating rules:**
- **Do NOT change `SECURE_PROXY_SSL_HEADER` to anything other than `('HTTP_X_FORWARDED_PROTO', 'https')`** without also updating every `proxy_set_header X-Forwarded-Proto https;` line in `docker/nginx.conf`. Mismatch = redirect loop or insecure cookies.
- **The `8005:8000` host port mapping on the `web` service is a debug escape hatch**, not the supported path. Attackers on the same network can hit gunicorn directly and spoof `X-Forwarded-Proto: https` to themselves. In prod, drop that port mapping entirely.
- **Cert rotation is `docker compose exec nginx nginx -s reload`** — no app rebuild, no container restart. The bind-mount picks up the new files.
- **Full design + production-readiness checklist:** `docs/EXPLAIN/docker/05-https-tls-termination.md` and `docs/EXPLAIN/docker/06-https-production-readiness.md`.

## API Endpoints
```
POST /auth/register/          # Register (public)
POST /auth/login/             # JWT obtain pair
POST /auth/token/refresh/     # JWT refresh

POST /clips/                  # Upload audio (auth) → triggers Celery `process_audio_to_hls`
GET  /feed/                   # Redis-backed personalized feed (auth)
POST /interactions/{id}/toggle-like/
POST /interactions/{id}/register-skip/
POST /interactions/{id}/log-telemetry/
GET  /comments/?clip={id}     # Filter by clip
POST /share/{id}/send-share/
GET  /follow/{id}/toggle-follow/
POST /tags/initialize/        # Cold-start: bootstrap user vectors from tags
GET  /suggestions/?category=X # Category-scoped vector ranking
GET  /profile/me/             # Own profile
GET  /profile/{id}/           # Public profile

# RevenueCat Pro subscription management (Phase 1: REST polling only)
GET  /subscription/           # Current Pro status + usage limits
POST /subscription/sync/      # Trigger immediate sync with RevenueCat (rate-limited)
GET  /subscription/manage/    # RevenueCat Customer Portal URL for self-service
POST /webhooks/revenuecat/    # Webhook endpoint (Phase 2 — HMAC verified when REVENUECAT_WEBHOOK_SECRET set)
```

## Architecture Notes
- **Dual `EchoFlow/`**: Project package (`backend/EchoFlow/settings.py`, `urls.py`, `celery.py`) vs app package (`backend/app/`). Don't confuse them.
- **Custom user model**: `backend.app.User` (extends `AbstractUser`). Set via `AUTH_USER_MODEL = 'backend.app.User'`.
- **Recommendation engine**: Composite scoring = 45% vector similarity + 30% avg completion rate + 25% engagement velocity. 80% exploit / 20% explore feed mixing.
- **Redis feed queues**: Per-user `user_feed:{id}` lists. `FastFeedViewSet` pops 10 at a time; refills trigger when queue < 15.
- **Vector fields**: `semantic_vector` (384-dim, from transcript via sentence-transformers), `acoustic_vector` (128-dim, from librosa). HNSW indexes (`m=16, ef_construction=64`) on both.
- **Celery task routing**: `process_audio_to_hls` → `heavy_media` queue; `refill_user_feed` → `fast_feed` queue; `cleanup_orphan_hls` → 03:00 UTC daily; `flush_counters_to_pg` → every 300s (defined in `backend/EchoFlow/settings.py` `CELERY_TASK_ROUTES` + `CELERY_BEAT_SCHEDULE`).
- **ML models lazy-loaded**: `get_whisper_model()`, `get_embedding_model()`, `get_kw_model()` in `backend/app/tasks.py` — initialized on first task call, not at import time.
- **`update_global_metrics`** is a no-op stub (deprecated 2026-09). All three responsibilities (counter deltas, avg_completion_rate, engagement_velocity) live in `flush_counters_to_pg`. The Celery Beat entry is kept for one cycle so a missing task name surfaces as a deployment error.
- **Event-driven metrics pipeline**: user interactions (`record_like_toggle`, `record_skip`, `record_share`, `record_telemetry` Tier-3 fallback) write to Redis via `counter_store.increment` / `add_completion` (O(1) on the request path). `flush_counters_to_pg` (every 5 min) drains the deltas and applies them to Postgres in batched UPDATEs that touch only the dirty clip set. No correlated subquery, no full-table scan. See [docs/EXPLAIN/decisions/event-driven-metrics.md](docs/EXPLAIN/decisions/event-driven-metrics.md).
- **Read replica routing**: `backend/app/db_routers.py` is a 71-line `ReadRouter` with 4 hooks (db_for_read/db_for_write/allow_relation/allow_migrate). Auto-activates when `READ_DATABASE_URL` is set; the `if not atomic and not SELECT FOR UPDATE` guard prevents stale-read races inside write transactions. See [docs/EXPLAIN/database/05-read-replica-design.md](docs/EXPLAIN/database/05-read-replica-design.md).
- **Per-session DB timeouts**: `backend/EchoFlow/settings.py` sets `statement_timeout=30s`, `idle_in_transaction_session_timeout=60s`, `lock_timeout=10s`, `connect_timeout=10s` on the default connection via libpq `options` string. Critical behind PgBouncer (25-conn pool); a slow query that held a backend connection could otherwise exhaust the pool. Gated on `ENGINE.endswith('postgresql')` so non-Postgres backends are unaffected.
- **Cache invalidation**: `services/interactions.py::invalidate_user_vectors_cache` is called from `record_like_toggle`, `record_skip`, `record_share`, and `record_telemetry`'s sync fallback via `transaction.on_commit`. The `flush_telemetry_stream` consumer invalidates each unique user's cache after a successful `bulk_create`. Stale-vector window collapsed from 15 min to near-zero for all user-state-mutating paths.
- **Counter store (event-driven, no dual-write)**: `services/counter_store.py` writes user-engagement counters to Redis (`INCRBY` for likes/shares/skips; `INCRBYFLOAT` + `INCR` for per-(user,clip) completion). The `UserInteraction.save()` F() side-effect was removed in the 2026-09 metrics rewrite; `flush_counters_to_pg` is the only path from Redis to Postgres. `ECHOFLOW_DUAL_WRITE_COUNTERS` is now a no-op (always False) and slated for deletion. See [docs/EXPLAIN/decisions/event-driven-metrics.md](docs/EXPLAIN/decisions/event-driven-metrics.md).
- **HLS output**: Stored under `media/hls/{clip_id}/` on local disk. Not S3-backed yet. `cleanup_orphan_hls` Celery task (daily 03:00 UTC) prunes directories older than 1 day that are not in the `AudioClip` table — bounded to 1000 keys/run.

## Scraping / Ingestion
> **⚠ BROKEN as of 2026-09-29 — both entry points fail at import.** `5c9c2d6 "removed scraper"`
> deleted the license helpers from `ai_ml/scrapers/base.py` (`normalize_license`,
> `license_features`, `license_allows_commercial`, `is_noncommercial_license`,
> `is_share_alike_license`, `resolve_podcast_rss` — 0 definitions remain anywhere in
> the tree) but both callers below still import them from that module, so neither
> will start. The commands are kept here for reference; see the "Session Learnings"
> entry for 2026-09-29. Restoring the helpers or finishing the removal is a
> **product decision that has not been made**.

```bash
# Management command  (currently ImportError — see warning above)
python manage.py scrape_audio --source=wikimedia --limit=3 --clip-length=30

# Celery task  (currently ImportError — see warning above)
python -c "from backend.app.tasks import scrape_and_import; scrape_and_import.delay('internet_archive', limit=5)"
```
Sources that still exist: wikimedia, internet_archive, freesound (needs `FREESOUND_API_KEY`), kaggle (needs `SCRAPER_KAGGLE_LOCAL_PATH`). Respects `robots.txt`. Source connectors live in `ai_ml/scrapers/sources/`. **The A3 licensing gate is unaffected** — `views/feed.py` and `services/entitlements.py::is_license_restricted` read the DB columns `is_noncommercial`/`requires_share_alike`, not the missing helpers. Only the scraper's ability to *classify* a license is gone.

### Seeding media for local development
The scraper being broken does not block local media work. `backend/scripts/seed_clips.py`
seeds real audio through the genuine upload path (`POST /clips/` →
`POST /clips/{id}/approve-moderation/` → `process_audio_to_hls`), one clip at a time:
```bash
python3 backend/scripts/seed_clips.py --dry-run   # validate the manifest, upload nothing
python3 backend/scripts/seed_clips.py             # upload + approve + wait for ready
python3 backend/scripts/seed_clips.py --resume    # skip already-uploaded tracks
```
Then trigger a feed refill so the new clips reach `GET /feed/`:
```bash
docker compose -f docker-compose.local.yml --env-file .env.local \
  exec celery_feed_local python -c "from backend.app.tasks import refill_user_feed; print(refill_user_feed(<user_id>))"
```
`GET /feed/` is a **destructive `lpop`**, so each call drains up to 10 ids; re-run the refill after you have consumed the queue.

## Frontend (sample only)
```bash
cd frontend
npm install
npm run dev      # Vite dev server on port 5173
npm run build
```
Uses HLS.js for playback. This is an example client — the production frontend may differ.

## RevenueCat Pro Subscription Integration

EchoFlow uses **RevenueCat Billing** (Stripe-backed) for Pro subscription management. This section covers the architecture, gating strategy, and operational details.

### Architecture Overview

| Component | Technology | Notes |
|---|---|---|
| Billing engine | RevenueCat Billing (Stripe) | Indian users excluded per policy |
| Subscription tier | Single "Pro" entitlement | `REVENUECAT_ENTITLEMENT_ID=pro` |
| Sync mechanism | REST API polling (Celery Beat) | Every 6h (configurable), no webhooks in Phase 1 |
| App User ID mapping | `User.uuid` (UUID4) | Immutable, survives username/email changes |
| Pro state cache | Django User model fields | `has_pro_entitlement`, `pro_expires_at`, `pro_grace_until` |
| Webhook support | Forward-compatible endpoint | HMAC-SHA256 verification gated on `REVENUECAT_WEBHOOK_SECRET` |

### Data Flow

```
Frontend (purchases-js SDK)        Backend                        RevenueCat API
        │                            │                                    │
        ├─── purchase ──────────────→│                                    │
        │                             │                                    │
        ├─── identify(app_user_id) ──→│                                    │
        │                             │                                    │
        │                             │─── GET /subscribers/{id} ─────────→│
        │                             │                                ←───┤
        │                             │─── update user fields ────────────→│(DB)
        │                             │                                    │
        │←─── show Pro features ───────│                                    │
        │                             │                                    │
        ├─── GET /subscription ───────→│                                    │
        │←─── 200 {is_pro: true} ──────│                                    │
        │                             │                                    │
        ├─── GET /manage ─────────────→│                                    │
        │←─── {url: "https://..."} ────│                                    │
```

### Gating Strategy: Usage Limits (Option A)

Pro gating is enforced via usage limits checked at request time — no feature flags, just hard limits:

| Feature | Free Limit | Pro Limit |
|---|---|---|
| Daily uploads | 5 clips | Unlimited |
| Max clip duration | 60 seconds | 300 seconds (MAX_DURATION_SECONDS) |
| Upload file size | 10 MB | 100 MB |
| HD quality (48kHz+) | Blocked | Allowed |
| Audio quality | 128 kbps | 320 kbps |

**Enforcement points:**
- `AudioUploadSerializer.validate()` — free-tier file size limit (before DB)
- `AudioUploadViewSet.create()` — daily upload count limit (before serializer)
- `process_audio_to_hls` task — clip duration + quality limits
- Feed views — HD quality filtering

### Grace Period Handling

During RevenueCat's billing grace period (3 days for annual/monthly), `User.is_pro()` returns `True` until the grace period ends AND the subscription is in a non-active state.

```python
def is_pro(self) -> bool:
    now = timezone.now()
    if self.has_pro_entitlement and self.pro_expires_at and self.pro_expires_at > now:
        return True
    if self.pro_grace_until and self.pro_grace_until > now:
        return True
    return False
```

The grace period end date is stored in `pro_grace_until` so Pro features continue during grace even if polling is delayed.

### Sync Strategy: REST API Polling

No webhooks in Phase 1 (free RevenueCat plan). A Celery Beat task polls the REST API every `REVENUECAT_SYNC_INTERVAL_MINUTES` (default 360 = 6h):

```
GET https://api.revenuecat.com/v1/subscribers/{app_user_id}
```

Response parsed for:
- Active entitlements (`is_active`, `expires_date_ms`, `grace_period_expire_date_ms`)
- Updates `has_pro_entitlement`, `pro_expires_at`, `pro_grace_until`, `pro_last_synced`

If polling indicates subscription inactive AND grace period expired, `has_pro_entitlement` is set to `False`.

### Webhook Placeholder (Phase 2)

```
POST /api/v1/webhooks/revenuecat/
```

Currently returns 200 and logs payload. Full HMAC-SHA256 verification will be implemented when upgrading to RevenueCat Pro plan. The `X-RevenueCat-Signature` header is verified against `REVENUECAT_WEBHOOK_SECRET`.

### Public vs Secret API Keys

| Key | Location | Safe for Frontend? |
|---|---|---|
| `REVENUECAT_PUBLIC_KEY` | Frontend `.env` (`VITE_REVENUECAT_PUBLIC_KEY`), backend `.env` | Yes — SDK initialization only |
| `REVENUECAT_SECRET_KEY` | Backend `.env` only | **No** — REST API polling, never expose |

### Environment Variables

All RevenueCat env vars are documented in the [Environment Variables](#environment-variables-required) table above. Key production settings:

```bash
REVENUECAT_SECRET_KEY=sk_live_xxx       # Backend-only, required
REVENUECAT_PUBLIC_KEY=pk_live_xxx       # Frontend-safe
REVENUECAT_ENTITLEMENT_ID=pro
REVENUECAT_SYNC_INTERVAL_MINUTES=360    # 6 hours
```

### Testing

- Backend: `backend/app/tests/test_revenuecat.py` — 21 tests covering `is_pro()`, `sync_entitlements`, views, webhook, free-tier limits
- Frontend: `frontend/sample_frontend/src/stores/__tests__/subscription.test.tsx` + `src/components/subscription/__tests__/Paywall.test.tsx` — 6 tests using vitest + @testing-library/react

### Operational Notes

- **Manual sync**: `POST /subscription/sync/` triggers immediate RevenueCat poll (rate-limited: 10/hour)
- **Customer Portal**: `GET /subscription/manage/` returns RevenueCat-hosted management URL
- **App User ID**: Maps to `User.uuid` (stringified). Created on user registration via `revenuecat_app_user_id` field
- **Frontend SDK init**: `Purchases.setup(publicKey, appUserId)` in `main.tsx` after auth context available
- **Paywall**: `Paywall.tsx` component shows upgrade CTA, calls `subscriptionAPI.sync()` then redirects to Customer Portal

## Testing & Linting
- Test framework: **pytest** + `pytest-django`, installed in the `api` image. Run via `docker compose exec web pytest …` — see [Running Tests](#running-tests) for the full command set.
- Test files live under `backend/app/tests/` (34 files: `test_adversarial_pass3.py`, `test_auth_regulatory.py`, `test_content_moderation.py`, `test_counter_store.py`, `test_db_router.py`, `test_erasure.py`, `test_feed_license_filter.py`, `test_feed_pool.py`, `test_group_c.py`, `test_hls_token.py`, `test_https_termination.py`, `test_integration_concurrency.py`, `test_integration_pgvector.py`, `test_metrics_endpoint.py`, `test_metrics.py`, `test_mobile_contract.py`, `test_observability_tui.py`, `test_orphan_cleanup.py`, `test_redis_url_precedence.py`, `test_reports.py`, `test_revenuecat.py`, `test_security_and_validation.py`, `test_sentry.py`, `test_services_comments.py`, `test_services_follows.py`, `test_services_interactions.py`, `test_services_shares.py`, `test_services_uploads.py`, `test_settings.py`, `test_share_pipeline.py`, `test_smoke.py`, `test_system_health.py`, `test_task_publisher.py`, `test_throttling.py`). The 8 `test_scraper*` files were deleted 2026-09-29 as orphaned — see the count note below.
- All tests run against PostgreSQL in Docker. No SQLite fallback.
- No linting/formatter config (no `.eslintrc` at root, no `pyproject.toml`, no `ruff.toml`).
- CI: `.github/workflows/django.yml` runs migrations + the test suite via Docker. Blocks merges on failure.
- **Current count (2026-09-29): 554 passed, 3 failed, 6 skipped.** Measured on the local stack. No `--ignore` flags are needed any more (the 4 collection-error modules were deleted 2026-09-29; see below).
  - **6 skipped** = 6 live-nginx-environmental (`TestLiveNginxTerminator` and friends need the full `docker compose up` stack, not the local one).
  - **3 failed**, all in `test_task_publisher.py::TestFlushTelemetryInvalidation`. These are **deterministic, not flaky** — they fail identically in isolation and in the full suite, so the "~4 flaky failures" note that used to live here was wrong. They are **pre-existing and not root-caused**; the test patches `tasks.cache` and then asserts against the real `django.core.cache` object, so it asserts state the patched code path does not own. Left alone deliberately: the behaviour under test (A3 cache invalidation after `flush_telemetry_stream`) is live and real, so deleting the test would drop a genuine guard. **Do not delete it — fix the patch target when someone picks it up.**
  - The previous count was **37 failed**, and AGENTS.md described them as "network/API-key dependent". **That was wrong** — none of them touched the network. They were orphaned tests left behind by `5c9c2d6 "removed scraper"`, which deleted 10 files / 407 lines including all of `ai_ml/scrapers/sources/` but touched **0** test files. The tests asserted against modules that no longer existed (`musopen`, `openverse`, `librivox`, `pixabay`, `podcast_index`, `bbc_sound_effects`, `free_music_archive`, `loc_national_jukebox`, `usgov_audio`, `youtube`, `youtube_shorts`, `state`, and the symbols `downloader.DownloadError` / `download_with_retries` / `normalizer.split_into_segments` / `uploader.save_clip_segments`). 8 test files were deleted 2026-09-29 on that basis; `test_feed_license_filter.py` was **repaired** instead of deleted because it guards a live security property.
  - **⚠ The same removal broke production code, not just tests.** `ai_ml/scrapers/base.py` no longer defines `normalize_license`, `license_features`, `license_allows_commercial`, `is_noncommercial_license`, `is_share_alike_license` or `resolve_podcast_rss` (0 definitions anywhere in the tree), yet both `backend/app/management/commands/scrape_audio.py:39` and `backend/app/tasks.py:925` (`scrape_and_import`) still import them from `ai_ml.scrapers.base`. **`scrape_audio` therefore fails at import time** — the documented scraping entry point in this file is dead until the license helpers are restored or the scraper is deleted properly. `scrape_audio.py` additionally calls `downloader.download_with_retries` (:441), `uploader.save_clip_segments` (:450) and catches `downloader.DownloadError` (:500), none of which exist any more.
  - The **A3 licensing gate is unaffected** and still enforced: `views/feed.py` and `services/entitlements.py::is_license_restricted` read the DB columns `is_noncommercial` / `requires_share_alike`, not the missing scraper helpers. Only the scraper's ability to *classify* a license is broken. Mobile Phase 2 does not touch the scraper.
  - Still worth the discipline: compare failure **sets** across >=2 runs against a stashed baseline rather than trusting a total. Verified 2026-09-29: two consecutive runs produced byte-identical failure sets, so the numbers above are stable.
- **Root cause of 178 `auth_group does not exist` errors:** The old conftest.py used a SQLite override hack that bypassed real migrations. The fix was to make Docker/Postgres the only test environment. The new `conftest.py` auto-creates `echoflow_test` DB, installs pgvector on `template1`, and handles session teardown.
- **docker-compose.test.yml** — test-only stack (db, redis, minio, web). No nginx, no celery workers. Run with: `docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d` then `docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --tb=short`.
- **Recent fixes (2026-09-07):**
  - **`backend/app/migrations/0002_audioclip_cover_image.py`** (added) — the `AudioClip.cover_image` field was added to the model (line 85) but the migration was never generated, so every `INSERT INTO app_audioclip` failed with `column "cover_image" of relation "app_audioclip" does not exist`. The migration was generated by `manage.py makemigrations` and added to fix 73 cascading fixture-setup errors across `test_adversarial_pass3.py`, `test_counter_store.py`, `test_orphan_cleanup.py`, `test_security_and_validation.py`, `test_services_{comments,interactions,shares,uploads}.py`, `test_task_publisher.py`, and `test_integration_{concurrency,pgvector}.py`.
  - **`ai_ml/scrapers/uploader.py:17`** (fixed) — was `from ..models import AudioClip` (a relative import left over from when the scraper lived at `backend/app/scrapers/uploader.py`); changed to the absolute `from backend.app.models import AudioClip` to match the pattern used by every other `ai_ml/` file. Was causing `ImportError: cannot import name 'AudioClip' from 'ai_ml.models'` in `test_scraper.py::test_uploader_creates_audioclip`.
  - **`docker/postgres-init/`** (new directory) — three init SQL scripts that run on the main `db` service's first startup: `00-init-pgvector.sql` installs the extension in `POSTGRES_DB` (echoflow_db) so Django migrations can find it; `01-init-pgvector-template1.sql` runs `\c template1` then installs the extension on the template (CRITICAL — must run after `00-` so `template1` has vector before `02-` runs); `02-echoflow-test-db.sql` runs `CREATE DATABASE echoflow_test OWNER echoflow` (idempotent via `\gexec` + `WHERE NOT EXISTS` guard). Filename ordering is load-bearing — see "Postgres init scripts" below.
  - **`docker-compose.yml:11-22`** (modified) — the `db` service now mounts `./docker/postgres-init` (instead of just the old `docker/test/postgres-init/init-pgvector.sql` single file) at `/docker-entrypoint-initdb.d:ro`. The single-file mount only installed vector in `echoflow_db`; the directory mount provisions both `echoflow_db` (main) and `echoflow_test` (dev) with pgvector on a fresh data volume. The separate `docker-compose.test.yml` still uses `./docker/test/postgres-init` for its own dedicated test-db container (clean isolation from dev data).
- **Audit records the proxy IP, not the client (fixed 2026-09-29)**: nginx is the only entrypoint, so `REMOTE_ADDR` is the nginx container's address. `CorrelationIdMiddleware` used `REMOTE_ADDR or X-Forwarded-For` — the `or` fallback could never fire behind the terminator, so every `AuditLog` row recorded `172.29.0.x`; `ConsentAudit` used `REMOTE_ADDR` alone. Verified live: `AuditLog.ip_address` held `172.29.0.13`. Both now use `EchoFlow/client_ip.py::get_client_ip`, which prefers `X-Real-IP` (nginx **sets** it from `$remote_addr`, so it cannot be spoofed through the terminator). Do **not** put `X-Forwarded-For` first: nginx uses `$proxy_add_x_forwarded_for`, which *appends*, so the first entry is whatever the client sent.
- **Postgres init scripts:** the main `db` service runs `docker/postgres-init/*.sql` in alphabetical order on first startup of a fresh data volume. The load-bearing order is `00-` (default DB) → `01-` (template1) → `02-` (create test db). If you change a filename, re-read the dependency comments in each file or you will silently break `CREATE DATABASE` for `echoflow_test` (vector extension is required on the source template). Wipe the volume (`docker volume rm echoflow_postgres_data`) if you change an init script — init scripts only run on a fresh data directory.
- **HNSW index EXPLAIN test gotcha:** `SET LOCAL enable_seqscan = OFF` requires an active transaction. Wrap it in `transaction.atomic()` to ensure it takes effect. Also verify the index type via `pg_am.amname` as a primary check (not just the EXPLAIN plan, which may choose Seq Scan for small tables).
- **S3 storage in tests:** Use `default_storage.exists(clip.original_file.name)` instead of `os.path.exists(clip.original_file.path)` — `.path` raises `NotImplementedError` on S3 storage backends (MinIO).
- **Conditional skip pattern for system binaries:** Use `@unittest.skipUnless(_ffmpeg_available, "requires ffmpeg on PATH")` where `_ffmpeg_available = shutil.which('ffmpeg') is not None`. This passes in Docker (ffmpeg installed) and skips on bare-metal dev.
- **F() expressions for atomic updates in concurrency tests:** Use `F('likes') + 1` instead of read-modify-write patterns (`obj.likes = obj.likes + 1`) to avoid race conditions.
- **date() objects for DOB fields:** Use `date(1990, 1, 1)` instead of string literals for date fields to avoid type errors.
- **trigger_hls_processing vs finalize_upload:** The upload flow changed; use `trigger_hls_processing` instead of the old `finalize_upload` in test fixtures.
- **cache import in adversarial tests:** Some test files need `from django.core.cache import cache` to work with Django's test cache backend.
- **postgresql assertion in smoke tests:** Changed from `sqlite3` to `postgresql` in smoke test assertions to match the Docker-only test environment.

### Known Skipped / Disabled Tests (environmental, not regressions)

The following test is **conditionally skipped** with `@unittest.skipUnless(_ffmpeg_available, ...)` because it requires `ffmpeg` on `PATH`. The `api` Docker image already installs ffmpeg (in the `base` stage of the Dockerfile), so this test **passes in Docker**. If running on a bare-metal dev machine without ffmpeg, it will be skipped:

| Test | Reason | How to enable locally |
|------|--------|------------------------|
| `backend/app/tests/test_scraper.py::ScraperUnitTests::test_normalizer_trims_to_max_seconds` | Requires `ffmpeg` on `PATH` (used by `pydub` for MP3 export) | `sudo apt install ffmpeg` (Debian/Ubuntu/Pop!_OS) or `brew install ffmpeg` (macOS) |

> The second scraper test, `test_uploader_creates_audioclip`, was previously ffmpeg-conditional too but now runs (it was failing with `ImportError` due to a broken relative import; the import was fixed in 2026-09 — see "Recent fixes" below).

The following nginx HTTPS termination tests require the `nginx` container (not part of the test stack):

| Test | Reason |
|------|--------|
| `backend/app/tests/test_https_termination.py::TestNginxConfig::test_nginx_parses_with_no_errors` | Requires `nginx` on `PATH` (only in the full Docker stack) |
| `backend/app/tests/test_https_termination.py::TestLiveNginxTerminator::*` | Live HTTP/HTTPS requests against nginx (not in test stack) |

These use `@unittest.skip(...)` for nginx (binary not available) and the full `docker compose up` stack for the live terminator tests. They pass when running the full stack.

If you add a test that needs a system binary not present in the Docker image, follow the same pattern: `@unittest.skip("requires <binary> on PATH; see AGENTS.md")`.

**Do NOT** comment-out or remove tests that fail for reasons you don't understand. If a test fails and the cause is unclear, debug it: run with `pytest --tb=long`, read the traceback, search the codebase for the operation being tested, and check whether the test environment matches the AGENTS.md prerequisites (Python 3.11, Postgres 16, Redis 7, FFmpeg on `PATH`, `docker compose` running). Only after you understand WHY a test fails — and the cause is environmental, not a code bug — should you add a skip with a clear reason.

### Local `.env` discipline

- `.env` is **gitignored**. Do not commit it. The boilerplate is `.env.example`, `.env.vps.example`, and `.env.laptop.example`; copy one of those to `.env` and edit locally. The `.gitignore` allows committing `*.example` files (see `.gitignore` exception rules for `.env.*.example`).
- Tracked env files must have `DJANGO_DEBUG=False`. CI runs `scripts/check_no_tracked_env.sh` on every PR; a tracked env file with `DJANGO_DEBUG=True` will block the merge.
- `HF_TOKEN` and `DJANGO_SECRET_KEY` in your local `.env` are real secrets. If you accidentally commit them, rotate them immediately.

### Where decisions and lessons live

**Design decisions** (architecture, schema, API, security, deployment) go in `docs/EXPLAIN/decisions/YYYY-MM-DD-<slug>.md` — NOT in AGENTS.md. Append new decisions there and link from AGENTS.md only if the decision changes how the stack is operated.

**Session lessons learnt** (gotchas, failure modes, test gaps) stay in AGENTS.md under [Session Learnings](#session-learnings--known-things) below — keep each entry to a tight bullet, max 3 lines.

**DOs and DON'Ts** (from user corrections) accumulate in AGENTS.md under [DOs and DON'Ts](#dos-and-donts). When the user corrects a behavior, append the lesson here on your own — do not ask, just update.

AGENTS.md is checked into the repo and is the canonical quick-start for coding agents. Update it when you:
- add or change a required env var,
- change the test command (e.g., new PYTHONPATH requirement),
- move a major subsystem (e.g., a Celery task, a service, a queue),
- learn a lesson worth keeping.

Keep entries concise. Link to docs instead of inlining long explanations.

## Gotchas
- `DEBUG = True` is hardcoded in `backend/EchoFlow/settings.py:15` — env-driven override exists (`DJANGO_DEBUG=False`). **MUST be `False` once the nginx terminator is live**, otherwise `SECURE_SSL_REDIRECT` 301-loops on the in-container `/health/` probe (the in-container healthcheck now sends `X-Forwarded-Proto: https` to compensate; the regression test `test_in_container_healthcheck_must_send_forwarded_proto` enforces this).
- `ALLOWED_HOSTS` is env-driven (`DJANGO_ALLOWED_HOSTS=localhost`). Add your host IP if accessing via LAN/Tailscale.
- `CORS_ALLOW_ALL_ORIGINS = True` in settings.py is hardcoded — env override (`DJANGO_CORS_ALL`) exists but the code sets it to True after the env check. With the terminator live, leave `DJANGO_CORS_ALL=False` and enumerate `https://...` origins explicitly.
- `requirements.txt` lists `librosa` twice (lines 8 and 28) — harmless but sloppy.
- `backend/scripts/seed_db.py` targets port 8005 (Docker) not 8000 (dev server). Adjust `API_ENDPOINT` if running locally. After the terminator: `https://localhost/clips/`.
- `backend/wait_for_db.py` polls the database with exponential backoff (up to 120
  attempts); relies on `DATABASE_URL` being set and resolvable in the
  Compose network.
- `process_audio_to_hls` is enqueued via `transaction.on_commit` in `backend/app/views.py:112` — won't fire if the transaction rolls back.
- Comment count on `AudioClip` is denormalized and updated in `Comment.save()/delete()` — not via signals.
- `UserInteraction` uses `F()` expressions for atomic counter increments on likes/shares/skips.
- **Self-signed dev cert (`docker/certs/localhost.crt`) is in the repo on purpose** so a fresh clone works. For prod, replace with Let's Encrypt material and `nginx -s reload` — the cert is bind-mounted, so no rebuild is needed. **Do NOT push the dev key to a public registry in any fork that re-publishes the image**; revocation is the only fix.
- **HLS token cookies**: The `ef_hls_token` cookie must have `SameSite=Lax` (not `Strict`) so it's sent on top-level navigation from `app.echoflow.in` to `media.echoflow.in` (SameSite=Lax permits cookies on same-site top-level navigations, but blocks cross-site). `Secure` requires HTTPS on both `api.echoflow.in` and `media.echoflow.in`. In dev, `Domain` attribute must be empty (localhost doesn't support domain cookies). See `docs/EXPLAIN/storage/04-hls-token-protection.md`.
- **HLS token secret sync**: In production, `MEDIA_TOKEN_SECRET` must be **identical** in the VPS `.env` (Django issuance) and the Cloudflare Worker secret (`npx wrangler secret put MEDIA_TOKEN_SECRET`). If these diverge, all HLS playback returns 403.
- **RFC 3986 §5.2.2 — Signed URLs don't work for HLS**: The master playlist references variant playlists and segments via relative paths. RFC 3986 §5.2.2 strips query strings during relative-reference resolution, so signed URLs (which rely on query parameters) fail on the second and subsequent HLS requests. **Signed cookies (or an equivalent per-prefix credential) are the only viable token mechanism for HLS.** This applies to any multi-file streaming protocol (HLS, DASH, Smooth Streaming).
- **fetch `credentials: 'include'` for Set-Cookie**: When using `fetch()` to call an endpoint that sets an HttpOnly cookie via `Set-Cookie`, the fetch request **must** include `credentials: 'include'` (or `'same-origin'`). Without it, the browser silently discards the Set-Cookie header. This is a common gotcha when building token-issuance endpoints.
- **HLS token has TWO transports — cookie (web) and header (native)**: `POST /media/playback-token/<clip_id>/` (POST, not GET — minting a credential must not be a safe/prefetchable/cacheable method) returns `{"status": "ok"}` and always sets the `ef_hls_token` cookie. A caller that also sends **`X-EchoFlow-Client: native`** additionally receives `"token"` in the body, and the Worker then accepts it as the **`X-EchoFlow-Media-Token`** request header (cookie-first precedence).
  - **Web:** read nothing from the body. The cookie is HttpOnly and the browser attaches it to every `/hls/*` request.
  - **Native (React Native / Expo):** send the header. AVPlayer does not read `NSHTTPCookieStorage` and ExoPlayer's `DefaultHttpDataSource` sends no `Cookie` header, so neither shares state with the app's HTTP client — and the cookie is `HttpOnly`+`Secure`, so the app cannot read it back to attach it manually. Attach the token via the player's per-source `headers` (expo-audio applies them to the manifest *and* every segment). See `docs/EXPLAIN/decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md`.
  - The body token is **opt-in** and the default body is unchanged, because `HttpOnly` exists to stop script from reading a bearer credential. Both transports carry the same HMAC string; signature, `exp` and per-clip scope are enforced identically.
  - **Cookie-first precedence will fool you when testing with `requests`.** `playback-token` sets `ef_hls_token` with `path=/hls/`, so a `requests.Session` that has *ever* minted a token will silently attach the cookie to `/hls/*` and a "no token" probe returns **200/206, not 403**. That is the cookie working, not a bypass. To test the header transport, `session.cookies.clear()` first, or use a fresh session. Verified 2026-09-29: 403 (no credential) → 206 (cookie) → 403 (cleared) → 200 (header only).
- **Bind-mounted source ≠ reloaded process**: the local stack bind-mounts the repo at `/app`, so a Python edit is on disk instantly — but gunicorn imported the module at startup and does not re-read it. Editing a view then curling the running stack exercises the OLD code, while pytest (fresh import) passes and `grep` in the container shows the new code. **Restart `web_local` before trusting any curl against a Python change.** `wrangler dev` does not have this problem.
- **…and the three workers do not even see the edit** (2026-09-29): `celery_media_local` / `celery_feed_local` / `celery_beat_local` have **no `/app` bind mount at all** — they run the image baked at build time, so a `backend/` fix needs `docker build` or a `docker cp` **plus a restart** (the prefork parent holds the old bytecode; copying the file while it runs changes nothing). `web_local` and `celery_local` are bind-mounted and only need a restart. Check `docker inspect <svc> --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' | grep /app` before assuming an edit took effect.
- **A stale `REDIS_BROKER_URL` in `.env.local` silently wins over compose's `REDIS_BROKER_HOST` (fixed 2026-09-29)**: the assignment was `os.getenv("REDIS_BROKER_URL", build_redis_url("REDIS_BROKER"))`, so an old URL in the env file beat the service name compose had just set — defeating the HOST/PORT split that exists *because* base64 Redis passwords break Kombo URL parsing. Symptom is nasty and misdiagnosable: the local stack publishes to a broker owned by the **other** compose project, two independent codebases race for the same `celery` queue, and a brand-new task dies with `NotRegistered` about half the time (measured **2/6**). It looks like "Celery never runs my task". `resolve_redis_url()` now prefers `{prefix}_HOST`; all three `.env.*.example` templates set exactly one form, so none of them change. If a new task mysteriously never fires, check this first.
- **A stale `django-redis` connection 500s, it does not 503**: `ConnectionInterrupted` out of the throttle check turns `POST /auth/login/` into a 500 debug page. Transient, clears on retry — re-run before investigating.
- **Never construct a media URL client-side**: use `hls_playlist_url` verbatim. Do not prefix the API base onto it — the HLS origin is the edge (`PUBLIC_HLS_ENDPOINT_URL`), often a different host and port from the API, and in `edge` style it is bucket-less. Both existing frontends did this and it is wrong; see `docs/FRONTEND-REQUIREMENTS.md` §4.7.
- **IP-keyed throttling is wrong on a mobile network**: a carrier NAT gateway is thousands of callers. `POST /auth/token/refresh/` is keyed on the **verified `user_id` inside the refresh token** (`RefreshTokenRateThrottle`), not the address — otherwise 15-minute access tokens mean ~4 refreshes/hour/user and one cell exhausts its shared `anon` budget, logging out every subscriber. `POST /auth/register/` keeps an IP key (it is anonymous) but is sized at 200/hour and paired with a per-username limit at 3/hour.
- **`throttle_scope` is load-bearing on any `ScopedRateThrottle` view**: `ScopedRateThrottle` reads its scope from the *view* at request time and **allows everything** when the view does not declare one. Listing the class without `throttle_scope` is a silent no-op — no error, no rate limit. `TestRefreshThrottleWiring` in `test_throttling.py` exists to catch exactly that.

## Docs
- `docs/backend-architecture-audit.md` — production scaling analysis (S3, PgBouncer, Kafka, etc.)
- `docs/scaling-analysis.md` — capacity planning notes
- `Startup_related_docs/` — market research and planning docs
- `docs/backend-bug-fixs.md` — audit + Group A/B/C/D/partial-issues fix reports (4 parts)
- `docs/EXPLAIN/decisions/partial-issues-completion-plan.md` — plan + completion record for the 7 partially-addressed items (A1, A3, A5, A8, B13, B14, B17) + B19 docstring
- `docs/EXPLAIN/decisions/group-b-architectural-plan.md` — plan for Group B items 9-12
- `docs/EXPLAIN/operations/hf-token-rotation.md` — HF_TOKEN rotation runbook (B17)
- `docs/EXPLAIN/observability/04-prometheus-grafana-setup.md` — Prometheus + Grafana activation (A8)
- `docs/EXPLAIN/database/05-read-replica-design.md` — read-replica design + activation playbook (A5)
- `docs/EXPLAIN/DEPLOYMENT/` — Hybrid deployment documentation (VPS + laptop + Cloudflare R2 + Tailscale)
- `docs/EXPLAIN/storage/04-hls-token-protection.md` — Short-lived HLS play token design (signed cookies + Cloudflare Worker / nginx njs)

---

## Engineering Principles

The following principles govern all code changes. These are standard SWE best practices distilled from the full protocol:

**Truth Protocol:** Source code > migrations > tests > config > docs > comments. Never invent behavior to reconcile conflicts; investigate instead.

**Golden Rules:**
- Understand before changing; root-cause fixes over symptoms
- Minimal viable changes; no "while I'm here" cleanup
- Never add a dependency without checking it exists in the repo first
- Tests are part of the implementation; don't delete/weaken/skip without justification
- Get approval before architecture/API/schema/security/deployment changes
- Design for failure: retries, idempotency, race conditions, partial completion

**Git Safety:** Use a dedicated branch. Never `git reset --hard`, `git clean`, or `git push --force` without explicit authorization.

**Documentation:** Put repo-specific notes in `docs/EXPLAIN/`. Use `DECISION:` / `SECURITY:` / `HACK:` / `TODO:` tags in code.

**For complex tasks touching approval gates (architecture, APIs, schemas, auth, security, deployment):**
Produce a design doc at `docs/EXPLAIN/decisions/YYYY-MM-DD-<slug>.md` with Changes Needed, How Changes Will Be Made, Why This & Not Anything Else, Files Affected, Architecture & Data Flow, Test Cases, Edge Cases, Atomic Commit Plan. Get explicit approval before implementing.

## Distributed-System & Security Reminders

When changing distributed workflows (Django, PostgreSQL/pgvector, Redis, Celery, MinIO/S3, FFmpeg/HLS, ML workers), consider: duplicate execution, retries, idempotency, race conditions, ordering, stale data, worker failure, process restart, partial completion, timeouts, resource exhaustion, network failure.

Never assume a task runs exactly once unless the system guarantees it. For every retryable operation, ask whether repeating it is safe.

**Media and Storage Invariants:** original uploads live in object storage; HLS output is generated in local worker scratch space then uploaded; containers must not assume a shared filesystem; HLS playback uses token-gated `hls/` paths (signed cookies); original `uploads/` remain private (signed S3 URLs); local scratch files must be cleaned up after processing. Verify in `settings.py`, `media_urls.py`, `tasks.py`, `docker-compose.yml` before modifying.

**Security:** Never hardcode secrets. Treat all input as untrusted. Validate/sanitize at boundaries. Before changing security-sensitive code, consider auth, authorization, injection, SSRF, path traversal, command execution, secret leakage, sensitive-data exposure, race conditions. For DB changes, inspect migrations, existing data, locking, rollback, compatibility.

## Session Learnings & Known Things

Durable, repo-specific knowledge. Append a concise entry at the end of each session.

### YYYY-MM-DD — <short slug>
**Learned:** 1-3 tight bullets.
**Changed:** Files/migrations/tests affected.
**Open:** Anything unresolved.

---

### 2026-09-15 — local-stack-compose-fixes + hybrid-deployment-diagnostics
**Learned:**
- MinIO image tags `RELEASE.2025-09-07T16-13-09Z` don't exist on Docker Hub → change to `quay.io/minio/minio:latest`; same for `mc:latest`
- Locally-built images (`echoflow-api:local`, `echoflow-media:local`, `echoflow/pgbouncer:local`) require `pull_policy: never` in docker-compose to avoid pulling from non-existent Docker Hub repos
- Redis passwords with base64 chars (`+`, `/`, `=`) break Kombu URL parsing → split into `REDIS_*_HOST/PORT/PASSWORD` env vars + `build_redis_url()` helper in `settings.py`
- `docker/nginx.conf` uses `web:8000`/`minio:9000` upstreams but local services are `web_local`/`minio_local` → create `docker/nginx.local.conf` with corrected hostnames
- Dockerfile HEALTHCHECK for `api` stage is web probe (`localhost:8000/health/`), not Celery → override healthcheck in compose with `celery inspect ping` for worker services
- `minio_init_local` service auto-initializes MinIO bucket on first stack up but `quay.io/minio/mc:latest` may have version incompatibility with MinIO server; service exits after init (one-shot behavior)
- Orphan container `echoflow_revnuecat-prod-celery_media-1` from previous project config is NOT part of current stack; use `docker compose down --remove-orphans` to clean
- Laptop media worker (`docker-compose.laptop.yml`) uses Tailscale tunnel to VPS, NOT Docker bridge; requires `tailscale up --accept-routes`, IP forwarding on both devices, and VPS nftables rule `ip saddr <laptop-ts-ip> iifname "tailscale0" accept` for TCP to work (ICMP/ping may work without it)

**Changed:**
- `docker-compose.local.yml`: fixed image tags, pull policies, Redis URLs, nginx upstreams, celery healthcheck, removed/re-added minio_init_local
- `docker/nginx.local.conf`: new file with corrected upstream hostnames
- `backend/EchoFlow/settings.py`: added `build_redis_url()` function
- Verified all 13 local services healthy; health endpoint `curl -k https://localhost:18443/health/` works

**Open:**
- `TestLiveNginxTerminator` fix (probe response body) - tracked in AGENTS.md
- `makemigrations --check` in CI - tracked in AGENTS.md

---

### 2026-09-28 — local-hls-worker + local-stack-networking
**Learned:**
- An R2 *binding* cannot be pointed at MinIO: under `wrangler dev` it is miniflare's local blob store in `.wrangler/state/` and `get()` always returns `null`. `workers/hls-token-worker/src/storage.ts` now selects an S3-over-fetch backend when `MEDIA_S3_ENDPOINT` is set. workerd CAN reach host-published MinIO and honours `Range`.
- A hand-rolled SigV4 was wrong twice, in OPPOSITE directions, and both passed every self-written test: it used `sha256("")` where boto3/MinIO want the literal `UNSIGNED-PAYLOAD`, and it put the access key id in the string-to-sign scope (it belongs only in `X-Amz-Credential`). Both surfaced only as 403 from MinIO. **Use `aws4fetch`** — a self-consistent signer validates only itself.
- `minio_local` is not a legal RFC 1123 hostname. `mc:latest` says `Invalid Request (invalid hostname)` and botocore 1.43 says `ValueError: Invalid endpoint`, so the bucket was never created and Django could not reach storage at all. Fixed with a hyphenated `minio-local` network alias.
- A top-level `networks:` block in compose does NOT auto-attach services — they go to the implicit `default`. Naming the block `default` is what makes an explicit bridge/subnet take effect. And `bridge.name: br-echoflow-local` was 17 chars vs Linux's 15-char limit, which Docker reports as the very unhelpful `numerical result out of range`.
- wrangler does NOT hot-reload `.dev.vars` (source files only). `scripts/run-hls-worker-local.sh` regenerates it from `.env.local` on every run so the two secrets cannot drift, and `npm run dev` routes through it.
- `conftest.py` hardcoded host `db`/port `5432`/`echoflow_test`, so the suite errored at setup everywhere except the main stack (`could not translate host name "db"`). Now env-driven via `DB_HOST`/`DB_PORT`/`TEST_DB_HOST`/`TEST_DB_PORT`/`TEST_DB_NAME`. `DATABASE_URL` is built by compose from those — it cannot live in the env file, since compose does not expand `${...}` there.
- `PlaybackTokenView` had zero test coverage despite being the token issuer. `test_hls_token.py` + `test_https_termination.py`: 69 passed, 6 skipped.
- `test_https_listeners_present` passes **vacuously** — its regex matches the commented-out `listen 9443 ssl` in `docker/nginx.conf`. `TestLocalHlsWorkerRouting` reads the local config, where the block is real.

**Changed:**
- `docker-compose.local.yml`, `docker/nginx.local.conf`, `conftest.py`, `.env.example`, `docker-compose.yml`, `docker-compose.test.yml`
- `workers/hls-token-worker/`: new `src/storage.ts` + tests, `/healthz`, `aws4fetch` dep, `.dev.vars.example`
- `backend/EchoFlow/settings.py`, `backend/app/media_urls.py`, `backend/app/views/media.py`
- New: `scripts/run-hls-worker-local.sh`, `docs/EXPLAIN/storage/05-local-hls-worker-runbook.md`, `docs/EXPLAIN/decisions/2026-09-28-local-hls-worker.md`

**Open:**
- **No cross-environment parity test**: the R2 backend (prod) and S3 backend (local) never see the same input. Token validation is shared code so the security boundary is covered; the storage fetch is not.
- `docker-compose.test.yml` cannot start — `docker-compose.yml` references `minio/minio:RELEASE.2025-09-07T16-13-09Z`, which does not exist on Docker Hub. Blocks running the suite in the documented test stack.
- 4 pre-existing failures unrelated to this work: `test_task_publisher.py::TestFlushTelemetryInvalidation` (3) and `test_feed_license_filter.py::test_fallback_excludes_nc_and_sa` (1). None of those files are in this branch's diff.
- 8 scraper test modules error on `ai_ml.scrapers.state`, deleted in `5c9c2d6 "removed scraper"` while `scrape_audio.py` and the tests still import it.
- `celery_media_local` OOMs (2 GB limit, 12 GB host), so HLS output is not produced locally; fixtures are seeded into MinIO directly.

---

### 2026-09-28 — mobile-rebuild: native media auth + CGNAT throttling
**Learned:**
- `ef_hls_token` is unreachable for native players: AVPlayer/ExoPlayer have no shared cookie jar, and the cookie is `HttpOnly`+`Secure`. Fixed by an opt-in `X-EchoFlow-Client: native` body token + Worker `X-EchoFlow-Media-Token` header (cookie-first precedence — a page can set a header but cannot read the cookie). `docs/mobile-rebuild-plan.md` §2-3.
- `ScopedRateThrottle` reads its scope from the **view** and allows *everything* when absent. Listing the class on a view with no `throttle_scope` silently unthrottles it — no error. `throttle_scope` is load-bearing.
- simplejwt **stringifies** `user_id` (`tokens.py:228`), so `isinstance(x, int)` on the token subject always fails; accept `(str, int)` or the throttle silently falls back to IP keying.
- `AnonRateThrottle` is fatal on mobile: 100/hour/IP behind a carrier NAT, and 15-min access tokens mean every user refreshes ~4x/hour → mass logout. Key refresh on the verified token subject, not the address.
- `.env.vps.example` was missing `PUBLIC_HLS_ENDPOINT_URL`, so prod emitted bucket-prefixed HLS URLs the Worker 404s. Domain is `echoflow.in` (was split with `echo-flow.in` across 13 files).

**Changed:**
- `backend/app/throttling.py` (new), `views/media.py`, `views/auth.py`, `app/urls.py`, `settings.py`; `workers/hls-token-worker/src/{token,index}.ts`; `.env.vps.example`, 3 compose files; 11 docs.
- New tests: `test_throttling.py` (26), `token.test.ts` (8), `TestNativeTokenTransport` (9).

**Open:**
- **No phone dev loop.** `PUBLIC_HLS_ENDPOINT_URL` is hardcoded to `localhost:19443` (a phone's `localhost` is the phone) and `docker/certs/localhost.crt` does not cover a LAN IP. Cert setup is manual per owner decision; runbook section not yet written.
- Suite flakiness: `test_counter_store` / `test_revenuecat` / `test_services_interactions` fail non-deterministically under a contended stack and pass in isolation. Compare failure **sets** across >=2 runs vs a stashed baseline; a single run proves nothing.
- Mobile app itself is **not started** — the rewrite plan is `docs/mobile-rebuild-plan.md` §8-17. Backend items still blocking feature parity are tabulated in §17.

---

### 2026-09-29 — mobile Phase 2: real-media seed + four latent bugs
**Learned:**
- **`celery_media_local`, `celery_feed_local` and `celery_beat_local` run a BAKED image with no `/app` bind mount** (only `web_local` and `celery_local` bind-mount the repo). Any `backend/` edit is invisible to them until a rebuild or a `docker cp`. This is the same trap as the existing "bind-mounted source ≠ reloaded process" note, one level worse: not a stale process, a stale *image*.
- **A stale `REDIS_BROKER_URL` in `.env.local` (172.28.0.x) beat compose's `REDIS_BROKER_HOST`** because those three workers predate the 2026-09-29 `resolve_redis_url` fix. They published Celery tasks to a dead broker while `web_local` published to the live one — so uploads enqueued and then nothing ran. The 2026-09-29 fix is correct; it just had not reached the baked images. Fix: delete `REDIS_BROKER_URL` / `REDIS_CACHE_URL` from `.env.local` and let HOST/PORT win.
- **Orphan containers from another project can silently consume your queue.** `echoflow_revnuecat-prod-celery_media-1` was up 23h on `-Q heavy_media` against the same broker, stealing every `process_audio_to_hls` task. It presented as "the worker receives 0 tasks". Check `docker ps -a | grep -v <your project>` and decode a `LINDEX` of the queue to see whose clip IDs are in there.
- **`from ..services` in `backend/app/tasks.py` killed EVERY HLS encode** at the moderation step (`ModuleNotFoundError: backend.services`). `tasks.py` is at `backend/app/`, so it needs `.services`; only files a level deeper use `..services`. Nothing had HLS'd successfully before this.

**Changed:**
- `backend/app/tasks.py` (import), `backend/app/views/content.py` + `backend/EchoFlow/settings.py` + `backend/app/tests/test_throttling.py` (throttle scopes), `backend/scripts/seed_clips.py` (new), `docker-compose.local.yml` (media worker concurrency 2→1), 8 deleted orphaned `test_scraper*` files, `backend/app/tests/test_feed_license_filter.py` (repaired).
- Commits: `7e39e52` (import), `936de67` (throttle scopes), `6b3da27` (seed + compose).
- Decision: `docs/EXPLAIN/decisions/2026-09-29-clip-throttle-scopes.md`.

**Open:**
- **`scrape_audio` and the `scrape_and_import` task are dead at import time** — both import license helpers that no longer exist in `ai_ml/scrapers/base.py`. Not touched by mobile Phase 2; needs a decision (restore helpers or delete the scraper properly).
- `test_task_publisher.py::TestFlushTelemetryInvalidation` (3) still fails deterministically, not root-caused.
- Media worker image still needs a rebuild for the `tasks.py` import fix to be permanent; currently `docker cp`'d in.

---

## DOs and DON'Ts

Accumulated from user corrections. Append on your own when corrected.

| DO | DON'T |
|---|---|
| Decisions → `docs/EXPLAIN/decisions/`, not AGENTS.md | Inlining long regulatory/explanatory content |
| Lessons learned → AGENTS.md, max 3 lines per bullet | Listing full decision rationale in AGENTS.md |
| DOs/DON'Ts → AGENTS.md, updated automatically on correction | Duplicating env-var tables across sections |
| Link to docs instead of inlining | Asking permission to correct AGENTS.md after a user correction |
| Record session learnings with `YYYY-MM-DD` slug format | Leaving entries unresolved indefinitely |

_(No user-corrected entries yet — add rows above as corrections come in.)_
