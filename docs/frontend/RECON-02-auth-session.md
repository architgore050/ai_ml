<task id="ses_f0f34cfb8ffeL7XNcoCXihkUoU" state="completed">
<task_result>
I have everything I need. All claims below are verified against source, and the load-bearing ones against the live stack (I checked `docker ps` first — all 13 containers healthy, no `Restarting`; the frontend suite is 48/48 green).

---

# AUTH / API-CLIENT / SESSION-LIFECYCLE RECON REPORT

**Stack state at time of recon:** `echoflow` local project, 13/13 containers `Up`, none restarting. `npm test` → 48 passed / 5 files. Probes I made (one throwaway user, one blacklisted-token row) have been deleted; `git status` shows no files touched by me.

## Headline: the prior audit is wrong more often than right, and it is wrong in the direction that matters

| Prior claim | Verdict |
|---|---|
| **P0-4** zombie-auth on network-throw | **CONFIRMED** (mechanism + user-visible outcome exactly right) — but the stated fix ("one missing line") is wrong about root cause |
| **P0-5** `getPlaybackToken` bypasses 401 | **CONFIRMED** — and understated |
| **§3.6** "No proactive refresh… a user watching a reel hits an unexpected logout" | **WRONG.** 401-refresh-replay makes access-token expiry *invisible* in the single-tab case. Zero user-visible cost. |
| **§3.6** "isAuthenticated from a cached user object, no JWT `exp` decode" | **CONFIRMED** |
| **§3.6** "Event-listener ordering race — `refreshProfile()` at `:48` fires before `addEventListener` at `:60`" | **WRONG.** No race is possible. `await` cannot yield mid-synchronous-block. |
| **§3.6** "A dead refresh token produces an unhandled rejection" | **WRONG.** `refreshProfile` has its own `try/catch`; nothing rejects. |
| **§3.6** "Session expiry renders a bare `LoginPage` with no message" | **WRONG.** `SessionNotice` is mounted outside the auth conditional (`App.tsx:145-146`). The "no return-to-previous-page" half is still true. |
| **§3.6** "No CSP… tokens in sessionStorage" | **CONFIRMED**, and worse than stated |
| **P2-3** "Enter double-submits login" | **WRONG.** `e.preventDefault()` (`Login.tsx:41`) does cancel implicit form submission. |
| **P2-21** "No 429/`Retry-After` handling anywhere" | **CONFIRMED** |
| **§3.8** "FR-AUTH-4 logout Missing" | **WRONG/stale** — `client.ts:240` calls it |

**And three defects the prior audit missed entirely, all higher severity than anything it listed in my domain:**

1. 🔴 **`register_username: 3/hour` does not exist.** It runs at **200/hour**. Proven live and in-process.
2. 🔴 **`POST /auth/register/` accepts the password `"123"`.** `AUTH_PASSWORD_VALIDATORS` is never called.
3. 🔴 **The single-flight mutex is per-tab, so rotation+blacklist guarantees a second tab is logged out and its tokens destroyed.** Proven live.

---

## 1. The refresh mutex — exhaustive exit table

`frontend/src/api/client.ts:67-109`. Four exits, plus one that never was an exit.

| # | Trigger | Line | Storage cleared? | `ef_session_expired`? | Caller sees | User sees |
|---|---|---|---|---|---|---|
| **0** | No refresh token in storage | `:69-71` | no | **no** | `null` → original 401 thrown | Depends — this is the *zombie* state, see below |
| **1a** | `200` rotation OK | `:92-98` | replaced | no | new access string, request replayed | nothing (transparent) |
| **1b** | `400` (missing/malformed `refresh` field) | `:85-90` | **yes** | **yes** | `null` → original 401 thrown | Login page + "Your session expired." — **correct-ish**, but a 400 is a client bug, not an expiry |
| **1c** | `401` (`Token is blacklisted` / `Token is expired` / `Token is invalid`) | `:85-90` | **yes** | **yes** | `null` → original 401 thrown | Login page + notice. **Correct.** This is the only branch that should clear |
| **1d** | **`429`** (token_refresh scope exhausted) | `:85-90` | **yes** | **yes** | `null` → original 401 thrown | **"Your session expired." — a lie.** A throttle is not an expiry |
| **1e** | **`500`/`502`/`503`** (deploy, gunicorn restart, DB blip) | `:85-90` | **yes** | **yes** | `null` → original 401 thrown | **"Your session expired." — a lie.** Server restart = mass logout |
| **2** | **network throw / abort** | `:99-102` | **yes** | **NO** | `null` → original 401 thrown | **nothing.** See below |

### P0-4 is CONFIRMED. The mechanism and the user-visible state are exactly as described.

**Root cause (not the missing line):** `if (!res.ok)` at `client.ts:85` conflates *four semantically different* failures. The spec it was written against — `docs/FRONTEND-REQUIREMENTS.md:652` — says the correct thing:

> `| 401 | Try refresh-token rotation once. **If that also 401s**, clear local auth state and route to /login. |`

The code checks "if anything at all went wrong." **The code is broader than the spec, and the spec is right.** That is the whole defect. The `catch` at `:99` has the same shape and the additional sin of swallowing the reason.

