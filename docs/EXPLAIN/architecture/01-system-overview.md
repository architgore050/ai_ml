# EchoFlow System Overview

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL CLIENTS                                   │
│                    (React/Vite Frontend, Mobile Apps)                       │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTPS / WebSocket
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          API GATEWAY (gunicorn)                              │
│                    Django 5.2 + Django REST Framework 3.18                  │
│                  JWT Auth (SimpleJWT) · CORS · Throttling                   │
└──────────────┬───────────────────────────┬────────────────────┬────────────┘
               │                           │                    │
               ▼                           ▼                    ▼
┌──────────────────────┐    ┌──────────────────────┐  ┌──────────────────────┐
│   PostgreSQL 16      │    │      Redis 7         │  │  Celery Workers      │
│   + pgvector (HNSW)  │    │  • Cache (django-    │  │  ┌────────────────┐  │
│  • Clips, Users      │    │    redis)            │  │  │ default        │  │
│  • Vectors (384/128) │    │  • Feed queues       │  │  │ (scraping,     │  │
│  • HNSW indexes      │    │  • Celery broker     │  │  │  general)      │  │
│  • Constraints       │    │  • Sessions          │  │  └────────────────┘  │
└──────────────────────┘    └──────────────────────┘  │  ┌────────────────┐  │
                                                      │  │ fast_feed      │  │
┌──────────────────────────────────────────────────┐  │  │ (feed refill)  │  │
│              Object Storage (S3/MinIO)            │  │  └────────────────┘  │
│  ┌─────────────────┐  ┌─────────────────────────┐ │  │  ┌────────────────┐  │
│  │ uploads/        │  │ hls/ (PRIVATE,          │ │  │  │ heavy_media    │  │
│  │ (private,       │  │  token-gated at edge)   │ │  │  │ (HLS + AI/ML)  │  │
│  │  signed URLs)   │  │ • master.m3u8 / .ts     │ │  │  │ --pool=solo    │  │
│  └─────────────────┘  │ • .ts segments (MPEG-TS)│ │  │  └────────────────┘  │
│                       └─────────────────────────┘ │  └──────────────────────┘
└──────────────────────────────────────────────────┘
               │                           │
               ▼                           ▼
        ┌─────────────┐             ┌─────────────┐
        │  Celery     │             │   FFmpeg    │
        │  Beat       │             │  (HLS       │
        │  (scheduler)│             │  transcoder)│
        └─────────────┘             └─────────────┘
```

## End-to-End Data Flows

### 1. Audio Upload & Processing Pipeline

```
POST /clips/ (multipart/form-data)
    │
    ▼
AudioUploadViewSet.create()
    │
    ├── Validates file (type, size ≤100MB)
    ├── Creates AudioClip(status='processing')
    ├── Saves original_file to S3 (uploads/ prefix, private)
    │
    └── transaction.on_commit → process_audio_to_hls.delay(clip_id)
                                          │
                                          ▼
                         ┌────────────────────────────────────┐
                         │ Celery heavy_media queue (solo)      │
                         │ process_audio_to_hls(clip_id)        │
                         ├────────────────────────────────────┤
                         │ 1. Download original from S3 to      │
                         │    local temp file (scratch space)   │
                         │ 2. FFmpeg normalize → mono 22050Hz   │
                         │    WAV (authoritative decode)        │
                         │ 3. librosa: extract 128-dim acoustic │
                         │    vector (MFCC+chroma+mel)          │
                         │ 4. faster-whisper: transcribe audio  │
                         │ 5. sentence-transformers: 384-dim    │
                         │    semantic vector from transcript   │
                         │ 6. KeyBERT: extract 3 genre tags     │
                         │ 7. FFmpeg HLS transcode (mpegts,     │
                         │    128kbps AAC, 4s segments)         │
                         │ 8. Upload all HLS files to S3        │
                         │    (hls/{clip_id}/ prefix, public)   │
                         │ 9. Save hls_playlist_url (object key)│
                         │ 10. clip.status = 'ready'            │
                         │ 11. Cleanup local scratch files      │
                         └────────────────────────────────────┘
```

### 2. Feed Retrieval (Fast Path)

```
GET /feed/
    │
    ▼
FastFeedViewSet.list()
    │
    ├── Redis LPOP user_feed:{user_id} (10 clips)
    │
    ├── If queue empty OR < 15 items:
    │   └── refill_user_feed.delay(user_id, count=40)
    │       (fast_feed queue, SETNX lock prevents concurrent refills)
    │
    ├── Fetch AudioClip objects preserving Redis order
    │   (Case/When ordering by position)
    │
    └── FeedClipSerializer → signed HLS URLs + is_liked annotation
