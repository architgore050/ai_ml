# RECON-04 — Error Resilience / Plausible False States

Recon agent R4 · read-only · no files modified, no git writes.
Method: static analysis with grep/read verification. `vitest` / `tsc` / `vite build` were **not** run (they write cache dirs, forbidden by the read-only brief). No claim here depends on a test result.

Scope exclusions: R1 owns media/HLS internals, R2 owns the auth refresh mutex. Those are referenced, not re-derived. `mobile/` untouched.

---

## 1. Verdict table

| # | Failure mode | What renders today | Plausible-but-false? | Blast radius | Severity |
|---|---|---|---|---|---|
| F1 | Upload accepted, clip never published | "Ingestion Accepted (202)", CLIP_ID, "Directing to live feed…" then a feed with no trace of it | **YES** | `Upload.tsx:122-137,152-168` | **CRITICAL** |
| F2 | `/profile/me/` or `/profile/{id}/` fails | 0 followers / 0 following / 0 reels, "Joined: <today's date>" | **YES** | `Profile.tsx:70-72` → `:162,172,207,213,219,251,260` | **CRITICAL** |
| F3 | `GET /comments/?clip=` fails | "No comments yet / Be the first to share your reaction" + "Discussions (0)" | **YES** | `CommentSheet.tsx:37-38` → `:84,105-111` | **HIGH** |
| F4 | Comment POST fails | Nothing. Text stays, no message, no retry | **YES** (silently lost) | `CommentSheet.tsx:55-56` | **HIGH** |
| F5 | Non-2xx from `/auth/token/refresh/` (429/500/502/503) | "Your session expired" + login screen | **YES** | `client.ts:85-90` → 27 call sites | **HIGH** |
| F6 | Network throw inside refresh `fetch` | Nothing. Tokens wiped, no `ef_session_expired`, `user` untouched → zombie app | **YES** | `client.ts:99-102` | **HIGH** |
| F7 | 429 from any endpoint | `Retry-After` never read; throttle swallowed (telemetry) or unannounced rollback (like) | **YES** | 0 production reads; `tooManyRequests()` exists and is **unused** | **HIGH** |
| F8 | Hung request / no timeout | Indeterminate spinner or permanently disabled button, forever | Blank-but-honest | `client.ts:115-174`, 7 surfaces | **HIGH** |
| F9 | Share sent, modal reused for another clip | Green "Sent" for a clip it was never sent to | **YES** | `ShareModal.tsx:26,60,148-149,174-184` | **HIGH** |
| F10 | Any paginated list | Only page 1; counts derived from the page; no "load more" | **YES** | `CommentSheet.tsx:84`, `Explore.tsx:38`, `Profile.tsx:239` | **HIGH** |
| F11 | Feed cold-queue retries exhausted | "Nothing here yet / Check back soon" | **YES** | `Feed.tsx:42-49` → `ReelList.tsx:109,190-227` | MEDIUM |
| F12 | Feed refresh fails with clips on screen | Nothing — `errorMsg` set but the branch requires `clips.length === 0` | **YES** | `Feed.tsx:63-64,103`; `ReelList.tsx:108` | MEDIUM |
| F13 | `send-share` fails | Nothing. Button stays "Stream" | **YES** | `ShareModal.tsx:61-63` | MEDIUM |
| F14 | `find-user` fails for any reason | "Peer listener not found in directory." for a 429, 500, and offline alike | **YES** | `ShareModal.tsx:47-49` | MEDIUM |
| F15 | "Copy link" on a non-secure origin | "Direct Stream URL Copied" regardless; write un-`await`ed; URL has no reader | **YES** | `ShareModal.tsx:32-37,110-112` | MEDIUM |
| F16 | markRead / share-delete / clip edit / delete fails | Nothing. `console.warn` only | Partially | `Inbox.tsx:44-46,62-64`; `Profile.tsx:111-113,122-124` | MEDIUM |
| F17 | Like fails (429/offline/5xx) | Heart un-fills silently, no message, no `role="status"` | **YES** | `ReelCard.tsx:93-95` | MEDIUM |
| F18 | Render error in any tab | Whole app blanks to "Something broke" — one boundary | Blank-but-honest | `App.tsx:153-159` | MEDIUM |
| F19 | Unhandled promise rejection | Nothing. Zero `unhandledrejection` / `window.onerror` listeners exist | Silent | grep: 0 listeners | **HIGH** |
| F20 | Backend down, on a phone | No health signal — the indicator is `hidden lg:flex` | Blank | `Header.tsx:114` | MEDIUM |
| F21 | Device reconnects but backend still down | "Back online" | **YES** | `NetworkBanner.tsx:60-64,77` | MEDIUM |
| F22 | Explore / Inbox / Comments fail once | Error text with **no retry button**; stuck until remount | Honest-but-trapped | `Explore.tsx:99-102`, `Inbox.tsx:89-92` | MEDIUM |
| F23 | Tab-switch remount | Each switch re-`lpop`s 10 clips; a DB error after the `lpop` destroys them | Silent data loss | `App.tsx:80-100`; `feed.py:71-75,127-131` | MEDIUM |
| F24 | Feed always shows "All caught up" | Rendered unconditionally (`hasMore={false}`) | **YES** | `Feed.tsx:164`; `ReelList.tsx:148-161` | MEDIUM |
| F25 | Minor's telemetry | Server permanently 403s; client retries every ~6 s forever, swallowing it | Silent | `player.tsx:77-83` vs `interactions.py:66-70` | LOW |
| F26 | 100 MB upload in progress | Indeterminate "Dispatching to Celery Queue…" — no progress, no timeout | **YES** | `Upload.tsx:113,284` | MEDIUM |

