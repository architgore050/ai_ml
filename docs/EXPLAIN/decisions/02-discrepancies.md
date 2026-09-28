# Documentation vs Implementation Discrepancies

This document tracks where documentation (README, AGENTS.md, audit docs) conflicts with actual implementation. **Actual code behavior is the source of truth.**

---

## README.md vs Implementation

| # | README Claim | Actual Implementation | Status |
|---|--------------|----------------------|--------|
| 1 | "DEBUG = True is hardcoded" (line 24) | `settings.py:24`: `DEBUG = os.environ.get('DJANGO_DEBUG', 'False').lower() == 'true'` — **Env-driven, default False** | ❌ Outdated |
| 2 | "CORS_ALLOW_ALL_ORIGINS = True hardcoded" (line 25) | `settings.py:63`: `CORS_ALLOW_ALL_ORIGINS = False` — **Explicitly disabled** | ❌ Outdated |
| 3 | "4 Celery workers" (line 139) | Docker Compose: `web`, `celery`, `celery_feed`, `celery_media`, `celery_beat` = **5 services** using Celery | ❌ Undercount |
| 4 | "HLS output stored under `media/hls/{clip_id}/` on local disk" (line 83) | `settings.py:270-293`: S3/MinIO storage; `tasks.py:302-323`: Uploads to `hls/{clip_id}/` in S3 | ❌ Outdated |
| 5 | "Not S3-backed yet" (line 272) | `settings.py:270-293`: Fully S3/MinIO-backed via `STORAGES["default"]` | ❌ Outdated |
| 6 | "celery_beat uses django_celery_beat" (line 148) | `settings.py:239`: Confirmed; but `celery_beat` service disables healthcheck | ⚠️ Partial |
| 7 | "Media served via Django static()" (line 174) | `urls.py:27-32`: **Explicitly no `/media/` route** — served via S3 signed URLs | ❌ Outdated |

---

## AGENTS.md vs Implementation

| # | AGENTS.md Claim | Actual Implementation | Status |
|---|-----------------|----------------------|--------|
| 1 | "DJANGO_DEBUG=False env override exists" | `settings.py:24`: **Correct** — `os.environ.get('DJANGO_DEBUG', 'False')` | ✅ Accurate |
| 2 | "CORS_ALLOW_ALL_ORIGINS hardcoded True, env override exists but code sets True after" | `settings.py:27, 63`: **Fixed** — was True, now explicitly `False` | ⚠️ Fixed |
| 3 | "requirements.txt lists librosa twice" | `requirements.txt:8, 28`: **Still duplicated** (lines 8 and 28) | ⚠️ Still exists |
| 4 | ".gitignore has *.env but .env committed" | `.gitignore`: `*.env` present; `.env` exists in repo | ⚠️ Still exists |
| 5 | "seed_db.py targets port 8005 (Docker) not 8000 (dev)" | `backend/scripts/seed_db.py:15`: `API_ENDPOINT = "http://localhost:8000"` | ✅ Accurate |
| 6 | "wait_for_db.py polls with exponential backoff (120 attempts)" | `wait_for_db.py:6-8`: `MAX_RETRIES = 120`, `BACKOFF_FACTOR = 2` | ✅ Accurate |
| 7 | "process_audio_to_hls enqueued via transaction.on_commit" | `views.py:101`: **Confirmed** | ✅ Accurate |
| 8 | "Comment count denormalized in Comment.save()/delete()" | `models.py:134-144`: **Confirmed** | ✅ Accurate |
| 9 | "UserInteraction uses F() for atomic increments" | `models.py:204-205`: **Confirmed** | ✅ Accurate |
| 10 | "Celery task routing defined in settings.py" | `settings.py:158-161`: **Confirmed** | ✅ Accurate |

---

## Backend Architecture Audit (`backend-architecture-audit.md`) vs Implementation

