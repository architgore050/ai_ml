# EchoFlow Technical Documentation

This directory contains comprehensive, code-grounded technical documentation for the EchoFlow audio-first short-form content platform.

**Source of Truth:** All documentation is derived from the actual implementation in the repository. Where existing documentation conflicts with code, the actual behavior is documented and discrepancies are explicitly noted.

## Documentation Structure

### System-Level Architecture
- [01-system-overview.md](architecture/01-system-overview.md) — Overall architecture, data flows, and component relationships
- [02-deployment-topology.md](architecture/02-deployment-topology.md) — Docker Compose services, networking, and runtime behavior
- [03-design-decisions.md](architecture/03-design-decisions.md) — Key architectural decisions, trade-offs, and rationale

### Backend (Django/DRF)
- [01-project-structure.md](backend/01-project-structure.md) — Dual `EchoFlow/` package layout, settings, and entry points
- [02-models.md](backend/02-models.md) — Custom User, AudioClip, Comment, ShareEvent, UserInteraction schemas
- [03-serializers.md](backend/03-serializers.md) — DRF serializers, validation, and HLS URL generation
- [04-views-api.md](backend/04-views-api.md) — ViewSets, endpoints, permissions, and pagination
- [05-urls-routing.md](backend/05-urls-routing.md) — URL configuration and API endpoint map
- [06-auth-permissions.md](backend/06-auth-permissions.md) — JWT authentication, SimpleJWT, and permission classes
- [07-media-urls.md](backend/07-media-urls.md) — S3/MinIO playback URL generation for HLS vs uploads

### Frontend (React/Vite)
- [01-architecture.md](frontend/01-architecture.md) — Component hierarchy, state management, and data flow
- [02-api-layer.md](frontend/02-api-layer.md) — API client, token management, and error handling
- [03-stores.md](frontend/03-stores.md) — Context providers (Auth, Player, Toast, Theme)
- [04-playback-hls.md](frontend/04-playback-hls.md) — HLS.js integration, MiniPlayer, and audio handling
- [05-pages-components.md](frontend/05-pages-components.md) — Page components, ReelCard, ReelList, and UI flows

### AI/ML Pipeline
- [01-overview.md](ai_ml/01-overview.md) — Pipeline stages, models, and integration points
- [02-feature-extraction.md](ai_ml/02-feature-extraction.md) — Acoustic (librosa) and semantic (sentence-transformers) vectors
- [03-transcription-tagging.md](ai_ml/03-transcription-tagging.md) — Whisper transcription and KeyBERT tag extraction
- [04-recommendation-engine.md](ai_ml/04-recommendation-engine.md) — Composite scoring, vector blending, feed mixing
- [05-cold-start.md](ai_ml/05-cold-start.md) — Tag-based vector bootstrapping for new users
- [06-ml-models-lazy-loading.md](ai_ml/06-ml-models-lazy-loading.md) — Thread-safe model initialization in Celery workers

### Redis & Celery
- [01-redis-usage.md](redis-celery/01-redis-usage.md) — Cache, feed queues, broker, and session storage
- [02-celery-workers.md](redis-celery/02-celery-workers.md) — Queue routing, concurrency, and worker types
- [03-periodic-tasks.md](redis-celery/03-periodic-tasks.md) — Celery Beat schedule, metrics, vector evolution
- [04-task-reliability.md](redis-celery/04-task-reliability.md) — Retries, idempotency, locking, and failure handling

### PostgreSQL & pgvector
- [01-schema.md](postgresql/01-schema.md) — Table definitions, constraints, and indexes
- [02-vector-indexes.md](postgresql/02-vector-indexes.md) — HNSW configuration, cosine similarity, ANN queries
- [03-migrations.md](postgresql/03-migrations.md) — Migration history and schema evolution
- [04-raw-sql-operations.md](postgresql/04-raw-sql-operations.md) — `update_global_metrics` and performance implications

### Audio Processing & HLS
- [01-pipeline-overview.md](media/01-pipeline-overview.md) — End-to-end media processing flow
- [02-ffmpeg-hls.md](media/02-ffmpeg-hls.md) — HLS transcoding, MPEG-TS segments, ABR variants
- [03-audio-normalization.md](media/03-audio-normalization.md) — FFmpeg decode, librosa processing, scratch space
- [04-media-lifecycle.md](media/04-media-lifecycle.md) — Upload → processing → HLS → object storage → cleanup

### Storage (MinIO/S3-Compatible)
- [01-s3-architecture.md](storage/01-s3-architecture.md) — Split ACL design, endpoint separation, path-style addressing
- [02-hls-playback.md](storage/02-hls-playback.md) — Why HLS cannot use signed URLs, public `hls/` prefix
- [03-bucket-policies.md](storage/03-bucket-policies.md) — MinIO init, CORS, anonymous download policy

