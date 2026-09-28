# Backend Media URLs (S3/MinIO Playback URL Generation)

## Overview

**File:** `backend/app/media_urls.py`

Critical module for generating browser-playable URLs for media stored in S3-compatible object storage (MinIO locally, S3/R2 in production).

Solves two fundamental problems:
1. **Endpoint mismatch** — Internal vs browser-accessible endpoints
2. **HLS multi-file protocol** — Signed URLs don't work for relative segment references

---

## Problem 1: Endpoint Mismatch

### Internal vs External Endpoints

| Variable | Container Value | Browser Value | Purpose |
|----------|----------------|---------------|---------|
| `AWS_S3_ENDPOINT_URL` | `http://minio:9000` | N/A | Internal (Docker network) |
| `PUBLIC_MEDIA_ENDPOINT_URL` | N/A | `https://localhost:9443` (in .env) | Browser-to-MinIO (nginx :9443) |

**In production:**
- `AWS_S3_ENDPOINT_URL` = VPC endpoint (e.g., `https://s3.us-east-1.amazonaws.com`)
- `PUBLIC_MEDIA_ENDPOINT_URL` = CDN domain (e.g., `https://cdn.example.com`)

### Why Separate?

```python
# Container resolves minio:9000 via Docker DNS
# Browser reaches localhost:9443 via nginx TLS terminator
# These are DIFFERENT origins (same MinIO instance, HTTPS public)
```

`get_hls_playback_url()` uses `PUBLIC_MEDIA_ENDPOINT_URL` so browsers never see internal `minio:9000`.

---

## Problem 2: HLS Multi-File Protocol

### HLS Structure
```
master.m3u8
  ├── variant_0.m3u8 (192kbps)
  │    ├── segment_000.ts
  │    ├── segment_001.ts
  │    └── ...
  ├── variant_1.m3u8 (128kbps)
  │    ├── segment_000.ts
  │    └── ...
  └── variant_2.m3u8 (64kbps)
       ├── segment_000.ts
       └── ...
```

### Signed URL Problem

1. Sign `master.m3u8` → URL: `https://bucket.s3.amazonaws.com/hls/abc/master.m3u8?signature=xyz`
2. `master.m3u8` references `variant_0.m3u8` via **relative path**: `variant_0.m3u8`
3. Browser resolves: `https://bucket.s3.amazonaws.com/hls/abc/variant_0.m3u8` **(no signature!)**
4. Private bucket → **403 Forbidden**

**RFC 3986:** Relative reference resolution does NOT carry base URL's query string.

### Solution: Split ACL

| Prefix | ACL | Access Method |
|--------|-----|---------------|
| `uploads/` | Private | Signed URLs (1hr expiry) |
| `hls/` | **Public-read** | Unsigned public URLs |

**MinIO bucket policy** (via `minio-init`):
```bash
mc anonymous set download local/echoflow-media/hls
```

Original uploads protected; derived HLS streams public (safe — they're transcoded, not user originals).

---

## Function Reference

### `get_hls_playback_url(object_key)`

```python
def get_hls_playback_url(object_key):
    """Return a playable URL for HLS content (master.m3u8 or anything under hls/).

    NOT signed — see the module docstring for why a single signed URL cannot
    authorize a multi-file HLS stream. hls/ is PRIVATE and reachable only
    through the validating edge (Cloudflare Worker, or nginx :9443 locally),
    which requires a short-lived per-clip HMAC token: the ef_hls_token
    cookie, or the X-EchoFlow-Media-Token header for native players.
    """
    if not object_key:
        return None

    bucket = settings.STORAGES["default"]["OPTIONS"]["bucket_name"]
    endpoint = (settings.PUBLIC_MEDIA_ENDPOINT_URL or "").rstrip("/")
    # path-style addressing (bucket as path segment)
    return f"{endpoint}/{bucket}/{object_key}"
```

**Input:** `hls/<uuid>/master.m3u8` (object key from `AudioClip.hls_playlist_url`)

**Output:** `http://localhost:9000/echoflow-media/hls/<uuid>/master.m3u8`

**Used by:** `FeedClipSerializer.get_hls_playlist_url()`, `ShareEventSerializer.get_clip_hls_url()`

---

### `get_signed_media_url(object_key)`

```python
def get_signed_media_url(object_key):
    """Return time-limited SIGNED url for PRIVATE object (uploads/).
    
    Do NOT use for HLS content — see module docstring.
    """
    if not object_key:
        return None

    client = boto3.client(
        "s3",
        endpoint_url=settings.PUBLIC_MEDIA_ENDPOINT_URL,
        aws_access_key_id=settings.STORAGES["default"]["OPTIONS"]["access_key"],
        aws_secret_access_key=settings.STORAGES["default"]["OPTIONS"]["secret_key"],
        region_name=settings.STORAGES["default"]["OPTIONS"]["region_name"],
        config=boto3.session.Config(
            s3={"addressing_style": settings.STORAGES["default"]["OPTIONS"]["addressing_style"]},
            signature_version="s3v4",
        ),
    )
    return client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.STORAGES["default"]["OPTIONS"]["bucket_name"],
            "Key": object_key,
        },
        ExpiresIn=settings.STORAGES["default"]["OPTIONS"]["querystring_expire"],  # 3600s default
    )
```

**Input:** `uploads/2024/01/15/abc.mp3` (object key from `AudioClip.original_file.name`)

**Output:** Signed URL valid for 1 hour (configurable via `AWS_S3_QUERYSTRING_EXPIRE`)

**Used by:** Not currently used in serializers — reserved for original file access.

---

## STORAGES Configuration Reference

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
            "default_acl": None,           # Private by default
            "querystring_auth": True,      # Sign URLs by default
            "querystring_expire": int(os.getenv("AWS_S3_QUERYSTRING_EXPIRE", "3600")),
            "file_overwrite": False,
            "addressing_style": "path",    # Required for MinIO
        },
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"
    },
}
```

**Key settings:**
- `addressing_style: "path"` — bucket as path segment (`/bucket/key`) not subdomain
- `querystring_auth: True` — default_storage.url() returns signed URLs
- `default_acl: None` — private by default

---

## URL Generation Flow

### HLS Playback (Feed, Share, Profile)

```
AudioClip.hls_playlist_url = "hls/abc-123/master.m3u8"  (stored in DB)
        │
        ▼