| # | Audit Claim | Actual Implementation | Status |
|---|-------------|----------------------|--------|
| 1 | "Recommendation algorithm broken — weights never populated" (line 36) | `tasks.py:629`: `weights.append(final_weight)` — **weights ARE populated** | ❌ False positive |
| 2 | "OPENAI_API_KEY NameError in tasks.py" (line 45) | `tasks.py:33`: `OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or ""`; `get_openai_client()` checks for empty | ❌ False positive |
| 3 | "Static FERNET_KEY in models.py" (line 52) | `models.py:16-22`: Loaded from `FIELD_ENCRYPTION_KEY` env var, fail-fast if missing | ❌ False positive |
| 4 | "No rate limiting configured" (line 105) | `settings.py:324-331`: DRF throttling configured (1000/hr user, 100/hr anon) | ❌ False positive |
| 5 | "CORS hardcoded to allow all" (line 237) | `settings.py:63`: Explicitly `False`; `CORS_ALLOWED_ORIGINS` from env | ❌ False positive |
| 6 | "Secret management — hardcoded everywhere" (line 238) | Most secrets from env vars; only `.env` file committed is a risk | ⚠️ Partially true |
| 7 | "Celery Beat uses DatabaseScheduler" | `settings.py:239`: **Confirmed** | ✅ Accurate |
| 8 | "Media to S3 done" (line 215) | `settings.py:270-293`: **Confirmed** for storage; CDN not yet configured | ⚠️ Partial |
| 9 | "PgBouncer not deployed" (line 216) | **Confirmed** — direct connections via `dj_database_url` | ✅ Accurate |
| 10 | "Decouple ML onto separate worker node" (line 217) | `celery_media` service with `--pool=solo`, separate Docker image | ✅ Accurate (partial) |
| 11 | "Batch telemetry not done" (line 218) | `views/interactions.py:88-105` + `tasks.py:591-641` + `settings.py:255-262`: Redis-buffered events + 30s batched flush via `flush_telemetry`. Synchronous fallback only on Redis outage. | ✅ Implemented |
| 12 | "Batch update_global_metrics not done" (line 219) | `tasks.py:479-548`: cursor-paginated batches of 5000 with Redis-persisted resume cursor; `FOR UPDATE SKIP LOCKED` so a batch doesn't stall on concurrent `UserInteraction` locks. | ✅ Implemented |
| 13 | "Fallback feed not done" (line 220) | `views/feed.py:65-86`: try/except wraps the Redis feed path; on any failure serves trending-by-`engagement_velocity` fallback. | ✅ Implemented |
| 14 | "Split Redis not done" (line 221) | `settings.py:158-186` + `docker-compose.yml`: `redis_broker` (noeviction, 512MB) and `redis_cache` (LRU, 1GB) as separate services. `REDIS_BROKER_URL` / `REDIS_CACHE_URL` env vars; non-Docker falls back to single `REDIS_URL`. | ✅ Implemented |
| 15 | "Validate audio by magic bytes not done" (line 222) | **Confirmed** — only extension check in `serializers.py:29-35` | ✅ Accurate (deferred) |
| 16 | "Rate limit telemetry partial" (line 223) | `settings.py:359-369` + `views/interactions.py:118-119`: per-scope rates (`telemetry:60/min`, `upload:20/hour`, `register:5/hour`, `login:10/min`, `comment:60/hour`, `share_send:100/hour`, `interaction:60/min`); `log_telemetry` overrides its scope to `telemetry` per-action. | ✅ Implemented |
| 17 | "Request tracing not done" (line 224) | `backend/EchoFlow/{correlation,middleware,logging_filters}.py` + `settings.py:106,391-410`: per-request `correlation_id` contextvar + middleware + JSON log filter. | ✅ Implemented |

---

## Backend Audit (`backend-audit.md`) vs Architecture Audit

| Topic | `backend-audit.md` Says | `backend-architecture-audit.md` Says | Reality |
|-------|------------------------|-------------------------------------|---------|
| Recommendation algorithm | Broken (weights never populated) | Working but slow | **Working** (`tasks.py:629`) |
| CORS | Hardcoded to allow all | Not mentioned | **Hardcoded False** (fixed) |
| Secret management | Hardcoded everywhere | "key rotation missing" only | **Mostly env-driven** |
| Rate limiting | "No rate limiting" | Not mentioned | **DRF throttling exists** |
| Celery workers | 4 workers | 5 services (web, celery, celery_feed, celery_media, celery_beat) | **5 services** |

