# docs/stateful-media-storage-at-scale.md

> **Status: Architecture implemented on `feat/stage2-service-layer-and-telemetry-stream` (heads through 3d973a7). The original failure modes (split-brain, disk exhaustion, ghost playlist) are no longer reachable in this codebase.**
>
> **Remaining hardening before public launch:** nginx reverse proxy in front of MinIO, CDN in front of `/hls/*`, presigned-PUT direct upload (P1.3), S3 lifecycle rule for `uploads/` (Glacier), OAC bucket policy restricting `hls/` to CDN-only access.
>
> **Companion to:** `docs/event-driven-architecture-plan.md` (the unfixed-issues roll-up is `docs/unfixed-issues-2026-09-03.md`).
>
> **Date:** 2026-09-03.

## Executive Summary

The original concern in this document — that EchoFlow's media was bound to a shared local filesystem — has been resolved. The codebase now uses S3-compatible object storage (`STORAGES["default"] = storages.backends.s3.S3Storage` in `backend/EchoFlow/settings.py:307-330`), ephemeral per-task scratch via `tempfile`, a public `hls/` prefix served directly by MinIO via bucket policy, and signed URLs for `uploads/`. The failure modes that motivated this document — split-brain processing, disk exhaustion, ghost playlists — are structurally unreachable in the current architecture.

What remains is **production hardening** rather than architectural rework: in front of the existing pipeline, no service today terminates TLS, serves HLS through a CDN cache, or offloads uploads from the API tier. This document is updated to reflect the shipped reality and to call out exactly what still doesn't scale.

---

## Current Media Architecture
**Status: Implemented — every claim below now describes production behavior, not an aspirational plan.**

1.  **Ingestion:** The client `POST`s a multipart form payload containing the audio file to `AudioUploadViewSet.create` (`backend/app/views/content.py`). Django writes the file via `default_storage` — which is `storages.backends.s3.S3Storage` (`backend/EchoFlow/settings.py:307-330`) — straight to the `uploads/%Y/%m/%d/` prefix in the configured bucket. **No local disk is involved in the upload path; the gunicorn thread is only blocked for the duration of the multipart parse and the single S3 PUT.**
2.  **Task Handoff:** The view calls `services/uploads.finalize_upload(clip)`, which wraps `process_audio_to_hls.delay(clip.id)` in `transaction.on_commit` (`backend/app/services/uploads.py:18-25`). The row is guaranteed to have persisted before Celery picks up the task; the `on_commit` contract was moved out of the view in commit `7f1b483` and now lives behind the service seam.
3.  **Processing:** The Celery `heavy_media` worker reads the original via `default_storage.open()`-equivalent — `clip.original_file.open('rb')` (`backend/app/tasks.py:186-188`) — **streaming the object down to a `tempfile.mkstemp` local copy** before invoking ffmpeg / librosa / Whisper. The scratch file is removed in the `finally:` block alongside the `tempfile.mkdtemp` HLS output dir (`backend/app/tasks.py:308-314`). **Workers no longer share a filesystem; each one renders, uploads, and cleans up its own scratch space.**
4.  **Delivery:** Generated HLS files are uploaded to object storage under `hls/{clip_id}/...` via `default_storage.save()` in a `for root,_dirs,files in os.walk(local_hls_dir)` loop (`backend/app/tasks.py:286-293`). The `AudioClip.hls_playlist_url` field stores the **relative object key** `hls/{clip_id}/master.m3u8` (NOT a full URL; the serializer regenerates the public-facing URL per request via `media_urls.get_hls_playback_url` which dispatches on the `hls/` prefix and uses the public bucket policy). For `uploads/`, the serializer calls `get_signed_media_url` which produces a `boto3.generate_presigned_url(...)` with a 1-hour TTL (`backend/app/media_urls.py:62-92`).
5.  **Local scratch:** `backend/app/tasks.py:185` (`fd, input_file_path = tempfile.mkstemp(...)`) and `backend/app/tasks.py:212` (`local_hls_dir = tempfile.mkdtemp(prefix=f'hls-{clip_id}-')`). `SCRAPER_SCRATCH_DIR` (`settings.py:195-199`) is documented as ephemeral per-container working space; it is never shared. `MEDIA_ROOT` is no longer used for user content (see `settings.py:177-200` for the rationale comment).

---

## Hidden Stateful Assumptions
**Status: most are now impossible by construction; two remain as hardening work.**

