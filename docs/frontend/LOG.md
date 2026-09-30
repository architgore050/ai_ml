# Frontend completion — execution log

Plan: `docs/frontend/FIX-PLAN.md` (reconciled from six recon reports).
Branch **`feat/frontend-mvp`**. Recon: `docs/frontend/RECON-01..06`.
Open owner decisions: **`docs/frontend/DECISIONS.md`** (D1–D12).

**Everything below is done and committed.** Agents never commit; they leave
changes in the tree and report, and I review, verify, and commit explicit paths.

---

## Baselines — how they moved, and why each move is a different number

| Point | Frontend | Backend | Cause |
|---|---|---|---|
| Start of pass | 24 | 716 pass / 0 fail / 7 skip | measured |
| End of Wave 1 | **240** | 716 (unchanged) | 8 per-file frontend agents |
| End of Wave 2 | 240 | **992** | 7 backend authorization agents |
| End of Wave 3 (primitives) | **322** | 992 | `client.ts` + a11y primitives |
| End of Wave 3 (final wave) | **418** | 992 | `player.tsx`, feed, `App.tsx` |
| Final | **418** | **1255** pass / 0 fail / 7 skip / 2 xfail | concurrent agent's backend work committed alongside |

**716 is no longer a valid regression target** — it predates my own `AuditLog`
fix, which is what invalidated 20 `assertNumQueries` assertions (see below).
992 was the right target for the frontend-final wave; 1255 is HEAD.

---

## The three things that actually went wrong, and what they cost

### 1. My own fix broke 20 tests
`c12f16b` corrected `AuditLog` being written as `user=<int>` into a ForeignKey
(raising `ValueError` on every authenticated request, swallowed — so the audit
table recorded anonymous traffic and nothing else). Fixing it made the write
real, which put one INSERT per request inside every query-count budget.

I could have raised the budgets. That would have destroyed the property
`test_tags_initialize_bounds.py` exists to pin: `assertNumQueries(0)` is the
structural proof that a rejected 50 000-tag payload never reaches the ORM.
Instead `conftest.assert_view_queries` counts, then subtracts the audit write,
so the expected numbers never moved. Verified by two controls — the raw
assertion sees exactly 1, and a wrong budget still fails while naming the
exclusion.

### 2. Six recon reports disproved the audit more often than they confirmed it
`docs/frontend/RECON-01..06` recorded **17 disconfirmations** of
`frontend_rebuild_plan.md`, including: a `transcript` field that does not exist,
`HLS_BUCKETS` misidentified as bitrate config, a "broken" share-delete rollback
that was already correct, a poll that "runs before auth" and cannot, and an
`ErrorBoundary` comment claiming it sits inside the providers when it is
outermost. Three separate specs currently *prescribe* the bugs; those
corrections are in `FIX-PLAN.md` §8.

### 3. A green suite is not evidence; a stale premise is worse than a red one
Three times this pass, the honest move was to change a **test**, not the code —
and twice the premise had been voided by a *different* commit:

- `AuditLog` was never written, so no test could see it.
- `test_a_licence_change_on_an_unapproved_clip_still_works` asserted the world
  where `license_type` was advisory. Once `create()` began deriving the rights
  flags from it, that premise died and the **guard** was right.
- `test_the_rights_flags_are_not_writable_through_the_api` carried a docstring
  asserting the flags were "written only by the scraper uploader" — also voided
  by the same change.

Both were rewritten to pin the *new* invariant, and proved non-vacuous by
stubbing the mechanism in throwaway plugins so the tests go red.

---

## What each wave fixed

**Wave 1 — 8 agents, one per file, all disjoint, run in parallel.**
Partitioning by *file* rather than by feature was the constraint that made
parallel work safe. `client.ts`, `player.tsx` and `App.tsx` were held back as
single-owner sequential.
Highest-value findings: `ShareModal` hardcoded four "Network Peers" carrying
**real User primary keys** (1–4), so tapping Stream wrote `ShareEvent` rows and
unread inbox items for actual strangers; `Upload`'s success screen claimed a
four-stage pipeline that never ran, because `approve-moderation` is the only
enqueue trigger and the client never called it; `Profile` rendered today's date
as the join date on any failed fetch; a failed comment load rendered "No comments
yet — be the first", inviting duplicate comments on a thread with 340.
Verified: 48 → 240, tsc clean, build clean.

