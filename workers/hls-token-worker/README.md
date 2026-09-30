# EchoFlow HLS Token Worker

Production edge proxy that validates HMAC-signed playback cookies for HLS
content stored in Cloudflare R2.

## Role

Replaces the direct `media.echoflow.in` → R2 custom domain mapping. The
Worker sits between the client and R2, validating the `ef_hls_token` cookie
or the `X-EchoFlow-Media-Token` header (native players have no cookie jar)
on every `/hls/*` request before proxying to R2.

## Why a Worker?

Signed URLs don't work for HLS — the master playlist references variant
playlists and segments via relative paths, and RFC 3986 §5.2.2 strips query
strings during relative-reference resolution. Signed **cookies** are the only
token mechanism that survives relative-reference resolution because cookies
are sent automatically by the browser on all requests to the cookie's domain
and path.

## Setup

```bash
cd workers/hls-token-worker

# Install dependencies
npm install

# Set the HMAC secret (must match MEDIA_TOKEN_SECRET in VPS .env)
npx wrangler secret put MEDIA_TOKEN_SECRET
# (paste the same value used in Django's .env)

# Deploy
npx wrangler deploy

# Verify
curl -b "ef_hls_token=<valid_token>" https://media.echoflow.in/hls/<clip_id>/master.m3u8
curl -H "X-EchoFlow-Media-Token: <valid_token>" https://media.echoflow.in/hls/<clip_id>/master.m3u8
# should 403 with no credential; the cookie wins if both are present
curl -I https://media.echoflow.in/hls/<clip_id>/master.m3u8
```

## Cost

Workers Free tier: 100,000 requests/day. At 5-10 users × ~50 clips/day ×
~10 HLS requests per clip = ~5,000 req/day. Well within free tier.

R2→Worker data transfer is free. Worker→browser egress is covered by R2's
10 GB/month free tier (Cloudflare handles the transfer).

## Files

- `src/index.ts` — Worker fetch handler (validate token → proxy to storage)
- `src/token.ts` — Token validation and extraction logic (HMAC-SHA256, must
  match Django's `hls_token.py`), plus the constants (`TOKEN_VERSION`,
  `COOKIE_NAME` at the top of the file — there is no separate `src/config.ts`)
- `src/storage.ts` — R2 binding (production) and S3/MinIO-over-SigV4 (local)
  backends behind one interface, plus the `Env` interface and backend selection
- `src/token.test.ts` — tests for `token.ts`
- `src/storage.test.ts` — tests for `storage.ts`
- `wrangler.toml` — Worker configuration

## Tests

```bash
cd workers/hls-token-worker
npm ci        # first time only
npm test      # vitest run — no network, no Docker, no wrangler
npm run typecheck
```

Plain `vitest` on Node: the tests are pure unit tests and never touch R2,
MinIO, or `wrangler dev`.

### What is covered

| Covered | File |
|---|---|
| `validatePlaybackToken` — every branch: HMAC mismatch, tampered payload, expiry, version, per-clip path scope (including the partial-prefix off-by-one), malformed and missing fields | `src/token.test.ts` |
| Token extraction from `Cookie` / `X-EchoFlow-Media-Token`, and cookie-over-header precedence | `src/token.test.ts` |
| `objectUrl` path building, `assertTokenSecret`, and which storage backend `getStorage` selects for a given env | `src/storage.test.ts` |

### What is NOT covered

| Not covered | File | Risk |
|---|---|---|
| The whole fetch handler — `/healthz`, OPTIONS preflight, the 404/405/method routing, CORS header emission and origin allowlist, `Cache-Control` selection, 304 passthrough, and the 403-vs-502 mapping | `src/index.ts` | **Highest.** This is where a validated token becomes bytes; a routing or CORS regression here is invisible to the suite |
| `StorageBackend.get()` itself — Range forwarding, `HEAD` vs `GET` bodies, 404 / 304 / `!ok` handling, `StorageUnavailable` on a transport error | `src/storage.ts` | The signer's request shape against a real MinIO/R2. Note these two backends never see the same input under test (an R2 binding cannot be pointed at MinIO), so a cross-environment parity test does not exist |

`src/token.test.ts` also pins several **known divergences** from
`hls_token.py` (a string `exp` is accepted, a missing `exp` never expires, a
`null` payload throws). Those assertions record current behaviour on purpose —
they are documented in the file and are not a specification.

## References

- Design doc: `docs/EXPLAIN/storage/04-hls-token-protection.md`
- Token format: `backend/app/services/hls_token.py`
- Cloudflare signing example: https://developers.cloudflare.com/workers/examples/signing-requests/
- R2 Workers API: https://developers.cloudflare.com/r2/get-started/workers-api/