### Scraping & Ingestion
- [01-sources.md](scraping/01-sources.md) — Wikimedia, Internet Archive, Freesound, Kaggle connectors
- [02-pipeline.md](scraping/02-pipeline.md) — Download → normalize → upload → AI processing
- [03-licensing-safety.md](scraping/03-licensing-safety.md) — License filtering, robots.txt, rate limiting, provenance

### Authentication & Security
- [01-jwt-auth.md](auth/01-jwt-auth.md) — SimpleJWT configuration, token lifetimes, refresh flow
- [02-pii-encryption.md](auth/02-pii-encryption.md) — Fernet email encryption, key management
- [03-cors-csrf.md](auth/03-cors-csrf.md) — CORS configuration, Range headers for HLS
- [04-rate-limiting.md](auth/04-rate-limiting.md) — DRF throttling, current limits, gaps

### Docker & Deployment
- [01-multi-stage-dockerfile.md](docker/01-multi-stage-dockerfile.md) — Build stages, `wheelhouse-base` layer-graph dedup, offline wheelhouse, secret handling, **named BuildKit caches** (`echoflow-apt` / `echoflow-pip` / `echoflow-hf`) — BuildKit caches section added 2026-09-06
- [02-docker-compose.md](docker/02-docker-compose.md) — 14 services, health checks, resource limits
- [03-environment-variables.md](docker/03-environment-variables.md) — Required vars, dev vs prod differences
- [04-gunicorn-wait-for-db.md](docker/04-gunicorn-wait-for-db.md) — Preload app, post_fork connection reset, DB polling
- [05-https-tls-termination.md](docker/05-https-tls-termination.md) — nginx TLS terminator (added 2026-09-04)
- [06-https-production-readiness.md](docker/06-https-production-readiness.md) — 12-section HTTPS release checklist (added 2026-09-04)

### Deployment (Hybrid VPS + Laptop)
- [DEPLOYMENT/README.md](DEPLOYMENT/README.md) — Hybrid deployment overview and quick start
- [DEPLOYMENT/01-hybrid-deployment-overview.md](DEPLOYMENT/01-hybrid-deployment-overview.md) — Architecture, service inventory, resource usage
- [DEPLOYMENT/02-vps-setup.md](DEPLOYMENT/02-vps-setup.md) — VPS deploy guide (Hetzner/Oracle + Cloudflare Tunnel + Tailscale)
- [DEPLOYMENT/03-laptop-media-worker.md](DEPLOYMENT/03-laptop-media-worker.md) — Laptop media worker deploy guide
- [DEPLOYMENT/04-cloudflare-config.md](DEPLOYMENT/04-cloudflare-config.md) — R2 bucket policy, Tunnel, Pages, DNS
- [DEPLOYMENT/05-data-flow.md](DEPLOYMENT/05-data-flow.md) — End-to-end data flow across all components

### Observability
- [01-current-state.md](observability/01-current-state.md) — What we measure today, where the gaps are
- [02-counter-store.md](observability/02-counter-store.md) — Dual-write RedisCounterStore + flush_counters_to_pg (Group B item 9)
- [03-prometheus-grafana-design.md](observability/03-prometheus-grafana-design.md) — Full Prometheus + Grafana + Alertmanager design (765 lines)
- [04-prometheus-grafana-setup.md](observability/04-prometheus-grafana-setup.md) — Activation runbook: `docker compose up prometheus grafana`, verify target is UP, dashboard URLs (added 2026-09-04)

### Operations
- [hf-token-rotation.md](operations/hf-token-rotation.md) — HF_TOKEN rotation procedure, failure modes, audit log (added 2026-09-04, Group B item 17 / A5 partial-issues)

### Testing
- [01-current-state.md](testing/01-current-state.md) — Existing tests, pytest framework, CI
- [02-metrics-health.md](testing/02-metrics-health.md) — Prometheus metrics, health/readiness endpoints
- [03-logging.md](testing/03-logging.md) — JSON structured logging configuration
- [04-integration-test-suite.md](testing/04-integration-test-suite.md) — `@pytest.mark.integration` marker, autouse skip fixture, pgvector + concurrency tests, CI step (added 2026-09-04, Group D item 25)

### Failure Handling & Recovery
- [01-distributed-systems.md](failure/01-distributed-systems.md) — Duplicate execution, retries, idempotency, race conditions
- [02-media-processing.md](failure/02-media-processing.md) — FFmpeg failures, model loading, scratch cleanup
- [03-feed-resilience.md](failure/03-feed-resilience.md) — Redis outage fallback, circuit breakers
- [04-telemetry-contention.md](failure/04-telemetry-contention.md) — PostgreSQL lock contention, batching needs