```

### 3. Feed Refill (Background)

```
refill_user_feed(user_id, count=50)  [Celery fast_feed queue]
    │
    ├── SETNX feed_refill_lock:{user_id} (30s TTL)
    │
    ├── calculate_time_decayed_vectors(user)
    │   ├── Recent interactions (7 days) with time decay
    │   ├── Completion rate weighting
    │   ├── Intent weighting (like/share=1.5x, skip<20%=-0.5x)
    │   ├── Blend 70% context + 30% long-term baseline
    │   └── Return (sem_query, ac_query) normalized vectors
    │
    ├── Base queryset: AudioClip(status='ready') EXCEPT seen_ids
    │   (seen = last 30 days interactions + already queued)
    │
    ├── Composite scoring (PostgreSQL native):
    │   vector_similarity = 1 - (cosine_dist_sem + cosine_dist_ac) / 4
    │   composite_score = 0.45*vector_sim + 0.30*avg_completion + 0.25*engagement_vel
    │
    ├── 80% EXPLOIT: Top composite_score clips
    ├── Follow wedge: 5 recent clips from followed creators
    ├── 20% EXPLORE: High engagement_velocity outside vector neighborhood
    │
    ├── Shuffle, RPUSH to Redis user_feed:{user_id}
    ├── EXPIRE 24h (prevent orphaned lists)
    │
    └── Release lock
```

### 4. Interaction & Telemetry

```
POST /interactions/{clip_id}/log-telemetry/
    { action_type: "view", watch_time_ms: 45000 }
    │
    ▼
ClipInteractionViewSet.log_telemetry()
    │
    ├── completion_rate = min(watch_time_ms / clip.duration_ms, 1.0)
    │
    ▼
backend.app.services.interactions.record_telemetry()      ← service layer
    │
    ├── Primary: XADD stream:interaction.events MAXLEN ~ 50000
    │             * event_id <uuid> schema_version "1.0.0" payload <json>
    │
    ├── Fallback: RPUSH telemetry:queue <json>      (legacy list, drained by
    │                                                 flush_telemetry_legacy)
    │
    └── Last-resort: synchronous UserInteraction.update_or_create
                     (only on full Redis failure)
    │
    ▼
flush_telemetry_stream (Celery Beat, every 10s)
    │
    ├── XREADGROUP cg:telemetry-flush COUNT 500 BLOCK 5000
    ├── SET processed_event:{event_id} 1 NX EX 86400   (idempotency)
    ├── UserInteraction.bulk_create(ignore_conflicts=True)
    ├── XACK
    └── Poison messages → stream:interaction.events:dlq
```

### 5. Periodic Metrics & Vector Evolution

```
Celery Beat (every 5 min) → update_global_metrics()
    │
    ├── Raw SQL UPDATE on ALL ready clips:
    │   engagement_velocity = LEAST((likes + shares*2) / (hours_since_created+2)^1.5 / 100, 1.0)
    │   avg_completion_rate = AVG(completion_rate) FROM UserInteraction WHERE type='view'
    │
    ⚠ ISSUE: Full table scan + lock on large tables (see failure/04-telemetry-contention.md)

Celery Beat (every hour) → evolve_long_term_user_baselines()
    │
    ├── For each active user (iterator chunk_size=100):
    │   ├── calculate_time_decayed_vectors(user, limit=500)
    │   ├── Update user.long_term_semantic, long_term_acoustic
    │   └── bulk_update(batch_size=100)
