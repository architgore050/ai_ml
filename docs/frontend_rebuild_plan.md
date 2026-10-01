# EchoFlow Frontend Rebuild Plan

**Status:** Awaiting implementation approval
**Branch:** `feat/mobile-rebuild` (no new branch — owner instruction, 2026-09-29)
**Date:** 2026-09-29
**Scope:** `frontend/` (the React web client) + three small backend changes that block honest frontend behaviour
**Not in scope:** `mobile/` — work in progress under a separate agent. This plan does not read, write, or depend on it.

> Filename note: requested as `frontent_rebild_plan.md`; written as `frontend_rebuild_plan.md` to avoid a
> permanent typo in the repo path. Rename if something already expects the literal string.

---

## 1. Starting point

`frontend/` is a single React 19 + Vite + Tailwind 4 client, 23 source files, ~3,000 LOC. It was consolidated
in `9af9bcf` from four competing checkouts (`frontend/src` won; `sample_frontend`, `sample_frontend2` and
`old_frontend` are preserved read-only in `20451d3` and deleted from the worktree).

Already fixed in that pass and **not** repeated here: `server.ts` removal, HLS token minting +
`xhrSetup` `withCredentials`, `dob` at registration, the `FeedClip` type gap, the `Math.random()`
visualizer, `AuthModal.tsx`, and the typecheck gate.

`tsc --noEmit` reports 0 errors and `vite build` succeeds. That is the *only* green signal — there are
**zero tests**, no error boundary, no router, and the audit below found defects in every layer.

---

## 2. Decisions

Owner decisions, 2026-09-29. These are settled; the plan implements them.

| # | Decision | Rejected | Why |
|---|---|---|---|
| **D1** | **Adopt terracotta `#e8a87c`** as the brand colour | Aliasing `--accent` to `#FF6321` | Keeps the design language `sample_frontend2` and `mobile-rebuild-plan.md` D7 both commit to, and collapses one colour that currently has three spellings (`#FF6321`, `#ff763a`, `#ff753b`) into one token. A visually invisible alias would preserve the divergence instead. |
| **D2** | **Backend changes in scope**, including the two that block correct behaviour | Frontend-only | (a) No follow-status field exists on any serializer, so the Follow button on `ReelCard` **unfollows people you already follow**. (b) The avatar upload has **no size or MIME limit at all**, unlike the audio path which enforces 100 MB + magic bytes. Both are small serializer additions; both are prerequisites for a non-broken client. |
| **D3** | **Add `react-router-dom`** | Keep the `useState` tab shell | There are no URLs, no back button, and the share link the app copies (`?clip=<id>`) is a dead end — nothing reads the query param. A router is also the precondition for the A4 share flow (D5) being meaningful. |
| **D4** | **Delete fabricated data; wire up what has a real source** | Keep decorative telemetry panels | A "3-D Acoustic Vector" derived from `likes * 13 % 89` and a "Similarity Score" of `0.92 + likes % 7 * 0.01` are arithmetic on two integers presented as embedding-space output. They are not decoration, they are false claims in the product's primary surface. |
| **D5** | **Wire the A4 share-link flow** for own clips | Peer-to-peer only | `POST /clips/{id}/share-link/` + `GET /clips/{id}/public/` + `POST /clips/{id}/play/` shipped in `f4bf14b` and are used by nothing. Opening a shared link mints nothing; playback requires an explicit play call that re-checks moderation and the NC/SA licence filter at play time. |
| **D6** | **Add vitest + React Testing Library, and turn on `strict`** | Either alone | Every fix below is a regression someone will re-break. `strict` is off precisely because `@types/react` was missing until the last pass, so every React state hook was silently `any` for this codebase's entire life. |

---

## 3. Findings

Severity is by user-visible or data-integrity impact, not by effort.

### 3.1 P0 — data integrity and security

