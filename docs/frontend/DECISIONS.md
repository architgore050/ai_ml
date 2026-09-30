# Open decisions — raised by recon R1–R6 and the Wave 1/2 fix agents

Branch `feat/frontend-mvp`. Every item is a **decision**, not a bug: each was either deliberately deferred, or needs a product/owner call, or needs a migration I am not authorised to write. Ordered by consequence.

Status legend: **BLOCKS** something already shipped · **LIVE** reachable now · **DEFERRED** consciously.

---

## D1 — Case-insensitive username uniqueness · LIVE · needs a migration

**The read path is fixed (no more 500); the squatting primitive is not.**

`User.username` is `unique=True` on a **case-sensitive** column, while every lookup is `iexact`. So `alice` and `Alice` can coexist.

Three facts that make this worse than a single bug:

1. `RegisterSerializer` (`serializers.py:623`, `create()` at `:727-731`) stores the username **verbatim** — no `.lower()`, no `casefold()`. `grep -rn 'lower()|casefold()'` across `serializers.py`/`views/auth.py`/`views/profile.py`/`models.py` finds exactly two hits, both on a **file extension**.
2. **`ProfileUpdateSerializer.validate_username` (`serializers.py:932-936`) is the bigger primitive — it needs no registration at all.** `PATCH /profile/me/update/ {"username": "Alice"}` succeeds while `alice` exists, because the check is `filter(username=value).exists()` — case-sensitive `exact`. And `update_me` declares **no `throttle_scope`**, which under the `ScopedRateThrottle` rule means it is not scoped at all; only `UserRateThrottle` 1000/hour applies.
3. **`RegisterUsernameRateThrottle` (`throttling.py:185-193`) already lowercases its key**, with the comment *"a user who tries 'Alice' then 'alice' is one account fishing for a name."* The throttle treats case-insensitive identity as real; the model constraint and both serializers do not. That internal contradiction is the strongest argument that the constraint is the bug.

**Correction to RECON-05 §6:** it states `username` has no `UniqueValidator`. It does — DRF generates one because `model_field.unique` is True (`rest_framework/utils/field_mapping.py::get_unique_validators`). Its default `lookup` is `exact`, i.e. case-sensitive, so it does not catch this.

**What a real fix needs (all four, or it is half a fix):**
- `UniqueConstraint(Lower('username'))` on `User` + a migration.
- A **data migration** to resolve existing collisions. This is the blocker: colliding rows are two real accounts with data, and no automatic rule can pick a winner. **Needs an owner decision.**
- `UniqueValidator(lookup='iexact')` on `RegisterSerializer.username`.
- The same at `ProfileUpdateSerializer:932`.

I did **not** write the migration. It is a schema change plus irreversible data resolution.

---

## D2 — Content-Security-Policy absent on every origin · LIVE

Confirmed absent in `docker/nginx.conf`, `docker/nginx.local.conf`, `backend/EchoFlow/settings.py` (none of the 14 middlewares at `:137-154`), `workers/hls-token-worker/src/`, and `frontend/`.