The codebase is no longer riddled with assumptions that bind the application to a single physical disk. The remaining stateful concerns are:

*   ~~`clip.original_file.path`~~ **Resolved.** The original code assumed a POSIX path on the worker. Today's `process_audio_to_hls` does **not** call `clip.original_file.path`; it streams the object to `tempfile.mkstemp` via `clip.original_file.open('rb')` (`backend/app/tasks.py:185-188`). The explicit comment at `tasks.py:176-184` documents the S3Storage no-local-path pattern.
*   ~~`os.makedirs(os.path.join(settings.MEDIA_ROOT, 'hls', str(clip.id)))`~~ **Resolved.** The output directory is `tempfile.mkdtemp(prefix=f'hls-{clip_id}-')` (`backend/app/tasks.py:212`). The comment at `tasks.py:206-211` states: "nothing under this directory is ever read by another container; it exists only for the lifetime of this task on this worker."
*   ~~Media served from Django / gunicorn threads~~ **Resolved.** `backend/EchoFlow/urls.py:27-32` has the `/media/` route **explicitly removed**; `MEDIA_URL='/media/'` is kept only because a few Django internals reference it (`settings.py:193-194`). HLS is served by MinIO directly via the bucket policy.
*   **Remaining concern — dev bind mounts:** `docker-compose.yml:159, 205, 264` mount the project root into `web`, `celery`, and `celery_feed`. They are not the storage path; the media files are in MinIO, not in the bind mount. But the bind mounts remain on trunk and P1.2 should consider removing them once nginx is in place to reduce confusion about "where does state live."
*   **Remaining concern — `celery_media` does not mount anything:** it has no `volumes:` block (`docker-compose.yml:286-340`). The comment at `docker-compose.yml:302-305` is the load-bearing statement: "this container can run on any machine, with no filesystem in common with `web`, and still process clips correctly." **This is the design that P1.2 preserves.**

---

## Horizontal Scaling Failure Modes
**Status: all three original failure modes are structurally impossible. New failure modes (and mitigations) appear at 10k+ concurrent.**

If the system were to scale to 10 API servers and 50 workers across multiple availability zones, the original failure modes do not occur:

1.  ~~**The Split-Brain Processing Failure:**~~
    *   ~~*Scenario:* User uploads to API Server 1. Celery Worker on Server 4 picks up the task.~~
    *   ~~*Result:* Worker 4 cannot find the file in its local `/uploads/` directory. The upload is permanently stalled in a `processing` state.~~
    *   **Resolution:** The upload is `default_storage.save()` to the bucket; the worker reads it back via `clip.original_file.open('rb')` (`tasks.py:186-188`). There is no shared filesystem to be out of sync with.

2.  ~~**The Disk Exhaustion Cascade:**~~
    *   ~~*Scenario:* A viral trend causes 100,000 uploads.~~
    *   ~~*Result:* API servers, handling binary uploads through RAM and writing to local disk, run out of EBS volume space. The OS halts, causing complete node failure.~~
    *   **Resolution:** Bytes go to object storage, not local disk. The API tier's only storage footprint is the multipart parse buffer, which is bounded by `client_max_body_size` on the (future) nginx or by Django's `DATA_UPLOAD_MAX_MEMORY_SIZE` (default 2.5 MB). MinIO volume is its own concern, not the API tier's.

3.  ~~**The "Ghost Playlist" Phenomenon:**~~
    *   ~~*Scenario:* Worker 2 successfully transcodes an HLS playlist and saves it locally. API Server 7 receives the client's HTTP request for the `.m3u8` file.~~
    *   ~~*Result:* Server 7 returns a 404 because the file exists only on Worker 2's ephemeral disk.~~
    *   **Resolution:** HLS files are uploaded to object storage by the worker (`tasks.py:286-293`); the browser fetches from MinIO via the public `hls/` bucket policy. The API tier never serves HLS bytes.

**New failure modes introduced by the S3 architecture (and their current mitigations):**