| # | Finding | Location | Impact |
|---|---|---|---|
| **P0-1** | **The share modal sends shares to real, fabricated users.** Four hardcoded peers `{id: 1, "alex"}, {id: 2, "roastmaster"}, {id: 3, "curiosity_lab"}, {id: 4, "stoic_focus"}` are rendered under the heading "Network Peers", each with a live **Stream** button wired to `handleSendToUser(peer.id)` → `shareAPI.sendShare(clip.id, recipientId)`. `receiver_id` is a real FK to `backend.app.User`. | `ShareModal.tsx:17-22`, `:166`, `:59` | Every tap writes a real `ShareEvent` row and a real `UserInteraction(type='share')` counter increment for whichever real users hold ids 1–4, and creates an unread item in their inbox. The button then flips to a green "Sent", so there is **no feedback that the recipient was invented**. This is data corruption, not a mock leftover. |
| **P0-2** | **`watch_time_ms` is media *position*, not watch time.** All three telemetry sites send `Math.floor(audio.currentTime * 1000)`. | `player.tsx:81`, `:99`, `:171` | Seek to 5:00 of a 10:00 clip and the next heartbeat reports 300 s watched after two seconds of listening. `interactions.py:242` computes `completion_rate = min(watch_time_ms / clip_duration, 1.0)`, and `avg_completion_rate` is **30 % of the recommendation score**. Seek-to-end yields a perfect completion for a clip never watched. This is the engagement-manipulation vector the backend comment at `interactions.py:88-90` explicitly names. Also: `watchTimeRef` (`:47`, `:72`, `:185`) *looks* like a watch-time accumulator, is never read, and increments a hardcoded 250 ms assuming `timeupdate` fires at exactly 4 Hz. |
| **P0-3** | **Auto-advance is dead — stale closure.** The `useEffect(..., [])` at `:62` creates `handleTimeUpdate`/`handleEnded` once, closing over the first render's `handleAutoAdvance`, which closes over the first render's `currentClip` — `null` at mount. `if (!currentClip) return;` at `:167` therefore always returns. | `player.tsx:62-123`, `:166-172` | Both the 99 %-completion path and the native `ended` event no-op. Completion telemetry never fires; `nextClip("auto")` is unreachable; the `reason === "auto"` branch is dead. The feed *appears* to work only because `ReelList:96-104` scrolls and trips its own `IntersectionObserver`. On the Inbox page (no `ReelList` mounted) a clip plays to the end and **stops dead**. Note `:76` uses `currentClipRef` correctly one function up, which is what makes this easy to miss. |
| **P0-4** | **Zombie-authenticated state.** The network-throw path in the refresh mutex clears storage but does **not** dispatch `ef_session_expired`; the 401 path does. | `client.ts:99-102` vs `:85-90` | A network failure during refresh leaves the UI authenticated with no tokens. The user sees a working-looking app that 401s on every request until a manual reload. One missing line. |
| **P0-5** | **`getPlaybackToken` bypasses the 401 interceptor.** It is the only call in the client that uses raw `fetch` instead of `apiRequest`. | `client.ts:431-437` | An expired access token at mint time returns 401, which the player's error mapping collapses into `"Playback unavailable"` instead of triggering refresh-and-replay. |
| **P0-6** | **Avatar upload is unbounded.** `ProfileUpdateSerializer` declares `fields = ['username', 'profile_picture']` with a username check and **no `validate_profile_picture`**, no size cap, no MIME/extension/magic-byte check. | `serializers.py:709-719` | Any authenticated user can POST an arbitrarily large file to object storage. The audio path is the opposite — `MAX_SIZE = 100 MB`, an extension allowlist, and a magic-byte allowlist. The UI's "Max 5MB" label (`Profile.tsx:414`) is unenforced by client *and* server. |
| **P0-7** | **The Follow button is destructively wrong.** `isFollowing` is `useState(false)`, never hydrated — there is no `is_following` on `FeedClipSerializer` and no follow-status endpoint anywhere in the backend. | `ReelCard.tsx:56`; `serializers.py:309-364`; `views/social.py:114-129` | A user who already follows a creator sees "Follow". Tapping it calls `toggle-follow`, which **unfollows them**. No confirmation, no feedback. |
| **P0-8** | **The copyright attestation is asserted for the user.** `formData.append("copyright_acknowledgement", "true")` with no checkbox, no notice, no way to decline. | `Upload.tsx:120`; `serializers.py:165`, `:184-187` | The server requires it and logs a warning when `license_type` is `Unknown` (`:191`). The user is not asked to affirm they hold rights to the audio; the app affirms it on their behalf. That is a compliance defect, not a validation gap. |
| **P0-9** | **Unbounded HLS retry against a 600 s token, and no re-mint on mid-playback 403.** `hls.startLoad()` retries on `NETWORK_ERROR` with no cap; a mid-session token expiry makes the manifest 200 and every segment 403, which is handled by restarting the *same* expired source. | `player.tsx:255-264`; `views/media.py:183`; `MEDIA_TOKEN_TTL_SECONDS` | Infinite retry storm, and a stream that can never recover because the token is never refreshed. |

### 3.2 P1 — fabricated data presented as real

| Finding | Location | What it claims |
|---|---|---|
| "Acoustic Vector" `v[0.${likes*13%89+10}, -0.${shares*19%79+10}, 0.99]` | `ReelCard.tsx:116-118` → `:245` | A 3-D embedding fingerprint. Two lies: it is 3 numbers not 128-dim, and it is *derived from like and share counts* — so the displayed "acoustic fingerprint" **changes when the user presses Like**, which no physical acoustic property can do. |
| "Similarity Score" `0.92 + (likes % 7) * 0.01` | `ReelCard.tsx:119` → `:249` | A cosine match. The real value lives in the pgvector HNSW index and is exposed by no serializer. The range 0.92–0.98 means it always looks like a confident match, even for a cold-start user whose vectors were seeded seconds ago. |
| Hardcoded transcript | `ReelCard.tsx:238` | The same sentence on every card: *"Sound travels without pixels…"*. A real `transcript` field exists. |
| `192kbps ABR` in green | `ReelCard.tsx:253` | `HLS_BUCKETS` is server-side config; no bitrate reaches the client. Styled to read as a healthy reading. |
| Fake waveform amplitude when not playing: `((idx * 17) % 65) + 20` | `ReelCard.tsx:210-212` | 24 bars of invented amplitude presented as an audio waveform. |
| `CLIP_ID: EF-{shortId}` | `ReelCard.tsx:138` | `EF-` is invented; `shortId` is 8 hex chars of a dash-stripped UUID4, so displayed IDs collide in practice and resolve to nothing. |
| **"Workers Active" with an `animate-ping` green dot** | `Header.tsx:77-85` | A hardcoded health indicator. Nothing polls `/health/`, `/ready/`, or `/api/v1/health/media-worker/`. It reads as a live heartbeat to an operator and will say "Workers Active" while every Celery worker is dead. The most operationally dangerous item in the app. |
| Hardcoded `v2.4` | `Header.tsx:38` | `package.json` says `"version": "0.0.0"`. Fiction that will silently drift. |
| Hardcoded `CREATOR` badge on **every** profile | `Profile.tsx:164-166` | No `is_creator` field, no backend concept of a creator tier. A user who has never uploaded is labelled a creator. |
| `followers_count \|\| 0` etc. after a swallowed error | `Profile.tsx:207/213/219/251` + `:70-72` | `catch { console.warn }` with no `setErrorMsg`. A failed request renders a **fully populated-looking profile with 0 0 0**, indistinguishable from a genuine empty profile. The most damaging failure *pattern* in the codebase. |
| `date_joined \|\| Date.now()` | `Profile.tsx:172` | On a missing field, renders today's date as the join date. |
| `{Math.max(15, likes + shares * 2)} Listens` | `Explore.tsx:159` | A synthesised listen count with a floor guaranteeing a plausible minimum. `FeedClip` has no listens field and no API returns one. |
| `PGVECTOR_384D`, "clustered by semantic embeddings" | `Explore.tsx:64/68/97` | The endpoint is a category filter with cosine ranking and an `engagement_velocity` fallback on error — there is no clustering, and the label is frequently wrong at runtime. |
| "Faster-Whisper… chroma vector extraction" and "Whisper-v3 Large" | `Upload.tsx:163`, `:274-275` | **All four model claims are wrong.** The backend is Whisper `base` and MFCC. `:163` says "chroma" while `:275` of the same file says "MFCC" — the file contradicts itself 112 lines apart. |
| Fake 2.5 s "processing" screen with `animate-pulse` | `Upload.tsx:125-127`, `:165-167` | A pulsing lie the user stares at before a hardcoded redirect. `clip_id` is received and never used to poll. |
| "Direct Stream URL Copied" | `ShareModal.tsx:110` | What was copied is `origin + "/?clip=" + id` — a dead deep link. |
| `Discussions ({comments.length})` | `CommentSheet.tsx:84` | The count of the **loaded page** (20), not `clip.comment_count`. `ReelCard:385` shows the real count, so the two disagree and the sheet is the wrong one. |

