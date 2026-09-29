# Audio Upload — Operational Guide

> **Audience:** anyone putting audio into EchoFlow for the first time — an
> operator, a developer verifying the local stack, or an agent told to "get
> media into the feed".
>
> **Goal:** get a clip from a file on disk to a playable HLS stream in the feed,
> without hitting the one step in the middle that is easy to miss and produces a
> silent, undiagnosable hang.
>
> **Scope:** the ingestion path only. Storage topology, the HLS token design and
> the ffmpeg invocation have their own documents; those are linked in
> [§11](#11-related-docs) rather than restated here.

---

## 1. What this is

EchoFlow's upload path is **three HTTP-level steps followed by one asynchronous
Celery job**, and the middle step is a moderation approval that is also the
*only* thing in the codebase that enqueues the processing task. Get it right and
an upload takes a couple of minutes; get it wrong and the clip sits at
`status='processing'` for ever, consuming a worker slot and looking, from the
outside, exactly like a slow transcode.

The most common way to get audio into a working local stack is
`backend/scripts/seed_clips.py`, which drives the genuine HTTP API rather than
the ORM. §2 is that path, copy-pasteable. §3 onwards is the manual path, for
when you need to upload one specific file or are debugging a failed seed.

> **SECURITY:** the original upload lands in object storage under
> `uploads/%Y/%m/%d/` *before* moderation runs. That is an accepted v1
> trade-off, not an oversight — see the `finalize_upload` docstring in
> `backend/app/services/uploads.py:19-39`. The upload is never *rendered* to
> users, because every read path filters on `moderation_approved`. If you need
> unmoderated content to never be stored at all, that is the `StagingClip`
> design, and it is not built.

---

## 2. TL;DR — the fastest path

### 2.1 Start the stack

Exactly this, with no shorthand. The `--env-file` is load-bearing:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local up -d
```

Omitting `--env-file .env.local` makes Compose interpolate from `.env`, whose
`DB_PASSWORD` differs from the one the Postgres volume was created with, and
every service then dies with `password authentication failed for user
"echoflow"`. See `AGENTS.md` → *Always start a stack the same way you found it*.

Confirm it is up:

```bash
curl -kI https://localhost:18443/health/
```

`https://localhost:18443` is the API (nginx is the only public entrypoint and it
terminates the self-signed dev TLS). `https://localhost:19443` is the HLS edge.

### 2.2 Make sure a media worker is consuming `heavy_media`

```bash
docker ps --filter name=echoflow_celery_media_local
docker compose -f docker-compose.local.yml --env-file .env.local logs --tail=20 celery_media_local
```