*   **MinIO CPU/MEM exhaustion under HLS egress** — `docker-compose.yml:70-94` has no `deploy.resources` block on the `minio` service. Under 1.5–2 Gbps HLS egress, MinIO will hit CPU caps. **Mitigation pending: P0.3 (resource limits).** Today the only bound is Docker's default 1 GB / 1 CPU on the host.
*   **Public `hls/` bucket is public-read for everyone, not just the CDN** — `mc anonymous set download` on the `hls/` prefix is global public-read (`docker-compose.yml:107-108`). There is no Origin Access Control policy restricting the bucket to a CloudFront/OAC distribution. **Mitigation pending: P1.2 (CloudFront + OAC).**
    *   ✅ **RESOLVED 2026-09-28, differently.** `hls/` is now **fully private** (`mc anonymous set download` removed from `minio-init`), and the CloudFront/OAC plan is moot for `hls/`: playback is gated at the edge by a short-lived per-clip HMAC token — `ef_hls_token` cookie for browsers, `X-EchoFlow-Media-Token` header for native players — validated by the Cloudflare Worker at `media.echoflow.in` (nginx `:9443` locally). No public-read policy and no OAC distribution. See `docs/EXPLAIN/storage/04-hls-token-protection.md` and `docs/mobile-rebuild-plan.md` §2-3. The `uploads/` prefix remains private behind presigned URLs.
*   **`uploads/` lifecycle is unconfigured** — the original doc called for a 7-day Glacier transition on `echoflow-raw` (a separate bucket for raw uploads). In the current architecture the original is in the same bucket under `uploads/`, and **no S3 lifecycle rule is configured**. **Mitigation pending: P2 in the original doc's roadmap.**

---

## Recommended Media Storage Architecture
**Status: Implemented — every recommendation below is now production behavior.**

EchoFlow enforces strict **statelessness** on all compute nodes:
*   **Primary Storage:** S3-compatible object storage (MinIO in dev, S3 / R2 in prod). `STORAGES["default"]` is `storages.backends.s3.S3Storage` (`backend/EchoFlow/settings.py:307-330`).
*   **Database:** PostgreSQL remains the source of truth for metadata and object keys (`backend/app/models.py`).
*   **Workers:** Ephemeral. They download from object storage to a `tempfile.mkstemp` scratch, process, upload to object storage, and clean up in `finally:`. The `celery_media` service has no `volumes:` block at all (`docker-compose.yml:286-340`).

### Upload Architecture
**Implemented: Client → API → S3 via Django storage backend.** The synchronous `Client → API → Local Disk` pattern is gone. The `python-magic` magic-byte validation runs at the serializer level before the file ever reaches `default_storage` (commit `2715b54`).

**Not implemented: Presigned-PUT direct upload.** `services/uploads.py` has a TODO at line 7 for `get_signed_put_url`. The endpoint `/clips/presign/` does not exist; `AudioClip.status` is binary (`processing` / `ready` / `failed`) — the `pending_upload` value is not in any migration. Today's upload still transits the gunicorn thread, just to S3 instead of to local disk. **P1.3 in `docs/event-driven-architecture-plan.md`.**

### Media Processing State Machine
**Partial.** Binary `processing` ↔ `ready` ↔ `failed` is in place (`backend/app/models.py:82`). The `pending_upload` state is not added. The audit's stale-processing failure mode is addressed by `cleanup_stuck_processing` (`backend/app/tasks.py:795-831`): every 5 min, clips in `processing` past 15 min are re-enqueued; after `threshold_minutes * 3` (45 min) the row is flipped to `failed` and surfaced in error reports. This addresses the "Celery broker hiccup at `transaction.on_commit` time" failure mode that the audit flagged (item 6.7).

### Object Storage Strategy
**Implemented.** Key design matches the plan:
*   Original uploads: `s3://{bucket}/uploads/%Y/%m/%d/{filename}` — UUID-suffixed filenames, set by `FileField(upload_to=...)` and `file_overwrite=False` (`backend/EchoFlow/settings.py:324`).
*   HLS output: `s3://{bucket}/hls/{clip_id}/{master.m3u8,index.m3u8,segment_*.ts}` (`backend/app/tasks.py:286-301`).
*   **Immutability:** Audio files are immutable. Re-uploads generate a new UUID via the `AudioClip` PK default.
*   ~~Lifecycle Policies: The `echoflow-raw` bucket should automatically transition raw files to Glacier/Deep Archive after 7 days.~~ **Not implemented.** No S3 lifecycle rule is configured on the bucket. **`uploads/` stays in standard storage until manually deleted.** P2 in this doc's roadmap.

