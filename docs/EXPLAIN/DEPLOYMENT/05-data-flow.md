# Hybrid Deployment Data Flow

This document traces the end-to-end data flow in the hybrid deployment,
showing how requests and tasks travel between the browser, VPS, laptop,
and Cloudflare R2.

## 1. User Registration & Authentication

```
Browser (app.echoflow.in)
  │ POST https://api.echoflow.in/auth/register/
  │   {email, username, password, dob, terms_version_id}
  ▼
Cloudflare Tunnel → VPS: nginx → gunicorn → Django
  │ RegisterSerializer
  │   - Validates dob (must be 8+ years old, CAP Act)
  │   - Checks terms_version_id against TERMS_VERSIONS env var
  │   - Encrypts email: Fernet with FIELD_ENCRYPTION_KEY
  │   - Creates UserInteraction row (initial counters at 0)
  │ POSTGIS: INSERT INTO app_user (...)
  ▼
201 Created {access, refresh, user: {...}}
```

**Components involved:** Frontend (Pages) → Cloudflare Tunnel → nginx → gunicorn → Django → PostgreSQL

## 2. User Uploads an Audio Clip

```
Browser (app.echoflow.in)
  │ POST https://api.echoflow.in/clips/
  │   multipart/form-data: original_file=<audio>
  ▼
Cloudflare Tunnel → VPS: nginx → gunicorn → Django
  │ AudioUploadViewSet.create() [content.py:34-50]
  │   1. Throttle: 20 uploads/hr/user
  │   2. Validate file: magic bytes, duration (<5min), format
  │   3. Django ORM: INSERT INTO app_audiocip (...)
  │      status='processing', moderation_approved=False
  │   4. django-storages: PUT uploads/{uuid}.mp3 → R2
  │   5. uploads_svc.finalize_upload(clip)
  │      - Sets moderation_approved=False
  │      - Does NOT enqueue process_audio_to_hls (not approved yet)
  ▼
202 Accepted {clip_id, status: "processing"}
```

**Components involved:** Frontend → Cloudflare Tunnel → nginx → gunicorn → Django → R2 → PostgreSQL

No code changes here — the upload flow is identical to the original single-host deployment. The only difference is R2 replaces MinIO (env-driven via `AWS_S3_ENDPOINT_URL`).

## 3. Moderator Approves the Clip

```
Browser → POST https://api.echoflow.in/clips/{id}/approve-moderation/
  │
  ▼
VPS: nginx → gunicorn → Django
  │ AudioUploadViewSet.approve_moderation() [content.py:69-100]
  │   1. Runs content_moderation.check_content()
  │      - sha256 fingerprint match against blocklist
  │      - Blocked phrase check on AI-generated tags
  │   2. Sets moderation_approved=True
  │   3. calls trigger_hls_processing(clip) [uploads.py:42-50]
  │      - transaction.on_commit(lambda: publish(process_audio_to_hls, clip_id))
  │      - publish() → task.apply_async() → 'heavy_media' queue
  │
  ▼
Postgres (172.28.0.4): UPDATE app_audiocip SET moderation_approved=True

VPS Redis broker (172.28.0.2):
  LPUSH celery:celery:heavy_media {task: process_audio_to_hls, args: [clip_id]}
  (task is queued, waiting for a worker to pick it up)

200 OK {status: "approved"}
```

**Components involved:** Browser → Cloudflare Tunnel → nginx → gunicorn → Django → PostgreSQL → Redis broker

The task is now waiting in the `heavy_media` queue on the VPS Redis broker. Since no worker is running on the VPS that listens to `heavy_media`, the task waits for the laptop worker to connect.

## 4. Laptop Media Worker Processes the Clip

