# FIX-PLAN — reconciled from RECON-01 … RECON-06

Branch: `feat/frontend-mvp` (includes `feat/mobile-reel-and-verify` via fast-forward `af966dd`).
Baselines to protect: **716 backend pass / 0 fail / 7 skipped** · **48 frontend pass** · `tsc --noEmit` clean · `vite build` clean.

Every finding below is grep-verified with a `file:line` in the recon reports. **The prior audit `docs/frontend_rebuild_plan.md` is treated as unreliable** — the six recons disproved 20+ of its claims (§7).

---

## 1. The partition rule

**Partition by FILE, never by feature.** Every finding is assigned to exactly one owning file. An agent owns that file exclusively and fixes *all* confirmed findings in it (data truthfulness + error resilience + accessibility). Splitting by concern would put two agents in one file; that is the only unrecoverable failure mode here.

**Hub files are single-owner and sequential, never parallel:** `client.ts`, `player.tsx`, `App.tsx`.

**Order of attack:**
1. Stop the lies + stop the corruption (frontend, per-file, parallel).
2. Stop the abuse (backend, per-file).
3. The two hubs + shared primitives.
4. The share-link bypass.

---

## 2. Wave 1 — frontend, one agent per file (all disjoint, run in parallel)

| # | File | Agent brief | Findings |
|---|---|---|---|
| 1 | `components/sharing/ShareModal.tsx` | `share-modal` | R3#1 (CRITICAL `DEFAULT_PEERS`), R3#2, R4 F9/F13/F14/F15, R6#2/#10, a11y #6 |
| 2 | `components/feed/ReelCard.tsx` | `reel-card` | R3#3/#4/#15/#16, R4 F17, R6#4/#8/#11, a11y #1/#4/#5, 60 fps bars |
| 3 | `pages/Profile.tsx` | `profile` | R3#8/#9/#10/#18/#19/#24/#26/#27, R4 F2/F16, R6#7, a11y #2/#9 |
| 4 | `pages/Explore.tsx` | `explore` | R3#14/#25, R4 F22/F10, R6#5, headings |
| 5 | `pages/Inbox.tsx` | `inbox` | R3#20, R4 F16, R6#6 |
| 6 | `components/comments/CommentSheet.tsx` | `comment-sheet` | R3#11/#12/#13/#30/#31, R4 F3/F4, R6#3, tap targets |
| 7 | `pages/Upload.tsx` | `upload` | R3#5/#6/#7, R4 F1/F26, **R6#1 (CRITICAL: file input unreachable)** |
| 8 | `pages/Login.tsx` | `login` | R6#2 (`htmlFor`=0 app-wide), autocomplete, 5× `focus:outline-none`, unnamed password toggle |

**All eight may run concurrently. No shared file. No DB access needed (vitest only).**

### Decisions taken (so agents do not block)
- **F1 / upload:** call `POST /clips/{id}/approve-moderation/` after the 202. `views/content.py:249-256` documents owner self-approval as the current v1 workflow, so this is not a new privilege. Then poll `GET /clips/{id}/` and render `processing → ready | failed` honestly. A creator loop that silently does nothing is not shippable.
- **Upload limits:** read the real values from `GET /subscription/` (`views/subscription.py` already returns them) instead of hardcoding Pro limits.
- **`DEFAULT_PEERS`:** delete. There is no peer/suggestion endpoint in the codebase; the honest state is a search prompt. Do **not** add a "recent recipients" call — that would need a backend endpoint that does not exist.
- **Fabricated telemetry strip:** delete, and substitute real values the API already sends (`tags`, `duration_ms`). Do **not** add a new backend field in Wave 1.
- **`handsFreeMode`:** gate the three advance paths on it. (Wave 3 — `player.tsx` / `ReelList.tsx` / `Feed.tsx` — not Wave 1.)

---

## 3. Wave 2 — backend abuse & authorization, one agent per file

