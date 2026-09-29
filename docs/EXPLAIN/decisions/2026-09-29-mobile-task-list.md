# Mobile Rebuild — Executable Task List

**Status:** awaiting approval to start Phase 1. Nothing in `mobile/` has been touched.

Derived from `docs/mobile-rebuild-plan.md` §8–§17 (Parts 2), `docs/FRONTEND-REQUIREMENTS.md`,
and the three decision records. Backend prerequisites from the same branch are **complete** —
§17 is fully closed, so no phase is blocked on backend work.

Read the source sections before starting each phase; the references below are
pointers, not substitutes. Where this document and a source doc disagree, the
source doc wins and this file gets corrected.

---

## 0. Preconditions — verify before writing app code

| # | Item | Why | Ref |
|---|---|---|---|
| 0.1 | Confirm branch `feat/mobile-rebuild` is clean and pushed | 9 backend commits are unpushed; mobile work must not sit on top of unpushed backend work | `git log` |
| 0.2 | Confirm backend suite baseline: **530 passed / 37 failed / 6 skipped** | The 37 are the documented pre-existing set. Any *new* failure is yours | plan §"Verification commands" |
| 0.3 | Re-run the 2-run baseline comparison before you change anything | A single run proves nothing about regressions — the failure *set* drifts | plan §I8 |
| 0.4 | Read `mobile/src` once end-to-end before deleting it | The salvage list captures *patterns* worth keeping. Do not go in blind | plan §20 salvage list |
| 0.5 | Extract the design tokens from `sample_frontend2/src/styles/globals.css` + `tailwind.config.js` into a scratch file | This is the single source for `src/design/tokens.ts`; §13 has the already-extracted values | plan §13 |
| 0.6 | Confirm `sample_frontend2` is **gitignored** | It is a local scratch copy and cannot be committed. Do not "fix" it and expect it to ship | `.gitignore:26` |

> **0.6 is a trap I already hit once.** During the backend work I edited
> `sample_frontend2/src/api/client.ts` to fix registration, then discovered the
> whole directory is untracked. Those edits are local-only. The tracked
> frontend is `frontend/src`. Do not build the design source's fixes into the
> plan on the assumption they are committable.

---

## 1. Phase 0 — Remove the old tree

Single commit, in place, on this branch. Git preserves history.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 1.1 | `git rm -r mobile/src` | 13 files, 3,200 LOC. Deleting in its own commit keeps the diff readable | plan §8 "Decision" |
| 1.2 | `git rm mobile/App.tsx mobile/index.js` | `App.tsx` navigation has no stacks, no linking, no param typing, no error boundary, no auth gate | plan §20 discard column |
| 1.3 | Remove 7 unused deps from `mobile/package.json` | `expo-linear-gradient`, `expo-constants`, `react-native-reanimated`, `react-native-gesture-handler`, `react-native-svg`, `expo-asset`, `@react-navigation/native-stack` | plan §8 "Structural" |
| 1.4 | Remove `expo-av` entirely | **Removed in Expo SDK 55.** Replaced by `expo-audio` (D2) | plan §8, D2 |
| 1.5 | Delete `mobile/dist/` | Build output, untracked | — |
| 1.6 | Keep `mobile/package.json`, rewrite it in Phase 1 | It declares the bundle IDs and scheme worth salvaging | plan §20 |

**Exit criteria:** `git status` clean; `mobile/` contains only `package.json` + config stubs.

---

## 2. Phase 1 — Scaffold + auth