No `Toast`, no `alert(`, no retry button on 3 of 5 error surfaces — grep-verified.

---

## 2. Per-finding detail

### F1 — Upload success is a fabrication (CRITICAL)

`Upload.tsx:122-137` accepts the 202, then `setTimeout(onUploadSuccess, 2500)`. The failure sequence:

1. `POST /clips/` → 202, `status: "processing"`, `moderation_approved=False` (model default, `models.py:152`).
2. HLS encoding is triggered **only** by `POST /clips/{id}/approve-moderation/`. `grep -rn "approve-moderation" frontend/src/` → **no matches**. The client never calls it.
3. The clip therefore stays unapproved forever, so `FastFeedViewSet.list`'s `.filter(moderation_approved=True)` (`views/feed.py:117`) and `ProfileViewSet.user_clips`'s `.filter(status='ready')` (`views/profile.py:57`) both exclude it.
4. `POST /media/playback-token/{id}/` 403s (`views/media.py:215-220`).
5. No poll exists — `frontend/src` has exactly two timers (`useBackendHealth.ts:169,175`, `App.tsx:38`); neither touches clip status. `clipsAPI` has no `getClip`.

`views/content.py:249-256` documents that owner self-approval is the current v1 workflow ("the mobile upload flow self-approves its own clip"). The web client just never does it.

### F2 — Profile renders a plausible zero profile (CRITICAL)

`Profile.tsx:70-72` is the only failure handling: `console.warn`, then fall through to render. With `currentDisplayProfile === null`, `|| 0` on a failed fetch is indistinguishable from a genuine zero, and `date_joined || Date.now()` fabricates **today's date as the account creation date** — a claim about account history about a third party on a public profile. `auth.tsx:40-42` has the identical shape, so the failure is invisible at both layers.

### F3 / F4 — Comments (HIGH)

`CommentSheet.tsx:37-38` leaves `comments` as `[]` → "No comments yet / Be the first to share your reaction" and "Discussions (0)", while the authoritative `clip.comment_count` sits on the `ReelCard` button the user just tapped. Two different numbers for the same fact, one of them fabricated. The post-failure path (`:55-56`) keeps the text (correct) but shows nothing.

### F8 — No timeout anywhere (HIGH)

