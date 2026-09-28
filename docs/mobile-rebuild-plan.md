# EchoFlow Mobile Rebuild — Implementation Plan & Change Record

**Branch:** `feat/mobile-rebuild`
**Base:** `01a8c70` → `338858d` → working tree
**Date:** 2026-09-28
**Scope:** (A) the backend changes the mobile client is blocked on, as
implemented; (B) the plan for the mobile client itself, not yet started.
**Approval:** items A1–A4 approved by the owner before implementation.

> **Status legend.** §1–§9 are *implemented and verified* — the code is on
> this branch. §10–§19 are the *plan* for the app, which has not been
> started. §20 is the issue log.

---

## Table of contents

**Part 1 — What was built**
1. [Why the backend had to change first](#1-why-the-backend-had-to-change-first)
2. [A1 — Native HLS token transport, part 1: issuing the token](#2-a1--native-hls-token-transport-part-1-issuing-the-token)
3. [A2 — Native HLS token transport, part 2: validating the header](#3-a2--native-hls-token-transport-part-2-validating-the-header)
4. [A3 — CGNAT-safe throttling](#4-a3--cgnat-safe-throttling)
5. [A4 — Production config: the edge URL and the domain](#5-a4--production-config-the-edge-url-and-the-domain)
6. [Verification](#6-verification)
7. [Deployment checklist](#7-deployment-checklist)

**Part 2 — The mobile app plan**
8. [The existing app: why it is a rewrite, not a repair](#8-the-existing-app-why-it-is-a-rewrite-not-a-repair)
9. [Architecture decisions](#9-architecture-decisions)
10. [The playback sequence](#10-the-playback-sequence)
11. [Error mapping](#11-error-mapping)
12. [Feature scope](#12-feature-scope)
13. [UI/UX port](#13-uiux-port)
14. [Directory layout](#14-directory-layout)
15. [Build phases](#15-build-phases)
16. [Testing strategy](#16-testing-strategy)
17. [Still-open backend items](#17-still-open-backend-items)

**Part 3 — Issue log**
18. [Issues found and how each was resolved](#18-issues-found-and-how-each-was-resolved)

---

# Part 1 — What was built

## 1. Why the backend had to change first

An audit of the repo, `docs/EXPLAIN/**`, and `docs/FRONTEND-REQUIREMENTS.md`
found that the HLS playback gate is correct **for browsers and unsatisfiable
for native players**. The existing `mobile/` app therefore cannot play a
single clip, and neither can the web app's HLS path in production.

The gate has two halves:

| Half | Where | Browser | Native |
|---|---|---|---|
| **Transport** — the URL shape, cookie scoping, TTL, edge behaviour | `media_urls.py`, `views/media.py`, `worker` | broken (404s at the edge) | broken |
| **Auth delivery** — how the token reaches the edge | `Set-Cookie` only | works (browser jar) | **impossible** |

Transport was already fixed on `main` by the `2026-09-28-local-hls-worker`
work. Auth delivery was not, and is not something a client can work around.

### The specific impossibility

`ef_hls_token` is set as `HttpOnly; Secure; SameSite=Lax; Path=/hls/`. A
React Native app has three problems with it simultaneously:

1. **The player has no cookie jar.** The token is consumed by
   `AVPlayer` (iOS) and `ExoPlayer`/`Media3` (Android). `AVPlayer` does not
   read `NSHTTPCookieStorage`, and ExoPlayer's `DefaultHttpDataSource` sends
   no `Cookie` header at all. Neither shares state with the app's
   `fetch`/OkHttp client.
2. **`HttpOnly` means the app cannot read it back out** to re-attach
   manually.
3. **`Secure` means it is dropped outright** over the plaintext-HTTP
   development stack.

Any one of these is a blocker. Together they mean a native client cannot
obtain the token *value*, so it cannot present a credential. Signing the
master playlist with a query parameter is not an alternative: RFC 3986 §5.2.2
strips query strings during relative-reference resolution, so every segment
the playlist names would be requested unsigned (this is already documented in
`docs/EXPLAIN/storage/02-hls-playback.md`).

**Conclusion:** the token must be delivered over a second transport. That is
A1 and A2 below.

---

## 2. A1 — Native HLS token transport, part 1: issuing the token

**File:** `backend/app/views/media.py`
**Tests:** `backend/app/tests/test_hls_token.py::TestNativeTokenTransport` (9 tests)

### Design

The same HMAC token is delivered two ways. The **cookie is still set
unconditionally** — the change is additive, so the web client is untouched
and a native client is free to use either.

| Caller | Response body | `Set-Cookie` | Edge accepts |
|---|---|---|---|
| Browser (no header) | `{"status": "ok"}` | yes | cookie |
| Native (`X-EchoFlow-Client: native`) | `{"status": "ok", "token": "…"}` | yes | header or cookie |

### Implementation

```python
NATIVE_CLIENT_HEADER = "X-EchoFlow-Client"
NATIVE_CLIENT_VALUE = "native"


def _token_response_body(request, token):
    body = {"status": "ok"}
    if request.headers.get(NATIVE_CLIENT_HEADER) == NATIVE_CLIENT_VALUE:
        body["token"] = token
    return body
```

`views/media.py:183` then becomes:

```python
response = Response(_token_response_body(request, token))
```

### Why the opt-in is *not* unconditional

Echoing a bearer credential into a JSON body is a real (if small) widening
of exposure, and it must be a deliberate widening. `HttpOnly` exists
specifically to stop script from reading the token; adding the value to a
body that a logging interceptor, an error reporter capturing response
bodies, or an XHR wrapper could capture undoes that property for no
functional gain on the web.

A caller that forges the header from a browser gains **nothing**: the token
is already scoped to the single clip (`payload["c"]` is checked against
`request_path`), the signature is HMAC-SHA256 over a server-held secret, and
`exp` is enforced. This is a change of *envelope*, not of *privilege*.

The match is exact and case-sensitive (`==`, not `.lower()`), pinned by a
parametrised test over `"web"`, `"NATIVE"`, `"native "`, `"ios"`, `""`,
`"browser-native"`. A sloppy client must not receive a credential in a body
it may log.

### What is asserted

| Test | Property |
|---|---|
| `test_native_client_receives_the_token_in_the_body` | opt-in works |
| `test_body_token_is_the_same_credential_as_the_cookie` | the two transports cannot diverge — if they did, a client reading one while the edge validates the other would 403 on every segment |
| `test_body_token_validates_against_the_clips_own_path` | end of the gate: accepted for its own path, rejected for another clip's |
| `test_non_native_client_does_not_receive_the_token_in_the_body` | default unchanged; the cookie is still issued |
| `test_only_the_exact_native_value_opts_in` | no prefix/case/wildcard match |
| `test_native_client_still_gets_the_cookie` | additive, not a replacement; cookie attributes unchanged |
| `test_native_flag_does_not_bypass_moderation` | an unmoderated clip is 403 for a native caller, with no token and no cookie |
| `test_native_flag_does_not_bypass_authentication` | anonymous is 401/403, no token |

---

## 3. A2 — Native HLS token transport, part 2: validating the header

**Files:** `workers/hls-token-worker/src/token.ts`, `src/index.ts`
**Tests:** `workers/hls-token-worker/src/token.test.ts` (8 tests)

### Design

The extraction moved out of the `fetch` handler and into `token.ts`, beside
`extractTokenFromCookie` and `validatePlaybackToken` — the module that
already owns token handling and is already the tested unit. `storage.test.ts`
existed but nothing covered the handler, so logic that decides *which
credential the edge trusts* would have been untested.

```ts
export const MEDIA_TOKEN_HEADER = "X-EchoFlow-Media-Token";

export function extractTokenFromRequest(request: Request): string | null {
  const fromCookie = extractTokenFromCookie(request.headers.get("Cookie"));
  if (fromCookie) return fromCookie;
  return request.headers.get(MEDIA_TOKEN_HEADER);
}
```

`src/index.ts:140` collapses to:

```ts
const token = extractTokenFromRequest(request);
```

Everything downstream — signature, version, `exp`, per-clip path scope — is
untouched, because both transports deliver the same HMAC string.

### Precedence is cookie-first, and that is a security decision

A web page's own script **cannot read** the `HttpOnly` cookie. It **can** set
an arbitrary request header. If the header were authoritative, any script on
`app.echoflow.in` could choose which credential the edge validates, turning
"authenticated by a token scoped to this clip" into "the page chooses".

Falling through to the header only when no token is extractable from the
cookie keeps the web path byte-identical and adds native as strictly the
otherwise-unauthenticated case. Pinned by
`test_prefers_the_cookie_over_the_header_when_both_are_present`.

### What is asserted

`test_falls_back_to_the_header_when_the_cookie_is_present_but_unrelated`
covers a subtlety worth naming: a browser sends *every* cookie it has for
the host, so the presence of a `Cookie` header does not mean *our* cookie is
present. The fallback keys on the **extracted value**, not the header's
presence — otherwise a user with an unrelated `ef_*` cookie could never
reach the native path.

---

## 4. A3 — CGNAT-safe throttling

**Files:** `backend/app/throttling.py` (new), `views/auth.py`, `app/urls.py`, `settings.py`
**Tests:** `backend/app/tests/test_throttling.py` (26 tests)

### The defect

`AnonRateThrottle` keys on `REMOTE_ADDR`. On a server that approximates "one
caller". On a mobile network it is one **carrier NAT gateway** serving
thousands of subscribers. Two endpoints inherited `anon` (100/hour/IP) and
both fail for legitimate users, not attackers:

**`POST /auth/token/refresh/`** — the worst. `urls.py:18` used a bare
`TokenRefreshView` with no `throttle_scope`, so it inherited `anon`. Access
tokens live **15 minutes** (`SIMPLEJWT['ACCESS_TOKEN_LIFETIME']`), so every
active user refreshes ~4×/hour. A single cell needs `4 × subscribers`
refreshes/hour out of a shared 100/hour budget. The first few dozen users on
a cell exhaust it and **every one of them is logged out**, within minutes,
with no error on the server — every response was a correct 401.

**`POST /auth/register/`** — scoped `register: 5/hour` per IP. New-user
signup is the growth metric. 5/hour per cell caps it, not the attacker.

### Fix for refresh — key on the verified subject, not the address

A refresh token is a *signed, verified* credential that already carries
`user_id`. `RefreshTokenRateThrottle` reads the principal out of the request
itself, so the rate becomes a function of the token rather than the network
path:

```python
class RefreshTokenRateThrottle(ScopedRateThrottle):
    scope = 'token_refresh'

    def get_cache_key(self, request, view):
        user_id = self._resolve_user_id(request)
        if user_id is not None:
            ident = f'user:{user_id}'
        else:
            ident = f'ip:{self.get_ident(request)}'
        return self.cache_format % {'scope': self.scope, 'ident': ident}
```

**Signature verification is mandatory, not an optimisation.** If the throttle
merely *decoded* the payload, an attacker could flip `user_id` in a stolen
token and mint a fresh bucket per forged subject — converting a rate limit
into no rate limit. `RefreshToken(raw)` validates signature and expiry and
raises `TokenError` otherwise, so the IP fallback is reached only when the
token is genuinely unusable. Pinned by
`test_tampered_token_is_not_trusted_as_a_subject`.

`request.data` is read inside a `try` because DRF raises `ParseError` for a
body it cannot read, and a throttle must never turn a 400 into a 500 (see
issue [I5](#i5-parseerror-escaped-the-resolvers-except-clause)).

**Rate: `120/hour`,** ~30× the 4/hour baseline — enough for clock skew,
boundary retries, and multi-device sign-in, while still bounding a leaked
token. `test_the_configured_rate_matches_the_token_lifetime` asserts the
*relationship* to `ACCESS_TOKEN_LIFETIME` rather than the literal, so
changing the token lifetime cannot silently break refresh.

### Fix for registration — raise the IP rate, add a second axis

Registration is anonymous by definition, so the IP key cannot be removed.
What changes is the sizing and the addition of a limit that sees what the IP
key cannot:

| Scope | Rate | Key | Bounds |
|---|---|---|---|
| `register` | **200/hour** (was 5) | IP | traffic from one source address |
| `register_username` | 3/hour | username | one host cycling through accounts; repeated re-registration to squat or reclaim a handle |

3/hour leaves room for a genuine user who typos twice and succeeds on the
third attempt. Usernames are lower-cased before keying: `User.username` is
case-sensitive, but one actor re-registering as `Alice` then `alice` is one
actor fishing for one handle, and lower-casing can only *merge* buckets —
never let an attacker fan out across many.

`AnonRateThrottle` was dropped from `RegisterView.throttle_classes`
explicitly: it was implicitly active at 100/hour, looser than the new
200/hour, so keeping it only made the effective limit the tighter of the two.

### The footgun this nearly shipped

`ScopedRateThrottle.allow_request` reads its scope from the **view** and
returns `True` — allowing with no accounting — when the view does not declare
one. The first version of this change listed the throttle class on
`ThrottledTokenRefreshView` without `throttle_scope`, which would have
replaced a too-tight limit with **no limit at all**, silently. See issue
[I4](#i4-silently-unthrottled-the-endpoint-by-omitting-throttle_scope).

`TestRefreshThrottleWiring` now asserts the wiring, because a wiring mistake
raises nothing for a behavioural test elsewhere to catch:
`test_refresh_view_declares_the_scope`, `test_refresh_view_uses_the_user_keyed_throttle`,
`test_the_endpoint_is_actually_rate_limited`,
`test_a_view_without_a_scope_is_unthrottled` (pins the DRF behaviour the
previous test protects against), and two tests that the new scopes exist in
settings — `get_rate()` raises `ImproperlyConfigured` for an unregistered
scope, which would be a **500 on every refresh** rather than a 429.

### Deliberately left alone

`/legal/`, `/grievance/`, `/data-subject/` keep IP-keyed limits. They are
user-initiated, low-frequency and low-volume, so sharing a bucket across a
cell is correct there rather than a bug.

---

## 5. A4 — Production config: the edge URL and the domain

### A4a — `PUBLIC_HLS_ENDPOINT_URL` was missing from the production template

`.env.vps.example` set `MEDIA_TOKEN_COOKIE_DOMAIN` but **not**
`PUBLIC_HLS_ENDPOINT_URL`. With it unset, `settings.py` falls back to
`PUBLIC_MEDIA_ENDPOINT_URL` and `HLS_URL_STYLE` resolves to `"bucket"`, so a
real VPS deploy emits:

```
https://media.echoflow.in/echoflow-media/hls/<id>/master.m3u8
```

and the Worker rejects it — it 404s any path not starting with `/hls/`,
because an edge fronting the bucket does not expose the bucket as a path
segment. **A silent outage**: no error, just 404s on every playlist.

The new settings were wired into `.env.example` and `docker-compose.local.yml`
but not the production template. Fixed by adding to `.env.vps.example`:

```
PUBLIC_HLS_ENDPOINT_URL=https://media.echoflow.in
HLS_URL_STYLE=edge
```

`HLS_URL_STYLE` is set explicitly rather than relying on the
"`edge` if `PUBLIC_HLS_ENDPOINT_URL` is set" default, so that changing one
without the other is visible in review. The same three are pinned in
`docker-compose.vps.yml`'s `environment:` block so a stale or incomplete
`.env` cannot reintroduce the failure.

### A4b — the domain was written two ways

`echoflow.in` (Worker route, all five `.env*.example`) versus
`echo-flow.in` (3 compose files, `AGENTS.md`, 9 docs). This was not cosmetic
once the edge was real: the Worker route is `media.echoflow.in`, so a deploy
from the documented path pointed the cookie `Domain` (`.echoflow.in`) at a
media origin it does not cover, and every segment would 403.

Owner confirmed `echoflow.in` is the registered zone. `echo-flow.in` →
`echoflow.in` applied to `docker-compose.yml`, `docker-compose.vps.yml`,
`docker-compose.laptop.yml`, `AGENTS.md`, `docs/TODO.md`, and the
`DEPLOYMENT/` + `storage/` docs — **133 occurrences across 13 files**.
`docs/old_docs/` is archival and was left alone deliberately.

---

## 6. Verification

| Suite | Result |
|---|---|
| `test_throttling.py` (new) | **26 passed** in 6.7s |
| `test_hls_token.py` | **47 passed** (38 pre-existing + 9 new) |
| `test_https_termination.py` | 32 passed, 6 skipped (live-nginx, environmental) |
| `workers/hls-token-worker` vitest | **22 passed** (14 pre-existing + 8 new) |
| `npx tsc --noEmit` | clean |
| Full backend suite | **37 stable failures — identical to baseline. Zero regressions.** |

### Live end-to-end verification of the native transport

Unit tests are not sufficient for a change whose whole point is the wire
format. Both transports were exercised through the real path — nginx `:18443`
→ Django, nginx `:19443` → Worker → MinIO — against a seeded probe clip:

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | `X-EchoFlow-Client: native` | body contains `token` | ✅ `{"status":"ok","token":"eyJj…"}` |
| 2 | no header (web default) | body unchanged | ✅ `{"status":"ok"}` |
| 3 | header → `master.m3u8` | 200 | ✅ 200 |
| 4 | no credential | 403 | ✅ 403 |
| 5 | valid token, **different** clip's path | 403 | ✅ 403 (per-clip scope) |
| 6 | native caller | cookie still set | ✅ `Set-Cookie: ef_hls_token=eyJj…` |
| 7 | **bad cookie + good header** | 403 — cookie wins | ✅ 403 |
| 8 | good cookie | 200 | ✅ 200 |
| 9 | unrelated cookie + good header | 200 — fallback keys on the extracted **value**, not the header's presence | ✅ 200 |
| 10 | header on a sub-resource | authorised (not 403) | ✅ 404 — token accepted, object absent |

Two operational traps were hit and fixed during this, both now in
`docs/EXPLAIN/storage/05-local-hls-worker-runbook.md` §"Before you trust a
manual verification" and in `AGENTS.md`:

- **gunicorn does not re-read bind-mounted source.** Checks 1–2 returned the
  old body even though pytest passed and `grep` in the container showed the
  new code. Fixed by restarting `web_local`. Diagnosing this by testing
  against gunicorn directly on `:18000` (bypassing nginx) proved nginx was
  not stripping the header.
- **A stale `django-redis` connection 500s.** `ConnectionInterrupted` out of
  the throttle check turned `/auth/login/` into a 500 debug page; transient,
  cleared on retry.

### Establishing "zero regressions" rigorously

A single full-suite run is not evidence; the failure set has to be
*stable*. Runs were diffed with `comm` against a stashed baseline:

- Baseline (my changes stashed, `test_throttling.py` ignored): **37 failures**
- Run 3 with changes: 40 · Run 4 with changes: 38
- `comm -12 baseline ∩ (run3 ∪ run4)` = **37** — the stable set is exactly
  the baseline set
- `comm -13 baseline \ (run3 ∪ run4)` = 4 tests that appear in *some* runs

Those 4 (`test_counter_store` ×1, `test_revenuecat` ×2,
`test_services_interactions` ×1) **shift between two runs of identical code**
and **pass in isolation** (4 passed in 6.9s). They are pre-existing
order-dependence in the Redis-state-sensitive metrics cluster under a
contended local stack, aggravated by residual cache state from an aborted
run — not caused by this work. Documented in [I8](#i8-suite-failures-were-a-misleading-signal).

Also unchanged and pre-existing: 4 scraper test modules fail to *collect*
(`ai_ml.scrapers.state` deleted in `5c9c2d6` while `scrape_audio.py` and the
tests still import it — already recorded in `AGENTS.md`).

---

## 7. Deployment checklist

Changes **A1/A2** are backward compatible — the web client is byte-identical.
Nothing needs deploying before the app is built.

Before the first native build is tested against production:

- [ ] `PUBLIC_HLS_ENDPOINT_URL=https://media.echoflow.in` in the VPS `.env`
- [ ] `HLS_URL_STYLE=edge` in the VPS `.env`
- [ ] `MEDIA_TOKEN_COOKIE_DOMAIN=.echoflow.in` in the VPS `.env` (already in the template)
- [ ] `MEDIA_TOKEN_SECRET` byte-identical between Django and the Worker
      (`npx wrangler secret put MEDIA_TOKEN_SECRET`)
- [ ] `ALLOWED_HOSTS` contains `api.echoflow.in` (now the compose default)
- [ ] Worker deployed: `.github/workflows/deploy-hls-worker.yml` on push to `workers/hls-token-worker/**`
- [ ] `GET https://media.echoflow.in/healthz` → `200 {"status":"ok","backend":"r2"}`
      (503 means the secret is unset — this is the new fast failure signal)

For **physical-device development** (see [I9](#i9-there-is-no-phone-dev-loop)):
`PUBLIC_HLS_ENDPOINT_URL` and the API base must both be a LAN-reachable
origin, and the device needs a certificate covering that address. Per owner
decision, certificate setup stays manual and is documented rather than
committed.

---

# Part 2 — The mobile app plan

## 8. The existing app: why it is a rewrite, not a repair

`mobile/` is 3,200 LOC across 13 source files, 5 commits inside 8 days, then
abandoned. It is not a starting point.

### Functional defects

| # | Defect | Evidence |
|---|---|---|
| 1 | **Scrolling never changes the track.** `onViewableItemsChanged` is stored in a `useRef(...).current`, so its closure permanently captures the first render's `clips = []`. `clips[index]` is always `undefined`; `playClip` is never called. You hear clip #0 forever. | `FeedScreen.tsx` |
| 2 | **Listening to the end increments the skip counter.** Natural completion fires `registerSkip` with `listen_duration_ms: 0`. The recommender ranks on `avg_completion_rate` — this corrupts it. | `audioPlayer.ts`, `PlayerContext.tsx` |
| 3 | **The feed is drained on every interaction.** `loadFeed` has `currentClip` in its dep array → `setCurrentClip` → refetch → `redis lpop 10` **more**. | `FeedScreen.tsx` |
| 4 | **No auth screen exists.** `api.ts` has no `login`/`register`; `AuthContext.login` is defined and never called. A fresh install is 100% dead — every screen 401s. | `api.ts`, `AuthContext.tsx` |
| 5 | **`toggleFollow` sends GET to a POST-only route** → 405. Never called, so never noticed. | `api.ts` |
| 6 | **Telemetry measures wall-clock**, not watch time. Pauses, buffering and failed loads all count. | `audioPlayer.ts` |
| 7 | **`downloadFirst=true`** (the `expo-av` default) downloads the entire stream before playing. | `audioPlayer.ts` |
| 8 | **`consentAccepted = useState(true)`** — pre-ticked consent. DPDP §11 requires affirmative consent. | `UploadScreen.tsx` |

### Structural

7 of 21 dependencies unused (`expo-linear-gradient`, `expo-constants`,
`react-native-reanimated`, `react-native-gesture-handler`,
`react-native-svg`, `expo-asset`, `@react-navigation/native-stack`).
Zero tests. `app.json` references `./assets/icon.png`, `splash.png`,
`adaptive-icon.png` — **none exist**, so any build fails. `expo-av` is
**removed in Expo SDK 55**. JWTs in plaintext `AsyncStorage`. No design
system: 8 duplicated `StyleSheet.create` blocks, 130+ hardcoded hex
literals, 16 alpha steps, `#FF6321` ×55, zero tokens. `scheme: "echoflow"`
declared with zero link handlers.

### Decision

Delete `mobile/src` and rewrite, in place, on this branch — one commit to
remove the old tree so the diff history stays readable. Git preserves the
history; the salvage list in [§20](#20-salvage-list) captures the few
*patterns* worth keeping.

---

## 9. Architecture decisions

| # | Decision | Rejected | Why |
|---|---|---|---|
| D1 | **Expo SDK 55, managed workflow, `expo prebuild` (CNG)** | bare RN | `expo-secure-store`, `expo-audio` (with the background-playback plugin), `expo-blur`, `expo-updates` all need native config; CNG writes `ios/`/`android/` at build time so no checked-in native project rots. No Expo UI kit — vanilla RN primitives keep ejecting possible. |
| D2 | **`expo-audio`, not `react-native-track-player`** | RNTP | SDK 55's config plugin ships `AudioControlsService` (Android MediaSessionService) and `UIBackgroundMode: audio` (iOS) automatically, including lock-screen controls. Also natively HLS-capable and — critically — supports **`AudioSource.headers`**, which is the transport A1/A2 exist to feed. |
| D3 | **`expo-router` (file-based)** | React Navigation | Deep linking, typed routes and universal links come for free. The old app declared `scheme: "echoflow"` and had zero handlers; expo-router fixes that structurally. Auth via route groups `app/(auth)/` vs `app/(tabs)/`. |
| D4 | **TanStack Query v5 (server) + Zustand (client) + MMKV/SecureStore** | React Context | Defects 1 and 3 above are both symptoms of hand-rolled cache state. TanStack Query owns every server read; Zustand holds only player/auth/preferences. Tokens → `expo-secure-store` (Keychain/Keystore), not MMKV. |
| D5 | **Zod at the API boundary** | trust the types | The backend has **four** coexisting response envelopes: PageNumber `{count,next,previous,results}`, Cursor `{next,previous,results}` (no `count`), hand-rolled `{"results":…}` whose `next` is the *string literal* `"auto_trigger"`, and a **bare top-level array** (`/share/inbox/`). `GET /feed/` can return **202** with `retry_after_ms`. And `SubscriptionStatusSerializer.limits` is `DictField(child=CharField)` — **every value arrives as a string**, including `max_clip_duration_seconds: "60"`. Parse once at the boundary. |
| D6 | **Design tokens in TypeScript + `StyleSheet.create`** | NativeWind | The identity is `backdrop-filter: blur()` glass, **coloured outer glows with no elevation scale**, radial gradient orbs, 8-digit-hex alpha tinting. NativeWind handles none of these cleanly, and RN's cross-platform glow story is a `Platform.select` problem regardless. Fighting the tool on the surfaces that define the product is the wrong trade. The system is ~20 values; it belongs in one typed file. |
| D7 | **`sample_frontend2` is the design source of truth** | `frontend/src` | `sample_frontend2` is the only mobile-first, tokenised, light/dark-aware frontend (Material 3, terracotta `#e8a87c` on midnight `#121416`, Lexend, 470px phone column, vertical scroll-snap reels). `frontend/src` is a desktop developer console. The old `mobile/` ported `frontend/src`'s palette and dropped all the substance. |
| D8 | **No native IAP in the MVP** | RevenueCat SDK now | `AGENTS.md` states RevenueCat **excludes Indian users** — our target market. Independently the backend has six defects: `revenuecat_app_user_id` is exposed by **zero** serializers (so `Purchases.logIn()` has no stable non-guessable ID); entitlement matching is by `product_id` against `REVENUECAT_ENTITLEMENT_ID="pro"`, which can never match real payloads (`pro_monthly`/`pro_annual`); `services/revenuecat.py:139` references `user.uuid`, which **does not exist** → HTTP 500 on `/subscription/manage/`; `POST /subscription/sync/` is fire-and-forget with no completion signal. **MVP ships:** read `GET /subscription/` → drive UI limits, soft-enforce the 60s free cap client-side (the server does not enforce it despite advertising it), "Upgrade" opens the web customer portal. |
| D9 | **nginx `:443` only, no platform fork** | debug escape hatch | The old default was `http://localhost:8005` / `http://10.0.2.2:8005` — the plaintext escape hatch `AGENTS.md` says to drop. `EXPO_PUBLIC_API_BASE_URL` per EAS build profile. |
| D10 | **`echoflow.in`** | `echo-flow.in` | Owner-confirmed registered zone; matches the Worker route and env templates. Reconciled in A4b. |

---

## 10. The playback sequence

The heart of the app. Post-A1/A2 this is short and fully specified.

```
1. Feed returns a clip with hls_playlist_url
   → use VERBATIM. Never rebuild it. Never prefix the API base onto it.
     (FRONTEND-REQUIREMENTS.md §4.7 documents both existing clients doing
      exactly that, and it is wrong: the storage origin carries a port and the
      edge is a different host.)

2. App: POST /media/playback-token/{id}/
       Authorization: Bearer <access JWT>
       X-EchoFlow-Client: native
   ← 200 {"status":"ok","token":"<b64url-payload>.<b64url-sig>"}
   ← 409 {"detail":"Clip media is not ready."}   → still processing
   ← 403 {"detail":"Content not available."}     → unmoderated

3. App: player.replace({
       uri: clip.hls_playlist_url,
       headers: { 'X-EchoFlow-Media-Token': token }
     })
   expo-audio applies headers to the manifest AND every segment, on the
   native stack, where the cookie would never have travelled.

4. Worker validates header (or cookie) on every /hls/* request:
   signature → version → exp → per-clip path scope.
```

### Token cache

In-memory `Map<clipId, {token, expiresAt}>`. TTL is 600s; refresh when under
120s remains. Scope is per-clip, so one token serves exactly one clip.
**Prefetch** the next clip in the queue on `activeIndex` change — the
endpoint is cheap and the alternative is a stall on swipe.

### Race guard

A monotonically increasing `loadGeneration` counter. A load resolving with a
stale generation is discarded. The old app has no guard, so a slow load can
resolve after a fast one and win.

### No cookies anywhere in the app

The `fetch` cookie jar is irrelevant; the header travels on the native
stack where it matters. The app should not read, store, or forward
`ef_hls_token`.

### Player placement

One `useAudioPlayer` instance, created **once at app root**, outside the feed
screen. The old app's most expensive error was the player being owned by the
card, so it unmounted with the view.

---

## 11. Error mapping

The API returns four distinct failure modes for a clip. The old app collapsed
all of them into "Failed to load audio track" and swallowed it.

| Condition | Card renders |
|---|---|
| `409` from playback-token | still processing → spinner on artwork, retry in 5s |
| `403` | unavailable/removed tombstone (also what a moderation rejection looks like) |
| `404` | gone |
| `200` + `token` | play |
| Network failure | retain last good state, show `NetworkBanner` |

The `409` branch is a direct benefit of the `2026-09-28` work, which replaced
a would-be `AttributeError` (`rsplit` on `None`) with an explicit conflict.

---

## 12. Feature scope

### MVP — in

**Auth.** Register (`username`/`email`/`password`/**`consent_accepted`**/**`terms_version`**/**`dob`**/**`parent_email`** if under 18), login, logout (`POST /auth/logout/` blacklists the refresh), silent session restore, 15-minute proactive refresh, `SecureStore` tokens, explicit "session expired" signal, 401 replay-once, error boundary at the navigator root.

> **Registration is currently broken in every client.** `RegisterSerializer` requires `consent_accepted` and `terms_version`; all clients send only `username/email/password`, so every registration 400s. The app must send them — see [§17](#17-still-open-backend-items) for the backend half.

**Onboarding.** 2-step non-dismissible wizard → `POST /tags/initialize/` for cold-start vector bootstrap. Reachable from Settings.

**Feed.** Vertical snap reels; autoplay at 70% viewability; 1000ms inter-reel pause; tap-to-toggle-play; 100px play/pause overlay; 40-bar decorative waveform; ambient orbs; **seekable** progress bar (the old app had a progress bar with no seek UI); timecode; ±10s skip; hands-free auto-advance toggle; degraded banner; 202 cold-start retry honouring `retry_after_ms`.

**Interactions.** Like (optimistic + rollback, haptics, ripple); double-tap-to-like with heart burst; CommentSheet (list, post, **reply**, edit own, delete own); ShareModal (`find-user` debounce → `send-share`); follow/unfollow (POST); 5s telemetry heartbeat from `player.currentTime` with the `position < duration × 0.9` completion guard; flush on pause/skip/background/unmount; 1-per-5s cap, drop-oldest on 429.

**Explore.** Category pills, paged `/suggestions/`, pull-to-refresh, empty/error states.

**Profile.** Own (avatar upload via `PATCH /profile/me/update/`, counts, liked clips) and public (follow/unfollow, their clips).

**Inbox.** Share inbox, unread badge (30s poll), mark-read, play a shared clip full-screen.

**Upload.** Record via `expo-audio`, or pick from library; live level meter (`isMeteringEnabled` is already on and unused in the old app); hard stop at the tier limit; title/category/**`license_type`**/**`copyright_owner_name`**/copyright acknowledgement (unchecked by default); upload **with progress** via `XMLHttpRequest.upload.onprogress` + cancel; then `POST /clips/{id}/approve-moderation/` and poll `GET /clips/{id}/` through a 4-stage pipeline to `ready`/`failed`/`rejected`, with a local notification on completion.

**Settings / Legal.** Theme; notification permission; `GET /subscription/` limits; Compliance/Grievance/Nodal officers + physical address; grievance form; data-access summary; **erase account** (Apple and Google both mandate in-app deletion); logout.

### MVP — out, with reasons

| Excluded | Why |
|---|---|
| Server-side push | No `POST /devices/register/`. Local notifications only. |
| Native IAP | D8. |
| Saved / Library | No backend entity. |
| Full-text search | No endpoint. |
| Follower / following lists | No endpoint. |
| Universal-link web pages | Needs a Cloudflare Pages route. |
| Light theme | Tokens ship it; dark-only at MVP, matching `userInterfaceStyle: "dark"`. |
| Tablet layout | `supportsTablet: false`. |

### v1.1
Now Playing screen (expand from MiniPlayer) · playback speed 1/1.25/1.5/2× · real audio-reactive visualizer · swipe-to-dismiss · hands-free gesture mode · edit/delete own clips · follower lists.

### v1.2
Native IAP (after the RevenueCat defects) · server push · light theme · search · saved clips · `react-native-track-player` only if `expo-audio`'s lock-screen controls prove insufficient.

---

## 13. UI/UX port

From `sample_frontend2/src/styles/globals.css` + `tailwind.config.js` →
`src/design/tokens.ts`.

```
FONT      Lexend 300–900 (@expo-google-fonts/lexend); weight + tracking do the work
BG        #121416      SURFACES  #0c0e10 / #1a1c1e / #1e2022 / #282a2c / #333537
BRAND     terracotta #e8a87c → hover #d4956a   (135° gradient, #000 text)
2ND       sage #aad0b1    3RD  honey-gold #f1ce6d
LIKE/ERR  #ffb4ab (white icon + count on top, salmon glow)
ON-SURF   #e2e2e5   ON-SURF-VAR #d5c3b9   OUTLINE #9d8e84   OUTLINE-VAR #51443d
GLASS     rgba(18,20,22,0.6) + blur(20px)      TINT  ${c}08/0A/18/22/33/44/55
RADIUS    card 48 · sheet 22 · dialog 20 · chip full
LAYOUT    14px gutter · 56px header · 100px nav clearance · 470px content cap
GLYPHS    22px icons · 9px nav · 10px counts · 11px labels · 13px body · 20px title · 28px page
TRACKING  +0.02em title → +0.08em uppercase micro-labels
GLOW      0 0 {6,8,12,16,20,24,32}px var(--accent-glow)   ← Platform.select, see D6
BLUR      6 scrim · 8 scrim · 10 button · 16 modal · 20 chrome
EASE      pop 0.35s cubic-bezier(.34,1.56,.64,1) · slide 0.32s cubic-bezier(.22,.61,.36,1)
          progress fills linear 0.1s
Z         nav 200 < sheet 800 < toast 5000 < onboarding 7000 < netbanner 8000
PACING    1000ms after progress ≥ 0.99, then advance
CATS      instrumental #00e5a0 · funny #f59e0b · news #60a5fa · science #8b5cf6 · music #ff6b35
          waveform → to top: ${c}, sage | progress → 90deg: ${c}, terracotta
```

### Ported from `frontend/src` because `sample_frontend2` lacks it

Real audio-reactive visualizer (it uses an `AnalyserNode`; the RN equivalent
is a deterministic pseudo-reactive envelope on the UI thread via Reanimated
— **not** `Math.random()`, which the old app re-rolled on every render) ·
playback-rate cycling · a Now Playing screen · double-tap-to-like (the web
code reserves the slot but its pause branch is an empty block) ·
`active:scale-0.96` press states · `RotateCw`/`RotateCcw` instead of the
semantically-wrong `SkipForward`/`SkipBack` for ±10s.

### Deliberately not ported

The CRT `scan-line` (undefined class, cyan from the discarded cyberpunk
theme) · the `Math.random()` decorative waveform · `alert()` in comment
handlers · `Light`/`Dark` segmented control that flips on both taps · the
Settings theme bug · the 16 defects catalogued in the design extraction.

### Known porting problem

The web "glow" is `box-shadow: 0 0 20px rgba(...)`. On iOS,
`shadowColor`/`shadowOpacity`/`shadowRadius` with `shadowOffset: {0,0}`
reproduces it. **On Android it does not.** → `src/design/shadows.ts` with
`Platform.select` branches; Android falls back to `expo-linear-gradient`
glow rings on the few hero elements (create FAB, liked heart) and drops the
rest. A deliberate visual degradation, documented rather than hidden.

The dot-matrix overlay (`radial-gradient` repeating pattern) has no
React Native equivalent. Either render a small absolute-positioned dot grid
or drop it; dropping is the honest MVP call.

### Accessibility

The web declares `--tap-target: 64px` and violates it everywhere (bare
`<X size={20}/>` ≈ 20pt; a 40px skip pair). Mobile minimums are enforced:
**≥44pt iOS / ≥48dp Android** on every control, with `accessibilityRole`,
`accessibilityLabel`, and `hitSlop` on icon-only buttons.

---

## 14. Directory layout

```
mobile/
├── app/                              expo-router
│   ├── _layout.tsx                    providers + theme + font load
│   ├── (auth)/{login,register}.tsx
│   ├── (tabs)/{index,explore,studio,inbox,profile}.tsx
│   ├── clip/[id].tsx  user/[id].tsx  settings/*.tsx  legal/*.tsx
│   └── +not-found.tsx
├── src/
│   ├── api/          client.ts (fetch+timeout+refresh+error) · schema.ts (zod) · endpoints/*.ts
│   ├── design/       tokens.ts · theme.tsx · shadows.ts · typography.ts · icons.tsx
│   ├── components/   ui/ (Glass, Chip, Button, Sheet, Toast, Spinner, Waveform, Equalizer)
│   │                 reel/ (ReelCard, WaveformBar, ActionCluster, CoverArt)
│   │                 overlays/ (CommentSheet, ShareModal, OnboardingModal, NetworkBanner)
│   ├── features/     auth/ feed/ upload/ inbox/ profile/ explore/ subscription/ legal/
│   ├── store/        auth.ts player.ts feed.ts prefs.ts   (zustand)
│   ├── hooks/        useFeedBuffer useWatchTelemetry usePlaybackToken useBackendStatus
│   ├── lib/          env.ts logger.ts sentry.ts
│   └── types/
├── assets/           icon / splash / adaptive-icon / notification icon   ← generate
├── e2e/              *.maestro.yaml
├── app.config.ts · eas.json · .env.example · .env.local
└── metro.config.js · babel.config.js · jest.config.js
```

### Key modules

**`store/player.ts`** — owns the single `useAudioPlayer` instance created
**once at app root**, outside the feed. Queue, `activeIndex`,
`loadGeneration`, `handsFree`.

**`hooks/useWatchTelemetry.ts`** — 5s heartbeat off `player.currentTime`.
Returns `{watchTimeMs, positionMs, durationMs, reason}`. Sends
`log-telemetry` always; sends `register-skip` **only** when
`position < duration × 0.9` **and** the transition was user-initiated. This
single function is where the old app corrupted the recommender.

**`hooks/useFeedBuffer.ts`** — accumulates pages from `/feed/` into a capped
(60) deduped buffer; falls back to `/suggestions/?category=all` on
202/degraded; never re-requests a consumed page (`GET /feed/` is a
destructive `lpop`).

**`hooks/usePlaybackToken.ts`** — token cache + prefetch per §10.

---

## 15. Build phases

Each phase is independently shippable; one atomic commit each.

| Phase | Delivers | Gate |
|---|---|---|
| **0** | ✅ **Backend PRs A1–A4** (this branch) | done |
| **1** | Scaffold: SDK 55, expo-router, tokens, UI primitives, API client + zod, auth (register with consent + age gate, login, logout, session restore), error boundary, assets | A3 |
| **2** | Onboarding + feed shell + player core — one clip plays end-to-end with the token header | A1, A2, Phase 1 |
| **3** | Feed interactions: like, comment sheet, share, follow, telemetry, haptics, degraded/202 handling | Phase 2 |
| **4** | Explore, Profile (own + public), Inbox | Phase 3 |
| **5** | Upload: record, progress, approve-moderation, status pipeline, my-clips | Phase 3 |
| **6** | Settings + Legal + Pro gating + Sentry + polish | Phase 4 |
| **7** | `eas.json`, store metadata, `eas update` channels, Maestro E2E, CI | Phase 6 |

**Distribution.** `eas.json` with `development`/`preview`/`production`, per-profile
`EXPO_PUBLIC_API_BASE_URL`, `runtimeVersion`, and `eas update` channels so a
JS-only fix ships in ~1 minute without App Store review. Note: EAS Build's
free tier will not carry production.

---

## 16. Testing strategy

Proportionate to the risk: test the logic that actually broke, not the pixels.

**Jest + `@testing-library/react-native`:**
- `useWatchTelemetry` completion guard (defect 2 — the costliest bug)
- `api.ts` refresh rotation, 401 replay, 429 backoff
- `useFeedBuffer` dedupe, 202 handling (defect 3)
- zod parsing of all four response envelopes + string-typed `limits`

**Maestro — 3 flows only:** register → onboard → play · like + comment + share ·
record → upload → status → ready.

**Deliberately excluded:** component snapshot tests. The tokens are the
contract, not the rendered output.

---

## 17. Still-open backend items

Not blocking the app, but needed for full feature parity. Each is a real
defect with an owner decision required.

| # | Item | Impact | Priority |
|---|---|---|---|
| B4 | `finalize_upload` does not enqueue `process_audio_to_hls`; only `approve-moderation` triggers it, and **any authenticated user can call it on any clip** (unscoped `get_object_or_404`) — a moderation bypass and a compute-abuse vector | The app works around it by calling approve on its own clip | P1 |
| B5 ✅ | `tags` and `duration_ms` absent from `FeedClipSerializer` | No tag chips; scrubber duration must be derived from the player | P1 |
| B6 ✅ | `GET /legal/compliance/` omits `terms_versions`, `privacy_version`, `physical_address` | The app cannot submit a *valid* `terms_version` without hardcoding `v1.0`; IT Rules 2021 R4(4) requires the physical address | P1 |
| B7 ✅ | `CommentSerializer` has no `author_id` | No tappable comment authors | P2 |
| B8 | `Report` has no `clip` FK and no `report_reason` enum | In-app reporting is decorative; IT Rules 2021 R3(1)(b) requires categorised handling | P2 |
| B9 ✅ | `PlaybackTokenView` has no `throttle_scope` | Draws from the shared 1000/hr `user` bucket; a fast-scrolling feed mints ~1 token per clip | P2 |
| — | Registration returns no tokens and no `id` | App must follow up with a second `login` call | by design |
| — | RevenueCat: 6 defects (see D8) | Native IAP impossible | v1.2 |
| — | `dob` is optional, so the DPDP §9 age gate is bypassed by omission; `minor_consent_verified` has no setter; no telemetry block for unverified minors | Compliance gap | P1 |
| — | `POST /data-subject/erasure/` never deletes anything but reports "Data erasure process initiated" | False success message; DPDP §12 | P1 |
| — | `ConsentAudit.ip_address` uses `REMOTE_ADDR` only, so behind nginx it records the proxy IP (`AuditLog` correctly falls back to `HTTP_X_FORWARDED_FOR`; `ConsentAudit` does not) | Weak DPDP §5(1) notice evidence | P2 |
| — ✅ | **`PlaybackTokenView` performs no entitlement check at all** (B9 above is only the throttle). It verifies `IsAuthenticated`, clip exists, `moderation_approved`, and HLS present — nothing else. `FastFeedViewSet` filters `is_noncommercial=False, requires_share_alike=False`; this view applies neither | **Live licensing bypass** — any logged-in user can mint a token for an NC/SA clip the feed deliberately withholds. The intended check exists only as a comment that was deferred ("a future hardening pass can add explicit authorization here"), and the docstring additionally falsely claimed `ShareViewSet` handled share-link auth | **P0** |
| — ✅ | `POST /auth/register/` returns **400 for the design-source frontend**: `sample_frontend2/src/api/client.ts:92` sends only `{email, username, password}`, but `RegisterSerializer` requires `consent_accepted` and `terms_version` (`serializers.py:435-436`). It also omits `dob` | Registration is non-functional, so ISSUE-01's DPDP §6 consent capture is unreachable in practice. Blocks mobile Phase 1 | **P0** |

---

# Part 3 — Issue log

Every problem hit while implementing Part 1, and what was actually done.
Three of these were defects in my own first implementation that the tests
caught — they are recorded in full because each one would have shipped a
silent production failure.

## Issues in the existing system

### I1 — The HLS token is unreachable for any native client
`ef_hls_token` is `HttpOnly` + `Secure` + `Path=/hls/`, and AVPlayer/ExoPlayer
have no shared cookie jar. A React Native client could neither obtain nor
present the credential. Query-string signing is not an alternative: RFC 3986
§5.2.2 strips query strings during relative-reference resolution, so every
segment would be requested unsigned.

**Fixed by** A1 + A2. Not worked around — there is no client-side fix, and a
temporary public-read `hls/` was explicitly rejected, because it would mean
testing against a transport that does not ship.

### I2 — Production would have emitted URLs the Worker 404s
`.env.vps.example` set `MEDIA_TOKEN_COOKIE_DOMAIN` but not
`PUBLIC_HLS_ENDPOINT_URL`, so `HLS_URL_STYLE` resolved to `bucket` and Django
emitted `/echoflow-media/hls/…` against a Worker that rejects any path not
starting `/hls/`. A silent outage with no error.

**Fixed by** A4a — the setting added to `.env.vps.example` *and* pinned in
`docker-compose.vps.yml`.

### I3 — The domain was written two ways, and it now mattered
`echoflow.in` vs `echo-flow.in` across 133 occurrences in 13 files. Once the
edge was real this was a live 403: the Worker route is `media.echoflow.in`
and the cookie `Domain` (`.echoflow.in`) would not cover a
`media.echo-flow.in` origin.

**Fixed by** A4b. `docs/old_docs/` excluded as archival.

## Issues in my own implementation, caught by the tests

### I4 — Silently unthrottled the endpoint by omitting `throttle_scope`

`ScopedRateThrottle.__init__` is a no-op; it reads its scope from the **view**
inside `allow_request` and returns `True` — allowing with no accounting —
when the view declares none. The first version of `ThrottledTokenRefreshView`
listed `throttle_classes = [RefreshTokenRateThrottle]` with no
`throttle_scope`, which would have replaced a too-tight limit with **no limit
at all**, invisibly.

Not a hypothetical: the unit test that called `allow_request(request, None)`
was passing while proving nothing, because a `None` view has no scope.

**Fixed by** adding `throttle_scope = 'token_refresh'` to the view, and by
`TestRefreshThrottleWiring`, which asserts the wiring directly —
`test_refresh_view_declares_the_scope`, `test_the_endpoint_is_actually_rate_limited`,
`test_a_view_without_a_scope_is_unthrottled` (pins the DRF behaviour being
protected against), and `test_token_refresh_rate_exists_in_settings` (an
unregistered scope makes `get_rate()` raise `ImproperlyConfigured`, which
would be a 500 on every refresh rather than a 429).

A wiring mistake raises nothing, so it needs a test of its own.

### I5 — `ParseError` escaped the resolver's `except` clause

`_resolve_user_id` caught `(AttributeError, KeyError, TypeError, ValueError)`.
`rest_framework.exceptions.ParseError` is an `APIException` — **not** a
`ValueError` subclass. A malformed body would propagate out of
`get_cache_key` and turn the view's 400 into a **500**.

Caught by `test_unparseable_body_does_not_raise`.

**Fixed by** adding `APIException` to both resolvers' `except` tuples, with a
comment explaining why it is not a `ValueError`. An unreadable body is now
treated as "no token presented": the view returns its own 400 and nothing is
charged beyond the anonymous IP bucket.

### I6 — `isinstance(user_id, int)` would have silently reintroduced the CGNAT bug

The subject-type guard was written against an assumption that
`payload["user_id"]` is an integer. It is not:
`rest_framework_simplejwt/tokens.py:228` does `user_id = str(user_id)` before
writing it to the payload, so a real token's subject is the **string** `"1"`.

With an `int`-only guard, every genuine token would have fallen through to
the IP key — restoring the exact outage the work exists to fix, while the code
looked correct.

Caught by `test_key_reflects_the_verified_subject_not_the_address`.

**Fixed by** accepting `(str, int)`, normalising with `str()`, and rejecting
everything else. Two tests added:
`test_string_subject_is_accepted` asserts the real decoded type *and* the
cache key, and **fails loudly if simplejwt ever changes the type** with a
message pointing at the resolver; and
`test_non_scalar_subject_is_rejected` is parametrised over
`dict`/`list`/`None`/`bool`/`float`. `bool` is called out explicitly because it
is a subclass of `int` in Python, so a naive `isinstance(x, int)` would let
`True` through and collapse every such token into one bucket.

### I7 — Throttle tests asserted against the shared production cache

`SimpleRateThrottle.cache` is a class attribute bound to the Django default
cache — in this stack, the same Redis the four running Celery workers use.
Asserting a 120-request boundary meant 120 sequential round-trips, which
intermittently raised `django_redis.exceptions.ConnectionInterrupted:
Redis TimeoutError` and failed the test for reasons unrelated to the throttle.
It presented as "my change broke things" and was not.

**Fixed** by an autouse fixture pointing `SimpleRateThrottle.cache` at a
private `LocMemCache`. Rate boundaries are pure logic and do not need shared
infrastructure. `test_throttling.py` went from 98s (and intermittently
failing) to **6.7s and deterministic**. The one test that genuinely must
exercise the real stack —
`test_many_users_behind_one_ip_are_not_throttled`, which goes through the
view — was left on the real cache because it makes only 6 calls.

The 120-loop was additionally replaced by
`test_the_configured_rate_matches_the_token_lifetime`, which asserts the rate
is ≥10× the `ACCESS_TOKEN_LIFETIME` baseline rather than a literal, so
changing the token lifetime cannot silently break refresh.

### I8 — Suite failures were a misleading signal

Mid-way I ran `git stash` to capture a baseline while comparing runs. The
aborted run left Redis state behind, and the next full run showed
`test_counter_store` and `test_revenuecat` failures that **passed in
isolation** and were **absent from the baseline**.

Rather than assume, two consecutive full runs of *identical* code were
compared:

```
run3: 40 failures      run4: 38 failures
diff: test_counter_store::TestCompletionAccumulator::test_drain_combines_counters_and_completion
      test_revenuecat::TestRevenueCatWebhookView::test_webhook_accepts_valid_signature
      test_revenuecat::TestRevenueCatWebhookView::test_webhook_rejects_bad_signature_when_secret_set
      test_services_interactions::TestRecordSkip::test_writes_completion_sample_to_redis
```

A **different** subset each run, all in the Redis-state-sensitive metrics
cluster, all passing in isolation (4 passed in 6.9s). Pre-existing
order-dependence under a contended local stack, aggravated by residual cache
state. Flushing Redis before each run removed the first occurrence entirely.

The stable set is `comm -12 baseline ∩ (run3 ∪ run4)` = **37**, exactly the
baseline. **Zero regressions.**

Lesson recorded: a single full-suite run proves nothing about regressions on
this suite. Compare the *set*, across ≥2 runs, against a stashed baseline.

### I9 — There is no phone dev loop

Two blockers, neither mentioned in the new
`docs/EXPLAIN/storage/05-local-hls-worker-runbook.md`, which stops at the
Worker's own LAN reachability:

1. **URLs.** `docker-compose.local.yml` hardcodes
   `PUBLIC_HLS_ENDPOINT_URL=https://localhost:19443`. On a phone `localhost`
   is the phone. The device needs `https://<LAN-IP>:19443` (HLS) and
   `https://<LAN-IP>:18443` (API). Per-machine values, so they belong in
   `.env.local` with compose referencing `${PUBLIC_HLS_ENDPOINT_URL}` —
   compose does not expand `${...}` inside an env file, so the value must be a
   literal in `.env.local`.
2. **Certificate.** `docker/certs/localhost.crt` SANs are
   `localhost, minio, web, nginx, 127.0.0.1, 0.0.0.0`. A LAN IP is not
   covered; iOS ATS rejects and Android shows an interstitial.

**Owner decision:** certificate setup stays **manual and documented**, not
committed. `AGENTS.md` already flags the committed dev key as a hazard, so a
second committed cert was declined. The two sub-sections above are the
content for the runbook addition, to be written with Phase 1.

### I10 — DRF's `APIClient.get()` second positional argument is `data`, not headers

`client.get(url, NATIVE_HEADERS)` sent the dict as **query parameters**
(`?HTTP_X_ECHOFLOW_CLIENT=native`), so the view never saw a header and every
"native client receives the token" test failed while the header tests asserting
*absence* passed vacuously.

**Fixed** by unpacking as WSGI extra kwargs (`client.get(url, **NATIVE_HEADERS)`)
and a comment on the constant recording why. An `assert` in the file now
guards against a positional call reappearing.

Worth naming: three tests passed for the wrong reason. A "should not contain"
assertion is satisfied by a broken request just as happily as a correct one.

### I11 — Minor: `settings.SIMPLEJWT` not reachable from the test harness

`AGENTS.md` documents the dual `EchoFlow/` package layout, and the harness
does not always load the module defining `SIMPLEJWT`. Reading the lifetime
from `rest_framework_simplejwt.settings.api_settings` instead is both correct
and drift-proof — it is the object simplejwt itself uses.

### Salvage list

Keep as **patterns**, not code:

| Keep | Discard |
|---|---|
| The `apiFetch` single-flight `refreshPromise` mutex — a correct port of the web client including `ROTATE_REFRESH_TOKENS` handling. Keep the pattern; rewrite the base URL, add `AbortController` timeouts, `204` handling, structured errors, `skipAuth`, 429 backoff. | `expo-av` entirely (removed SDK 55) |
| `Audio.setAudioModeAsync({playsInSilentModeIOS, staysActiveInBackground, shouldDuckAndroid})` — well-reasoned, product-appropriate | The whole styling layer — 8 duplicated `StyleSheet.create` blocks, 130+ hardcoded hex, 16 alpha steps, zero tokens |
| `RecordingPresets.HIGH_QUALITY` → `.m4a`/AAC/44.1k/stereo/128kbps. Backend-compatible (`ALLOWED_EXT`), ffmpeg-friendly, matches the free-tier bitrate | `App.tsx` navigation — no stacks, no linking, no param typing, no error boundary, no auth gate |
| `com.echoflow.audio` bundle IDs, `scheme`, `UIBackgroundModes: audio` | `AuthContext` — `login()` unreachable, `isAuthenticated` derived not authoritative, no session-expiry signal, un-caught startup `refreshProfile` |
| `CommentModal`'s `KeyboardAvoidingView` + drag-indicator composition (the design; the implementation should be `@gorhom/bottom-sheet`) | `consentAccepted = useState(true)` — a DPDP §11 defect |
| | 7 unused deps, missing `assets/`, `getUnreadCount` never called, `toggleFollow` sending GET to a POST-only route |

---

## Verification commands

```bash
# Backend
docker compose -f docker-compose.local.yml --env-file .env.local exec -T \
  -e PYTHONPATH=/app web_local pytest backend/app/tests/test_throttling.py backend/app/tests/test_hls_token.py -q
# 73 passed

# Worker
cd workers/hls-token-worker && npx vitest run && npx tsc --noEmit
# 22 passed, tsc clean

# Full suite (regressions)
docker compose -f docker-compose.local.yml --env-file .env.local exec -T \
  -e PYTHONPATH=/app web_local pytest backend/app/tests/ -q \
  --ignore=backend/app/tests/test_scraper.py \
  --ignore=backend/app/tests/test_scraper_license_helpers.py \
  --ignore=backend/app/tests/test_scraper_state.py \
  --ignore=backend/app/tests/test_scraper_state_segments.py
# 37 stable failures == baseline. Compare the SET, across >=2 runs.
```

## Files changed on this branch

**New**
- `backend/app/throttling.py` — `RefreshTokenRateThrottle`, `RegisterUsernameRateThrottle`
- `backend/app/tests/test_throttling.py` — 26 tests
- `workers/hls-token-worker/src/token.test.ts` — 8 tests

**Modified**
- `backend/app/views/media.py` — native token transport, cookie Domain, `max_age` from setting, 409 on unprocessed
- `backend/app/urls.py` — `ThrottledTokenRefreshView` with `throttle_scope`
- `backend/app/views/auth.py` — dual throttle on registration
- `backend/EchoFlow/settings.py` — `token_refresh`, `register_username`, raised `register`
- `workers/hls-token-worker/src/{index,token}.ts` — header transport
- `.env.vps.example`, `docker-compose{,.vps,.laptop}.yml` — edge URL, domain reconciliation
- `AGENTS.md`, `docs/TODO.md`, 9 docs — domain reconciliation
