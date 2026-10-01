# Running the HLS Token Worker Locally

**Companion to** [`04-hls-token-protection.md`](04-hls-token-protection.md) (the
design) and [`../decisions/2026-09-28-local-hls-worker.md`](../decisions/2026-09-28-local-hls-worker.md)
(why the local stack looks the way it does).

The Worker validates the playback token on every `/hls/*` request and only
then fetches from object storage. In production that storage is R2 via a
binding. Locally it is MinIO over signed HTTP.

The token arrives two ways: as the `ef_hls_token` cookie (browsers) or as the
`X-EchoFlow-Media-Token` header (native players, which have no cookie jar to
share with their HTTP client). Same HMAC string either way; the edge reads
the cookie first. See
[`../decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md`](../decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md).

---

## The one thing that will waste your time

**Run the local stack with `--env-file .env.local`.**

```bash
docker compose -f docker-compose.local.yml --env-file .env.local up -d
```

Without it, compose interpolates from `.env`, whose `DB_PASSWORD` differs
from the one the Postgres volume was initialised with, and every service
fails `password authentication failed for user "echoflow"`.

Do not run plain `docker compose up`, and do not combine
`docker-compose.local.yml` with `.vps.yml` / `.laptop.yml` unless you mean
to: the combined project name is shared, so a mismatched invocation will
rebuild the network and orphan 13 running containers.

---

## Start order

```bash
# 1. Stack (db, minio, web, celery, nginx, ...)
docker compose -f docker-compose.local.yml --env-file .env.local up -d

# 2. Worker (separate terminal — it is a host process, not a compose service)
./scripts/run-hls-worker-local.sh
#    or: cd workers/hls-token-worker && npm run dev
```

Step 2 renders `workers/hls-token-worker/.dev.vars` from `.env.local` and
then execs `wrangler dev --ip 0.0.0.0 --port 8787`. It does both on every
run, which matters: wrangler does **not** hot-reload `.dev.vars` (it
watches source files, not var files), so a hand-edit has no effect until the
process restarts.

### Why 0.0.0.0 and not 127.0.0.1

The nginx container reaches the Worker over the Docker bridge, which cannot
see the host's loopback interface. nginx resolves the host via
`host.docker.internal`, which `docker-compose.local.yml` provides with
`extra_hosts: ["host.docker.internal:host-gateway"]`. Without it nginx fails
to start with `host not found in upstream`.

The consequence is that the Worker is reachable from anything that can route
to this machine's LAN address while it runs. It holds no HLS data itself and
refuses unauthenticated requests, so what is exposed is a validating proxy.
Do not leave it running on a shared network.

---

## Before you trust a manual verification

Two things will make a correct change look broken. Both bit during the
2026-09-28 native-transport work.

### 1. Restart the web service after changing Django code

The source tree is bind-mounted (`/home/devansh/Code/EchoFlow` → `/app`), so
a file edit is visible on disk **immediately** — but gunicorn imported the
module when it started and will not re-read it. Editing a view, a serializer
or `settings.py` and then curling the running stack exercises the **old**
code.

The symptom is maddeningly convincing: the unit tests pass (pytest imports
fresh), `grep` inside the container shows the new code, and the live endpoint
still returns the old shape.

```bash
docker compose -f docker-compose.local.yml --env-file .env.local restart web_local
# wait for health, then verify
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:18443/health/
```

Rule of thumb: **if a change touches Python, restart `web_local` before
trusting any curl against it.** The Worker does not have this problem —
`wrangler dev` watches source files and reloads.

### 2. A stale Redis connection returns 500, not 503

`django-redis` raised `ConnectionInterrupted: Redis ConnectionError: Error 32
while writing to socket. Broken pipe.` out of the **throttle** check, so
`POST /auth/login/` returned a 500 with a Django debug page instead of a 503.
It is transient — a pooled connection invalidated by something else (a
`FLUSHALL` from another client, for instance) — and clears on retry.

Do not read this as an application bug. Re-run the request before
investigating; if it persists, check `redis_cache_local` with
`redis-cli ... ping` and restart the service.

---

## Configuration

`workers/hls-token-worker/.dev.vars` is **generated** from `.env.local` and
is gitignored. The committed template is `.dev.vars.example`.

| Var | Source | Notes |
|---|---|---|
| `MEDIA_TOKEN_SECRET` | `.env.local` | **Must match Django.** If they differ every token 403s and nothing says so. |
| `MEDIA_S3_ENDPOINT` | script default `http://127.0.0.1:19000` | Host-published MinIO port, because the Worker is in the host netns. The in-network `minio-local:9000` does not resolve for it. |
| `MEDIA_S3_BUCKET` | `.env.local` `AWS_STORAGE_BUCKET_NAME` | |
| `MEDIA_S3_REGION` | `.env.local` `AWS_S3_REGION_NAME` | |
| `MEDIA_S3_ACCESS_KEY_ID` | `.env.local` `AWS_ACCESS_KEY_ID` | |
| `MEDIA_S3_SECRET_ACCESS_KEY` | `.env.local` `AWS_SECRET_ACCESS_KEY` | |