`client.ts:115-174` is the whole request path: no `AbortController`, no `signal`, no `Promise.race`. The only `AbortController` in the frontend is `useBackendHealth.ts:97,135`, a local variable that never reaches the other 27 call sites. Permanently stuck surfaces: `Login.tsx:245-247`, `Upload.tsx:281,284`, `OnboardingModal.tsx:137,141`, `Explore.tsx:94-98`, `Inbox.tsx:84-88`, `Feed.tsx:94-101`, `CommentSheet.tsx:195`, `Profile.tsx:428,431`, `ShareModal.tsx:131`.

`useBackendHealth.ts:46-52` already contains the correct pattern and its own comment: *"a half-open connection would leave the indicator on `checking` for ever — a different flavour of the same lie."* That reasoning was applied to the probe that matters least.

### F9 / F10 / F12 / F24 — Feed and list state

`ShareModal` is mounted once in `FeedPage.tsx:179-183` and only ever receives `isOpen={false}`; it returns `null` at `:66` but its state is **not reset**, so `sentUsers[1]` stays true for every subsequent clip. `services/shares.py:28-31` is an unconditional `ShareEvent.objects.create(...)` with no dedupe, and there is no pending guard at `:55-56`, so a double-tap creates two inbox rows and bumps the counter twice.

`Feed.tsx:103` `if (errorMsg && clips.length === 0)` means a failed refresh with clips on screen is silent, and `ReelList.tsx:108` has the identical condition — so `ListError` and its `window.location.reload()` handler are **dead code**; `Feed.tsx` short-circuits first.

`Feed.tsx:37-51` cold-queue handling has three defects in nine lines: `retryCountdown` is set once and **never decremented** (no interval anywhere, so the text reads "retrying in 2s" for the whole cold period); the `setTimeout` is **never cleared** (`useEffect` at `:70-76` returns no cleanup), so a tab switch fires another destructive `lpop`; and after 5 retries the page renders as an empty feed, i.e. "Nothing here yet" when the queue is merely cold.

No consumer of `next`/`previous`/`cursor` exists anywhere in `src/`, so "All caught up" (from `hasMore={false}`) is rendered on every feed while `feed.py:100` returns `next: "auto_trigger"` and 30+ unread clips.

### F14 / F15 — ShareModal error laundering (MEDIUM)

`ShareModal.tsx:47-49` maps a 429, a 500, a `TypeError: Failed to fetch`, and a genuine 404 to the same sentence "Peer listener not found in directory." The backend distinguishes them cleanly (`views/social.py:118` 400, `:122` self-share 400, `:125` 404). The message is **categorically false in three of four cases**.

`:32-37` does not await `navigator.clipboard.writeText` and has no `.catch`, so a permission rejection becomes an unhandled rejection while `:110` still shows "Direct Stream URL Copied". On a non-secure origin the API is `undefined` and this throws synchronously. The copied URL is inert: `?clip=` is read by nothing.

### F19 — Zero global error/rejection handlers (HIGH)

`grep -rn "unhandledrejection|window.onerror" frontend/src` → **no matches**. `ErrorBoundary` catches render throws only; React 19 does not route event-handler or async rejections to a boundary. The live example is `ShareModal.tsx:34`.

### F20 / F21 — Connectivity signals (MEDIUM)

`Header.tsx:114` puts the honest health verdict inside `hidden lg:flex`. `ReelList.tsx:18` sizes the reel to a phone viewport and `BottomNav.tsx:20` is `md:hidden`, so the primary device gets no backend-health signal at all. `NetworkBanner.tsx:60-64,77` sets `reconnected = true` on any `online` event — the file's own comment at `:38-43` correctly notes `navigator.onLine` is not a reachability probe, then makes a reachability claim anyway.

---

## 3. The plausible false state inventory

