# Key Decisions Log

This document consolidates all `DECISION`, `SECURITY`, `HACK`, and `TODO` comments found in the codebase.

---

## DECISION Comments

### 1. Fail-Fast on Missing Secrets
**Files:** `settings.py:13-21`, `models.py:16-22`
```python
# DECISION: Fail fast on missing DJANGO_SECRET_KEY, same pattern as
# FIELD_ENCRYPTION_KEY in models.py. Generating a random key per process
# would silently break session/CSRF/signature verification across the
# gunicorn + Celery fleet — every worker would have a different key.
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    raise ImproperlyConfigured(...)
```
**Rationale:** Silent fallback breaks distributed authentication. Fail-fast catches config errors at startup.

---

### 2. CORS Allow All Origins → Disabled
**File:** `settings.py:57-63`
```python
# DECISION: Disabled CORS_ALLOW_ALL_ORIGINS; using explicit allowed origins
# instead. Tradeoff: Less convenient for unknown clients, but prevents CSRF-style
# attacks from malicious domains using JWT auth.
CORS_ALLOW_ALL_ORIGINS = False
```
**Rationale:** Security over convenience. Explicit origins prevent token theft via malicious sites.

---

### 3. Media Storage → S3-Compatible (Not Local Disk)
**File:** `settings.py:174-195`
```python
# DIAGNOSIS: every media bug this week (dead /media/ route under DEBUG=False,
# celery_media unable to see files web wrote, the wrong image entirely being
# served to a worker) traced back to one root assumption: that every
# container processing a clip shares one filesystem with the container that
# received the upload. That's only true in this specific docker-compose
# setup, and only true today because of a dev-convenience bind mount — it is
# NOT true of a real deployment...
# DECISION: media now lives in S3-compatible object storage that every
# container reaches over the network, identically, in every environment.
```
**Rationale:** Local filesystem doesn't work in distributed deployments. S3-compatible storage works identically everywhere.

---

### 4. STORAGES Dict (Django 5.1+)
**File:** `settings.py:261-263`
```python
# DECISION: STORAGES dict, not STATICFILES_STORAGE — that setting was removed
# in Django 5.1 and is silently ignored (no manifest would ever be generated).
STORAGES = {...}
```
**Rationale:** Django 5.1 deprecated `STATICFILES_STORAGE`; `STORAGES` is the new API.

---

### 5. Thread-Safe Model Loading (Double-Checked Locking)
**File:** `tasks.py:36-41`
```python
# DECISION: Use thread-safe double-checked locking instead of simple
# singleton to prevent concurrent task initialization from loading the
# same ML model multiple times (memory waste / duplicate GPU/CPU loads).
# Tradeoff: Slight latency on first access vs. guaranteed single init.
```
**Rationale:** Prevents duplicate model loads in prefork Celery workers.

---

### 6. Retry Configuration on Celery Tasks
**File:** `tasks.py:179-183`
```python
# DECISION: Added bind=True + retry config to prevent permanent data loss
# when transient errors occur (DB connection timeout, FFmpeg crash, network
# failure). Tradeoff: Slightly more overhead per task (retry tracking) vs.
# guaranteed resilience.
@shared_task(bind=True, max_retries=3, default_retry_delay=60, autoretry_for=RETRYABLE_ERRORS, retry_backoff=True, retry_backoff_max=600, retry_jitter=False)
```

---

### 7. Authoritative FFmpeg Decode (Normalize Once)
**File:** `tasks.py:142-169`, `tasks.py:196-224`
```python
# DIAGNOSIS -> SOLUTION: `clip.original_file.path` only exists for
# FileSystemStorage; S3Storage has no local path — the bytes live in the
# bucket, not on this container's disk. ffmpeg/librosa/Whisper all need a
# real local file to operate on, so we explicitly stream the object down to
# a local temp file once, work on that, and delete it when done.
```
**Rationale:** Single authoritative decode avoids format-specific bugs and ensures consistency.

---

### 8. MPEG-TS Segments (Not fMP4)
**File:** `tasks.py:285-294`
```python
# DECISION: Use standard MPEG-TS segments explicitly.
# Chrome's MSE decoder rejects fMP4 segments with certain AAC codec
# configurations, producing "DecoderStatus::kUnsupportedConfig".
# MPEG-TS is universally supported by hls.js and all browsers.
# Newer FFmpeg defaults to fMP4, so we must explicitly set mpegts.
```

---

### 9. Store Object Key (Not Signed URL) in DB
**File:** `tasks.py:315-320`
```python
# DECISION: store the relative object KEY, not a full URL. A
# signed S3 URL expires (see AWS_S3_QUERYSTRING_EXPIRE) — baking
# one into the database would mean playback silently breaks an
# hour after processing regardless of whether the clip is still
# valid. The serializer generates a fresh signed URL from this
# key on every read instead (see FeedClipSerializer).
```

---

