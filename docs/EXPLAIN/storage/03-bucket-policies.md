# Bucket Policies & MinIO Init

> **⛔ READ FIRST. The bucket is FULLY PRIVATE, and this file's
> "anonymous policy" sections are HISTORICAL.**
>
> This page was written for the pre-token-protection design and still contains
> runnable commands that publish `hls/` to the world. **Do not run
> `mc anonymous set download .../hls`, and do not add the `PublicReadHLS`
> statement to any real bucket.** `hls/` segments are verbatim transcripts,
> so a public prefix means the entire clip is readable in one request by
> anyone who can guess a clip UUID.
>
> Current state: `hls/` is private and reachable only through the validating
> edge — the Cloudflare Worker at `media.echoflow.in` in production, nginx
> `:9443` locally — which checks a short-lived per-clip HMAC token
> (`ef_hls_token` cookie, or the `X-EchoFlow-Media-Token` header for native
> players) before reading the object. `minio-init` now only *creates* the
> bucket.
>
> The **ACL Summary** near the bottom of this file is accurate and is the
> part to trust. The `PublicReadHLS` JSON blocks retained below are kept only
> so the mistake they describe is recognisable.
>
> See [`04-hls-token-protection.md`](04-hls-token-protection.md).

## MinIO Init Service (`docker-compose.yml:99-109`)

```yaml
minio-init:
  image: minio/mc:RELEASE.2025-08-13T08-35-41Z
  depends_on:
    minio:
      condition: service_healthy
  entrypoint: >
    sh -c "
      mc alias set local http://minio:9000 ${AWS_ACCESS_KEY_ID:-echoflow-dev} ${AWS_SECRET_ACCESS_KEY:-echoflow-dev-secret} &&
      mc mb --ignore-existing local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}
    # ⛔ The `mc anonymous set download .../hls` line that used to be here was
    # removed: hls/ is token-gated at the edge, not public. See the banner.
    "
```

### Steps

1. **Configure mc client**
   ```bash
   mc alias set local http://minio:9000 $ACCESS_KEY $SECRET_KEY
   ```

2. **Create bucket** (idempotent)
   ```bash
   mc mb --ignore-existing local/echoflow-media
   ```

