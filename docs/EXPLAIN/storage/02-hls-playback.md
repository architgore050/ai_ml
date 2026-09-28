# HLS Playback: Why Signed URLs Don't Work

## The Core Problem

**HLS is a multi-file protocol.** A single signed URL cannot authorize a stream of dozens of objects.

---

## HLS Structure

```
master.m3u8
  │
  ├── variant_0.m3u8 (192kbps)        ← Relative reference
  │    ├── segment_000.ts              ← Relative reference
  │    ├── segment_001.ts
  │    └── ...
  ├── variant_1.m3u8 (128kbps)
  │    ├── segment_000.ts
  │    └── ...
  └── variant_2.m3u8 (64kbps)
       └── ...
```

---

## Signed URL Failure

### Attempt 1: Sign master.m3u8
```python
# Signed URL for master
https://bucket.s3.amazonaws.com/hls/abc/master.m3u8?signature=xyz&expires=123
```

### Browser Behavior
1. Loads signed `master.m3u8` ✓ (200 OK)
2. Parses `variant_0.m3u8` (relative path)
3. Resolves: `https://bucket.s3.amazonaws.com/hls/abc/variant_0.m3u8` **NO SIGNATURE**
4. Requests variant → **403 Forbidden**

### RFC 3986 Section 5.2.2
> "A relative reference ... does not include a scheme or authority ... the query component is not carried forward."

**The query string (signature) is stripped** when resolving relative references.

---

## Why This Affects ALL Object Storage

| Storage | Behavior |
|---------|----------|
| AWS S3 | Same — signed URLs don't work for HLS |
| Google Cloud Storage | Same |
| Azure Blob | Same |
| MinIO | Same |
| Cloudflare R2 | Same |

**Not a MinIO bug** — fundamental to HTTP + signed URL design.

---

## Failed Workarounds

### 1. Sign Every Segment Individually
```python
# Generate signed URL for each segment
for segment in segments:
    signed_urls[segment] = generate_signed_url(segment)
```
**Problems:**
- Master playlist must be rewritten with signed URLs
- Signatures expire → playlist becomes invalid mid-playback
- 100s of signed URLs per clip → massive overhead

### 2. Proxy Through Backend
```python
# Backend proxies all segment requests
GET /api/media/hls/{clip_id}/segment_000.ts
    │
    ▼
Backend generates signed URL → proxies bytes
```
**Problems:**
- Backend becomes media server (bandwidth, latency)
- Defeats purpose of object storage + CDN
- No range request support without complex code

### 3. CloudFront Signed Cookies
```python
# CloudFront signed cookie for entire hls/ prefix
Set-Cookie: CloudFront-Policy=...; CloudFront-Signature=...; CloudFront-Key-Pair-Id=...
```
**Problems:**
- Requires CloudFront (not raw S3/MinIO)
- Complex cookie management
- Still need backend to issue cookies

---

> **⚠️ HISTORICAL. EchoFlow does NOT do this.** The public-read `hls/`
> arrangement described below was the pre-token-protection design. It is kept
> for the reasoning about *why query-string signing fails*, which still holds.
> Current state: `hls/` is **private**, served through the Cloudflare Worker at
> `media.echoflow.in` (or nginx `:9443` locally), which validates a
> short-lived HMAC credential per clip. Never run
> `mc anonymous set download .../hls` — it makes every transcript readable
> without a token. See [`04-hls-token-protection.md`](04-hls-token-protection.md).

## Working Solution: Public-Read Derived Content (historical)

### Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                      S3 Bucket                               │
├──────────────────────┬──────────────────────────────────────┤
│ uploads/ (private)   │ hls/ (public-read)                    │
│                      │                                        │
│ - Original uploads   │ - master.m3u8                         │
│ - Scraper originals  │ - variant playlists                   │
│ - Require signed URL │ - .ts segments                        │
│ - User content       │ - Anonymous access OK                 │
└──────────────────────┴──────────────────────────────────────┘
```

### Bucket Policy (MinIO)
```bash
# Private by default
# Public-read ONLY for hls/ prefix
mc anonymous set download local/echoflow-media/hls
```

### URL Generation
```python
# HLS: Unsigned public URL
def get_hls_playback_url(object_key):
    return f"{PUBLIC_MEDIA_ENDPOINT_URL}/{bucket}/{object_key}"