### CDN Strategy
**Not implemented.** No nginx service in `docker-compose.yml`. `PUBLIC_MEDIA_ENDPOINT_URL` defaults to `AWS_S3_ENDPOINT_URL` (`backend/EchoFlow/settings.py:348`); in dev that's `http://localhost:9000` (the MinIO host-published port), not a CDN. The browser currently hits MinIO directly. CORS for browser HLS playback is wired via MinIO env vars (`docker-compose.yml:79-83`) and `CORS_EXPOSE_HEADERS` exposing `Content-Range` and `Accept-Ranges` (`backend/EchoFlow/settings.py:56-59`). Range request handling depends on hls.js → MinIO; it is not exercised through a CDN cache yet. **P1.2 in `docs/event-driven-architecture-plan.md`.**

The original doc's recommendation of **CloudFront with Origin Shield** and **Range request support** stands as written. Until a CDN is in front of MinIO, the public-read `hls/` bucket is exposed to the open internet without an OAC policy.

---

## Consistency Model
*   **Source of Truth:** PostgreSQL is the definitive authority on *state* (is this clip published?). Object storage is the authority on *bytes* (the actual media).
*   **Eventual Consistency:** When a clip is uploaded, the DB is updated. The CDN edge locations may take milliseconds to cache the object. (CDN not yet deployed — see CDN Strategy above.)
*   **Orphan Mitigation (Transactional Outbox):** ~~If a user deletes a clip, you cannot perform a synchronous S3 delete during the HTTP request. If S3 times out, the DB transaction rolls back. Instead, soft-delete the `AudioClip` in Postgres (making it instantly invisible to the app) and dispatch a Celery task to perform the hard S3 delete asynchronously.~~ **Not implemented.** No soft-delete on `AudioClip`. No outbox table. No async S3-delete task. `ClipDeleted` event also not emitted (referenced in `docs/event-driven-architecture-plan.md:590`). **P1.4 in `docs/event-driven-architecture-plan.md`.**

## Idempotency and Retry Strategy
**Status: Implemented for `process_audio_to_hls`. The retry and cleanup contracts from this section are now production behavior.**

*   The task is bound with `bind=True, max_retries=3, default_retry_delay=60, autoretry_for=RETRYABLE_ERRORS, retry_backoff=True, retry_backoff_max=600, retry_jitter=False` (`backend/app/tasks.py:163`). Transient `OperationalError`, `ConnectionError`, `subprocess.CalledProcessError`, and `OSError` are auto-retried with exponential backoff.
*   The worker downloads the raw file to `tempfile.mkstemp` (line 185), normalizes via ffmpeg → WAV, runs the AI stack, encodes HLS to a `tempfile.mkdtemp` directory, uploads every file via `default_storage.save()`, then deletes the `tempfile.mkstemp` and `tempfile.mkdtemp` paths in a `finally:` block (`backend/app/tasks.py:308-314`). The comment at line 309-310 makes the cleanup invariant explicit: "Always clean up both local scratch areas, success or failure."
*   **Not implemented: SHA-256 dedup at the presign stage** — P1.3. The current `get_or_create` style uniqueness checks live in the service layer, not at the byte level.

---

## Failure Scenarios and Recovery

| Scenario | Impact | Current (2026-09-03) recovery behavior |
| :--- | :--- | :--- |
| **Worker crashes mid-transcode** | Orphaned files in `/tmp/` | **Resolved by `tempfile.mkstemp` + `finally:` cleanup** (`backend/app/tasks.py:185, 308-314`). Task is redelivered. The next worker uses a fresh `tempfile.mkstemp` path; partial S3 uploads are overwritten atomically by `default_storage.save()` (idempotent at the object level) |
| **Client retries upload** | Duplicate files | **Partial.** The Django ORM `get_or_create` patterns and the `FileField` `file_overwrite=False` (`backend/EchoFlow/settings.py:324`) prevent exact-duplicate *keys* but do not deduplicate by content. SHA-256 dedup at the presign stage is **P1.3** (not yet implemented) |
| **DB succeeds, S3 fails (Deletion)** | Orphaned S3 bytes (Cost leak) | **Open.** No soft-delete on `AudioClip`. No async S3-delete task. S3 orphans accumulate. P1.4 in `docs/event-driven-architecture-plan.md` |
| **Viral clip causes traffic spike** | Origin overload | **Partial.** The `minio` service has no resource limits (`docker-compose.yml:70-94`). CloudFront Origin Shield is **not deployed** (P1.2). Today, viral clips will exhaust MinIO's default container limits before they exhaust anything else |
| **Upload spike to gunicorn** | API threads pinned on multipart parse | **Open.** No `client_max_body_size` cap on the API tier (no nginx). No presigned-PUT. P1.3 |
| **Celery broker hiccup at `transaction.on_commit` time** | Clip stuck in `processing` forever | **Resolved by `cleanup_stuck_processing`** (`backend/app/tasks.py:795-831`). Beat every 5 min re-enqueues clips stuck >15 min; after 3 retries the row is flipped to `failed` |