### 10. Feed Refill Lock (SETNX)
**File:** `tasks.py:517-523`
```python
# DECISION: SETNX with 30s expiry prevents double-refill without
# blocking indefinitely if a worker dies mid-task.
lock_key = f"feed_refill_lock:{user_id}"
acquired = redis_client.set(lock_key, "1", nx=True, ex=30)
if not acquired:
    return "Refill already in progress."
```

---

### 11. Always Release Refill Lock
**File:** `tasks.py:577-583`
```python
# DECISION: Always release refill lock to prevent deadlock if worker
# crashes after acquiring but before completing the task.
finally:
    try:
        redis_client.delete(lock_key)
    except Exception:
        pass
```

---

### 11. Feed Mixing (80/20 + Follow Wedge)
**File:** `tasks.py:554-572`
```python
# 80% EXPLOIT: Serve highest scoring algorithmic matches
exploit_count = int(count * 0.8)
exploit_clips = composite_query[:exploit_count]
# The Follow Graph Wedge: Pull recent content from followed creators
followed_creators = user.following.all()
network_clips = base_queryset.filter(
    creator__in=followed_creators
).order_by('-created_at')[:5] # Force 5 network clips into the mix
# 20% EXPLORE: Serve high velocity clips outside their vector neighborhood
explore_count = count - exploit_count
explore_clips = base_queryset.exclude(
    id__in=[c.id for c in exploit_clips]
).order_by('-engagement_velocity')[:explore_count]
```

---

### 12. Transaction.on_commit for Task Enqueue
**File:** `views.py:101`
```python
transaction.on_commit(lambda: process_audio_to_hls.delay(clip.id))
```
**Rationale:** Guarantees clip row exists before worker picks up task. If transaction rolls back, task never enqueued.

---

### 13. Denormalized Counters with F() Expressions
**File:** `models.py:181-205`
```python
# UserInteraction.save() uses F() expressions for atomic counter increments
AudioClip.objects.filter(pk=self.clip.pk).update(
    **{field_to_update: F(field_to_update) + increment_val}
)
```
**Rationale:** Atomic increments prevent race conditions on concurrent likes/shares.

---

### 14. Comment Count via save()/delete() (Not Signals)
**File:** `models.py:134-144`
```python
# NOTE: use _state.adding, NOT `not self.pk` — UUID pks with a callable
# default are assigned at __init__, so self.pk is never None on create.
if self._state.adding and not self.parent_id:
    AudioClip.objects.filter(pk=self.clip_id).update(comment_count=F('comment_count') + 1)
```
**Rationale:** UUID PK assigned at init; `_state.adding` correctly detects creation.

---

### 15. BuildKit Secret for HF_TOKEN
**File:** `Dockerfile:116-123`, `docker-compose.yml:397-402`
```dockerfile
# SECURITY: HF_TOKEN reaches the bake step exclusively via a BuildKit secret mount.
# Secrets mounted this way never enter ARG/ENV, layer history, or cache
# metadata, so `docker history` cannot leak them.
RUN --mount=type=secret,id=hf_token \
    set -eu; \
    if [ -s /run/secrets/hf_token ]; then \
        export HF_TOKEN="$(cat /run/secrets/hf_token)"; \
    fi; \
    python -c "..."
```
**Rationale:** `--build-arg` persists in layer history; BuildKit secret mount exists only during RUN.

---

### 16. Offline Wheelhouse for Deterministic Builds
**File:** `Dockerfile:76-81, 101-106`, `AGENTS.md`
```dockerfile
# --no-index: wheelhouse is verified complete for this pinned set — installs
# are fully offline and deterministic. If you add a dependency, regenerate the
# wheelhouse first (see AGENTS.md) or temporarily drop --no-index.
RUN pip install --no-cache-dir \
      --no-index --find-links=/wheelhouse \
      -c constraints.txt \
      -r requirements-base.txt
```

---

### 17. Gunicorn preload_app + post_fork Hook
**File:** `gunicorn.conf.py:22, 44-65`
```python
preload_app = True  # Load app before forking workers (saves memory)

def post_fork(server, worker):
    # Reset ALL shared connections after fork.
    # Critical because EchoFlow/__init__.py imports Celery app at module load time.
    # When preload_app=True, the Celery app's Redis connections AND Django's DB
    # connections are established in the master process. Without resetting,
    # forked workers inherit stale connections, which leads to "connection reset"
    # errors and silent failures.
    from django.db import connections
    for conn in connections.all():
        conn.close()
    # Reset Celery/Redis connections
    ...
```

---

## SECURITY Comments

### 1. BuildKit Secret for HF_TOKEN
**File:** `Dockerfile:112-115`
```dockerfile
# SECURITY: 
#   --mount=type=secret  -> file exists only during THIS RUN, never persisted
#   `set -eu` (NOT -x!)  -> xtrace would echo the exported token into build logs
#   [ -s ... ] guard     -> absent/empty secret = anonymous public download
```