| # | File | Finding | Severity |
|---|---|---|---|
| 9 | `app/views/profile.py` | R5 R5-01 — `GET /profile/{id}/clips/` is the **only** clip-listing endpoint with no `moderation_approved` and no NC/SA filter. Leaks NC/SA + pre-moderation metadata incl. `hls_playlist_url`. Every other path (`feed.py:111,115,135,183`, `social.py:166,394`) has both. | **High** |
| 10 | `app/views/interactions.py` | R5 R5-02 — `queryset = AudioClip.objects.all()`. Write-IDOR: `register-skip` / `log-telemetry` / `toggle-like` write to **any** clip UUID, including `moderation_approved=False` ones invisible in every feed → ranking poisoning of 30% + 25% of the composite. | **High** |
| 11 | `EchoFlow/middleware.py` | R5 R5-05 — `X-Request-ID` is not truncated to `AuditLog.correlation_id` (`varchar(64)`); the insert is wrapped in `except: pass`. **An attacker can suppress the audit record for any request with one header.** CERT-In artefact integrity. | **High** |
| 12 | `app/views/feed.py` (TagsViewSet only) | R5 R5-04 — `selected_tags` untyped and unbounded → 50 000 OR'd JSONB conditions (repeatable 30 s DB stall, bounded by `statement_timeout`); `int` input → 500. | **High** |
| 13 | `app/views/legal.py` + `app/views/grievance.py` | R5 R5-06 — unauthenticated **500s**: `AudioClip.objects.get(id=<non-uuid>)` raises uncaught `ValidationError`; over-length `subject` (varchar 200) and `user_email` (varchar 254) raise `StringDataRightTruncation`. Remote 500 per request + error oracle. | **High** |
| 14 | `app/views/social.py` (find_user only) | R5 R5-07 — `get(username__iexact=…)` on a **case-sensitive** unique column; only `DoesNotExist` caught → `MultipleObjectsReturned` 500. Username-squatting primitive. | **High** |
| 15 | `app/serializers.py` (RegisterSerializer only) | R2 A-2 — `AUTH_PASSWORD_VALIDATORS` is configured (`settings.py:466-481`) but `validate_password` is **never called**. Registration accepts `"123"`. | **High** |

**Sequencing:** these are disjoint files, but they share one Postgres test DB. Run at most **two** backend agents concurrently, each restricted to its own test file, and expect table-exists/lock contention noise — re-run serially before believing a failure. I run the full suite after Wave 2.

**Do not touch in Wave 2** (deferred, listed with reasoning in the recon reports): the `KEYS` blocking call in `flush_counters_to_pg` (R5-09), the `GET /feed/` Celery-publish amplifier (R5 §7.2 — needs a Redis debounce design), audit-log volume (R5 §7.5), `find_user` enumeration UX (owner decision), `page=999999` deep offsets (already bounded by `statement_timeout`), and the RevenueCat webhook (inert).

---

## 4. Wave 3 — the hubs + primitives (sequential, never parallel)

| # | File | Work |
|---|---|---|
| 16 | `api/client.ts` | R4 groundwork: attach `retryAfter` from `response.headers`; record `error.status`; NETWORK/OFFLINE discriminator. Then narrow `!res.ok` to 401/400 (R2/R4 F5) and dispatch `ef_session_expired` on the network-throw path (F6). Then `REQUEST_TIMEOUT_MS` + `AbortController` (F8). **Must preserve** the 202 passthrough, the single-flight mutex, `credentials:"include"`, and the fact that `SessionNotice` is mounted *outside* the `isAuthenticated` conditional. Also: `src/test/fetchMock.ts:4-7` claims a `Retry-After` extraction that does not exist — fix the comment in the same commit. |
| 17 | `stores/player.tsx` | R1: memoize the player context (kills the 60 Hz full-subtree rerender); reset `currentTime`/state per clip; **delete** the player-owned auto-advance and leave `ReelList`'s scroll as sole driver (fixing only the stale closure would create a skip machine); change `watch_time_ms` to a **cumulative watched-time accumulator** (see below); render `playbackError`; gate `handsFreeMode`. |
| 18 | `styles/tokens.css` | R6 primitives: `.tap-target` utility wiring the dead `--tap-target: 64px` token to ~25 controls at once; a global `focus-visible` rule replacing the 11 remaining `focus:outline-none`; a `prefers-reduced-motion` block; replace the 72 `text-white/30|40` occurrences with token-backed values that pass AA. |
| 19 | `components/feed/ReelList.tsx` + `pages/Feed.tsx` | R4 F11/F12/F23/F24: real `hasMore` from `next`; clear the cold-queue `setTimeout`; decrement the frozen countdown; surface refresh errors **alongside** retained clips; gate auto-advance on `handsFreeMode`. |
| 20 | `App.tsx` | R4 F19 (global `unhandledrejection`), F23, R6 nav landmark/`aria-current`/page title, and the `?clip=` bootstrap. |

