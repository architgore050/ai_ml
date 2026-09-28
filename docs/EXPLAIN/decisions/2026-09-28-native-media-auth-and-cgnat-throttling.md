# 2026-09-28 — Native media authentication transport and CGNAT-safe throttling

**Status:** approved and implemented on `feat/mobile-rebuild`.
**Plan of record:** [`docs/mobile-rebuild-plan.md`](../../mobile-rebuild-plan.md).
This document is the approval-gate record required by `AGENTS.md` for
architecture / API / security changes. The plan holds the full client-side
design; this holds the rationale for the backend contract.

---

## Changes needed

A mobile client is the next major consumer of this API, and four things
block it. Two are the HLS playback gate; two are configuration.

1. **The playback token is unsatisfiable off-browser.** `ef_hls_token` is
   `HttpOnly; Secure; SameSite=Lax; Path=/hls/`. `AVPlayer` (iOS) does not
   read `NSHTTPCookieStorage`; ExoPlayer's `DefaultHttpDataSource` (Android)
   sends no `Cookie` header. Neither shares state with the app's HTTP client,
   and `HttpOnly` prevents the app reading it back to re-attach manually.
   A native client can neither obtain nor present the credential.

2. **The Worker validates a cookie only**, so even a delivered token has no
   route to the edge.

3. **IP-keyed throttling is wrong on a mobile network.** One carrier NAT
   address is thousands of callers. `POST /auth/token/refresh/` inherited
   `anon` (100/hour/IP) while access tokens live 15 minutes — so a cell
   exhausts its shared budget within minutes and every subscriber is logged
   out. `POST /auth/register/` was 5/hour/IP.

4. **The production deploy path was silently broken.** `.env.vps.example`
   set `MEDIA_TOKEN_COOKIE_DOMAIN` but not `PUBLIC_HLS_ENDPOINT_URL`, so
   `HLS_URL_STYLE` resolved to `bucket` and Django emitted
   `/echoflow-media/hls/…` against a Worker that rejects any path not
   starting `/hls/`. Separately, the registered domain was written two ways
   (`echoflow.in` vs `echo-flow.in`) across 13 files.

## How the changes will be made

**Native transport.** One HMAC token, two carriers, **cookie-first**.

- `POST /media/playback-token/<id>/` returns `{"status":"ok"}`, plus
  `"token"` when the caller sends `X-EchoFlow-Client: native`. The cookie is
  set unconditionally, so the web client is byte-identical and the change is
  additive.
- The Worker accepts `X-EchoFlow-Media-Token` when no token is extractable
  from the cookie.
- Signature, version, `exp` and per-clip path scope are unchanged for both.

**Throttling.** `POST /auth/token/refresh/` keys on the **verified**
`user_id` inside the refresh token, falling back to IP only when no usable
token is presented, at `120/hour`. `POST /auth/register/` becomes two
independent limits: `register` 200/hour per IP and `register_username`
3/hour per username.

**Config.** `PUBLIC_HLS_ENDPOINT_URL` + explicit `HLS_URL_STYLE=edge` in
`.env.vps.example` and `docker-compose.vps.yml`; `echo-flow.in` →
`echoflow.in` across compose files, `AGENTS.md` and docs.

## Why this & not anything else

**Header, not cookie.** Query-string signing is impossible: RFC 3986 §5.2.2
strips the query during relative-reference resolution, so `master.m3u8`
succeeds and every segment it names 403s. Making `hls/` public discards the
gate. A shared cookie store would mean a custom native networking layer to
inject `Cookie` into ExoPlayer's `DefaultHttpDataSource`, which React
Native's audio module does not expose — more machinery for the same
security property. `AudioSource.headers` already exists in `expo-audio` and
applies to the manifest *and* every segment, so the header is the cheapest
correct answer.

**Cookie-first precedence.** A web page's script cannot read the `HttpOnly`
cookie but can set an arbitrary header. Header-authoritative would let any
script on the app origin choose which credential the edge trusts. Falling
through to the header only when no token is extractable adds native as
strictly the otherwise-unauthenticated case.

**Body token is opt-in, not unconditional.** Echoing a bearer credential
into JSON widens exposure for a bug (a logging interceptor, an error
reporter capturing bodies) that `HttpOnly` exists to prevent. The default is
unchanged. A forged header gains nothing: the token is already clip-scoped,
HMAC-signed, and expiry-checked.