| Rank | Screen | Asserts | Truth | Harm |
|---|---|---|---|---|
| 1 | Upload success (`Upload.tsx:152-168`) | "Ingestion Accepted", "Worker task dispatched", "Directing to live feed…" | unapproved, invisible to feed and profile, 403s at playback, never published | **Creator believes they published.** They re-upload (duplicate orphans) or blame the app |
| 2 | Own profile on failed fetch (`Profile.tsx:207,213,219,172`) | 0/0/0, joined **today** | nothing was read | fabricates account history; a creator with 4 000 followers believes they were wiped |
| 3 | Comment sheet on failed fetch (`:105-111`) | "No comments yet. Be the first…" | the request 500'd/timed out | silently invites a **duplicate comment**; data-integrity harm |
| 4 | Share modal "Sent" (`:174-178`) | this clip was sent to this peer | a *different* clip was | recipient waits for a clip that never arrives |
| 5 | Feed "Nothing here yet" (`ReelList.tsx:190-227`) | there is no content for you | 5 retries gave up on a cold queue | reads as "I'm not into anything" — the exact wrong conclusion for a recommender |
| 6 | Feed "All caught up" (`:159`) | you have seen everything | `hasMore={false}` is a literal; 30+ remain | kills the core loop on first render |
| 7 | Counts from the page (`CommentSheet.tsx:84`, `Profile.tsx:239`, `Explore.tsx:38`) | "Discussions (20)", "My Uploads (10)" | page size, not total | contradicts `clip.comment_count` on the adjacent button |
| 8 | "Back online" (`NetworkBanner.tsx:77`) | the app works again | a NIC exists; server may be down | undoes the user's correct hypothesis and sends them into the same wall |
| 9 | Like after a 429 (`ReelCard.tsx:93-95`) | nothing | the like was rejected | heart un-fills with no explanation; users re-tap, burning a 60/min budget |
| 10 | Copy-link "Copied" (`ShareModal.tsx:110`) | the link is on your clipboard and works | write may have rejected; `?clip=` is read by nothing | pasted link opens the generic feed |
| 11 | Stale feed after failed refresh (`Feed.tsx:103`) | these are current reels | the refresh failed | engagement decisions on stale data |
| 12 | Explore "Listens" (`Explore.tsx:159`) | `max(15, likes+shares*2)` listens | no such field exists | a confident invented number |
| 13 | "Dispatching to Celery Queue…" (`Upload.tsx:284`) | progress is happening | 100 MB transferring, or the socket is dead | unbounded, no timeout, no progress |
| 14 | "Peer listener not found" on a 500 (`:48`) | that user does not exist | server down / throttled | sends the user hunting a typo that isn't there |

---

## 4. ErrorBoundary / unhandled-rejection coverage

Exactly one boundary, wrapping the whole app (`App.tsx:151-160`).

**`ErrorBoundary.tsx:28-30` is factually inverted**: it claims the boundary "sits *inside* the providers" and that "a throw in the providers themselves is not caught here". It sits **outside** both. There is no note in `App.tsx`. Same class as the `CORS_URLS_REGEX` comment AGENTS.md already flags.

Genuinely uncovered: event-handler and async rejections (React 19 does not route these); route/tab scoping — `ErrorBoundary` supports `fallback`/`label` (`:5-10`) and nothing uses them, so one throw in a `ReelCard` unmounts the feed, header, nav **and the player**, with audio stopping mid-track and no explanation.

---

## 5. Duplicate-submit audit