Gate: nothing (backend is clear). Ships a launchable shell with a working auth loop.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 2.1 | `npx create-expo-app` at **SDK 57** (owner-approved 2026-09-29) | Not 55: `latest` is 57.0.25 (`sdk-56` 56.0.22, `sdk-55` 55.0.31) and the old app is on **52.0.37** (`package.json:17`), so this is a 3-major scaffold, not an upgrade. `expo-audio` is at `57.0.5`. **Install every dep with `npx expo install`** — hand-written ranges drift from the SDK's compatible set | plan D1 (amended), detail §5 O1 |
| 2.2 | Confirm CNG: no committed `ios/` or `android/` | `expo prebuild` generates them at build time so no native project rots | plan D1 |
| 2.3 | Generate `assets/`: icon, splash, adaptive-icon, notification icon | The old `app.json` references all three and **none exist**, so every build failed. This is not optional | plan §8 "Structural" |
| 2.4 | `app.config.ts` (not `app.json`) | Needed for `EXPO_PUBLIC_API_BASE_URL` per EAS profile | plan D9, §14 |
| 2.5 | Carry over from old `app.json`: bundle IDs `com.echoflow.audio`, `scheme: "echoflow"`, `UIBackgroundModes: audio` | Salvage list says keep these | plan §20 |
| 2.6 | Add `expo-audio` + its background-playback config plugin | D2: it wires `AudioControlsService` (Android MediaSessionService) and `UIBackgroundMode: audio` (iOS) automatically | plan D2 |
| 2.7 | Add `expo-secure-store`; tokens to Keychain/Keystore | **Not MMKV** — D4 explicitly rules MMKV out for tokens | plan D4 |
| 2.8 | `src/design/tokens.ts` — port the value table in detail §6 verbatim | `surface.bright` is **resolved: `#38393c`** (`globals.css:11`), a 6th ramp step above `#333537`. `tailwind.config.js:15` says `#282a2c` (= `container-high`) and is wrong — comment the override so nobody "fixes" it back. The system is ~20 values, and it is the contract — not the rendered output | plan §13, D6; detail §5 O3 |
| 2.9 | `src/design/shadows.ts` with `Platform.select` | **Glow does not work on Android.** iOS: `shadowColor`/`shadowOpacity`/`shadowRadius` + `shadowOffset:{0,0}`. Android: fall back to `expo-linear-gradient` glow rings on hero elements only (create FAB, liked heart) and drop the rest. Documented degradation, not hidden | plan §13 "Known porting problem" |
| 2.10 | Do **not** port: CRT `scan-line`, `Math.random()` waveform, `alert()` in comment handlers, the light/dark segmented control, the Settings theme bug, the 16 catalogued design-extraction defects | §13 "Deliberately not ported" | plan §13 |
| 2.11 | Drop the dot-matrix `radial-gradient` overlay | No RN equivalent. Dropping is the honest MVP call | plan §13 |
| 2.12 | `src/api/client.ts` — port `apiFetch`'s single-flight `refreshPromise` mutex, then rewrite the base URL and add `AbortController` timeouts, `204` handling, structured errors, `skipAuth`, 429 backoff | The mutex is the one genuinely correct thing in the old client. **Keep the pattern, not the code** — the old `data.refresh \|\| tokens.refresh` (`api.ts:100`) is a fallback that can never fire while `ROTATE_REFRESH_TOKENS` is on, and would resurrect a blacklisted token if rotation were ever disabled. Require `data.refresh` | plan §20 keep column; `settings.py:776-777` |
| 2.13 | Base URL = **https only**. Default was `http://localhost:8005` | D9: that is the plaintext escape hatch `AGENTS.md` says to drop. `EXPO_PUBLIC_API_BASE_URL` per EAS profile | plan D9 |
| 2.14 | `src/api/schema.ts` — zod schemas for **all four** response envelopes | PageNumber `{count,next,previous,results}` · Cursor `{next,previous,results}` (no `count`) · hand-rolled `{"results":…}` whose `next` is the **string literal** `"auto_trigger"` · **bare top-level array** (`/share/inbox/`). `GET /feed/` can return **202** with `retry_after_ms`. `SubscriptionStatusSerializer.limits` is `DictField(child=CharField)` so **every value arrives as a string**, including `max_clip_duration_seconds: "60"` | D5 — parse once at the boundary | plan D5 |
| 2.15 | `app/(auth)/register.tsx` — send **`consent_accepted`, `terms_version`, `dob`**, and `parent_email` if under 18 | `dob` is **required** (was optional, so omission bypassed the DPDP §9 age gate). `terms_version` must be valid against the server's list | `FRONTEND-REQUIREMENTS.md` AUTH; plan §12 Auth |
| 2.16 | `register` does **not** return tokens — follow up with a second `login` call | The response is `201 User (no tokens)`; this is by design | `FRONTEND-REQUIREMENTS.md` §9 |
| 2.17 | Fetch `current_terms_version` from `GET /legal/compliance/` at registration screen mount | Do **not** hardcode `v1.0`. The list is now published; hardcoding 400s the day a version is appended | `FRONTEND-REQUIREMENTS.md` AUTH; plan §17 B6 ✅ |
| 2.18 | `consent_accepted` checkbox **unchecked by default** | The old app had `useState(true)` — pre-ticked consent, a DPDP §11 defect | plan §8 defect 8, §20 discard |
| 2.19 | Age gate in the form: if computed age < 18, show the guardian-email field and explain why | Backend sets `is_minor=True` and then **403s telemetry** for that user. Say so in the UI | plan §12, §17 ✅ row |
| 2.20 | Login → `SecureStore` for access + refresh; logout → `POST /auth/logout/` (blacklists refresh) | Logout is the one backend capability with no consumer in any client | `FRONTEND-REQUIREMENTS.md` §8 |
| 2.21 | Silent session restore on cold start; proactive refresh at 13 min (15-min lifetime) | + explicit "session expired" signal; 401 replay-once | plan §12 Auth |
| 2.22 | Refresh throttle is keyed on the **verified token subject**, not IP, at `120/hour` | A sustained mobile client refreshes ~4×/hour/user. Do not reintroduce IP keying client-side. Related: the **7-day** `REFRESH_TOKEN_LIFETIME` is the real session boundary and needs its own signed-out path, distinct from a 401 | `docs/EXPLAIN/auth/04-rate-limiting.md`; plan §4; `settings.py:770-771` |
| 2.26 | **Registration UX must respect `register_username` = 3/hour per username** | `RegisterView` (`views/auth.py:47`) runs `register` 200/hour **per IP** *and* `register_username` **3/hour per username**. Three typos of the same handle locks that username out for an hour with no recovery. Do not submit on blur/keystroke; name the username as the likely cause when a 429 arrives. `login` is separately 10/min/IP (credential stuffing) — a 429 there must read as "wait", not "wrong password" | `views/auth.py:47`; `urls.py:29`; `settings.py` `DEFAULT_THROTTLE_RATES` |
| 2.23 | Error boundary at the **navigator root** | The old `App.tsx` had none | plan §20 discard |
| 2.24 | Route groups `app/(auth)/` vs `app/(tabs)/` via expo-router | D3: fixes structurally what the old app declared (`scheme: "echoflow"`) and never implemented | plan D3 |
| 2.25 | `useBackendStatus` on a **30 s** timer, not mount-only | Current implementation checks once; the banner then never recovers from a transient outage | `FRONTEND-REQUIREMENTS.md` §4.9 |

