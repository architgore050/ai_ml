# S3-Compatible Storage Architecture

## Overview

EchoFlow uses **django-storages `S3Storage`** for all media files, compatible with:
- **MinIO** (local development)
- **AWS S3** (production)
- **Cloudflare R2** (production alternative)

**Configuration:** `backend/EchoFlow/settings.py:270-293`

---

## STORAGES Configuration

```python
STORAGES = {
    "default": {
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": os.environ["AWS_STORAGE_BUCKET_NAME"],
            "region_name": os.getenv("AWS_S3_REGION_NAME", "auto"),
            "endpoint_url": os.getenv("AWS_S3_ENDPOINT_URL") or None,
            "access_key": os.environ["AWS_ACCESS_KEY_ID"],
            "secret_key": os.environ["AWS_SECRET_ACCESS_KEY"],
            "default_acl": None,              # Private by default
            "querystring_auth": True,         # Sign URLs by default
            "querystring_expire": int(os.getenv("AWS_S3_QUERYSTRING_EXPIRE", "3600")),
            "file_overwrite": False,
            "addressing_style": "path",       # Required for MinIO
        },
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"
    },
}
```

---

## Key Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `default_acl` | `None` | Private by default (no public-read) |
| `querystring_auth` | `True` | `default_storage.url()` returns signed URLs |
| `querystring_expire` | `3600` (1hr) | Signed URL TTL |
| `addressing_style` | `path` | Path-style: `/bucket/key` (MinIO requirement) |
| `file_overwrite` | `False` | UUID filenames prevent collisions anyway |

---

## Endpoint Separation (Critical)

### Two Endpoints for Same Bucket

| Variable | Container Value | Browser Value |
|----------|-----------------|---------------|
| `AWS_S3_ENDPOINT_URL` | `http://minio:9000` | N/A |
| `PUBLIC_MEDIA_ENDPOINT_URL` | N/A | `https://localhost:9443` |

**In Production:**
| Variable | Value |
|----------|-------|
| `AWS_S3_ENDPOINT_URL` | `https://s3.us-east-1.amazonaws.com` (or VPC endpoint) |
| `PUBLIC_MEDIA_ENDPOINT_URL` | `https://cdn.example.com` (CloudFront) |

### Why Separate?

1. **Container DNS** resolves `minio:9000` internally
2. **Browser** needs `localhost:9000` (published port) or CDN domain
3. **django-storages** uses `AWS_S3_ENDPOINT_URL` for internal operations
4. **Playback URLs** must use `PUBLIC_MEDIA_ENDPOINT_URL`

---

## Split ACL Design

### Bucket Policy (via `minio-init`)

```bash
# The bucket is FULLY PRIVATE. minio-init only creates it.
# ⛔ Do NOT add `mc anonymous set download .../hls` — that makes every
# transcript and segment readable without a playback token.
mc mb --ignore-existing local/echoflow-media
```

`hls/` is served through the validating edge (Cloudflare Worker at
`media.echoflow.in` in production, nginx `:9443` locally), which checks a
short-lived HMAC token per clip before reading the object. See
[`04-hls-token-protection.md`](04-hls-token-protection.md).

### Prefix ACLs

| Prefix | ACL | Access Method |
|--------|-----|---------------|
| `uploads/` | Private | Signed URL (1hr) |
| `audio_scraper/` | Private | Signed URL (1hr) |
| `hls/` | **Public-read** | Unsigned public URL |
| `avatars/` | Private | Signed URL (1hr) |

---

## Why HLS Must Be Public

### The Multi-File Problem

```
master.m3u8 (signed)
  │
  ├── variant_0.m3u8 (relative reference)
  │    ├── segment_000.ts (relative)
  │    └── ...
  └── variant_1.m3u8 (relative)
       └── ...
```

### RFC 3986: Relative Reference Resolution
> Resolving a relative reference against a base URL does **NOT** carry the base URL's query string forward.

**Result:** Signed `master.m3u8` works, but every segment request gets **403 Forbidden** (no signature).

### Industry Standard Solution
- **Derived/processed content** (HLS) = private + token-gated (signed cookies)
- **Original uploads** = private, signed URLs
- Used by Netflix, Spotify, YouTube, etc.
- **EchoFlow implements this.** `hls/` is private and token-gated; the edge
  at `media.echoflow.in` validates the token. See
  `04-hls-token-protection.md`.

---

## URL Generation (`media_urls.py`)

### HLS Playback (Unsigned)
```python
def get_hls_playback_url(object_key):
    if not object_key: return None
    bucket = settings.STORAGES["default"]["OPTIONS"]["bucket_name"]
    endpoint = (settings.PUBLIC_MEDIA_ENDPOINT_URL or "").rstrip("/")
    return f"{endpoint}/{bucket}/{object_key}"
```
**Output:** `https://localhost:9443/echoflow-media/hls/uuid/master.m3u8`

### Original Files (Signed)
```python
def get_signed_media_url(object_key):
    if not object_key: return None
    client = boto3.client("s3", ...)
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": object_key},
        ExpiresIn=3600
    )
```
**Output:** `https://localhost:9443/echoflow-media/uploads/...?signature=xyz`