If this container is not running, nothing will transcode and no error will be
raised at upload time. See [§9](#9-troubleshooting) row *tasks never run*.

### 2.3 Create (or Pro-upgrade) the seed account

The free tier allows **5 uploads/day** and **10 MB/file**. Bulk seeding will hit
both, so the seed account is granted Pro directly:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local exec web_local python manage.py shell -c "
from django.contrib.auth import get_user_model
from django.utils import timezone
from datetime import timedelta
U=get_user_model()
u,_=U.objects.get_or_create(username='seeduser', defaults={'email':'seed@echoflow.in'})
u.set_password('SeedLocal!2026'); u.has_pro_entitlement=True
u.pro_expires_at=timezone.now()+timedelta(days=365); u.save(); print(u.id, u.is_pro())"
```

> **SECURITY:** that password is a committed default in
> `backend/scripts/seed_clips.py:84`, deliberately, so the script is runnable
> straight after this one-liner. It is only safe because the account lives in a
> local Postgres reachable solely through the dev nginx terminator, and every
> real credential for this stack lives in the gitignored `.env.local`. Do not
> reuse it anywhere. To use a different account, pass
> `SEED_USERNAME` / `SEED_PASSWORD` to the script.

The trailing `print(u.id, u.is_pro())` gives you the user id — you need it for
the feed refill in §7. Expect `True`.

### 2.4 Seed the audio

Runs on the **host**, not in a container, because the source library is a host
mount and the API is reachable over TLS from the host.

```bash
# 1. Validate the manifest and upload nothing.
python3 backend/scripts/seed_clips.py --dry-run

# 2. Upload + approve + block until ready, one clip at a time.
python3 backend/scripts/seed_clips.py

# 3. After a partial failure, retry only what is missing.
python3 backend/scripts/seed_clips.py --resume
```

Other flags: `--limit N`, `--media-dir PATH`, `--api URL`, `--timeout SECONDS`.

#### Why this script drives HTTP and not the ORM

This is the single most important thing it teaches, so it is worth stating
plainly. A management command that did `AudioClip.objects.create(...)` and
hand-set `hls_playlist_url` would be wrong twice over:

1. **It would skip the only enqueue trigger.** `POST /clips/{id}/approve-moderation/`
   is the sole caller of `trigger_hls_processing` (`backend/app/services/uploads.py:82`).
   A seeder that writes rows directly never runs the step whose absence is the
   documented trap, so it would be "working" against a state the pipeline never
   produces.
2. **It would make the pipeline unfalsifiable.** Every field the seeder writes
   would be written by the seeder, so a later failure in moderation, Whisper,
   KeyBERT, ffmpeg or the S3 upload would be invisible — you would be debugging
   a stub. "The feed works" is only evidence of something when every field in
   the row was written by the server that is supposed to write it.

Two further decisions in the script are load-bearing and should not be
"optimised away":

- **Exact filenames.** The manifest pins byte-exact names because the library
  contains near-duplicates where substring matching picks the wrong file —
  `NEFFEX - Fight Back [Official Video].mp3` and
  `NEFFEX - Make It (Official Video) Fight Back_ The Collection OUT NOW!.mp3`
  both contain `Fight Back`. `resolve_track` refuses to guess.
- **Strictly one clip in flight.** Upload → approve → block until
  `status == 'ready'` → *then* the next. The media worker runs
  `--concurrency=1` (see [§8.2](#82-why-the-media-worker-runs-at-concurrency-1)),
  so a batch would not run in parallel anyway — it would queue while every clip
  sat at `processing` and every poll became noise about a state that was never
  going to change.

### 2.5 Refill the feed and read it

```bash
docker compose -f docker-compose.local.yml --env-file .env.local exec web_local python manage.py shell -c "
from backend.app.tasks import refill_user_feed
print(refill_user_feed(<seeduser_id>))"
```

Then `GET /feed/` as that user. **Read the rest of this section before you
conclude it is empty** — [§7](#7-confirming-it-worked) explains why an empty
feed is the single most common false alarm here.

---

## 3. The 3-step model, and why step 2 is the one that gets missed

```
POST /clips/                          → 202 {message, clip_id, status:"processing"}
        │                                    clip saved, file in object storage
        │                                    NOTHING IS ENQUEUED HERE
        ▼
POST /clips/{id}/approve-moderation/  → 200 {status:"approved", ...}
        │                                    runs moderation, then enqueues
        ▼
process_audio_to_hls   (Celery, queue `heavy_media`)
        │
        ▼
                                   status → 'ready' | 'rejected' | 'failed'
```

### Step 1 — `POST /clips/`

Creates the row with `status='processing'` and `moderation_approved=False`, and
returns **202**. `create()` then calls `finalize_upload` — which **deliberately
does not enqueue anything**.

> **DECISION:** the docstring at `backend/app/services/uploads.py:21-34` states
> the reasoning. `process_audio_to_hls` opens with
>
> ```python
> if not clip.moderation_approved:
>     timer.set_outcome('skipped')
>     return
> ```
>
> and `finalize_upload`'s entire job is to *ensure* `moderation_approved` is
> False. Enqueueing here would dispatch a task that wakes up, reads the clip,
> sees the gate, and returns having done nothing — burning a worker slot and a
> `skipped` metric per upload. Adding a `process_audio_to_hls.delay()` call to
> `create()` is therefore a trap, not a fix.

### Step 2 — `POST /clips/{id}/approve-moderation/` — **the step that gets missed**

This is the only call to `trigger_hls_processing`:

```python
# backend/app/services/uploads.py:74-82
def trigger_hls_processing(clip: AudioClip) -> None:
    if not clip.moderation_approved:
        raise ValueError("Cannot trigger HLS processing for unapproved clip.")
    transaction.on_commit(lambda: publish(process_audio_to_hls, str(clip.id)))
```

The `ValueError` is a real guard, not decoration: calling it on an unapproved
clip raises rather than silently dispatching.

Responses:

| Outcome | Status | Body |
|---|---|---|
| Approved | **200** | `{status: "approved", message, clip_id, moderation_approved: true}` |
| Rejected | **400** | `{status: "rejected", message, reason, clip_id, moderation_approved: false}` |

**Skip this step and the clip sits at `processing` for ever.** It is not that
the encode is slow — no task was ever dispatched.

**What moderation actually checks at this point** (honest reading of
`services/content_moderation.py::run_moderation_check`): an audio fingerprint
against the known-bad set, `clip.tags` against the prohibited list, and
`clip.transcript_text`. At approve time `clip.tags` is still `[]` and there is
**no `transcript_text` column on `AudioClip` at all**, so the last two checks
read empty and cannot reject anything. In practice the fingerprint check is the
only live gate at this step — and the blocklist is currently empty, with
`check_fingerprint_blocklist` deliberately failing open on an unreadable
fingerprint so a MinIO blip cannot permanently reject a user's own upload.

> **HONEST LIMITATION:** the endpoint is owner-or-staff, so a user can upload,
> self-approve, and be published once the keyword checks in
> `process_audio_to_hls` (which do run, on the real transcript) pass. That is
> the accepted v1 state. It is a content policy decision (ISSUE-04), not a
> scoping bug; the scoping was fixed 2026-09-29 to stop *any* authenticated
> user approving *any* clip.

### Step 3 — `process_audio_to_hls`, queue `heavy_media`

Detailed in [§6](#6-what-processing-actually-does). Summary: normalise → librosa
→ Whisper → moderation → embed/KeyBERT → ffmpeg HLS → upload to `hls/<clip_id>/`
→ `status='ready'`.

---

## 4. Manual upload, step by step

Base URL for all examples: `https://localhost:18443` (API, self-signed TLS) and
`https://localhost:19443` (HLS edge). In `curl`, either `--cacert
docker/certs/localhost.crt` or `-k`.

### 4.1 Fields accepted by `POST /clips/`

From `AudioUploadSerializer` (`backend/app/serializers.py:125-186`):

| Field | Required | Type / values | Notes |
|---|---|---|---|
| `original_file` | yes | file | See the validation table in §5. |
| `title` | yes | string, max 255 | |
| `category` | no | string, max 50, **blank allowed** | **Free text — no `choices`.** See §8. |
| `copyright_acknowledgement` | **yes** | boolean | **The only `required=True` field.** In multipart, send the *string* `"true"`. |
| `license_type` | no | `Owned`, `CC0`, `CC-BY`, `CC-BY-SA`, `CC-BY-NC`, `Public_Domain`, `Unknown` | Defaults to `"Unknown"`, which logs `logger.warning("Upload with Unknown license type — audit trail required.")` at `serializers.py:189-191`. |
| `copyright_owner_name` | no | string, max 255, blank/null allowed | |
| `id`, `status` | — | — | `read_only_fields`. Sending them is ignored. |

Note what is **not** writable through this endpoint: `is_noncommercial` and
`requires_share_alike` are not in `Meta.fields`, so they stay at their `False`
model defaults for any upload. Only the (currently dead) scraper could set them.
See [§10.2](#102-why-nc-and-sa-clips-are-withheld).

### 4.2 curl

```bash
API=https://localhost:18443
CACERT=docker/certs/localhost.crt

# 1. Log in.
TOKEN=$(curl -sS --cacert "$CACERT" \
  -H 'Content-Type: application/json' \
  -d '{"username":"seeduser","password":"SeedLocal!2026"}' \
  "$API/auth/login/" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access"])')

# 2. Upload. Note: do NOT set Content-Type — curl derives the multipart
#    boundary itself, and forcing the header produces an unparseable body.
UPLOAD=$(curl -sS --cacert "$CACERT" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F 'title=Neffex - Fight Back' \
  -F 'category=instrumental' \
  -F 'license_type=Owned' \
  -F 'copyright_owner_name=Local dev fixture' \
  -F 'copyright_acknowledgement=true' \
  -F 'original_file=@/path/to/track.mp3' \
  "$API/clips/")
echo "$UPLOAD"
# {"message":"Audio uploading and processing in background.","clip_id":"…uuid…","status":"processing"}

CLIP_ID=$(printf '%s' "$UPLOAD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["clip_id"])')

# 3. Approve. THIS IS THE STEP THAT ENQUEUES THE ENCODE.
curl -sS --cacert "$CACERT" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$API/clips/$CLIP_ID/approve-moderation/"

# 4. Poll. This endpoint does NOT consume the upload budget (see §5.3).
watch -n5 "curl -sS --cacert $CACERT -H 'Authorization: Bearer $TOKEN' $API/clips/$CLIP_ID/ | python3 -m json.tool"
```

> **Gotcha:** `GET /clips/{id}/` is serialised by `AudioUploadSerializer`, whose
> `Meta.fields` does **not** include `hls_playlist_url`, `duration_ms` or
> `tags`. Those three live on `FeedClipSerializer`, which is what `GET /feed/`
> and `GET /suggestions/` use. If you need them per clip, read the row:
>
> ```bash
> docker compose -f docker-compose.local.yml --env-file .env.local exec web_local python manage.py shell -c "
> from backend.app.models import AudioClip
> c=AudioClip.objects.get(id='$CLIP_ID')
> print(c.status, c.hls_playlist_url, c.duration_ms, c.tags)"
> ```
>
> (`backend/scripts/seed_clips.py:396-401` prints those three from the
> retrieve response, so its `ready` line shows `None` for all of them. Cosmetic
> only — the status it prints is correct.)

### 4.3 Python

```python
#!/usr/bin/env python3
"""Upload one clip through the real API, and wait for HLS."""
import os
import sys
import time

import requests

API = os.environ.get("SEED_API_URL", "https://localhost:18443")
CACERT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "docker", "certs", "localhost.crt")

session = requests.Session()
session.verify = CACERT
session.headers["Accept"] = "application/json"

auth = session.post(f"{API}/auth/login/",
                    json={"username": "seeduser", "password": "SeedLocal!2026"},
                    timeout=30)
auth.raise_for_status()
headers = {"Authorization": f"Bearer {auth.json()['access']}"}

with open(sys.argv[1], "rb") as handle:
    resp = session.post(
        f"{API}/clips/",
        headers=headers,
        data={
            "title": "Neffex - Fight Back",
            "category": "instrumental",
            "license_type": "Owned",
            "copyright_owner_name": "Local dev fixture",
            # Booleans arrive as strings in multipart.
            "copyright_acknowledgement": "true",
        },
        # requests must derive the multipart boundary itself; setting
        # Content-Type by hand produces a body the server cannot parse.
        files={"original_file": (os.path.basename(sys.argv[1]), handle, "audio/mpeg")},
        timeout=600,
    )
resp.raise_for_status()
clip_id = resp.json()["clip_id"]
print("uploaded", clip_id, resp.json()["status"])

# The ONLY enqueue trigger. Without this the clip waits for ever.
approved = session.post(f"{API}/clips/{clip_id}/approve-moderation/",
                        headers=headers, timeout=120)
print("approve ->", approved.status_code, approved.json().get("status"))
if approved.status_code != 200:
    sys.exit(1)

while True:
    body = session.get(f"{API}/clips/{clip_id}/", headers=headers, timeout=30).json()
    status = body["status"]
    if status == "ready":
        print("ready", clip_id)
        break
    if status in ("failed", "rejected"):
        sys.exit(f"clip ended in status={status}")
    time.sleep(5)
```

---

## 5. Validation and limits

### 5.1 File validation, in the order it runs

`AudioUploadSerializer.validate_original_file` (`backend/app/serializers.py:213`).
Order matters because it is what makes the error message predictable: the
cheapest and least ambiguous check fires first, and the expensive whole-file
decode is last.

| # | Check | Failure message | Why it is here |
|---|---|---|---|
| 1 | `size > MAX_SIZE` (100 MB) | `File exceeds 100MB limit.` | Cheapest possible rejection. |
| 2 | Extension in `ALLOWED_EXT` = `{.mp3, .wav, .ogg, .flac, .m4a, .aac, .webm, .opus}` | `Unsupported file type: <ext>` | Catches typos and wrong files before any decode. |
| 3 | Pure-Python magic-byte sniff over the first 8 KB — `_has_blocked_magic_signature` | `File content does not match audio format. Detected: <type>` | **SECURITY:** an attacker renaming `evil.exe` to `evil.mp3` passes step 2. This blocks PE/EXE, ELF, shebang scripts, PDF, Java class / Mach-O, ZIP/RAR/7z/gzip, and BMP/GIF/PNG/JPEG. No system binary required, so it works on minimal images. |
| 4 | libmagic MIME, if `python-magic` is importable | `File content does not match audio format. Detected: <mime>` | Second-opinion layer for less common containers. `application/octet-stream` is exempt. If libmagic is missing, this is skipped with a logged warning and steps 2 + 5 carry the load. |
| 5 | pydub duration probe against `MAX_DURATION_SECONDS` (default **300**, `settings.py:408`, env-overridable) | `Audio duration (X.Xs) exceeds maximum allowed (300s).` | **SECURITY:** a 100 MB, 24-hour WAV would otherwise be accepted into storage, billed, and only then fail in the worker. |

> **HACK (documented in the source, `serializers.py`, `validate_original_file`):**
> step 5 reads the **whole upload into memory** because pydub needs a path or a
> `BytesIO`, and Django's `InMemoryUploadedFile` is not one. With `MAX_SIZE` at
> 100 MB and gunicorn threads, concurrent large uploads are a real memory
> consideration. There is a `TODO` to stream via a temp path if memory pressure
> becomes a problem.

> **Correction to a commonly-repeated claim.** `AudioUploadSerializer` declares
> an `ALLOWED_MIMES` frozenset (`serializers.py:137-142`) containing
> `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/x-wav`, `audio/wave`,
> `audio/x-vorbis+ogg`, `audio/ogg`, `audio/flac`, `audio/x-flac`, `audio/mp4`,
> `audio/aac`, `audio/x-m4a`, `audio/webm`, `audio/opus` — but **step 4 does not
> consult it.** The live check is
> `if mime and not mime.startswith('audio/') and mime != 'application/octet-stream'`
> (`serializers.py:245`), i.e. a *deny-if-not-audio* prefix test. `ALLOWED_MIMES`
> is currently dead. If you are reasoning about what step 4 will accept, reason
> about the prefix test, not the list.

After `validate_original_file`, `validate()` runs the copyright-acknowledgement
check, the `"Unknown"`-licence warning, and (free tier only) the per-file size
limit.

### 5.2 Tier limits

| Limit | Setting | Default | Enforced where | Failure |
|---|---|---|---|---|
| Daily uploads, free | `REVENUECAT_DAILY_UPLOAD_LIMIT_FREE` | **5/day** | `views/content.py:189` `create()`, **before** serializer validation | **`PermissionDenied` → HTTP 403**: `Free tier limit of 5 daily uploads reached. Upgrade to Pro for unlimited uploads.` |
| File size, free | `REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE` | **10 MB** | `AudioUploadSerializer._enforce_free_limits` (size only) | 400 on `original_file`: `Free tier upload limit is 10MB. Upgrade to Pro for unlimited uploads.` |
| File size, all tiers | `AudioUploadSerializer.MAX_SIZE` | 100 MB | step 1 above | 400: `File exceeds 100MB limit.` |
| Duration, all tiers | `MAX_DURATION_SECONDS` (`settings.py:408`) | 300 s | step 5 above | 400: `Audio duration (X.Xs) exceeds maximum allowed (300s).` |

Counting is `AudioClip.objects.filter(creator=user, created_at__date=today)`, so
it counts **rows created today**, including ones that later failed.

`User.is_pro()` (`models.py:66-79`) returns `True` when
`has_pro_entitlement and pro_expires_at > now`, **or** `pro_grace_until > now`.
Pro lifts the 5/day and 10 MB caps. The 100 MB and 300 s caps apply to
everyone — they bound compute and storage, not spend.

> **CRITICAL, and frequently misread: the 60-second free-tier clip cap is NOT
> server-enforced.** `REVENUECAT_CLIP_DURATION_LIMIT_FREE` (default 60) appears
> in exactly two places in the tree: its definition at `settings.py:901`, and
> `views/subscription.py:33`, which *reports* it to the client as
> `max_clip_duration_seconds`. Nothing validates against it. **The server will
> accept a 200-second clip from a free account** and the only bound that applies
> is the 300 s `MAX_DURATION_SECONDS`. The 60 s limit is a mobile-UI affordance
> — do not tell anyone the server rejects clips over 60 s, because it does not.

The asymmetry is worth internalising: the daily cap is a **403 with a different
status code and a different JSON shape** from every other limit, which is a 400.
If a client only handles 400s as "validation error", the daily cap reads as an
unexplained permission failure.

### 5.3 Throttle rates

`AudioUploadViewSet` routes each action to its own scope in
`views/content.py:121-159`. The keys are **DRF method names** (`self.action`),
not `url_path` — that distinction was a real bug, fixed 2026-09-29; see
`docs/EXPLAIN/decisions/2026-09-29-clip-throttle-scopes.md`.

| `self.action` | Route | Scope | Rate |
|---|---|---|---|
| `create` | `POST /clips/` | `upload` | 20/hour |
| `retrieve` | `GET /clips/{id}/` | `clip_read` | 120/min |
| `list` | `GET /clips/` | `clip_read` | 120/min |
| `approve_moderation` | `POST /clips/{id}/approve-moderation/` | `clip_approve` | 20/hour |
| `public_view` | `GET /clips/{id}/public/` | `clip_public` | 120/min |
| `play_shared` | `POST /clips/{id}/play/` | `clip_play` | 60/min |
| `share_link` | `POST /clips/{id}/share-link/` | `share_link` | 60/hour |
| `report_clip` | `POST /clips/{id}/report/` | `clip_report` | 20/hour |
| `update` / `partial_update` / `destroy` | | `upload` | 20/hour |

So one user gets **20 uploads/hour AND 20 approvals/hour**. Bulk-seeding more
than 20 in an hour returns 429, and that is by design: `approve-moderation` is
the step that starts an ffmpeg encode, so it is compute and gets the tight cap.

Polling `GET /clips/{id}/` is on `clip_read` (120/min) — a deliberately separate
bucket — so watching an encode does **not** consume the upload budget. Before
the 2026-09-29 fix it did, which made a 20-clip seed arithmetically impossible.

> **Watch out:** `ScopedRateThrottle` treats a **missing** `throttle_scope` as
> "allow everything" — no error, no rate limit. Any new `ScopedRateThrottle`
> view must declare its scope or it is silently unthrottled.

### 5.4 Authentication and authorisation

- `Authorization: Bearer <access JWT>` from `POST /auth/login/`. Access tokens
  live 15 minutes; refresh via `POST /auth/token/refresh/`.
- `approve-moderation` is **owner-or-staff**. A non-staff user asking for
  someone else's clip gets **404, not 403** — a 403 would confirm the UUID
  exists, and the UUID is the only identifier. The lookup goes through the
  creator-scoped `get_queryset()`.
- Auth failures (401) and the owner check (404) are separate failure modes. A
  404 on approve usually means "wrong account", not "clip deleted".

---

## 6. What processing actually does

`process_audio_to_hls`, Celery, queue **`heavy_media`**
(`CELERY_TASK_ROUTES` in `backend/EchoFlow/settings.py`). Wrapped in
`metrics.time_hls_processing()`, which records the outcome as `success`,
`terminal_error`, `skipped`, or `moderation_rejected`.

In order:

1. **Gate.** `if not clip.moderation_approved: return` — the step-2 dependency
   again, this time as a runtime guard. Records outcome `skipped` and leaves
   `status` at `processing`.
2. **Fetch to local scratch.** `original_file.open('rb')` is streamed to a
   `tempfile.mkstemp` copy. **S3/MinIO has no local path**, so every step below
   needs a real file. "Pull remote bytes to a local scratch file, process, clean
   up" is the only pattern in this task — no code path assumes a shared
   filesystem.
3. **Normalise.** `normalize_to_wav()` → mono 22050 Hz WAV. The original upload
   is deleted; the normalised path is what everything downstream reads.
4. **librosa** → `acoustic_vector` (128-dim = 40 MFCC + 12 chroma + 76 mel) and
   `duration_ms` (from `librosa.get_duration`, not the container header).
5. **faster-whisper `base`, int8, `beam_size=5`** → transcript.
6. **Branch on vocals:**
   - **Has speech** — sentence-transformers `all-MiniLM-L6-v2` →
     `semantic_vector` (384-dim), then KeyBERT → top 3 unigrams → `tags`.
   - **No speech (instrumental)** — the documented fallback
     (`tasks.py:293-296`): `semantic_vector = [0.0] * 384` and
     `tags = ["instrumental"]`.
7. **Moderation on the real values.** `check_transcript_for_prohibited_content(transcript)`
   and `check_tags_for_prohibited_content(tags)`. Either failing sets
   `moderation_approved = False`, `status = 'rejected'`, and returns. This is
   the check that can actually reject — the earlier one at approve time reads a
   column that does not exist.
8. **ffmpeg HLS encode** into a local scratch dir:
   ```
   ffmpeg -y -i <normalised.wav> -c:a aac -ar 44100 -ac 2 -b:a 128k
          -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type mpegts
          -master_pl_name master.m3u8 <scratch>/index.m3u8
   ```
   `-hls_segment_type mpegts` is explicit because newer ffmpeg defaults to fMP4,
   which Chrome's MSE decoder rejects for certain AAC configurations.
9. **Upload** every generated file to `hls/<clip_id>/` in object storage.
10. **Write the key and the status:**
    ```python
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.status = 'ready'
    ```

> **SECURITY / DECISION: `hls_playlist_url` stores an object *key*, not a
> URL.** A presigned S3 URL expires (`AWS_S3_QUERYSTRING_EXPIRE`); baking one
> into the database would mean playback silently breaking an hour after
> processing, regardless of whether the clip is still valid. A fresh
> browser-playable URL is derived on every read by
> `FeedClipSerializer.get_hls_playlist_url` → `media_urls.get_hls_playback_url`.
> **Never persist a signed URL.**

### Status values

| `status` | Meaning | How you get there |
|---|---|---|
| `processing` | Row exists, no encode has finished | Default from creation. Also what a missing step-2 leaves behind. |
| `ready` | HLS produced and uploaded | Normal completion of step 3. |
| `rejected` | Moderation refused it | Keyword match on the transcript or tags. Terminal. |
| `failed` | Terminal processing error | ffmpeg encode error, missing/corrupt original, librosa decode failure, AI inference error. Terminal — Celery will not retry. |

Transient failures (S3/OS network errors, `librosa.load` `OSError`,
`ConnectionError` during model load) are **re-raised** so the autoretry policy
picks them up. That is why `failed` and a still-`processing` clip mean different
things.

---

## 7. Confirming it worked

### 7.1 Status

```bash
GET /clips/{id}/    →  {id, title, category, original_file, status, license_type, ...}
```

Poll until `status == 'ready'`. Throttle bucket is `clip_read`, 120/min, so a
2-second poll during a Whisper-base + ffmpeg encode is fine.

### 7.2 Feed — and why it is probably empty

```bash
curl -sS --cacert docker/certs/localhost.crt \
  -H "Authorization: Bearer $TOKEN" https://localhost:18443/feed/
```

**`GET /feed/` is a destructive `lpop(redis_key, 10)`.** Every call *consumes*
up to 10 ids off the user's Redis queue. Re-requesting a page you already got
does not bring it back — it brings you the *next* ten, or nothing. If you were
polling to "refresh" and the feed went empty, you did that to yourself. Buffer
client-side; never re-request.

Refill before reading:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local exec web_local python manage.py shell -c "
from backend.app.tasks import refill_user_feed
print(refill_user_feed(<seeduser_id>))"
```

`refill_user_feed` (queue `fast_feed`, implemented in
`ai_ml/pipelines/feed_tasks.py:63`) is idempotent for its dedup set and takes a
30 s `SETNX` lock per user, so calling it twice concurrently is safe.

Two responses to know:

| Status | Body | Meaning |
|---|---|---|
| **200** | `{results, next: "auto_trigger", queue_health}` | Normal. `queue_health` is the remaining Redis depth. |
| **202** | `{results: [], retry_after_ms: 1500, degraded: true}` | Cold queue. **Honour `retry_after_ms`; do not invent your own backoff.** A second `lpop` fires in the same request thread before the async refill has run, so an immediate retry would also see an empty queue. |
| **200** | `{…, degraded: true, queue_health: 0}` | Redis is unreachable. A trending fallback (top 20 by `engagement_velocity`) is served instead of a 500. |

The feed serves only `moderation_approved=True`, `is_noncommercial=False`,
`requires_share_alike=False`. `FeedClipSerializer` returns `hls_playlist_url`
(as a full edge URL), `duration_ms`, `tags`, plus `likes`, `shares`, `skips`,
`comment_count`, `is_liked`, `creator_name`, `creator_id`, `cover_image`.

> **HACK (in the source, `views/feed.py:93`):** the 202-on-cold-queue response
> exists because the old code returned `"You've caught up!"` on a second
> same-thread `lpop`, which told the user the feed was empty when it was about
> to be populated. Treat 202 as "ask again shortly", never as "no results".

### 7.3 Playback

`hls_playlist_url` from the feed is already browser-playable and already points
at the edge (`HLS_URL_STYLE=edge` → `https://localhost:19443/hls/<id>/master.m3u8`,
bucket-less). **Use it verbatim. Never rebuild it and never prefix the API base
onto it** — the HLS origin is a different host and port from the API, and both
existing frontends got this wrong at least once.

Mint the credential:

```bash
curl -sS --cacert docker/certs/localhost.crt -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://localhost:18443/media/playback-token/$CLIP_ID/
```

**POST, not GET.** A GET returns 405 with an explanatory message. Issuing a
credential must not be a safe, prefetchable, cacheable method.

| Status | Meaning | Client action |
|---|---|---|
| **200** | Token issued. Body `{"status":"ok"}`, plus `"token"` if `X-EchoFlow-Client: native`. The `ef_hls_token` cookie is **always** set. | Web: nothing to do; the browser attaches the cookie to `/hls/*`. Native: read `token` from the body. |
| **409** | `Clip media is not ready.` | HLS not produced yet. Poll the status. |
| **403** | `Content not available.` (unmoderated) **or** `Clip not available.` (licence-restricted) | Treat as one indistinguishable tombstone — see §10.3. |
| **404** | `Clip not found.` | Gone. |

**Web:** do not read the token from the body — the cookie is `HttpOnly` by
design. If you are calling this with `fetch()`, you **must** pass
`credentials: 'include'` or the browser silently discards the `Set-Cookie`.

**Native (React Native / Expo):** send `X-EchoFlow-Client: native` and pass the
returned `token` as the **`X-EchoFlow-Media-Token`** request header. Native
players cannot use the cookie at all: `AVPlayer` does not read
`NSHTTPCookieStorage`, ExoPlayer's `DefaultHttpDataSource` sends no `Cookie`
header, and the cookie is `HttpOnly`+`Secure` so the app cannot read it back to
attach it itself. Attach it as the player's per-source headers —
`expo-audio` applies them to the manifest *and* every segment. Cookie takes
precedence at the edge when both are present.

> **Testing the header transport:** `playback-token` sets the cookie with
> `path=/hls/`, so a `requests.Session` that has *ever* minted a token will
> attach it to subsequent `/hls/*` requests. A "no credential" probe then
> returns 200/206 rather than 403 — that is the cookie working, not a bypass.
> `session.cookies.clear()` first, or use a fresh session.

---

## 8. Category vocabulary, and other operational notes

### 8.1 Category is free text, and matching is byte-exact

`AudioClip.category` is `CharField(max_length=50, blank=True)` with **no
`choices`** (`models.py:112`). The backend accepts any string.

`GET /suggestions/?category=X` filters on **exact string equality**
(`views/feed.py:163`). A near-miss — `Lo-Fi` vs `Lo-Fi Beats`, or any
differing case — produces a **silently empty result set, not a 400**. There is
no error to notice. The field is not normalised anywhere.

The mobile app's single source of truth is
`mobile/src/design/categories.ts`. It brands 5 values:

| Value | Label |
|---|---|
| `instrumental` | Instrumental |
| `funny` | Funny |
| `news` | News |
| `science` | Science |
| `music` | Music |

It also enumerates 6 legacy values already present in the database from the old
app (`Field Recordings`, `Ambient & Drone`, `Synthesizer`, `Cyberpunk`,
`Lo-Fi Beats`, `Speech & Poetry`), which are coloured neutrally.

**Recommendation: reuse those 5 branded values for new uploads.** They are the
only ones the picker, the filter pills and the colour lookup agree on, which is
precisely the class of disagreement that produces the silent empty result.
`backend/scripts/seed_clips.py` uses only the 3 that honestly describe its
library (`music`, `instrumental`, `funny`) and deliberately leaves `news` and
`science` empty rather than mislabelling anything.

> Note: the clip's `tags` field is **not** this value. `tags` is derived by
> KeyBERT from the Whisper transcript inside `process_audio_to_hls`, and will
> not agree with `category`. That is expected, not a bug.

### 8.2 Why the media worker runs at concurrency 1

`docker-compose.local.yml` sets `-Q heavy_media --pool=prefork
--concurrency=1`. With prefork, **each child loads its own copy** of Whisper
`base` int8 (~75 MB), `all-MiniLM-L6-v2` (~90 MB) and KeyBERT's default MiniLM
(~90 MB), then holds an ffmpeg subprocess and a decoded librosa array for the
whole track. Two children × that working set exceeds the service's 2 GB cgroup
limit on a 12 GB host that is also running a desktop. One child halves the peak
and still saturates a queue this size.

This is also why `seed_clips.py` uploads one clip at a time (see §2.4).

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Clip stuck at `status='processing'`, forever | **Step 2 was skipped.** `POST /clips/` enqueues nothing; `finalize_upload` deliberately does not. No task was ever dispatched. | `POST /clips/{id}/approve-moderation/`. If it returns 200 and the status does not move, it is a worker problem — see the next row. |
| `approve-moderation` 404 | Clip belongs to a different user (or you are not staff). The lookup is creator-scoped, and returns 404 rather than 403 so a UUID is not confirmed to exist. | Approve with the uploader's token, or `is_staff=True`. |
| **403** `Free tier limit of 5 daily uploads reached.` | `REVENUECAT_DAILY_UPLOAD_LIMIT_FREE`; counts `AudioClip` rows created today by this user. Raised from `create()` **before** validation, so no file work is done. Note it is a 403, not a 400. | Grant Pro (see §2.3), or upload after midnight, or raise the env var. |
| **400** `Free tier upload limit is 10MB.` | `REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE`, free tier only, size only. | Pro, or compress. |
| **400** `File exceeds 100MB limit.` | `MAX_SIZE`, all tiers. | Compress. Note WAV is the usual culprit — 5 min stereo 44.1 kHz PCM is ~50 MB. |
| **400** `Audio duration (X.Xs) exceeds maximum allowed (300s).` | `MAX_DURATION_SECONDS`, all tiers, enforced by a pydub probe at upload time. | Trim the file. Raising the env var raises it for everyone. |
| **400** `Unsupported file type: <ext>` / `File content does not match audio format. Detected: <type>` | Extension not in `ALLOWED_EXT`, or the magic-byte / libmagic layer recognised a non-audio container. | Use one of the 8 allowed extensions **and** genuine audio bytes. A renamed `.exe` is rejected by design. |
| **429** on `approve-moderation` during a bulk seed | `clip_approve` is 20/hour, and it is the *second* 20/hour bucket (uploads are the first). 12 clips is fine; 25 is not. | By design — approval starts an ffmpeg encode. Seed in batches under 20/hour, or temporarily raise `clip_approve`. |
| `status='rejected'` | A keyword matched the Whisper transcript or the KeyBERT tags, inside the worker. Not the approve-time check. | `docker compose -f docker-compose.local.yml --env-file .env.local logs celery_media_local` and read the `Moderation rejected clip …` line for the reason. |
| `status='failed'` | Terminal: ffmpeg encode error, missing original, undecodable audio, or an AI-inference error. Celery will not retry. | Worker logs carry the exception. `failed` is terminal by design; re-upload. A genuinely *transient* S3/network error would be retried, not `failed`. |
| `ModuleNotFoundError` in a worker that passes under pytest | **The workers run a baked image with no `/app` bind mount.** `celery_media_local`, `celery_feed_local` and `celery_beat_local` do **not** bind-mount the repo; only `web_local` and `celery_local` do. A `backend/` source edit is invisible to them until `docker build`, or `docker cp` **plus a restart** (the prefork parent holds the old bytecode — copying a file into a running worker changes nothing). | `docker compose -f docker-compose.local.yml --env-file .env.local build celery_media_local` then `up -d celery_media_local`. Check with `docker inspect <svc> --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' \| grep /app`. |
| Tasks are enqueued but never run | Either the media worker is not consuming `heavy_media`, or **an orphan container from another compose project is stealing the queue.** | `docker ps -a \| grep -v <your project>` — an `echoflow_revnuecat-prod-celery_media-1` has previously been up for a day on `-Q heavy_media` against the same broker, silently taking every task. Also check the broker: a stale `REDIS_BROKER_URL` in `.env.local` can beat compose's `REDIS_BROKER_HOST` and publish to the other project's broker. |
| `GET /feed/` returns nothing | **Most likely you consumed it.** `GET /feed/` is a destructive `lpop` of up to 10 ids; every call drains the queue. Also possible: cold queue (expect 202 + `retry_after_ms`), or nothing approved yet. | Re-run `refill_user_feed(user_id)`. Buffer pages client-side; never re-request. |
| Playback token returns 409 | `hls_playlist_url` is empty — HLS not produced (or pruned by `cleanup_orphan_hls`). | Poll status until `ready`. |
| Playback token returns 403 for a clip you just approved | Either `moderation_approved` is False, or the clip is licence-restricted **and you are not the owner** (`resolve_clip_access` exempts the owner and anyone it was shared with). | Check `is_noncommercial` / `requires_share_alike` on the row. |
| HLS requests 403 at the edge with a valid-looking token | `MEDIA_TOKEN_SECRET` has drifted between Django and the Worker. | Restart the local Worker via `scripts/run-hls-worker-local.sh` — it regenerates the Worker's `.dev.vars` from `.env.local` on every run so the two cannot drift. |
| You want to *scrape* audio instead of uploading it | **`scrape_audio` and the `scrape_and_import` Celery task are dead at import time.** Both import `normalize_license`, `license_features`, `license_allows_commercial` and `is_share_alike_license` from `ai_ml.scrapers.base`, which no longer defines them (0 definitions anywhere in the tree — removed in `5c9c2d6 "removed scraper"`). `scrape_audio.py` additionally calls `downloader.download_with_retries`, `uploader.save_clip_segments` and catches `downloader.DownloadError`, none of which exist. | **Do not use the scraper as a way to get audio.** Upload files (this document) or seed them (§2). The **A3 licensing gate is unaffected** — `views/feed.py` and `services/entitlements.py::is_license_restricted` read the DB columns `is_noncommercial` / `requires_share_alike`, not the missing helpers. Only the scraper's ability to *classify* a licence is gone. Restoring the helpers or finishing the removal is a product decision that has not been made. |

---

## 10. Security notes

### 10.1 Why the copyright acknowledgement is the only required field

`copyright_acknowledgement` is the sole `required=True` field, and it is
required for a regulatory reason, not a UX one: **ISSUE-05 / Copyright Act 1957
/ IT Rules 2021**. The uploader must explicitly confirm they have the right to
submit the audio and that it infringes no third-party rights.

It is a `BooleanField`, and in `multipart/form-data` everything is a string — so
submit `"true"`, not `true` and not `"True"`. A missing or falsy value returns
400 with the full acknowledgement text as the message.

`license_type` is **not** required and defaults to `"Unknown"`, which logs
`logger.warning("Upload with Unknown license type — audit trail required.")`
(`serializers.py:189-191`). That is the hook for the audit trail: a submission
without a stated licence is a submission an operator has to look at. The seed
script deliberately sends `Owned` to avoid tripping it — and that is a dev-fixture
value chosen to silence a log line, **not** a licensing assertion.

### 10.2 Why NC and SA clips are withheld

`AudioClip` carries two boolean columns, `is_noncommercial` and
`requires_share_alike`, deliberately as booleans rather than a licence-policy
table so feed queries can filter with index-friendly predicates
(`models.py:125-130`, with composite indexes on each).

Every read path excludes both: `views/feed.py:111-115` (primary feed) and
`views/feed.py:168` (suggestions) both apply
`.filter(is_noncommercial=False, requires_share_alike=False)`, and
`services/entitlements.py::resolve_clip_access` denies playback tokens for
restricted clips.

That second check is recent history worth knowing: `PlaybackTokenView`
previously authorised on `moderation_approved` alone, so **any logged-in user
could mint a token for an NC/SA clip the feed never serves** — a licensing
bypass, closed 2026-09-29. The resolution order is: `moderation_approved` gates
everyone; then the **owner** and anyone the clip was **shared with** are exempt
(NC/SA restrict redistribution — the uploader must still be able to hear what
they uploaded, and sharing to a named recipient is a deliberate act); then the
licence restriction gates everyone else.

For uploads specifically, these two columns are **not writable through
`POST /clips/`** — they are absent from `AudioUploadSerializer.Meta.fields` — so
every uploaded clip stays at the `False` defaults. Only the (dead) scraper
could set them.

### 10.3 Why 403s must be collapsed in the UI

`PlaybackTokenView` returns 403 with two different messages —
`Content not available.` for unmoderated and `Clip not available.` for
licence-restricted. **A client must render both as the same tombstone.**
Distinguishing them tells an unauthorised caller something they could not
otherwise learn: whether a given clip is under moderation, or carries an NC/SA
licence. That is a moderation-state oracle, and the codebase applies the same
principle elsewhere — `approve-moderation` returns 404 rather than 403 for
someone else's clip, `public_view` filters in the queryset rather than raising,
and `play_shared` returns one message for both an invalid token and a
valid-but-wrong-scope token.

The server log records the distinction (`logger.warning("playback token denied:
… reason=…")`) for operators. The client must not.

### 10.4 Never store a signed URL

Covered in §6, restated because it is the mistake most likely to be reintroduced:
`hls_playlist_url` holds `hls/<clip_id>/master.m3u8` — an object *key*. Derive a
browser URL on every read via `get_hls_playback_url`. A presigned URL in the
database has a hard expiry, so playback would break on a fixed timer regardless
of whether the clip is still valid, and re-signing would require a write on a
read path. Original uploads under `uploads/` are the genuinely private objects;
those *are* signed per read, by `get_signed_media_url`.

### 10.5 Uploads are stored before moderation

An unmoderated upload is in object storage from the moment `POST /clips/`
returns. It is never rendered to users because every read path filters on
`moderation_approved`, but it is stored, and it consumes storage. This is a
documented v1 trade-off (see `finalize_upload`), not an oversight.

---

## 11. Related docs

| Document | What it covers that this one does not |
|---|---|
| `backend/scripts/seed_clips.py` | The recommended seeding path. Its module docstring carries the "why HTTP, not the ORM" rationale in full. |
| `docs/EXPLAIN/decisions/2026-09-29-clip-throttle-scopes.md` | The throttle-scope bug and why `self.action` keys on method names, not `url_path`. |
| `docs/EXPLAIN/storage/04-hls-token-protection.md` | The token design, both transports, and why signed URLs cannot work for HLS (RFC 3986 §5.2.2). |
| `docs/EXPLAIN/storage/05-local-hls-worker-runbook.md` | Running the validating edge locally and keeping `MEDIA_TOKEN_SECRET` in sync. |
| `docs/EXPLAIN/media/01-pipeline-overview.md` | The processing pipeline diagram, ffmpeg flags, normalisation. **Caveat:** its diagram is stale in two places — it shows a `transaction.on_commit()` in `create()` (there is none; see §3) and a "Save: transcript_text" step (there is no such column; the transcript is a local variable, which is exactly why the approve-time transcript check cannot fire). Read it for the shape; read §3 and §6 for the truth. |
| `docs/EXPLAIN/media/02-ffmpeg-hls.md` | HLS encoding in detail. |
| `docs/EXPLAIN/docker/05-https-tls-termination.md` | Why the API is on `:18443` and the HLS edge on `:19443`. |
| `AGENTS.md` | Stack start/stop, env vars, test commands, session learnings. |