**Exit criteria:** a fresh install can register → land in `(tabs)` → logout → re-login. `tsc --noEmit` clean.

---

## 3. Phase 2 — Feed shell + player core

Gate: Phase 1. This is the phase that proves the media transport.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 3.1 | `src/store/player.ts` owns **one** `useAudioPlayer`, created **once at app root** | The old app's most expensive error: the player was owned by the card, so it unmounted with the view | plan §10 "Player placement", §14 |
| 3.2 | Player state in the store: queue, `activeIndex`, `loadGeneration`, `handsFree` | Zustand owns client state only; TanStack Query owns server reads | plan D4, §14 |
| 3.3 | `usePlaybackToken.ts` — in-memory `Map<clipId,{token,expiresAt}>`; TTL 600s; **refresh under 120s remaining** | Scope is per-clip, so one token serves exactly one clip. Do not share across clips | plan §10 "Token cache" |
| 3.4 | **Prefetch the next clip's token** on `activeIndex` change | The endpoint is cheap (300/min scoped); the alternative is a stall on swipe | plan §10 "Token cache" |
| 3.5 | `POST /media/playback-token/{id}/` with `Authorization: Bearer` **and** `X-EchoFlow-Client: native` | **POST, not GET** — minting a credential must not be a safe/prefetchable/cacheable method. GET returns 405 with a message telling you to use POST | plan §10 step 2; `FRONTEND-REQUIREMENTS.md` |
| 3.6 | Read `token` from the response body and pass it to the player as `headers: { 'X-EchoFlow-Media-Token': token }` | `expo-audio` applies headers to the manifest **and every segment**, on the native stack, where the cookie would never have travelled | plan §10 step 3, D2 |
| 3.7 | **No cookies anywhere in the app.** Do not read, store, or forward `ef_hls_token` | The header travels on the native stack where it matters; the fetch cookie jar is irrelevant | plan §10 "No cookies anywhere" |
| 3.8 | Use `clip.hls_playlist_url` **verbatim**. Never rebuild it, never prefix the API base | Both existing clients got this wrong: the storage origin carries a port and the edge is a different host | `FRONTEND-REQUIREMENTS.md` §4.7; `AGENTS.md` |
| 3.9 | Error mapping — 5 distinct branches, not one generic failure | `409` → still processing, spinner on artwork, retry in 5 s · `403` → unavailable/removed tombstone (also a moderation rejection) · `404` → gone · `200`+`token` → play · network failure → keep last good state, show `NetworkBanner` | plan §11 |
| 3.10 | `loadGeneration` race guard — discard a load whose generation is stale | The old app has no guard, so a slow load can resolve after a fast one and win | plan §10 "Race guard" |
| 3.11 | `useFeedBuffer.ts` — accumulate pages into a capped (**60**) deduped buffer | **`GET /feed/` is a destructive `lpop`.** Never re-request a consumed page | plan §14 |
| 3.12 | On `202`/degraded, fall back to `/suggestions/?category=all` and honour `retry_after_ms` (server hint, 1500 ms default) | The cold-retry is server-driven; do not invent your own backoff | `FRONTEND-REQUIREMENTS.md` §4.8; plan §12 Feed |
| 3.13 | Vertical snap reels; autoplay at **70 % viewability**; **1000 ms** inter-reel pause | Pacing value is a token in §13 | plan §12 Feed, §13 |
| 3.14 | Ambient orbs, 40-bar decorative waveform (deterministic, **not** `Math.random()`) | The old app re-rolled `Math.random()` every render | plan §12, §13 |
| 3.15 | Telemetry in this phase: **no** `registerSkip` yet | Defect 2 — listening to the end incremented the skip counter and corrupted `avg_completion_rate`. Ship play, add telemetry in Phase 3 | plan §8 defect 2 |