| Action | Site | In-flight guard | Server dedupe | Verdict |
|---|---|---|---|---|
| Like | `ReelCard.tsx:82,88,97` | **YES** (`isLikePending`) | genuine toggle | Safe |
| Follow | `ReelCard.tsx:107,111,122` | **YES** (2 tests) | toggle | Safe |
| Comment | `CommentSheet.tsx:46,48,58,195` | **YES** | n/a | Safe |
| Upload | `Upload.tsx:113,281` | **YES** | none needed | Safe |
| Profile save | `Profile.tsx:79,428` | **YES** | n/a | Safe |
| Tag init | `OnboardingModal.tsx:43,137` | **YES** | n/a | Safe |
| Find user | `ShareModal.tsx:41,131` | **YES** | n/a | Safe |
| **Share send** | `ShareModal.tsx:55-56` | **NO** — flips only *after* the await | **NO** — `shares.py:31` unconditional create | **UNSAFE** — double-tap → 2 inbox rows, 2 counter bumps |
| markRead | `Inbox.tsx:37` | NO | Yes (`.update(is_read=True)` filtered by pk+receiver) | Harmless, idempotent |
| share-delete | `Inbox.tsx:59` | NO | Yes, idempotent DELETE | Harmless |
| Clip edit | `Profile.tsx:102,491` | NO — button never disabled | last-write-wins | Harmless, noisy |
| Clip delete | `Profile.tsx:117` | `confirm()` gates it | idempotent | Harmless |
| Login | `Login.tsx:221 onKeyDown` + `:141 onSubmit` | `isLoading` on the button but `handleSubmit` never checks it | n/a | Probably safe: `e.preventDefault()` at `:41` cancels implicit submission. **Not verified by test — low confidence, not asserted** |

---

## 6. Backend error contract vs frontend expectations

No custom `EXCEPTION_HANDLER` → stock DRF shapes.

| Condition | Body | Header | Frontend |
|---|---|---|---|
| Throttle 429 | `{"detail": "…"}` | `Retry-After: N` | **never read**; `CORS_EXPOSE_HEADERS` (`settings.py:89-97`) exposes it with a comment saying the client is required to honour it |
| Validation 400 | `{"field": ["msg"]}` or `{"detail"}` | — | `client.ts:166` flattens correctly; only 2 sites read `err.data.*` |
| Auth 401 | `{"detail"}` | `WWW-Authenticate` | `client.ts:139` refresh + replay |
| Permission 403 | `{"detail"}` | — | only `player.tsx:224-230` |
| 5xx | **HTML** (`DEBUG=False`) | — | `client.ts:155-160` reads text → message becomes the literal "Request failed". Honest, unhelpful; `err.data` holds the whole HTML page |
| Cold feed 202 | `{"results": [], "retry_after_ms": 1500, "degraded": true}` | — | `client.ts:162` special-cases it — **the only place the 202 contract is honoured** |

**Shape inconsistency**: the codebase mixes `{"detail"}` and `{"error"}` arbitrarily (`urls.py:79,88` vs `views/social.py:118,122,125,155,161,179,225` vs `views/content.py` which raises DRF exceptions). `client.ts:164-165` papers over it by trying both. Any new surface reading only one key silently shows the wrong message.

**`src/test/fetchMock.ts:4-7` documents behaviour that does not exist**: it claims `apiRequest` layers "`Retry-After` extraction" on top of `fetch`. `client.ts:154-173` never touches `response.headers`. The companion `tooManyRequests()` helper (`:159-165`) has **zero call sites** — a scaffold for a feature never implemented, which makes the suite look like it covers 429s when it does not.

---

## 7. Blast radius

**Refresh path (F5/F6)** — 30 `apiRequest`/`fetch` sites in `client.ts`; 3 are `skipAuth` and can never reach the refresh branch (`:209` register, `:223` compliance, `:227` login). **27 can:** `/feed/` `:255` · `/suggestions/` `:260` · `/tags/initialize/` `:264` · `/clips/` `:273` · `PATCH /clips/{id}/` `:280` · `DELETE /clips/{id}/` `:287` · `toggle-like` `:295` · `register-skip` `:301` · `log-telemetry` `:308` · `GET /comments/` `:322` · `POST /comments/` `:326` · `PATCH` `:333` · `DELETE` `:340` · `find-user` `:348` · `send-share` `:352` · `/share/inbox/` `:359` · `unread-count` `:363` · `mark-read` `:368` · `share-delete` `:374` · `toggle-follow` `:382` · `/profile/me/` `:390` · `/profile/me/update/` `:394` · `/profile/{id}/` `:401` · `/profile/{id}/clips/` `:405` · `/auth/logout/` `:240` · plus `/health/` + `/ready/` (`useBackendHealth.ts:110,125`).

