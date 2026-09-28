# HLS Token Protection — Short-Lived Play Tokens for HLS Streams

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Why Signed URLs Don't Work for HLS](#2-why-signed-urls-dont-work-for-hls)
3. [Why Signed Cookies Are the Solution](#3-why-signed-cookies-are-the-solution)
4. [Token Design](#4-token-design)
5. [Option A — Cloudflare Worker (Production)](#5-option-a--cloudflare-worker-production)
6. [Option B — nginx + njs (Development)](#6-option-b--nginx--njs-development)
7. [Files That Change — Complete Inventory](#7-files-that-change--complete-inventory)
8. [Backend Changes (Shared by Both Options)](#8-backend-changes-shared-by-both-options)
9. [Frontend Changes (Shared by Both Options)](#9-frontend-changes-shared-by-both-options)
10. [Deployment Changes](#10-deployment-changes)
11. [Testing Strategy](#11-testing-strategy)
12. [Migration / Rollback Plan](#12-migration--rollback-plan)
13. [Cost Analysis](#13-cost-analysis)
14. [Comparison Matrix: Worker vs nginx](#14-comparison-matrix-worker-vs-nginx)

---

## 1. Problem Statement

### Current State

The `hls/` prefix in the S3-compatible object storage bucket is made **public-read** via a bucket policy:

- **Local dev (MinIO)**: `mc anonymous set download local/echoflow-media/hls` in the `minio-init` service (`docker-compose.yml:228`)
- **Production (Cloudflare R2)**: Bucket policy JSON grants `s3:GetObject` on `arn:aws:s3:::echoflow-media/hls/*` to `Principal: "*"` (`docs/EXPLAIN/storage/03-bucket-policies.md:40-55`, `docs/EXPLAIN/DEPLOYMENT/04-cloudflare-config.md:41-53`)

This means **anyone** who knows or guesses a clip's UUID can download the HLS master playlist, variant playlists, and all segments — forever. There is:

- No authentication gate
- No expiry
- No rate limiting at the storage layer
- No per-user tracking of who accessed what
- No ability to revoke access for a compromised session

### Attack Vectors

| Attack | Current Impact | With Token Protection |
|--------|----------------|----------------------|
| URL scraping | Anyone with a clip URL can download segments indefinitely | Token expires in 10 min; requires valid session |
| DDOS on R2 egress | Unlimited segment requests from anonymous IPs | Worker returns 403 before hitting R2; Cloudflare WAF can rate-limit |
| Hotlinking | Third-party sites can embed HLS players pointing at your R2 | Cookie scope restricts to authenticated sessions |
| Enumeration | UUIDs are unguessable, but once known, content is permanent | Even if UUID is known, token is required |
| Viewbot inflation | Bots can repeatedly fetch the same segments | Rate-limited at the edge (Worker + WAF) |

### User Requirements (from discussion)

1. Cloudflare R2 is already in use (confirmed)
2. Token scope: **per-clip** (token only valid for `hls/<clip_id>/*`)
3. TTL: **10 minutes** (600 seconds)
4. Production: Cloudflare Worker (edge-level, cost-effective at 5-10 users)
5. Token tied to **authenticated user** (JWT-based)
6. Dev parity: nginx-based validation for local MinIO setup

---

## 2. Why Signed URLs Don't Work for HLS

**HLS is a multi-file protocol.** A single signed URL cannot authorize a stream made of dozens of objects.

### The RFC 3986 Problem

A signed URL's signature lives in its **query string**:
```
https://media.echoflow.in/hls/abc-123/master.m3u8?verify=1234567890-abcdef==
```

The `master.m3u8` playlist references variant playlists via **relative paths**:
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=192000
index.m3u8
```

Per RFC 3986 §5.2.2, resolving a relative reference against a base URL **does NOT carry the base URL's query string forward**. So:

1. Browser loads signed `master.m3u8` → ✓ 200 OK
2. Browser resolves `index.m3u8` (relative) → `https://media.echoflow.in/hls/abc-123/index.m3u8` — **no signature**
3. Browser requests `index.m3u8` → ✗ 403 Forbidden

This is true against **all** S3-compatible storage: AWS S3, Google Cloud Storage, Azure Blob, MinIO, and Cloudflare R2. It is not a bug — it is fundamental to how HTTP + signed URLs work.

This is documented in detail in:
- `backend/app/media_urls.py:12-33` (module docstring)
- `docs/EXPLAIN/storage/02-hls-playback.md` (full writeup)
- `docs/EXPLAIN/storage/03-bucket-policies.md` (current bucket policy)

### Why the WAF HMAC Feature Alone Doesn't Solve It

Cloudflare's `is_timed_hmac_valid_v0()` ([WAF docs](https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/)) validates an HMAC token in the **query string**. Since the query string doesn't carry forward to HLS subrequests (same RFC 3986 problem), this approach alone cannot protect multi-file HLS streams.

The "protect an entire URI path prefix" variant ([docs](https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/#protect-an-entire-uri-path-prefix-with-a-single-signature)) signs a **fixed-length prefix** and validates it against all requests under that prefix. But the signature still lives in the query string, so it still doesn't propagate to relative HLS references.

**A proxy or cookie-validation layer is required.** This is the architectural gap this document fills.

---

## 3. Why Signed Cookies Are the Solution

### The Cookie Advantage

Unlike query-string signatures, **HTTP cookies are sent automatically by the browser on every request to the cookie's domain and path**. hls.js makes standard HTTP requests (fetch/XHR) for the master playlist, variant playlists, and segments — all to the same origin (`media.echoflow.in`). A cookie scoped to `Path=/hls/` will be included on **every** HLS subrequest without any frontend URL manipulation.

```
Browser cookie jar:
  Domain: media.echoflow.in (or .echoflow.in for shared scope)
  Path:   /hls/
  Name:   ef_hls_token
  Value:  <hmac_signed_token>

Every request to:
  https://media.echoflow.in/hls/<clip_id>/master.m3u8  → cookie sent ✓
  https://media.echoflow.in/hls/<clip_id>/index.m3u8   → cookie sent ✓
  https://media.echoflow.in/hls/<clip_id>/segment_0.ts → cookie sent ✓
```

### Validation Layer Placement

| Option | Where validation happens | Why it works for HLS |
|--------|-------------------------|---------------------|
| **A: Cloudflare Worker** | Edge (Cloudflare global network) | Cookie sent on all HLS requests; Worker validates and proxies to R2 |
| **B: nginx + njs** | VPS (single region) | Cookie sent on all HLS requests; nginx validates and proxies to MinIO |

Both options share the same token format, the same Django API endpoint for token issuance, and the same frontend integration. The only difference is the **validation layer** between the browser and object storage.

---

## 4. Token Design

### Token Format

```
ef_hls_token = base64url(payload):hmac_sha256(secret, payload)
```

**Payload** (JSON, base64url-encoded):
```json
{
  "u": 42,                          // user_id (integer)
  "c": "hls/abc-123",               // clip key prefix (hls/<clip_id>)
  "exp": 1725000000,                // expiry timestamp (UNIX epoch, seconds)
  "iat": 1724996400,                // issued-at timestamp
  "v": 1                            // token version (for future upgrades)
}
```

**HMAC computation:**
```python
payload_b64 = base64url_encode(json.dumps(payload))
signature = hmac_sha256(Media_TOKEN_SECRET, payload_b64)
token = f"{payload_b64}.{signature}"
```

### Token Properties

| Property | Value | Rationale |
|----------|-------|-----------|
| **Scope** | Per-clip (`hls/<clip_id>`) | A token issued for one clip cannot be reused for another |
| **TTL** | 600 seconds (10 min) | Short enough to limit exposure window; long enough for a full playback session |
| **Algorithm** | HMAC-SHA256 | Compatible with Worker `crypto.subtle.verify` and nginx `njs` `crypto` module; no external dependencies |
| **Secret** | `MEDIA_TOKEN_SECRET` env var | Separate from `DJANGO_SECRET_KEY` so the Worker can share it as a Cloudflare secret without exposing Django's signing key |
| **Cookie flags** | `Secure; HttpOnly; SameSite=Lax; Path=/hls/; Max-Age=600` | Secure = HTTPS only; HttpOnly = JS cannot read (reduces XSS theft); SameSite=Lax = CSRF protection |

### Per-Clip Scope Enforcement

The validation layer checks that every request's path starts with the `c` field from the token. For example, a token with `c: "hls/abc-123"` only authorizes paths under `/hls/abc-123/`. A request to `/hls/def-456/master.m3u8` returns 403, even if the cookie is valid.

This is the per-clip isolation the user requested. If the user wants session-wide access later, set `c` to `"hls/*"` (but that weakens per-clip isolation).

### Token Refresh

The frontend proactively fetches a new token when the old one is about to expire:
- If the current token expires in < 120 seconds, request a fresh one
- Token refresh happens silently (no user interaction)
- If the user's JWT has expired, the token request returns 401 and the frontend triggers session refresh via the existing `refreshToken` mechanism in `frontend/.../api/client.ts:54-63`

---

## 5. Option A — Cloudflare Worker (Production)

### Architecture

```
Browser (app.echoflow.in)
  │
  │ GET /feed/  (JWT authenticated)
  ▼
API (api.echoflow.in → Cloudflare Tunnel → nginx → gunicorn → Django)
  │
  │ Response: clips with hls_playlist_url: "https://media.echoflow.in/hls/<id>/master.m3u8"
  │
  │ GET /media/playback-token/<clip_id>/  (JWT authenticated)
  │ ←→ Set-Cookie: ef_hls_token=...; Domain=.echoflow.in; Path=/hls/
  ▼
Browser cookie jar now contains ef_hls_token for media.echoflow.in/hls/
  │
  │ GET https://media.echoflow.in/hls/<clip_id>/master.m3u8  (cookie auto-sent)
  ▼
Cloudflare Worker (media.echoflow.in → Worker route)
  │
  │ 1. Validate ef_hls_token cookie (HMAC + expiry + clip scope)
  │ 2. If invalid → 403
  │ 3. If valid → proxy to R2 (env.HLS_BUCKET.get(key, { range: headers }))
  ▼
R2 (private bucket, hls/ prefix no longer public-read)
```

### Worker File Structure

```
workers/hls-token-worker/
├── wrangler.toml           # Worker config: R2 binding, name, route
├── src/
│   ├── index.ts            # fetch() handler: validate cookie → proxy to R2
│   ├── token.ts            # Shared token types (mirrors Django service)
│   └── config.ts           # Constants (TTL, cookie name, etc.)
├── package.json            # @cloudflare/workers-types
└── README.md               # Deployment + secret setup instructions
```

### Worker Logic (`src/index.ts`)

```typescript
import { parseCookies, validateHLSCookie } from './token';
import { HLS_BUCKET } from './config'; // env binding name

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Only protect /hls/ paths — allow everything else to pass through to R2
    if (!url.pathname.startsWith('/hls/')) {
      // Forward to R2 via S3-compatible endpoint (bucket root access, if needed)
      return fetch(request);
    }

    // Step 1: Extract cookie
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const token = cookies['ef_hls_token'];
    
    // Step 2: Validate token (HMAC + expiry + clip scope)
    const validation = await validateHLSCookie(token, env.MEDIA_TOKEN_SECRET, url.pathname);
    if (!validation.valid) {
      return new Response(validation.error || 'Forbidden', { status: 403 });
    }

    // Step 3: Proxy to R2 via binding (supports Range headers for HLS seeking)
    const objectKey = url.pathname.slice(1); // strip leading /
    const object = await env.HLS_BUCKET.get(objectKey, {
      range: request.headers,  // forwards Range header for partial content
      onlyIf: request.headers, // forwards If-Match, If-None-Match, etc.
    });

    if (object === null) {
      return new Response('Object Not Found', { status: 404 });
    }

    // Step 4: Stream response with proper headers
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag || '');
    headers.set('cache-control', 'public, max-age=120'); // 2 min CDN cache
    
    return new Response(object.body, { status: 200, headers });
  },
};
```

### Worker `wrangler.toml`

```toml
name = "echoflow-hls-token"
main = "src/index.ts"
compatibility_date = "2026-09-01"

# Route: media.echoflow.in/* → Worker (replaces direct R2 custom domain)
routes = [{ pattern = "media.echoflow.in/*", zone_name = "echoflow.in" }]

# R2 bucket binding (the same bucket EchoFlow uses)
[[r2_buckets]]
binding = "HLS_BUCKET"
bucket_name = "echoflow-media"

# Secrets (set via: npx wrangler secret put MEDIA_TOKEN_SECRET)
[vars]
MEDIA_TOKEN_SECRET = ""  # placeholder; actual value set as encrypted secret
```

### Worker Deployment

```bash
# 1. Navigate to worker directory
cd workers/hls-token-worker

# 2. Install dependencies
npm install

# 3. Deploy
npx wrangler deploy

# 4. Set the secret (shared with Django via .env)
npx wrangler secret put MEDIA_TOKEN_SECRET
# (paste the same value as MEDIA_TOKEN_SECRET in your VPS .env)

# 5. Update Cloudflare DNS: media.echoflow.in now points to the Worker,
#    not directly to R2. The R2 custom domain is removed.
```

### Worker Token Validation (`src/token.ts`)

```typescript
import { Buffer } from 'node:buffer';

interface HLSCookiePayload {
  u: number;           // user_id
  c: string;           // clip prefix, e.g. "hls/abc-123"
  exp: number;         // expiry epoch (seconds)
  iat: number;         // issued-at epoch
  v: number;           // version
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

export async function validateHLSCookie(
  token: string | undefined,
  secret: string,
  requestPath: string
): Promise<ValidationResult> {
  if (!token) {
    return { valid: false, error: 'Missing token' };
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return { valid: false, error: 'Malformed token' };
  }

  const secretKeyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw', secretKeyData, { name: 'HMAC', hash: 'SHA-256' },
    false, ['verify']
  );

  const receivedSig = Buffer.from(signature, 'base64url');
  const expectedSig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(payloadB64)
  );

  // Timing-safe comparison
  if (!await crypto.subtle.verify('HMAC', key, receivedSig, new TextEncoder().encode(payloadB64))) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Parse payload
  let payload: HLSCookiePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return { valid: false, error: 'Invalid payload' };
  }

  // Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { valid: false, error: 'Token expired' };
  }

  // Check clip scope: request path must start with the clip prefix
  // requestPath is like "/hls/abc-123/master.m3u8"
  // payload.c is like "hls/abc-123"
  const expectedPrefix = '/' + payload.c + '/';
  if (!requestPath.startsWith(expectedPrefix)) {
    return { valid: false, error: 'Token scope mismatch' };
  }

  return { valid: true };
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach(c => {
    const [name, value] = c.trim().split('=');
    if (name && value) cookies[name] = value;
  });
  return cookies;
}
```

### Cloudflare WAF Rules (Optional Defense-in-Depth)

Create a WAF custom rule to block requests to `/hls/*` that **lack** the `ef_hls_token` cookie **before** they even reach the Worker (reduces Worker invocations):

```
Field: http.cookie
Operator: not contains
Value: ef_hls_token
```

This rule returns a 403 for anonymous requests, ensuring no Worker invocation for scrapers. Requires a **Pro, Business, or Enterprise** Cloudflare plan.

---

## 6. Option B — nginx + njs (Development)

### Architecture

```
Browser (localhost:5173, Vite dev server)
  │
  │ GET https://localhost/api/v1/media/playback-token/<clip_id>/
  │ ←→ Set-Cookie: ef_hls_token=...; Domain=localhost; Path=/hls/
  ▼
Browser cookie jar
  │
  │ GET https://localhost:9443/hls/<clip_id>/master.m3u8  (cookie auto-sent)
  ▼
nginx (TLS terminator, port :9443)
  │
  │ js_access handler validates ef_hls_token cookie:
  │ 1. HMAC-SHA256 verification using MEDIA_TOKEN_SECRET
  │ 2. Expiry check
  │ 3. Clip-scope check (path starts with /hls/<clip_id>/)
  │ 4. If invalid → 403
  │ 5. If valid → proxy_pass to MinIO (:9000)
  ▼
MinIO (localhost:9000, hls/ prefix is now PRIVATE)
```

### File Structure

```
docker/
├── nginx/
│   ├── hls_auth.js        # njs script: HMAC cookie validation
│   └── hls_auth.wasm     # (placeholder — not needed, pure JS)
└── nginx.conf             # ADD: js_import + js_access on :9443 server
```

### nginx.conf Changes

**Current** (lines 139-170): The `:9443` server block proxies all requests to MinIO without any auth check:
```nginx
server {
    listen 9443 ssl;
    http2 on;
    server_name _;
    # ... ssl config ...
    
    location / {
        proxy_pass http://minio_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

**After** (add njs import + js_access on /hls/):
```nginx
# ADD at top of http {} block:
js_import hls_auth from /etc/nginx/hls_auth.js;

# Modified :9443 server block:
server {
    listen 9443 ssl;
    http2 on;
    server_name _;
    # ... ssl config ...

    proxy_buffering off;
    proxy_request_buffering off;

    # Only /hls/ requires token auth
    location /hls/ {
        js_access hls_auth.validate;
        proxy_pass http://minio_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Health check endpoint (no auth, used by docker-compose healthcheck)
    location /minio/health/live {
        proxy_pass http://minio_backend;
    }

    location / {
        # Other MinIO paths (console, API) remain accessible for dev
        proxy_pass http://minio_backend;
    }
}
```

### njs Script (`docker/nginx/hls_auth.js`)

```javascript
import { Buffer } from 'node:buffer';

// How to configure njs in nginx.conf:
// js_import hls_auth from /etc/nginx/hls_auth.js;
// js_set $hls_token_valid hls_auth.setValid;
//
// The js_access function runs before proxy_pass and must call
// r.return(403) to reject or simply return to allow.

async function readRequestBody(r) { /* no-op for GET */ }

async function verifyHLSCookie(r) {
  // Extract cookie from headers
  const cookieHeader = r.headersIn['cookie'] || '';
  const cookies = cookieHeader.split(';').reduce((acc, c) => {
    const [name, value] = c.trim().split('=');
    if (name && value) acc[name.trim()] = value.trim();
    return acc;
  }, {});

  const token = cookies['ef_hls_token'];
  if (!token) {
    r.return(403, 'Missing HLS token');
    return false;
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    r.return(403, 'Malformed HLS token');
    return false;
  }

  const secret = process.env.MEDIA_TOKEN_SECRET || '';
  if (!secret) {
    r.return(503, 'Token validation unavailable (no secret configured)');
    return false;
  }

  // Verify HMAC signature
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw', keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify']
    );

    const receivedSig = Buffer.from(signature, 'base64');
    const isValid = await crypto.subtle.verify(
      'HMAC', key, receivedSig, encoder.encode(payloadB64)
    );

    if (!isValid) {
      r.return(403, 'Invalid HLS token signature');
      return false;
    }
  } catch (e) {
    r.return(403, 'HMAC verification error');
    return false;
  }

  // Parse payload (synchronous — JSON.parse in njs)
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
  } catch {
    r.return(403, 'Invalid payload encoding');
    return false;
  }

  // Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    r.return(403, 'HLS token expired');
    return false;
  }

  // Check clip scope
  const expectedPrefix = '/' + payload.c + '/';
  if (!r.uri.startsWith(expectedPrefix)) {
    r.return(403, 'HLS token scope mismatch');
    return false;
  }

  return true; // Allow request
}

// js_access handler — called before proxy_pass
async function validate(r) {
  const ok = await verifyHLSCookie(r);
  if (!ok) return; // r.return() already called, request terminated
  // Returning normally from js_access allows the request to proceed
}
```

### Dockerfile Changes

**Current Dockerfile uses `nginx:1.27-alpine`**. The njs module is **not** included in the base Alpine nginx image. We need to switch to an image that includes njs:

```dockerfile
# FROM nginx:1.27-alpine  (current)
FROM nginx:1.27-alpine  # Add njs module via apk
RUN apk add --no-cache nginx-mod-njs
```

Or use the official njs image variant. The `js_import` directive requires the `ngx_http_js_module` which is provided by `nginx-mod-njs`.

### minio-init Changes

**Current** (`docker-compose.yml:224-229`):
```bash
mc anonymous set download local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}/hls
```

**After** (remove public-read on hls/):
```bash
# Do NOT make hls/ public — token protection is handled by nginx/Worker
# Only create the bucket; leave all prefixes private
mc mb --ignore-existing local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}
```

---

## 7. Files That Change — Complete Inventory

This is the exhaustive list of every file that will be modified or created, organized by category.

### New Files (Option A — Worker)

| File | Purpose |
|------|---------|
| `workers/hls-token-worker/wrangler.toml` | Worker configuration: R2 binding, route mapping |
| `workers/hls-token-worker/src/index.ts` | Worker fetch handler: cookie validation + R2 proxy |
| `workers/hls-token-worker/src/token.ts` | Token validation logic (HMAC, expiry, scope) |
| `workers/hls-token-worker/src/config.ts` | Constants (TTL, cookie name, token version) |
| `workers/hls-token-worker/package.json` | TypeScript dependencies |
| `workers/hls-token-worker/README.md` | Deployment and secret setup instructions |

### New Files (Option B — nginx njs)

| File | Purpose |
|------|---------|
| `docker/nginx/hls_auth.js` | njs script for HMAC cookie validation |

### New Files (Shared — Backend)

| File | Purpose |
|------|---------|
| `backend/app/services/hls_token.py` | Token generation and validation service (Python HMAC) |
| `backend/app/views/media_views.py` | `PlaybackTokenView` — JWT-authenticated API endpoint for token issuance |
| `backend/app/tests/test_hls_token.py` | Unit tests for token generation/validation |

### New Files (Shared — Frontend)

| File | Purpose |
|------|---------|
| `frontend/sample_frontend/src/data/hlsToken.ts` | `getPlaybackToken(clipId)` API call + cookie setter |

### Modified Files (Shared — Backend)

| File | Change | Why |
|------|--------|-----|
| `backend/app/views/__init__.py` | Add `from .media_views import PlaybackTokenView` to imports + `__all__` | Register the new view in the views package |
| `backend/app/urls.py` | Add `path('media/playback-token/<uuid:clip_id>/', PlaybackTokenView.as_view())` to urlpatterns | Expose the token endpoint to the API |
| `backend/EchoFlow/settings.py` | Add `MEDIA_TOKEN_SECRET` and `MEDIA_TOKEN_TTL_SECONDS` to env-driven settings | Config: token signing secret and TTL |
| `.env.example` | Add `MEDIA_TOKEN_SECRET` and `MEDIA_TOKEN_COOKIE_DOMAIN` | New env template for dev |
| `.env.vps.example` | Add `MEDIA_TOKEN_SECRET` (and note: same value goes into Worker as Cloudflare secret) | New env template for production |
| `.env.laptop.example` | Add `MEDIA_TOKEN_SECRET` (must match VPS) | Laptop worker connects to same Redis/DB; needs same secret for any token operations |

### Modified Files (Shared — Frontend)

| File | Change | Why |
|------|--------|-----|
| `frontend/sample_frontend/src/api/client.ts` | Add `mediaAPI.getPlaybackToken(clipId)` function | Frontend needs to call the token endpoint |
| `frontend/sample_frontend/src/stores/player.tsx` | Call `getPlaybackToken()` in `loadSource()` before `hls.loadSource()` | Token must be in cookie jar before HLS requests fire |
| `frontend/sample_frontend/vite.config.ts` | Add `/media` proxy entry (if not already present) | Dev proxy for the token endpoint |
| `frontend/sample_frontend/.env.example` or similar | Add `VITE_HLS_COOKIE_DOMAIN` | Frontend needs to know which domain to set the cookie for |

### Modified Files (Option A Only — Worker Deployment)

| File | Change | Why |
|------|--------|-----|
| `docs/EXPLAIN/DEPLOYMENT/04-cloudflare-config.md` | Update: `media.echoflow.in` now points to Worker, not R2 direct | Document the new deployment step |
| `docs/EXPLAIN/DEPLOYMENT/02-vps-setup.md` | Add Worker deployment step | Operational guide update |
| `scripts/vps-deploy.sh` | Add optional Worker deploy step | Automate deployment |

### Modified Files (Option B Only — Dev Stack)

| File | Change | Why |
|------|--------|-----|
| `docker/Dockerfile` | Install `nginx-mod-njs` in the nginx image | njs module required for in-nginx HMAC validation |
| `docker/nginx.conf` | Add `js_import hls_auth` + `js_access` on `:9443` `/hls/` location | Token validation before proxying to MinIO |
| `docker-compose.yml` | Remove `mc anonymous set download .../hls` from minio-init | `hls/` is now private; nginx handles auth |
| `scripts/test_minio_edge_cases.py` | Update: `hls/` is now 403 without auth (expected, not a fix) | Test expectations change |
| `docs/EXPLAIN/storage/02-hls-playback.md` | Update "Working Solution" section: now uses signed cookies | Documentation must match implementation |
| `docs/EXPLAIN/storage/03-bucket-policies.md` | Update: `hls/` is no longer public-read | Documentation must match implementation |
| `docs/EXPLAIN/docker/05-https-tls-termination.md` | Update `:9443` section: now has auth layer | Architecture doc update |

### Modified Files (Env Templates)

| File | Change |
|------|--------|
| `.env.example` | Add `MEDIA_TOKEN_SECRET` (generate: `python -c "import secrets; print(secrets.token_urlsafe(32))"`) |
| `.env.vps.example` | Add `MEDIA_TOKEN_SECRET` + note about Worker secret sync |
| `scripts/check_no_tracked_env.sh` | Add `MEDIA_TOKEN_SECRET` to the list of vars that must not be `DJANGO_DEBUG=True` (if applicable) |

---

## 8. Backend Changes (Shared by Both Options)

### 8.1 Token Service — `backend/app/services/hls_token.py`

This is the single source of truth for token generation. Both the Django API (issuance) and the Worker/njs (validation) use the same HMAC algorithm. The token format is defined here.

```python
"""HLS playback token service.

Generates short-lived, per-clip, user-bound HMAC tokens for HLS playback access.
The token is a signed cookie that browsers send automatically on all HLS
subrequests (master.m3u8, variant playlists, segments) — unlike query-string
signatures, cookies are not stripped by RFC 3986 relative-reference resolution.

The validation counterpart lives in:
  - Cloudflare Worker:  workers/hls-token-worker/src/token.ts  (production)
  - nginx njs:          docker/nginx/hls_auth.js               (dev)

Both implementations MUST match this file's algorithm exactly:
  - payload = base64url(JSON({u, c, exp, iat, v}))
  - token   = payload + "." + base64url(HMAC-SHA256(secret, payload))

DECISION: Using HMAC-SHA256 with a symmetric key (not JWT) because:
  1. No dependency on PyJWT in the Worker (WebCrypto API suffices)
  2. Smaller token size than JWT (no base64 JSON header)
  3. Symmetric key is fine because the issuer and validator share the same secret
"""
import base64
import hmac
import hashlib
import json
import time
from django.conf import settings

COOKIE_NAME = "ef_hls_token"
TOKEN_VERSION = 1

def _get_secret() -> bytes:
    secret = getattr(settings, "MEDIA_TOKEN_SECRET", "")
    if not secret:
        raise RuntimeError("MEDIA_TOKEN_SECRET is not set in environment")
    return secret.encode("utf-8")

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def _b64url_decode(data: str) -> bytes:
    padding = 4 - (len(data) % 4)
    if padding < 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)

def generate_playback_token(user_id: int, clip_key: str) -> str:
    """Generate a short-lived, per-clip HMAC token for HLS playback.

    Args:
        user_id: The authenticated Django user's ID.
        clip_key: The object storage key prefix (e.g. "hls/<clip_id>").

    Returns:
        Token string: base64url(payload).base64url(hmac_sha256(secret, payload))
    """
    now = int(time.time())
    ttl = int(getattr(settings, "MEDIA_TOKEN_TTL_SECONDS", 600))
    payload = {
        "u": user_id,
        "c": clip_key,        # e.g. "hls/abc-123-def" — per-clip scope
        "exp": now + ttl,
        "iat": now,
        "v": TOKEN_VERSION,
    }
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = _b64url_encode(payload_json.encode("utf-8"))
    signature = hmac.new(_get_secret(), payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = _b64url_encode(signature)
    return f"{payload_b64}.{sig_b64}"

def validate_playback_token(token: str, request_path: str) -> dict | None:
    """Validate a playback token. Returns the decoded payload dict if valid,
    None otherwise.

    Args:
        token: The token string (payload.signature).
        request_path: The full request path (e.g. "/hls/abc-123/master.m3u8").

    Returns:
        Payload dict if valid, None if invalid/expired/scope-mismatched.
    """
    if not token or "." not in token:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None

    payload_b64, sig_b64 = parts

    # HMAC verification (timing-safe)
    expected_sig = hmac.new(_get_secret(), payload_b64.encode("ascii"), hashlib.sha256).digest()
    try:
        received_sig = _b64url_decode(sig_b64)
    except Exception:
        return None

    if not hmac.compare_digest(expected_sig, received_sig):
        return None

    # Parse payload
    try:
        payload_json = _b64url_decode(payload_b64)
        payload = json.loads(payload_json)
    except Exception:
        return None

    # Check token version
    if payload.get("v") != TOKEN_VERSION:
        return None

    # Check expiry
    if int(time.time()) > payload["exp"]:
        return None

    # Check clip scope: request path must start with /<clip_key>/
    expected_prefix = "/" + payload["c"] + "/"
    if not request_path.startswith(expected_prefix):
        return None

    return payload
```

### 8.2 API View — `backend/app/views/media_views.py`

A new view following the same pattern as `GrievanceCreateView` (in `views/grievance.py`) — a simple `APIView` with JWT authentication.

```python
"""Media playback token views.

ISSUE: HLS content in the `hls/` prefix was previously public-read (bucket policy).
This view issues short-lived, per-clip, user-bound HMAC tokens as signed cookies
so the Cloudflare Worker (prod) or nginx njs (dev) can validate them before
serving HLS content from R2/MinIO.

The token format is defined in backend.app.services.hls_token.
The validation counterparts live in:
  - workers/hls-token-worker/src/token.ts   (production Worker)
  - docker/nginx/hls_auth.js                 (dev nginx)
"""
import os
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.throttling import ScopedRateThrottle

from ..models import AudioClip
from ..services.hls_token import generate_playback_token, COOKIE_NAME


class PlaybackTokenView(APIView):
    """Issue a short-lived HLS playback token as a signed cookie.

    GET /api/v1/media/playback-token/<clip_id>/

    Requires JWT authentication. Returns 200 with the token cookie set.
    The cookie is scoped to Path=/hls/ so it's sent on every HLS subrequest
    (master.m3u8, variant playlists, segments).

    The cookie Domain attribute is set from MEDIA_TOKEN_COOKIE_DOMAIN (default:
    the current request's domain). In production, this should be the parent
    domain (e.g. ".echoflow.in") so it covers both api.echoflow.in and
    media.echoflow.in.
    """
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'interaction'  # reuse interaction throttle (60/min/user)

    def get(self, request, clip_id=None):
        clip = self.get_clip_or_404(clip_id)

        clip_key = clip.hls_playlist_url
        if not clip_key:
            return Response(
                {"error": "Clip HLS not ready"},
                status=status.HTTP_404_NOT_FOUND,
            )

        token = generate_playback_token(
            user_id=request.user.id,
            clip_key=clip_key.rsplit("/", 1)[0],  # strip "master.m3u8" → "hls/<clip_id>"
        )

        cookie_domain = os.getenv("MEDIA_TOKEN_COOKIE_DOMAIN", "")
        cookie_parts = [
            f"{COOKIE_NAME}={token}",
            "Path=/hls/",
            "Secure",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={getattr(settings, 'MEDIA_TOKEN_TTL_SECONDS', 600)}",
        ]
        if cookie_domain:
            cookie_parts.append(f"Domain={cookie_domain}")

        response = Response({"token_issued": True, "expires_in": 600})
        response["Set-Cookie"] = "; ".join(cookie_parts)
        return response

    def get_clip_or_404(self, clip_id):
        from ..models import AudioClip
        try:
            return AudioClip.objects.get(id=clip_id, status='ready', moderation_approved=True)
        except AudioClip.DoesNotExist:
            from rest_framework.exceptions import NotFound
            raise NotFound("Clip not found or not ready for playback")
```

### 8.3 urls.py Registration

Add to `backend/app/urls.py`:
```python
# After the existing urlpatterns:
path('media/playback-token/<uuid:clip_id>/', PlaybackTokenView.as_view(), name='playback_token'),
```

And import in `views/__init__.py`:
```python
from .media_views import PlaybackTokenView
```

### 8.4 Settings Addition

In `backend/EchoFlow/settings.py`, after the `PUBLIC_MEDIA_ENDPOINT_URL` block (current line 508):
```python
# --- HLS playback token ---
# DECISION: Separate secret from DJANGO_SECRET_KEY so the Cloudflare Worker
# (which does NOT have Django's settings) can share this secret as a
# Cloudflare Worker secret without exposing the Django signing key.
# Generate: python -c "import secrets; print(secrets.token_urlsafe(32))"
MEDIA_TOKEN_SECRET = os.environ.get("MEDIA_TOKEN_SECRET", "")
# TTL in seconds. 600 (10 min) is short enough to limit exposure on leak
# but long enough for a full playback session of a 5-minute clip.
MEDIA_TOKEN_TTL_SECONDS = int(os.getenv("MEDIA_TOKEN_TTL_SECONDS", "600"))
# Domain attribute for the HLS token cookie. In production (multi-subdomain),
# set to ".echoflow.in" so the cookie covers both api.echoflow.in and
# media.echoflow.in. In dev (single host), leave empty so the browser
# defaults to the current domain.
MEDIA_TOKEN_COOKIE_DOMAIN = os.getenv("MEDIA_TOKEN_COOKIE_DOMAIN", "")
```

### 8.5 Serializer Changes

`FeedClipSerializer` and `ShareEventSerializer` in `serializers.py` do NOT need to change. They still return `get_hls_playback_url(obj.hls_playlist_url)` — the **same unsigned URL**. The token is now a **cookie**, not embedded in the URL. This keeps the API response format backward-compatible.

The only serializer-adjacent change is that the frontend must ensure the cookie is set before attempting playback. This is handled in the player store, not the serializer.

### 8.6 Model Changes

**No model changes required.** The `AudioClip.hls_playlist_url` field (`models.CharField(max_length=500)`) already stores the relative object key (e.g. `hls/<clip_id>/master.m3u8`). The token is generated from this key at API request time, not stored in the database. This is consistent with the existing design where signed URLs are generated per-read, not persisted (see `tasks.py:378-384` comment: "store the relative object KEY, not a full URL").

### 8.7 Task Changes

**No task changes required.** `process_audio_to_hls` in `tasks.py` uploads HLS files to the `hls/<clip_id>/` prefix and sets `clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"`. This is completely unchanged — the storage layout is identical; only the access control layer changes.

### 8.8 Settings — Remove Public-Read

The current `STORAGES` config has `"default_acl": None` (private), which is correct. The public access comes from the **bucket policy** in minio-init, not from the S3 ACL. So no settings.py change is needed for the bucket ACL — only the minio-init command needs to stop making `hls/` public.

---

## 9. Frontend Changes (Shared by Both Options)

### 9.1 API Client — `frontend/sample_frontend/src/api/client.ts`

Add a `mediaAPI` object:
```typescript
// --- Media Token ---
export const mediaAPI = {
  getPlaybackToken: async (clipId: string): Promise<{ token_issued: boolean; expires_in: number } | null> => {
    const accessToken = getAccessToken();
    if (!accessToken) return null;

    const res = await fetch(`${API_BASE}/media/playback-token/${clipId}/`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // credentials: 'include' is needed so the browser accepts the Set-Cookie
      // from the API response even though the cookie domain differs from the
      // API domain (api.echoflow.in vs media.echoflow.in)
      credentials: 'include',
    });

    if (!res.ok) {
      throw { status: res.status, message: 'Failed to get playback token' };
    }

    return res.json().catch(() => null);
  },
};
```

### 9.2 Player Store — `frontend/sample_frontend/src/stores/player.tsx`

Modify the `loadSource` function to fetch a token before loading HLS:

```typescript
import { mediaAPI } from '../api/client';

const loadSource = useCallback(async (clip: AudioClip) => {
  const a = audioRef.current;
  killHLS();
  a.pause();
  setError(null);
  setProgress(0); setDuration(0); setBuffered(0);
  startRef.current = Date.now();

  const src = clip.hls_playlist_url;
  if (!src) { setError('No stream available'); return; }

  // DECISION: Fetch a short-lived playback token BEFORE loading HLS.
  // The token is set as a signed cookie by the Django response, and
  // the browser automatically sends it on all HLS subrequests to
  // media.echoflow.in/hls/<clip_id>/* (master.m3u8, variants, segments).
  // Without this, the Cloudflare Worker / nginx would return 403.
  try {
    await mediaAPI.getPlaybackToken(clip.id);
  } catch (e) {
    // Token issuance failed — likely expired session or non-auth'd user.
    // The 403 page (or redirect to login) will surface this.
    setError('Unable to authorize playback. Please refresh and sign in.');
    return;
  }

  const fullSrc = src.startsWith('http') ? src : (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000') + src;

  if (Hls.isSupported()) {
    // ... existing hls.js logic unchanged
  }
  // ... rest unchanged
}, [killHLS]);
```

### 9.3 Vite Proxy — `frontend/sample_frontend/vite.config.ts`

The `/media` proxy entry must be present for dev so `localhost:5173` can reach the token endpoint through the Vite dev proxy. Current config (line 19) already has:
```typescript
'/media': { target: 'http://localhost:8000', changeOrigin: true }
```

This is **already present** and needs no change. The token endpoint will be at `http://localhost:8000/media/playback-token/<clip_id>/`, proxied by Vite.

**However**, in dev the cookie Domain is `localhost` (no subdomain), and both the API (`localhost:8000` via proxy or `https://localhost`) and HLS (`https://localhost:9443`) are on `localhost`. The cookie set from the API response will be scoped to `localhost` by default, and the browser will send it to `localhost:9443` automatically. This works because both are on the same registrable domain (`localhost`).

### 9.4 Environment Variable — `VITE_HLS_COOKIE_DOMAIN`

In production, the cookie must be set with `Domain=.echoflow.in` (cross-subdomain). This value needs to reach the frontend so the player knows the cookie scope. Add to vite config:

Actually, the cookie Domain is set by the **server** (Django), not the frontend. The frontend just needs to know that the cookie was set successfully (by checking the response). The `credentials: 'include'` header in the fetch request ensures the browser honors the `Set-Cookie` from `api.echoflow.in` for the `.echoflow.in` domain.

No frontend env var is needed. The cookie Domain is controlled by `MEDIA_TOKEN_COOKIE_DOMAIN` on the backend.

---

## 10. Deployment Changes

### 10.1 Production (Option A — Worker)

**Step 1: Create and deploy the Worker**

```bash
cd workers/hls-token-worker
npm install
npx wrangler deploy

# Set the shared secret (same value as MEDIA_TOKEN_SECRET in .env.vps)
npx wrangler secret put MEDIA_TOKEN_SECRET
```

**Step 2: Update R2 bucket policy**

Remove the `hls/*` public-read policy from the R2 bucket. The bucket becomes fully private. All access is now mediated by the Worker.

**Step 3: Update Cloudflare DNS**

Change `media.echoflow.in` from a R2 custom domain (CNAME to R2) to a **Worker route**. This is done in the Cloudflare dashboard:
- Remove the R2 custom domain for `media.echoflow.in`
- The Worker's `wrangler.toml` `routes` entry (`media.echoflow.in/*`) takes over

**Step 4: Set MEDIA_TOKEN_SECRET**

In `.env.vps.example`, add a line noting that the same secret must be set as a Worker secret:

```bash
# --- HLS playback token ---
# CRITICAL: This same value must be set as a Cloudflare Worker secret
# (via: npx wrangler secret put MEDIA_TOKEN_SECRET). The Worker and Django
# must share this secret for HMAC validation.
MEDIA_TOKEN_SECRET=change-me-to-64-hex-chars
```

**Step 5: Set MEDIA_TOKEN_COOKIE_DOMAIN**

```bash
# In .env.vps (not .example — this is deployment-specific):
MEDIA_TOKEN_COOKIE_DOMAIN=.echoflow.in
```

### 10.2 Development (Option B — nginx njs)

**Dockerfile change**

The current `docker/Dockerfile` uses `nginx:1.27-alpine`. To add njs:

```dockerfile
# In the multi-stage Dockerfile, find the nginx stage or final image
# ADD: install nginx-mod-njs alongside nginx
RUN apk add --no-cache nginx-mod-njs
```

Or, if nginx is in a separate image, use `nginx:1.27-alpine` with:
```dockerfile
RUN apk add --no-cache nginx-mod-njs
```

**docker-compose.yml change**

In the `minio-init` service (line 228), remove the `mc anonymous set download` line:
```yaml
# Before:
mc mb --ignore-existing local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media} &&
mc anonymous set download local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}/hls

# After:
mc mb --ignore-existing local/${AWS_STORAGE_BUCKET_NAME:-echoflow-media}
```

This makes `hls/` private. nginx (with njs) will validate the cookie before proxying to MinIO.

**nginx.conf change**

Mount the njs script into the nginx container:
```yaml
# In docker-compose.yml, nginx service volumes:
volumes:
  - ./docker/nginx.conf:/etc/nginx/nginx.conf:ro
  - ./docker/nginx/hls_auth.js:/etc/nginx/hls_auth.js:ro  # NEW
  - ./docker/certs:/etc/nginx/certs:ro
```

---

## 11. Testing Strategy

### 11.1 Backend Unit Tests — `backend/app/tests/test_hls_token.py`

```python
"""Tests for HLS playback token generation and validation."""
import time
import json
import base64
import hmac
import hashlib
import pytest
from unittest.mock import patch

from backend.app.services.hls_token import (
    generate_playback_token,
    validate_playback_token,
    parse_token_payload,
)


class TestTokenGeneration:
    """Token generation produces valid HMAC-signed tokens."""

    def test_token_has_two_parts(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        assert "." in token
        payload_b64, sig_b64 = token.split(".")
        assert len(payload_b64) > 0
        assert len(sig_b64) > 0

    def test_token_payload_contains_required_fields(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload_b64 = token.split(".")[0]
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        assert payload["u"] == 42
        assert payload["c"] == "hls/abc-123"
        assert "exp" in payload
        assert "iat" in payload
        assert payload["v"] == 1

    def test_token_expiry_is_10_minutes(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload_b64 = token.split(".")[0]
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        assert payload["exp"] - payload["iat"] == 600

    def test_token_is_different_each_time(self):
        token1 = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        token2 = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        assert token1 != token2  # iat/exp change


class TestTokenValidation:
    """Token validation checks HMAC, expiry, and scope."""

    def test_valid_token_passes(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload = validate_playback_token(token, "/hls/abc-123/master.m3u8")
        assert payload is not None
        assert payload["u"] == 42

    def test_expired_token_rejected(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload_b64 = token.split(".")[0]
        # Tamper with expiry
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        payload["exp"] = int(time.time()) - 1  # expired 1 second ago
        tampered_payload_b64 = base64.urlsafe_b64encode(
            json.dumps(payload).encode()
        ).decode().rstrip("=")
        # Re-sign with correct HMAC (simulating a re-issued but expired token)
        secret = getattr(settings, "MEDIA_TOKEN_SECRET", "")
        sig = hmac.new(secret.encode(), tampered_payload_b64.encode(), hashlib.sha256).digest()
        sig_b64 = base64.urlsafe_b64encode(sig).decode().rstrip("=")
        expired_token = f"{tampered_payload_b64}.{sig_b64}"
        assert validate_playback_token(expired_token, "/hls/abc-123/master.m3u8") is None

    def test_wrong_signature_rejected(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload_b64, _ = token.split(".")
        bad_token = f"{payload_b64}.invalid_signature"
        assert validate_playback_token(bad_token, "/hls/abc-123/master.m3u8") is None

    def test_scope_mismatch_rejected(self):
        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        # Token is for hls/abc-123/ but request is for hls/def-456/
        assert validate_playback_token(token, "/hls/def-456/master.m3u8") is None

    def test_missing_token_rejected(self):
        assert validate_playback_token("", "/hls/abc-123/master.m3u8") is None
        assert validate_playback_token(None, "/hls/abc-123/master.m3u8") is None

    def test_malformed_token_rejected(self):
        assert validate_playback_token("garbage", "/hls/abc-123/master.m3u8") is None
        assert validate_playback_token("a.b.c", "/hls/abc-123/master.m3u8") is None


class TestPlaybackTokenView:
    """Integration test: API endpoint issues token cookie."""
    # Uses pytest-django fixtures — requires docker compose (PostgreSQL, Redis)
```

### 11.2 Worker Tests

The Worker can be tested with `wrangler dev` and `curl`:

```bash
# Start Worker in dev mode (with local R2)
npx wrangler dev

# In another terminal, simulate an authenticated request:
# 1. Get a clip ID from the local API
CLIP_ID=$(curl -s -H "Authorization: Bearer $JWT" https://localhost/feed/ | python -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")

# 2. Request a token (Django issues the cookie)
curl -s -b cookie-jar.txt -H "Authorization: Bearer $JWT" \
  https://localhost/media/playback-token/$CLIP_ID/

# 3. Use the cookie to access HLS
curl -b cookie-jar.txt -I https://localhost:9443/hls/$CLIP_ID/master.m3u8
# Should return 200 (cookie valid)

# 4. Try without cookie
curl -I https://localhost:9443/hls/$CLIP_ID/master.m3u8
# Should return 403

# 5. Try with expired cookie (fast-forward time by issuing a token, then
#    waiting 600s, or testing with a crafted expired token)
```

### 11.3 Existing Test Updates

Tests in `test_https_termination.py` that assert `hls/` is public will need updates:

- `TestPublicMediaEndpoint` — no change (still validates HTTPS)
- Any test that checks `http://localhost:9000/echoflow-media/hls/...` returns 200 **without auth** — these tests encode the OLD behavior and must be updated to expect 403 without a token.

The `diagnostics/check_pipeline.py` and `diagnostics/test_hls_playback.py` scripts also reference the old public-access behavior and need updating.

---

## 12. Migration / Rollback Plan

### Migration Steps (Production)

1. **Deploy Worker** (`npx wrangler deploy`) — Worker is deployed but not yet routing traffic (DNS still points to R2 directly)
2. **Set Worker secret** (`npx wrangler secret put MEDIA_TOKEN_SECRET`) — same value as VPS `.env`
3. **Deploy backend** — new token API endpoint is live but Worker not yet routing
4. **Frontend deploy** — player calls token endpoint before HLS load
5. **Switch DNS** — `media.echoflow.in` CNAME changes from R2 to Worker
6. **Remove R2 public-read policy** — `hls/*` becomes private
7. **Verify** — playback works end-to-end; anonymous requests get 403

**Rollback:** Revert DNS `media.echoflow.in` back to R2 direct + re-add the public-read bucket policy. No data changes — HLS objects are untouched.

### Migration Steps (Dev)

1. **Update Dockerfile** — add `nginx-mod-njs`
2. **Add njs script** — `docker/nginx/hls_auth.js`
3. **Update nginx.conf** — `js_import` + `js_access` on `:9443`
4. **Update docker-compose.yml** — remove `mc anonymous set download .../hls`
5. **Rebuild and restart:**
   ```bash
   docker compose down -v
   docker compose up --build
   ```
6. **Verify** — playback works with token; anonymous HLS requests get 403

**Rollback:** Revert `docker-compose.yml` line 228 (re-add `mc anonymous set download .../hls`), rebuild without njs. No data migration needed.

### Timing

The migration is **zero-downtime** because:
- Steps 1-4 do not affect existing traffic (DNS still points to R2 direct)
- Step 5 (DNS switch) is the cutover point — traffic shifts from R2-direct to Worker
- Step 6 (remove public-read) only matters after step 5
- If step 5 is reverted before step 6, traffic continues to flow (Worker validates cookie, but if the cookie endpoint is also deployed, it works)

### Potential Issues

| Issue | Mitigation |
|-------|------------|
| Safari/iOS third-party cookie blocking | `SameSite=Lax` + `Secure` on same-site requests works. The cookie is set from `api.echoflow.in` for Domain=`.echoflow.in`, and sent to `media.echoflow.in` — these are same-site (both Cloudflare-proxied). Safari's ITP treats same-site cross-subdomain as first-party. |
| Cookie Domain configuration | Default (empty) = current request domain. For dev (localhost), this works out of the box. For prod, `.echoflow.in` must be set. |
| Token endpoint not deployed but frontend calls it | Frontend catches the 404/403 and displays an error. Users without a fresh deploy can still access the old public URLs. |
| Worker cold start | ~5ms cold start on first request; after that, requests are served from warm instances. For 5-10 users, this is negligible. |
| njs crypto module availability | The `nginx:1.27-alpine` image with `nginx-mod-njs` provides `crypto.subtle` (Web Crypto API) — verified in njs docs. |
| R2 Object listing | Worker only does GET (no LIST), so R2 bucket listing is never exposed. |

---

## 13. Cost Analysis

### Worker Costs (Option A, Production)

At 5-10 concurrent users watching short-form audio:

| Metric | Estimate | Free Tier | Paid |
|--------|----------|-----------|------|
| Users | 10 | — | — |
| Clips per user per day | ~50 | — | — |
| HLS requests per clip | ~10 (master + 1 variant + ~8 segments) | — | — |
| Total Worker invocations/day | 5,000 | 100,000 (free) | — |
| CPU per invocation | ~0.5ms (HMAC verify) | — | — |
| Total CPU/day | ~2,500ms | 10ms × 100k = 1M ms (free) | — |
| **Cost** | **$0** | Well within free tier | Only at massive scale |

At 10,000 users (hypothetical future scale):
- 500,000 requests/day → ~15M/month → $1.50 for requests + ~$0 for CPU
- Still negligible cost relative to R2 storage + Cloudflare bandwidth

### nginx Costs (Option B, Dev)

No additional cost — nginx is already running. The only addition is the `njs` module in the same container.

---

## 14. Comparison Matrix: Worker vs nginx

| Criterion | Option A: Cloudflare Worker | Option B: nginx + njs |
|-----------|---------------------------|----------------------|
| **Latency** | Edge (~1-5ms validation at edge) | VPS region (depends on user distance to VPS) |
| **Scalability** | Automatic edge scaling | Limited by VPS CPU/memory |
| **R2 egress** | Free (Worker→R2 is internal) | Free (nginx→MinIO is local dev) |
| **Free tier** | 100k req/day (sufficient at your scale) | No additional cost (nginx already running) |
| **Cookie compatibility** | Standard cookies work | Standard cookies work |
| **Range request support** | Native via `env.R2_BUCKET.get(key, {range})` | Native via `proxy_pass` to MinIO |
| **WAF/Bot Management** | Available (requires Pro plan) | Available via nginx config + fail2ban |
| **Cloudflare caching** | Can cache HLS at the edge | No caching (dev only) |
| **Development parity** | Requires local emulation (not exact) | Exact mirror of prod logic |
| **Deployment complexity** | Separate `wrangler deploy` | Part of `docker compose up` |
| **Maintenance surface** | Additional Worker repo + secrets | Single nginx image change |
| **Recommended for** | **Production (your use case)** | **Development** |

### My Recommendation

**Use Option A (Worker) for production** — it's the right choice for your scale (5-10 users, free tier covers it), provides edge-level DDoS protection at the Cloudflare edge (before traffic reaches your VPS), and supports Cloudflare's WAF + bot management.

**Use Option B (nginx + njs) for dev** — it's the exact logic running in nginx locally, giving you a faithful test of the token validation pipeline before deploying to production. The njs script mirrors the Worker's TypeScript validation, so you're testing the same algorithm.

---

## Appendix A: Token Format Reference

### Python (Django) — `services/hls_token.py`

```python
payload = json.dumps({"u": 42, "c": "hls/abc-123", "exp": 1725000000, "iat": 1724996400, "v": 1}, separators=(",", ":"), sort_keys=True)
payload_b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()
signature = hmac.new(MEDIA_TOKEN_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
token = f"{payload_b64}.{sig_b64}"
```

### TypeScript (Worker) — `src/token.ts`

```typescript
// Must produce the SAME token as Python for the same inputs
// (same JSON serialization order, same base64url encoding, same HMAC)
```

### JavaScript (njs) — `docker/nginx/hls_auth.js`

```javascript
// Must validate the SAME token produced by Python/TypeScript
// Uses crypto.subtle (Web Crypto API) available in njs
```

All three implementations must agree on:
1. JSON key order: `u, c, exp, iat, v` (sorted alphabetically)
2. Base64url encoding (no padding)
3. HMAC-SHA256 with the shared secret
4. Token format: `payload_b64.signature_b64`

---

## Appendix B: Cookie Flow Diagram

```
Step 1: User opens feed
  Browser → GET https://api.echoflow.in/feed/
  Headers: Authorization: Bearer <JWT>
  Response: { clips: [{ hls_playlist_url: "https://media.echoflow.in/hls/abc-123/master.m3u8" }] }

Step 2: Playback initiated (clip comes into view)
  Browser → GET https://api.echoflow.in/media/playback-token/abc-123/
  Headers: Authorization: Bearer <JWT>
  Response: 200 OK
  Set-Cookie: ef_hls_token=<HMAC_TOKEN>; Domain=.echoflow.in; Path=/hls/; Secure; HttpOnly; SameSite=Lax; Max-Age=600
  ↓
  Browser cookie jar stores the cookie

Step 3: hls.js requests master.m3u8
  Browser → GET https://media.echoflow.in/hls/abc-123/master.m3u8
  Headers: Cookie: ef_hls_token=<HMAC_TOKEN>  ← automatically sent
  ↓
  Cloudflare Worker:
    1. Parse cookie
    2. Verify HMAC signature
    3. Check expiry (10 min)
    4. Check path prefix matches token scope (hls/abc-123)
    5. If all pass → proxy to R2
    6. If any fail → 403

Step 4: hls.js requests variant playlist (relative URL)
  Browser → GET https://media.echoflow.in/hls/abc-123/index.m3u8
  Headers: Cookie: ef_hls_token=<HMAC_TOKEN>  ← automatically sent (same domain + /hls/ path)
  ↓
  Cloudflare Worker validates → proxies to R2 ✓

Step 5: hls.js requests segments (relative URLs)
  Browser → GET https://media.echoflow.in/hls/abc-123/segment_000.ts
  Headers: Cookie: ef_hls_token=<HMAC_TOKEN>  ← automatically sent
  ↓
  Cloudflare Worker validates → proxies to R2 ✓
  ✓ All segments load seamlessly
```

---

## Appendix C: Environment Variable Reference

| Variable | Where | Required | Default | Purpose |
|----------|-------|----------|---------|---------|
| `MEDIA_TOKEN_SECRET` | `.env.example`, `.env.vps.example`, Worker secret | Yes | Empty (app raises if missing) | HMAC signing key for token issuance/validation |
| `MEDIA_TOKEN_TTL_SECONDS` | `.env.example`, `.env.vps.example` | No | `600` | Token time-to-live in seconds |
| `MEDIA_TOKEN_COOKIE_DOMAIN` | `.env.vps.example` only (empty in dev) | No | `""` (empty = current domain) | Cookie Domain attribute for cross-subdomain cookies in production |

**Critical deployment note:** The `MEDIA_TOKEN_SECRET` value must be **identical** in:
1. The VPS `.env` file (read by Django for token issuance)
2. The Cloudflare Worker secret (set via `npx wrangler secret put MEDIA_TOKEN_SECRET`)

If these diverge, tokens issued by Django will fail validation in the Worker, and all HLS playback will break in production.

---

## Appendix D: Relationship to Existing Security Controls

This token system complements (does NOT replace) existing security measures:

| Existing Control | Layer | How HLS token relates |
|-----------------|-------|----------------------|
| JWT auth on API | Application | Token issuance requires valid JWT; user must be authenticated |
| `querystring_auth: True` on STORAGES | Storage | Original uploads still require signed S3 URLs; only `hls/` is token-gated |
| `IsAuthenticated` on all viewsets | Application | Feed, suggestions, interactions all require auth |
| `ScopedRateThrottle` | Application | Token endpoint is rate-limited (reuses `interaction` scope = 60/min/user) |
| HSTS / `SECURE_SSL_REDIRECT` | TLS | Cookie has `Secure` flag; HTTPS-only transport |
| Cloudflare WAF | Edge | Can add defense-in-depth: block requests to `/hls/*` without `ef_hls_token` cookie (Pro plan) |
| Cloudflare Bot Fight Mode | Edge | Blocks known bot user agents before they reach the Worker |
| DPDP/RBI region assertion | Compliance | Token system doesn't affect region requirements; R2 stays in `ap-south-1` |

---

*Document created for the HLS short-lived play token feature. See `docs/EXPLAIN/storage/` for the sibling documents on S3 architecture, HLS playback, and bucket policies.*