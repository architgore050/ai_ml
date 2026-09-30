# Public MVP Launch Readiness — Investigation & Plan

**Date:** 2026-09-30
**Status:** DECIDED — all 4 blocking questions answered by owner. Ready to implement.
**Scope:** The five items submitted as "still needed before a public MVP launch"
**Method:** Read-only investigation. No source file was modified. Every load-bearing
claim below was verified directly (grep/read, or a live check inside the running
`web_local` container). Claims I did *not* verify are marked.

### Owner decisions (2026-09-30)

| # | Question | Decision |
|---|---|---|
| D1 | Scraper: defer, enable, or drop? | **Drop it entirely.** Delete `ai_ml/scrapers/`, both entry points, all `SCRAPER_*` settings. |
| D2 | Moderator model | **Keep owner self-approval**, but only after the transcript column makes the gate real. |
| D3 | Schema migration for moderation | **Approved: all four fields** (`transcript`, `moderation_reason`, `moderated_at`, `moderated_by`). |
| D4 | RevenueCat: SDK or minimal? | **RevenueCat is mandatory. Minimum viable work: fix the backend, correct the docs, leave the portal as-is.** |

**Consequence of D1 that must not be missed:** deleting `ai_ml/scrapers/` makes
`test_upload_license_derivation.py::test_parity_with_the_scraper_classifier`
**silently skip** (it uses `pytest.importorskip`). That test is currently the only
independent check on `LICENSE_RESTRICTION_FEATURES` — the table that gates NC/SA
content on the upload path. Deleting the scraper without replacing that test
converts the rights gate from *tested* to *unchecked* **silently and green**.
The replacement is straightforward (§6.3) and must be in the same commit as the
deletion.

---

## 1. Executive summary

The five items were submitted as roughly equivalent "pre-launch polish". They are
not equivalent, and four of the five framings are materially wrong in ways that
change the work:

| # | Item as submitted | What the code actually shows | Real class of work |
|---|---|---|---|
| 1 | RevenueCat: "set a real portal URL or implement the SDK flow" | The documented frontend SDK **does not exist**. `revenuecat_app_user_id` is in **zero** serializers. The endpoint has a **live HTTP 500**. | **D4: minimal backend fix + doc truth.** No SDK. |
| 2 | Moderation: "needs a launch decision" | The approve-time gate is **100% inert** — it approves every upload. The real gate runs *after* the flag is already `True`. | **D2+D3: fix the gate, keep self-approval.** |
| 3 | HLS edge: "needs an end-to-end test" | The **entire security boundary has zero tests in any language**, and CI deploys it to production with no test step, from a branch whose `package.json` has no `test` script. | **Highest risk. Unverified prod security control.** |
| 4 | `ai_ml` migration debt | Largely accurate — but the migration is half-done in the *other* direction, and the ranking formula now exists in **five copies**. | **Defer + fix a duplication hazard.** |
| 5 | Scraper: "needs credentials + a policy decision" | One flag is **dead config**, another does not do what 4 docs claim, a connector is **silently broken**, and enabling it yields **zero playable audio**. | **D1: delete it.** 5 commits. |