---

## Frontend Documentation vs Implementation

| # | Frontend Claim | Actual Implementation | Status |
|---|----------------|----------------------|--------|
| 1 | "Uses HLS.js for playback" (README:269) | `stores/player.tsx:58-63`: **Confirmed** — HLS.js with native Safari fallback | ✅ Accurate |
| 2 | "Vite/React client" (README:233) | `package.json`: React 18, Vite 7, TypeScript | ✅ Accurate |
| 3 | "Sample frontend only" (README:233) | Directory: `frontend/sample_frontend/` | ✅ Accurate |
| 4 | "API client handles token refresh" | `api/client.ts:50-78`: **Confirmed** — auto-refresh on 401 | ✅ Accurate |
| 5 | "MiniPlayer for persistent playback" | `components/feed/MiniPlayer.tsx`, `AppShell.tsx:46`: **Confirmed** | ✅ Accurate |

---

## Docker Documentation vs Implementation

| # | Docker Claim | Actual Implementation | Status |
|---|--------------|----------------------|--------|
| 1 | "7 services in docker-compose" (README:153) | `docker-compose.yml`: **8 services** (db, redis, minio, minio-init, web, celery, celery_feed, celery_media, celery_beat) | ❌ Undercount |
| 2 | "HF_TOKEN as build secret" (AGENTS.md) | `Dockerfile:116-123`, `docker-compose.yml:397-402`: **Confirmed** — BuildKit secret mount | ✅ Accurate |
| 3 | "Wheelhouse regeneration script" (AGENTS.md) | Provided in AGENTS.md, uses `python:3.11-slim-bookworm` | ✅ Accurate |
| 4 | "Pop!_OS note: use `docker compose` not `docker-compose`" | AGENTS.md: **Accurate** — Compose V2 plugin | ✅ Accurate |

---

## AI/ML Documentation vs Implementation

| # | AI/ML Doc Claim | Actual Implementation | Status |
|---|-----------------|----------------------|--------|
| 1 | "Models in ai_ml/models/" (README:234) | `ai_ml/models/`: **Stubs only** — `NotImplementedError` | ⚠️ Stubs only |
| 2 | "Pipelines in ai_ml/pipelines/" (README:234) | `ai_ml/pipelines/`: **Stubs only** | ⚠️ Stubs only |
| 3 | "ML logic in backend/app/tasks.py" (ai_ml/README:26) | **Confirmed** — `tasks.py` has all ML logic | ✅ Accurate |
| 4 | "Future migration planned" (ai_ml/README:26-31) | **Stubs exist** but no active migration | ⚠️ Planned only |

---

## Summary: Most Critical Discrepancies

### High Priority (Misleading for Operations)
1. **README says local media storage** → Actually S3/MinIO
2. **README says DEBUG hardcoded True** → Actually env-driven, default False
3. **README says CORS allow all** → Actually explicitly denied
4. **README says 4 Celery workers** → Actually 5 services
5. **README says media not S3-backed** → Actually fully S3-backed

### Medium Priority (Misleading for Development)
6. **AGENTS.md says librosa duplicated in requirements.txt** → Still duplicated
7. **AGENTS.md says .env committed** → Still committed
8. **Backend audit claims algorithm broken** → Actually works
9. **Backend audit claims no rate limiting** → Actually has DRF throttling

### Resolved by Phase 1.0 (2026-09-04)
- Batch telemetry via Redis queue + flush task
- Cursor-batched `update_global_metrics` with `SKIP LOCKED`
- Trending-feed fallback when Redis is unavailable
- Split Redis into `redis_broker` (noeviction) + `redis_cache` (LRU)
- Per-endpoint throttle scopes including the tighter `telemetry` scope
- Per-request correlation_id via middleware + JSON log filter

### Resolved 2026-09-28 — native media auth + CGNAT throttling

Documents that asserted the *superseded* behaviour, now corrected at source.

