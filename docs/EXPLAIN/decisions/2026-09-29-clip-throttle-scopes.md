# DECISION: Fix per-action throttle scopes on `AudioUploadViewSet` (A4 follow-up)

- **Date:** 2026-09-29
- **Status:** approved (owner: "Fix bug 4 properly"), implemented same day
- **Author:** mobile Phase 2 seeding
- **Relates to:** A4 (2026-09-29) per-action throttle scopes; mobile Phase 2 exit criteria

## 1. Changes needed

`AudioUploadViewSet.throttle_scope` and `get_throttles()` route actions to
per-action rate limits, but both key on the **URL path** while DRF sets
`self.action` to the **method name**. No custom action ever matches, so every
one of them silently falls through to `'upload'` (20/hour).

This is the same class of bug as I4 in the plan (`ScopedRateThrottle` allows
everything when the scope is absent) — a mis-keyed scope fails *open* onto the
wrong bucket, with no error, and the symptom is a 429 on an endpoint nobody
thought was throttled.

Two concrete failures observed while seeding Phase 2 media:

1. **A read is charged the upload budget.** `GET /clips/{id}/` — the status poll
   a client runs while HLS encodes — resolves to `'upload'`. A 20/hour cap on a
   read. Seeding 12 clips needs 12 uploads + 12 approves + ~300 polls against a
   shared 20/hour bucket, which is arithmetically impossible. The same cap will
   break **Phase 5**'s upload status pipeline, which polls this exact endpoint
   every few seconds for the whole duration of an encode.
2. **The 5 A4 scopes are dead code.** `clip_public` (120/min),
   `clip_play` (60/min), `share_link` (60/hour), `clip_report` (20/hour) and
   `clip_approve` (20/hour) are all still `20/hour` via `upload`. The A4
   comment claiming "a shared link's landing page 429s after 20 views" describes
   a bug that was never actually fixed.

## 2. How changes will be made

**Key the routing on method names, not URL paths.** DRF's `ViewSetMixin`
populates `self.action` from the handler **name**; `url_path` only affects the
route it is mounted at. So the correct keys are `public_view`, `play_shared`,
`share_link`, `report_clip`, `approve_moderation`.

**Give reads their own scope.** `retrieve` and `list` are reads, not uploads.
They move to a new `clip_read` scope (120/min) rather than being folded into
`upload`. `create` keeps `upload` (20/hour) — pushing up to 100 MB is the thing
that scope exists to limit.

**Route `approve_moderation` to the existing `clip_approve`** (20/hour). It
triggers HLS encoding, so the tight cap is correct and already specified; it
just never applied.

The resulting map:

| `self.action` | route | scope | rate | why |
|---|---|---|---|---|
| `create` | `POST /clips/` | `upload` | 20/hour | pushes ≤100 MB — this is what the cap is for |
| `retrieve` | `GET /clips/{id}/` | `clip_read` | 120/min | status poll during encode; a read |
| `list` | `GET /clips/` | `clip_read` | 120/min | own-clips list; a read |
| `approve_moderation` | `POST .../approve-moderation/` | `clip_approve` | 20/hour | triggers HLS encode = compute |
| `public_view` | `GET .../public/` | `clip_public` | 120/min | unauthenticated, IP-keyed |
| `play_shared` | `POST .../play/` | `clip_play` | 60/min | token exchange; anti-oracle |
| `share_link` | `POST .../share-link/` | `share_link` | 60/hour | mints a 30-day link |
| `report_clip` | `POST .../report/` | `clip_report` | 20/hour | abuse report |
| `update`/`partial_update`/`destroy` | — | `upload` | 20/hour | owner mutations, same trust level |

`update`/`partial_update`/`destroy` deliberately stay on `upload` rather than
getting bespoke rates. They are owner-scoped writes on the same objects `create`
creates, so sharing the cap is correct and avoids inventing limits nobody asked
for.

## 3. Why this and not anything else