```

## Component Responsibilities

| Component | Responsibility | Key Files |
|-----------|---------------|-----------|
| **Django API** | Auth, REST endpoints, serialization, request validation | `backend/EchoFlow/`, `backend/app/views.py`, `serializers.py` |
| **PostgreSQL + pgvector** | Persistent storage, vector similarity (HNSW), constraints | `models.py`, migrations |
| **Redis** | Feed queues, Celery broker, cache, rate limiting | `settings.py` CACHES, `views.py` FastFeedViewSet |
| **Celery default** | Scraping, general async tasks | `celery.py`, `tasks.py` |
| **Celery fast_feed** | Feed refill (composite scoring, vector queries) | `tasks.py:refill_user_feed` |
| **Celery heavy_media** | HLS transcoding, ML inference (Whisper, embeddings) | `tasks.py:process_audio_to_hls` |
| **Celery Beat** | Periodic: global metrics, vector evolution | `settings.py:CELERY_BEAT_SCHEDULE` |
| **S3/MinIO** | Object storage: uploads (private) + HLS (public) | `settings.py:STORAGES`, `media_urls.py` |
| **FFmpeg** | Audio normalize, HLS transcode (mpegts) | `tasks.py:normalize_to_wav`, HLS command |
| **ML Models** | Whisper (transcribe), sentence-transformers (embed), KeyBERT (tags) | `tasks.py:get_*_model()`, `extract_acoustic_vector` |

## Current vs Intended Design

| Aspect | Current Implementation | Intended/Future Design |
|--------|----------------------|------------------------|
| Media storage | S3-compatible (MinIO local, S3 prod) ✓ | CDN in front (CloudFront/Cloudflare) |
| Feed computation | Redis pre-computed queues | Multi-tier: candidate gen → scoring → ranking |
| Telemetry | Redis Stream + consumer group (2026-09); legacy list fallback | Schema-versioned fat events + ClickHouse analytical sink |
| Counter side-effects | Synchronous F() in `UserInteraction.save()` | Redis INCRBY + counter batcher (P1.1 in event-driven plan) |
| Vector search | pgvector HNSW in PostgreSQL | Dedicated vector DB (Qdrant/Milvus) at >10M clips |
| ML inference | In Celery worker (CPU, baked models) | GPU inference service (Triton/vLLM) |
| Message queue | Redis broker | RabbitMQ → Kafka |
| Connection pooling | `conn_max_age=600` (Django) | PgBouncer transaction pooling |
| Rate limiting | DRF global (1000/hr user) + scoped (telemetry 60/min, upload 20/hr, etc.) | Per-endpoint, Redis token bucket |
| Observability | JSON logs, /health, /ready, /metrics | OpenTelemetry + Prometheus + Grafana + Loki |
| Service layer | Stage 2 boundary in `backend/app/services/` ✓ (2026-09) | Service layer as the home for all business logic |

## Known Limitations (Current Implementation)

1. **Counter side-effect on `UserInteraction.save()` still F() into `AudioClip`** (services/interactions.py:record_like_toggle still triggers `UserInteraction.save()` → `AudioClip.objects.filter(pk=...).update(likes=F('likes')+1)`). The Stage 2 service layer is now the boundary; P1.1 of the event-driven plan replaces this with a Redis INCRBY + counter batcher.
2. **Telemetry stream consumer:** `flush_telemetry_stream` is the primary path; `flush_telemetry_legacy` (LIST) is kept as a safety net for one cycle and slated for removal. The DLQ (`stream:interaction.events:dlq`) grows unbounded; alert on depth > 0.
3. **Global metrics**: Raw SQL `UPDATE` on entire `AudioClip` table is now batched by id cursor (`update_global_metrics`); the correlated subquery for `avg_completion_rate` is still O(N) per batch.
4. **No fallback feed**: Redis outage → the `FastFeedViewSet` try/except serves a trending fallback (top clips by `engagement_velocity`). Not a 500.
5. **Single Redis**: Broker + cache share instance; feed spike evicts broker queues (mitigated by `volatile-lru`; see P0.4 in the event-driven plan).
6. **No PgBouncer**: Direct Django connections exhaust PostgreSQL at moderate load.
7. **No CDN**: HLS served directly from MinIO/S3; no edge caching.
8. **Magic byte validation missing on legacy paths**: covered by `python-magic` at upload time but not on every read.
9. **No automated DLQ triage**: failed stream events land in `stream:interaction.events:dlq` but no consumer auto-pages.
10. **CORS hardcoded**: `CORS_ALLOW_ALL_ORIGINS = False`; env-driven allowlist is the single source of truth.

## Discrepancies with Documentation

| Document | Claim | Actual Code |
|----------|-------|-------------|
| `README.md:24` | `DEBUG = True` hardcoded | `settings.py:24` uses `DJANGO_DEBUG` env (default False) |
| `README.md:25` | `CORS_ALLOW_ALL_ORIGINS = True` hardcoded | `settings.py:63` explicitly sets `False` |
| `AGENTS.md` | 4 Celery workers | docker-compose has 4: web, celery, celery_feed, celery_media, celery_beat |
| `README.md:139` | Celery beat uses `django_celery_beat` | `settings.py:239` confirms, but `celery_beat` service disables healthcheck |
| `backend-architecture-audit.md:215` | Media to S3 done | Done for storage, but CDN not configured |

---

*Source: `backend/EchoFlow/settings.py`, `backend/app/views.py`, `backend/app/tasks.py`, `backend/app/models.py`, `docker-compose.yml`, `Dockerfile`*