### 3.3 P2 — correctness bugs

| # | Finding | Location |
|---|---|---|
| 1 | **Enter double-submits login.** `onKeyDown` handler *plus* the native `<form>` submit. `e.preventDefault()` is called inside the synthetic handler and doesn't stop the native path. Two concurrent `POST /auth/login/` per press, against a 10/min/IP throttle. | `Login.tsx:221` |
| 2 | **Failed share delete removes the row anyway.** Optimistic removal, `catch { console.warn }`. Gone from the UI, still on the server, reappears on next mount. | `Inbox.tsx:59-64` |
| 3 | **`markRead` failure swallowed** after an optimistic flip — badge never clears, UI already says read. | `Inbox.tsx:44-46` |
| 4 | **`playClip(item.clip)` with no queue** from the Inbox — auto-advance jumps into the *feed's* queue. | `Inbox.tsx:52` |
| 5 | **`degraded` never set on the 202 cold-start path** — `:50` returns before `setIsDegraded`, so the banner can never show for a cold start. | `Feed.tsx:50` |
| 6 | **`setTimeout` never cleared on unmount** in the cold-start retry; navigating away fires `loadFeed` on an unmounted component. | `Feed.tsx:43-45` |
| 7 | **`hasMore={false}` hardcoded**, so the pagination observer never installs and the sentinel ref is assigned to nothing. | `Feed.tsx:163`; `ReelList.tsx:61-71`, `:121` |
| 8 | **`next`/`previous` unread in Explore** — `FeedCursorPagination` is page_size 10, so Explore can only ever show 10 clips. | `Explore.tsx:38` |
| 9 | **Non-current card's scrubber seeks the current clip.** The *label* is correctly guarded with `isActive && currentClip?.id === clip.id`; the *handler* is not. | `ReelCard.tsx:264` vs `:272` |
| 10 | **Like state never resyncs with props.** `useState(clip.is_liked)` / `useState(clip.likes)` are initial-only and cards are keyed by stable `clip.id`, so a feed refresh never updates the button or count. | `ReelCard.tsx:54-55` |
| 11 | **`playbackError` has zero consumers** — 3 occurrences, all in `player.tsx`. The entire 409/403/404 mapping and both `setPlaybackError` calls are dead code. | `player.tsx:16`, `:51`, `:372` |
| 12 | **409 sets a message and never retries**, despite the comment saying "retry". A clip that finished 2 s later never plays. | `player.tsx:223-231` |
| 13 | **The 401 case is documented but not implemented** — the comment promises four mappings, the code delivers three plus a default. | `player.tsx:220-231` |
| 14 | **Skip guard is incoherent:** `listen_duration_ms` and `reel_position_ms` are the same value; the 0.9 threshold contradicts the 0.99 completion path, so a 92 % manual skip is recorded as **neither** skip nor completion; `currentTime` is stale state, not a ref. | `player.tsx:331-336` |
| 15 | **Over-length file still accepted.** The 100 MB check `return`s without setting the file; the 300 s check sets an error *and then* calls `setFile`. No `audio.onerror`, so an undecodable file skips the duration check entirely. | `Upload.tsx:42-48`, `:30-33` |
| 16 | **Profile: delete refreshes counts, edit does not** → `uploads_count` goes stale after an edit. | `Profile.tsx:121` vs `:102-114` |
| 17 | **Clip edit has no `required`/`maxLength`** and the modal closes on failure, so clearing the title sends `title: ""` → 400 → `console.warn` → modal closes. Silent data loss. | `Profile.tsx:457-479` |
| 18 | **Replies render flat.** `parent` and `reply_count` are fetched but `parentId` is never passed and neither is rendered. | `CommentSheet.tsx:51`, `:139-148` |
| 19 | **`commentsAPI.updateComment` is dead code** — defined, never called. | `client.ts:332-337` |
| 20 | **`created_at` is returned by the API and never rendered** — a share inbox with no timestamps. | `Inbox.tsx`; `echoflow.ts:65` |
| 21 | **No 429 / `Retry-After` handling anywhere in the frontend.** Every telemetry call is `.catch(() => {})`, so 429s are fully silent. `getPlaybackToken` doesn't even capture headers. | all of `frontend/src` |
| 22 | **`handsFreeMode` is a switch that controls nothing** — it changes two labels and gates no behaviour. | `Header.tsx:88-101`; `Feed.tsx:136-139` |
| 23 | **Unread count has two sources of truth** — a local `shares.filter(!is_read).length` on the Inbox page and a 30 s global poll. | `Inbox.tsx:80`; `App.tsx:27` |
| 24 | **The 30 s poll runs before auth is established**, with an empty `catch {}`. | `App.tsx:34-38` |
| 25 | **The feed is drained on every interaction.** `GET /feed/` is a destructive `lpop` of 10; there is no client-side buffer, so re-requesting a page you already saw returns the *next* ten. | `AGENTS.md`; `Feed.tsx:34` |
| 26 | **Four unused imports** (`Header.tsx:2` ×4, `CommentSheet.tsx:2`, `Explore.tsx:21` dead prop) plus 44 non-colour arbitrary Tailwind values. | various |

### 3.4 P3 — design tokens

