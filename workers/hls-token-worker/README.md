# EchoFlow HLS Token Worker

Production edge proxy that validates HMAC-signed playback cookies for HLS
content stored in Cloudflare R2.

## Role

Replaces the direct `media.echoflow.in` → R2 custom domain mapping. The
Worker sits between the browser and R2, validating the `ef_hls_token` cookie
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
curl -I https://media.echoflow.in/hls/<clip_id>/master.m3u8  # should 403 without cookie
```

## Cost

Workers Free tier: 100,000 requests/day. At 5-10 users × ~50 clips/day ×
~10 HLS requests per clip = ~5,000 req/day. Well within free tier.

R2→Worker data transfer is free. Worker→browser egress is covered by R2's
10 GB/month free tier (Cloudflare handles the transfer).

## Files

- `src/index.ts` — Worker fetch handler (validate cookie → proxy to R2)
- `src/token.ts` — Token validation logic (HMAC-SHA256, must match Django's `hls_token.py`)
- `src/config.ts` — Constants (cookie name, TTL, etc.)
- `wrangler.toml` — Worker configuration

## References

- Design doc: `docs/EXPLAIN/storage/04-hls-token-protection.md`
- Token format: `backend/app/services/hls_token.py`
- Cloudflare signing example: https://developers.cloudflare.com/workers/examples/signing-requests/
- R2 Workers API: https://developers.cloudflare.com/r2/get-started/workers-api/