# Originals: Signed URL
def get_signed_media_url(object_key):
    return boto3.generate_presigned_url(...)
```

---

## Security Analysis

### What's Exposed
- **HLS streams** (transcoded, 128kbps AAC)
- No metadata, no originals
- No user PII

### What's Protected
- **Original uploads** (full quality, user content)
- **Scraper originals** (licensing compliance)
- **User avatars** (PII)

### Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| HLS URL leaked | Medium | Low (transcoded copy) | Rotate clip IDs, monitor access logs |
| Enumeration attack | Low | Low | UUIDs unguessable |
| Hotlinking | Medium | Bandwidth cost | CloudFront referrer check, token auth later |

**Industry standard:** Netflix, Spotify, YouTube all serve HLS publicly.

---

## Implementation in EchoFlow

### MinIO Init (`docker-compose.yml`)
```bash
# ⛔ OBSOLETE — do not run. This is what made hls/ world-readable.
# The bucket is left fully private; minio-init only creates it.
mc mb --ignore-existing local/echoflow-media
```

### URL Generation (`media_urls.py`)
```python
def get_hls_playback_url(object_key):
    """Unsigned public URL for hls/ content"""
    bucket = settings.STORAGES["default"]["OPTIONS"]["bucket_name"]
    endpoint = (settings.PUBLIC_MEDIA_ENDPOINT_URL or "").rstrip("/")
    return f"{endpoint}/{bucket}/{object_key}"

def get_signed_media_url(object_key):
    """Signed URL for uploads/ content"""
    client = boto3.client(...)
    return client.generate_presigned_url(...)
```

### Serializer Usage
```python
# FeedClipSerializer
def get_hls_playlist_url(self, obj):
    return get_hls_playback_url(obj.hls_playlist_url)

# ShareEventSerializer  
def get_clip_hls_url(self, obj):
    return get_hls_playback_url(obj.clip.hls_playlist_url)
```

---

## Verification

### Test Signed URL Failure
```bash
# 1. Generate signed master.m3u8
# 2. Play in browser → works
# 3. Check network tab → segment requests 403
```

### Test Public HLS Success
```bash
# 1. Get unsigned URL via get_hls_playback_url()
# 2. Play in browser → works
# 3. Check network tab → all segments 200
```

### Scripts
```bash
# Verify HLS playback end-to-end
./scripts/verify_hls_playback.html

# Check segment format
./scripts/verify_decoder_rootcause.sh hls/clip_id/segment_000.ts
```

---

## Future: Token Auth for HLS (If Needed)

> **Status: PLANNED.** See `04-hls-token-protection.md` for the full design and
> implementation plan. This section is retained as a historical record of the
> evolution from "public HLS" to "token-gated HLS".

### Cloudflare Worker + Signed Cookies (Production)

The recommended approach for token-protected HLS over Cloudflare R2:

1. R2 bucket `hls/` prefix is **private** — this is the shipped state, not a
   future step (remove any public-read bucket policy)
2. A [Cloudflare Worker](https://developers.cloudflare.com/workers/) at `media.echoflow.in`
   validates an HMAC-signed cookie on every `/hls/*` request
3. If valid → Worker proxies to R2 via the Workers R2 binding (`env.HLS_BUCKET.get(key, {range: request.headers})`)
4. If invalid → 403

The cookie is set by a Django API endpoint
(`GET /api/v1/media/playback-token/<clip_id>/`) and is automatically sent by
the browser on all HLS subrequests (master.m3u8, variant playlists, segments)
because cookies are not stripped by RFC 3986 relative-reference resolution.

Worker-free alternative (Pro plan+): Cloudflare WAF `is_timed_hmac_valid_v0()`
can validate a query-string token, but this requires the token to be present on
every subrequest URL — which hls.js achieves via `xhrSetup` to inject the token
into each manifest and segment request. The signed-cookie approach is simpler
and requires no hls.js configuration changes.

---

*Source: `backend/app/media_urls.py`, `docker-compose.yml`, `docs/minio-s3-architecture.md`, RFC 3986*