**Plus one that bypasses it entirely:** `POST /media/playback-token/{id}/` (`client.ts:431`, raw `fetch`) — a 401 there never refreshes, never dispatches, never surfaces.

**F8 no timeout:** `client.ts:115-174`. `AbortController` appears only at `useBackendHealth.ts:97,135`.

**F23 destructive refetch:** `App.tsx:80-100` (conditional render → unmount on tab switch) + `Feed.tsx:34,70-76` (no cleanup, refetch on mount) + `views/feed.py:71` (`lpop(redis_key, 10)`) + `:127-131` (the `except` that serves trending *after* the ids were consumed).

---

## 8. What a fix MUST preserve

1. `apiRequest`'s **202 passthrough** (`client.ts:162`) — upload and telemetry depend on it.
2. The **single-flight refresh mutex** (`client.ts:65,73-75,104`) — R2 confirms it works; a `!res.ok` fix must not add a second concurrent refresh.
3. `credentials: "include"` on `getPlaybackToken` (`client.ts:436`) and `xhr.withCredentials` (`player.tsx:244-246`) — dropping either makes every `/hls/*` 403.
4. `ef_session_expired` as the **only** tree-teardown signal — `SessionNotice` is mounted at `App.tsx:145` *outside* the `isAuthenticated` conditional at `:146` precisely so it survives the transition. A second logout path (e.g. clearing on 5xx) would tear down the notice explaining it.
5. Optimistic like/follow rollback arithmetic (`ReelCard.tsx:94-95`) — the `!nextLiked ? +1 : -1` inversion is correct and easy to break.
6. `isLikePending` / `isFollowPending` guards — 2 tests pin the follow one.
7. `playbackError`'s 409/403/404 mapping (`player.tsx:223-231`) — currently unread; a fix should **render** it, not rewrite it.
8. The `useBackendHealth` **timeout-race** pattern (`useBackendHealth.ts:143-153`) — the `stale` flag, not the `abort`, is what makes it correct. Copy the pattern, not just the `AbortController`.
9. The `results.length === 0` guard in `Feed.tsx:37` — a 202 *with* results must not be treated as cold.
10. CORS allowlist — any new code reading a response header must be on a route `CORS_URLS_REGEX` (`settings.py:60`) matches; it excludes only `/admin/` and `/metrics/`, so `/health/` and `/ready/` are covered.

---

## 9. Tests that would prove each fix

Harness: `installFetchMock()` (`src/test/fetchMock.ts`, supports `.fail()` for transport throws), `MockAudio`, `MockIntersectionObserver` + `intersectionMock.intersect(id)`, RTL + `userEvent`, `restoreMocks: true`. **Baseline 48 tests.** Every test must be **watched fail before the fix**.

| Fix | Test |
|---|---|
| F1 | `POST /clips/` 202 → assert the UI does not claim the reel is live until a status read confirms it; assert `approve-moderation` is called |
| F2 | 500 on `/profile/me/` → assert an error state **and** that `0` followers is absent; assert no "Joined: <today>" |
| F3 | `api.fail("GET", /comments/)` → assert "No comments yet" is **not** present |
| F4 | `POST /comments/` 500 → assert the text is still in the input **and** an error is present |
| F5 | 429 on refresh → assert `ef_session_expired` **not** dispatched, `sessionStorage` **not** cleared, `Retry-After` surfaced |
| F6 | `api.fail("POST", /token\/refresh/)` → assert the event **is** dispatched and `LoginPage` renders |
| F7 | 429 on `toggle-like` → assert a `role="status"` carries the retry hint |
| F8 | fake timers + a never-resolving handler → assert each spinner leaves its loading state |
| F9 | share clip A to peer 1, close, open for clip B → assert peer 1 shows "Stream" again |
| F10 | `next` non-null → assert a load-more affordance; 25 comments → header uses `clip.comment_count` |
| F11 | 5 consecutive 202s → assert an explicit "still preparing" state, **not** "Nothing here yet" |
| F12 | first load OK then 500 on retry → assert the error is visible **alongside** the retained clips |
| F14 | 500 on `find-user` → assert the message is **not** "not found" |
| F15 | `writeText` rejects → assert no "Copied" and no unhandled rejection |
| F19 | reject a promise in an event handler → assert a visible surface |
| F23 | mount → tab switch → back → assert 2 `GET /feed/` calls; assert the cold `setTimeout` is cleared |
| F24 | response carries `next: "auto_trigger"` → assert "All caught up" absent |
| F28 | fake timers → assert the countdown text actually decreases |

