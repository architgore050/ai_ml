## Storage Pipeline Audit

### What is actually working

The core upload-to-storage flow is structurally sound. `POST /clips/` → Django fires `process_audio_to_hls` via `transaction.on_commit` (correct: no task before commit) → Celery `heavy_media` queue with prefork concurrency=2 and a 4GB memory ceiling → ffmpeg produces ABR HLS at 192/128/64 kbps → segments upload to MinIO under the `hls/` prefix, original under `uploads/`. The MinIO configuration itself is correct: CORS headers set, the `minio-init` one-shot service creates the bucket before any worker races it, `minio:condition: service_completed_successfully` is the right dependency guard. The two-Redis split (noeviction broker, allkeys-lru 3GB cache) is correct reasoning. PgBouncer transaction-pool mode with `IGNORE_STARTUP_PARAMETERS` is correctly wired. The AI pipeline stages (librosa → Whisper → SentenceTransformer → KeyBERT → ffmpeg) are baked into the media image so there are no runtime downloads.

### The design split that breaks HLS playback

This is the most critical finding. There are two contradictory states in the repo:

The `minio-init` service runs `mc anonymous set download local/${BUCKET}/hls` — this makes the entire `hls/` prefix publicly readable with no authentication. The docker-compose.yml even has a comment explaining why (HLS is a multi-file protocol; presigned URLs only sign the master.m3u8, not the segment files it references, so they all get 403).

But separately, the codebase now has a token-protection design: HMAC-signed `ef_hls_token` cookies issued by `/media/playback-token/<clip_id>/`, validated by nginx njs (dev) or a Cloudflare Worker (prod) before proxying to MinIO. The fork documentation explicitly states "the hls/ prefix is NO LONGER public-read."

These two things cannot both be true at runtime. Right now in your repo, `hls/` IS public-read because that is what `minio-init` actually executes. The token validation layer (nginx njs) is only meaningful if `hls/` is private. If you run `docker compose up` as-is, HLS playback works without any token — but unauthorized access is wide open and the token endpoint is vestigial.

The resolution is binary: either revert the token protection (keep public-read, drop the njs/Worker layer) or complete it (make hls/ private, verify njs validates tokens before proxying, remove `mc anonymous set download`). The current state is neither — it's public-read storage with a token endpoint that doesn't protect anything.

### HLS Worker is not deployed

PR #22 added a GitHub Actions CI step to deploy the Cloudflare Worker at `workers/hls-token-worker/`. The deployment log shows `❌ Deployment failed` on Sep 14, 2026. The worker is not live. For localhost this is less urgent because the dev design uses nginx njs instead, but the nginx.conf in your repo's `docker/` directory would need the njs configuration verified — and that configuration is not confirmed to exist.

### Localhost deployment: four blockers before `docker compose up --build` succeeds

`docker/certs/` must contain a self-signed cert and key before nginx starts. Without them nginx fails to start, the web health check probe (`wget -q --spider https://localhost/health/`) fails, and Prometheus never reaches the web target. These are not in the repo and need generation (`openssl req -x509 -newkey rsa:2048 -keyout docker/certs/key.pem -out docker/certs/cert.pem -days 365 -nodes -subj "/CN=localhost"`).

`wheelhouse/` must exist and be complete before `docker build` runs. The Dockerfile uses `--no-index --find-links=/wheelhouse` for both the api and media stages, which means pip cannot reach PyPI. On a fresh clone with no wheelhouse, the build fails at the first `pip install` step. There should be a generation script (probably in AGENTS.md or scripts/) — run that first.

`docker/pgbouncer/Dockerfile` is a custom build referenced in `docker-compose.yml`. It needs to exist for `docker compose build` to succeed.

`GRAFANA_ADMIN_PASSWORD` must be set in `.env` — the docker-compose.yml uses `:?` interpolation which means docker compose exits immediately at startup if it's missing. Same for `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

### What you are missing — the more important questions

The real problem here is not a single broken file, it is a design that is mid-transition. There are two distinct versions of EchoFlow: the public-read HLS version (your docker-compose.yml minio-init) and the token-gated HLS version (the Cloudflare Worker and njs design). You merged the plumbing of the second into a codebase that still configures storage as the first. This is the class of bug that only surfaces when someone actually tries to do end-to-end playback.

The meta-question you are not asking: does the `/media/playback-token/<clip_id>/` endpoint actually exist in your `backend/app/views.py` and `backend/app/urls.py`? If the token endpoint is not implemented in your version (only in the fork), then the entire playback flow as documented cannot work even in the fork-ahead design.

Second-order effect: if you deploy this to a VPS with the current `hls/` public-read configuration and MinIO exposed on port 9000, any clip's segments are permanently downloadable by anyone with the URL structure. That is not just a security issue — if you ever carry real audio content with licensing implications, public-read storage is an ownership liability, not just a technical gap.

### Highest-leverage action right now

Decide on one of two paths and make the codebase coherent with it:

For localhost dev (fastest to working state): keep `hls/` as public-read, remove the token endpoint work from your nginx config, set `PUBLIC_MEDIA_ENDPOINT_URL=http://localhost:9000` in `.env`, generate the self-signed certs, run the wheelhouse generation script, then `docker compose up --build`. HLS will work without auth — acceptable for local dev.

For the complete design: change `minio-init` from `mc anonymous set download` to `mc anonymous set none` for the `hls/` prefix, verify the `/media/playback-token/<clip_id>/` view exists in your `backend/app/views.py`, configure nginx njs to validate the HMAC cookie before proxying to MinIO on `:9443`, and fix the Cloudflare Worker deployment failure by checking the `CLOUDFLARE_API_TOKEN` secret in GitHub Actions.

Pick one. The current state is a superposition of both, which means neither actually works end-to-end.