---

## MinIO Configuration (`docker-compose.yml`)

### MinIO Service
```yaml
minio:
  image: minio/minio:RELEASE.2025-09-07T16-13-09Z
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${AWS_ACCESS_KEY_ID:-echoflow-dev}
    MINIO_ROOT_PASSWORD: ${AWS_SECRET_ACCESS_KEY:-echoflow-dev-secret}
    # CORS for HLS playback
    MINIO_CORS_ALLOW_ORIGIN: "*"
    MINIO_CORS_ALLOW_METHODS: "GET,PUT,POST,DELETE,OPTIONS"
    MINIO_CORS_ALLOW_HEADERS: "Origin,Accept,Content-Type,Authorization,Range"
    MINIO_CORS_EXPOSE_HEADERS: "Date,Content-Length,Content-Range,Accept-Ranges"
    MINIO_CORS_MAX_AGE: "3600"
```

### MinIO Init (One-shot)
```yaml
minio-init:
  image: minio/mc:RELEASE.2025-08-13T08-35-41Z
  depends_on:
    minio: {condition: service_healthy}
  entrypoint: >
    sh -c "
      mc alias set local http://minio:9000 ${AWS_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY} &&
      mc mb --ignore-existing local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media} &&
      mc anonymous set download local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}/hls
    "
```

---

## CORS Configuration

### MinIO CORS (for browser HLS)
```yaml
MINIO_CORS_ALLOW_ORIGIN: "*"
MINIO_CORS_ALLOW_METHODS: "GET,PUT,POST,DELETE,OPTIONS"
MINIO_CORS_ALLOW_HEADERS: "Origin,Accept,Content-Type,Authorization,Range"
MINIO_CORS_EXPOSE_HEADERS: "Date,Content-Length,Content-Range,Accept-Ranges"
MINIO_CORS_MAX_AGE: "3600"
```

### Django CORS (for API)
```python
CORS_ALLOW_HEADERS = [..., 'range']  # Critical for HLS Range requests
CORS_EXPOSE_HEADERS = ['Content-Range', 'Accept-Ranges']
```

---

## Path-Style Addressing

### Required for MinIO
```python
"addressing_style": "path"
```

| Style | URL Format | MinIO |
|-------|------------|-------|
| Virtual-hosted | `https://bucket.endpoint/key` | ❌ Needs DNS config |
| **Path-style** | `https://endpoint/bucket/key` | ✅ Works |

**Also works with AWS S3** — single setting covers both.

---

## Environment Variables

| Variable | Dev Default | Prod Value | Required |
|----------|-------------|------------|----------|
| `AWS_ACCESS_KEY_ID` | echoflow-dev | IAM Access Key | ✅ |
| `AWS_SECRET_ACCESS_KEY` | echoflow-dev-secret | IAM Secret Key | ✅ |
| `AWS_STORAGE_BUCKET_NAME` | echoflow-media | echoflow-prod-media | ✅ |
| `AWS_S3_ENDPOINT_URL` | http://minio:9000 | https://s3.us-east-1.amazonaws.com | ✅ |
| `AWS_S3_REGION_NAME` | auto | us-east-1 | ✅ |
| `AWS_S3_QUERYSTRING_EXPIRE` | 3600 | 3600 | |
| `PUBLIC_MEDIA_ENDPOINT_URL` | https://localhost:9443 | https://cdn.example.com | ✅ |

---

## Verification Scripts

| Script | Purpose |
|--------|---------|
| `scripts/verify_minio_deployment.sh` | Host + internal API, bucket, anonymous policy, CORS, direct .m3u8 access |
| `scripts/test_minio_edge_cases.py` | Concurrent reads, bad auth, timeout, large upload, signed URL expiration |
| `scripts/verify_clip_url.sh` | Quick 200-check + content preview for any HLS URL |
| `scripts/verify_decoder_rootcause.sh` | Downloads .ts, checks MPEG-TS magic (47401111) |
| `scripts/verify_hls_playback.html` | Browser test with hls.js |

---

## Production Checklist

- [ ] Real AWS credentials (not MinIO defaults)
- [ ] Bucket in same region as compute
- [ ] VPC endpoint for `AWS_S3_ENDPOINT_URL` (cost + latency)
- [ ] CloudFront distribution for `PUBLIC_MEDIA_ENDPOINT_URL`
- [ ] Cache-Control headers on S3 objects
- [ ] CloudFront Origin Shield enabled
- [ ] WAF rules on CloudFront
- [ ] Monitoring: 4xx/5xx rates, latency, bytes out
- [ ] S3 versioning enabled (accidental overwrite protection)
- [ ] Cross-region replication (DR)

---

## Discrepancy: README vs Implementation

| README Claim | Actual |
|--------------|--------|
| "HLS output stored under `media/hls/{clip_id}/` on local disk" | **S3/MinIO** `hls/{clip_id}/` |
| "Not S3-backed yet" | **Fully S3-backed** (STORAGES config) |

---

*Source: `backend/EchoFlow/settings.py:270-293`, `backend/app/media_urls.py`, `docker-compose.yml`, `docs/minio-s3-architecture.md`*