3. ~~**Set public-read on hls/**~~ — **REMOVED, do not run**
   ```bash
   # ⛔ OBSOLETE: mc anonymous set download local/echoflow-media/hls
   # hls/ is token-gated at the edge; the bucket stays fully private.
   ```

---

## Anonymous Policy Details (HISTORICAL — not applied)

### What `mc anonymous set download` Does

> ⛔ This is what the removed init step *used to* create. It is recorded here
> so the policy it produced is recognisable in a real bucket. If you find
> `PublicReadHLS` on `echoflow-media`, remove it — it defeats the gate.

Creates bucket policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"AWS": "*"},
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::echoflow-media/hls/*"]
    }
  ]
}
```

### Equivalent AWS S3 Bucket Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadHLS",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::echoflow-prod-media/hls/*"
    }
  ]
}
```

---

## Complete Bucket Structure

```
echoflow-media/
├── uploads/                    ← Private (default)
│   └── 2024/01/15/
│       └── uuid.mp3
│
├── audio_scraper/              ← Private (default)
│   └── wikimedia/2024/01/15/
│       └── uuid.mp3
│
├── hls/                        ← Private, token-gated at the edge
│   └── clip-uuid/
│       ├── master.m3u8
│       ├── index.m3u8
│       ├── segment_000.ts
│       └── ...
│
└── avatars/                    ← Private (default)
    └── user123.jpg
```

---

## ACL Summary

| Prefix | ACL | Anonymous Policy | Access Method | Notes |
|--------|-----|------------------|---------------|-------|
| `uploads/` | Private | None | Signed URL (`get_signed_media_url`) | Original uploads — always private |
| `audio_scraper/` | Private | None | Signed URL | Scraper originals — licensing compliance |
| `hls/` | Private + token-gated | None (was anonymous download) | **Signed cookie** via Worker/nginx | See `04-hls-token-protection.md` for migration plan |
| `avatars/` | Private | None | Signed URL | User PII |

> **Migration note:** The `hls/` prefix was previously public-read via
> `mc anonymous set download local/.../hls`. When HLS token protection
> ships (Option A for production, Option B for dev), this public-read policy
> is **removed** and replaced with per-request cookie validation at the
> Cloudflare Worker (production) or nginx njs (development) layer. See
> `04-hls-token-protection.md` for the full implementation plan and rollback
> strategy.

---

## CORS Configuration (MinIO)

```yaml
environment:
  MINIO_CORS_ALLOW_ORIGIN: "*"
  MINIO_CORS_ALLOW_METHODS: "GET,PUT,POST,DELETE,OPTIONS"
  MINIO_CORS_ALLOW_HEADERS: "Origin,Accept,Content-Type,Authorization,Range"
  MINIO_CORS_EXPOSE_HEADERS: "Date,Content-Length,Content-Range,Accept-Ranges"
  MINIO_CORS_MAX_AGE: "3600"
```

### Why These Headers?

| Header | Purpose |
|--------|---------|
| `Range` | **Critical** — HLS.js requests segments with `Range: bytes=0-` |
| `Content-Range` | Response header for partial content |
| `Accept-Ranges` | Advertises range support |
| `Origin, Accept, Content-Type, Authorization` | Standard CORS |

---

## MinIO Healthcheck

```yaml
healthcheck:
  test: ["CMD", "mc", "ready", "local"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 5s
```

**Why `mc ready`** — Checks MinIO is fully operational, not just port open.

---

## Verification Commands

### Check Bucket Policy
```bash
# Inside minio container or via mc
mc anonymous get download local/echoflow-media/hls
# Should show: "Download access is allowed for hls/*"
```

### Test Public Access
```bash
# Should work without auth
curl -I http://localhost:9000/echoflow-media/hls/clip-uuid/master.m3u8
# Should return 200 OK

# Should fail (private)
curl -I http://localhost:9000/echoflow-media/uploads/2024/01/15/file.mp3
# Should return 403 Forbidden
```

### Check CORS
```bash
curl -H "Origin: http://localhost:5173" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: Range" \
     -X OPTIONS \
     http://localhost:9000/echoflow-media/hls/clip-uuid/segment_000.ts

# Should return:
# Access-Control-Allow-Origin: *
# Access-Control-Allow-Methods: GET, OPTIONS
# Access-Control-Allow-Headers: Range
# Access-Control-Expose-Headers: Content-Range, Accept-Ranges
```

---

## Production: AWS S3 Bucket Policy

### ⛔ Public Read for HLS — DO NOT APPLY
> The production design is Cloudflare R2 with a **fully private** bucket and a
> Worker in front (`workers/hls-token-worker/`). `02-vps-setup.md` step 4
> says the same. This policy is the superseded alternative.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadHLS",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::echoflow-prod-media/hls/*"
    }
  ]
}
```

### Block Public Access (Account Level)
- Enable S3 **Block Public Access** for the account/bucket
- With the Worker design there should be **no** allow statements at all —
  the Worker reads R2 through a server-side binding, not an HTTP request,
  so it needs no public policy

---

## CloudFront Integration (Production)

### Origin Access Control (OAC)
```json
// S3 Bucket Policy for CloudFront OAC
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::echoflow-prod-media/*",
      "Condition": {
        "StringEquals": {
          "aws:SourceArn": "arn:aws:cloudfront::123456789:distribution/EXAMPLE"
        }
      }
    }
  ]
}
```

### Cache Behaviors
| Path Pattern | TTL | Forward Headers |
|--------------|-----|-----------------|
| `*/master.m3u8` | 0 | Authorization, Range |
| `*/index.m3u8` | 0 | Authorization, Range |
| `*/segment_*.ts` | 86400 | Authorization, Range |
| `*/uploads/*` | 0 | Authorization |

---

## Disaster Recovery

### Bucket Versioning
```bash
# Enable versioning (protects against accidental delete)
mc version enable local/echoflow-media
```

### Cross-Region Replication (CRR)
```bash
# Replicate to DR region
mc replicate add local/echoflow-media \
  --remote-bucket dr-echoflow-media \
  --arn arn:aws:iam::123456789:role/replication-role \
  --priority 1
```

---

*Source: `docker-compose.yml:99-124`, `docs/minio-s3-architecture.md`*