| # | Doc claimed | Actual | Status |
|---|-------------|--------|--------|
| 10 | `AGENTS.md`: "HLS token endpoint returns Set-Cookie, not JSON body — the frontend must NOT read the token from the response body" | The body token is **opt-in** for `X-EchoFlow-Client: native`; the web default is unchanged and must still ignore the body | ✅ Corrected |
| 11 | `AGENTS.md`: "**Signed cookies are the only viable token mechanism for HLS**" | Too strong. A per-*prefix* credential is the requirement; the cookie is one carrier of it. Native players use the `X-EchoFlow-Media-Token` header | ✅ Corrected |
| 12 | `FRONTEND-REQUIREMENTS.md` §1.1: `/auth/token/refresh/` = bare `TokenRefreshView`, default `user` throttle | `ThrottledTokenRefreshView`, `token_refresh` 120/hour keyed on the **verified** token subject | ✅ Corrected |
| 13 | `FRONTEND-REQUIREMENTS.md` §1.1 + §4.8: `register` = 5/hour/IP | 200/hour per IP **plus** `register_username` 3/hour | ✅ Corrected |
| 14 | `auth/04-rate-limiting.md`: only `anon` + `user` scopes; refresh/login/register all 100/hr per IP | 17 scopes, and the audit's "Critical Gaps" / "Recommended Improvements" are historical | ✅ Rewritten; audit sections labelled |
| 15 | `storage/03-bucket-policies.md`: `mc anonymous set download .../hls` as an init step | Removed. `hls/` is private, token-gated at the edge | ✅ Corrected (file contradicted itself — see #19) |
| 16 | `storage/01-s3-architecture.md`: "current implementation uses public-read for `hls/`" | Private + token-gated | ✅ Corrected |
| 17 | `storage/02-hls-playback.md`: public-read design + `mc anonymous set download` | Historical; §2 (why query signing fails) still holds | ✅ Labelled historical |
| 18 | `DEPLOYMENT/04-cloudflare-config.md`: prescribes a `PublicReadHLS` bucket policy | Contradicts `02-vps-setup.md` step 4. Bucket is fully private behind the Worker | ✅ Corrected (see #19) |
| 19 | — | `03-bucket-policies.md` told you to make `hls/` public while its own ACL Summary said token-gated; `04-cloudflare-config.md` contradicted `02-vps-setup.md`. **The failure mode: following either doc makes every transcript readable without a token, while the Worker still 403s — so it presents as a broken edge, not a security hole** | ✅ Both corrected |
| 20 | `DEPLOYMENT/05-data-flow.md`: `hls/` "served by R2 custom domain, public-read" | Served by the Worker, which reads R2 through a binding | ✅ Corrected |
| 21 | `decisions/01-key-decisions.md`: DECISION "Split ACL (hls/ public)" with a SECURITY comment claiming it "is not a data leak" | Superseded. The reasoning was wrong — segments are verbatim transcripts | ✅ Marked superseded |

### Low Priority (Minor)
- Service count mismatch (7 vs 8 in docker-compose) — was 8; Phase 1.0 brings it to 11 (db, redis_broker, redis_cache, pgbouncer, minio, minio-init, web, celery, celery_feed, celery_media, celery_beat)
- AI/ML directory has stubs not implementations
- Celery beat healthcheck disabled (documented in compose)

---

## Recommendation

**Update priority:**
1. **README.md** — Fix storage, DEBUG, CORS, worker count claims
2. **AGENTS.md** — Note librosa duplication, .env commit as known issues; update service count and add PgBouncer/Redis-split notes from Phase 1.0
3. **backend-audit.md** — Mark false positives as resolved
4. **phase-1-scaling-plan.md** — Add a verification footer (2026-09-04) listing which items were already implemented vs. which were delivered by Phase 1.0

> Phase 1.0 verification footer added; see [phase-1-scaling-plan.md § Verification Note](../../phase-1-scaling-plan.md).

---

*Source: Cross-reference of README.md, AGENTS.md, backend-architecture-audit.md, backend-audit.md, and actual source code*