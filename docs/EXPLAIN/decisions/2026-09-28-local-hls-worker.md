# Local HLS Token Worker — Bring the Worker Up Against Local MinIO

**Date:** 2026-09-28
**Status:** PROPOSED — awaiting approval
**Scope:** `docker-compose.local.yml` path only. The prod `docker-compose.yml`
(`/`, R2) path is untouched.

---

## 0. Goal

Make the HLS token Worker (`workers/hls-token-worker/`) reachable and
functional from the local Docker stack, so that a browser playing HLS locally
must present a valid `ef_hls_token` cookie or get a 403 — i.e. the exact
production authorization path is exercised in dev.

Explicitly **not** the goal of this pass: fixing the `docker/nginx.conf`
`:9443` block (still commented out), the nginx+njs dev path, or the
`docker/nginx/hls_auth.js` stub.

---

## 1. Verified findings

Everything below was verified by running it, not by reading alone.

### 1.1 The Worker cannot read local MinIO today — the R2 binding is a dead end

`workers/hls-token-worker/src/index.ts:113` reads objects with
`env.MEDIA_BUCKET.get(...)`. That is an **R2 binding**. Under `wrangler dev`
the binding is served by miniflare's local blob store in `.wrangler/state/`,
which is completely disconnected from MinIO. There is no wrangler flag to
point a local R2 binding at an S3 endpoint.

Verified with a throwaway worker on the real repo's binding config:

```
GET /probe-minio  -> "minio reachable: 200"      # workerd CAN reach host:19000
GET /probe-r2     -> "r2 get returned: null"     # R2 binding does NOT see MinIO
```