**Exit criteria:** one clip plays end-to-end in a simulator with a real token, and scrubbing works.

---

## 4. Phase 3 — Feed interactions

Gate: Phase 2.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 4.1 | `useWatchTelemetry.ts` — 5 s heartbeat derived from `player.currentTime` | **Not wall-clock.** Pauses, buffering and failed loads all corrupted the old measurement | plan §8 defect 6, §14 |
| 4.2 | Completion guard: send `registerSkip` **only** when `position < duration × 0.9` **and** the transition was user-initiated | The single most expensive defect. Natural completion must not count as a skip | plan §14, §16 |
| 4.3 | Flush telemetry on pause / skip / background / unmount | — | plan §12 |
| 4.4 | 1-per-5 s send cap; **drop-oldest** on 429; re-queue rather than spam | `telemetry` is throttled at 60/min — a sustained 1 Hz client starts 429ing after ~60 s | `FRONTEND-REQUIREMENTS.md` §4 telemetry |
| 4.5 | `403` from `log-telemetry` means the account is a minor | The backend now refuses telemetry for `is_minor`. Surface it, do not retry | plan §17 ✅ row; `AGENTS.md` age-gate note |
| 4.6 | Like: optimistic + rollback, haptics, ripple; re-anchor to the server's `data.status` on 200 | POST twice in the same state does **not** re-toggle — the server is authoritative | `FRONTEND-REQUIREMENTS.md` §6.2 |
| 4.7 | Double-tap-to-like with heart burst; port from `frontend/src` | The web code reserves the slot but its pause branch is an **empty block** — port the idea, not the bug | plan §13 "Ported from frontend/src" |
| 4.8 | CommentSheet: list (cursor envelope), post, **reply** (`parent`), edit own, delete own | All four are backend capabilities with **no client consumer**. Delete is a `DELETE`; edit is `PATCH` | `FRONTEND-REQUIREMENTS.md` §8 |
| 4.9 | Comment list parses the **cursor** envelope `{next, previous, results}` — **no `count`** | Four envelopes coexist; this is the second one | plan D5 |
| 4.10 | Comment authors are tappable — `Comment.author_id` now exists | Backend gap closed in this branch | plan §17 B7 ✅; `FRONTEND-REQUIREMENTS.md` §8 |
| 4.11 | ShareModal: `find-user` debounce → `send-share` | `/share/find-user/?username=X` → `{id, username}` \| 404 | `FRONTEND-REQUIREMENTS.md` §10 |
| 4.12 | `mark-read` is **POST**, not PATCH | The existing clients send PATCH to a POST-only route | `FRONTEND-REQUIREMENTS.md` §9 |
| 4.13 | Follow/unfollow is **POST** | The old `toggleFollow` sent GET to a POST-only route → 405, never noticed because never called | plan §8 defect 5 |
| 4.14 | Seekable progress bar + timecode + ±10 s skip + hands-free auto-advance toggle | The old app had a progress bar with **no seek UI** | plan §12 Feed |
| 4.15 | ±10 s uses `RotateCw`/`RotateCcw`, not `SkipForward`/`SkipBack` | Semantically wrong icon in the web source | plan §13 |
| 4.16 | Tag chips on the card — `tags` and `duration_ms` are now on `FeedClipSerializer` | Backend gap closed; `duration_ms` makes the scrubber exact instead of derived | plan §17 B5 ✅ |
| 4.17 | Share *link* (not in-app send) uses the new pipeline | `POST /clips/{id}/share-link/` (owner) → `GET /clips/{id}/public/` → `POST /clips/{id}/play/?s=`. **Exchange the share token for a media token; do not hand the 30 d token to a player** | `docs/EXPLAIN/decisions/2026-09-29-share-pipeline.md` |