- **81 hex + 9 rgba** across 9 components. Only `ReelList` and `NetworkBanner` use `var(--…)` — the two files ported in `9af9bcf`. Every other component still hardcodes.
- `#FF6321` ×68, with **two different hover shades** (`#ff763a` in MiniPlayer/OnboardingModal, `#ff753b` in BottomNav/CommentSheet/ShareModal/Login/Upload).
- `App.tsx:62` hardcodes the palette on the root element, so **`[data-theme="light"]` in `tokens.css:90-112` can never apply** — the light theme is unreachable dead code. Either wire a theme toggle or delete it.
- `pb-safe` (`BottomNav.tsx:20`) is a **no-op class** — no safe-area plugin, no CSS rule. On notched iPhones the tab bar runs under the home indicator.
- `animate-in zoom-in-95 duration-150` on three modals is a no-op — no plugin, no such classes defined.
- 44 non-colour arbitrary values (`text-[10px]`, `min-h-[580px]`, `leading-[0.9]`, `blur-[120px]`…).

### 3.5 P4 — accessibility

**Baseline: 3 `aria-*` attributes in 1,626 lines.** No error boundary anywhere — a throw in `usePlayer` or `useAuth` unmounts the whole tree to a blank page.

| Finding | Location |
|---|---|
| The reel scrubber is a `<div onClick>` — no `role="slider"`, no `aria-valuenow`, **not keyboard operable at all**. Video scrubbing is a hard WCAG 2.1.1 requirement. | `ReelCard.tsx:267-286` |
| The entire card is a `<div onClick>` — not focusable, not a button, no `role`. | `ReelCard.tsx:127-129` |
| 9 icon-only buttons with no `aria-label`; `title=` used as the accessible name. | `ReelCard.tsx` ×8, `MiniPlayer.tsx:80-89` (the primary play/pause has **no name at all**) |
| Tap targets 24–40 px. Smallest in the app: ShareModal close at **24×24 px**. | `ShareModal.tsx:79-85`, `MiniPlayer.tsx:67-102`, `ReelCard.tsx:293-405` |
| All three modals: no `role="dialog"`, no `aria-modal`, no `aria-labelledby`, **no Escape-to-close**, no backdrop click, no focus trap, no focus restore, no body scroll lock. | `CommentSheet:74`, `ShareModal:69`, `OnboardingModal:58` |
| `focus:outline-none` with no replacement — a *deliberate deletion* of the browser focus ring. | `BottomNav.tsx:32` |
| 1 px border-colour focus rings fail WCAG 2.4.11/2.4.13 and are invisible on `#111111`. | `CommentSheet:191`, `ShareModal:127` |
| The comment composer has no `<label>` — placeholder only, which vanishes on focus. | `CommentSheet.tsx:186-192` |
| `ReelList`'s scroll container hides the scrollbar *and* removes the Firefox one, with **no keyboard scrollbar and no visible affordance** — a keyboard user cannot reach clip 2+. | `ReelList.tsx:110-113`; `tokens.css:209` |
| Nav tabs have no `aria-current`; the hands-free toggle has no `aria-pressed`; the unread badge reads as a bare number. | `Header.tsx:52-69`, `:88-101`, `:61-65` |
| Tag selection is a `<div>` checkbox, invisible to assistive tech; no `aria-pressed`. | `OnboardingModal.tsx:108-114` |
| `NetworkBanner` auto-dismisses at 2500 ms — a screen-reader user who looked away never learns they are offline, then sees a generic "Failed to load audio feed". WCAG 2.2.1. | `NetworkBanner.tsx:30-34` |

### 3.6 P5 — auth and session

- **No proactive refresh.** Tokens are 15 min; the only refresh trigger is a 401 *after* a request fails. A user watching a reel hits an unexpected logout.
- `isAuthenticated: !!user` is derived from a **cached user object**, never from token validity. No JWT `exp` decode anywhere.
- `refreshProfile` swallows 500, network and 401 identically. A dead refresh token produces an unhandled rejection with no user-facing message.
- **Event-listener ordering race** — `refreshProfile()` fires at `auth.tsx:48` before `addEventListener` at `:60`.
- Session expiry renders a bare `LoginPage` with no message and no return-to-previous-page.
- No CSP in `index.html`, and tokens are in `sessionStorage` (XSS-exposed).
- API base defaults to `http://localhost:18000` with no fail-fast guard — a silent dead port rather than a clear error.

### 3.7 P6 — build and infra