```
Laptop: Docker (celery_media worker, 172.28.0.0/16 via Tailscale)
  │
  │ Celery worker polls Redis broker (172.28.0.2:6379/0) via Tailscale
  │ ← LRANGE celery:celery:heavy_media  (receives task: process_audio_to_hls, [clip_id])
  │
  ▼
process_audio_to_hls(clip_id) [tasks.py:165+]
  │
  │ 1. Get clip from DB
  │    SELECT * FROM app_audiocip WHERE id=clip_id
  │    ← via Tailscale → Postgres (172.28.0.4:5432)
  │
  │ 2. Download original from R2
  │    GET AWS_S3_ENDPOINT_URL/uploads/{uuid}.wav → /tmp/{uuid}.wav
  │
  │ 3. Audio processing
  │    - ffmpeg normalize → /tmp/normalized.wav
  │    - librosa.extract_acoustic_vector(128-d) → acoustic_vector
  │    - pydub duration check
  │
  │ 4. AI processing (models baked into media image)
  │    - faster-whisper → transcript
  │    - sentence-transformers → semantic_vector (384-d)
  │    - KeyBERT → tags
  │
  │ 5. HLS encoding
  │    - ffmpeg → 192/128/64 kbps ABR → /tmp/hls-{uuid}/master.m3u8
  │
  │ 6. Upload HLS to R2
  │    PUT AWS_S3_ENDPOINT_URL/hls/{clip_id}/master.m3u8
  │    PUT AWS_S3_ENDPOINT_URL/hls/{clip_id}/variant_192.m3u8
  │    PUT AWS_S3_ENDPOINT_URL/hls/{clip_id}/segment_001.ts
  │    ...
  │    (all files in hls/{clip_id}/ prefix — public via R2 bucket policy)
  │
  │ 7. Update DB
  │    UPDATE app_audiocip
  │    SET acoustic_vector = ...,
  │        semantic_vector = ...,
  │        tags = [...],
  │        hls_playlist_url = 'hls/{clip_id}/master.m3u8',
  │        status = 'ready'
  │    WHERE id = clip_id
  │    ← via Tailscale → Postgres (172.28.0.4:5432)
  │
  │ 8. Cleanup
  │    rm -rf /tmp/{uuid}.wav /tmp/hls-{uuid}/
```

**Components involved:** Laptop (Tailscale) → VPS Redis broker → VPS Postgres → R2

**Key insight:** The laptop worker talks to the VPS's Redis broker and Postgres over Tailscale's private network (172.28.0.0/16). R2 is reached directly over the public internet with AWS credentials. No public ports are exposed on the VPS.

## 5. Browser Plays the HLS Clip

```
Browser (app.echoflow.in)
  │ GET https://media.echoflow.in/hls/{clip_id}/master.m3u8
  │   (URL was generated by media_urls.py:43-59 using PUBLIC_MEDIA_ENDPOINT_URL)
  ▼
Cloudflare Worker (media.echoflow.in, custom domain → echoflow-hls-worker)
  │ GET /hls/{clip_id}/master.m3u8
  │   with ef_hls_token cookie, or X-EchoFlow-Media-Token header
  ▼
R2 (echoflow-media bucket — hls/ is PRIVATE; the Worker reads it via binding)
  │ Returns master.m3u8
  │   hls.js parses and requests variant playlists
  │   hls.js requests .ts segments
  ▼
All HLS files served directly from R2 via Cloudflare CDN
  (cached at edge, zero VPS bandwidth usage)
```

**Components involved:** Browser → Cloudflare CDN → R2

No VPS hop involved! The `PUBLIC_MEDIA_ENDPOINT_URL=https://media.echoflow.in`
points directly to R2's custom domain. Cloudflare's CDN caches the HLS
segments at the edge, so playback is fast and free (within R2 free tier).

## 6. Feed Generation & Interaction

```
Browser → GET https://api.echoflow.in/feed/ (via Cloudflare Tunnel)
  │
  ▼
VPS: nginx → gunicorn → Django
  │ FastFeedViewSet.list() [feed.py]
  │   - Check Redis feed list: LRUGET user_feed:123
  │   - If < 15 items (low watermark): trigger refill_user_feed task
  │   - Pop 10 items → apply HLS URLs via media_urls.py
  │
  │ refill_user_feed task → 'fast_feed' queue
  │ ← picked up by VPS celery_feed worker (172.28.0.12)
  │   - Vector similarity from PostgreSQL (pgvector)
  │   - Update Redis feed list with clip IDs
  │
  ▼
200 OK {results: [...10 clips with hls_urls...]}
```