Setting `MEDIA_S3_ENDPOINT` is what selects the S3 backend over the R2
binding. In production it is absent and the binding is used.

### Fail-loud behaviour

| Situation | Response |
|---|---|
| `MEDIA_TOKEN_SECRET` unset | `/healthz` → **503** with the fix in the message; `/hls/*` → **503** |
| Storage backend unconfigured | `/healthz` → **503** naming the missing var |
| Token valid but MinIO unreachable | **502**, never 403 |
| Token valid, object absent | **404** |

The 503-instead-of-403 case matters most: unset, WebCrypto would sign with an
*empty* HMAC key and every request would 403, which is indistinguishable
from a Django-side token bug. Always check `/healthz` first.

---

## Verification sequence

Ordered so each step has exactly one possible cause. Note the health route
is `/healthz` — there is no `/health`, and every non-`/hls/` path 404s.

```bash
CLIP=<clip-uuid>
```

### 1. Worker is up and knows which backend it uses

```bash
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","backend":"s3"}
```

### 2. It gates, rather than passing through

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8787/hls/$CLIP/master.m3u8                        # 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Cookie: ef_hls_token=garbage' \
  http://127.0.0.1:8787/hls/$CLIP/master.m3u8                        # 403
```

### 3. A valid token reaches storage and returns real content

```bash
TOKEN=$(docker compose -f docker-compose.local.yml --env-file .env.local \
  exec -T web_local python -c "
import django, os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','backend.EchoFlow.settings'); django.setup()
from backend.app.services.hls_token import generate_playback_token
print(generate_playback_token(user_id=1, clip_key='hls/$CLIP'))")

curl -s -H "Cookie: ef_hls_token=$TOKEN" \
  http://127.0.0.1:8787/hls/$CLIP/master.m3u8
# #EXTM3U
```

Requires an object at `hls/<clip>/master.m3u8`. The media worker is
frequently down locally (2 GB limit against 12 GB of host RAM), so seed one
rather than waiting for `process_audio_to_hls`:

```bash
docker exec echoflow_minio_local sh -c \
  "mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD &&
   printf '#EXTM3U\n#EXT-X-VERSION:3\n' > /tmp/m.m3u8 &&
   mc cp /tmp/m.m3u8 local/echoflow-media/hls/$CLIP/master.m3u8"
```

### 4. Range requests survive (seeking, ABR)

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  -H "Cookie: ef_hls_token=$TOKEN" -H 'Range: bytes=0-4' \
  http://127.0.0.1:8787/hls/$CLIP/master.m3u8
# 206 5
```

### 5. Clip-scope isolation

A token for clip A must not open clip B:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Cookie: ef_hls_token=$TOKEN" \
  http://127.0.0.1:8787/hls/<a-different-uuid>/master.m3u8           # 403
```

### 6. Through nginx :19443

```bash
curl -sk -o /dev/null -w '%{http_code}\n' \
  https://localhost:19443/hls/$CLIP/master.m3u8                      # 403
curl -sk -o /dev/null -w '%{http_code}\n' \
  -H "Cookie: ef_hls_token=$TOKEN" \
  https://localhost:19443/hls/$CLIP/master.m3u8                      # 200
```

### 7. Storage is still private

The Worker must be the only way in:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:19000/echoflow-media/hls/$CLIP/master.m3u8        # 403
```

### 8. Full issuance flow, browser-equivalent

Needs an `AudioClip` with `moderation_approved=True`, `status='ready'` and
a populated `hls_playlist_url`. Routes are at the **root**, not under
`/api/v1/`:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local \
  exec -T web_local python -c "
import django, os, uuid
os.environ.setdefault('DJANGO_SETTINGS_MODULE','backend.EchoFlow.settings'); django.setup()
from backend.app.models import User, AudioClip
CLIP = uuid.UUID('$CLIP')
u, _ = User.objects.get_or_create(username='hls_probe',
                                  defaults={'email': 'hls_probe@example.com'})
c, _ = AudioClip.objects.get_or_create(id=CLIP, defaults={'creator': u, 'title': 'probe'})
c.creator, c.title = u, 'probe'
c.moderation_approved, c.status = True, 'ready'
c.hls_playlist_url = 'hls/%s/master.m3u8' % CLIP
c.save()"

JWT=$(curl -sk -X POST https://localhost:18443/auth/login/ \
  -H 'Content-Type: application/json' \
  -d '{"username":"hls_probe","password":"pw"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access"])')

curl -sk -c /tmp/jar -D /tmp/hdr -H "Authorization: Bearer $JWT" \
  "https://localhost:18443/media/playback-token/$CLIP/"
grep -i '^set-cookie' /tmp/hdr
# ef_hls_token=...; HttpOnly; Max-Age=600; Path=/hls/; SameSite=Lax; Secure

curl -sk -o /dev/null -w '%{http_code}\n' -b /tmp/jar \
  https://localhost:19443/hls/$CLIP/master.m3u8                      # 200
```

The cookie works across ports because cookies are host-scoped and ignore
ports — both origins are `localhost`. In production they are different hosts
(`api.` issuing for `media.`), which is why `MEDIA_TOKEN_COOKIE_DOMAIN` must
be set to the shared parent domain there.

### 8b. Verify the native header transport

The cookie path cannot be exercised from a phone or a native player, so check
the header path explicitly. Ask for the token as a native client, then send it
back as a header:

```bash
curl -sk -H "Authorization: Bearer $JWT" \
  -H 'X-EchoFlow-Client: native' \
  "https://localhost:18443/media/playback-token/$CLIP/" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' > /tmp/tok
# Without the X-EchoFlow-Client header the body is {"status": "ok"} and this
# raises KeyError — that is the opt-in working, not a bug.

curl -sk -o /dev/null -w '%{http_code}\n' \
  -H "X-EchoFlow-Media-Token: $(cat /tmp/tok)" \
  https://localhost:19443/hls/$CLIP/master.m3u8                      # 200
```

Sanity checks on the gate:

```bash
# no credential at all                                            -> 403
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:19443/hls/$CLIP/master.m3u8
# a valid token for a DIFFERENT clip's path                        -> 403
curl -sk -o /dev/null -w '%{http_code}\n' -H "X-EchoFlow-Media-Token: $(cat /tmp/tok)" \
  https://localhost:19443/hls/00000000-0000-0000-0000-0000000000ff/master.m3u8
# a token in the header does not override a bad cookie in the jar   -> 403
curl -sk -o /dev/null -w '%{http_code}\n' -b /tmp/jar \
  -H "X-EchoFlow-Media-Token: $(cat /tmp/tok)" \
  https://localhost:19443/hls/$CLIP/master.m3u8
```

### 9. Feed serializer emits the edge URL

```bash
docker compose -f docker-compose.local.yml --env-file .env.local \
  exec -T web_local python -c "
import django, os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','backend.EchoFlow.settings'); django.setup()
from django.conf import settings
from backend.app.media_urls import get_hls_playback_url
print('style:', settings.HLS_URL_STYLE)
print(get_hls_playback_url('hls/$CLIP/master.m3u8'))"
# edge   -> https://localhost:19443/hls/<clip>/master.m3u8   (no bucket)
# bucket -> http://localhost:19000/echoflow-media/hls/...   (with bucket)
```

### 10. Browser (hls.js), optional

Serve the frontend and play a clip. The page origin (`http://localhost:5173`)
is already in the Worker's `ALLOWED_ORIGINS`, and credentialed CORS is
handled in the Worker because a binding fetch bypasses R2's CORS policy.
Note the `Origin` header is the **page's** origin, not the media origin.

---

## Failure modes

| Symptom | Cause |
|---|---|
| 403 on everything, `/healthz` says `ok` | Secret mismatch. `MEDIA_TOKEN_SECRET` in `.dev.vars` != the one Django used. Re-run the script. |
| 502 on authorized requests | MinIO unreachable. Check the script's startup warning and `curl http://127.0.0.1:19000/minio/health/live`. |
| 404 on a valid token | No object at that key, or the URL still carries the bucket segment (`/echoflow-media/hls/...`). Check `HLS_URL_STYLE`. |
| nginx: `host not found in upstream` | `extra_hosts` missing from `nginx_local`. |
| Worker returns 404 for `/healthz` | You are on an old build; the route was added with the storage backend. |
| `.dev.vars` edit has no effect | wrangler does not hot-reload var files. Restart. |
| Everything 403 after `docker compose ... up` | You forgot `--env-file .env.local`. |

---

## Known gaps

- **No cross-environment parity test.** The R2 backend (production) and the
  S3 backend (local) are never exercised against the same input in the same
  place. The token validation they share *is* identical code (`token.ts` in
  both), so the security boundary is covered; the storage fetch is not.
  Deferred deliberately — the plan is a shared fixture file replayed against
  both backends.
- **The Worker is not a compose service.** Running it as one would remove the
  `host.docker.internal` special case. The storage config is entirely
  env-driven, so it is a compose-only change; deferred until the flow is
  proven.
- **`celery_media_local` is often down** (OOM at the 2 GB limit on a 12 GB
  host), so HLS output is not produced locally. Fixtures are seeded directly.