Also delete or correct `src/test/fetchMock.ts:4-7` and `ErrorBoundary.tsx:28-30` in the same commit as the behaviour they describe, so a comment cannot outlive its code again.

---

## 10. Recommended fix order

1. **`client.ts` groundwork** — attach `retryAfter` from `response.headers`; record `error.status`; add a NETWORK/OFFLINE discriminator when the initial `fetch` throws. One file, no control-flow change, breaks no test. Everything below depends on it.
2. **`CommentSheet.tsx`** — `postError` above the input with `role="status"`; distinguish load-error from empty.
3. **`ReelCard.tsx`** — copy `:232-238`'s existing `role="status"` announce to the like button (follow is the reference implementation; this is symmetry, not new machinery).
4. **`Inbox.tsx`**, then **`Profile.tsx`** — announce mark-read/delete/edit failures. Rollback is already correct; only the announcement is missing.
5. **`Profile.tsx`** — `loadError` state; skeleton while loading; em dash + error on failure; remove all six `|| 0` and the `|| Date.now()`. Highest-harm fix; do it on a file already carrying tests from step 4.
6. **`client.ts`** (sequential with 1) — narrow `!res.ok` to 401/400; dispatch on the network-throw path. Must preserve the mutex and the `SessionNotice` placement.
7. **`client.ts`** (sequential) — `REQUEST_TIMEOUT_MS` + `AbortController`.
8. **`ShareModal.tsx`** — re-key `sentUsers`, add a pending set, await the clipboard, delete the inert `DEFAULT_PEERS`, fix the error message.
9. **`Upload.tsx` + `client.ts` (new `getClip`) + one backend call** — needs a product decision (self-approve, or an honest processing list).
10. **List layer** — `Explore.tsx`, `Inbox.tsx`, `ReelList.tsx`, `Feed.tsx`, `Profile.tsx`: pagination, retry buttons, cold-queue honesty.
11. **`App.tsx` + `Feed.tsx`** — the destructive-`lpop` tab-switch remount; needs a decision because the honest fix is a routing change.
12. **`App.tsx`** — global `unhandledrejection` handler; needs a reporting destination.

---

## 11. Deliberately NOT fixed for MVP

- **Route-scoped boundaries** — the props support it, but there is no router, so "route-scoped" means "tab-scoped" and a tab is a `useState` change. One boundary is honest about the current architecture. The `ErrorBoundary.tsx:28-30` docstring inversion is a one-line fix worth doing immediately regardless.
- **F25 minor-telemetry 403** — server behaviour is deliberate and correct; 10/min against a 60/min budget. Suppressing it requires the client to know the user is a minor, which it must not (DPDP §9).
- **F26 upload progress** — needs XHR instead of `fetch`, or chunked upload. The F8 timeout makes the failure honest; progress is a nicety.
- **Honouring `Retry-After` by backing off** — reading and displaying it is the honest MVP. Automatic retry against a 60/min budget can make throttling worse.
- **A `Toast` system** — the working pattern is a per-component `role="status"` (`ReelCard.tsx:232-238`, `SessionAnnouncer.tsx:73-76`, `NetworkBanner.tsx:82-84`). A global toast would touch every file and collide with file-ownership partitioning.
- **Backend `detail` vs `error` unification** — `client.ts:164-165` already handles both; ~20 response sites for zero user-visible gain.
- **`visibilitychange` refetch-on-return** — with a 15-minute access token and no offline write queue the staleness window is bounded and the data is advisory.