**Consequence:** the plan originally proposed ("prove the worker successfully
reached MinIO") cannot pass. Any object the Worker serves under `wrangler dev`
would come from an empty local store. This is the single biggest item of work.

The same probe proved the *positive* path is viable:

```
GET /hls/<uuid>/master.m3u8   (SigV4 presigned)
  -> s3 status=200  body="#EXTM3U\n#EXT-X-VERSION:3\n"
     ct=application/vnd.apple.mpegurl  etag="a851a86fab1df8abd853a646bfae0d1e"
Range: bytes=0-4  -> 206, 5 bytes
anonymous (no auth) -> 403
```

So: workerd reaches the host-published MinIO port, performs authenticated
SigV4 GETs, honours `Range`, and the bucket is genuinely private.

### 1.2 Local MinIO has no bucket — and never gets one

```
$ docker run --network echoflow_default ... mc ls local
(no buckets)

$ docker logs echoflow-minio_init_local-1
mc: <ERROR> Unable to initialize new alias from the provided credentials.
          Invalid Request (invalid hostname).
```

The compose service is named `minio_local`. **The underscore is not a legal
RFC 1123 hostname character**, and both modern S3 clients reject it:

| Client | Behaviour on `http://minio_local:9000` |
|---|---|
| `quay.io/minio/mc:latest` | `Invalid Request (invalid hostname)` → `minio-init` exits 1 |
| `botocore 1.43.78` (Django) | `ValueError: Invalid endpoint: http://minio_local:9000` |

Verified inside the running container:

```
botocore 1.43.78
FAIL http://minio_local:9000 -> ValueError Invalid endpoint
OK   http://172.19.0.4:9000
OK   http://minio:9000
```

This means **Django's `STORAGES` S3 backend cannot talk to MinIO locally at
all** — uploads, HLS output, everything. `select count(*) from app_audioclip`
= `0`. The local stack has never actually written to storage.

### 1.3 `celery_media_local` points at a hostname that does not exist

`celery_media_local` takes `AWS_S3_ENDPOINT_URL` from `env_file: .env.local`,
where it is `http://minio:9000` (`.env.local:73`) — the *main* compose
service name. In the local stack the service is `minio_local`, and no container
is aliased `minio`. Unlike `web_local`, `celery_media_local` has no explicit
`environment:` override for this var. It is currently `Exited (137)`.

### 1.4 The served URL shape does not match what the Worker accepts

`get_hls_playback_url()` (`backend/app/media_urls.py:68`) returns
`{endpoint}/{bucket}/{object_key}` → pathname
`/echoflow-media/hls/<id>/master.m3u8`.

The Worker requires `url.pathname.startsWith("/hls/")` (`index.ts:79`) and
checks the token scope against `"/" + payload.c + "/"` where
`c == "hls/<id>"` (`token.ts:143`). `/echoflow-media/hls/...` fails **both** →
a clean 404 that has nothing to do with auth. This is exactly the failure mode
called out in §6.1 of the original request, and it is the *production* bug too:
R2 with `custom_domain = true` (`wrangler.toml:6-8`) does not serve the bucket
as a path segment, so the serializer's URL is wrong for the Worker's origin.

### 1.5 Smaller gaps that block the test sequence

| Gap | Evidence |
|---|---|
| The Worker has **no health route** | `index.ts:78-81` — every non-`/hls/` path is 404 |
| `ALLOWED_ORIGINS` omits the dev media origin | `index.ts:20-26` has `http://localhost:5173` (OK) but no `https://localhost:19443` |
| Cookie `max_age=600` is hardcoded | `media.py:93` — the comment claims it tracks `MEDIA_TOKEN_TTL_SECONDS`; it does not |
| `_extract_clip_key(None)` → 500 | `media.py:35` `rsplit` on a `null=True` field |
| `.dev.vars` / `.wrangler` not gitignored | `.gitignore` has no entry |

### 1.6 Things already correct — do not "fix" them

- The bucket is **already fully private**; `minio_init` sets no anonymous
  policy and anonymous GET returns 403. The proposed
  `mc anonymous set download` → `none` change is unnecessary.
- The Django issuer (`hls_token.py:88-108`) and the Worker validator
  (`token.ts:106-147`) are already mutually consistent — same HMAC input
  (the base64 string, not the raw JSON), same unpadded base64url, same
  `sort_keys` ordering, same version/expiry/scope checks.
- The env var the Worker reads is **`MEDIA_TOKEN_SECRET`**, not
  `HLS_TOKEN_SECRET`. `HLS_TOKEN_SECRET` in the original request would have
  produced silent 403s — exactly the failure described there.
- Cookies are host-scoped and **not** port-scoped, so a `Path=/hls/` cookie
  set by Django on `https://localhost:18443` *is* sent to
  `https://localhost:19443`. No `Domain` attribute needed locally.
- The `[[routes]] custom_domain = true` in `wrangler.toml` does not block
  `wrangler dev` — the real Worker boots and answers
  `403` for `/hls/x/y` with no cookie, `404` for `/`, with no login prompt.

---

## 2. Design

### 2.1 Storage abstraction in the Worker (the core change)

Add `workers/hls-token-worker/src/storage.ts`:

```
getObject(env, key, request) -> R2ObjectLike | null
```

Two implementations behind one interface, selected by env:

| Env present | Backend | Used by |
|---|---|---|
| `MEDIA_S3_ENDPOINT` | S3/MinIO over `fetch` + SigV4 | local dev |
| (absent) | `env.MEDIA_BUCKET` (R2 binding) | production |

The selection is **fail-loud**: if neither is configured, throw rather than
silently 404. `index.ts` keeps all its existing Range / ETag / Cache-Control /
CORS / status logic and only swaps the fetch call, so the prod path is
byte-for-byte unchanged.

SigV4 is hand-rolled with WebCrypto (`SHA-256` + `HMAC` — the same primitives
`token.ts` already uses) rather than adding `aws4fetch`. Rationale: no new
dependency, the whole thing is dev-only, and it is covered by a live test
against real MinIO plus a unit test on the canonical request. This is
reversible — swapping in `aws4fetch` later is a one-file change.

### 2.2 Networking (option A, as proposed)

The Worker stays a bare host process. `wrangler dev --ip 0.0.0.0 --port 8787`
is reachable from the container network via
`extra_hosts: ["host.docker.internal:host-gateway"]` on `nginx_local` only.
This is required regardless of option A/B, so it is not A-specific.

The Worker's outbound S3 endpoint is the **host-published** MinIO port
(`http://127.0.0.1:19000`) because the Worker is in the host netns. This is
precisely why MinIO's published port must stay bound to `127.0.0.1` rather
than `0.0.0.0` — the Worker reaches it over loopback, nothing off-host does.

The network config is env-var driven, so containerising the Worker later
(option B) is a `wrangler.toml` / compose change with **zero code change**.

### 2.3 Path-shape fix

Introduce `PUBLIC_HLS_ENDPOINT_URL` (the edge/Worker origin) separate from
`PUBLIC_MEDIA_ENDPOINT_URL` (the raw storage origin):

- `get_hls_playback_url()` → `{PUBLIC_HLS_ENDPOINT_URL}/{object_key}`,
  **no bucket segment**. Matches the R2 custom-domain model exactly, so local
  and prod URLs are the same shape.
- `get_signed_media_url()` → unchanged, still on `PUBLIC_MEDIA_ENDPOINT_URL`.
  This is the important separation: folding the two together would break
  presigned `uploads/` URLs, which the Worker does not serve.

### 2.4 nginx routing

`:9443` keeps serving MinIO for everything, with `/hls/` carved out ahead of
the catch-all:

```
location /hls/  -> upstream hls_worker   (host.docker.internal:8787)
location /      -> upstream minio_backend (unchanged)
```

`Cookie`, `Origin`, and `Range` are forwarded (nginx passes client headers
through by default; `Range` is explicitly re-asserted for clarity).
`proxy_buffering off` is preserved — required for streaming segments.

---

## 3. Changes Needed — atomic commits

### Commit 1 — `fix(local): give MinIO an RFC 1123-legal hostname`

Root cause of §1.2. Add a hyphenated network alias rather than renaming the
service (renaming cascades into `nginx.local.conf`, four `depends_on` blocks,
and every `AWS_S3_ENDPOINT_URL`).

- `docker-compose.local.yml`
  - `minio_local.networks.echoflow_local.aliases: [minio-local]`
  - `minio_init_local.entrypoint`: `http://minio-local:9000`
  - all `AWS_S3_ENDPOINT_URL=http://minio_local:9000` → `http://minio-local:9000`
  - bind published ports to `127.0.0.1:19000:9000` / `127.0.0.1:19001:9001`
- `.env.local`: `AWS_S3_ENDPOINT_URL=http://minio-local:9000`
- `celery_media_local` (and any other service that only inherits
  `env_file`) gets an explicit `AWS_S3_ENDPOINT_URL` override — §1.3
- `docker/nginx.local.conf`: `upstream minio_backend { server minio-local:9000; }`

Verify: `minio-init` exits 0; `mc ls` lists `echoflow-media`; a boto3
`list_objects_v2` from inside `web_local` succeeds.

### Commit 2 — `feat(worker): add an S3/MinIO storage backend for local dev`

- new `workers/hls-token-worker/src/storage.ts`
  - `signS3GetUrl()` — SigV4 canonical request, WebCrypto
  - `s3Get()` — signed `fetch`, returns `{ body, status, headers, etag }`
  - `r2Get()` — wraps the existing binding
  - `getStorage(env)` — selector, throws if unconfigured
- `workers/hls-token-worker/src/index.ts` — call `getStorage(env).get(...)`
  instead of `env.MEDIA_BUCKET.get(...)`; extend the `Env` interface with the
  optional `MEDIA_S3_*` vars. No change to the R2 code path.
- `workers/hls-token-worker/vitest.config.ts` + `src/storage.test.ts` — new
  (the `vitest` devDependency is declared but currently unused, and there is
  no config file). Covers: canonical-request construction against a known
  vector, `getStorage` selection for both env shapes, and the
  "neither configured" throw.
- `workers/hls-token-worker/src/index.ts` — add a `/healthz` route that
  returns 200 **before** the `/hls/` check, reporting which backend is active
  (no secrets in the body). Makes the test sequence in §5 possible and gives
  any future container healthcheck something to hit.

### Commit 3 — `chore(worker): local dev secret plumbing`

- `workers/hls-token-worker/.dev.vars` — **gitignored**, generated by a script
  so it cannot drift from Django's secret
- `workers/hls-token-worker/.dev.vars.example` — committed placeholders
- `.gitignore` — add `workers/**/.dev.vars` and `workers/**/.wrangler/`
- `scripts/run-hls-worker-local.sh` — renders `.dev.vars` from `.env.local`
  (`MEDIA_TOKEN_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_STORAGE_BUCKET_NAME`) and execs `wrangler dev --ip 0.0.0.0 --port 8787`
  from the worker directory

Generating the secret from `.env.local` is the point: the "Django signs with
one secret, the Worker verifies with another" failure produces 403s with no
diagnostic, and this removes the possibility of the two drifting.

### Commit 4 — `feat(local): route :9443 /hls/* to the Worker`

- `docker/nginx.local.conf`
  - `upstream hls_worker { server host.docker.internal:8787; }`
  - new `location /hls/` ahead of the existing catch-all
- `docker-compose.local.yml`
  - `nginx_local.extra_hosts: ["host.docker.internal:host-gateway"]`
  - drop the now-misleading `hls_auth.js` mount (a stub, and the image has no
    njs module — it can never do anything)

### Commit 5 — `feat(api): serve bucket-less /hls/ URLs to the edge`

- `backend/EchoFlow/settings.py` — `PUBLIC_HLS_ENDPOINT_URL`, defaulting to
  `PUBLIC_MEDIA_ENDPOINT_URL` so nothing changes until it is set
- `backend/app/media_urls.py` — `get_hls_playback_url()` uses the edge origin
  and omits the bucket; docstring updated to explain the split
- `docker-compose.local.yml` — `PUBLIC_HLS_ENDPOINT_URL=https://localhost:19443`
  on `web_local`
- `.env.local`, `.env.example` — document the var
- `backend/app/views/media.py` — two 1-line correctness fixes in the path being
  tested: `max_age=settings.MEDIA_TOKEN_TTL_SECONDS`, and a null guard in
  `_extract_clip_key` so an un-processed clip returns 409 instead of a 500

### Commit 6 — `test: cover the local HLS worker path`

- `backend/app/tests/test_hls_token.py`
  - `TestPlaybackUrlStyle` — bucket-less when the edge origin is set;
    bucket-prefixed (unchanged) when it is not
  - `TestPlaybackTokenView` — the view has **zero** coverage today despite
    being the token issuer: cookie name/`Path`/`HttpOnly`/`Secure`/
    `SameSite`/`Max-Age`, 404 unknown clip, 403 unmoderated, 409 un-processed
- `backend/app/tests/test_https_termination.py` — the existing
  `listen 9443 ssl` assertion is **vacuous**: its regex matches the commented-out
  line in `docker/nginx.conf`. Add real assertions against
  `docker/nginx.local.conf` (`location /hls/` → `hls_worker`, minio upstream
  only in the fallback, `extra_hosts` present in the compose file)
- `docs/EXPLAIN/storage/05-local-hls-worker-runbook.md` — the runbook: start
  order, the test sequence, the failure-mode table
- `AGENTS.md` — new env var, session learnings, the `minio_local` underscore
  gotcha

---

## 4. Files Affected

| File | Change |
|---|---|
| `docker-compose.local.yml` | minio alias + endpoint + loopback binds, `extra_hosts`, `PUBLIC_HLS_ENDPOINT_URL`, media-worker S3 override, drop stub mount |
| `docker/nginx.local.conf` | `hls_worker` upstream, `location /hls/`, minio alias |
| `workers/hls-token-worker/src/storage.ts` | **new** |
| `workers/hls-token-worker/src/storage.test.ts` | **new** |
| `workers/hls-token-worker/vitest.config.ts` | **new** |
| `workers/hls-token-worker/src/index.ts` | storage indirection, `/healthz`, `Env` |
| `workers/hls-token-worker/.dev.vars.example` | **new** |
| `scripts/run-hls-worker-local.sh` | **new** |
| `backend/EchoFlow/settings.py` | `PUBLIC_HLS_ENDPOINT_URL` |
| `backend/app/media_urls.py` | edge-origin URL builder |
| `backend/app/views/media.py` | TTL + null guard |
| `backend/app/tests/test_hls_token.py` | new test classes |
| `backend/app/tests/test_https_termination.py` | real 9443 assertions |
| `.env.local`, `.env.example`, `.gitignore` | config |
| `docs/EXPLAIN/storage/05-...md`, `AGENTS.md` | docs |

---

## 5. Test sequence

Ordered so each step's failure has exactly one possible cause. Note the
Worker's health route is `/healthz` (§3 commit 2) — there is no `/health`, and
step 1 of the original sequence would 404.

**Pre-flight:** commits 1–3 applied; `minio-init` exited 0; the bucket exists.

```
# 1. Worker is up and the S3 backend is live
$ curl -s http://127.0.0.1:8787/healthz
{"status":"ok","backend":"s3","bucket":"echoflow-media"}   # 200

# 2. It is actually GATING (not passing through)
$ curl -s -o /dev/null -w '%{http_code}\n' \
    http://127.0.0.1:8787/hls/<uuid>/master.m3u8
403                                                     # no cookie
$ curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Cookie: ef_hls_token=garbage" \
    http://127.0.0.1:8787/hls/<uuid>/master.m3u8
403                                                     # bad token

# 3. A valid token reaches MinIO and returns real content
$ curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Cookie: ef_hls_token=$TOKEN" \
    http://127.0.0.1:8787/hls/<uuid>/master.m3u8
200
$ curl -s -H "Cookie: ef_hls_token=$TOKEN" \
    http://127.0.0.1:8787/hls/<uuid>/master.m3u8 | head -1
#EXTM3U

# 4. Range requests survive (hls.js seeking / ABR)
$ curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
    -H "Cookie: ef_hls_token=$TOKEN" -H "Range: bytes=0-4" \
    http://127.0.0.1:8787/hls/<uuid>/master.m3u8
206 5

# 5. Clip-scope isolation: a token for clip A must not open clip B
$ curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Cookie: ef_hls_token=$TOKEN_A" \
    http://127.0.0.1:8787/hls/<other-uuid>/master.m3u8
403

# 6. Expiry: a token whose exp is in the past is refused
403

# 7. Through nginx :9443 (proves extra_hosts + routing, not the Worker)
$ curl -sk -o /dev/null -w '%{http_code}\n' \
    https://localhost:19443/hls/<uuid>/master.m3u8
403
$ curl -sk -H "Cookie: ef_hls_token=$TOKEN" \
    -o /dev/null -w '%{http_code}\n' \
    https://localhost:19443/hls/<uuid>/master.m3u8
200

# 8. Full issuance flow through Django (JWT + Set-Cookie + replay)
$ curl -sk -c jar -H "Authorization: Bearer $JWT" \
    https://localhost:18443/api/v1/media/playback-token/<uuid>/
$ grep ef_hls_token jar
$ curl -sk -b jar -o /dev/null -w '%{http_code}\n' \
    https://localhost:19443/hls/<uuid>/master.m3u8
200

# 9. Storage is still private — the Worker is the only way in
$ curl -s -o /dev/null -w '%{http_code}\n' \
    http://127.0.0.1:19000/echoflow-media/hls/<uuid>/master.m3u8
403

# 10. Backend regression suite still green
$ docker compose exec -e PYTHONPATH=/app web_local \
    pytest backend/app/tests/test_hls_token.py \
           backend/app/tests/test_https_termination.py --tb=short
```

**Fixtures.** Steps 2–6 need an object in MinIO. The media worker is
currently `Exited (137)` and the DB has 0 clips, so seed a fixture directly
rather than depending on the `process_audio_to_hls` pipeline:

```python
# django shell in web_local
from backend.app.services.hls_token import generate_playback_token
print(generate_playback_token(user_id=1, clip_key="hls/<uuid>"))
```
plus a `master.m3u8` uploaded with `mc cp`. Step 8 needs a real
`AudioClip` row with `moderation_approved=True` and a populated
`hls_playlist_url`.

**Browser step (last, optional).** hls.js from
`http://localhost:5173` — that origin is already in `ALLOWED_ORIGINS`, so
credentialed CORS should pass without a worker change. Confirms the
`credentials: 'include'` + `Path=/hls/` + `Secure` cookie path end to end.

---

## 6. Edge Cases

| Case | Handling |
|---|---|
| Worker running, MinIO down | S3 `fetch` throws → 502 with a clear body, not a 404. Distinguishes "auth passed, storage broke" from "auth failed". |
| `MEDIA_TOKEN_SECRET` empty in `.dev.vars` | Every token 403s with no diagnostic — hence generating `.dev.vars` from `.env.local` in the run script. `/healthz` reports the backend but never the secret. |
| MinIO port not on loopback | `/healthz` reports `s3`; step 3 fails with a connection error naming the endpoint. |
| `hls/` object missing but token valid | 404 from the storage layer — correctly distinguishable from the 403 auth path. |
| Token for clip A used on clip A's variant playlist | Allowed: the scope check is a `/hls/<id>/` prefix, so sub-paths pass. Matches Django. |
| Concurrent hls.js segment bursts | No Worker state; each request is an independent signed GET. Worker free-tier invocation limits are a prod concern only. |
| Someone changes `PUBLIC_HLS_ENDPOINT_URL` to a raw MinIO origin | No bucket segment → 404. Documented in `.env.example`; the runbook says the two vars must be paired. |
| Nginx restarts while the Worker is down | `location /hls/` 502s; `location /` (MinIO) still works, so upload presigning is unaffected. |
| `celery_media_local` still `Exited (137)` | Not this plan's problem. Flagged: 12 GB host, 4 GB free, 2 GB container limit + HF models. The fixture path deliberately avoids the pipeline. |

---

## 7. Why This And Not The Alternatives

**Containerise the Worker (option B).** Better long-term fit with the rest of
the stack, but it needs a Node+wrangler image, source mount, and a second
secret-mount path. It does not remove any of the §1 blockers — the R2 binding
problem (§1.1) is the same in a container, and the path mismatch (§1.4) is
pure application code. Deferring it is correct: §2.2 keeps the network config
in env vars so it stays a compose-only change later.

**nginx + njs (design doc Option B).** Would sidestep §1.1 entirely — it
proxies to real MinIO with no S3 client in the path. Rejected because it
requires a second implementation of the HMAC validation (drift risk on the
security-critical path), plus a custom nginx image with `nginx-mod-njs`
matched to the exact nginx version. The existing `hls_auth.js` is a 19-line
stub and the image has no njs module at all. Worth revisiting only if we
decide to drop the Worker entirely.

**`wrangler dev --remote`.** No production Cloudflare account is wired up, and
it cannot reach a Docker-network MinIO either. Non-starter.

**Seeding miniflare's local R2 (`wrangler r2 object put`).** Duplicates storage
and must be re-seeded on every HLS re-encode. Non-starter.

**Make the Worker bucket-aware (strip a leading `/<bucket>/`).** Smaller —
no Django change. Rejected: it makes the Worker accept two path shapes, leaves
the *production* URL wrong (§1.4 is a real prod bug, not just a local one), and
leaks the bucket name to the edge. Fixing it at the source also fixes prod.

---

## 8. Explicitly Out Of Scope

- `docker/nginx.conf` `:9443` block (still commented out) and
  `docker/nginx/hls_auth.js` — main-compose/prod path
- `MEDIA_TOKEN_COOKIE_DOMAIN` is dead config. It is *needed* in prod
  (`api.` and `media.` are different hosts) and correctly empty locally. Wiring
  it up is a prod change with real security surface — flagged, not touched.
- Containerising the Worker (option B)
- The `docker-compose.vps.yml` / `.laptop.yml` files. Note the running stack
  currently has all three compose files loaded together, so its containers sit
  on `echoflow_default` (172.19.0.0/16), **not** the `echoflow_local` network
  `docker-compose.local.yml` declares. Any `docker compose up` invocation must
  match how it was started, or it will rebuild the network and orphan 13
  containers.