### `watch_time_ms` — decided, do not re-litigate
The client is the only witness; the server can bound the rate but never verify honesty. The current bug is that the client sends **media position** while the server divides it by duration. Fix: accumulate `delta = now - lastTick`, clamped to the tick interval, into a per-clip `watchedMs`, and send `watch_time_ms = watchedMs`. That is seek-proof (seeking does not inflate it), monotone, and keeps the existing backend contract's intent — `completion_rate = watched/duration` becomes exactly right instead of the current 0.1–1.0 inflation. **No backend change, no contract rename.** The residual "client can under-report" limitation is inherent and is documented, not engineered around.

---

## 5. Wave 4 — the share-link bypass

`ShareModal` copies `${origin}/?clip=${id}` and **nothing reads `?clip=`**. `App.tsx` is a `useState("feed")` tab shell with no query parsing, so every shared link opens the generic feed. A full React Router migration touches `App.tsx` + all 6 pages and risks player continuity (the feed is remounted on every tab switch, which re-`lpop`s 10 clips). For an MVP the bypass is a ~15-line mount handler in `App.tsx`: parse `?clip=`, find it in the loaded feed, else fetch it, and deep-link. **Decision: bypass the router.** Revisit only if the bypass cannot be made to preserve playback.

---

## 6. Verification I run myself, after every wave

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npx vite build
docker compose -f docker-compose.local.yml --env-file .env.local exec -T \
  -e PYTHONPATH=/app web_local pytest backend/app/tests/ -q --tb=short