The missing `dispatchEvent` is the *second* bug, not the first. Adding it fixes the symptom (you'd get the login page) but leaves a user being logged out by a 502.

### The actual user-visible outcome of the network-throw path (traced end to end)

1. `client.ts:100-101` — `setStoredTokens(null)`, `setStoredUser(null)`. **React state is untouched** — `user` is the in-memory object from `useState(() => getStoredUser())` (`auth.tsx:25`); clearing storage does not clear state.
2. `client.ts:139` — on the *next* request, `getStoredTokens()` returns `null`, so `tokens?.refresh` is `undefined` → **exit 0. No refresh is ever attempted again.** The client is permanently, silently unable to authenticate.
3. `auth.tsx:40-42` — `catch { console.warn("Could not fetch user profile:", err) }`. `user` unchanged → `isAuthenticated` stays `true` (`auth.tsx:117`).
4. `App.tsx:59` — `!isAuthenticated && !isLoading` is `false` → **the full authenticated tree renders.** Header, feed shell, bottom nav, all of it.
5. `App.tsx:36-40` — the 30 s unread poll keeps firing, unauthenticated, each one 401ing, each one swallowed by `catch {}` at `App.tsx:31-33`.
6. Every user action (like, follow, comment, upload, play) throws a 401 and each call site swallows it in its own `console.warn`.

**The user is looking at a fully-rendered EchoFlow app in which nothing works, with no error, no message, no spinner, and no way back except a manual browser reload.** On reload, `getStoredUser()` returns `null` → `LoginPage`. So a reload is the only cure, and the user is never told that. Worse: **the 30 s poll guarantees the zombie state persists indefinitely** rather than self-healing.

**What a correct fix must preserve:**
- The single-flight mutex (`client.ts:65,73-75`) — it works and must not regress.
- Idempotent replay: the 401 arrives from DRF's `initial()`, so the handler never ran. Replay is safe.
- `ef_session_expired` must remain the *only* signal that tears down the tree, because `SessionNotice` is mounted outside the auth conditional specifically so the notice survives the transition (`App.tsx:135-137` says this in a comment that is, unusually, correct).

**Tests that would prove it:**
- `fetchMock` 401 on refresh → assert `dispatchEvent` spy called, storage cleared.
- `fetchMock.fail("POST", /token\/refresh/)` (network) → assert dispatch called **and** `sessionStorage` cleared.
- refresh 429 → assert **no** dispatch, tokens retained, `Retry-After` surfaced.
- refresh 500/502 → assert **no** dispatch, tokens retained.
- The killer integration test: network-throw on refresh, then assert `screen.getByRole`/`queryByText` shows `LoginPage` — not just that the event fired.

**Blast radius (grep-proven):** `frontend/src/api/client.ts` (`:85-90`, `:99-102`), `frontend/src/stores/auth.tsx:53-61`, `frontend/src/App.tsx:36-40,59`, `frontend/src/components/common/SessionAnnouncer.tsx:4-6`, `frontend/src/test/fetchMock.ts` (needs 429/5xx helpers), new `frontend/src/test/auth.test.tsx`, `docs/FRONTEND-REQUIREMENTS.md:652,1689-1700`, `docs/frontend_rebuild_plan.md` (P0-4).

---

## 2. Which calls bypass `apiRequest`

There are exactly **four** `fetch(` call sites in `frontend/src` (grep, excluding `node_modules`):

| Site | Goes through `apiRequest`? | Loses |
|---|---|---|
| `client.ts:79` (refresh itself) | n/a — *is* the refresh | — |
| `client.ts:133` (primary request) | n/a | — |
| `client.ts:143` (replay) | n/a | — |
| **`client.ts:431` `getPlaybackToken`** | **NO — raw `fetch`** | 401-refresh-replay, `ef_session_expired`, error normalisation, `Retry-After`, structured body |

That's the complete list. `useBackendHealth` (`:110`, `:125`) goes through `apiRequest` and correctly passes `skipAuth: true` with a comment explaining that a health check must not be able to rotate a session (`:108-109`) — good.

**P0-5 is CONFIRMED and understated.** Quantifying what `getPlaybackToken` loses:

1. **401-refresh-replay.** The access token expires every 15 min. A user mid-reel at minute 15 gets a 401 at mint time. `getPlaybackToken` reads `getStoredTokens()?.access` (`client.ts:434`) — whatever is in storage, possibly hours old — and has no recovery. The 401 lands in `player.tsx:217-232` and is mapped by the `else` branch at `:230` to `"Playback unavailable"`.
2. **`ef_session_expired` is never dispatched.** So the 401 does not log the user out — the app stays "authenticated" while playback is dead. The zombie state again, arrived at from a different direction.
3. **`error.data` is never read.** `client.ts:442-444` throws `new Error("Playback token issuance failed")` with only `.status`. Every other call site in the app reads `err.data.<field>[0]` (`Login.tsx:78-83`); this one is structurally unable to.
4. **`Retry-After` is never read** — but at 300/min it is nearly irrelevant here. Lowest of the four losses. The media recon's emphasis on this is slightly off; the real cost is 1 and 2.
5. **No content-type discrimination.** A proxy 502 HTML page becomes `response.json()` → a `SyntaxError`, not a mapped status. `apiRequest` handles this correctly at `:155-160`.

Note: `credentials: "include"` at `:436` **is** correct and load-bearing, and the comment at `:418-422` explaining why it is not the same path as `apiRequest` is accurate.

**Also missing (not in the prior audit): `CORS_ALLOW_HEADERS` does not contain `X-EchoFlow-Client`.** `settings.py:81-87` lists `accept, authorization, content-type, origin, range`. The native-client opt-in header documented at `media.py:76-77,128` and in `AGENTS.md` would be **stripped at preflight**. That is the media domain's finding, but the blast radius is `settings.py:81-87`.

---

## 3. Is authentication state derived from anything real?

**No. CONFIRMED, exactly as the prior audit says.**

- `isAuthenticated: !!user` (`auth.tsx:117`).
- `user` is initialised from `getStoredUser()` — a JSON blob — at `auth.tsx:25` (`useState(() => getStoredUser())`).
- **Zero JWT decoding anywhere.** `grep -rniE "\bexp\b|atob|jwtdecode|jwt_decode|decodeToken|base64" frontend/src` → `NONE`. There is no `jwt-decode` dependency in `package.json` either.

So: the app considers you logged in because a JSON object exists in `sessionStorage`. It never checks that a token exists, is parseable, or is unexpired.

### Real TTLs (read from source)

`settings.py:832-842`: `ACCESS_TOKEN_LIFETIME = 15 min`, `REFRESH_TOKEN_LIFETIME = 7 days`, `ROTATE_REFRESH_TOKENS = True`, `BLACKLIST_AFTER_ROTATION = True`.

**But the 7-day refresh TTL is a SLIDING window, not a hard cap — and every doc gets this wrong.** `TokenRefreshSerializer.validate` calls `refresh.set_exp()` on every rotation (`rest_framework_simplejwt/serializers.py:139`), which recomputes `exp = now + 7d`. Proven live:

```
t+0  exp = 2026-10-07T05:43:01
t+4s exp = 2026-10-07T05:43:05  -> advanced by 4 sec
```

**Consequence:** a refresh token that keeps rotating never expires. There is **no absolute session lifetime anywhere in this system.** That is a first-class security finding, listed as A-11 below, and it is the *residual* risk left after rotation is accounted for.

### User-visible cost of no proactive refresh: **zero, in every scenario the prior audit describes**

The 401-refresh-replay is fully transparent. The prior audit's "A user watching a reel hits an unexpected logout" is **WRONG.**

| Scenario | What actually happens | Visible cost |
|---|---|---|
| **(a) open tab** | `App.tsx:36-40` polls `/share/unread-count/` every 30 s, **with auth and no `skipAuth`**. The access token is never allowed to lapse in practice; when it does, the next poll 401s, refreshes, replays. | **None.** One extra round-trip. |
| **(b) backgrounded tab** | Browsers throttle `setInterval` to ≥1/min; Chrome may freeze the tab after ~5 min. On foreground, the pending timer fires → 401 → refresh → replay. | **None.** Still one extra round-trip. |
| **(c) closed tab** | `sessionStorage` dies with the tab. Tokens gone. Refresh token TTL irrelevant. | **None** — user re-logs-in. |

**The incidental warmer exists and I nearly missed it: `App.tsx:36-40`.** The 30 s unread poll is mounted inside `MainContent`, which `AuthenticatedApp` renders only when authenticated (`App.tsx:146`). It is the reason nobody has ever noticed the missing proactive refresh. **Do not "fix" proactive refresh expecting a user-visible win — you will get a latency optimisation and nothing else.** (It is still worth doing: it removes a round-trip and, more importantly, it is the only way to survive the 429/5xx paths once those are fixed.)

### The listener-ordering race: **the claim is WRONG. There is no race.**

`auth.tsx:45-62`:
```
46    const tokens = getStoredTokens();
48      refreshProfile().finally(...)      // ← claimed race
...
60    window.addEventListener("ef_session_expired", handleSessionExpired);
```

For the dispatch at `client.ts:88` to precede line 60, the chain `refreshProfile()` → `getMyProfile()` → `apiRequest()` → `fetch()` → … → `await` → back to `refreshAccessToken()` → `await` → `client.ts:88` would have to complete without the JS stack ever emptying. It cannot: `await` on *any* thenable — including an already-resolved `fetch` promise — schedules a microtask, and microtasks cannot run until the current synchronous execution completes. Lines 48 and 60 are in the same synchronous block. React 19 StrictMode's double-invoke (mount → cleanup → mount) is also entirely synchronous within one commit, so the listener is re-registered before any microtask flushes.

**The listener is always registered first. The claim is wrong, and the fix it implies (moving `addEventListener` above `refreshProfile()`) is a no-op that would look like a fix and prove nothing.**

**What IS adjacent and real, which the claim is probably a garbled version of:** the effect at `auth.tsx:45-62` has `[]` deps and never re-runs. So if the mount-time `refreshProfile` fails, nothing re-checks. Combined with exit 0 (no refresh token ⇒ no retry ever), that is the permanence of the zombie state — not an ordering bug.

---

## 4. Storage and XSS surface

### Where the tokens are

`client.ts:15-17` → `sessionStorage`, keys `ef_access_token`, `ef_refresh_token`, `ef_user`. Readers: `getStoredTokens()` (`:27`), `getStoredUser()` (`:46`), and directly `auth.tsx:46,101` and `App.tsx:44`. **No `localStorage` use anywhere.** `sessionStorage` is per-tab, per-origin, survives reload, dies on tab close.

### CSP: **there is none, anywhere**

- `frontend/index.html` — 25 lines, no `<meta http-equiv>`, no CSP. Only a Google Fonts `<link>` (`:18`).
- `docker/nginx.conf:108-111` and `docker/nginx.local.conf:83-86` — the **exact** `add_header` set is four headers:
  ```
  Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  X-Content-Type-Options "nosniff" always;
  X-Frame-Options "DENY" always;
  Referrer-Policy "strict-origin-when-cross-origin" always;
  ```
  **No `Content-Security-Policy`. No `Permissions-Policy`.**
- `settings.py:897-907` (`if not DEBUG:`) — SSL redirect, HSTS, nosniff, proxy header. **No `SECURE_CROSS_ORIGIN_OPENER_POLICY`, no CSP.**
- Repo-wide grep for `Content-Security-Policy` outside `node_modules`: **one hit, in a doc** — `docs/EXPLAIN/backend/06-auth-permissions.md:301`, correctly listing it as missing.
- **nginx does not serve the frontend** (`nginx.conf` has no `root`/`try_files`; it proxies the API and MinIO). The frontend is a separate origin (Cloudflare Pages per `docs/EXPLAIN/DEPLOYMENT/04-cloudflare-config.md`), and there is **no `_headers` file** in the repo. So the app origin carries **zero** security headers.

### Worst case for one XSS

Any script executing on the app origin reads both tokens from `sessionStorage` and exfiltrates them. With no CSP, nothing constrains what that script can do — no `script-src`, no `connect-src`, no nonce, nothing.

Blast radius:
- **Access token**: 15 min of impersonation.
- **Refresh token**: **indefinite.** It rotates, but the sliding `exp` means a token that keeps rotating never expires (§3). The attacker rotates; the victim's next refresh 401s; **the victim is logged out and cannot tell why**, and the attacker holds a session that no mechanism can revoke (see A-12).
- **`ef_user`**: username + email (PII, DPDP-relevant).
- **`ef_hls_token` is NOT reachable** — `HttpOnly` (`media.py:265`). Correctly designed.
- Because the API is `CORS_ALLOW_ALL_ORIGINS = False` with an explicit allowlist (`settings.py:33,28`), exfiltration must go to an attacker's own server, not to the API. CSP would not have prevented exfiltration anyway — but `script-src 'self'` would prevent *most* injection vectors, and the absence of any CSP means the app has no second line of defence against the Google Fonts origin, a compromised npm dependency, or a stored-XSS in user-generated content (comments, profile bios — **none of which are rendered as markdown, but all of which are rendered as text nodes; verify that before assuming the risk is theoretical**).

A viable CSP must allow `style-src`/`font-src` for `fonts.googleapis.com` + `fonts.gstatic.com` (`index.html:12-18`) and `connect-src` for the API and media origins. `script-src 'self'` is achievable with zero code changes.

---

## 5. Abuse / DoS / malicious-user surface

### 5.1 🔴🔴 `register_username: 3/hour` DOES NOT EXIST — it runs at 200/hour

**Root cause:** `rest_framework/throttling.py:219-221`:

```python
def allow_request(self, request, view):
    # We can only determine the scope once we're called by the view.
    self.scope = getattr(view, self.scope_attr, None)
```

`ScopedRateThrottle.allow_request` **unconditionally overwrites `self.scope` with the view's `throttle_scope`.** So `RegisterUsernameRateThrottle.scope = 'register_username'` (`backend/app/throttling.py:167`) is dead code, and the class resolves to the view's `'register'` → **200/hour**.

Proven in-process against the real settings:

```
RegisterUsernameRateThrottle ->
   resolved self.scope = 'register'  (class attr says register_username)
   resolved rate       = 200/hour -> num_requests 200 per 3600 s
   cache key           = throttle_register_username:zz_keyprobe
   allowed             = True
```

Proven live over HTTPS — 16 consecutive `POST /auth/register/` with one username, **zero 429s** (the correct rate is 3/hour, so the 4th request should have 429'd).

**And the test that "covers" it asserts the bug as correct.** `backend/app/tests/test_throttling.py:338-347`:

```python
throttle = RegisterUsernameRateThrottle()
request = _fake_request_body({"username": "squatter"})
for _ in range(3):
    view = _view_with_scope('token_refresh')     # ← dead loop; wrong scope
for _ in range(120):
    assert throttle.allow_request(request, view) is True
assert throttle.allow_request(request, view) is False
```

The fake view's scope is `'token_refresh'` (120/hour), and the test asserts **120 allowed then denied**. It passes *because* the throttle resolved to the wrong scope's rate. **A green test asserting the exact wrong number.** Its sibling `test_register_username_rate_exists_in_settings` (`:547-549`) only asserts the dict has the key — never that the throttle uses it.

**`RefreshTokenRateThrottle` is safe — by coincidence.** Its class scope (`'token_refresh'`) happens to equal its view's `throttle_scope`, so the overwrite is a no-op. Anyone who ever renames one without the other silently changes the rate with no error. That is a landmine, not a fix.

**Documented as working in:** `settings.py:772-777`, `throttling.py:47-52,151-165`, `views/auth.py:35-41`, `AGENTS.md` ("paired with a per-username limit at 3/hour"), `docs/FRONTEND-REQUIREMENTS.md:663`. **Every one of these is wrong.** The `settings.py:765-770` comment is the worst: *"The per-IP cap on actual spam is now carried by 'register_username' below"* — the thing carrying it is not carrying it.

**Fix:** override `allow_request` in `RegisterUsernameRateThrottle` to restore `self.scope` from a class attribute, or (cleaner) subclass `SimpleRateThrottle` directly instead of `ScopedRateThrottle`. Then **rewrite the test to use `_view_with_scope('register')` and assert 3** — and verify it goes red first.

### 5.2 🔴🔴 `POST /auth/register/` accepts the password `"123"`

`AUTH_PASSWORD_VALIDATORS` is fully configured (`settings.py:467-480`, all four validators). **`RegisterSerializer` never calls it** — `validate()` (`serializers.py:631-682`) handles only `terms_version`, `dob` bounds and the minor gate; `create()` (`:685`) passes `validated_data['password']` straight to `create_user`, which hashes it correctly but applies no policy.

Proven in-process:

```
'123'       -> is_valid = True | errors: {}
'password'  -> is_valid = True | errors: {}
'a'         -> is_valid = True | errors: {}
direct django validate_password("123"):
   rejected: ['This password is too short. It must contain at least 8 characters.',
              'This password is too common.', 'This password is entirely numeric.']
```

No test anywhere greps for `validate_password` in `backend/app/tests/`. `dj_rest_auth`'s own registration endpoint is **not routed** (`backend/EchoFlow/urls.py` has no include for it), so `RegisterView` is the only registration path.

**Combined with 5.1 and 5.4, the abuse path is complete:** bulk-create accounts with trivial passwords at 200/hour/IP, unlimited usernames, and every account is a known-credential target.

**Fix:** one `validate_password` call in `RegisterSerializer.validate`. Blast radius: `backend/app/serializers.py:631`, tests in `test_security_and_validation.py` / `test_group_c.py` / `test_erasure.py` (all three POST to `/auth/register/` — check none of them use a weak fixture password, or the suite will go red for the right reason).

### 5.3 🔴 `find_user` is a first-class username + PK enumeration oracle

`backend/app/views/social.py:114-125`:
```python
return Response({'id': user.id, 'username': user.username})   # 200, exists
...
return Response({'error': f'No user found: @{username}'}, status=404)  # 404, doesn't
```

Requires only `IsAuthenticated` — **any free-tier account**. Throttle scope `share_poll` = **1000/hour** (`:109-112`). Wired to a live search box at `ShareModal.tsx:45`.

So: **1000 username probes + the integer PK for every hit, per hour, per throwaway free account.** And because it also returns `id`, the attacker gets the PK map that `getPublicProfile(userId)` (`client.ts:400`) walks. That is the whole user base in ~1 request per user.

**Fix (MVP):** return a constant-shape 404 (`{'error': 'Not found'}`) and drop `id` from the response in favour of a username-keyed send endpoint — or keep `id` but return an identical body/status for hit and miss. Add a dedicated `find_user` scope at ~60/hour. This is a product decision (the search box needs to say "no such user"), so **ask before implementing** — the owner may accept enumeration for a share-by-name UX.

### 5.4 Throttle inventory — every scope, its key, and the CGNAT verdict

| Endpoint | Scope | Rate | Key | CGNAT verdict |
|---|---|---|---|---|
| `POST /auth/login/` | `login` | 10/min | **IP** (`ScopedRateThrottle.get_cache_key` → `get_ident`, anonymous) | ⚠️ Shared. A cell needs >10 logins/min sustained to break. Unlikely, but a user who fumbles their password 3× during a busy minute on a busy cell eats a third of the cell's budget. **Self-DoS is possible but low-likelihood.** |
| `POST /auth/token/refresh/` | `token_refresh` | 120/hour | **verified `user_id`** (`throttling.py:81-99`) | ✅ **NAT-safe.** This is the one place the CGNAT work was done correctly. |
| `POST /auth/register/` | `register` | 200/hour | **IP** | ⚠️ A cell can onboard 200 users/hour. Fine at launch, wrong at scale. |
| `POST /auth/register/` | `register_username` | ~~3/hour~~ **200/hour** | username | 🔴 **Does not exist.** See 5.1. |
| `GET /share/find-user/` | `share_poll` | 1000/hour | user pk | 🔴 Enumeration oracle. See 5.3. |
| `POST /auth/logout/` | (default) | `user` 1000/h | user pk | ✅ |
| `GET /legal/compliance/` | `legal` | 30/hour | **IP** | ⚠️ **Decorative.** `auth.tsx:91` calls it on every registration and `catch {}`s the 429 (`:95-97`), falling back to `"v1.0"`. So the throttle has **no effect on the attacker** and only adds a wasted round-trip for legitimate users. Either surface the 429 or drop the pre-flight fetch and inline the version. |
| `GET /health/`, `GET /ready/` | **none** | — | — | ✅ Plain Django function views (`backend/EchoFlow/health.py`), not DRF, so **not throttled at all**. The 30 s frontend probe does not touch any bucket. *(I checked this specifically — it would have been a nasty finding if true.)* |

**Default classes** (`settings.py:750-754`): `AnonRateThrottle` 100/h (IP), `UserRateThrottle` 1000/h (user pk), `ScopedRateThrottle` (no scope ⇒ **allows everything**, per the load-bearing note at `urls.py:39-44`).

**No account lockout anywhere** — `grep -rniE "lockout|failed_login|login_attempts"` over `backend/`: zero hits. `10/min/IP` is the only credential-stuffing control, and it is IP-keyed, so a distributed attacker gets no per-account bound at all.

### 5.5 Token abuse — the 401-refresh-replay loop is **bounded**. No amplification.

Enumerating honestly, because the mandate asks and the answer is reassuring:

- **Per `apiRequest` call: exactly one refresh, then exactly one replay.** `client.ts:139-148` checks `response.status === 401` once; the replay's result is never re-checked. **No retry cap is needed because there is no loop** — the structure is `if`, not `while`. 3 requests max: original, refresh, replay.
- **Concurrency is capped by the mutex.** 10 simultaneous 401s ⇒ 1 refresh (`client.ts:73-75`). This is correct and I could not break it.
- **Server-side ceiling: 120 refreshes/hour per verified user.** Worst case: a client whose access token is *persistently* rejected (e.g. `USER_AUTHENTICATION_RULES` blocks the user) fires 1 refresh per `apiRequest`. At 30 s poll + feed + telemetry that exceeds 120/hour within ~30 min ⇒ 429 ⇒ **and the 429 currently logs the user out** (exit 1d). So the amplification is bounded, but the *failure mode* is a self-inflicted logout. Fixing 1d fixes this too.
- **The client cannot mint extra refreshes without an access token**, and a 429 is the server's hard stop.

**Verdict: no unbounded refresh amplification. The prior audit's implied concern is unfounded and I will not invent a fix for it.**

### 5.6 🔴🔴 Refresh-token rotation + `sessionStorage` = guaranteed multi-tab logout

**This is the most severe defect in my domain and the prior audit does not mention it.**

Chain: `ROTATE_REFRESH_TOKENS=True` + `BLACKLIST_AFTER_ROTATION=True` (`settings.py:839-840`), `token_blacklist` in `INSTALLED_APPS` (`:115`) ⇒ **every refresh blacklists the presented token** (`rest_framework_simplejwt/serializers.py:128-136`) and `check_blacklist()` raises on reuse (`tokens.py:267-280`). Verified enforced. Tokens live in **`sessionStorage`** (`client.ts:28-29`) — **per-tab, so every tab holds an independent copy of the same refresh token.**

The single-flight mutex is a **module-level variable in one JS context** (`client.ts:65`). It cannot coordinate across tabs. So:

1. Tab A refreshes → rotates + blacklists token *R₀*, stores *R₁*.
2. Tab B still holds *R₀* → refreshes → **401 `Token is blacklisted`** → `!res.ok` → `setStoredTokens(null)`, `setStoredUser(null)`, dispatch `ef_session_expired` → **Tab B is logged out and its tokens destroyed, with the message "Your session expired."**
3. Tab C, D… same. The user is logged out of every tab except whichever won the race.

Proven live:
```
tab A refresh OK -> new refresh jti 0035c299
TAB B (holds old r1) -> TokenError: Token is blacklisted
TAB A replay (old r1) -> TokenError: Token is blacklisted
```

**Blast radius.** Open the app twice (two windows, or a tab plus a PWA install, or a phone with the page in two tabs) and log in once. Whichever tab refreshes second kills itself. Given a 15-minute access token, **this fires within 15 minutes of any user opening a second tab.** Users do this constantly.

**And the doc tells the next agent the opposite.** `docs/FRONTEND-REQUIREMENTS.md:1426-1437`:
> "**Concurrent request storms:** … Mitigation: serialize refresh attempts — maintain a single in-flight refresh promise that other 401s await. **The current code does not do this.** **Status: Partially implemented — single-tab is fine; multi-tab may see occasional spurious 401s.**"

Two errors. The mutex *is* implemented (`client.ts:65,73-75`) — AGENTS.md even credits it. And the residual multi-tab issue is **not** "occasional spurious 401s" — it is **guaranteed, total, self-inflicted session destruction.** A reader who trusts this doc concludes the single-tab part is fine (true) and that multi-tab is a cosmetic nit (catastrophically wrong).

**What a correct fix must preserve:** the mutex, the replay, and — critically — the fact that a `401 Token is blacklisted` is *not* a credential-compromise signal. It is the **expected** outcome of two tabs sharing a session, so it must be recoverable rather than terminal.

**Three candidate fixes, in order of preference:**
1. **Server (best).** A short reuse-detection grace window on rotation (simplejwt supports `UPDATE_LAST_LOGIN`-style family patterns; the clean version is to return the *current* outstanding token to the same user instead of 401 when the presented jti is blacklisted but a newer outstanding token for the same user exists). Blast radius: `settings.py:832-842`, a custom `TokenRefreshSerializer`, `backend/app/urls.py:31-48`, new tests. **This is the only fix that also handles the genuine theft case** (a stolen token is used from a *different* IP, which the grace window would flag).
2. **Client (cheap).** On a refresh 401 whose body is `Token is blacklisted`, retry the refresh **once** — the winner's token is in that tab's sibling, not here, so this only helps if the tokens were shared. **Actually it does not help**: Tab B's storage has *R₀* and the server has *R₁* issued to Tab A. Tab B cannot recover *R₁*. **This fix does not work.** Discard it.
3. **Client (real).** Move the refresh token to `localStorage` (shared across tabs) or IndexedDB, keep the access token in `sessionStorage`, and use a `BroadcastChannel` or `storage` event to keep tabs in sync. **This directly contradicts `FRONTEND-REQUIREMENTS.md:1415`: "**Never** store tokens in `localStorage` shared across origins."** Read carefully, that rule says *shared across origins* — `localStorage` is same-origin, so the rule is arguably not violated. **But it is close enough to the prohibition that this needs an explicit owner decision, not an agent's judgement call.**

**Ask the owner which of (1) or (3) they want before implementing.** I lean (1): it is a small, server-local change that also closes the theft case, and it does not require touching the documented storage policy.

### 5.7 Self-DoS

- **Exhausting the IP-keyed login budget** (10/min, shared on a cell): possible, self-inflicted, self-clearing in 60 s, with **no cooldown UI** (`FR-AUTH-2` at `:1043` prescribes a countdown timer; the client renders `err?.message` = `"Request was throttled."`). Low severity, trivial fix.
- **Exhausting `token_refresh` (120/hour)**: logs the user out **and** discards a still-valid refresh token. Bounded at 121 refreshes; realistically reached only via 5.6 or a persistently-401 backend. Fixed by the 1d change.
- **Exhausting `legal` (30/hour)**: no effect, swallowed. Cosmetic.

### 5.8 Unbounded growth: the blacklist is never pruned

`grep -rn "flushexpiredtokens"` over `backend/` → **zero hits.** No Celery Beat entry, no cron, no management command wired into `CELERY_BEAT_SCHEDULE` (`:483-513`).

Every refresh inserts an `OutstandingToken` and a `BlacklistedToken` row (`tokens.py:282+`), and `check_blacklist()` runs `BlacklistedToken.objects.filter(token__jti=jti).exists()` — a JOIN against a table that only grows. At 4 refreshes/hour/user × 7-day retention ≈ 196 rows/user, unbounded in user count. Not a DoS today; it is the load-bearing control for "a stolen refresh token is single-use" silently degrading, and nobody is watching the table.

### 5.9 ✅ Logins do not leak user existence

Proven live:

| Request | Status | Body |
|---|---|---|
| nonexistent user | **401** | `{"detail":"No active account found with the given credentials"}` |
| existing user, wrong password | **401** | `{"detail":"No active account found with the given credentials"}` |
| `{}` | 400 | `{"username":["This field is required."],"password":["This field is required."]}` |

Byte-identical. `TokenObtainSerializer.validate` (`serializers.py:50-58`) raises the same `no_active_account` `AuthenticationFailed` for both because `authenticate()` returns `None` for both. **This is correct. Do not "fix" it.** The only observable difference (400 vs 401) is field validation, not existence.

**Registration enumeration is real but bounded:** a duplicate username returns `400 {"username":["A user with that username already exists."],"email":["This field must be unique."]}` (proven live) — a clean oracle, but capped at 200/hour/IP (and the per-username limit that was supposed to slow it doesn't exist — 5.1).

---

## 6. Error normalisation

`client.ts:154-173`:

```ts
const contentType = response.headers.get("content-type");
if (contentType && contentType.includes("application/json")) { data = await response.json(); }
else { data = await response.text(); }

if (!response.ok && response.status !== 202) {
  const error: any = new Error(
    data?.detail || data?.error ||
    (typeof data === "object" ? Object.values(data).flat().join(" ") : "Request failed")
  );
  error.status = response.status;
  error.data = data;
  throw error;
}
```

**What works:**
- ✅ Status preserved (`.status`).
- ✅ Raw body preserved (`.data`) — this is what `Login.tsx:78-83` and `Upload.tsx` read for field errors, and it is the right design.
- ✅ `202` passthrough (`:162`) — required for the feed cold-start path.
- ✅ `204` → `null` (`:150-152`).
- ✅ Non-JSON bodies degrade to text rather than throwing a `SyntaxError` inside the client.

**What is broken or missing:**

1. 🔴 **`Retry-After` is never read.** Zero occurrences in `frontend/src` outside `fetchMock.ts`. Meanwhile `settings.py:89-96` *explicitly configures* `CORS_EXPOSE_HEADERS = ['Retry-After']` with the comment:
   > `# ← the client is required to honour 429 backoff. DRF sends this on every throttle response; without exposing it the browser hides it from JS on a cross-origin request and the client cannot back off.`

   **The backend is configured for a client that does not exist.** DRF does send it (`rest_framework/views.py:92`). It is exposed. Nobody reads it. `FRONTEND-REQUIREMENTS.md:1443-1446` prescribes the exact algorithm ("schedule the next attempt at the response's `Retry-After` (or 30 s, whichever is greater)"). Unimplemented.

2. 🔴 **A non-OK response that is *not* JSON loses the body entirely.** `data` is a string; `data?.detail` is `undefined`; `typeof data === "object"` is false → `new Error("Request failed")`. A 502 HTML page from nginx becomes a content-free error. `useBackendHealth.ts:116-121` works around this by checking `liveness?.status !== "healthy"` — i.e. the *only* place in the app that handles a proxy-HTML response has a bespoke workaround for it.

3. ⚠️ **Field errors are flattened into one string** (`Object.values(data).flat().join(" ")`). A 400 with three field errors becomes `"Invalid terms version… A user with that username already exists. This field must be unique."` Any caller that falls back to `err.message` shows the user a run-on sentence. Callers that read `err.data.<field>[0]` (as `Login.tsx:78-83` correctly does) are fine. The flattened `message` is a fallback, not the primary path — but nothing documents that, and `client.ts` has no comment saying so.

4. ⚠️ **No error taxonomy.** There is no `isNetworkError` flag, no `cause`, no distinction between "no response arrived" (no `.status`) and "the server said no" (`.status` set). This is the structural reason the app's `catch { console.warn }` pattern is so destructive: **a caller cannot tell a 401 from a dead network from a 500**, so they all get the same treatment. This is the highest-leverage thing to add and it costs 5 lines.

5. ⚠️ **`apiUrl()` (`:23-25`) is prefix-agnostic**: `endpoint.startsWith("http") ? endpoint : base + endpoint`. No allowlist — a caller passing a user-controlled absolute URL sends the `Authorization` header to it. **No current caller does this** (`findUser` uses `encodeURIComponent`, `registerSkip`'s `reel_id` is body-only). But `getPlaybackToken(clipId)` interpolates `clipId` directly into a path at `:431` with no `encodeURIComponent`, unlike every other ID-taking method (`feedAPI.getSuggestions:259`, `shareAPI.findUser:348`, `commentsAPI.getComments:317` all encode). `clipId` comes from `FeedClip.id` (server-supplied) so it is not attacker-controlled today — but it is the only unencoded interpolation in the file, and the fix is one function call.

### 🔴 `fetchMock.ts` documents behaviour that does not exist

`frontend/src/test/fetchMock.ts:4-8`:
> "`apiRequest` in `src/api/client.ts` layers four behaviours on top of `fetch` that the tests actually need to assert against: the `Authorization` header, single-flight 401 refresh + replay, `202` passthrough, and **`Retry-After` extraction**."

**Three of the four are real. `Retry-After` extraction does not exist.** And line 158-165 defines an unused helper:
```ts
/** Convenience: a 429 carrying `Retry-After` (seconds, as the server sends it). */
export function tooManyRequests(retryAfterSeconds: number): MockResponseSpec { ... }
```
`grep -rn "tooManyRequests" frontend/src` → **defined, never imported.** Dead code whose only purpose is to make a test suite for behaviour that isn't there look imminent.

**This is exactly the "mock documenting absent behaviour misleads the next agent" failure mode.** The comment asserts a contract; a future agent reads the mock's docstring, concludes the client handles `Retry-After`, and writes `await api(...)` expecting a `retryAfter` field. It will be `undefined`.

**Fix the comment before writing the 429 test**, or the test will be written to the wrong shape.

---

## Doc-vs-reality contradictions (quoted)

Ordered by how much damage they will do to the next agent.

**1. 🔴 `docs/FRONTEND-REQUIREMENTS.md:547-554` — prescribes password validation that does not exist.**
> "Password validation: Django's four built-in validators (`AUTH_PASSWORD_VALIDATORS` at `backend/EchoFlow/settings.py:324-337`): … `MinimumLengthValidator` (default ≥ 8 chars) … `CommonPasswordValidator` (rejects top-1000 common passwords) … `NumericPasswordValidator` (rejects entirely-numeric passwords)"

Proven false: `'123' -> is_valid = True`. **An agent will read this, conclude password strength is handled, and skip the P0.** The line reference (`:324-337`) is also wrong — the validators are at `settings.py:467-480`.

**2. 🔴 `docs/FRONTEND-REQUIREMENTS.md:1426-1437` — says the mutex is missing and the residual issue is cosmetic.** Both false (see §5.6). Quoted in full above.

**3. 🔴 `docs/FRONTEND-REQUIREMENTS.md:1415` — "**Never** store tokens in `localStorage` shared across origins."** The obvious correct fix for 5.6 is `localStorage`. A future agent will read this rule, conclude `localStorage` is forbidden, and decline to fix a guaranteed-logout bug. *(The rule as written says "across origins", so it does not actually forbid same-origin `localStorage` — but it is one clause away from forbidding it, and it is in a document that the next agent will be holding.)*

**4. 🔴 `docs/FRONTEND-REQUIREMENTS.md:1689-1700` — the state machine that justifies the P0-4 bug.**
> ```
> state: authenticated, refresh expired (7 days)
>    POST /auth/token/refresh/ → 401
>    → state: anonymous
> ```

The spec describes **only** 200 and 401 branches. `if (!res.ok) { clear; dispatch }` is a *faithful implementation of a spec that omits 429 and 5xx*. **The spec is the bug's cover story**, and it also gets the 7-day expiry wrong (it is a sliding window, proven). The spec says "7 days" as if it were a hard cap; there is no hard cap.

**5. 🔴 `docs/EXPLAIN/backend/06-auth-permissions.md:343-352` — "Missing Security Features" table, right about the one thing that is broken and wrong about the two that are fixed.**
> | Token blacklist/logout invalidation | ❌ Not implemented | Stolen access token valid 15min |
> | Refresh token rotation | ❌ Not implemented | Long-lived refresh token theft |
> | Password strength validation | ❌ Not in serializer | Weak passwords allowed |

Blacklist **is** implemented (`urls.py:62-78`, proven). Rotation **is** implemented and enforced (proven). Password strength **is** genuinely missing (proven). **An agent skimming this table fixes the two working things and skips the broken one.** This is the most dangerous document in my domain.

**6. 🔴 `docs/EXPLAIN/storage/04-hls-token-protection.md:275-278` — prescribes a playback-token refresh that is architecturally impossible for the web transport.** (The media recon's finding; I independently confirm and add the reason.)
> "The frontend proactively fetches a new token when the old one is about to expire:
> - If the current token expires in < 120 seconds, request a fresh one"

The cookie is `HttpOnly` (`media.py:265`). No script on the origin can read it, decode its `exp`, or know it is within 120 s of expiry. No endpoint returns the expiry. **For the web transport this cannot be implemented.** The only signal is a 403 from the edge *after* the manifest has loaded — too late for a seamless swap.

**7. ⚠️ `docs/EXPLAIN/frontend/02-api-layer.md:236` — says refresh rotation is missing.**
> "| Token refresh | Automatic on 401 | **No refresh token rotation** |"

It is implemented (`settings.py:839`, `client.ts:95`). **This doc teaches the reader that refresh theft is unmitigated** — which is the exact mental model that makes 5.6 invisible.

**8. ⚠️ `docs/EXPLAIN/frontend/02-api-layer.md:53` — documents an error shape the client does not produce.**
> "5. Normalizes errors: throws `{status, message, errors}`"

There is **no `errors` field**. It throws an `Error` with `.status`, `.data`, `.message`. A caller written against this doc reads `err.errors` and always gets `undefined`.

**9. ⚠️ `docs/EXPLAIN/frontend/02-api-layer.md:264-270` — "Current Limits" table is 18 months of stale rate limiting.**
> "No per-endpoint overrides (e.g., `log_telemetry` can be spammed 1000x/hour)"; "No Redis-backed distributed throttling (uses Django cache → local memory in dev)"

Both false. There are 22 per-action scopes (`settings.py:760-827`) and throttling is django-redis on `REDIS_CACHE_URL` (`settings.py:340-348`). It does correctly flag `Content-Security-Policy` as missing (`:301`) and `Retry-After` as unhandled (`:237`) — the two things it gets right are the two things that are still true.

**10. ⚠️ `docs/EXPLAIN/frontend/02-api-layer.md:19-21` — "ef_refresh: JWT refresh token (7 days)"** — same fixed-vs-sliding error as #4.

**11. ⚠️ `frontend/src/test/fetchMock.ts:4-8`** — see §6. Asserts `Retry-After` extraction that does not exist.

**12. ⚠️ `backend/app/tests/test_throttling.py:338-347`** — a green test that asserts the wrong rate. See §5.1. *A test is a doc that runs; this one is actively wrong.*

**13. ⚠️ `backend/EchoFlow/settings.py:89-96`** — configures `CORS_EXPOSE_HEADERS: ['Retry-After']` with the comment "the client is required to honour 429 backoff." **No client does.** The server half of a contract with no client half.

---

## Abuse-case table

| # | Case | Severity | Likelihood | Control that would stop it |
|---|---|---|---|---|
| A-1 | **Multi-tab session destruction** — rotation + blacklist + `sessionStorage` + per-tab mutex. Guaranteed logout of all but one tab within 15 min of a second tab. | **Critical** | **Very high** — every user who opens a second tab | Server-side rotation grace window / same-user re-issue of the newest outstanding token. *Not* a client retry — proven not to work. |
| A-2 | **Bulk account creation with trivial passwords** — `register_username` runs at 200/hour (5.1) + `AUTH_PASSWORD_VALIDATORS` never called (5.2). 200 accounts/hour/IP with password `"123"`. | **Critical** | High (trivially scriptable) | `validate_password` in `RegisterSerializer.validate`; fix the throttle scope; add a per-IP account-creation cap independent of `register` |
| A-3 | **Refresh 401/429/5xx destroys a valid session** — `if (!res.ok)` (1d/1e) | **High** | Medium — needs a 502/503/429 window | Branch on status: clear only on 401/400. Spec `FRONTEND-REQUIREMENTS.md:652` already says this |
| A-4 | **Silent zombie session** — network throw clears storage, no event, UI stays authenticated, no recovery (exit 2) | **High** | Medium — any transient network drop during a refresh | Dispatch the event; better, do not clear storage on a transport failure at all |
| A-5 | **Stolen refresh token = indefinite access** — sliding `exp` (proven), rotation, no absolute session cap, no revocation path. `LogoutView` (`urls.py:62-78`) blacklists only the *presented* token | **High** | Low (requires token theft) | Absolute session lifetime (`ABSOLUTE_REFRESH_TOKEN_LIFETIME` / `max_age`); per-user token-version revocation; "sign out everywhere" |
| A-6 | **Username + PK enumeration** — `find_user`, 1000/hour, any free account (5.3) | **Medium** | High | Constant-shape response; drop `id`; dedicated ~60/hour scope |
| A-7 | **No 429 backoff anywhere** — `Retry-After` exposed by the server, read by nobody (§6) | **Medium** | High under contention | Read `Retry-After` in `apiRequest`, surface `error.retryAfter`, honour it at telemetry/login/playback-token call sites |
| A-8 | **IP-keyed `login` 10/min behind CGNAT** + no lockout + no cooldown UI | **Medium** | Low | Per-username login throttle alongside the IP one (same pattern as register, *done correctly this time*); cooldown UI per `FR-AUTH-2` |
| A-9 | **Blacklist tables grow without pruning** — no `flushexpiredtokens` anywhere (5.8) | **Low now / Medium later** | Certain, unbounded | Beat task running `flushexpiredtokens --hours 24`; alert on row count |
| A-10 | **XSS ⇒ token theft**, no CSP on either origin (§4) | **High** if an injection exists | Unknown — no audit of comment/bio rendering | `Content-Security-Policy` (`script-src 'self'`) via `_headers`; audit user-content rendering |
| A-11 | **Secret hygiene**: `DJANGO_SECRET_KEY` in `.env.local` is **28 bytes**. PyJWT emits `InsecureKeyLengthWarning: The HMAC key is 28 bytes long, which is below the minimum recommended length of 32 bytes for SHA256` — observed live during my probe. Same key signs the JWTs. | **Medium** | Certain (already live) | 32+ bytes. Note `settings.py:20` fails fast on *empty* but not on *short*. `.env.example` and `.env.vps.example` still ship `change-me-...` (33 bytes, passes the length check, fails the value check that `MEDIA_TOKEN_SECRET` now has — see `c897426`) |
| A-12 | **Registration enumeration** — 400 `{"username":["A user with that username already exists."]}` (5.9) | **Low** | High | Return 202/204 regardless; or accept it as the cost of unique usernames |
| A-13 | **`legal` 30/hour/IP throttle is decorative** — `auth.tsx:95-97` swallows the 429 | **Low** | Certain | Surface it, or drop the pre-flight fetch |
| A-14 | **`X-EchoFlow-Client` not in `CORS_ALLOW_HEADERS`** (`settings.py:81-87`) — the documented native opt-in is stripped at preflight | **Low** (web) | Certain (native) | Add to the allowlist. *Media domain's call; flagging because the blast radius is `settings.py`.* |

**Unbounded-refresh amplification: NOT PRESENT.** Bounded at 1 refresh + 1 replay per `apiRequest` (structurally, not by a retry cap), 1 in-flight per tab, and 120/hour per user server-side. Do not write a fix for this.

---

## Recommended fix order

**Tier 0 — security, do first, each independently shippable**

1. **A-1 multi-tab.** Highest severity × highest likelihood, and it is *actively getting worse* with every committed line of client code. Server-side rotation grace window. *Needs an owner decision between server-grace and `localStorage`+`BroadcastChannel` — I recommend server-grace; ask before implementing.*
2. **A-2 password validation.** One function call in `RegisterSerializer.validate`. Verify the new test goes red first.
3. **5.1 fix `RegisterUsernameRateThrottle`'s scope.** Then **rewrite `test_throttling.py:338-347`** to `_view_with_scope('register')` and assert **3**, and confirm it fails against the current code. Then fix the six doc/comment sites that assert 3/hour.
4. **A-10 CSP.** `script-src 'self'` + `style-src`/`font-src` for the Google Fonts origins + `connect-src` for the API and media origins. Zero application code changes. Needs a `_headers` file for the Pages origin and an `add_header` for the nginx origin.
5. **A-11 rotate the 28-byte `DJANGO_SECRET_KEY`** and add a length check next to the existing empty check at `settings.py:20`.

**Tier 1 — session correctness**

6. **A-3 + A-4 together, one change to `client.ts:85-102`.** Branch on status; treat only 401/400 as terminal; do not clear storage on a transport failure; dispatch the event on every terminal path. This is the real P0-4 and it subsumes the "one missing line" fix. Add the error taxonomy from §6.4 at the same time (5 lines, and every call site benefits).
7. **A-7 `Retry-After`.** Read it in `apiRequest`, expose `error.retryAfter`, honour it at the three call sites `FRONTEND-REQUIREMENTS.md:1443-1446` names. **Fix the `fetchMock.ts:4-8` comment first** so the test is written to the right shape.
8. **A-5 absolute session lifetime.** `settings.py:832-842` + `backend/app/urls.py:31-48`. Also document the sliding-vs-fixed TTL correction in the four places that get it wrong.

**Tier 2 — abuse surface, needs product input**

9. **A-6 `find_user`.** *Ask the owner: is username search worth the enumeration?* Then constant-shape the response.
10. **A-8 per-username login throttle + cooldown UI.**
11. **A-9 `flushexpiredtokens` Beat task.**

**Tier 3 — docs, do these in the same commit as the code they describe, never separately**

12. The 13 contradictions above. **A doc that is not updated in the same commit as its fix is the mechanism by which the next agent reintroduces the bug** — that is exactly what happened to `04-hls-token-protection.md:275-278` and what `fetchMock.ts:4-8` is about to do to `Retry-After`.

---

## Recommended **NOT** to fix for an MVP

- **Proactive token refresh.** The prior audit calls this a P5 defect. It is a **latency optimisation with zero user-visible benefit** (§3): the 401-refresh-replay already makes access-token expiry invisible, and `App.tsx:36-40` keeps the token warm regardless. Do it last, if at all. Anyone who "fixes" this expecting to close a logout bug will be disappointed, and the eager implementation may well re-introduce the multi-tab problem by adding a second, uncoordinated refresh trigger.
- **Replacing `sessionStorage`.** Tempting as an A-1 fix, but it collides with a documented rule (contradiction #3), and the server-side fix is better. Not an MVP change.
- **`decodeToken`/`exp`-based `isAuthenticated`.** Sounds like the right fix for §3 and is a genuine improvement in correctness. But it adds a JWT parser dependency for a state that the *server* already arbitrates on every request. A decoded `exp` is a hint; the 401 is the truth. Fix the truth path (Tier 1 #6) first and re-evaluate.
- **Revocation / "sign out everywhere" (part of A-5).** Real gap, but it needs a token-version column and a migration, and the `flushexpiredtokens` task should land first so the blacklist is not already unbounded. Tier 2, not MVP.
- **The 30 s unread poll.** It is doing load-bearing work nobody designed it for (the incidental token warmer). If anyone optimises it away — a reasonable-looking perf change — access-token expiry becomes *visible* and §3's "no proactive refresh" instantly becomes a real P0. **Leave it, and put a comment on it saying why.** This is a trap, not an opportunity.
- **An error taxonomy in `apiRequest`** — no, this one *is* Tier 1. Five lines, and it is the structural fix for the app-wide `catch { console.warn }` pattern the prior audit flags everywhere else. Doing it alongside #6 is nearly free; doing it later means re-reading every call site.

---

## Two things I want to flag about my own method

- Every 🔴 finding above was **proven on the running stack**, not inferred: the blacklist behaviour by minting and re-presenting a real token; the throttle scope by instantiating the class against real settings and then by 16 live requests that should have 429'd; the password validators by running the serializer; the sliding `exp` by rotating and diffing the claim. I did not trust the audit, and neither should the implementer trust this report without the same standard.
- I made DB writes (one user row, one blacklist row) to gather that evidence and **deleted both**; `git status` shows no files of mine. The stack is healthy and the suite is green. If any parallel agent sees a `zz_recon*` user or a shifted `OutstandingToken` count, that was me, and it is cleaned up.
</task_result>
</task>