The sharper framing: `docker/nginx.conf:108-111` and `nginx.local.conf:83-86` set HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY` and `Referrer-Policy`. **CSP is the only member of the standard set that is missing**, which makes it an omission rather than a policy choice.

It matters most on one surface: `GET /clips/{id}/public/` is the only HTML the API origin renders, `_render_share_card` (`content.py:43-77`) escapes every interpolation, and `og:url` is attacker-influenceable via `request.path`. Escaping is currently the only backstop and there is no second layer.

A real policy also spans the HLS Worker and the frontend origin, so it cannot be a single-file change. **Owner decision.**

Mitigating factor worth recording: `ef_hls_token` is `HttpOnly`+`Secure` (`media.py:256-283`), so a successful XSS could not exfiltrate the playback credential directly — only issue authenticated `fetch` calls. That is a smaller blast radius, and it is partly luck rather than design.

---

## D3 — `AuditLog`: one INSERT per request, `action` always `'view'`, no pruning · LIVE

Three related problems, all in `backend/EchoFlow/middleware.py`:

1. **Volume.** The `finally` block writes a row for *every* request: every `/metrics/` scrape (15 s), `/health/`, every 404, every 401, every static asset. At 1000 rps that is 1000 INSERTs/s into a table with **no pruning task anywhere** in the tree (no `flushexpiredtokens`, no retention job — confirmed by grep). Needs a sampling and/or exclusion policy, plus retention.
2. **`action='view'` is hardcoded** for every endpoint, so the column carries zero information for a CERT-In artefact. The choices already exist (`models.py:358-361`: view/create/update/login/register/delete) and nothing but the middleware writes the row. Fixing it needs a decided vocabulary — does `PATCH /clips/{id}/` log `view` or `update`? does a 404 log at all? — plus a view-level hook or response inspection. **Design decision.**
3. **Log-filter user id is still `-`.** `middleware.py:110-114` carries a self-documented `HACK`: audit identity is set *before* `AuthenticationMiddleware` runs, so the **log filter** records `user_id: '-'` even though the DB row is now correct. Retained intentionally for minimal change; flagged so nobody reads the logs as evidence.

Separately: `token_blacklist_outstanding_token` grows without bound. `ROTATE_REFRESH_TOKENS=True` + `BLACKLIST_AFTER_ROTATION=True` means every refresh inserts an `OutstandingToken` and a `BlacklistedToken`, and `check_blacklist()` JOINs tables that only grow. `flushexpiredtokens` appears **only in docs, never in a Beat entry, cron or management command**. This is load-bearing for "a stolen refresh token is single-use", so its silent degradation is worse than the row count.

---

## D4 — `is_noncommercial` / `requires_share_alike` are never derived from `license_type` · LIVE

The rights flags and the declared licence are **independent columns**. Nothing derives one from the other, so a human uploader can declare `CC-BY-NC` on audio that every feed, suggestion and profile listing then serves as commercial.

This is the load-bearing gap underneath the whole A3 licence gate: the gate is only as good as the flag, and the flag is self-declared and never reconciled with the licence text.

**Correction to the Wave-2 finding's premise:** I initially rated `PATCH /clips/{id}/` writing `license_type` as a redistribution bypass. It is not — those columns are absent from `AudioUploadSerializer.Meta.fields` and written only by the scraper uploader, so PATCH cannot move the flags at all. The real defect was silent rewriting of the declared licence and attribution on moderated content (audit integrity). Now refused with 409. **The derivation gap is the larger issue and remains open.** It is a schema/derivation decision: `serializers.py`/`models.py`, plus a decision about what happens to already-uploaded rows whose flags contradict their licence.

---

## D5 — `throttle_scope` missing on five viewsets · LIVE

`ScopedRateThrottle.allow_request` returns `True` — no accounting at all — when the view declares no `throttle_scope`. Verified in the installed DRF. So these five run at the default `user` 1000/hour only:

| Viewset | Why it matters |
|---|---|
| `FastFeedViewSet` | **A Celery task amplifier.** `GET /feed/` is a destructive `lpop`; an empty response publishes one `refill_user_feed` with `count=40`, **unconditionally, with no debounce**. 1000 accounts × 1000/hour = 1M `fast_feed` tasks/hour. The pathological loop is "call again before the worker runs", which is the cheapest possible request. |
| `SuggestionViewSet` | Runs a pgvector HNSW query plus a composite rerank per call, unscoped. |
| `TagsViewSet` | Input is now bounded, so this is defence in depth. |
| `ProfileViewSet` | `update_me` carries no scope — this is what leaves D1's rename primitive at 1000/hour. |
| `FollowViewSet` | Free, unscoped, unbounded graph write. `followers_count` is `Count(..., distinct=True)` recomputed on every profile read, so 1000 follows/hour/account is a free amplifier of the most expensive read in the profile path. |

The `feed.py` fix needs a **Redis `SETNX` debounce** (`feed:refill:requested:{user_id}`, ~30 s TTL) — a design change to a hot path, so it is a decision rather than a patch. `settings.py` is not mine to edit unilaterally.

---

## D6 — No GIN index on `AudioClip.tags` · DEFERRED

`pg_indexes` lists only pkey, status/category/creator btrees and the two HNSW vector indexes. Every `Q(tags__contains=[tag])` is therefore a sequential-scan containment check per row, so the `tags/initialize` cost scales with clauses × rows. A `GinIndex(fields=['tags'])` fixes the class of problem rather than capping one caller. It is a migration, so it is queued rather than done — the input bounds shipped first, which is the correct order (bound the caller, then index the column).

---

## D7 — Frontend contract changes that already landed and need a UI decision

Four behaviour changes shipped in Wave 1/2 and are **not** cosmetic. None is a bug; each needs its UI consequence decided.

1. **Upload now blocks at the server-advertised free-tier duration (60 s).** `views/subscription.py:33` advertises 60 s for free users, but `serializers.py:338` reads `MAX_DURATION_SECONDS` (300) for everyone, so the backend enforces nothing at 60 s. The Upload page displays the server's 60 s and **blocks at it**, so the displayed limit is not a lie. Consequence: this client is now the first enforcer of a limit the backend only advertises, and a free user who today can upload a 90 s clip is blocked. See `docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md`. **Ratify or relax.**
2. **`PATCH /clips/{id}/` returns 409 when `license_type` or `copyright_owner_name` changes on an approved clip.** The edit form must surface that as a field error on the licence input, or the user sees an unexplained save failure. Note the 409 rejects the **whole** request, including a title edit in the same payload — deliberate, because a partial apply leaves the client unable to tell which half landed and the half that landed is the dangerous one.
3. **`PATCH /clips/{id}/` now 400s if `copyright_acknowledgement` is sent as an explicit `false`.** Absent is fine; `false` is not. The edit form must not send the field as a default `false`.
4. **`GET /share/find-user/` now returns 409 on a case collision.** `ShareModal.tsx` handles 404/429/400 and falls through to a generic message, so 409 is *safe* but not *informative*. It needs a 409 branch.

---

## D8 — `types/echoflow.ts` lies in both directions · DEFERRED

- `OwnProfile.email` is typed non-optional `string`, but `OwnProfileSerializer.Meta.fields` (`serializers.py:766-785`) has **no `email`**. So `tsc` was clean while `Profile.tsx` rendered a line that could never display, and `auth.tsx:36` persisted `email: undefined` into `sessionStorage`. The render is removed; the type is not fixed.
- `PublicProfile` omits `is_following`, which the serializer **does** send (`serializers.py:741`). There is no follow button on the profile page at all — so `serializers.py:757-764`'s comment, *"the Profile page has its own follow button hitting the same blind toggle"*, describes a UI that does not exist. That is the `CORS_URLS_REGEX` / `ErrorBoundary.tsx:28` failure class again: a comment describing absent code.

Both are one-line type changes in a file no agent currently owns.

---

## D9 — `uploads_count` counts rows the listing withholds · DEFERRED

`views/profile.py:22-27` and `:46-53` count `uploads_count` over **all** `audio_clips`, while `/profile/{id}/clips/` now filters `status='ready' AND moderation_approved AND not NC AND not SA`. So a user with 3 failed or NC uploads sees a total the listing contradicts. The count-vs-list inconsistency is pre-existing and is not a row-content leak, so it was deliberately preserved and pinned by a test rather than changed. Fixing it means deciding what "uploads" means — all attempts, or published reels.

---

## D10 — Enumeration surfaces · owner call, unchanged from FIX-PLAN §9

- `GET /share/find-user/` → 200 `{id, username}` vs 404, `share_poll` 1000/hour from any free account. **`share_poll` at 1000/hour is sized for inbox polling every 3.6 s (`social.py:101-102`); a directory search does not need it.** Lowering it means editing `settings.py:787`.
- `GET /profile/{id}/` returns profiles for `is_active=False` and `is_staff=True` accounts. Public profiles are a product feature, so this needs a filter decision, not a patch.
- `POST /legal/takedown/` → 404 vs 201 for any clip UUID, unauthenticated, 30/hour. **I left this open deliberately:** IT Rules R3(1)(b)/(2) oblige us to receive and categorise every complaint, and `TakedownRequest.clip` is `on_delete=CASCADE`, so a takedown naming a deleted clip may be the only surviving record that anyone complained. A fake 201 for a non-existent clip records nothing — the "fix" would destroy the complaint. Documented at `legal.py:189-210` so the 404 is not read as an oversight. The cheap version is also defeated trivially: anyone who can read a public feed already has clip UUIDs. The real control is R5-12 verification plus a per-address cap.

---

## D11 — `is_noncommercial` set before the check that can clear it · DEFERRED

`moderation_approved=True` is written **before** the check that can clear it, and `public_view` trusts the flag alone. So unmoderated metadata is public for the duration of the Whisper window. Small window, but it is a real ordering bug. The Wave-2 fix moved `public_view` to 404 for anything not fully servable, which closes the *listing* half; the flag-ordering half is in `content_moderation.py` and was not touched.

---

## D12 — Small items, no decision needed, listed so they are not lost

- `serializers.py:405` — `validated_data.setdefault('copyright_acknowledgement', validated_data.get('copyright_acknowledgement', False))` is a self-referential no-op. Dead but harmless.
- `content.py:16` — `TakedownRequest` imported, never used in that file.
- `fetchMock.ts:4-7` claims `apiRequest` extracts `Retry-After`; it does not, and `tooManyRequests()` has zero call sites. Queued for the `client.ts` pass.
- `test_auth_regulatory.py:32` uses `password: 'testpass'`, now rejected as common. The test still passes (it asserts 400 for missing consent) but the fixture is misleading.
- Modals do not close on backdrop click. Deliberate, not a defect.
- No global `unhandledrejection` handler; Sentry is Python-only, so a browser reporting destination is a decision (see FIX-PLAN §9.4).
- The HLS cookie is `HttpOnly`, so a web client **cannot** proactively refresh the playback token — `04-hls-token-protection.md:275-278` prescribes something unimplementable. Queued for the doc sweep.