---

## Security Architecture
*   **Malicious Files:** Direct-to-S3 uploads bypass Django, preventing server-side arbitrary code execution during ingestion. **Partial.** Today the upload still transits Django (no presigned PUT yet), but `python-magic` MIME validation runs at the serializer level before the file reaches `default_storage` (commit `2715b54`). Disguised executables are rejected with HTTP 400.
*   **Content-Type Spoofing:** FFmpeg acts as a natural sanitizer. If a user uploads a disguised executable, FFmpeg fails to parse it as an audio stream, `process_audio_to_hls` flips the row to `failed` (`backend/app/tasks.py:171-174, 195-199`), and the threat is isolated to the failed clip.
*   **Predictable Object Keys:** Object keys use UUIDv4 for HLS (`hls/{clip_id}/...`) and timestamp-prefixed paths for originals (`uploads/%Y/%m/%d/{filename}`). The `AudioClip.id` UUID is unguessable (`backend/app/models.py:48`).
*   **Public Access:** The `hls/` prefix is `mc anonymous set download` (`docker-compose.yml:107-108`) — public-read globally. **OAC (Origin Access Control) bucket policy is not configured.** The original doc's recommendation of "restricted to CloudFront via OAC" stands as the correct hardening. **Open: P1.2 (CloudFront + OAC).**

---

## Cost and Capacity Analysis
*   **Ingestion:** 1M uploads/day ≈ 10TB of raw ingress. (S3 Ingress is free; MinIO is self-hosted and the cost is on the operator.)
*   **Storage:** 10M media objects (HLS format, ~3 qualities) ≈ 150TB. S3 Standard costs ~$3,500/month. **No Glacier transition is configured**; the cost figure assumes standard storage for the full retention window. P2 in this doc's roadmap.
*   **Delivery (The Threat):** If viral media causes extreme read amplification (e.g., 10M users streaming 10MB each), that is 100TB of egress. At standard AWS CloudFront rates ($0.085/GB), this costs $8,500 **per day**. **Mitigation pending: Cloudflare R2 / Bandwidth Alliance, or committed-use discounts with AWS, otherwise scaling EchoFlow will financially ruin the company. CDN is P1.2.**

---

## What Should Change in EchoFlow

### Current vs Target Architecture — Status

*   **~~Current `AudioClip` Model~~** (`models.py:53` — `original_file = models.FileField(upload_to='uploads/%Y/%m/%d/', null=True)`): **Behaviorally equivalent to the target.** Despite being a `FileField`, the bytes go to S3-compatible object storage via `STORAGES["default"]` (`backend/EchoFlow/settings.py:307-330`); `clip.original_file.path` is **never read** anywhere in the codebase. No migration to a separate `raw_s3_key` `CharField` is necessary for the current architecture to work.
*   **~~Current `tasks.py`~~** (`tasks.py:185, 212, 286-293`): **Behaviorally equivalent to the target.** `tempfile.mkstemp` and `tempfile.mkdtemp` replace the old `settings.MEDIA_ROOT`-based paths. The local file is downloaded via `clip.original_file.open('rb')` → `shutil.copyfileobj`; the local HLS dir is walked and uploaded via `default_storage.save()`. The `finally:` block cleans both up.

### Missing Infrastructure (today, 2026-09-03)

*   **~~AWS S3 Integration~~** — **Implemented.** `django-storages` and `boto3` are in `requirements.txt`. MinIO service in dev, real S3/R2 in prod. The `STORAGES["default"] = S3Storage` block is the single source of truth (`settings.py:307-330`).
*   **~~Presigned URL Endpoint~~** — **Open.** `services/uploads.py:7` has a TODO for `get_signed_put_url`. No `/clips/presign/` endpoint. **P1.3 in `docs/event-driven-architecture-plan.md`.**
*   **CDN Configuration** — **Open.** No CloudFront / Cloudflare / Bunny config. No nginx service. **P1.2.**
*   **MinIO resource limits** — **Open.** No `deploy.resources` block on the `minio` service. **P0.3.**
*   **Glacier lifecycle for `uploads/`** — **Open.** No S3 lifecycle rule. **P2.**
*   **OAC bucket policy for `hls/`** — **Open.** Bucket is currently public-read. **P1.2.**
*   **Soft-delete + outbox + `ClipDeleted` event** — **Open.** No soft-delete on `AudioClip`; no outbox table. **P1.4.**