- Bundle: **922 kB (280 kB gzip), single chunk.** No `React.lazy`, no route splitting, no `Suspense`.
- No error boundary, no Sentry in the browser (`AGENTS.md`'s Sentry integration is Python-only, and `send_default_pii=False` means it would reject browser events anyway).

### 3.8 Documentation drift

`FRONTEND-REQUIREMENTS.md` is stale in **8 places** — it still reports these as broken when they are fixed, and the plan corrects them:

| Spec claim | Reality |
|---|---|
| FR-SHARE-4 "wrong method used" | Fixed — `client.ts:366-367` |
| FR-AUTH-4 logout "Missing" | Fixed — `client.ts:240` |
| FR-PROFILE-1 "calls getProfile even for own profile" | Fixed — `Profile.tsx:57` |
| FR-UPLOAD-2/3 "Missing" | Fixed — `Profile.tsx:102-125` |
| FR-UPLOAD-4 dead tag input | Removed in `9af9bcf` |
| FR-EXPLORE-2 dead search input | Removed in `9af9bcf` |
| "202/cold retry missing, triggers a poll storm" | Fixed — `Feed.tsx:37-51` |
| FR-TEL-2 "Missing" / "no heartbeat" | Fixed — `player.tsx:77-83` |

Two further corrections the plan makes to prior audit output, both verified:
- The 6 s heartbeat is **10/min against a 60/min budget** — comfortably within limits. Not a defect. The real pressure is the unthrottled per-pause `logTelemetry`.
- `docs/EXPLAIN/frontend/06-frontend-fix-plan.md` prescribes *"token-first with graceful fallback to direct HLS"* (`:20`, `:114`, `:338-346`, `:678`). That is now a guaranteed 403 and must not be implemented. `FRONTEND-REQUIREMENTS.md:1507` is the correct rule: on 401/403/404, do not attempt playback.

---

## 4. Backend changes

Three, all small, all prerequisites (D2). Each is independently testable.

### B1 — Bound the avatar upload (security, P0-6)

`backend/app/serializers.py`, `ProfileUpdateSerializer` (`:709-719`)

Add a `validate_profile_picture` mirroring the audio path's discipline: a `MAX_AVATAR_BYTES` (5 MB) check and an extension + magic-byte allowlist (`jpg`, `jpeg`, `png`, `webp`). Add a test asserting a 6 MB file 400s and a renamed `.exe` 400s.

*Why client-side validation is not enough:* `Profile.tsx:414` already *claims* a 5 MB limit and enforces nothing. The server is the only authority that cannot be bypassed.

### B2 — Expose follow state (correctness, P0-7)

`backend/app/serializers.py`, `FeedClipSerializer` (`:309-364`)

Add `is_following = serializers.SerializerMethodField()`, mirroring the existing `is_liked` pattern (`:313`, `:356-364`). `PublicProfileSerializer` (`:637-651`) and `OwnProfileSerializer` (`:659-674`) should gain it too, so the Profile page's follow button is honest.

*Why not just hide the button:* follow/unfollow is a real product action; hiding it removes a feature, and `POST /follow/{id}/toggle-follow/` already returns `{status: 'followed'|'unfollowed'}` — the data is one field away.

### B3 — Type `SubscriptionStatusSerializer.limits` correctly (prerequisite for Pro gating)

`backend/app/serializers.py:722-727`, `views/subscription.py:20-36`

No server change needed — a **client-side typing correction**. `_get_limits` puts ints and a bool into the Pro branch (`:26-28`) and strings into the free branch (`:32`, `:35`); DRF coerces everything to strings on output, so `hd_quality_allowed` arrives as `"True"`, not `true`. The client must type `limits` as `Record<string, string>` and parse explicitly.

---

## 5. Phases

Ordered by risk. Each phase is independently shippable and reviewable.

### Phase 0 — Foundation (gate everything else)

- Install **vitest**, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`; add `test` and `test:watch` scripts; add a `setupTests.ts` with a mocked `fetch`, a stubbed `Audio`, and a `IntersectionObserver` polyfill (the autoplay tests need it).
- Add `vitest.config.ts` with `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/setupTests.ts']`.
- Turn on **`strict: true`** in `tsconfig.json` and fix the fallout. Expect implicit-any errors concentrated in `client.ts` (the `apiRequest<T = any>` default) and the event handlers.
- Add a **top-level `ErrorBoundary`** around `MainContent` with a real recovery affordance, and an `aria-live` region for session events.

*Exit criteria:* `npm test` runs, `npm run lint` is 0 errors under `strict`, `npm run build` succeeds.

### Phase 1 — Data integrity and security (P0)

| Step | Change |
|---|---|
| 1.1 | **Delete `DEFAULT_PEERS`** (`ShareModal.tsx:17-22`) and the peer-list block (`:145-185`). Replace with the real, already-working `GET /share/find-user/?username=` flow — exact match, case-insensitive, returns `{id, username}` or 404. Debounce 500 ms (the spec claims this and the file does not do it). Distinguish 404 from 429/500 in the error message; today a throttled user is told the user does not exist. |
| 1.2 | **Measure watch time, not position** (P0-2). Replace `watchTimeRef`'s hardcoded `250` increment with a real elapsed-time accumulator driven from `timeupdate` deltas, clamped, and monotonic — never jumping on `seeking`/`seeked`. Delete the position-based `watch_time_ms` at all three sites. Add a test: seek to the end of a 10-minute clip and assert reported watch time is the *actually watched* seconds, not 600. |
| 1.3 | **Restore auto-advance** (P0-3). Read `currentClip` from `currentClipRef` inside `handleAutoAdvance`, or move the listener registration into an effect that depends on `currentClip`. **Remove exactly one of the two advance timers** — `player.tsx:175` (800 ms) or `ReelList:24` (1000 ms) — or the fix yields 1.8 s of dead air per clip. |
| 1.4 | **Fix the skip guard** (P2-14): `listen_duration_ms` = accumulated watch time, `reel_position_ms` = media position, and reconcile the 0.9 threshold with the 0.99 completion path so a 92 % manual skip is classified consistently. |
| 1.5 | **Dispatch `ef_session_expired` on the network-throw path** (P0-4) — one line — and add a "session expired" notice so the transition to `LoginPage` is not silent. |
| 1.6 | **Route `getPlaybackToken` through the 401 interceptor** (P0-5) while keeping `credentials: 'include'`, by adding an opt-in `withCredentials` flag to `apiRequest` rather than keeping a second fetch path. Capture response headers so `Retry-After` is readable. |
| 1.7 | **Bound the avatar upload** (B1). |
| 1.8 | **Expose `is_following`** (B2), then hydrate `ReelCard`'s follow button from it and make the optimistic update correct. Fix the inverted rollback ternary at `ReelCard.tsx:69,77` and surface the failure. |
| 1.9 | **Ask for the copyright acknowledgement** (P0-8): an unchecked-by-default checkbox with the licence text, plus `license_type` (from the server's `ChoiceField`) and `copyright_owner_name`. Currently every upload is logged as `license_type: "Unknown"` with a server-side warning. |
| 1.10 | **Cap HLS retries and re-mint on 403** (P0-9): bound `startLoad()` with exponential backoff and a ceiling, and on a fatal mid-playback error re-mint the token once before giving up. |
| 1.11 | **409 actually retries** — poll the token endpoint every ~5 s while the media is still processing, with a ceiling, and surface a spinner on the artwork meanwhile. |
| 1.12 | **Render `playbackError`** (P2-11). Wire the existing state to `ReelCard` and `MiniPlayer`; add the missing 401 branch so the code matches its own comment. |

*Exit criteria:* every P0 row has a test; no fabricated recipient can reach `send-share`; a seek cannot inflate `avg_completion_rate`.

### Phase 2 — Fabricated data (P1)

- Delete the vector, similarity, transcript, bitrate, fake-waveform and `EF-` id displays from `ReelCard` (`:116-119`, `:138`, `:210-212`, `:238`, `:244-253`). Show `tags` (real, already fetched) instead of the fabricated metadata.
- Replace "Workers Active" with a **real poll** of `GET /health/` and `GET /ready/`, showing the actual state. Add a `useBackendHealth` hook with a slow timer so it recovers after a transient outage (`FRONTEND-REQUIREMENTS.md §4.9`).
- Delete the hardcoded `v2.4`; read from `package.json` via Vite's `define`, or remove the badge.
- Delete the `CREATOR` badge. Replace `|| 0` stats with a skeleton while loading and an explicit error state on failure — **never a plausible zero**. Replace `date_joined || Date.now()` with an em dash.
- Delete the Explore "Listens" count and the `PGVECTOR_384D` / clustering copy. Render `duration_ms` and `tags` instead.
- Fix the Upload pipeline copy to be **accurate** (Whisper `base`, MFCC, 384-dim semantic) or delete it.
- Replace the fake 2.5 s processing screen with a **real poll** of `GET /clips/{id}/` through the pipeline to `ready`/`failed`/`rejected`.
- Fix the "Direct Stream URL Copied" label; fix `Discussions (N)` to use `clip.comment_count` plus real pagination.
- Render `created_at` on Inbox rows; make `Discussions` count and unread badge agree.

*Exit criteria:* no string in the UI asserts a measurement the client cannot make. Grep-able invariant: zero `Math.random()` in render, zero hardcoded metric strings.

### Phase 3 — Router and the A4 share flow (D3, D5)

- Add `react-router-dom`. Routes: `/` → feed, `/explore`, `/upload`, `/inbox`, `/profile/:userId?`, `/login`, `/clip/:id`, `/legal/*`. Route-level `React.lazy` + `Suspense` to split the 922 kB chunk.
- Replace the `useState` tab shell. Keep the `Header`/`BottomNav` chrome, driven by route rather than a parallel `activeTab` string — which also removes the two divergent hardcoded nav lists (`Header.tsx:16-21` has 4 entries, `BottomNav.tsx:11-17` has 5, and `profile` is missing from the header entirely).
- `ShareModal` becomes two distinct affordances, currently conflated:
  - **Own clips only:** `POST /clips/{id}/share-link/` → `{url, path, token, expires_in}`. Note `url` is null when `PUBLIC_APP_BASE_URL` is unset — use `path` and prefix it. **Never hand the share token to a player.**
  - **Any clip:** peer-to-peer `POST /share/{clip_id}/send-share/` via the `find-user` picker from 1.1.
- `/clip/:id` resolves the share token, renders `GET /clips/{id}/public/`'s `PublicClip` (which is deliberately minimal — no `hls_playlist_url`, no counters), and requires an explicit play click that calls `POST /clips/{id}/play/` to exchange the token for a 600 s media token. Do not auto-play on open.
- Fix `ShareModal`'s `copied` state leaking across modal opens (the `if (!isOpen) return null` guard is *after* the hooks, so `copied` persists and the first render after reopening can claim a copy that never happened).

*Exit criteria:* a copied link opens the right clip in a fresh tab; the share token is never attached to a player; the feed URL is shareable and back-button-safe.

### Phase 4 — Design token migration (D1, P3)

- **`#FF6321` → `--accent`.** Every hardcoded colour becomes a `var(--token)`. Case-insensitive: the brand colour has three spellings.
- Introduce semantic tokens for the repeated arbitrary values: type scale (`--text-micro` 9/10/11px, `--text-body` 13px, `--text-title` 20px, `--text-page` 28px), spacing (`--gutter-md` 16px, `--interaction-stack` 24px), radii, blur, easing, z-index (nav 200 < sheet 800 < toast 5000 < onboarding 7000 < netbanner 8000).
- Fix or delete the dead CSS: `pb-safe` (install a safe-area plugin or add real `env(safe-area-inset-bottom)` padding — this is an iPhone home-indicator bug), the three `animate-in zoom-in-95` modals, the dead `group` class.
- **Decide the light theme.** `App.tsx:62` hardcodes the root palette so `[data-theme="light"]` is unreachable. Either add a `ThemeProvider` + toggle (a real feature, ~40 LOC) or delete the light block from `tokens.css`. Leaving it is not an option — it is currently code that cannot execute.
- Then drop the three legacy font families from `index.html` once no component references them.

*Exit criteria:* zero hex literals in `frontend/src`; every colour resolves through a token.

### Phase 5 — Accessibility (P4)

- ReelCard: make the card and creator bar real `<button>`s; give the scrubber `role="slider"` with `aria-valuenow`/`min`/`max` and **arrow-key seeking**; `aria-label` all 9 icon buttons; `aria-hidden` on decorative waveform bars; one `h1` per page, not per card.
- A shared `<Sheet>` primitive (`role="dialog"`, `aria-modal`, labelled by its heading, Escape-to-close, backdrop click, focus trap, focus restore, body scroll lock) replacing the three hand-rolled modals.
- Real `<label htmlFor>` on every input; stop using placeholders as labels.
- Raise every tap target to ≥44 px; restore a visible `focus-visible` ring everywhere, and remove the `focus:outline-none` deletions.
- `aria-current="page"` on nav, `aria-pressed` on toggles, labelled unread badges.
- `ReelList`: restore a keyboard-reachable scroll path (the scrollbar is hidden on both engines with no replacement).
- `NetworkBanner`: make dismissal user-controlled, not a 2500 ms auto-expiry, and add a "back online" confirmation.

*Exit criteria:* every interactive element is reachable and operable by keyboard with a visible focus indicator and an accessible name.

### Phase 6 — Remaining correctness and cleanup (P2, P5, P6)

- All 26 P2 rows.
- Proactive token refresh on a timer at ~13 min (well inside the 15 min expiry) instead of waiting for a 401; decode the JWT `exp`; derive `isAuthenticated` from token validity, not a cached user.
- Move the `ef_session_expired` listener above the first `refreshProfile()` call to close the ordering race.
- Buffer `GET /feed/` client-side — it is a destructive `lpop` of 10, so re-requesting a page you already saw silently returns the *next* ten.
- Add a session-expiry notice and return-to-previous-page on the login redirect.
- `429` / `Retry-After` handling across the client, with telemetry 429s buffered rather than surfaced (§4.4 of the requirements doc).
- Either wire `handsFreeMode` to real behaviour or delete the switch.
- Single source of truth for the unread count.
- Add a CSP to `index.html`; fail fast on a missing/invalid `VITE_API_BASE_URL` instead of silently using `:18000`.
- Code-split via the Phase 3 routes; drop the four unused imports and the dead `Explore` prop.
- Add `frontend/src/api/client.ts` field-keyed error extraction for `category`, `license_type`, `copyright_acknowledgement` and `password`, not just `original_file`/`title`.

---

## 6. Architecture and data flow

### 6.1 Playback (corrected)

```
1. Feed returns a clip with hls_playlist_url
   → use VERBATIM. Never prefix the API base, never re-sign.
     (FRONTEND-REQUIREMENTS.md §4.7; docs/EXPLAIN/backend/07-media-urls.md)

2. POST /media/playback-token/{id}/
     Authorization: Bearer <access>      → via apiRequest (401 refresh applies)
     credentials: 'include'             → so the HttpOnly cookie is stored
   ← 200                    → proceed
   ← 409 still processing   → poll every ~5 s, ceiling, spinner on artwork
   ← 403 unmoderated        → tombstone
   ← 404 gone               → remove from cache
   ← 429                    → honour Retry-After

3. hls.js: xhrSetup → xhr.withCredentials = true
   (manifest AND every segment; cross-site in production)
   native/Safari: audio.crossOrigin = 'use-credentials'
   ('anonymous' will NOT send a cookie cross-origin)

4. On fatal NETWORK_ERROR: bounded backoff, then one token re-mint, then stop.
5. Playback error state renders on the card. There is NO direct-HLS fallback —
   the hls/ prefix is edge-validated, so the fallback can only 403.
```

### 6.2 Telemetry (corrected)

```
watch time = Σ real elapsed playback deltas, monotonic, seek-excluded
  ├─ never audio.currentTime (that is position, and it is exploitable:
  │  seek-to-end ⇒ completion_rate 1.0 ⇒ 30% of the rec score)
  ├─ 6 s heartbeat, action_type 'view', ≤10/min (budget 60/min)
  ├─ on pause and on ended: final value, but skip the pause caused by a
  │  clip switch so one view is not counted twice
  └─ failures are non-fatal AND not silent: log, surface in dev, never
     spam the user

manual skip:  listen_duration_ms = accumulated watch time
              reel_position_ms  = media position          (these must differ)
              threshold reconciled with the 0.99 completion path
```

### 6.3 Share (two distinct flows)

```
OWN clip  → POST /clips/{id}/share-link/   → {path, token, expires_in: 30d}
            → copy `${origin}${path}`
            → recipient opens /clip/:id  → renders GET /clips/{id}/public/
            → NOTHING is minted on open; an explicit play click calls
              POST /clips/{id}/play/ with the share token, which re-checks
              moderation + the NC/SA licence filter, then issues a normal
              600 s media token
            → the 30-day share token is NEVER attached to a player

ANY clip  → GET /share/find-user/?username=  (debounced 500 ms, exact match)
            → POST /share/{id}/send-share/   {receiver_id}
            → recipient's inbox
```

### 6.4 Auth and session

```
tokens in sessionStorage (ef_access_token / ef_refresh_token / ef_user)
  ├─ proactive refresh at ~13 min (access TTL is 15 min)
  ├─ 401 → single-flight refresh → replay once → on failure: clear +
  │         dispatch ef_session_expired  (BOTH paths, including network throw)
  └─ isAuthenticated derived from token validity, not a cached user
```

---

## 7. Test cases

Vitest + RTL. The first block is the regression net for the P0 fixes; each maps to a finding above.

**Playback / token**
- Token 200 → `xhrSetup` sets `withCredentials`; native path sets `crossOrigin = 'use-credentials'`.
- Token 409 → polls on an interval, resolves on a later 200, and never attempts playback before then.
- Token 403/404 → terminal, error state rendered on the card, **no HLS instance created**.
- Token 429 → honours `Retry-After`.
- Token request with an expired access token → refreshes and replays once.
- `hls_playlist_url` is used byte-for-byte; no string concatenation, no API-base prefix.
- Fatal `NETWORK_ERROR` → bounded retries, then one re-mint, then a terminal error.

**Telemetry**
- Seek to the end of a 10-minute clip after 2 s of playback → reported watch time ≈ 2 s, `completion_rate < 0.1`.
- A pause caused by a clip switch does not emit a second `logTelemetry`.
- Heartbeat interval is ≥ 5 s; total requests for a 60 s clip stay under the 60/min budget.
- Manual skip sends different `listen_duration_ms` and `reel_position_ms`.
- A 92 % manual skip is classified consistently against the completion path.

**Share**
- `DEFAULT_PEERS` is gone; no send can be issued without a `find-user` result.
- `find-user` 429 shows a throttle message, **not** "user not found".
- Own clip → `share-link`; the response `token` is never passed to the player.
- `/clip/:id` does not auto-play; playback requires the explicit play call.
- Closing and reopening the share modal does not show a stale "Copied" label.

**Follow / profile**
- Follow button reflects `is_following` on load; tapping it on an already-followed creator does not unfollow.
- A failed profile fetch renders an error state, **not** `0 0 0`.
- A failed clip delete leaves the row visible; a failed edit leaves the modal open with the error.
- Avatar > 5 MB is rejected client-side **and** server-side.

**Router**
- Each route renders and is directly linkable; back/forward preserve player state.
- `?clip=` / `/clip/:id` resolves to the right clip in a fresh tab.

**Upload**
- `copyright_acknowledgement` is only sent when the checkbox is ticked; the button is disabled until then.
- An over-length file is not added to state.
- An undecodable file surfaces an error rather than skipping the duration check.

**Generic**
- `ErrorBoundary` catches a throw from the player provider and renders a recovery affordance.
- Every interactive element has an accessible name; the scrubber is keyboard-operable.
- Feed 202 → retries honouring `retry_after_ms`, capped at 5, and `degraded` sets the banner.

---

## 8. Edge cases

| Scenario | Required behaviour |
|---|---|
| Token minted, then expires mid-clip | One re-mint on fatal error, then a terminal "unavailable" — never an infinite retry storm |
| Clip still processing (409) | Spinner, poll ~5 s with a ceiling; if it never resolves, "still processing" persists rather than a generic error |
| Unmoderated clip (403) | Tombstone; not retryable; not a network error |
| User seeks forward | Watch time does **not** jump; only real elapsed playback counts |
| User scrubs a non-current reel's bar | Ignored, or that reel is made current first — never seeks the wrong clip |
| Backend down | Honest "not reachable" state from a real poll; every fabricated indicator shows its unknown state rather than a healthy one |
| Session expires mid-reel | Playback stops with an explanation; login returns the user to the same clip |
| 429 on telemetry | Buffered, never surfaced to the user, oldest dropped |
| 429 on login | Cooldown timer honouring `Retry-After`; the button cannot be hammered |
| `register` with a future / >120-year `dob` | Rejected by the server; the picker's `max` is advisory only |
| Under-18 registration | `parent_email` required, mirrors the server rule, gate on `is_minor` not `minor_consent_verified` |
| Share link opened by a non-owner | `share-link` is owner-scoped; peers use `send-share` |
| Share token expired (30 d) | `play/` 404s → a clear "link expired" state |
| Public clip is unmoderated or NC/SA-licensed | `play/` re-checks and refuses — the client must not cache a grant |
| Re-registering a username (3/hour throttle) | 429 with `Retry-After`, not a generic failure |
| Empty feed after cold-start retries | An intentional empty state, not an accidental one |
| Screen reader user loses connectivity mid-session | Banner persists until dismissed, not auto-expired at 2.5 s |

---

## 9. Atomic commit plan

Each commit is independently reviewable and revertable. Backend changes land first — they are prerequisites.

| # | Commit | Contents |
|---|---|---|
| 1 | `test(frontend): vitest + RTL harness, strict mode on` | Test infra, setup file, `strict`, the fallout, `ErrorBoundary` |
| 2 | `fix(security): bound avatar upload size and MIME` | B1 + tests |
| 3 | `feat(api): expose is_following on clip and profile serializers` | B2 + tests |
| 4 | `fix(share): stop sending shares to fabricated user ids` | 1.1 + tests — **ship first, it is live data corruption** |
| 5 | `fix(telemetry): measure watch time, not media position` | 1.2, 1.4 + tests |
| 6 | `fix(player): restore auto-advance, surface playback errors, retry 409` | 1.3, 1.11, 1.12 — **removes exactly one advance timer** |
| 7 | `fix(auth): dispatch session-expired on every refresh failure` | 1.5 + test |
| 8 | `fix(api): route playback-token through the refresh interceptor` | 1.6 + test |
| 9 | `fix(player): cap hls retries, re-mint on 403` | 1.10 + tests |
| 10 | `fix(share): ask for copyright acknowledgement and licence fields` | 1.9 + tests |
| 11 | `fix(follow): hydrate follow state and fix optimistic rollback` | 1.8 + tests |
| 12 | `fix(ui): delete fabricated telemetry, wire real health polling` | Phase 2, all of it |
| 13 | `refactor(app): react-router, real URLs, route-level code splitting` | D3 |
| 14 | `feat(share): wire the A4 share-link flow for own clips` | D5 + tests |
| 15 | `refactor(ui): migrate to design tokens, adopt terracotta` | D1, Phase 4 |
| 16 | `feat(a11y): shared Sheet primitive, real labels, focus management` | Phase 5, first half |
| 17 | `fix(a11y): keyboard-operable scrubber, tap targets, focus rings` | Phase 5, second half |
| 18 | `fix(correctness): page-level bugs, 429 handling, session refresh` | Phase 6 |
| 19 | `docs: correct the stale status in FRONTEND-REQUIREMENTS.md` | §3.8 |

---

## 10. Not in scope

| Excluded | Why |
|---|---|
| `mobile/` | Work in progress under a separate agent. Untouched. |
| Native IAP | `mobile-rebuild-plan.md` D8 — RevenueCat excludes the target market; six backend defects are unresolved. |
| Follower / following lists | No backend endpoint. Would need a new viewset (a schema/API change beyond this plan's approval). |
| Search | Only exact-match `find-user` exists. A real search needs a new endpoint. |
| Offline telemetry queue | `docs/unfixed-issues-2026-09-03.md` P2.4, still open; out of scope. |
| Browser Sentry | `send_default_pii=False` means it would reject browser-source events anyway. |
| Code-splitting beyond routes | Follows from 13; revisit once route chunks exist. |

---

## 11. Verification

```bash
cd frontend
npm run lint                 # tsc --noEmit, strict
npm test                     # vitest
npm run build                # vite build — chunk count should rise after commit 13

# Backend, inside the web container
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --tb=short
docker compose exec web python manage.py makemigrations --check --dry-run
```

Before declaring any phase done, confirm the failure **set** is unchanged across ≥2 runs against a stashed
baseline — `AGENTS.md` records that single runs prove nothing here.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Deleting the fabricated telemetry leaves the feed looking empty | High | Medium | The card already has real data — `tags`, `duration_ms`, `creator_name`, `category`, real counters. Redesign the card to lead with those rather than padding with invented readouts. |
| `strict` produces a large error batch | High | Low | Contained to `client.ts` and event handlers; commit 1 isolates it so it is reviewable on its own. |
| Fixing the auto-advance creates double-advance | Medium | Medium | Commit 6 explicitly removes one of the two timers, and a test asserts exactly one advance per completion. |
| Watch-time change shifts recommendation rankings for existing users | High | Medium | Expected and desirable — the current numbers are seek-inflated. Expect `avg_completion_rate` to fall, which changes feed ordering. Flag to the owner before the sync task runs. |
| Avatar limit rejects images users have already uploaded | Low | Low | Only affects new uploads; no migration. |
| `is_following` adds a per-row query | Medium | Medium | Match the existing `is_liked` `SerializerMethodField` pattern and its query strategy rather than introducing a new access pattern. Measure before optimising. |
| Terracotta migration reads as a regression | Medium | Low | D1 is a deliberate design decision, not a bug fix. It is isolated in commit 15 so it can be reverted alone. |
| Router conversion breaks player continuity | Medium | High | The player is already hoisted to the app root above the tab switch; keep it above the router. Test back-button continuity explicitly (case 7 of §7). |