**Exit criteria:** like/comment/share/follow all persist; telemetry produces correct `registerSkip` semantics.

---

## 5. Phase 4 — Explore, Profile, Inbox

Gate: Phase 3.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 5.1 | Explore: category pills, paged `/suggestions/?category=X`, pull-to-refresh, empty/error states | — | plan §12 |
| 5.2 | Remove free-text search | **No search endpoint exists** | `FRONTEND-REQUIREMENTS.md` §9 |
| 5.3 | Profile (own): avatar upload via `PATCH /profile/me/update/`, counts, liked clips | — | plan §12 |
| 5.4 | `profile_picture` is a **relative storage key** (`avatars/…`) | Prefixing the API base is wrong for production. Treat as absolute-if-`http`, else it needs a backend signed URL — flag, do not silently build a wrong URL | `FRONTEND-REQUIREMENTS.md` §4.7 |
| 5.5 | Own profile `liked_clips` uses `getMyProfile()` when `targetId === user.id` | The existing app used the public path for your own profile | `FRONTEND-REQUIREMENTS.md` §11.5 |
| 5.6 | Profile (public): follow/unfollow + their clips | — | plan §12 |
| 5.7 | **No follower/following drill-down** | No backend endpoint. Remove the "Followers N" stat link or leave it inert | `FRONTEND-REQUIREMENTS.md` §8, §9 |
| 5.8 | Inbox: share list, **30 s** unread poll, mark-read, play a shared clip full-screen | 30 s is within the `share_poll` 1000/hr budget | `FRONTEND-REQUIREMENTS.md` §4.8 |
| 5.9 | `/share/inbox/` returns a **bare top-level array**, not an envelope | Envelope #4. zod must accept it | plan D5 |