```
Plus: `docker ps` for `Restarting` **before** trusting any result; compare failure **sets** across two runs rather than totals; every new test was watched red before its fix.

**Commit discipline:** agents do not commit. I review, verify, and commit explicit paths only. Never `git add -A`, `git stash`, `git checkout -- .`, `git reset --hard` — another agent's uncommitted `mobile/` work is in the working tree. Never touch `mobile/` or `docs/mobile/`.

---

## 7. What the recon disproved (do not "fix" these)

Recorded so no later agent resurrects a wrong premise:

1. `docs/frontend_rebuild_plan.md:68` "a real `transcript` field exists" — **false**. `grep transcript models.py serializers.py` → 0 hits. The worker computes it locally and discards it. Deleting the UI is the MVP fix; a real transcript needs a new column.
2. `frontend_rebuild_plan.md:69` "`HLS_BUCKETS` is server-side config" — **false**. It is a Prometheus histogram bucket tuple in seconds (`metrics.py:132`).
3. `frontend_rebuild_plan.md:58` "there is no `is_following` anywhere" — **fixed** in `c9405ae`; 8 tests pin it.
4. `frontend_rebuild_plan.md:89` "failed share delete removes the row anyway" — **false**. `Inbox.tsx:58-61` removes only after the await succeeds.
5. `frontend_rebuild_plan.md:111` "the 30 s poll runs before auth is established" — **false**. It is inside `MainContent`, which renders only when authenticated.
6. `frontend_rebuild_plan.md:126` "no error boundary anywhere" — **stale**. `4ed5cf5` added one.
7. `ErrorBoundary.tsx:28-30` "sits inside the providers" — **factually inverted**; it is outermost.
8. `src/test/fetchMock.ts:4-7` "`Retry-After` extraction" — **does not exist**; `tooManyRequests()` has zero call sites.
9. `serializers.py:757-764` "the Profile page has its own follow button" — **no follow button on `Profile.tsx` exists.**
10. R2's "proactive refresh causes logout" — **zero** user impact; the 401 refresh-replay already covers it.
11. R2's "event-listener ordering race" — **cannot exist**; `client.ts:64-89` initialises the mutex synchronously before any consumer can fire.
12. R2's "login double-submit" — **does not happen**; `e.preventDefault()` at `Login.tsx:41` cancels implicit submission (flagged low-confidence, not asserted).
13. "Fix the stale closure in `handleAutoAdvance`" — **insufficient**. `nextClip` has its own stale closure; a `currentClip` ref alone does not fix it, and fixing only the player path creates a skip machine because `ReelList` already advances.
14. "Polling fixes the 409" — **wrong**. `FastFeedViewSet` does not filter `status='ready'`, so the feed genuinely serves unencoded clips. Fix the queryset.
15. "avg_completion_rate is 30% and telemetry reaches it" — **wrong under default config**: `log-telemetry` returns early on the stream path and never touches it. Only `register-skip` writes it.
16. `04-hls-token-protection.md:275-278` prescribes proactive web refresh — **unimplementable**, the cookie is `HttpOnly`.
17. `FRONTEND-REQUIREMENTS.md` prescribes: media-position telemetry (`:285-286`, `:1229-1234`), localStorage tokens (`:1415`), a specific mutex (`:1426-1437`), only 200/401 error branches (`:1689-1700`), and the `ReelList` advance (`:880-890`). **Three separate specs currently instruct the bugs** — correct each doc in the same commit as its code.

---

## 8. Docs to correct in the same commit as their code

| Doc | Lines | Says |
|---|---|---|
| `docs/FRONTEND-REQUIREMENTS.md` | 547-554 | `RegisterSerializer` validates the password — it does not |
| " | 1415 | store tokens in `localStorage` — `sessionStorage` is the deliberate choice |
| " | 1426-1437 | a specific refresh-mutex design |
| " | 1689-1700 | error handling branches only on 200/401 |
| " | 285-286, 1229-1234 | telemetry sends media position as watch time |
| " | 880-890, 1100 | auto-advance, with no stop control |
| " | 1689-1700 | 409 has no client handling |
| `docs/EXPLAIN/storage/04-hls-token-protection.md` | 275-278 | the web client can proactively refresh the token |
| `docs/EXPLAIN/backend/06-auth-permissions.md` | 343-352 | says the two things that *work* are broken |
| `docs/frontend_rebuild_plan.md` | throughout | superseded by the six recon reports |
| `backend/app/serializers.py` (comment) | 757-764 | a Profile-page follow button that does not exist |
| `frontend/src/test/fetchMock.ts` | 4-8 | `Retry-After` extraction that does not exist |
| `frontend/src/components/common/ErrorBoundary.tsx` | 28-30 | inverted boundary-placement claim |
| `docker/nginx.conf` | 170 | says the `hls/` bucket is public-read (false) |
| `docker/nginx/hls_auth.js` | — | a 19-line stub that `docker-compose.yml:618` describes as gating `:9443` |
| `SECURITY.md` | Known Mitigations | claims emails are Fernet-encrypted at rest; the field was removed |

---

## 9. Open decisions for the owner (not blocking Wave 1–2)

1. **Multi-tab session destruction** — `ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION` + `sessionStorage` (per-tab) + a per-tab mutex means opening a second tab logs out every other tab within 15 minutes, guaranteed. Options: a server-side grace window (recommended) or `localStorage` + `BroadcastChannel` (contradicts `FRONTEND-REQUIREMENTS.md:1415`).
2. **`find_user` enumeration** — username + primary key, 1000/hour, any free account. Is username+PK disclosure acceptable for share-by-name?
3. **Free-tier duration/HD limits** are advertised by `GET /subscription/` but enforced nowhere (`docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md`).
4. **A global `unhandledrejection` reporting destination** — Sentry is Python-only; browser events are not wired.
5. **CSP** — absent on every origin, and the API origin serves rendered HTML at `/clips/{id}/public/`.