### 2. Split ACL (hls/ token-gated, uploads/ private) — **SUPERSEDED**
**Was:** `media_urls.py:1-38`, claiming `hls/` was intentionally public
```python
# SECURITY:
# - `hls/` is intentionally public for playback; this is not a data leak — originals remain private
# - No admin/backend access is granted through MinIO public access
# - `mc anonymous set download` is scoped to `/hls/` prefix only
```
**Now:** the quoted comment is gone and the claim is inverted. `hls/` is
private and reachable only through the validating edge, which requires a
short-lived per-clip HMAC token (`ef_hls_token` cookie, or the
`X-EchoFlow-Media-Token` header for native players). `mc anonymous set
download` is no longer run anywhere. The "not a data leak" reasoning was
wrong: segments are verbatim transcripts, so a public prefix is the whole
clip in one request. See
[`../storage/04-hls-token-protection.md`](../storage/04-hls-token-protection.md)
and `2026-09-28-native-media-auth-and-cgnat-throttling.md`.

### 3. Fail-Fast on Encryption Key
**File:** `models.py:16-22`
```python
# Fail fast. Do not allow the app to boot without PII encryption.
raise ImproperlyConfigured("FIELD_ENCRYPTION_KEY is missing...")
```

---

## HACK Comments

### 1. db_routers.py (Stub)
**File:** `db_routers.py:1`
```python
# no need now ; when u get a seprate db for stats that time u will nedd it
```
**Status:** Intentional stub — no multi-DB setup currently.

---

### 2. Commented OpenAI Pipeline
**File:** `tasks.py:337-417`
```python
'''try:
    client = get_openai_client()
    ...
    # OpenAI-based pipeline (commented out)
    ...
'''
```
**Status:** Placeholder for future OpenAI integration when budget allows.

---

### 3. Commented FeedViewSet
**File:** `views.py:160-215`
```python
'''class FeedViewSet(viewsets.ReadOnlyModelViewSet):
    ...
'''
```
**Status:** Fallback slow feed implementation, commented out. Architecture audit recommends implementing fallback.

---

## TODO Comments

### 1. Key Rotation for Fernet
**File:** `models.py:40-42` (implied), `docs/backend-architecture-audit.md:99`
```python
# TODO: Implement key rotation for Fernet email encryption
```

### 2. Batch update_global_metrics
**File:** `tasks.py:666-690`, `docs/backend-architecture-audit.md:149, 219`
```python
# TODO: Batch the `update_global_metrics` cron job to process 10,000 rows at a time to prevent locks
```

### 3. Fallback Feed for Redis Outage
**File:** `views.py:160-215` (commented), `docs/backend-architecture-audit.md:150, 220`
```python
# TODO: Implement fallback feed when vector search fails
```

### 4. Split Redis (Broker vs Cache)
**File:** `settings.py:131-150`, `docs/backend-architecture-audit.md:151, 221`
```python
# TODO: Use one Redis instance exclusively for Celery queues and a separate Redis instance for the user_feed:{id} cache
```

### 5. Magic Byte Validation
**File:** `serializers.py:29-35`, `docs/backend-architecture-audit.md:222`
```python
# TODO: Use python-magic to verify file headers before sending to FFmpeg
```

### 6. Per-Endpoint Rate Limiting
**File:** `settings.py:324-331`, `docs/backend-architecture-audit.md:223`
```python
# TODO: Add per-endpoint override on `log_telemetry` specifically
```

### 7. Request Tracing / Correlation IDs
**File:** `settings.py:341-378`, `docs/backend-architecture-audit.md:224`
```python
# TODO: Add correlation middleware. LOGGING config does not include a request ID field.
```

### 8. Model Migration to ai_ml/
**Files:** `ai_ml/models/*.py`, `ai_ml/pipelines/*.py`
```python
# TODO: Migrate from backend.app.tasks.get_whisper_model() etc.
```

### 9. PgBouncer Deployment
**File:** `docs/backend-architecture-audit.md:216`
```python
# TODO: Deploy PgBouncer in transaction-pooling mode
```

### 10. Dead Letter Queues for Failed Tasks
**File:** `docs/backend-architecture-audit.md:133`
```python
# TODO: Failed media processing tasks currently just print an error; they need to be routed to a DLQ for manual inspection
```

---

## Discrepancy: Code Comment vs Implementation

| Comment | Actual Behavior |
|---------|-----------------|
| `models.py:40-42` warns about plaintext fallback | **Never executes** — app crashes at startup if key missing |
| `views.py:128-135` mentions "second .delay() removed" | **Already removed** in current code |
| `README.md:24` says DEBUG hardcoded True | **Env-driven** with default False |
| `README.md:25` says CORS_ALLOW_ALL_ORIGINS=True | **Explicitly False** in settings |

---

*Source: Codebase grep for `DECISION`, `SECURITY`, `HACK`, `TODO` patterns*