**Exit criteria:** all three tabs navigate and their primary action round-trips.

---

## 6. Phase 5 — Upload

Gate: Phase 3.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 6.1 | Record via `expo-audio`, or pick from library | — | plan §12 |
| 6.2 | `RecordingPresets.HIGH_QUALITY` → `.m4a` / AAC / 44.1 kHz / stereo / 128 kbps | Salvage-list approved: backend-compatible (`ALLOWED_EXT`), ffmpeg-friendly, matches the free-tier bitrate | plan §20 |
| 6.3 | `Audio.setAudioModeAsync({ playsInSilentMode, interruptionMode: 'duckOthers', shouldPlayInBackground, allowsRecording })` | **CORRECTED 2026-09-29** — the salvage list named the expo-av keys (`playsInSilentModeIOS`, `staysActiveInBackground`, `shouldDuckAndroid`) and none exist in expo-audio. Verified against `expo-audio@57.0.5` `Audio.types.d.ts`. Note `shouldDuckAndroid` (boolean) becomes `interruptionMode` (a string union), and recording is now explicit | plan §20 |
| 6.4 | Live level meter | `isMeteringEnabled` is already on in the old app and **unused** | plan §12 |
| 6.5 | Pre-validate duration against `MAX_DURATION_SECONDS = 300` (and the free-tier 60 s cap) | Avoids a round-trip 400. The 300 s bound IS server-enforced (pydub probe in `AudioUploadSerializer.validate_original_file`); the **60 s free cap is not** — `_enforce_free_limits` checks file size only, so the client is the only place it exists | `FRONTEND-REQUIREMENTS.md` §8; plan D8 |
| 6.6 | Title / category / `license_type` / `copyright_owner_name` / copyright acknowledgement | Corrected: only **`copyright_acknowledgement` is `required=True`** (`serializers.py:165`); `license_type` is `required=False` defaulting to `"Unknown"`, and `copyright_owner_name` is `required=False, allow_null`. So the old app's 400 was the missing acknowledgement, not the licensing fields. Make the picker **mandatory in the UI anyway** — `"Unknown"` triggers `logger.warning("Upload with Unknown license type — audit trail required.")` (`serializers.py:186-190`), so the server is asking for an audit trail and Copyright Act 1957 is a real question. Note `category` is free text (`models.py:112`), so O2 governs which vocabulary ships | `serializers.py:154-190`; plan §17 B8 ✅ |
| 6.7 | Acknowledgement checkbox **unchecked by default** | DPDP §11 affirmative consent | plan §8 defect 8 |
| 6.8 | Upload with **progress** via `XMLHttpRequest.upload.onprogress` + cancel | `fetch` gives no upload progress | plan §12 |
| 6.9 | Then `POST /clips/{id}/approve-moderation/` | This is the **only** trigger for HLS processing. `finalize_upload` deliberately does not enqueue — the task would immediately skip on `moderation_approved=False` | plan §17 B4; `backend/app/services/uploads.py` |
| 6.10 | Poll `GET /clips/{id}/` through the 4-stage pipeline to `ready`/`failed`/`rejected`; local notification on completion | Only `ready` clips appear in lists; a `processing` clip is invisible everywhere | `FRONTEND-REQUIREMENTS.md` §6.1 |
| 6.11 | Do **not** send `tags` on upload | The backend ignores it | `FRONTEND-REQUIREMENTS.md` §9 |
| 6.12 | `report_reason` is **required** and validated; `content` must be non-empty | Repeats append to the existing report and return `duplicate: true` | `FRONTEND-REQUIREMENTS.md` report; plan §17 B8 ✅ |
| 6.13 | Daily free cap is 5 uploads; hard stop before the round trip | `AudioUploadViewSet.create` checks it before serializer validation | plan D8 |
| 6.14 | My-clips list | A just-uploaded clip takes ~5–60 s to appear. Do not expect it instantly | `FRONTEND-REQUIREMENTS.md` §6.1 |