**The priority inversion is the most important output of this investigation.** As
submitted, item 3 reads like the lowest-stakes item ("this workspace does not
exercise the external Worker path"). In fact it is the only item where **untested
code is deploying to production on every push**, guarding every byte of paid media.

### The cross-cutting finding

`AGENTS.md` contains at least **six claims that are now false**, and two of them
are actively dangerous: one tells a future agent the scraper is dead (it is not,
and it is the only writer of the product's rights-critical columns), and another
describes moderation behaviour that does not exist. Per this repo's own doctrine
(*"a comment describing a method that does not exist is worse than no comment"*),
stale documentation is a defect, not a footnote. See §6.

### Harness health (checked before trusting anything)

```
echoflow_web_local            Up 50 minutes (healthy)
echoflow_celery_media_local   Up 2 hours (healthy)
echoflow_celery_feed_local    Up 2 hours (healthy)
echoflow_redis_cache_local    Up 2 hours (healthy)
... 13 containers, none crash-looping, none Restarting
```

No `Restarting` state, so the cache-corruption and foreign-broker failure modes
recorded in `AGENTS.md` are not active. All findings below are code findings, not
harness artifacts.

---

## 2. Item 3 — HLS edge validation (re-prioritised to **first**)

### What was claimed
> "HLS edge validation needs an end-to-end test with the actual token-validating
> Worker deployed. The HTTPS/API terminator is healthy, but this workspace does
> not exercise the external Worker path."

### What is true
`docker/nginx.local.conf:51-53,158-183` does route `https://localhost:19443/hls/*`
→ `host.docker.internal:8787` → `wrangler dev` → MinIO. The architecture is
correct. The routing is statically asserted by 9 tests in
`test_https_termination.py::TestLocalHlsWorkerRouting`.

### What was not disclosed: the boundary has **no** tests at all

`workers/hls-token-worker/src/token.ts:106-147` is `validatePlaybackToken` — HMAC
verify, version check, expiry check, per-clip scope check. This is the *entire*
security boundary of the media edge. Verified:

```
$ grep -rn "validatePlaybackToken" workers/hls-token-worker/
  .wrangler/tmp/dev-8AucQe/index.js:43   <- miniflare build artifact
  .wrangler/tmp/dev-8AucQe/index.js:582  <- miniflare build artifact
  (source: token.ts:106, index.ts — no *.test.ts)
```

`src/token.test.ts:14-18` imports exactly three symbols:
`MEDIA_TOKEN_HEADER`, `extractTokenFromCookie`, `extractTokenFromRequest`. The
8 tests cover **transport extraction and precedence** only — a real and
well-reasoned property ("the one that matters", per its own comment) — but the
HMAC verify is never executed by a test in any language.

Coverage census of the Worker:

| Module | Lines | Tests | What's untested |
|---|---|---|---|
| `token.ts` — `validatePlaybackToken` | 106-147 | **0** | the entire gate |
| `token.ts` — extraction | 171-205 | 8 | — |
| `index.ts` — fetch handler | 239 | **0** | 405 method filter, `/hls/` 404, OPTIONS 204, CORS allow/deny, `StorageUnavailable→502`, `object===null→404`, segment-vs-playlist `Cache-Control` |
| `storage.ts` — `createS3Backend`/`createR2Backend` | 130-241 | **0** | Range forwarding, 206, 304, `404→null`, `StorageUnavailable` |
| `storage.ts` — `objectUrl`/`getStorage`/`assertTokenSecret` | — | 14 | — |

### And CI deploys it untested

`.github/workflows/deploy-hls-worker.yml` is 36 lines: checkout → setup-node →
`npm install` → `wrangler deploy`. No `npm test`, no `npm run typecheck`, and
`npm install` (not `npm ci`, unlike `deploy-frontend.yml:81-88` which
deliberately uses `ci`).

Compounding, verified against the branch CI actually deploys:

```
$ git ls-tree origin/RevnueCat-prod -- workers/
  README.md  package-lock.json  package.json  src/index.ts  src/token.ts
  tsconfig.json  wrangler.toml
  -> no storage.ts, no vitest.config.ts, no *.test.ts
```

`origin/RevnueCat-prod:workers/hls-token-worker/package.json` has only `dev` and
`deploy` scripts. **There is no `test` script on the deployed branch at all.** Even
adding a test step would fail there. The 22 Worker tests on this branch are
executed by nobody, ever.

### Cross-language parity is real but unverified

I read both implementations and they agree on every axis: HMAC-SHA256, secret as
UTF-8, HMAC over the base64 payload (not the raw JSON), constant-time compare,
padding-stripped base64url, `sort_keys=True` JSON, fields `{u, c, exp, iat, v}`,
`TOKEN_VERSION = 1`, scope prefix `"/" + c + "/"`, cookie `ef_hls_token`.

But `test_hls_token.py:113-140` (`test_token_format_matches_doc_spec`)
re-derives the signature **in Python against itself**. That is precisely the
"self-consistent implementation passes every test written against itself" pattern
that `storage.test.ts:3-8` records getting the SigV4 signer wrong twice, in
opposite directions. Nothing would catch future drift.

Two known divergences, both untested:
- `token.ts:133` `payload.v !== TOKEN_VERSION` (strict) vs `hls_token.py:213`
  `payload.get("v") != TOKEN_VERSION` (loose). A token with `"v": "1"` passes
  Python, is rejected by the Worker.
- `hls_token.py` runs `is_placeholder_secret` (`:75-78`); the Worker's only guard
  is `assertTokenSecret` (non-empty). A placeholder secret is rejected in Django
  and accepted at the edge.

Also: `workers/hls-token-worker/README.md:56` documents a `src/config.ts` that
does not exist, and never mentions `npm test`.

### Proposed work (5 commits, ~2 days)

**C3.1 — Unit-test `validatePlaybackToken` in TypeScript. Highest value per line.**
Zero new infrastructure: pure function, fake secret, `crypto.subtle` is global in
Node 24. Mirror the 11 cases in `test_hls_token.py:147+` (valid, tampered payload,
tampered sig, expired, wrong clip, partial prefix, exact scope, no-clip path,
empty, malformed, `v=2`), plus the two divergences above as explicit named cases.
**Closes the largest hole in the repo for the smallest diff.**

**C3.2 — Shared cross-language token-vector fixture.**
Commit `workers/hls-token-worker/testdata/token-vectors.json`: a fixed
`MEDIA_TOKEN_SECRET` and rows of `(token, request_path, expected_verdict,
expected_reason)`. `test_hls_token.py` and `token.test.ts` both replay it. This
turns "they share the same algorithm" from a read-through into a **checked
invariant**. `05-local-hls-worker-runbook.md:349-350` already proposes this and
defers it.

**C3.3 — Test `index.ts` via `@cloudflare/vitest-pool-workers`.**
Requires a new devDependency and switching `vitest.config.ts` from
`environment: "node"` to the workers pool. Covers the 405/404/502/CORS/304
branches against a real workerd runtime and a real R2 binding. No Docker needed.

**C3.4 — Fix the deploy workflow, and the branch it deploys.**
`npm ci` (not `install`) → `npm run typecheck` → `npm test` → `wrangler deploy`.
**Blocked on a decision (§7-Q1):** the workflow triggers on `RevnueCat-prod`, which
lacks the tests. Either re-point the trigger at the current branch, or land this
after the branch is reconciled. Do not add a test step that will fail on deploy.

**C3.5 — Fix the stale README** (nonexistent `src/config.ts`, document `npm test`).

### Explicitly out of scope for now
A full Docker E2E (Django mints → running `wrangler dev` → seeded MinIO) needs
`host.docker.internal:8787` reachable from `web_local`, a seeded
`hls/<clip>/master.m3u8` object (nothing in the repo creates one — the media
worker OOMs locally and fixtures are `mc cp`'d in by hand), and a shared secret
injected into both runtimes. That is C3.6, worth doing, but C3.1–C3.3 deliver most
of the value for a fraction of the infrastructure. **Recommend deferring C3.6 and
revisiting once C3.1–C3.3 are green.**

---

## 3. Item 2 — Upload moderation (needs a decision *after* reading this)

### What was claimed
> "Upload moderation needs a launch decision. The current implementation is
> intentionally only a small prohibited-phrase list; it is not adequate as a
> general content-moderation system or review workflow."

The second sentence is correct and already documented in the code
(`content_moderation.py:30-33`). The framing as a *decision* is what needs
correcting: **the system is not merely weak, it is non-functional at the point
where it is supposed to gate.**

### Finding 2.1 — the approve-time gate approves 100% of uploads

`run_moderation_check` (`content_moderation.py:132-179`) runs three checks. All
three are inert at the moment `approve-moderation` calls it:

| Check | Reads | State at approve time | Result |
|---|---|---|---|
| fingerprint (`:150-151`) | `_FINGERPRINT_BLOCKLIST` (`:45-47`) | **empty set** | always `(True, None)` |
| tags (`:155`) | `clip.tags` | `[]` — KeyBERT runs later, in the worker | always `(True, None)` |
| transcript (`:172-173`) | `getattr(clip, "transcript_text", None)` | **no such column exists** on any model (verified) | always `(True, None)` |

So `POST /clips/{id}/approve-moderation/` returns `200 {"status": "approved"}` for
**every upload**. The code says so itself at `:159-171`.

### Finding 2.2 — a test pins the rejection path using a fixture the real flow cannot produce

`test_content_view_authorization.py:937-946` (`test_a_rejected_clip_is_not_approved`)
asserts a 400 rejection, with `tags=["child sexual abuse material"]`
**pre-seeded on the clip**. The real upload flow (`serializers.py:503-568`) never
sets `tags`; `finalize_upload` forces `moderation_approved=False` and enqueues
nothing. The test therefore asserts a state the product cannot reach.

This is the exact lesson already recorded in `AGENTS.md` (2026-09-29, frontend
pass 1): *"Test fixtures must be the thing the test is about."* It gives false
confidence in the one place confidence is most needed.

### Finding 2.3 — the real gate runs after the flag is already `True`

`tasks.py`:
```
:256  if not clip.moderation_approved: return          # gate on entry
:390  check_transcript_for_prohibited_content(...)     # THE ONLY REAL CHECK
:394  clip.moderation_approved = False; status='rejected'
:408  clip.moderation_approved = True                  # set unconditionally on pass
```
`approve-moderation` (`content.py:527-532`) already set it `True` before the task
was enqueued. So the clip is `moderation_approved=True, status='processing'` while
transcription runs, and the rejection only lands afterwards. Whether any read
surface can observe that window is worth checking — every consumer filters on
`moderation_approved=True`, and `status` is separately `'processing'`, so the
practical exposure is likely nil. **I did not exhaustively verify the window is
unobservable; treat as a design smell, not a confirmed leak.**

**This gate has zero behavioural tests.** `grep -rn "moderation_rejected\|status='rejected'" backend/app/tests/`
returns nothing. The only real moderation in the product is untested.

### Finding 2.4 — there is no moderator; the uploader is the moderator

`content.py:519-526` is the entire authorization model: `is_staff` or
`creator == request.user`. No group, no `Permission`, no role. Owner self-approval
is deliberate and load-bearing — `test_group_c.py:223-234` and
`test_content_view_authorization.py:922-936` both assert it, with the reasoning
*"denying it would leave every upload stuck in `processing` until a human looked at
it."*

Given §2.1, that reasoning is now hollow: the human *is* looking, and approving,
and the check they are approving against cannot fail.

### Finding 2.5 — the surrounding workflow does not exist

- **No admin UI.** `backend/app/admin.py` is 3 lines and registers nothing.
  `django.contrib.admin` *is* installed and `/admin/` *is* mounted — a live,
  reachable, empty surface.
- **No rejection reason persisted.** The reason goes to `logger.error`
  (`tasks.py:393,400`) and is destroyed. `AudioClip` has no `moderation_reason`
  column. A uploader polling `GET /clips/{id}/` sees `status='rejected'` and never
  learns why.
- **No appeal, no notification.** No mail backend, no notification model, no
  appeal endpoint. The concepts are absent, not unimplemented.
- **Reports and takedowns are write-only.** Nothing in the repo ever *reads* a
  `Report` or `TakedownRequest`. No operator can see one, and neither has any
  enforcement effect on a clip — despite `2026-09-29-share-pipeline.md:42` and
  `settings.py:942` describing un-approval as a takedown mechanism. **No code path
  un-approves a clip.**
- **Moderation is unauditable.** `AuditLog.action` has no moderation value and
  `middleware.py:138` records every request as `action='view'`. A
  `POST .../approve-moderation/` is logged as a view.
- **Banned content is stored before moderation**, acknowledged at
  `uploads.py:36-39`. A rejected upload's `original_file` is never deleted.
- `tasks.py:396` saves with `update_fields=['moderation_approved','status','tags']`,
  **discarding the `semantic_vector` computed at `:351`** on the rejection path.

### Proposed work — DECIDED (D2: keep self-approval · D3: approve 4 fields)

> **D2 — "Keep owner self-approval, fix the gate."** **D3 — "Approve all four
> fields"** (`transcript`, `moderation_reason`, `moderated_at`, `moderated_by`).

D2's condition is the important half: self-approval is only defensible once the
check it approves against can fail, so C2.1 is not optional and must land before
anything describes moderation as working.

**C2.1 — Make the gate real (small, no longer blocked).** Add a `transcript` field
to `AudioClip` (`TextField`, nullable) and persist it in `process_audio_to_hls`
*before* the moderation check. `run_moderation_check` then works on the second and
later calls, and the ordering can be inverted so the transcript check happens
before `moderation_approved=True`. This is the single change that converts §2.1
from "approves everything" to "checks something".

**C2.2 — Persist the decision (schema, approved).**
`moderation_reason` (Text), `moderated_at` (DateTime), `moderated_by` (FK User,
null). Makes rejection explainable and approval attributable.

**C2.3 — Fix the fixture that gives false confidence (small).** *(Phase 0 — do
first.)* Rewrite `test_a_rejected_clip_is_not_approved` to drive the real path
rather than pre-seeding `tags`, or explicitly mark it as a unit test of the
predicate. Add behavioural tests for the `tasks.py:390` gate, which has none.

**C2.4 — Admin UI (medium).** Register `ModelAdmin` for `AudioClip` (moderation
queue: `filter(moderation_approved=False)`), `Report`, `TakedownRequest`. Turns
`/admin/` from an empty page into the review workflow. Under D2 the queue is a
*convenience for the operator*, not a gate — uploads still self-approve, so this
is lower priority than C2.1/C2.2.

**C2.5 — Document the accepted risk.** `docs/INDIA-REGULATORY-READINESS.md`
currently labels ISSUE-04 `[COMPLETED]` (line 21), `PARTIAL` (line 138), and
*"not closed"* (line 203-207) — three contradictory statuses in one document. Under
D2 the honest status is **"keyword gate operational; human review is
self-service; no appeal path; reports and takedowns unenforced"**, and that has to
be what the document says.

**Not recommended for MVP:** an audio classifier, fingerprint matching against
Content ID, or NSFW detection. Each is a separate project. Under D1 this matters
more than before — with no scraper, the keyword gate plus self-approval is the
*only* control standing between an upload and publication.

---

## 4. Item 1 — RevenueCat customer portal (config task → build task)

### What was claimed
> "Set a real `REVENUECAT_CUSTOMER_PORTAL_URL` or implement the official
> SDK/customer-management flow. The current fallback URL is product-specific
> hardcoded behavior, not a verified RevenueCat portal integration."

Correct. But the framing misses that **there is a live 500**, and that the
documented frontend integration **does not exist**.

### Finding 4.1 — live HTTP 500 on `GET /subscription/manage/`

`backend/app/services/revenuecat.py:191`:
```python
app_user_id = str(user.revenuecat_app_user_id) if user.revenuecat_app_user_id else str(user.uuid)
```

`User` extends `AbstractUser` (`models.py:14`). Verified: the only UUID field is
`revenuecat_app_user_id` at **`models.py:60`**. There is **no `uuid` attribute**.
`revenuecat_app_user_id` is `null=True`, so any row with `NULL` takes the `else`
branch and raises `AttributeError` → **500**.

It is masked today only because the field defaults to `uuid4()` on creation. This
is the defect already catalogued as **D8** in `docs/mobile-rebuild-plan.md:514` and
still present. `AGENTS.md:634` compounds it by describing the field as
"Maps to `User.uuid`" — it maps to `revenuecat_app_user_id`.

**Untested:** no test calls `/subscription/manage/` with the field nulled.

### Finding 4.2 — the documented frontend integration does not exist

`AGENTS.md:82`, `AGENTS.md:631`, `README.md:82` and
`docs/EXPLAIN/revenuecat/05-frontend.md:110-165` all describe
`@revenuecat/purchases-js`, `Paywall.tsx`, a `useSubscription` context, and 6
vitest tests. Verified: `frontend/package.json` has no such dependency; there is
no `Paywall.tsx`; `frontend/src/stores/` contains only `auth.tsx` and
`player.tsx`; `frontend/src/api/client.ts` has no `subscriptionAPI`;
`frontend/sample_frontend/` does not exist. The only frontend hits are three
*comments* citing the limit env vars.

Blocking that: **`revenuecat_app_user_id` is exposed by zero serializers.** It
appears only in `models.py:60`, its migration, and `services/revenuecat.py`. Even
if the SDK were added, `Purchases.logIn()` has no stable ID to receive.

### Finding 4.3 — the env var is in one template, so the fallback is what everyone gets

| Var | `.env.example` | `.env.vps.example` | `.env.laptop.example` |
|---|---|---|---|
| `REVENUECAT_CUSTOMER_PORTAL_URL` | **empty (line 292)** | **absent** | **absent** |

`os.environ.get(..., '')` defaults to `''`, so the hardcoded
`https://rcat.page/p/echoflow?app_user_id=…` (`revenuecat.py:198`) is served in
**every currently-configured environment**. It is not in
`test_env_file_hygiene.py`'s `FLEET_WIDE_REQUIRED` map, so its absence from the
VPS/laptop templates is silently tolerated.

### Finding 4.4 — the configured branch has zero coverage

`test_revenuecat.py:220-231` asserts only `"app_user_id" in r.data["url"]`, which
both branches satisfy on any host. Nothing tests the `"&" if "?" in base else "?"`
separator at `revenuecat.py:194-196`.

### Secondary (do not block MVP)
- `SubscriptionManageView` (`views/subscription.py:98`) has **no `throttle_scope`**,
  unlike `SubscriptionSyncView`. Relevant given the `AGENTS.md` note that
  `ScopedRateThrottle` silently allows everything when the scope is absent.
- `REVENUECAT_SECRET_KEY` is **not** covered by the `secrets.py` placeholder guard,
  and holds a placeholder in all three live env files — so `sync_entitlements`
  attempts real API calls with a bogus key instead of skipping.
- `tasks.py:524-530` ORs an unbounded `pro_last_synced` filter → full user-table
  scan every sync cycle.
- Docs show `rcat.page/p/your-project` / `yourproject`; code emits `/p/echoflow`.

### Proposed work — DECIDED (D4: mandatory, minimum viable)

> **D4 — "It is mandatory to use RevenueCat. Keep the work minimum. Update the
> docs and leave it as is. Make sure the backend works fine."**

So: no SDK, no portal reconfiguration, no new API surface. Three things only —
one of which is a live bug.

**C1.1 — Fix the 500 (tiny, non-negotiable under "make the backend work").**
`revenuecat.py:191` → drop the `str(user.uuid)` branch. The correct behaviour when
`revenuecat_app_user_id` is null is to **generate and persist** one (the field
already defaults to `uuid4()`; this is just the backfill path for pre-existing
rows) and return that. Add a test that nulls the field and calls the endpoint.
Without this, a null field is a 500 on a user-facing subscription screen.

**C1.2 — Env hygiene (tiny).** Add `REVENUECAT_CUSTOMER_PORTAL_URL` to
`.env.vps.example` and `.env.laptop.example` (currently present in **neither**, so
every deployment serves the hardcoded fallback), plus a `FLEET_WIDE_REQUIRED`
entry so its absence fails a test rather than passing silently. The value stays
empty — that is correct and intentional under D4, and it is a documented
RevenueCat-side configuration step, not a code change.

**C1.3 — Delete the false frontend documentation (small, and the point of D4).**
This is the highest-value part of "update the docs". `AGENTS.md:82`,
`AGENTS.md:631`, `README.md:82` and `docs/EXPLAIN/revenuecat/05-frontend.md:110-165`
all describe `@revenuecat/purchases-js`, `Purchases.setup(publicKey, d.user.uuid)`,
`Paywall.tsx`, a `useSubscription` context, `openCustomerCenter()`, and 6 vitest
tests. **None of it exists.** Under D4 that is a permanent state, so the docs must
say what is true: the backend polls entitlements over REST, exposes
`GET /subscription/`, `POST /subscription/sync/`, `GET /subscription/manage/`, and
there is no web purchase surface in this repository.

**C1.4 — Tests for the configured branch (small).** Cover the
`"&" if "?" in base else "?"` separator at `revenuecat.py:194-196` and a base URL
that already carries a query string. Under D4 the fallback stays, so **do not**
add a "fallback must never be served" guard — that test would fail by design.

**C1.5 — Secret hygiene (small, real bug).** `REVENUECAT_SECRET_KEY` is a
placeholder in all three live env files and is **not** covered by the
`secrets.py` placeholder guard, so `sync_entitlements` attempts real API calls
with a bogus key instead of skipping. Add it to the guard. Related:
`.env.laptop.example` has **zero** RevenueCat vars; add `REVENUECAT_SECRET_KEY` at
minimum, or record the omission deliberately.

### One consequence of D4 that needs stating plainly

**D4 leaves no way for a user to purchase a subscription from this product.** The
backend can *poll* entitlements and *report* them (`GET /subscription/`), but
initiating a purchase requires a store SDK — which is exactly what D4 declines to
build. So either purchases happen outside this repository (native app stores, or a
dashboard action), or no purchase happens at all.

That may well be the intent. But it should be written down, because
`docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md` already
records that `GET /subscription/` **advertises two usage limits that nothing
enforces** (`REVENUECAT_DAILY_UPLOAD_LIMIT_FREE`, `REVENUECAT_CLIP_DURATION_LIMIT_FREE`
— read in exactly one place, the response serializer). A product that cannot sell
and does not enforce its advertised tier is a coherent MVP, but only if the docs
say so rather than describing a paywall that isn't there.

**Recommended follow-up, explicitly not in this plan:** either wire the two
unenforced limits (a pure enforcement change, no purchase path needed) or stop
advertising them. That is `docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md`'s
open question and it survives D4 untouched.

---

## 5. Item 4 — `ai_ml` migration (defer, with one exception)

### What was claimed
> "The `ai_ml` migration remains incomplete: `cold_start.py`, audio-ingest
> orchestration, model wrappers, and evaluation harnesses still raise
> `NotImplementedError`. Live backend paths work because they still use the
> legacy implementations, so this is migration debt rather than an immediate
> outage."

**Verified accurate.** 11 `raise NotImplementedError`, all inside `ai_ml/`, across
4 model wrappers, 2 pipelines, 2 eval harnesses. All 9 stub symbols have **zero
external importers**.

Two corrections to the framing:

**Correction A — the migration is half-done in the *other* direction, and that is
the live risk.** `ai_ml/pipelines/recommendation.py` (437 lines) and
`feed_tasks.py` (227 lines) **are** live: `backend/app/tasks.py:553-558` re-exports
them, `celery.py:20` autodiscovers them, and `Dockerfile:211,254` `COPY` the
package into both final stages. The docstring at
`recommendation.py:53-58` claims "change them in ONE place … and the three builders
+ `backend.app.services.feed_pool` stay in sync." **They are not in sync.**
`build_global_exploit_pool` (`:335`) and `build_user_explore_pool` (`:387`) —
169 lines — have **zero callers**, while `services/feed_pool.py` re-implements the
identical annotate/`ExpressionWrapper` inline. There are now **five copies** of the
composite-score formula. That is a live divergence hazard in the ranking function,
not deferred debt.

**Correction B — `AGENTS.md`'s big `ai_ml` warning is now false and will mislead
the next agent.** `AGENTS.md:649` states `ai_ml/scrapers/` is gitignored, ships in
no image, and that `scrape_audio` "fails at import time." Verified all three false:
`git ls-files ai_ml/scrapers/` returns 12 tracked files; `.dockerignore:42-45`
explicitly notes it is *not* excluded; and `manage.py scrape_audio` imports
cleanly and reaches its gate. `75cebd9` fixed all of it. **The same false warning
is repeated at `AGENTS.md:883` and `docs/EXPLAIN/operations/01-audio-upload-guide.md:756`.**

### Proposed work

**C4.1 — Correct the false docs (small, no decision, do first).** Delete the
"dead at import time" warning from `AGENTS.md:649,883` and the upload guide.
`docs/frontend/RECON-05-security-abuse.md:699` already reached the correct
conclusion and says *"Anyone acting on that Open item will re-break a working
scraper."*

**C4.2 — Make `recommendation.py` the single authority for the formula (medium,
recommended before MVP).** Delete the duplicated SQL from `services/feed_pool.py`
and call `build_global_exploit_pool` / `build_user_explore_pool` instead. Pure
refactor, no task-name changes, so `CELERY_TASK_ROUTES` and
`CELERY_BEAT_SCHEDULE` are unaffected. Note
`test_feed_pool.py:244-267` uses `inspect.getsource()` and is pinned to
`recommendation.py` — it survives, but a behavioural test must be added because
`AGENTS.md` already flags that source-inspection test as P0 fragile.

**C4.3 — Defer the stubs. Do not implement them for MVP.** The dependency order
is: model wrappers → `audio_ingest` → `cold_start` → eval. Three load-bearing
constraints make this genuinely risky work, not busywork:

1. **The lazy-import contract must survive.** `faster_whisper`,
   `sentence_transformers` and `keybert` are imported *inside* the loader
   functions (`tasks.py:110,125,140`) precisely because the `api` image has none
   of them. Moving them to module level crashes `web` on boot. This is the single
   most likely way to break production.
2. **`extract_acoustic_vector` is a numerics contract, not a code move.** 40 MFCC
   + 12 chroma + 76 mel, L2-normalized, compared with `CosineDistance`. Any drift
   invalidates every stored `acoustic_vector` relative to the HNSW indexes. Needs
   a bit-for-bit fixture parity test, not a copy-paste.
3. **`RETRYABLE_ERRORS` differs between the two task modules** —
   `tasks.py:221-226` is a 4-tuple including `subprocess.CalledProcessError`;
   `feed_tasks.py:44-48` is a 3-tuple without it. Merging naively changes retry
   behaviour on the media hot path.

**Doc hazard if anyone does pick this up:** `docs/EXPLAIN/ai_ml/05-cold-start.md:41`
and `docs/EXPLAIN/architecture/03-design-decisions.md:558,566` document
`tags__overlap=selected_tags`. The code uses `Q(tags__contains=[tag])` in
`backend/app/views/feed.py:617-626`; `overlap` on a `JSONField` silently becomes
`JSON_EXTRACT(tags,'$.overlap')` and returns **zero rows**. Implementing
`cold_start.py` from the docs would reintroduce a previously-fixed silent bug.

**`ai_ml/scrapers/` is deleted under D1 — with one condition.** It is the only
writer of `is_noncommercial` / `requires_share_alike` **on the scraper path**, and
those two columns are the sole input to the feed filter,
`services/entitlements.py::is_license_restricted()`, and
`POST /media/playback-token/`. `serializers.py:214-235` deliberately
**transcribes** that table rather than importing it because the package has been
deleted twice. D1 makes that transcription the **sole** authority, which is exactly
why C5.1 (the golden test replacing the `importorskip` parity check) must ship in
the same commit as the deletion. The rest of this section is unaffected: none of
the model wrappers, `audio_ingest`, `cold_start`, or the eval harnesses touch
licensing.

---

## 6. Item 5 — Audio scraper (accurate claim, drastically understated work)

### What was claimed
> "Audio scraping is deliberately disabled by default. Enabling it needs source
> credentials and an explicit licensing/content-policy decision."

**Verified accurate.** `SCRAPER_ENABLED` is a genuine hard refusal — verified live
in the container:
```
$ docker compose exec web_local python manage.py scrape_audio --source=freesound --limit=1
CommandError: The audio scraper is disabled (SCRAPER_ENABLED is not set).
$ docker compose exec -e SCRAPER_ENABLED=True web_local python manage.py scrape_audio --source=freesound --limit=2 --smoke
[OK-empty] source=freesound fetch_audio() returned 0 items
```
The gate is the first statement in `handle()` (`scrape_audio.py:141`, before arg
parsing) and the first executable statement in the task. The classifier is
allow-list based (`_COMMERCIAL_ALLOW = {CC0, CC-BY, CC-BY-SA, PIXABAY, PD}`) and
fails closed on two independent paths. `test_scraper_licensing.py` (13 tests, 35
subtests) passes and pins the Freesound NC fail-open regression.

**But "credentials + a decision" understates it by roughly an order of magnitude.**
Five additional findings, all verified:

### Finding 5.1 — `SCRAPER_ALLOW_SHARE_ALIKE` is dead configuration

It gates nothing. `include_sa` is read at `scrape_audio.py:210`, printed at `:222`,
written to resume state at `:235`, and passed to `_process_item` at `:379,415` —
where it **never appears in the body** (`:416-564`). Same in `tasks.py` (only
interpolated into a log line at `:1291-1292`). Setting it True and False produces
byte-identical behaviour.

Three documents state otherwise: the CLI help at `scrape_audio.py:99` ("auto-approve
moderation"), `.env.example:229-232`, `.env.vps.example:183-186`, and
`docs/EXPLAIN/decisions/2026-09-07-...:111`.

### Finding 5.2 — `SCRAPER_ALLOW_NC=True` does **not** admit NC to any feed

The feed filter is **unconditional**:
```
backend/app/views/feed.py:159   .filter(is_noncommercial=False, requires_share_alike=False)
backend/app/views/feed.py:181   .filter(is_noncommercial=False, requires_share_alike=False)
backend/app/views/feed.py:235   is_noncommercial=False, requires_share_alike=False,
```
No view, service or serializer reads `SCRAPER_ALLOW_NC` at read time. The flag only
admits NC **into the database**, where it then sits permanently unreachable by
every surface. `docs/EXPLAIN/scraping/03-licensing-safety.md:64-76`,
`.env.example:224-227` and `.env.vps.example:178-181` all claim the opposite.

Net: NC audio would be ingested, stored, encoded, billed for, and never servable.
A waste rather than a leak — but not what four documents promise.

### Finding 5.3 — the Internet Archive connector is silently broken (HTTP 200 + error key)

`ai_ml/scrapers/sources/internet_archive.py:70-79` sends bracket-form sort params:
```python
params['sort[0]'] = sort_field
params['sort[0][dir]'] = sort_dir or 'asc'
...
r = session.get(SEARCH, params=params, timeout=30)
r.raise_for_status()          # does NOT raise — archive.org returns 200
return r.json().get('response', {}).get('docs', [])   # -> []
```
The sub-agent measured this live against archive.org, isolating each parameter:
```
A: fl list only                        status=200 numFound=14037302 docs=3
B: fl list + neg collection            status=200 numFound=14037233 docs=3
C: fl list + sort                      status=200 numFound=None      docs=0  <-- BREAKS
D: all (what the connector sends)      status=200 numFound=None      docs=0
```
Raw body for C: `[UNSUPPORTED_VALUE] A requested parameter has an inappropriate
value (array: [{"dir":"asc"}]) for request parameter sort`. The slash form
`sort=identifier asc` works. **Confirmed end-to-end:**
`manage.py scrape_audio --source=internet_archive --limit=3 --smoke` →
`[OK-empty] ... returned 0 items`, while IA reports `numFound=14037299`.

`AGENTS.md:471` says IA is excluded for licensing reasons ("emits no license key").
It emits the key (`internet_archive.py:213`) — IA is *also* excluded by this bug.
An operator enabling the scraper would hit this immediately and could not
diagnose it from any document.

### Finding 5.4 — enabling the switch produces zero playable audio

`scrape_audio.py:516-519` publishes `process_audio_to_hls` for each clip. But
`uploader.py` **never sets `moderation_approved`** (zero occurrences in
`ai_ml/scrapers/`), so the model default `False` stands — and `tasks.py:256-262`:
```python
if not clip.moderation_approved:
    logger.info("... moderation not approved ... skipping HLS generation.")
    timer.set_outcome('skipped')
    return
```
The task exits immediately and changes nothing. **No scraped clip is ever
HLS-encoded** without human approval. This is not an SA-only chore — it gates
**100%** of scraped content, contrary to how `AGENTS.md:331,471` and both env
templates describe it.

Approval is also awkward: the `scraper` owner account is created with
`set_unusable_password()` and `is_active=False` (`scrape_audio.py:309-315`), and
`is_staff=False`, so the owner path in `content.py:519-526` is unusable — a real
staff account is a hard prerequisite. Undocumented.

### Finding 5.5 — zero tests for the load-bearing control

`grep -rn "SCRAPER_ENABLED" backend/app/tests/` returns **2 hits, both in
`test_env_file_hygiene.py`**, and both only assert the key appears in the env
templates. **Nothing tests that either entry point raises when the flag is off.**
No test imports any connector, `uploader`, or `normalizer`. The 8 orphaned
`test_scraper*` files deleted 2026-09-29 removed what little integration coverage
existed. This is precisely why §5.3 survived.

Also: there is **no `--dry-run`**. `--smoke` is single-source (only
`source_list[0]`, so it tests wikimedia unless you pass `--source` four times),
still downloads 10 MB, and ignores the NC/SA flags. An operator has no way to
preview licence classifications before writing to Postgres, MinIO and the queue.

### The 11 decisions an operator actually faces

1. Flip `SCRAPER_ENABLED=True`. 2. Supply `FREESOUND_API_KEY` (the only credential
that can produce an import today). 3. Choose sources and a time budget.
**4.** Which sources (9 recoverable, each needing licence-vocabulary
re-verification — an engineering task, not a flag). **5.** Is NC admissible?
`03-licensing-safety.md:23-25` says no. **6.** Is SA admissible? `…:17-21` warns
CC-BY-SA is *viral*: **EchoFlow re-encodes everything to MP3 and repackages as
HLS — that is a derivative work**, and there is no mechanism or field to record
a ShareAlike obligation. **7.** Who approves, with which account? (§5.4)
**8.** What is the moderation standard? (Depends on item 2.) **9.** Attribution
display — `attribution_text` is stored but **not displayed anywhere**, and
CC-BY *requires* attribution. Shipping CC-BY without it is a licence breach.
**10.** Takedown/DMCA — not implemented; `INDIA-REGULATORY-READINESS.md:12` lists
this among 6 Critical launch blockers. **11.** Who is the copyright owner of
record? The scraper populates neither `copyright_owner_name` nor
`copyright_acknowledgement`.

### Proposed work — DECIDED (D1: drop the scraper entirely)

> **D1 — "Drop the scraper entirely."**

This is the right call and it is well supported by the findings above: the
subsystem has been deleted twice already (`5c9c2d6`, `aacd759`), restored once
(`75cebd9`), contains a live silent bug (§5.3), has dead configuration (§5.1, §5.2),
cannot produce playable audio (§5.4), and opens eleven unresolved product and legal
questions. Deleting it removes all of that and buys back the right to be small.

**D1 is a deletion, not a deferral, and it has one non-obvious hazard that must be
handled in the same commit as the deletion itself.**

#### The hazard: the deletion silently disarms the rights gate's only cross-check

`backend/app/tests/test_upload_license_derivation.py:756-776`:

```python
def test_parity_with_the_scraper_classifier():
    license_features = pytest.importorskip(
        "ai_ml.scrapers.base", reason="scraper package not installed"
    ).license_features

    from backend.app.serializers import LICENSE_RESTRICTION_FEATURES

    for license_type, expected in sorted(EXPECTED_FEATURES.items()):
        assert LICENSE_RESTRICTION_FEATURES[license_type] == \
            license_features(license_type) == expected, license_type
```

That `importorskip` is **load-bearing today and lethal after the deletion**:

- Today, `LICENSE_RESTRICTION_FEATURES` is a table *transcribed* into
  `serializers.py:234` (deliberately — see its 20-line comment at `:227-233`: a
  top-level import would turn a missing optional package into an `ImportError` on
  every request, taking the rights gate down with the site). The transcription is
  kept honest by this test, which re-derives it from the classifier and fails on
  any divergence.
- After the deletion, the test **skips**. Suite stays green. The transcribed table
  becomes the sole, unchecked authority for `is_noncommercial` /
  `requires_share_alike` — the two columns that gate the feed, the profile, the
  share path, and `POST /media/playback-token/`.

This is precisely the "silently skips, so the guarantee evaporates" failure class
this repo has been bitten by before (the `Redis`-corrupt-AOF incident: green suite,
broken harness). **The replacement must land in the same commit as the deletion.**

**C5.1 — Replace the parity test with a hard-pinned golden test (same commit as C5.2).**
`EXPECTED_FEATURES` is already a clean 7-entry literal that exactly matches
`LICENSE_CHOICES`. Drop the middle term of the chained assertion:

```python
# BEFORE — three-way, one term optional
assert LICENSE_RESTRICTION_FEATURES[lt] == license_features(lt) == expected
# AFTER  — two-way, nothing optional
assert LICENSE_RESTRICTION_FEATURES[lt] == expected
```

Then add what the deletion makes newly necessary, because the uploader is now the
**only** source of these columns and therefore the only thing standing between a
declaration and a served file:
- a test that `LICENSE_RESTRICTION_FEATURES` has **exactly** the same key set as
  `AudioUploadSerializer.LICENSE_CHOICES` (catches a new choice added without a
  table row — currently impossible to detect, and the failure mode is an
  unclassified licence served commercially);
- keep the existing `test_upload_license_derivation.py` behavioural tests, which
  already cover the derivation in `create()`.

Also update the `serializers.py:214-233` comment block, which currently names
`ai_ml/scrapers/base.py` as "THE AUTHORITY" and explains the transcription in
terms of a package that will no longer exist.

**C5.2 — Delete the subsystem.**
- `ai_ml/scrapers/` — 12 files, ~1,600 lines (`base.py` 471, `state.py` 373,
  `storage`-adjacent `sources/internet_archive.py` 215, `uploader.py` 182,
  `normalizer.py` 161, `downloader.py` 153, `log.py` 106, plus connectors).
- `backend/app/management/commands/scrape_audio.py`.
- `scrape_and_import` from `backend/app/tasks.py` (lazy imports at `:1185-1191`,
  `:1225`).
- All `SCRAPER_*` settings (`settings.py:603-678` — 20 settings, of which 6 are
  already dead with zero readers: `SCRAPER_SOURCES`, `SCRAPER_ALLOW_LICENSES`,
  `SCRAPER_TARGET_DIR`, `SCRAPER_DOWNLOAD_MAX_ATTEMPTS`, `SCRAPER_DOWNLOAD_BACKOFF`,
  `SCRAPER_STATE_DIR`/`SCRAPER_LOG_DIR`) plus `FREESOUND_API_KEY`.
- `backend/app/tests/test_scraper_licensing.py` (13 tests) — delete, **not port**.
  It tests a classifier that will no longer exist. Its *intent* survives as C5.1's
  golden test; its *vocabulary* (Freesound licence strings) does not, because
  nothing parses licence strings any more.
- Env templates: 12 `SCRAPER_*`/`FREESOUND_*` lines in `.env.example`, 5 in
  `.env.vps.example`. `FREESOUND_API_KEY` is in `FLEET_WIDE_REQUIRED`
  (`test_env_file_hygiene.py:337`) and must be removed from that map too.
- Docs: `docs/EXPLAIN/scraping/` (whole directory), `AGENTS.md`'s Scraping /
  Ingestion section, `docs/EXPLAIN/decisions/2026-09-07-scraping-coverage-expansion.md`,
  `docs/EXPLAIN/decisions/2026-09-29-restore-audio-scraper.md`,
  `docs/EXPLAIN/compliance/01-license-type-unknown-gap.md:63-64` (its operator
  approve-moderation instruction becomes moot), and the stale
  `docs/EXPLAIN/operations/01-audio-upload-guide.md:756`.
- `models.py:126` and `settings.py:646` comments that name the classifier as the
  rights authority.

**C5.3 — Delete the false claims D1 makes false in a second way.**
`AGENTS.md:331,471` already misdescribe the scraper's `moderation_approved`
behaviour; §5.1, §5.2, §5.3 and §5.4 make four more documents wrong. The `AGENTS.md`
"dead at import time" warning (§5 in the original list, see §5/Correction B) is
deleted in the same pass, so the file does not both say "it's deleted" and "it's
broken".

**C5.4 — Cold-start content is unaffected.** `backend/scripts/seed_clips.py` drives
the real HTTP API (`POST /clips/` → `POST /clips/{id}/approve-moderation/` →
`process_audio_to_hls`) with known-good local audio and **no licensing exposure**.
It is unaffected by D1 and remains the answer to "the feed is empty at launch".

#### What D1 explicitly does not do

D1 removes the *ingestion* path. It does **not** weaken any serving control:
`views/feed.py:159,181,235`, `views/profile.py:83`, `views/comments.py:152`,
`views/interactions.py:112`, `views/social.py:235` and
`services/entitlements.py:67` all filter on the two DB columns and are untouched.
The NC/SA rights gate keeps working exactly as it does today for user uploads —
which, per §2, is where all content now comes from.

**The residual risk D1 accepts, stated plainly:** with no scraper, `license_type`
is entirely self-declared by the uploader. A user who uploads NC audio and
declares `CC-BY` gets it served. This is the standard UGC trust model (Content ID
is the usual answer, and is out of scope) and it is *not worse than the status
quo* — today the same lie is possible, and the `serializers.py:205-207` comment
says so. But it does mean **item 2's moderation gate is now the only control
between an upload and publication**, which raises rather than lowers the priority
of §3.

---

## 7. Decision register — RESOLVED

All owner decisions are in. The remaining items are *sequencing* choices, not
blockers, and are marked with my recommendation.

| # | Question | Decision |
|---|---|---|
| Q1 | `deploy-hls-worker.yml` triggers on `RevnueCat-prod`, which has no `test` script and no test files. Re-point the trigger, or reconcile the branch? | **Still open — needs one line from you.** I recommend re-pointing the trigger to the current branch. Do not add a test step that will fail on deploy. Blocks C3.4 only; C3.1–C3.3 are unaffected. |
| Q2 | Add 4 fields to `AudioClip`? | **Approved** (D3): `transcript`, `moderation_reason`, `moderated_at`, `moderated_by`. |
| Q3 | Who moderates? | **Owner self-approval retained** (D2), conditional on Q2 landing first. |
| Q4 | RevenueCat: SDK or minimal? | **Minimal** (D4): fix the backend, correct the docs, portal unchanged. |
| Q5 | Fix the `ai_ml` ranking-formula duplication (5 copies) before MVP? | **My recommendation: yes.** Pure refactor, live divergence risk in the ranking function, no task-name changes. Needs your nod but nothing depends on it. |
| Q6 | Enable the scraper for MVP? | **No — deleted** (D1). |
| Q7 | Correct the false docs? | **Yes**, folded into C5.3 and C1.3. |
| Q8 | `REVENUECAT_SECRET_KEY` is a placeholder in all live env files and outside the `secrets.py` guard. | **Yes** → C1.5. Recommended unconditionally; it is a live bug, not a preference. |
| Q9 | `REVENUECAT_SECRET_KEY` absent from `.env.laptop.example` entirely. | **Yes** → C1.5. |

**Only Q1 blocks Phase 2, and only C3.4 within it.** Phases 0 and 1 can start now.

---

## 8. Proposed sequencing

Ordered by **risk reduction per unit of effort**, not by the order submitted.

### Phase 0 — no open questions, land first (≈2 days)
| Commit | Item | Why first |
|---|---|---|
| **0.1** | C1.1 fix the `/subscription/manage/` 500 + regression test | Live production bug, one line. Satisfies D4's "make the backend work". |
| **0.2** | C3.1 unit-test `validatePlaybackToken` (13 TS cases) | Largest untested hole in the repo, smallest diff. |
| **0.3** | C2.3 fix the false-confidence moderation fixture + add `tasks.py:390` gate tests | Zero cost, removes actively misleading coverage. |
| **0.4** | C5.1 + C5.2 **together** — golden rights test + delete the scraper | The importorskip hazard (§6) makes these inseparable. Deleting first would silently disarm the rights gate. |
| **0.5** | C5.3 delete the false docs (AGENTS.md, README, `docs/EXPLAIN/scraping/`, RevenueCat frontend claims) | Do it in the same pass as 0.4 so the file never says both "deleted" and "broken". |
| **0.6** | C1.5 `REVENUECAT_SECRET_KEY` placeholder guard + laptop template | Live bug: sync attempts real API calls with a bogus key. |

### Phase 1 — moderation (D2 + D3, ≈3 days)
C2.1 `transcript` column + invert the gate order → C2.2 persist reason/actor/time →
C2.4 admin queue for the review workflow → C2.5 rewrite ISSUE-04 with one honest
status. Self-approval stays, but it is now approving against a check that can fail.

### Phase 2 — HLS edge (≈3 days, C3.4 needs Q1)
C3.2 shared token-vector fixture → C3.3 `index.ts` pool-workers tests → C3.4 CI gate
(Q1) → C3.5 README.

### Phase 3 — RevenueCat docs + `ai_ml` (≈1 day)
C1.2/C1.3/C1.4 (D4 scope) → C4.1 false-doc correction → C4.2 de-duplicate the
ranking formula (needs Q5).

### Explicitly deferred
- C3.6 full Docker E2E for HLS.
- `ai_ml` stubs (model wrappers, `audio_ingest`, `cold_start`, eval) — D1 does not
  affect these; they remain deferred with the constraints in §5/C4.3.
- Enforcing or removing the two advertised-but-unenforced subscription limits —
  flagged in §4, outside this plan, and the one RevenueCat follow-up D4 leaves open.
- Audio classifier / fingerprint matching / NSFW detection.
- Any form of content ingestion beyond `backend/scripts/seed_clips.py`.

---

## 9. Atomic commit plan

Each commit is independently revertable and leaves the suite green. Per
`AGENTS.md`, the Django test command is:

```bash
docker compose exec -e PYTHONPATH=/app web_local pytest backend/app/tests/ -q
```

Run with a per-run `TEST_DB_NAME` **and** `TEST_REDIS_CACHE_DB` if other agents
are working concurrently — `TEST_DB_NAME` alone is no longer sufficient.

| # | Commit | Files | Test file |
|---|---|---|---|
| 0.1 | `fix(revenuecat): /subscription/manage/ 500 on null app_user_id` | `services/revenuecat.py` | `test_revenuecat.py` (+1) |
| 0.2 | `test(hls-worker): cover validatePlaybackToken` | `src/token.test.ts` | self (13) |
| 0.3 | `test(moderation): fixture matches the real upload path; cover the task gate` | `test_content_view_authorization.py`, `test_content_moderation.py` | (+6) |
| **0.4** | **`refactor(scraper): delete the ingestion subsystem; pin the rights table as a golden test`** | `ai_ml/scrapers/` (**−12 files**), `scrape_audio.py`, `tasks.py`, `settings.py` (**−20**), `test_scraper_licensing.py` (**−13**), `.env.example` (**−12**), `.env.vps.example` (**−5**), `test_env_file_hygiene.py`, `serializers.py`, `test_upload_license_derivation.py` | `test_upload_license_derivation.py` (**rewritten, no longer skips**) |
| 0.5 | `docs: remove the deleted scraper and the never-built RevenueCat frontend` | `AGENTS.md`, `README.md`, `docs/EXPLAIN/scraping/` (**deleted**), 4 decision docs, `05-local-hls-worker-runbook.md`, `01-audio-upload-guide.md` | — |
| 0.6 | `fix(secrets): guard REVENUECAT_SECRET_KEY; add it to the laptop template` | `EchoFlow/secrets.py`, `test_throttle_identity_and_secrets.py`, `.env.laptop.example` | (+3) |
| 1.1 | `feat(moderation): persist the transcript; check before approving` | `models.py`, `tasks.py`, `content_moderation.py`, `serializers.py`, migration | `test_content_moderation.py` |
| 1.2 | `feat(moderation): persist the decision (reason, actor, time)` | `models.py`, `tasks.py`, migration | `test_content_moderation.py` |
| 1.3 | `feat(admin): moderation queue + report/takedown review` | `admin.py` | `test_content_moderation.py` |
| 1.4 | `docs: one honest ISSUE-04 status` | `INDIA-REGULATORY-READINESS.md` | — |
| 2.1 | `test(hls): shared cross-language token vectors` | `testdata/token-vectors.json`, `test_hls_token.py`, `token.test.ts` | (+vector replay) |
| 2.2 | `test(hls-worker): cover the fetch handler` | `vitest.config.ts`, `package.json`, new `index.test.ts` | (+~15) |
| 2.3 | `ci: gate the worker deploy on typecheck + tests` **(needs Q1)** | `deploy-hls-worker.yml` | — |
| 2.4 | `docs(revenuecat): document the REST-only, no-SDK reality` | `AGENTS.md`, `README.md`, `05-frontend.md` | — |
| 3.1 | `docs: correct the stale ai_ml migration-status claims` | `AGENTS.md`, `ai_ml/README.md`, `05-cold-start.md`, `03-design-decisions.md` | — |
| 3.2 | `refactor(ai_ml): one authority for the composite-score formula` **(needs Q5)** | `services/feed_pool.py`, `test_feed_pool.py` | (+behavioural) |

**Commit 0.4 is the only large one and the only one with a silent-failure mode.**
Its verification is not "the suite is green" — the suite was green *before* it, and
would be green after it if the parity test were left skipping. The verification is:

1. `pytest backend/app/tests/test_upload_license_derivation.py -v` shows the
   rewritten test **collected and passing**, not skipped.
2. `grep -rn "ai_ml.scrapers\|SCRAPER_\|scrape_audio\|scrape_and_import" --include=*.py backend/`
   returns nothing outside `__pycache__`.
3. `python manage.py check` and `makemigrations --check --dry-run` both clean.
4. All six NC/SA serving surfaces still filter: `test_feed_license_filter.py`,
   `test_share_send_endpoint.py`, `test_interaction_scoping.py`,
   `test_hls_token.py::TestPlaybackTokenEntitlement` all green.

Every other commit is verified the same way as the rest of this repo: **fail
before the fix, pass after** — the discipline `AGENTS.md` records from the
2026-09-29 Block 0 work. A test that has never been seen red is not evidence.

### Test command

```bash
docker compose exec -e PYTHONPATH=/app web_local pytest backend/app/tests/ -q
```

Run with a per-run `TEST_DB_NAME` **and** `TEST_REDIS_CACHE_DB` if other agents are
working concurrently — `TEST_DB_NAME` alone is no longer sufficient. For the Worker:

```bash
cd workers/hls-token-worker && npm ci && npm run typecheck && npm test
```

And before trusting any result, `docker ps` for `Restarting` — see §1.

---

## 10. What I did not do

- **Did not run the test suite.** I report no pass/fail count, because I did not
  measure one. The container health check above is the only harness claim I make.
- **Did not verify** whether the `moderation_approved=True, status='processing'`
  window (§2.3) is observable by any read surface. Flagged as a design smell.
- **Did not verify the IA sort bug myself** — I report the sub-agent's live
  measurement against archive.org, which included the raw error body and an
  isolating parameter matrix. Worth a 30-second re-check before acting.
- **Did not touch** `ai_ml/scrapers/` beyond reading it.
- **Made no changes** to any file other than this plan.