FeedClipSerializer.get_hls_playlist_url(obj)
        │
        ▼
media_urls.get_hls_playback_url("hls/abc-123/master.m3u8")
        │
        ├── bucket = "echoflow-media"
        ├── endpoint = "https://localhost:9443" (PUBLIC_MEDIA_ENDPOINT_URL — HTTPS terminator on nginx :9443)
        │
        ▼
Returns: "https://localhost:9443/echoflow-media/hls/abc-123/master.m3u8"
        │
        ▼
Browser loads master.m3u8 → resolves relative variant/segment URLs
        │
        ▼
All requests to MinIO public-read hls/ prefix → 200 OK (no auth)
```

### Original File Access (Not Currently Used)

```
AudioClip.original_file.name = "uploads/2024/01/15/abc.mp3"
        │
        ▼
media_urls.get_signed_media_url("uploads/2024/01/15/abc.mp3")
        │
        ▼
boto3 generate_presigned_url() → signed URL valid 1hr
        │
        ▼
Returns: "https://localhost:9443/echoflow-media/uploads/...?signature=xyz"
```

---

## Path-Style Addressing

**Required for MinIO**, also works with AWS S3:

| Style | URL Format | MinIO Support |
|-------|------------|---------------|
| Virtual-hosted | `https://bucket.endpoint/key` | ❌ Requires DNS config |
| **Path-style** | `https://endpoint/bucket/key` | ✅ Works out of box |

**Configuration:**
```python
# STORAGES
"addressing_style": "path"

# boto3 client in get_signed_media_url()
config=boto3.session.Config(
    s3={"addressing_style": "path"},
    signature_version="s3v4",
)
```

---

## CORS Configuration for HLS

**MinIO CORS (docker-compose.yml):**
```yaml
environment:
  MINIO_CORS_ALLOW_ORIGIN: "*"
  MINIO_CORS_ALLOW_METHODS: "GET,PUT,POST,DELETE,OPTIONS"
  MINIO_CORS_ALLOW_HEADERS: "Origin,Accept,Content-Type,Authorization,Range"
  MINIO_CORS_EXPOSE_HEADERS: "Date,Content-Length,Content-Range,Accept-Ranges"
  MINIO_CORS_MAX_AGE: "3600"
```

**Django CORS (settings.py):**
```python
CORS_ALLOW_HEADERS = [..., 'range']  # Critical for HLS partial content
CORS_EXPOSE_HEADERS = ['Content-Range', 'Accept-Ranges']
```

**Why `Range` header?**
- HLS.js requests segments with `Range: bytes=0-` for seeking
- Without CORS `Range` allowance → preflight fails → playback breaks

---

## Verification Scripts

| Script | Purpose |
|--------|---------|
| `scripts/verify_minio_deployment.sh` | Host + internal API, bucket, anonymous policy, CORS |
| `scripts/test_minio_edge_cases.py` | Concurrent reads, bad auth, timeout, large upload |
| `scripts/verify_clip_url.sh` | Quick 200-check + content preview for HLS URL |
| `scripts/verify_decoder_rootcause.sh` | Downloads .ts, checks MPEG-TS magic (47401111) |
| `scripts/verify_hls_playback.html` | Isolate frontend from source format |

---

## Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 403 on HLS segments | Signed master.m3u8, relative refs lose signature | Make `hls/` public-read |
| `minio:9000` in browser URL | Used `AWS_S3_ENDPOINT_URL` instead of `PUBLIC_MEDIA_ENDPOINT_URL` | Use `get_hls_playback_url()` |
| CORS preflight fails | `Range` header not allowed | Add `Range` to MinIO CORS allow headers |
| MPEG-TS magic not found | FFmpeg used fMP4 instead of mpegts | `-hls_segment_type mpegts` |
| Signed URL expires mid-playback | `querystring_expire` too short | Increase `AWS_S3_QUERYSTRING_EXPIRE` (for uploads only) |

---

*Source: `backend/app/media_urls.py`, `backend/EchoFlow/settings.py`, `docker-compose.yml`, `docs/minio-s3-architecture.md`*