**Components involved:** Browser → Cloudflare Tunnel → nginx → gunicorn → Redis cache → Postgres → Celery feed worker (VPS) → Redis cache

## 7. Like/Skip/Telemetry

```
Browser → POST https://api.echoflow.in/interactions/{id}/toggle-like/
  │
  ▼
VPS: nginx → gunicorn → Django
  │ ClipInteractionViewSet [interactions.py]
  │   - counter_store.increment('likes', clip_id)
  │     → Redis INCRBY on redis_cache (172.28.0.3)
  │     O(1) on the request path
  │   - invalidate_user_vectors_cache(user_id) via transaction.on_commit
  │   - INSERT INTO app_userinteraction (...) (F() expression for atomicity)
  │
  ▼
200 OK {status: "liked"}

Background (every 5 min via celery_beat):
flush_counters_to_pg task → 'default' queue
  ← picked up by VPS celery worker (172.28.0.11)
    - Read all counters from Redis batch
    - Batched UPDATE to PostgreSQL
    - Flush complete counters from Redis
```

**Components involved:** Browser → Cloudflare Tunnel → nginx → gunicorn → Redis cache → Postgres → Celery worker (VPS) for metrics flush

## 8. Heartbeat (Health Status)

```
Laptop: scripts/laptop-heartbeat.sh (background process)
  │ Every 30 seconds:
  │   redis-cli -u redis://172.28.0.2:6379/0 SET media_worker:alive <ts> EX 60
  │   ← via Tailscale → VPS Redis broker
  ▼

Browser → GET https://api.echoflow.in/api/v1/health/media-worker/ (polls every ~30s)
  │
  ▼
VPS: nginx → gunicorn → Django
  │ system_health.media_worker_health() [system_health.py]
  │   - Redis.from_url(REDIS_BROKER_URL).get('media_worker:alive')
  │   - Returns {"media_worker_alive": true/false}
  ▼
200 OK {media_worker_alive: true}

Frontend shows: "Processing on time" or "Processing delayed"
```

**Components involved:** Laptop (heartbeat) → VPS Redis broker → VPS gunicorn → Browser

## Connectivity Summary

| Flow | Protocol | Network | Latency |
|------|----------|---------|---------|
| Browser → API | HTTPS (TLS 1.2/1.3) | Cloudflare Tunnel → VPS nginx | ~50-200 ms (Cloudflare edge → VPS) |
| Browser → HLS | HTTPS (TLS 1.3) | Cloudflare CDN → R2 | ~10-30 ms (cached at edge) |
| Laptop worker → Redis broker | Redis protocol | Tailscale (WireGuard) | ~5-20 ms |
| Laptop worker → Postgres | PostgreSQL protocol | Tailscale (WireGuard) | ~5-20 ms |
| Laptop worker → R2 | HTTPS (AWS SigV4) | Public internet | ~10-50 ms |
| Laptop heartbeat → Redis | Redis protocol | Tailscale (WireGuard) | ~5-20 ms |
| Browser → Frontend | HTTPS | Cloudflare Pages | ~5-20 ms (edge cache) |

All VPS-to-laptop and laptop-to-VPS traffic flows through Tailscale's
encrypted WireGuard tunnel. No VPS ports are exposed to the public internet
except `:80` and `:443` (for the Cloudflare Tunnel).

## Failure Modes

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Laptop sleeps / loses power | Heartbeat key expires (60s TTL) → API returns `false` | Frontend shows "Processing delayed"; clips resume processing when laptop wakes |
| Tailscale disconnects | Worker can't reach Redis/Postgres → tasks stay in queue | Tasks remain in Redis until connection restores; idempotent retries |
| VPS restarts | Health checks fail → Docker restarts containers | `restart: unless-stopped` keeps services alive |
| R2 bucket misconfigured | HLS uploads fail → task fails → retry | Check bucket policy, fix ACLs, requeue task |
| Cloudflare Tunnel down | API unreachable → frontend shows error | Restart cloudflared on VPS |