**Exit criteria:** record → upload with progress → approve → poll → ready → clip plays in the feed.

---

## 7. Phase 6 — Settings, Legal, Pro gating, Sentry

Gate: Phase 4.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 7.1 | Theme control (dark-only at MVP, `userInterfaceStyle: "dark"`). Tokens already carry light | — | plan §12 "out" |
| 7.2 | `GET /subscription/` → `is_pro` + limits; **every `limits` value is a string** | `"max_clip_duration_seconds": "60"` — coerce explicitly | plan D5 |
| 7.3 | Soft-enforce the free cap client-side; "Upgrade" opens the **web** customer portal | D8: **no native IAP in the MVP.** RevenueCat excludes India, plus 6 backend defects (`revenuecat_app_user_id` unexposed, `product_id` can never match, `user.uuid` → 500 on `/subscription/manage/`, sync is fire-and-forget) | plan D8 |
| 7.4 | Manual sync `POST /subscription/sync/` — rate-limited to 10/hour, and it is fire-and-forget | No completion signal exists; do not poll for a result | plan D8; `FRONTEND-REQUIREMENTS.md` §8 |
| 7.5 | Compliance / Grievance / Nodal officers + **physical address** | All now on `GET /legal/compliance/`, plus `terms_versions`, `current_terms_version`, `privacy_version` | plan §17 B6 ✅; IT Rules 2021 R4(1) |
| 7.6 | Grievance form → `POST /grievance/` | — | plan §12 |
| 7.7 | Data-access summary → `GET /data-subject/access/` | Returns **counts**, not a full export | plan §12 |
| 7.8 | **Erase account** → `POST /data-subject/erasure/` with `confirm: true` | Apple and Google both mandate in-app deletion. Two-stage: first call opens a **30-day cooling-off** and returns `pending`; a later call returns `in_progress` and schedules a Celery task. **The endpoint never returns `completed` synchronously** — do not render "your data is deleted" on either response | plan §12; `backend/app/services/erasure.py` |
| 7.9 | Sentry init; `send_default_pii=False` means no browser source maps will be accepted | — | `AGENTS.md` Sentry; `FRONTEND-REQUIREMENTS.md` §8 |
| 7.10 | Accessibility: **≥44 pt iOS / ≥48 dp Android** on every control, plus `accessibilityRole`, `accessibilityLabel`, `hitSlop` on icon-only | The web declares `--tap-target: 64px` and violates it everywhere (a bare `<X size={20}/>` ≈ 20 pt) | plan §13 "Accessibility" |

**Exit criteria:** every Settings row has a real backend behaviour; the erase flow is honest about timing.

---

## 8. Phase 7 — Distribution, E2E, CI

Gate: Phase 6.