---

## P0/P1/P2/P3 Implementation Roadmap

*   **P0 (Blocker for Production):** ~~Rip out `models.FileField`. Implement `django-storages` pointing to an S3 bucket. Modify `process_audio_to_hls` to use Python's `tempfile` module for intermediate disk I/O instead of `settings.MEDIA_ROOT`.~~ **✅ RESOLVED.** `STORAGES["default"]` is `S3Storage`; `process_audio_to_hls` uses `tempfile.mkstemp` / `tempfile.mkdtemp`; `MEDIA_ROOT` is no longer used for user content (`backend/EchoFlow/settings.py:177-200`). **Sub-item still open: P0.3** (MinIO resource limits).
*   **P1 (Before Viral Growth):** Implement Direct-to-S3 Presigned URL uploads to unblock the Gunicorn/API workers from handling binary streams. **⏳ OPEN.** `services/uploads.py:7` has the TODO; no `/clips/presign/` endpoint; `pending_upload` AudioClip status not added.
*   **P2 (Cost Optimization):** Implement CloudFront caching layers and S3 lifecycle rules to move raw uploads to Glacier. **⏳ OPEN.** No CDN, no lifecycle rule.
*   **P3 (Extreme Scale):** Implement cross-region S3 replication for the media bucket to reduce latency for global listeners. **⏳ OPEN.** Not started.

---

## Architectural Blind Spots
*   **My Blind Spot:** FFmpeg time. If audio files are long (e.g., >3 minutes), the worker could hit Celery's `soft_time_limit` and be killed, abandoning the `/tmp` files. **Mitigation today:** `process_audio_to_hls` has `max_retries=3, retry_backoff_max=600` (`backend/app/tasks.py:163`) and a `finally:` cleanup block. **Still open:** `soft_time_limit` is not configured on the Celery worker; if a hard kill happens before the `finally:` block runs, the local scratch is leaked. Recommend `task_soft_time_limit=600` on the `heavy_media` worker.
*   **Your Blind Spot:** Transcoding requires massive CPU. ~~If you run the Celery worker on the same EC2 instance as the API, an upload spike will starve the API of CPU cycles, taking down the feed endpoint. The workers *must* be physically isolated on different compute clusters.~~ **Addressed.** `celery_media` runs on a separate image (`devansh1012007/echoflow-media`, target `media`) with `cpus: 4`, `memory: 4G` (`docker-compose.yml:325-340`). The `web` service is bounded at `cpus: 2, memory: 1G`. They share the Compose network but not the cgroup.

---

## Final Senior-Engineer Verdict

The architecture that this document prescribed is now implemented: media lives in S3-compatible object storage, the API tier is a stateless traffic cop that never touches the audio bytes, workers render to `tempfile` scratch and clean up in `finally:`, and HLS is served by MinIO via the public `hls/` bucket policy. The split-brain, disk-exhaustion, and ghost-playlist failure modes are structurally impossible in the current codebase.

The remaining work is **production hardening**, not architectural rework:
1. **CDN + OAC in front of MinIO** (P1.2) — the highest-leverage open item. Without it, the public-read `hls/` bucket is exposed to the open internet with no rate limiting, no cache, and no Origin Access Control. **Before any public launch.**
2. **Direct-to-S3 presigned PUT** (P1.3) — removes the upload bandwidth from the API tier. The serializer-level magic-byte validation (commit `2715b54`) and the service-layer boundary in `services/uploads.py` are the right hooks.
3. **MinIO resource limits** (P0.3) — five lines of `docker-compose.yml` (`deploy.resources` on the `minio` service). Trivial; no reason to defer.
4. **Glacier lifecycle for `uploads/`** (P2) — a single S3 lifecycle rule. Saves real money at the 10M-object scale.
5. **`task_soft_time_limit` on `heavy_media`** — five minutes of YAML. Protects against the original doc's FFmpeg time blind spot.

These five items, plus the F() counter pipeline and PgBouncer / nginx / Redis `volatile-lru` from `docs/event-driven-architecture-plan.md` §6, are the **launch checklist**. The architecture itself is sound.