**Refresh keyed on subject, not address.** The refresh token is a signed,
verified credential that already carries `user_id`. Decoding it is safe *only*
with signature verification — otherwise flipping `user_id` mints a fresh
bucket per forged subject and the limit is decorative. The IP fallback still
bounds flooding, because it is per source address.

**Registration keeps an IP key but adds an axis.** Registration is
anonymous; the IP key cannot go. 200/hour lets a carrier cell onboard
normally, and the per-username limit catches what the IP key cannot see:
one host cycling through accounts, and repeated re-registration to squat a
handle.

**Not fixed here** (tabulated in the plan, §17): the `approve-moderation`
authorization hole, the missing `tags`/`duration_ms` on the feed serializer,
`Report` lacking a `clip` FK, and the six RevenueCat defects. Each is a
larger investigation; none blocks a working client.

## Files affected

New — `backend/app/throttling.py`, `backend/app/tests/test_throttling.py`,
`workers/hls-token-worker/src/token.test.ts`.

Modified — `backend/app/views/media.py`, `backend/app/urls.py`,
`backend/app/views/auth.py`, `backend/EchoFlow/settings.py`,
`workers/hls-token-worker/src/{token,index}.ts`, `.env.vps.example`,
`docker-compose{,.vps,.laptop}.yml`, `AGENTS.md`, `docs/TODO.md`, and nine
docs under `DEPLOYMENT/` and `storage/`.

## Architecture & data flow

```
Browser   ──Set-Cookie ef_hls_token──▶ edge ──▶ storage
RN client ──X-EchoFlow-Client: native─▶ Django ──{status, token}
          ◀──token──────────────────
          ──X-EchoFlow-Media-Token─▶ edge ──▶ storage

One HMAC token, same TTL, same clip scope, both paths.
```

## Test cases

`test_hls_token.py::TestNativeTokenTransport` (9): body token issued; body
token equals the cookie value; validates for its own path and not another
clip's; default body unchanged; only the exact value opts in (parametrised
over 5 near-misses); cookie still set for native; moderation and auth are not
bypassed.

`test_throttling.py` (26): two users behind one IP do not share a budget; a
single user is still bounded; the configured rate is ≥10× the
`ACCESS_TOKEN_LIFETIME` baseline; invalid tokens share one IP bucket; the key
reflects subject not address; a **tampered** token is not trusted as a
subject; non-scalar subjects (`dict`/`list`/`None`/`bool`/`float`) rejected;
**string** subjects accepted (fails loudly if simplejwt changes type);
unparseable bodies do not raise; per-username limit fires; case-insensitive;
distinct usernames distinct; missing username falls back to IP; both throttle
classes are on `RegisterView`; scope declared on the refresh view; a
scope-less view is unthrottled (pins the DRF behaviour); both new scopes
exist in settings.

`token.test.ts` (8): cookie path; header path; neither → null; **cookie
wins when both present**; fallback when the cookie header is present but
unrelated; header-name casing; value is not empty.

## Edge cases

| Case | Handling |
|---|---|
| Malformed request body | `ParseError` is an `APIException`, **not** a `ValueError` — explicitly caught, falls back to IP, view returns its own 400 |
| Tampered / expired refresh token | Signature + expiry check fails → IP bucket |
| `bool` subject | Explicitly rejected; `isinstance(True, int)` is `True` in Python |
| Body-token caller also sends a cookie | Both set; edge uses cookie first |
| Forged `X-EchoFlow-Client` from a browser | No privilege gained — clip-scoped, HMAC, expiry-checked |
| View missing `throttle_scope` | **Fails loudly in CI** (`TestRefreshThrottleWiring`); silently allows in production |
| Unregistered throttle scope | Would be a 500 on every refresh; two tests assert the scopes exist |

## Atomic commit plan

1. `feat(media): issue the playback token in the body for native clients`
2. `feat(worker): accept the playback token as a request header`
3. `fix(throttle): key token refresh on the verified subject, not the IP`
4. `fix(throttle): size registration limits for carrier NAT`
5. `fix(deploy): wire the edge HLS URL into the production template`
6. `docs: reconcile echoflow.in across compose files and docs`