### Decision Logs
- [01-key-decisions.md](decisions/01-key-decisions.md) — Centralized DECISION/SECURITY/HACK/TODO log from code
- [02-discrepancies.md](decisions/02-discrepancies.md) — Where documentation conflicts with implementation
- [comprehensive-bug-sweep.md](decisions/comprehensive-bug-sweep.md) — Original Group A/B/C/D audit findings (4 groups, 31 items, 3 false positives, 1 not-shipped)
- [group-b-architectural-plan.md](decisions/group-b-architectural-plan.md) — Plan for Group B items 9-12 (counter store, cache invalidation, correlation_id, orphan cleanup)
- [partial-issues-completion-plan.md](decisions/partial-issues-completion-plan.md) — Plan + completion record for the 7 partially-addressed items (A1, A3, A5, A8, B13, B14, B17) + B19 docstring (added 2026-09-04)
- [2026-09-28-local-hls-worker.md](decisions/2026-09-28-local-hls-worker.md) — Local HLS token Worker (S3/MinIO storage backend, `/healthz`, nginx `:9443` routing) (added 2026-09-28)
- [2026-09-28-native-media-auth-and-cgnat-throttling.md](decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md) — Native media auth transport (body token + Worker header) and CGNAT-safe throttle keying (added 2026-09-28)
- [Mobile rebuild plan](../../mobile-rebuild-plan.md) — Approved plan for rewriting `mobile/` from scratch: architecture decisions, playback sequence, feature scope, UI/UX port, build phases (added 2026-09-28)

---

## Quick Reference: API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register/` | Public | User registration |
| POST | `/auth/login/` | Public | JWT obtain pair |
| POST | `/auth/token/refresh/` | Public | JWT refresh |
| POST | `/clips/` | ✓ | Upload audio → triggers `process_audio_to_hls` |
| GET | `/feed/` | ✓ | Redis-backed personalized feed |
| POST | `/interactions/{id}/toggle-like/` | ✓ | Toggle like/unlike |
| POST | `/interactions/{id}/register-skip/` | ✓ | Register skip/view telemetry |
| POST | `/interactions/{id}/log-telemetry/` | ✓ | Log detailed watch-time telemetry |
| GET | `/comments/?clip={id}` | ✓ | Filter comments by clip |
| POST | `/comments/` | ✓ | Create comment |
| POST | `/share/{id}/send-share/` | ✓ | Send clip to another user |
| GET | `/share/inbox/` | ✓ | Get user's share inbox |
| POST | `/follow/{id}/toggle-follow/` | ✓ | Follow/unfollow user |
| GET | `/media/playback-token/{clip_id}/` | ✓ | HLS play token — cookie, or body token for native (`X-EchoFlow-Client: native`) |
| POST | `/tags/initialize/` | ✓ | Cold-start tag-based vector bootstrapping |
| GET | `/suggestions/?category=X` | ✓ | Category-scoped vector ranking |
| GET | `/profile/me/` | ✓ | Own profile |
| GET | `/profile/{id}/` | ✓ | Public profile |

---

## Key Files to Understand First

1. **`backend/EchoFlow/settings.py`** — All configuration: DB, Redis, Celery, JWT, S3, scraper, CORS. Per-session DB timeouts (statement/lock/connect) on the default connection.
2. **`backend/app/models.py`** — Core data models with pgvector fields and constraints
3. **`backend/app/tasks.py`** — Celery tasks: HLS/AI pipeline, feed refill, metrics, vector evolution, counter flush, orphan HLS cleanup
4. **`backend/app/views.py`** — API ViewSets: feed, uploads, interactions, comments, share, follow, tags
5. **`backend/app/serializers.py`** — DRF serializers with HLS URL signing logic
6. **`backend/app/services/`** — Service layer: `interactions.py` (cache invalidation), `counter_store.py` (Redis INCR + dual-write), `task_publisher.py` (correlation_id propagation), `sentry.py` (error capture)
7. **`backend/app/throttling.py`** — `RefreshTokenRateThrottle` (keyed on the **verified** token subject, not the client IP — a carrier NAT is thousands of callers) and `RegisterUsernameRateThrottle`
8. **`backend/app/db_routers.py`** — Read-replica routing; auto-activates when `READ_DATABASE_URL` is set
9. **`docker-compose.yml`** — 14-service deployment topology
10. **`docker/nginx.conf`** — TLS terminator with 3 listeners (`:80`/`:443`/`:9443`)
11. **`Dockerfile`** — Multi-stage build with offline wheelhouse and HF model baking

---

## Discrepancy Tracking

This documentation explicitly notes where:
- **README/AGENTS.md claims** differ from **actual code behavior**
- **Architecture audit docs** describe intended/future state vs **current implementation**
- **Comments in code** are outdated or inaccurate

Search for `DISCREPANCY:` markers throughout the docs.

---

*Generated from source code analysis. Last updated: 2026-09-04 (partial-issues completion: PR 1/2/3 shipped A1, A3, A5, A8, B13, B17, D25, B19).*