| # | Task | Precision detail | Ref |
|---|---|---|---|
| 8.1 | `eas.json` with `development` / `preview` / `production` | Per-profile `EXPO_PUBLIC_API_BASE_URL`, `runtimeVersion` | plan §15 "Distribution" |
| 8.2 | `eas update` channels | A JS-only fix must ship without App Store review | plan §15 |
| 8.3 | Note: EAS Build free tier will not carry production | — | plan §15 |
| 8.4 | Store metadata | — | plan §15 |
| 8.5 | Jest: `useWatchTelemetry` completion guard | Defect 2 — the costliest bug | plan §16 |
| 8.6 | Jest: `client.ts` refresh rotation, 401 replay, 429 backoff | — | plan §16 |
| 8.7 | Jest: `useFeedBuffer` dedupe + 202 handling | Defect 3 | plan §16 |
| 8.8 | Jest: zod parsing of all four envelopes + string-typed `limits` | — | plan §16 |
| 8.9 | Maestro — **3 flows only**: register→onboard→play · like+comment+share · record→upload→status→ready | — | plan §16 |
| 8.10 | **No component snapshot tests.** The tokens are the contract, not the rendered output | — | plan §16 |
| 8.11 | CI: typecheck + jest + Maestro on PR | — | plan §15 |

**Exit criteria:** `eas build --profile preview` produces an installable binary.

---

## 9. Blocked / out of scope — do not attempt in the MVP

| Item | Why | Ref |
|---|---|---|
| Server-side push | No `POST /devices/register/`. Local notifications only | plan §12 "out" |
| Native IAP | D8 | plan D8 |
| Saved / Library | No backend entity | plan §12 |
| Full-text search | No endpoint | `FRONTEND-REQUIREMENTS.md` §9 |
| Follower / following lists | No endpoint | `FRONTEND-REQUIREMENTS.md` §8 |
| Universal-link web pages | Needs a Cloudflare Pages route; no web frontend is deployed | plan §12 "out"; share-pipeline decision record |
| Light theme | Tokens ship it; dark-only at MVP | plan §12 "out" |
| Tablet layout | `supportsTablet: false` | plan §12 "out" |
| Glow on Android | No native equivalent. Documented degradation, not a bug to chase | plan §13 |
| Real audio-reactive visualizer | v1.1. MVP uses a deterministic pseudo-reactive envelope on the UI thread via Reanimated | plan §13 |
| Now Playing screen, playback speed, swipe-to-dismiss | v1.1 | plan §12 v1.1 |

---

## 10. Open question that must be settled during Phase 1

**There is no phone dev loop (plan §I9).** Two blockers, neither handled by
`docs/EXPLAIN/storage/05-local-hls-worker-runbook.md`:

1. **URLs.** `docker-compose.local.yml` hardcodes
   `PUBLIC_HLS_ENDPOINT_URL=https://localhost:19443`. On a phone, `localhost`
   is the phone. A device needs `https://<LAN-IP>:19443` (HLS) and
   `https://<LAN-IP>:18443` (API). These are per-machine, so they belong in
   `.env.local` as literals — **compose does not expand `${...}` inside an env
   file.**
2. **Certificate.** `docker/certs/localhost.crt` SANs are
   `localhost, minio, web, nginx, 127.0.0.1, 0.0.0.0`. A LAN IP is not
   covered; iOS ATS rejects and Android shows an interstitial.

**Owner decision already taken: certificate setup stays manual and documented,
not committed** — `AGENTS.md` flags the committed dev key as a hazard, so a
second committed cert was declined. The runbook section is the deliverable.

**Consequence to state plainly:** until this is solved, only an **iOS
simulator** or **Android emulator** can exercise playback (`10.0.2.2` for the
emulator). A physical device is needed before any claim about real-device
playback is made. Simulator verification is not a substitute and should not be
reported as one.

---

## 11. Per-phase definition of done

Applies to every phase without exception:

1. One atomic commit per phase (plan §15).
2. `tsc --noEmit` clean.
3. Jest suite green.
4. Backend suite re-run **twice**, failure **sets** compared against the
   37-failure baseline — the count drifts, the set must not grow (plan §I8).
5. Any new backend defect found while building the app gets a row in
   `docs/mobile-rebuild-plan.md` §17 before it is worked around, not after.
6. Contracts this document cites are re-read at the start of the phase that
   uses them. The backend changed materially during the prerequisite work and
   a stale plan line is worse than no plan line.
