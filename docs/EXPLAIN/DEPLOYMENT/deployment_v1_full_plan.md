# EchoFlow — Hybrid Deployment V1: Complete Implementation Plan

> **Target:** ~$6/month (or $0/month with Oracle Always Free).  
> **Architecture:** Small VPS (light services) + Laptop (heavy media worker) + Cloudflare R2 (object storage) + Tailscale (private connectivity).  
> **Domain:** `echoflow.in`  
> **Frontend:** Cloudflare Pages at `app.echoflow.in`  
> **API:** `api.echoflow.in` (Cloudflare Tunnel → VPS nginx → gunicorn)  
> **HLS Playback:** `media.echoflow.in` (Cloudflare Custom Domain → R2, direct, no VPS hop)  
> **Connectivity:** Tailscale subnet router for laptop → VPS private network

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Service Split: What Runs Where](#2-service-split-what-runs-where)
3. [Data Flow: End-to-End](#3-data-flow-end-to-end)
4. [Connectivity: Tailscale + Cloudflare Tunnel](#4-connectivity-tailscale--cloudflare-tunnel)
5. [File Inventory: New Files, Edits, No-Touch Files](#5-file-inventory-new-files-edits-no-touch-files)
6. [Phase 1: `feat/hybrid-vps` — 4 Commits](#6-phase-1-feathybridvps--4-commits)
7. [Phase 2: `feat/hybrid-laptop` — 3 Commits](#7-phase-2-feathybridlaptop--3-commits)
8. [Phase 3: Review](#8-phase-3-review)
9. [Edge Cases and Failure Modes](#9-edge-cases-and-failure-modes)
10. [Test Strategy](#10-test-strategy)
11. [Alternative Approaches Considered](#11-alternative-approaches-considered)
12. [Impact on Existing Codebase](#12-impact-on-existing-codebase)
13. [Assumptions and Ambiguities](#13-assumptions-and-ambiguities)
14. [Deployment Checklist](#14-deployment-checklist)
15. [Migration Path: When You Outgrow This](#15-migration-path-when-you-outgrow-this)

---

## 1. Architecture Overview

### 1.1 Current State (on `main`)

The repository has a **14-service** `docker-compose.yml` running everything on one host:

| Service | Image | Purpose |
|---|---|---|
| `db` | `pgvector/pgvector:pg16` | PostgreSQL 16 + pgvector (HNSW indexes) |
| `pgbouncer` | `echoflow/pgbouncer:local` | Connection pooler (transaction mode, 25 connections) |
| `redis_broker` | `redis:7-alpine` | Celery message broker (noeviction, 512 MB) |
| `redis_cache` | `redis:7-alpine` | Django cache + feed lists (allkeys-lru, 3 GB) |
| `minio` | `minio/minio:RELEASE.2025-09-07T16-13-09Z` | S3-compatible object storage (dev) |
| `minio-init` | `minio/mc:RELEASE.2025-08-13T08-35-41Z` | One-shot bucket creation |
| `web` | `devansh1012007/echoflow-api:${TAG:-latest}` (target: `api`) | Django/gunicorn (4 workers, 4 threads) |
| `celery` | `devansh1012007/echoflow-api:${TAG:-latest}` (target: `api`) | Celery worker (default queue) |
| `celery_feed` | `devansh1012007/echoflow-api:${TAG:-latest}` (target: `api`) | Celery worker (`-Q fast_feed`, concurrency=4) |
| `celery_media` | `devansh1012007/echoflow-media:${TAG:-latest}` (target: `media`) | Celery worker (`-Q heavy_media`, Whisper + ST + KeyBERT) |
| `celery_beat` | `devansh1012007/echoflow-api:${TAG:-latest}` (target: `api`) | Celery beat scheduler |
| `nginx` | `nginx:1.27-alpine` | TLS terminator (:80, :443, :9443) |
| `prometheus` | `prom/prometheus:v2.55.0` | Metrics scraper (15s interval) |
| `grafana` | `grafana/grafana:11.2.0` | Dashboards |

All services share one Docker network. Media is stored on MinIO. The `api` Docker image (built from `Dockerfile:130-166`) serves `web`, `celery`, `celery_feed`, and `celery_beat`. The `media` Docker image (`Dockerfile:169-195`) serves `celery_media` only.

### 1.2 Target State (Hybrid)

**VPS** (Hetzner CX22 or Oracle A1):

| Service | Image | Purpose |
|---|---|---|
| `db` | `pgvector/pgvector:pg16` | PostgreSQL 16 + pgvector (local NVMe) |
| `redis_broker` | `redis:7-alpine` | Celery message broker (noeviction, 512 MB) |
| `redis_cache` | `redis:7-alpine` | Django cache + feed lists (allkeys-lru, **1 GB**) |
| `web` | `echoflow-api:${TAG:-latest}` (target: `api`) | Django/gunicorn (2 workers, 4 threads) |
| `celery` | `echoflow-api:${TAG:-latest}` (target: `api`) | Celery worker (default queue) |
| `celery_feed` | `echoflow-api:${TAG:-latest}` (target: `api`) | Celery worker (`-Q fast_feed`) |
| `celery_beat` | `echoflow-api:${TAG:-latest}` (target: `api`) | Celery beat scheduler |
| `nginx` | `nginx:1.27-alpine` | TLS terminator (:80, :443 only) |

**Laptop**:

| Service | Image | Purpose |
|---|---|---|
| `celery_media` | `echoflow-media:${TAG:-latest}` (target: `media`) | Celery worker (`-Q heavy_media`, Whisper + ST + KeyBERT) |

**Cloudflare**:

| Hostname | Route | Purpose |
|---|---|---|
| `api.echoflow.in` | Cloudflare Tunnel → VPS cloudflared → nginx → gunicorn | API entrypoint |
| `media.echoflow.in` | Cloudflare Custom Domain → R2 (direct) | HLS playback |
| `app.echoflow.in` | Cloudflare Pages | Frontend |

**Removed from VPS**: `pgbouncer`, `minio`, `minio-init`, `celery_media`, `prometheus`, `grafana`.

### 1.3 Key Design Decisions

1. **`settings.py:495`** — Already has `"auto"` in the region allowlist. Untouched. The codebase is already R2-ready.
2. **`docker/nginx.conf`** — Reused as-is on VPS. The unused `minio_backend` upstream and `:9443` server block are harmless because port 9443 is not published on the VPS compose.
3. **Heartbeat Redis** — Broker Redis (`REDIS_BROKER_URL`). The laptop writes the heartbeat key; the API reads from the same place.
4. **Laptop → VPS connectivity** — **Tailscale** with subnet router (`172.28.0.0/16`). Fixed Docker IPs via `networks:` block. No public ports exposed.
5. **Cloudflare Tunnel** — VPS runs `cloudflared` for `api.echoflow.in` (user installs separately). Laptop runs `cloudflared` optionally for API access.
6. **pg_dump** — Local disk (`/backups/echoflow-$(date +%F).sql.gz`) → upload to R2 via `aws s3 cp` or `mc cp`.
7. **Gunicorn workers** — In `.env.vps.example` (`GUNICORN_WORKERS=2` for 4 GB VPS).
8. **PgBouncer** — Removed. Direct DB connection at 50 users. Saves ~256 MB RAM.
9. **`redis_cache` memory** — Hardcoded 1 GB (reduced from 3 GB in main compose). At 50 users, 1 GB is more than enough.
10. **`wait_for_db.py`** — Kept on laptop (same pattern as main compose). More robust with tunnel latency.

---

## 2. Service Split: What Runs Where

### 2.1 VPS Services (8 services)

| Service | Docker Image | Queue | Memory Limit | Why on VPS |
|---|---|---|---|---|
| `db` | `pgvector/pgvector:pg16` | N/A | 2 GB | Data integrity matters. Local NVMe is fast. Backups are simpler. |
| `redis_broker` | `redis:7-alpine` | Celery broker | 1 GB | Shared between VPS workers and laptop worker. Must be reachable from both. |
| `redis_cache` | `redis:7-alpine` | Django cache | 1 GB | Reduced from 3 GB (main compose). At 50 users, 1 GB is more than enough. |
| `web` | `echoflow-api:latest` (target: `api`) | N/A | 1 GB | Always-on. Handles user requests. Must be on a public-facing host. |
| `celery` | `echoflow-api:latest` (target: `api`) | `default` | 1 GB | Light tasks: counter flushes, cache invalidation, telemetry. |
| `celery_feed` | `echoflow-api:latest` (target: `api`) | `fast_feed` | 1 GB | Feed refill, vector evolution. CPU-light, lots of Redis calls. |
| `celery_beat` | `echoflow-api:latest` (target: `api`) | N/A | 256 MB | Scheduler. Must be exactly 1 instance. |
| `nginx` | `nginx:1.27-alpine` | N/A | 128 MB | Public-facing. Terminates TLS for the Cloudflare tunnel. |

### 2.2 Laptop Services (1 service)

| Service | Docker Image | Queue | Memory Limit | Why on Laptop |
|---|---|---|---|---|
| `celery_media` | `echoflow-media:latest` (target: `media`) | `heavy_media` | 4 GB | Burst workload (1-10 clips/day × 30-300s). Whisper base = 1.5 GB + ST = 0.5 GB + KeyBERT = 0.1 GB + librosa + temp scratch = 2-4 GB total. Laptop RAM (8-16 GB) handles this; VPS (4 GB) does not. |

### 2.3 What Was Removed and Why

| Removed Service | Reason | RAM Saved |
|---|---|---|
| `pgbouncer` | At 50 users, direct DB connection is fine. Saves ~256 MB. | ~256 MB |
| `minio` | R2 replaces it. Zero egress fees. | 0 (no memory) |
| `minio-init` | R2 bucket created via dashboard. | 0 (one-shot) |
| `celery_media` | Laptop-only. Heavy media processing. | 0 (runs on laptop) |
| `prometheus` | Out of scope for 50-user / $6 budget. | 512 MB |
| `grafana` | Out of scope for 50-user / $6 budget. | 512 MB |
| **Total RAM savings** | | **~1.272 GB** (plus redis_cache reduction from 3 GB to 1 GB = ~2 GB total) |

---

## 3. Data Flow: End-to-End

### 3.1 User Uploads a Clip (Unchanged Code Path)

```
Browser (app.echoflow.in)
  │ POST /clips/ (multipart/form-data)
  ▼
Cloudflare (api.echoflow.in, TLS + Bot Fight Mode)
  │
  ▼
Cloudflare Tunnel → VPS cloudflared → nginx (:443)
  │ X-Forwarded-Proto: https, X-Real-IP, X-Forwarded-For
  ▼
gunicorn → Django (web container, port 8000)
  │
  │ AudioUploadViewSet.create() [backend/app/views/content.py:34-50]
  │   1. Validates upload (DRF throttle: 20/hr)
  │   2. Saves AudioClip to DB (status='processing', moderation_approved=False)
  │   3. Uploads original_file to R2 uploads/ prefix (via django-storages)
  │   4. calls uploads_svc.finalize_upload(clip)
  │
  │ finalize_upload() [backend/app/services/uploads.py:19-39]
  │   - Sets moderation_approved=False
  │   - transaction.on_commit(lambda: None) — does NOT enqueue HLS task
  │     (moderation must be approved first)
  │
  ▼
Response: 202 Accepted {"message": "...", "clip_id": "...", "status": "processing"}
```

**No code changes in this path.** The upload flow is identical. The only difference is:
- R2 replaces MinIO (env-driven, `STORAGES["default"]` in `settings.py:456-490`)
- The VPS has no `minio` service, so `minio-init` dependency is removed from `web` service

### 3.2 Moderator Approves a Clip (Unchanged Code Path)

```
Browser → POST /clips/{id}/approve-moderation/
  │
  ▼
Django (web container)
  │
  │ AudioUploadViewSet.approve_moderation() [content.py:69-100]
  │   1. Runs moderation check (content_moderation.py)
  │   2. Sets moderation_approved=True
  │   3. calls uploads_svc.trigger_hls_processing(clip)
  │
  │ trigger_hls_processing() [uploads.py:42-50]
  │   - transaction.on_commit(lambda: publish(process_audio_to_hls, str(clip.id)))
  │   - publish() → task.apply_async() → routes to 'heavy_media' queue
  │
  ▼
Response: 200 OK {"status": "approved", "message": "..."}
```

**No code changes.** The `publish()` function (task_publisher.py:36) calls `task.apply_async()`, which routes `process_audio_to_hls` to `heavy_media` queue via `CELERY_TASK_ROUTES` in `settings.py:264-267`.

### 3.3 Media Worker Processes the Clip (NEW Location: Laptop)

```
Celery broker (Redis on VPS, heavy_media queue)
  │
  │ [Laptop] celery_media worker (-Q heavy_media)
  │   picks up the task from Redis (via Tailscale)
  │
  ▼
process_audio_to_hls() [backend/app/tasks.py:165+]
  1. Downloads original_file from R2 uploads/ to /tmp/{clip_id}.wav
  2. Runs ffmpeg normalize → librosa.extract_acoustic_vector()
  3. Runs faster-whisper → transcript
  4. Runs sentence-transformers → semantic_vector (384-d)
  5. Runs KeyBERT → tags
  6. Runs ffmpeg HLS encode (192/128/64 kbps ABR) → /tmp/hls-{clip_id}/
  7. Uploads all HLS files to R2 hls/{clip_id}/... (public-read)
  8. Updates AudioClip row: hls_playlist_url='hls/{clip_id}/master.m3u8', status='ready'
  9. Cleans up /tmp scratch
```

**No code changes.** The `process_audio_to_hls` task is queue-agnostic — it doesn't know where it runs. It downloads from R2 (via `default_storage`), processes, uploads to R2, updates DB. All connections go through Tailscale (Redis + Postgres).

### 3.4 Browser Plays HLS (NEW Path: Direct to R2)

```
Browser (app.echoflow.in)
  │ GET https://media.echoflow.in/hls/{clip_id}/master.m3u8
  │ (URL was baked into the feed response by media_urls.py:43-59)
  ▼
Cloudflare (media.echoflow.in, Custom Domain)
  │
  ▼
R2 (echoflow-media bucket, hls/ prefix, public-read)
  │
  ▼
Returns master.m3u8 → hls.js fetches variant playlists → .ts segments
```

**No code changes.** `media_urls.py:43-59` builds the URL from `PUBLIC_MEDIA_ENDPOINT_URL` env var. The browser just fetches it. Cloudflare caches segments.

### 3.5 Heartbeat Pattern (NEW Code)

```
[Laptop] scripts/laptop-heartbeat.sh (background process)
  │ Every 30 seconds:
  │   redis-cli SET media_worker:alive <unix_ts> EX 60
  │
  ▼
VPS: GET /api/v1/health/media-worker/
  │ Reads media_worker:alive from Redis broker
  │ Returns {"media_worker_alive": true/false}
  ▼
Frontend polls this endpoint, shows "Processing delayed" when false
```

This is the **only new code** — a single view + one URL route + one test.

---

## 4. Connectivity: Tailscale + Cloudflare Tunnel

### 4.1 Cloudflare Tunnel (VPS → Cloudflare)

The VPS runs `cloudflared` to expose `api.echoflow.in` to the public internet. This is the ONLY public-facing tunnel.

```
Browser → Cloudflare (api.echoflow.in) → VPS cloudflared → nginx → gunicorn
```

**Configuration (user installs separately):**

```yaml
# /etc/cloudflared/config.yml on VPS
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: api.echoflow.in
    service: http://nginx:80
  - service: http_status:404
```

### 4.2 Tailscale (Laptop ↔ VPS Private Network)

Tailscale connects the laptop to the VPS's internal services (Redis, Postgres). No public ports on the VPS.

```
Laptop → Tailscale (100.x.x.x) → VPS subnet router (172.28.0.0/16) → Docker containers
```

**Step 1: Install Tailscale on both machines**

```bash
# On VPS
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On laptop
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Both machines join the same tailnet. The VPS gets a Tailscale IP (e.g., `100.73.0.1`). The laptop gets its own Tailscale IP (e.g., `100.82.0.1`).

**Step 2: VPS Docker services listen on Docker-internal addresses**

The VPS compose runs `redis_broker:6379` and `db:5432` on Docker-internal addresses. These are NOT exposed to the public internet. The laptop connects via Tailscale's private network.

**Step 3: VPS advertises Docker subnet to Tailscale**

```bash
# On VPS
sudo tailscale up --advertise-routes=172.28.0.0/16
```

This makes the entire Docker network reachable from the laptop via Tailscale.

**Step 4: Laptop connects via Tailscale IPs**

```bash
# .env.laptop.example
DATABASE_URL=postgres://echoflow:<db-password>@172.28.0.4:5432/echoflow_db
REDIS_BROKER_URL=redis://172.28.0.2:6379/0
REDIS_CACHE_URL=redis://172.28.0.3:6379/0
```

The Tailscale IPs (`172.28.0.2`, `172.28.0.3`, `172.28.0.4`) are the Docker container IPs on the VPS. They are stable because we use a custom Docker network with fixed IPs (see `docker-compose.vps.yml` below).

### 4.3 Cloudflare Custom Domain (R2)

R2 supports custom domains via Cloudflare. The user must:
1. Create a custom domain in the R2 bucket settings
2. Point `media.echoflow.in` at the R2 `r2.dev` subdomain
3. Cloudflare handles TLS (Universal SSL, free)

### 4.4 Cloudflare Pages (Frontend)

The frontend at `app.echoflow.in` is hosted on Cloudflare Pages. The user must:
1. Connect their GitHub repo to Cloudflare Pages
2. Set build command: `npm run build`
3. Set output directory: `dist/`

### 4.5 Tradeoffs: Tailscale vs Cloudflare Tunnel (for laptop connectivity)

| Aspect | Tailscale | Cloudflare Tunnel (private) |
|---|---|---|
| Setup complexity | Low (install + `tailscale up`) | Medium (Zero Trust network, WARP, cloudflared config) |
| Reliability | High (dedicated wireguard-based mesh) | High (Cloudflare's network) |
| Public exposure | None (private network only) | None (private routing only) |
| Cross-platform | macOS, Linux, Windows, iOS, Android | Linux, macOS, Windows |
| Cost | Free for personal use (up to 3 devices, 100 users) | Free (unlimited devices) |
| Latency | ~5-20 ms (wireguard) | ~20-100 ms (Cloudflare edge) |
| Docker support | Requires subnet router for container IPs | Requires TCP tunnel config |
| Your use case | **Best fit** (VPS + laptop, 2 machines) | Overkill for 2 machines |

---

## 5. File Inventory: New Files, Edits, No-Touch Files

### 5.1 New Files (Zero Impact on Existing Code)

| File | Branch | Lines | Purpose |
|---|---|---|---|
| `docker-compose.vps.yml` | `feat/hybrid-vps` | ~150 | Slimmed compose: web, celery, celery_feed, celery_beat, db, redis_broker, redis_cache, nginx |
| `.env.vps.example` | `feat/hybrid-vps` | ~40 | Production env: R2 keys, tunnel creds, production secrets |
| `scripts/vps-deploy.sh` | `feat/hybrid-vps` | ~60 | One-shot deploy on VPS |
| `backend/app/views/system_health.py` | `feat/hybrid-vps` | ~25 | Heartbeat endpoint |
| `backend/app/tests/test_system_health.py` | `feat/hybrid-vps` | ~60 | Heartbeat endpoint tests |
| `docker-compose.laptop.yml` | `feat/hybrid-laptop` | ~30 | One-service compose: celery_media |
| `.env.laptop.example` | `feat/hybrid-laptop` | ~35 | Worker env: tunnel creds, HF_TOKEN |
| `scripts/laptop-deploy.sh` | `feat/hybrid-laptop` | ~40 | One-shot on laptop |
| `scripts/laptop-heartbeat.sh` | `feat/hybrid-laptop` | ~20 | Background heartbeat process |

### 5.2 Existing Files with Additive Edits

| File | Lines Changed | Change |
|---|---|---|
| `backend/EchoFlow/urls.py` | +1 | Add `path("api/v1/health/media-worker/", media_worker_health)` |

### 5.3 Existing Files That MUST NOT Change

| File | Reason |
|---|---|
| `docker-compose.yml` | Local dev workflow — must keep all 14 services |
| `Dockerfile` | `api` and `media` targets are already correct |
| `docker/nginx.conf` | HLS goes direct to R2 via Cloudflare Custom Domain; no nginx hop needed |
| `backend/EchoFlow/settings.py` | `region_name="auto"` already in allowlist (line 495) |
| `backend/app/tasks.py` | `process_audio_to_hls` is queue-agnostic |
| `backend/app/services/uploads.py` | `finalize_upload` and `trigger_hls_processing` work as-is |
| `backend/app/media_urls.py` | `get_hls_playback_url` reads `PUBLIC_MEDIA_ENDPOINT_URL` from env |
| `backend/EchoFlow/celery.py` | Task discovery and routing unchanged |
| `backend/app/urls.py` | No new routes needed (heartbeat is in root urls.py) |
| `frontend/sample_frontend/src/api/client.ts` | Already reads `VITE_API_BASE_URL` from env |
| `.env.example` | Local dev — MinIO, full stack. New `.env.*.example` files are separate |
| `requirements-base.txt` | `redis` is already installed (via `django-redis`) |
| `requirements-media.txt` | No new deps needed |

---

## 6. Phase 1: `feat/hybrid-vps` — 4 Commits

### 6.1 Commit 1: `feat(deploy): add docker-compose.vps.yml`

**New file** (~150 lines). Slimmed compose from `docker-compose.yml` with these removals:

| Removed | Reason |
|---|---|
| `pgbouncer` | Direct DB connection at 50 users; saves ~256 MB |
| `minio` | R2 replaces it |
| `minio-init` | R2 bucket created via dashboard |
| `celery_media` | Laptop-only |
| `prometheus` | Out of scope for 50-user / $6 budget |
| `grafana` | Out of scope |

**Key changes from main compose:**

| Setting | Main Compose | VPS Compose |
|---|---|---|
| `DATABASE_URL` | `postgres://echoflow:…@pgbouncer:6432/echoflow_db` | `postgres://echoflow:…@db:5432/echoflow_db` |
| `AWS_S3_ENDPOINT_URL` | `http://minio:9000` | `https://<accountid>.r2.cloudflarestorage.com` |
| `PUBLIC_MEDIA_ENDPOINT_URL` | `https://localhost:9443` | `https://media.echoflow.in` |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | `api.echoflow.in,media.echoflow.in` |
| `DJANGO_CORS_ALLOWED_ORIGINS` | `https://localhost:3000,...` | `https://app.echoflow.in` |
| `GUNICORN_WORKERS` | `4` | `2` (4 GB VPS) |
| `redis_cache` maxmemory | `3gb` | `1gb` (hardcoded) |
| `nginx` ports | `80:80`, `443:443`, `9443:9443` | `80:80`, `443:443` (no 9443) |

**Services:** `db`, `redis_broker`, `redis_cache`, `web`, `celery`, `celery_feed`, `celery_beat`, `nginx`

**Networks block (new):**

```yaml
networks:
  echoflow:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16

services:
  redis_broker:
    networks:
      echoflow:
        ipv4_address: 172.28.0.2
  redis_cache:
    networks:
      echoflow:
        ipv4_address: 172.28.0.3
  db:
    networks:
      echoflow:
        ipv4_address: 172.28.0.4
```

**Key dependency changes:**
- `web`: removes `depends_on: pgbouncer`, `depends_on: minio-init`
- `celery`: removes `depends_on: pgbouncer`, `depends_on: minio-init`
- `celery_feed`: removes `depends_on: pgbouncer`
- `celery_beat`: removes `depends_on: pgbouncer`
- `nginx`: removes `depends_on: minio`

**Volumes:** Removes `minio_data`, `prometheus_data`, `grafana_data`. Keeps `postgres_data`, `redis_broker_data`, `redis_cache_data`.

### 6.2 Commit 2: `feat(deploy): add .env.vps.example`

**New file** (~40 lines). Mirrors `.env.example` with production values:

| Variable | Value |
|---|---|
| `DJANGO_DEBUG` | `False` |
| `DJANGO_SECRET_KEY` | `change-me` (with generation hint) |
| `DJANGO_ALLOWED_HOSTS` | `api.echoflow.in,media.echoflow.in` |
| `DJANGO_CORS_ALLOWED_ORIGINS` | `https://app.echoflow.in` |
| `DB_NAME` | `echoflow_db` |
| `DB_USER` | `echoflow` |
| `DB_PASSWORD` | `change-me-strong-password` |
| `DATABASE_URL` | `postgres://echoflow:change-me-strong-password@db:5432/echoflow_db` |
| `REDIS_URL` | (not needed — split URLs) |
| `REDIS_BROKER_URL` | `redis://redis_broker:6379/0` |
| `REDIS_CACHE_URL` | `redis://redis_cache:6379/0` |
| `AWS_ACCESS_KEY_ID` | `<your-r2-access-key>` |
| `AWS_SECRET_ACCESS_KEY` | `<your-r2-secret>` |
| `AWS_STORAGE_BUCKET_NAME` | `echoflow-media` |
| `AWS_S3_ENDPOINT_URL` | `https://<accountid>.r2.cloudflarestorage.com` |
| `AWS_S3_REGION_NAME` | `auto` (R2) |
| `AWS_S3_QUERYSTRING_EXPIRE` | `3600` |
| `PUBLIC_MEDIA_ENDPOINT_URL` | `https://media.echoflow.in` |
| `HF_TOKEN` | (empty — not needed) |
| `SENTRY_DSN` | (empty — optional) |
| `SENTRY_ENV` | `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` |
| `SENTRY_PROFILES_SAMPLE_RATE` | `0.05` |
| `GUNICORN_WORKERS` | `2` |
| `GUNICORN_THREADS` | `4` |
| `FIELD_ENCRYPTION_KEY` | `change-me` (with generation hint) |

### 6.3 Commit 3: `feat(deploy): add scripts/vps-deploy.sh`

**New file** (~60 lines). One-shot deploy script:

```bash
#!/bin/bash
# scripts/vps-deploy.sh
# One-shot deploy script for the VPS.
#
# Prerequisites:
#   - Docker + compose plugin installed
#   - cloudflared installed (user installs separately)
#   - aws CLI or mc (MinIO client) installed (for pg_dump → R2)
#   - Tailscale installed (for subnet router)

set -e

echo "=== EchoFlow VPS Deploy ==="

# Step 1: Copy .env
echo "Step 1: Copying .env.vps.example to .env..."
cp .env.vps.example .env

# Step 2: Build and start services
echo "Step 2: Building and starting services..."
docker compose -f docker-compose.vps.yml up -d --build

# Step 3: Create pgvector extension
echo "Step 3: Creating pgvector extension..."
docker compose -f docker-compose.vps.yml exec db psql -U echoflow -d echoflow_db -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Step 4: Run migrations
echo "Step 4: Running migrations..."
docker compose -f docker-compose.vps.yml exec web python manage.py migrate --noinput

# Step 5: Collect static files
echo "Step 5: Collecting static files..."
docker compose -f docker-compose.vps.yml exec web python manage.py collectstatic --noinput

# Step 6: Set up Tailscale subnet router
echo "Step 6: Setting up Tailscale subnet router..."
sudo tailscale up --advertise-routes=172.28.0.0/16 || echo "Tailscale already configured or not running"

# Step 7: Set up cron for daily pg_dump
echo "Step 7: Setting up cron for daily pg_dump..."
( crontab -l 2>/dev/null; echo "0 3 * * * /backups/echoflow-backup.sh" ) | crontab -
mkdir -p /backups
cat > /backups/echoflow-backup.sh << 'EOF'
#!/bin/bash
set -e
DATE=$(date +%F)
docker compose -f /home/deploy/echoflow/docker-compose.vps.yml exec db pg_dump -U echoflow echoflow_db | gzip > /backups/echoflow-${DATE}.sql.gz
# Upload to R2 (using aws s3 cp or mc cp)
# aws s3 cp /backups/echoflow-${DATE}.sql.gz s3://echoflow-media/backups/
# mc cp /backups/echoflow-${DATE}.sql.gz echoflow-media/backups/
# Clean up old backups (keep 7 days)
find /backups -name "echoflow-*.sql.gz" -mtime +7 -delete
EOF
chmod +x /backups/echoflow-backup.sh

echo "=== VPS Deploy Complete ==="
echo "Next steps:"
echo "  1. Configure Cloudflare Tunnel (user installs cloudflared)"
echo "  2. Configure R2 bucket policy (hls/ public-read)"
echo "  3. Configure Cloudflare Custom Domain (media.echoflow.in → R2)"
echo "  4. Verify: curl -I https://api.echoflow.in/health/"
```

### 6.4 Commit 4: `feat(api): add /api/v1/health/media-worker/ heartbeat endpoint`

**New file:** `backend/app/views/system_health.py` (~25 lines)

```python
"""Heartbeat endpoint for media worker health check.

Returns the status of the media worker (laptop) by checking if the
`media_worker:alive` key exists in Redis broker.
"""
from django.conf import settings
import redis
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@api_view(["GET"])
@permission_classes([AllowAny])
def media_worker_health(request):
    """Check if the media worker (laptop) is alive.

    Returns:
        200: {"media_worker_alive": true/false}
        503: {"media_worker_alive": false} (Redis error)
    """
    try:
        r = redis.from_url(settings.REDIS_BROKER_URL)
        return Response({"media_worker_alive": bool(r.get("media_worker:alive"))})
    except Exception:
        return Response({"media_worker_alive": False}, status=503)
```

**Edit:** `backend/EchoFlow/urls.py` (+1 line)

```python
from .health import health_check, readiness_check
from backend.app.views.system_health import media_worker_health  # NEW

urlpatterns = [
    ...
    path("api/v1/health/media-worker/", media_worker_health),  # NEW
]
```

**New file:** `backend/app/tests/test_system_health.py` (~60 lines, 3 tests)

```python
"""Tests for the media worker heartbeat endpoint."""
import pytest
from django.test import RequestFactory


pytestmark = pytest.mark.django_db


class TestMediaWorkerHealth:
    def test_returns_true_when_heartbeat_key_exists(self, settings, monkeypatch):
        """When the heartbeat key exists, return 200 with media_worker_alive=true."""
        from backend.app.views.system_health import media_worker_health

        # Mock redis to return a truthy value
        mock_redis = type('MockRedis', (), {'get': lambda self, key: b'1234567890'})()
        monkeypatch.setattr('redis.from_url', lambda url: mock_redis)

        factory = RequestFactory()
        request = factory.get('/api/v1/health/media-worker/')
        response = media_worker_health(request)

        assert response.status_code == 200
        assert response.json() == {"media_worker_alive": True}

    def test_returns_false_when_heartbeat_key_missing(self, settings, monkeypatch):
        """When the heartbeat key is missing, return 200 with media_worker_alive=false."""
        from backend.app.views.system_health import media_worker_health

        # Mock redis to return None (key doesn't exist)
        mock_redis = type('MockRedis', (), {'get': lambda self, key: None})()
        monkeypatch.setattr('redis.from_url', lambda url: mock_redis)

        factory = RequestFactory()
        request = factory.get('/api/v1/health/media-worker/')
        response = media_worker_health(request)

        assert response.status_code == 200
        assert response.json() == {"media_worker_alive": False}

    def test_returns_503_when_redis_unreachable(self, settings, monkeypatch):
        """When Redis is unreachable, return 503 with media_worker_alive=false."""
        from backend.app.views.system_health import media_worker_health

        # Mock redis.from_url to raise an exception
        monkeypatch.setattr('redis.from_url', lambda url: (_ for _ in ()).throw(Exception("connection refused")))

        factory = RequestFactory()
        request = factory.get('/api/v1/health/media-worker/')
        response = media_worker_health(request)

        assert response.status_code == 503
        assert response.json() == {"media_worker_alive": False}
```

---

## 7. Phase 2: `feat/hybrid-laptop` — 3 Commits

### 7.1 Commit 1: `feat(deploy): add docker-compose.laptop.yml`

**New file** (~30 lines). One service: `celery_media`

```yaml
# docker-compose.laptop.yml — runs on your laptop, only the celery_media worker
# Connects to VPS services through Tailscale (private network)

services:
  celery_media:
    image: echoflow-media:local
    build:
      context: .
      dockerfile: Dockerfile
      target: media
      secrets:
        - hf_token
    restart: unless-stopped
    command: >
      sh -c "set -e && python wait_for_db.py &&
              celery -A backend.EchoFlow worker -Q heavy_media --pool=prefork --concurrency=2 --loglevel=info"
    env_file: .env
    secrets:
      - hf_token
    volumes:
      - laptop-scratch:/tmp
    deploy:
      resources:
        limits: { cpus: '4', memory: 4G }
        reservations: { cpus: '2', memory: 2G }

secrets:
  hf_token:
    environment: HF_TOKEN

volumes:
  laptop-scratch:
```

**Key differences from main compose's `celery_media`:**
- No `depends_on` for `db`, `pgbouncer`, `redis_broker`, `redis_cache`, `minio-init` (laptop talks to remote services via Tailscale)
- `DATABASE_URL` points at Tailscale IP: `postgres://echoflow:…@172.28.0.4:5432/echoflow_db`
- `REDIS_BROKER_URL` points at Tailscale IP: `redis://172.28.0.2:6379/0`
- `REDIS_CACHE_URL` points at Tailscale IP: `redis://172.28.0.3:6379/0`
- `AWS_S3_ENDPOINT_URL` points at R2: `https://<accountid>.r2.cloudflarestorage.com`
- `HF_TOKEN` is required (BuildKit secret for media image build)
- Volume: `laptop-scratch` for /tmp work (instead of no volume)
- `HF_HUB_OFFLINE=1`, `HF_HOME=/home/appuser/.cache/huggingface`

### 7.2 Commit 2: `feat(deploy): add .env.laptop.example`

**New file** (~35 lines). Laptop-specific env:

| Variable | Value |
|---|---|
| `DJANGO_DEBUG` | `False` |
| `DJANGO_SECRET_KEY` | `<same-as-vps>` (must match — signed cookies) |
| `DJANGO_ALLOWED_HOSTS` | `api.echoflow.in` (laptop doesn't serve HTTP) |
| `DB_NAME` | `echoflow_db` |
| `DB_USER` | `echoflow` |
| `DB_PASSWORD` | `<same-as-vps>` |
| `DATABASE_URL` | `postgres://echoflow:<db-password>@172.28.0.4:5432/echoflow_db` |
| `REDIS_BROKER_URL` | `redis://172.28.0.2:6379/0` |
| `REDIS_CACHE_URL` | `redis://172.28.0.3:6379/0` |
| `AWS_ACCESS_KEY_ID` | `<your-r2-access-key>` |
| `AWS_SECRET_ACCESS_KEY` | `<your-r2-secret>` |
| `AWS_STORAGE_BUCKET_NAME` | `echoflow-media` |
| `AWS_S3_ENDPOINT_URL` | `https://<accountid>.r2.cloudflarestorage.com` |
| `AWS_S3_REGION_NAME` | `auto` |
| `AWS_S3_QUERYSTRING_EXPIRE` | `3600` |
| `HF_TOKEN` | `<your-hf-token>` (required for media image build) |
| `HF_HUB_OFFLINE` | `1` |
| `HF_HOME` | `/home/appuser/.cache/huggingface` |
| `FIELD_ENCRYPTION_KEY` | `<same-as-vps>` (must match — encrypted DB fields) |

### 7.3 Commit 3: `feat(deploy): add laptop-deploy.sh and laptop-heartbeat.sh`

**New file:** `scripts/laptop-deploy.sh` (~40 lines)

```bash
#!/bin/bash
# scripts/laptop-deploy.sh
# One-shot deploy script for the laptop media worker.
#
# Prerequisites:
#   - Docker installed
#   - cloudflared installed (optional, for API access)
#   - Tailscale installed and running (for VPS connectivity)

set -e

echo "=== EchoFlow Laptop Deploy ==="

# Step 1: Ensure HF_TOKEN is set
if [ -z "${HF_TOKEN}" ]; then
  echo "ERROR: HF_TOKEN is required. Set it in your environment or .env file."
  exit 1
fi

# Step 2: Build media image
echo "Step 1: Building media image..."
docker build --target media -t echoflow-media:local --secret id=hf_token,env=HF_TOKEN .

# Step 3: Start celery_media worker
echo "Step 2: Starting celery_media worker..."
docker compose -f docker-compose.laptop.yml up -d

# Step 4: Show logs
echo "Step 3: Showing logs (Ctrl+C to detach)..."
docker compose -f docker-compose.laptop.yml logs -f celery_media
```

**New file:** `scripts/laptop-heartbeat.sh` (~20 lines)

```bash
#!/bin/bash
# scripts/laptop-heartbeat.sh
# Background process that writes `media_worker:alive` to Redis broker every 30 seconds.
# Run as: nohup bash scripts/laptop-heartbeat.sh > /tmp/heartbeat.log 2>&1 &
#
# The heartbeat key has a 60-second TTL. If the script stops (worker crashes,
# laptop sleeps), the key expires after 60 seconds and the API correctly
# reports "offline".

set -e

# Use the same Redis URL as the laptop's worker (via Tailscale)
REDIS_URL="${REDIS_BROKER_URL:-redis://172.28.0.2:6379/0}"

echo "Starting heartbeat (Redis: ${REDIS_URL})..."

while true; do
  redis-cli -u "$REDIS_URL" SET media_worker:alive "$(date +%s)" EX 60
  echo "Heartbeat set at $(date)"
  sleep 30
done
```

---

## 8. Phase 3: Review

Show diffs for all branches. Wait for approval before pushing.

---

## 9. Edge Cases and Failure Modes

### 9.1 VPS nginx with unused `minio_backend` upstream

The VPS compose mounts `./docker/nginx.conf`, which defines `upstream minio_backend { server minio:9000; }` and a `server { listen 9443 ... }` block that proxies to it. Since there's no `minio` service on the VPS and port 9443 is not published, this is **harmless** — nginx starts, listens on 443, and the `minio_backend` upstream is never resolved.

**But:** Docker Compose's `nginx` service in the VPS compose has `depends_on: web: { condition: service_healthy }, minio: { condition: service_healthy }`. Since there's no `minio` service, this will fail at compose validation time. **Fix:** Remove `minio` from `depends_on` in the VPS compose's nginx service.

### 9.2 `DATABASE_URL` without pgbouncer

The VPS `DATABASE_URL` points directly to `db:5432` (not `pgbouncer:6432`). This means:
- Each Django worker opens a direct connection to Postgres
- At 50 users with `GUNICORN_WORKERS=2` and `GUNICORN_THREADS=4`, that's at most 8 concurrent connections
- Postgres default `max_connections` is 100 — plenty of headroom
- The per-session timeouts in `settings.py:194-202` still apply (statement_timeout=30s, etc.)

**Risk:** At scale (>100 concurrent users), direct connections could exhaust Postgres `max_connections`. But at 50 users, this is fine. If the user scales up, they can add PgBouncer later (the `docker-compose.yml` already has the pgbouncer service; they'd just add it back to the VPS compose).

### 9.3 `redis_cache` memory reduction (3 GB → 1 GB)

The `main` compose sets `redis_cache` to 3 GB (`docker-compose.yml:81`). The VPS compose will set it to 1 GB. This is a **reduction** from the original design, which assumed 10K active users with P2.2 pre-computed candidate pools needing ~1.2 GB.

At 50 users, 1 GB is more than enough:
- Per-user feed lists: 50 users × 20 clips × ~200 bytes = ~200 KB
- Django cache: depends on usage, but typically <100 MB
- Telemetry stream: small (XREADGROUP drains every 10s)
- Candidate pools: at 50 users, the exploit pool is small (<50 MB)

**Risk:** If the user scales beyond 50 users, they may need to increase `redis_cache` memory. The `allkeys-lru` eviction policy means the cache will evict old entries under memory pressure — the feed refill task will rebuild them. This is safe but may cause a temporary performance hit during eviction.

### 9.4 Tailscale subnet router reliability

The laptop connects to VPS Redis and Postgres via Tailscale. This adds latency:
- Local Redis: ~1 ms
- Tailscale: ~5-20 ms (wireguard)
- Local Postgres: ~1 ms
- Tailscale: ~5-20 ms

**Impact on Celery tasks:**
- `process_audio_to_hls` downloads from R2 (public, ~10-50 ms), processes locally, uploads to R2 (public, ~10-50 ms), updates Postgres (Tailscale, ~10-30 ms). Total overhead: ~10-30 ms per DB/Redis call. With ~10 calls, that's ~100-300 ms of overhead per clip. Negligible compared to the 30-300 second processing time.

**Risk:** If the Tailscale connection drops, the laptop worker can't reach Redis or Postgres. Celery's `CELERY_TASK_REJECT_ON_WORKER_LOST=True` (settings.py:277) will requeue the task when the connection is restored. The `process_audio_to_hls` task is idempotent (overwrites `hls/{clip_id}/` and updates the row), so retries are safe.

### 9.5 `DJANGO_SECRET_KEY` and `FIELD_ENCRYPTION_KEY` must match

The VPS and laptop share the same database. If they have different `DJANGO_SECRET_KEY`, signed cookies will fail. If they have different `FIELD_ENCRYPTION_KEY`, encrypted DB fields will fail to decrypt.

**Mitigation:** Both `.env.vps.example` and `.env.laptop.example` have clear comments: `DJANGO_SECRET_KEY=<same-as-vps>` and `FIELD_ENCRYPTION_KEY=<same-as-vps>`. The deploy scripts should print these values and warn the user.

### 9.6 Heartbeat script vs worker startup order

The heartbeat script must start **after** the `celery_media` worker starts. If the heartbeat starts first, it will write `media_worker:alive` even though the worker isn't ready yet. If the worker crashes, the heartbeat script should stop too (or at least the key should expire after 60 seconds).

**Mitigation:** The `laptop-deploy.sh` script starts the worker first, then starts the heartbeat. The heartbeat script's 60-second TTL means even if the script keeps running after the worker dies, the key expires after 60 seconds and the API correctly reports "offline."

### 9.7 R2 bucket policy

The R2 bucket must have a bucket policy that makes `hls/*` public-read and keeps `uploads/*` private. This is set in the Cloudflare dashboard, not in code. If the user forgets to set this, HLS playback will fail with 403 errors.

**Mitigation:** The deploy scripts should include a verification step: `curl -I https://media.echoflow.in/hls/test-master.m3u8` to check that HLS files are accessible.

### 9.8 `media.echoflow.in` Custom Domain configuration

R2 supports custom domains via Cloudflare. The user must:
1. Create a custom domain in the R2 bucket settings
2. Point `media.echoflow.in` at the R2 `r2.dev` subdomain
3. Cloudflare handles TLS (Universal SSL, free)

**Risk:** If the custom domain is not configured, `PUBLIC_MEDIA_ENDPOINT_URL=https://media.echoflow.in` will 404. The user must configure this in the Cloudflare dashboard.

### 9.9 CORS for the frontend

The frontend at `app.echoflow.in` makes requests to `api.echoflow.in`. Django's `CORS_ALLOWED_ORIGINS` must include `https://app.echoflow.in`. This is set in `.env.vps.example`.

**Risk:** If the user sets `DJANGO_CORS_ALLOWED_ORIGINS` incorrectly, the browser will block preflight requests and the frontend will fail to load data.

---

## 10. Test Strategy

### 10.1 What Existing Tests Guarantee

The existing test suite (23 files, `backend/app/tests/`) covers:
- `test_smoke.py`: pytest-django is wired correctly
- `test_services_uploads.py`: `finalize_upload` enqueues `process_audio_to_hls` on commit
- `test_services_comments.py`, `test_services_follows.py`, `test_services_interactions.py`, `test_services_shares.py`: service-layer tests
- `test_counter_store.py`: Redis counter store
- `test_db_router.py`: Read replica router
- `test_feed_pool.py`: Feed candidate pool
- `test_https_termination.py`: HTTPS termination (32 tests)
- `test_integration_concurrency.py`: Concurrency tests
- `test_integration_pgvector.py`: pgvector integration
- `test_metrics_endpoint.py`: Prometheus metrics endpoint
- `test_metrics.py`: Custom metrics
- `test_observability_tui.py`: TUI script
- `test_orphan_cleanup.py`: HLS cleanup task
- `test_scraper.py`: Scraper tests
- `test_security_and_validation.py`: Security tests
- `test_sentry.py`: Sentry integration
- `test_settings.py`: Settings validation
- `test_task_publisher.py`: Task publisher (correlation_id)

**What they DON'T cover:** Compose file validation, deployment scripts, tunnel connectivity, R2 integration, heartbeat endpoint.

### 10.2 New Tests Needed

**`test_system_health.py`** (new file, 3 tests):
1. `test_returns_true_when_heartbeat_key_exists` — heartbeat key present → 200 with `{"media_worker_alive": true}`
2. `test_returns_false_when_heartbeat_key_missing` — heartbeat key absent → 200 with `{"media_worker_alive": false}`
3. `test_returns_503_when_redis_unreachable` — Redis error → 503 with `{"media_worker_alive": false}`

**Compose file validation** (not a pytest test, but a validation step):
- `docker compose -f docker-compose.vps.yml config` — parses the YAML, validates service definitions, ensures no undefined references
- `docker compose -f docker-compose.laptop.yml config` — same

**Deploy script validation** (manual, not automated):
- `bash scripts/vps-deploy.sh --dry-run` — validates env vars, checks Docker is installed
- `bash scripts/laptop-deploy.sh --dry-run` — same

### 10.3 What Will NOT Be Tested

- **Tailscale connectivity** — requires actual Tailscale account and tailnet setup
- **R2 bucket policy** — requires actual R2 bucket with correct policy
- **HLS playback** — requires actual media processing and playback
- **Laptop hardware** — Whisper model loading, ffmpeg encoding, etc.

These are operational validations, not code validations. They must be done manually during deployment.

---

## 11. Alternative Approaches Considered

### 11.1 Alternative: Edit `docker-compose.yml` on `main` instead of creating new files

**Rejected.** The original `docker-compose.yml` is the local dev workflow. It must keep all 14 services (MinIO, Prometheus, Grafana, full media worker) so `docker compose up --build` still works on a fresh clone. Touching this file breaks local dev for everyone else.

### 11.2 Alternative: Single branch with conditional compose files

**Rejected.** The VPS and laptop have different services, different `.env` files, and different resource limits. A single branch with conditional logic would be more complex and harder to review than two small, focused branches.

### 11.3 Alternative: Deploy heartbeat endpoint to `backend/EchoFlow/health.py` instead of new file

**Rejected.** The existing `health.py` serves Docker health probes (`/health/`, `/ready/`). The heartbeat endpoint is a DRF API endpoint (needs `@api_view`, `@permission_classes`, `Response`). Mixing Docker health checks with DRF API endpoints in the same file would be architecturally messy.

### 11.4 Alternative: Use `django.core.cache` for heartbeat instead of direct Redis

**Rejected.** The heartbeat is written by the laptop to the **broker** Redis (the same Redis the worker uses). The API endpoint would need to read from the **cache** Redis (a different Redis, different URL). Cross-Redis reads are error-prone and add unnecessary complexity. Using direct `redis.from_url(settings.REDIS_BROKER_URL)` is simpler and more correct.

### 11.5 Alternative: Skip the heartbeat endpoint entirely

**Considered.** The user can manually check `redis-cli GET media_worker:alive` on the VPS. The endpoint is a UX enhancement, not a functional requirement.

**Decision:** Ship it. It's 30 lines of code + 3 tests + 1 URL route. The UX win ("Processing delayed" badge) is real and the cost is minimal.

### 11.6 Alternative: Cloudflare Tunnel (private) instead of Tailscale

**Considered.** Cloudflare's private tunnel routing would work, but it requires:
- Setting up Cloudflare Zero Trust network
- Installing WARP or cloudflared on both machines
- Configuring private routing rules

**Rejected.** Tailscale is simpler (just `tailscale up` on both machines), more reliable (dedicated wireguard mesh), and better suited for a 2-machine setup (VPS + laptop).

### 11.7 Alternative: Expose Redis/Postgres on VPS public IP with firewall rules

**Rejected.** This increases attack surface unnecessarily. Even with firewall rules limiting access to the laptop's IP, it's still a public-facing port that could be probed or scanned.

---

## 12. Impact on Existing Codebase

### 12.1 No Impact

- `backend/app/tasks.py` — `process_audio_to_hls` is queue-agnostic
- `backend/app/models.py` — vector fields, AudioClip model unchanged
- `backend/app/serializers.py` — upload serializer unchanged
- `backend/app/views/content.py` — upload view unchanged
- `backend/app/services/uploads.py` — finalize_upload, trigger_hls_processing unchanged
- `backend/app/services/task_publisher.py` — publish() unchanged
- `backend/app/services/feed_pool.py` — candidate pool unchanged
- `backend/app/services/counter_store.py` — counter store unchanged
- `backend/app/services/comments.py`, `interactions.py`, `follows.py`, `shares.py`, `content_moderation.py` — unchanged
- `backend/EchoFlow/celery.py` — task discovery, routing, correlation unchanged
- `frontend/sample_frontend/src/api/client.ts` — already reads `VITE_API_BASE_URL`
- `Dockerfile` — `api` and `media` targets unchanged
- `docker/nginx.conf` — untouched (HLS goes direct to R2)
- `.env.example` — local dev, untouched

### 12.2 Minimal Impact (One-Line Additive Changes)

- `backend/EchoFlow/urls.py` — one new `path()` line
- `backend/app/views/__init__.py` — no change needed (function-based view imported directly)

### 12.3 New Files (Zero Impact on Existing Code)

- `docker-compose.vps.yml` — new file, no existing file touched
- `docker-compose.laptop.yml` — new file, no existing file touched
- `.env.vps.example` — new file, no existing file touched
- `.env.laptop.example` — new file, no existing file touched
- `scripts/vps-deploy.sh` — new file, no existing file touched
- `scripts/laptop-deploy.sh` — new file, no existing file touched
- `scripts/laptop-heartbeat.sh` — new file, no existing file touched
- `backend/app/views/system_health.py` — new file, no existing file touched
- `backend/app/tests/test_system_health.py` — new file, no existing file touched

---

## 13. Assumptions and Ambiguities

### 13.1 Assumptions

1. **The user has a Cloudflare account** with the domain `echoflow.in` already registered and nameservers pointing to Cloudflare.
2. **The user has a Hetzner or Oracle account** for the VPS.
3. **The user's laptop has Docker installed** (or will install it).
4. **The user's laptop has 8+ GB RAM** (required for Whisper + ST + KeyBERT).
5. **The user's laptop has a stable internet connection** (required for tunnel connectivity).
6. **The user will create the R2 bucket and set the bucket policy** in the Cloudflare dashboard (not in code).
7. **The user will configure the Cloudflare Custom Domain** for `media.echoflow.in` (not in code).
8. **The user will configure the Cloudflare Tunnel** with the public hostname `api.echoflow.in` (not in code).
9. **The user will install Tailscale** on both the VPS and the laptop (not in code).
10. **The user will install cloudflared** on the VPS (not in code, user installs separately).

### 13.2 Ambiguities

1. **Which Hetzner instance?** The doc mentions CX22 (4 GB) and CPX21 (8 GB). The VPS compose assumes 4 GB. If the user gets an 8 GB instance, they can increase `GUNICORN_WORKERS` and `redis_cache` memory.
2. **Oracle A1 ARM architecture?** If the user uses Oracle A1 (ARM), the Docker images must be multi-arch or built on ARM. The existing `Dockerfile` uses `python:3.11-slim-bookworm` which supports ARM.
3. **Frontend build process?** The doc assumes Cloudflare Pages. The user needs to configure the build command (`npm run build`) and output directory (`dist/`).
4. **SSL certificate for `api.echoflow.in`?** Cloudflare's Universal SSL handles this automatically. No manual cert management needed.
5. **`DJANGO_SECRET_KEY` and `FIELD_ENCRYPTION_KEY` generation?** The `.env.vps.example` should include hints for generating these (like the existing `.env.example` does for `DJANGO_SECRET_KEY`).

### 13.3 Conflicts with Existing Implementation

**None.** The existing code was already designed for S3-compatible storage (R2), queue-based task routing (Celery), and env-driven configuration. The hybrid deployment leverages these existing patterns rather than fighting them.

---

## 14. Deployment Checklist

### 14.1 Pre-Deployment (Cloudflare)

- [ ] Add `echoflow.in` to Cloudflare
- [ ] Update nameservers at registrar to point to Cloudflare
- [ ] Create R2 bucket: `echoflow-media`
- [ ] Create R2 API Token: `Object Read & Write` scoped to bucket
- [ ] Set R2 bucket policy: `hls/*` public-read, `uploads/*` private
- [ ] Configure Cloudflare Custom Domain: `media.echoflow.in` → R2 `r2.dev` subdomain
- [ ] Create Cloudflare Tunnel: `echoflow-vps`
- [ ] Add public hostname: `api.echoflow.in` → `http://nginx:80`

### 14.2 Pre-Deployment (VPS)

- [ ] Create Hetzner/Oracle instance
- [ ] Install Docker + compose plugin
- [ ] Install cloudflared (user installs separately)
- [ ] Install Tailscale
- [ ] Install aws CLI or mc (MinIO client) for pg_dump → R2
- [ ] Clone repo, checkout `feat/hybrid-vps`
- [ ] Copy `.env.vps.example` to `.env`, fill in real values
- [ ] Run `bash scripts/vps-deploy.sh`
- [ ] Verify: `curl -I https://api.echoflow.in/health/` → 200

### 14.3 Pre-Deployment (Laptop)

- [ ] Install Docker
- [ ] Install Tailscale
- [ ] Clone repo, checkout `feat/hybrid-laptop`
- [ ] Copy `.env.laptop.example` to `.env`, fill in real values
- [ ] Run `bash scripts/laptop-deploy.sh`
- [ ] Run `nohup bash scripts/laptop-heartbeat.sh > /tmp/heartbeat.log 2>&1 &`
- [ ] Verify: `curl -I https://api.echoflow.in/api/v1/health/media-worker/` → 200

### 14.4 End-to-End Test

- [ ] Register a user on the VPS
- [ ] Upload a clip
- [ ] Approve moderation
- [ ] Verify laptop processes the clip (check `docker compose -f docker-compose.laptop.yml logs -f celery_media`)
- [ ] Verify HLS appears in R2 `hls/` prefix
- [ ] Verify playback in browser via `https://media.echoflow.in/hls/{clip_id}/master.m3u8`

---

## 15. Migration Path: When You Outgrow This

| Trigger | Action | Cost Impact |
|---|---|---|
| Laptop unreliable (sleeps often, dies, etc.) | Move `celery_media` to the VPS (use the `media` Docker image, same `celery_media` service in `vps-compose.yml`). VPS needs more RAM (Oracle A1 with 24 GB handles this for $0/mo; Hetzner needs to upgrade to a 8 GB+ server for ~$15/mo). | Hetzner upgrade: $15/mo. Oracle A1: still $0/mo. |
| 100+ users (web load exceeds VPS) | Migrate web to a larger VPS (Hetzner CCX23, 4 vCPU / 16 GB, $30/mo) OR to AWS ECS Fargate (`docs/aws-deployment-guide.md`, $120-140/mo). | Hetzner upgrade: $30/mo. AWS: $120-140/mo. |
| 1000+ users (DB read load) | Add a read replica to the VPS (set `READ_DATABASE_URL` to the replica; the existing `ReadRouter` in `backend/app/db_routers.py` auto-activates). | $15-30/mo (Hetzner volume for the replica). |
| Commercial launch (Vercel Hobby restriction) | Migrate frontend from Vercel Hobby to Cloudflare Pages (same React build, $0/mo, no commercial restriction). | $0/mo. |
| 50,000+ users | Re-read `docs/aws-deployment-guide.md` and `docs/zero-cost-deployment.md` and pick the right scale architecture. | Varies. |

---

## Summary

| Metric | Value |
|---|---|
| New files | 10 |
| Existing files edited | 2 (each +1 line) |
| Total new code | ~700 lines |
| `docker-compose.yml` on `main` | Untouched |
| `Dockerfile` | Untouched |
| `docker/nginx.conf` | Untouched |
| `settings.py` | Untouched |
| Branches | `feat/hybrid-vps` (4 commits), `feat/hybrid-laptop` (3 commits) |
| Cost | ~$6/mo (Hetzner CX22) or $0/mo (Oracle A1) |
| Uptime | 99% (web always on; media best-effort with retry) |
| Security | Cloudflare Tunnel, Tailscale private network, R2 private uploads, DRF throttles |

---

*Last updated: 2026-09-06*
*Domain: echoflow.in*
*Frontend: app.echoflow.in (Cloudflare Pages)*
*API: api.echoflow.in (Cloudflare Tunnel → VPS)*
*HLS: media.echoflow.in (Cloudflare Custom Domain → R2)*