- **Not a bigger `upload` number.** Raising 20/hour to, say, 500/hour would make
  the seed pass while leaving a *read* charged for *writes* — the actual defect.
  It also weakens the one limit that has a real justification (storage abuse).
- **Not a bespoke scope for every action.** Only the actions whose real cost
  differs from their neighbours get a scope. Owner mutations share `upload`.
- **Not keying on `url_path` via a lookup.** Reading the route is indirect and
  breaks again the moment a route is renamed. `self.action` is the API DRF
  actually exposes.
- **Not leaving the polling to the client.** A client cannot be the thing that
  decides it is allowed to read; a status endpoint that 429s mid-encode makes
  the server, not the client, responsible for the client's UX.

## 4. Files affected

- `backend/app/views/content.py` — `throttle_scope` property map, `get_throttles`
  action list, and the comment explaining the A4 intent
- `backend/EchoFlow/settings.py` — add `'clip_read': '120/min'`
- `backend/app/tests/test_throttling.py` — new regression tests
- `docs/EXPLAIN/decisions/2026-09-29-clip-throttle-scopes.md` — this file

## 5. Architecture & data flow

Unchanged. Throttle selection happens in DRF's `initial()` before the handler
runs; this only alters which cache key is used for the rate counter. The rate
counters live in the default Django cache (Redis `redis_cache_local`); the
keys are `throttle_<scope>_<ident>_<num>_<duration>`, so a scope rename resets
existing counters — harmless for a dev stack, and in production the first window
after deploy is effectively unthrottled for the renamed scopes, which is
acceptable for read scopes at these numbers.

## 6. Test cases

New `TestAudioUploadViewSetScopes` in `test_throttling.py`:

1. Each custom action resolves to its intended scope for **method names**
   (`approve_moderation` → `clip_approve`, `public_view` → `clip_public`,
   `play_shared` → `clip_play`, `share_link` → `share_link`,
   `report_clip` → `clip_report`). This is the regression guard: the old
   url_path keys fail this.
2. `retrieve` and `list` resolve to `clip_read` (not `upload`).
3. `create` resolves to `upload`.
4. `update`/`partial_update`/`destroy` resolve to `upload`.
5. Every scope named in the map exists in `DEFAULT_THROTTLE_RATES` — a typo'd
   scope is silently "no rate" in DRF, so this catches the next I4.
6. No action resolves to a scope that is also reachable by a *different*
   action with a different intended rate (guards against re-merging).

## 7. Edge cases

- **`ScopedRateThrottle` with an unknown scope returns `None`** from `get_rate()`,
  and `allow_request` then returns `True` — unthrottled. Test 5 exists purely
  to prevent that.
- **Method rename.** If a `@action` method is renamed, the map key silently stops
  matching and the action reverts to `upload`. The test derives the expected
  keys from the actual decorated methods where practical, so a rename surfaces
  as a test failure rather than a silent regression.
- **`get_throttles` returning `[ScopedRateThrottle()]` for scoped actions**
  means those actions are *not* additionally limited by the 1000/hour `user`
  bucket. That is intended and pre-existing (A4), and this change does not
  alter which class list each action gets — only which scope the class reads.
- **A 20/hour `clip_approve` still permits one bulk seed run per hour.** That is
  the correct posture: approving is compute. Seeding more than 20 in an hour
  requires a Pro/staff path or a deliberate limit change, not a client fix.

## 8. Atomic commit plan

1. `fix(throttling): key AudioUploadViewSet scopes on action names, add clip_read`
   — `content.py` + `settings.py` + tests. Self-contained and independently
   revertible; no behaviour change outside this viewset.
2. (separate, later) `fix(tasks): correct relative import ..services -> .services`
   — the HLS-blocking import bug found while seeding. Unrelated to throttling,
   so it does not belong in the same commit.
3. (separate) `chore(local): drop stale REDIS_*_URL from .env.local` — env only,
   never committed (`.env.local` is gitignored), so this is a local note in
   AGENTS.md rather than a commit.
