# 2026-09-29 — Share pipeline: one token type, two lifetimes, explicit play

DECISION: A share link is an **ordinary HLS playback token minted with a
longer TTL**, not a new token type. There is no `ShareLink` table, no second
HMAC secret, and no second validator. `POST /clips/{id}/play/` re-mints a
short-lived media token on the recipient's explicit play intent.

Status: implemented on `feat/mobile-rebuild`.

---

## Why not a separate share-token type

The first design (recorded in the plan's A4 row) was a `ShareLink` model, a
`SHARE_TOKEN_SECRET`, its own module, and a 30-day TTL, exchanged for a
600s media token.

Reading `services/hls_token.py` before writing any of it killed that plan.
The token payload is:

```json
{ "c": "hls/<clip_id>", "exp": int, "iat": int, "u": int, "v": 1 }
```

There is **no purpose field.** `c` is a *storage path prefix*, and
`validate_playback_token` checks only HMAC + `v` + `exp` + `startswith("/"+c+"/")`.
So a long-lived token in that format is **indistinguishable from a 600s media
token** to every validator that exists — Django, the Cloudflare Worker
(`token.ts`), and the nginx njs file. Adding a purpose field means changing
the payload schema in all three implementations, which the module docstring
warns "MUST match this file's algorithm exactly". That is a cross-cutting
change to deployed validators, for a feature.

And once a share token *is* a media token, the exchange step is a no-op
indirection: it would hand out a long token, then immediately hand out a
short one. So the second secret, the `ShareLink` table, and the second
validator bought nothing that a `ttl=` argument does not.

## Why not "forever"

`exp` is the **only automatic revocation mechanism in this design.** When a
clip is un-approved (an ISSUE-04 takedown) nothing else invalidates a token
already in someone's hand.

| TTL | Takedown takes effect | Shared link survives |
|---|---|---|
| 600s (media) | ~10 min | no — unusable |
| 30d (share) | ≤ 30 days | yes |
| forever | **never** | yes |

"Forever" was offered and declined in favour of 30 days. Same implementation
cost — one constant — and it preserves the one property that makes the design
tractable. This is also why revocation of a single share link is *not*
supported: there is no row to revoke. Accepted trade for MVP.

## Why POST /clips/{id}/play/ exists

Two reasons, and the second is the important one.

**Play-gating.** Opening a shared link mints no credential. Nothing is issued
until an explicit play intent, so a link preview, a chat client unfetch, or
a crawler cannot cause a token to be minted at all.

**Scope check.** The endpoint must confirm `payload["c"]` equals *this*
clip's storage key. Without it, any valid token unlocks any clip: a recipient
takes the `?s=` value from the link they were sent and rewrites the clip id
in the path. This is the "is this actually a reel which was shared to the
user" check, and it is a string comparison, not new crypto.

`verify_token()` in `hls_token.py` exists solely to support this. It is
`validate_playback_token` minus the path check, so a caller can inspect a
token rather than authorise a request with it.

## The landing surface: OG card, not a web app

`GET /clips/{id}/public/` is content-negotiated. JSON for API clients; a
small HTML page with Open Graph tags for a browser or a link unfurl.

This is not gold-plating. There is **no deployed web frontend** — nginx is
`server_name _` proxying only to Django, and `frontend/` holds samples only.
A shared link therefore has no page to land on, and the only thing that
renders a bare URL is an unfurl. OG tags make the share legible in
WhatsApp/Slack/X *today*, with no site.

App-vs-web routing is **deliberately deferred**: `PUBLIC_APP_BASE_URL` is
configurable, and if unset the endpoint returns a relative path plus the raw
token rather than inventing an absolute URL. A plausible-but-wrong absolute
link is worse than an obviously incomplete one, because a client will not
second-guess it.

## Anonymous playback: the licensing filter is mandatory

An unauthenticated caller can reach a media token, so
`POST /clips/{id}/play/` **must** apply the feed's license filter
(`is_noncommercial` / `requires_share_alike`). Without it, sharing an NC clip
once makes its audio anonymously retrievable by anyone holding the link —
turning the pre-existing bypass into a permanent one. `moderation_approved`
is likewise re-checked at play time, not only at mint time, so a takedown
stops new playback.

## Data minimisation

`GET /clips/{id}/public/` previously returned `FeedClipSerializer`, so an
unauthenticated caller could read a clip's like/share/skip/comment counts,
the per-viewer `is_liked` field, and the media URL. `PublicClipSerializer`
omits all of those, plus `creator_id` (the display name is enough to
attribute the clip, and omitting the id avoids a user-id oracle).

Every interpolated value in the OG card goes through `django.utils.html.escape`.
The title is user-supplied free text rendered on an **unauthenticated** page,
so an unescaped title is stored XSS against whoever opens the link.

## Files affected

- `backend/app/services/hls_token.py` — `ttl=` override, `verify_token()`
- `backend/app/services/uploads.py` — `clip_storage_key()` (one definition of a clip's key)
- `backend/app/views/content.py` — `share_link`, `play_shared`, rewritten `public_view`, per-action throttle scopes
- `backend/app/views/media.py` — `_extract_clip_key` now delegates to the shared helper
- `backend/app/serializers.py` — `PublicClipSerializer`
- `backend/EchoFlow/settings.py` — `SHARE_TOKEN_TTL_SECONDS`, `PUBLIC_APP_BASE_URL`, 5 new throttle scopes
- `conftest.py` — `clear_throttle_cache` fixture

## Two bugs found by reading the surrounding code

**1. One throttle scope for the whole viewset.** `AudioUploadViewSet` declared
`throttle_scope = 'upload'` (20/hour), which applied to *every* action. So the
share landing page answered **429 after 20 views** — a share feature that
works for you and then silently stops, the worst shape of bug to notice. Now
per-action scopes, matching the existing pattern in `ClipInteractionViewSet`
and `ShareViewSet`.

**2. `media._extract_clip_key` returned the filename as a prefix.** For
`hls_playlist_url = "master.m3u8"` (no `/`) it returned `"master.m3u8"`, so
the token's `c` became `master.m3u8` and the Worker compared
`startswith("/master.m3u8/")` — which never matches. Broken playback,
silently. The shared helper returns `None` → 409.

## Not done, deliberately

- **Per-link revocation.** No `ShareLink` row exists. Bounded by `exp` only.
- **The landing route.** `app.echoflow.in` does not exist; universal/app links
  need `apple-app-site-association` + `assetlinks.json` and a real host. The
  app-vs-web routing decision is deferred until there is one.
- **Language coverage.** Transcripts are matched against English keywords only.