**Wave 2 — 7 backend agents.** Four live authorization holes: the profile clip
listing was the only clip-listing endpoint without a moderation or licence
filter; `ClipInteractionViewSet.queryset = AudioClip.objects.all()` was a
write-IDOR that also poisoned the ranking model; the `AuditLog` FK bug; and
`X-Request-ID` was unbounded into a `varchar(64)`, so one unauthenticated
header permanently suppressed the CERT-In record for any request. Then
registration accepted `password: "123"` (`AUTH_PASSWORD_VALIDATORS` configured
and never called), `PATCH /clips/{id}/` always 400'd, and `public_view` leaked
NC/SA metadata. Verified: 716 → 992.

**Wave 3 — 5 agents, two stages.** Stage one: `client.ts` treated *any* non-OK
refresh response as session expiry, so a 502 signed everyone out; the
network-throw path never dispatched `ef_session_expired`, leaving a zombie app;
`Retry-After` was exposed by the backend and read nowhere; no request timeout
existed anywhere. Plus a11y primitives — desktop had **no** nav landmark, the
avatar button was announced as the user's own username, the honest health
verdict was inside `hidden lg:flex` so phones had no health signal at all.
Stage two: the player re-rendered the whole feed **60×/second even paused**;
per-clip state was never reset, so a stale progress field re-minted a token
until `playback_token` (300/min) was exhausted and every later play 429'd;
`watch_time_ms` was media *position* feeding 30% of the ranking score; and
`?clip=` was copied by every share and read by nothing.

**The two hardest problems, and how each was actually solved.**
*The 60 Hz render* was two bugs, not one: the context value was rebuilt every
render, **and** the rAF loop ran unconditionally. Fixing only the memoization
would have left a paused tab burning CPU. Measured before/after, not asserted.
*The deep link* — the obvious fix was `GET /clips/{id}/`, which **structurally
cannot work** because `get_queryset` is creator-scoped, so it 404s for every
clip the recipient didn't upload, which is every real share. A new
`GET /clips/{id}/resolve/` gated on `resolve_clip_access` fixed it. The failing
test that caught this was strengthened, not relaxed: it now registers the
resolver as 404 — the real-world case — and proves the in-feed answer survives a
failing metadata fetch.

---

## Decisions I took without asking, and why

- **Owner self-approval on upload.** `views/content.py:249-256` documents it as
  the current v1 workflow, so the web client now does what mobile does. Without
  it the creator loop silently does nothing, which is not shippable.
- **A metadata failure is not a deep-link answer on its own.** It waits for the
  feed (capped 1500 ms). Letting the feed upgrade a committed failure would have
  made the test green while production showed a false error *first* — the
  feed's `lpop` is far slower than a PK lookup.
- **`429` is surfaced, not enforced.** `telemetry` and `interaction` are both
  60/min, so an automatic retry spends the caller's remaining budget and makes
  the throttle worse. Still open, and says so in the code.
- **Feed pinned across tab switches** rather than buffered client-side: it is the
  only option that stops the destructive `lpop`, at the cost of one page's DOM.
  `display:none` is correctly out of the a11y tree.

## Left open on purpose
`DECISIONS.md` D1–D12. The ones that actually need the owner: case-insensitive
username uniqueness (needs a data migration that cannot pick a winner
automatically), a CSP (absent on every origin, and it spans nginx, the Worker and
the frontend), the audit-log retention and `action` vocabulary, the missing
`throttle_scope` on five viewsets — `GET /feed/` publishes a Celery task per
empty request, so one free account can force 1000/hour — and the free-tier
duration limit, which the server advertises but enforces nowhere and the Upload
page now blocks on client-side.

## Process notes worth keeping
- `conftest.py` drops the test DB at session finish and runs
  `pg_terminate_backend`, so a parallel agent without `ECHOFLOW_KEEP_TEST_DB=1`
  kills every peer's backends mid-test. Cost ~8 forced retries before I found
  it; every later agent got a private `TEST_DB_NAME` and the flag.
- `clear_throttle_cache` issues a `FLUSHDB` against the **shared** cache Redis,
  where the `user_feed:*` queues also live. Agents that used it as an autouse
  fixture would have un-throttled peers mid-assertion.
- One agent's assertion about a shared Redis counter was green in one run and
  `None` in the next with no code change — the counter store's keys had been
  drained by a concurrent test. It installs its own `_InMemoryBackend` now.
- `frontend/src/test/fetchMock.ts` matches the **first** registered route, so a
  `beforeEach` happy path silently shadows every failure route a test installs.
  Nine tests failed for the wrong reason before this was found.
- jsdom implements implicit form submission via user-event, so the
  long-open "does Enter double-submit?" question was settled by measurement:
  one submit, not two — RECON-02's "WRONG" verdict confirmed rather than assumed.