---

## 12. Disconfirmations

1. **`ErrorBoundary.tsx:28-30` is factually inverted** — the boundary is outermost, so provider throws *are* caught. The referenced "note in `App.tsx`" does not exist.
2. **`frontend_rebuild_plan.md:89` is wrong** — "Failed share delete removes the row anyway. Optimistic removal, `catch { console.warn }`." Current `Inbox.tsx:58-61` removes the row **only after** `await shareAPI.deleteShare()` succeeds. Not optimistic, no phantom removal. `COMPLETION_PLAN.md` A3 propagates the same wrong premise.
3. **`frontend_rebuild_plan.md:111` is wrong** — "The 30 s poll runs before auth is established, with an empty `catch {}`." The `useEffect` at `App.tsx:36-40` lives inside `MainContent`, which renders only when `isAuthenticated` (`App.tsx:59,146`). It cannot run before auth, and the catch is not empty.
4. **`frontend_rebuild_plan.md:126` is stale** — "No error boundary anywhere." Commit `4ed5cf5` added one. The *consequence* still holds; the premise does not.
5. **`src/test/fetchMock.ts:4-7` documents a feature that does not exist** — see §6.
6. **The prior audit found the destructive `lpop` and `hasMore={false}` but never connected them to a user-visible state.** The consequences — "All caught up" on every feed and tab-switch-driven queue drainage — are in neither the audit nor the plan.
7. **The prior audit treats `date_joined || Date.now()` as cosmetic.** It is the most damaging line on the page: it fabricates a join date, a claim about account history, not a zero placeholder. Grouping it with `|| 0` understates it.
8. **`COMPLETION_PLAN.md` C3 "failed clip-edit must not close the modal" is already true** (`Profile.tsx:110` clears state only on success). The task is a no-op; the real gap is that the failure is invisible.
9. **R1's "unbounded retry loop" and "playbackError has zero consumers" are CONFIRMED** — and the interaction neither report names: because `playbackError` is never rendered, **a clip whose playback token 403/404/409s renders as a normal ReelCard** with a live-looking Play button, a 0:00 scrubber, and a green "HLS Stream: 192kbps ABR" in green. A plausible-false state belonging on the inventory.
10. **R2's exit table is correct and complete.** Addition: **27 of 30** call sites can enter the refresh path (§7).

---

## 13. Open questions for the owner

1. **F1 needs a product decision, not a fix.** (a) the web client calls `approve-moderation` after the 202 (the backend documents owner self-approval as the v1 workflow) — one extra request, no backend change, but moderation becomes a no-op by design; (b) an honest "processing" list polling `GET /clips/{id}/`; (c) drop the success card's claims and say "received; not yet published."
2. **F23: is the tab-switch remount intentional?** The honest fix is to stop remounting `FeedPage` on every tab switch — a routing change. Cheap mitigation now, or wait for the router?
3. **Are the free-tier duration/size limits supposed to be enforced?** The UI enforces the Pro limits for everyone; a free user uploading 90 MB gets a 202 and a clip that will not publish — compounding F1 into "uploaded twice, published never."
4. **F19: is there a reporting destination for a global `unhandledrejection` handler?** AGENTS.md's Sentry is Python-only. Affects whether F19 is worth doing before F20.
5. **`ReelCard`'s telemetry strip is four fabricated confidences on the primary card** — and because `playbackError` is never rendered, it is also the *error* surface: a card that cannot play still looks healthy. Confirm ownership with R3 so it is not filed twice.
6. **`mobile/` is untouched by design, but `mobile/src/store/player.ts` has uncommitted parallel work.** If the mobile client shares the same shape, F1/F3/F8 may duplicate there — check before fixing the web side so the two do not diverge.
