# Frontend completion plan — production MVP

**Date:** 2026-09-29
**Branch:** `feat/mobile-rebuild` (no new branch)
**Scope:** `frontend/` only, plus backend changes where genuinely required
**Supersedes:** the phasing in `docs/frontend_rebuild_plan.md` §5, which was written
before commits 1–8 and whose line references have drifted. That document's
*findings* still stand; its *ordering* and *scope* are replaced by this one.
**Status:** in progress

---

## 1. Where the frontend actually is

Five commits landed before this plan, plus two in Block 1:

| Commit | Effect on the frontend |
|---|---|
| `4ed5cf5` | vitest + RTL harness (24 tests), `strict` + `noUncheckedIndexedAccess` on, ErrorBoundary, SessionAnnouncer |
| `9eebc1a` | *backend* — avatar upload bound |
| `21846fe` | *backend* — `is_following` exposed (+ the `/profile/me/` 500) |
| `c9405ae` | `is_following` consumed in `ReelCard`; optimistic follow with rollback + in-flight guard |
| `2002e46` | *backend* — share queryset annotation |
| `dcd0159`, `db3ac24` | *docs* |

So **24 tests, 0 real error states, 0 routing, and the whole of Phases 2–6 are
untouched.** `tsc --noEmit` and `vite build` pass; that is still the only green
signal outside the test suite.

Verified baseline before starting: `npm test` 24 passed, `tsc --noEmit` clean,
`vite build` succeeds, single 926 kB chunk.

### 1.1 File inventory (the basis for partitioning)

```
  503  src/pages/Profile.tsx          <- heaviest, 14 known defects
  456  src/components/feed/ReelCard.tsx
  448  src/api/client.ts
  401  src/stores/player.tsx          <- hardest single file
  290  src/pages/Upload.tsx
  274  src/pages/Login.tsx
  227  src/components/feed/ReelList.tsx
  213  src/styles/tokens.css
  205  src/components/comments/CommentSheet.tsx
  194  src/components/sharing/ShareModal.tsx
  186  src/pages/Feed.tsx
  170  src/pages/Explore.tsx
  170  src/pages/Inbox.tsx
  161  src/App.tsx
  148  src/components/feed/OnboardingModal.tsx
  136  src/stores/auth.tsx
  130  src/components/common/ErrorBoundary.tsx
  128  src/components/common/Header.tsx
  126  src/components/common/SessionAnnouncer.tsx
  107  src/components/feed/MiniPlayer.tsx
   93  src/types/echoflow.ts
   73  src/components/navigation/BottomNav.tsx
   59  src/components/common/NetworkBanner.tsx
   10  src/main.tsx
```

## 2. The constraint that decides the whole approach

Agents are dispatched in parallel, so **work is partitioned by file, not by
feature.** Two agents in the same file will conflict and produce a mess that
looks like progress. Every assignment below therefore names the files the agent
owns exclusively, and any file not listed is off-limits to that agent.

Three files are hubs and are therefore **single-owner and sequential**:
`player.tsx`, `client.ts`, `ReelCard.tsx`. Most of the "obvious" parallel work
(health polling, fabricated-data removal in the leaf pages, a11y on small
components) is in leaf files and *can* run fully in parallel.

## 3. Guiding rules for every agent

Given to each agent verbatim, with the task appended:

1. **Other agents are working in this repository concurrently.** You own only
   the files named in your task. Do not edit, reformat, or "fix" any other
   file. Do not run `git add -A`, `git commit -a`, `git checkout -- .`, or
   `git stash` — the last three can destroy another agent's uncommitted work.
   Stage only your own files, by explicit path.
2. **Read before you write.** Open each file you are about to change and read it
   end to end, plus the types and API client it depends on. The audit that
   produced these tasks is dated; line numbers may have drifted. Verify with
   `grep` before relying on any claim in the task text.
3. **No band-aid fixes.** Do not silence a warning, add a `// TODO`, widen a
   type with `any`, delete an assertion, skip a test, or catch-and-swallow an
   error to make something pass. If a defect's real fix is larger than the task
   implies, stop and say so in your report rather than papering over it.
4. **Prove the change.** Every behavioural fix needs a test that you have
   watched **fail before your fix and pass after**. Report the before/after
   count explicitly. A test you have never seen red is not evidence.
5. **Verify your claims yourself** with `grep`/`tsc`/`npm test`. Do not assert
   something is fixed because it looks right.
6. **Small commits, or no commit.** Prefer leaving changes uncommitted and
   reporting, unless told otherwise. One logical change at a time.
7. **Report honestly.** If you did not finish, say so and say what is left. If
   you found a defect outside your files, report it — do not fix it.

## 4. Execution phases

Each phase is verified by me before the next begins.

### Phase A — leaf components, fully parallel (5 agents)

Disjoint files, no shared dependencies. Lowest risk, builds the test harness
coverage that later phases need.

| # | Agent owns | Task |
|---|---|---|
| A1 | `Header.tsx`, `NetworkBanner.tsx`, `BottomNav.tsx` | Replace the hardcoded "Workers Active" indicator with a real poll of `/health/` and `/ready/`; make the banner user-dismissable instead of a 2.5 s auto-expiry; `aria-current` on nav, `aria-pressed` on toggles, remove `focus:outline-none`; drop the hardcoded `v2.4` |
| A2 | `Explore.tsx` only | Delete the synthesised `{Math.max(15, likes + shares*2)} Listens` count and the `PGVECTOR_384D`/"clustered by semantic embeddings" copy; render real `duration_ms` and `tags`; `next`/`previous` were dead — make pagination actually work |
| A3 | `Inbox.tsx`, `CommentSheet.tsx` | Render `created_at` on inbox rows; roll back a failed share delete instead of dropping the row; roll back a failed `markRead`; fix `Discussions (N)` to use `clip.comment_count` + real pagination; render comment `parent`/`reply_count` (fetched but never displayed) |
| A4 | `OnboardingModal.tsx` | Replace the `<div>` fake checkbox with a real input, labelled; `aria-pressed` on tag selection |
| A5 | `tokens.css` only | No component may be edited by this agent. Define the semantic token set (type scale, spacing, radii, z-index, `--accent`) and the light-theme `[data-theme="light"]` block; document the `pb-safe` and `animate-in zoom-in-95` dead CSS. **Deliverable is the CSS plus a migration map, not the migration** |

### Phase B — the media core (sequential, 2 agents, one file each)

`player.tsx` and `client.ts` are the two highest-coupling files. They are done
one after the other by a single agent each, in small steps, because both are
dense and a concurrent editor would corrupt them.

| # | Agent owns | Task |
|---|---|---|
| B1 | `client.ts` only | Dispatch `ef_session_expired` on the **network-throw** path (only the non-OK path does it today); route `getPlaybackToken` through the 401 refresh path via an opt-in `withCredentials` flag on `apiRequest`; capture `Retry-After` on 429 |
| B2 | `player.tsx` only | Measure **elapsed playback**, not media position, for `watch_time_ms`; make `reel_position_ms` and `listen_duration_ms` genuinely different; fix the stale-closure `handleAutoAdvance`; pick **one** owner for advance and remove the other; bound `hls.startLoad()` with a cap and one token re-mint; render `playbackError` |

### Phase C — heavy single files, sequential

| # | Agent owns | Task |
|---|---|---|
| C1 | `ShareModal.tsx` only | Delete `DEFAULT_PEERS` and the peer-list block; re-key `sentUsers` by `(clipId, recipientId)` — today it is keyed by recipient alone, so a peer marked "Sent" for clip A is permanently unshareable for every later clip; distinguish 404 from 429/500 in the `find-user` error |
| C2 | `ReelCard.tsx` only | Delete the fabricated "Acoustic Vector", "Similarity Score", hardcoded transcript, `192kbps ABR` and the fake waveform; replace with real `tags`/`duration_ms`; the non-current card's scrubber seeks the current clip — guard it; `role="slider"` + arrow-key seeking on the scrubber; `aria-label` on the 8 icon-only buttons |
| C3 | `Profile.tsx` only | Delete the always-on `CREATOR` badge; replace `\|\| 0` stats with a loading skeleton and a real error state — **never a plausible zero**; `date_joined \|\| Date.now()` → em dash; failed clip-edit must not close the modal; add `required`/`maxLength` to the title field |
| C4 | `Upload.tsx` only | Replace the asserted `copyright_acknowledgement: "true"` with an unchecked-by-default checkbox and a real `license_type` + `copyright_owner_name`; fix the over-length file path that `return`s without clearing state and the 300 s path that sets an error *and then* the file; correct the four false model claims (backend is Whisper `base` + MFCC, and the file contradicts itself 112 lines apart) |

### Phase D — integration (1 agent)

| # | Agent owns | Task |
|---|---|---|
| D1 | `App.tsx`, `main.tsx` | Re-place the `ErrorBoundary` so it actually wraps `AuthProvider`/`PlayerProvider` (today it sits outside both, so it catches neither) and correct the docstring that claims the opposite; wire `SessionAnnouncer` to the `ef_session_expired` event; make `isAuthenticated` derive from token validity, not a cached user object |

### Phase E — deliberately deferred, with reasons

| Deferred | Why |
|---|---|
| **Router (`react-router-dom`)** | Touches `App.tsx` + all 6 pages. The only thing it buys is a working share deep link. §6 handles that for ~15 lines instead. Not worth the blast radius for an MVP. |
| **Terracotta token migration** | ~90 hex literals across 9 components. Purely cosmetic, zero behavioural value, and a large diff that makes every other review harder. A5 lays the groundwork; the migration is a single mechanical commit when wanted. |
| **Full a11y sweep** | Phase A + C2/C3 cover the keyboard and label defects that block use. Polish (focus-trap refinement, live-region tuning) is post-MVP. |
| **Code splitting** | Only possible once routes exist, and routes are deferred. The 926 kB chunk is a performance concern, not an MVP blocker. |
| **26 P2 rows** | Only the ones touching files an agent already owns get fixed, to avoid file collisions. The rest are logged with their location. |

## 5. Verification between phases

I run all of these myself after every phase, and will not proceed on a red one:

```bash
cd frontend
npx tsc --noEmit          # strict
npx vitest run            # must not regress
npx vite build            # must succeed
```

Plus, for any backend change an agent makes:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local \
  exec -T -e PYTHONPATH=/app web_local pytest backend/app/tests/ -q --tb=short
docker compose -f docker-compose.local.yml --env-file .env.local \
  exec -T web_local python manage.py makemigrations --check --dry-run
```

Suite baseline to protect: **716 passed, 0 failed, 7 skipped**.

## 6. The hardest problem, and the bypass

**The router is the hardest item and I am bypassing it deliberately.** Converting
the `useState("feed")` tab shell to `react-router-dom` touches `App.tsx` and all
six pages, and it is the single change most likely to break player continuity
(the player is currently hoisted above the tab switch, which is what keeps audio
playing across navigation).

The only MVP-relevant thing the router buys is the share deep link, which is
currently **dead**: `ShareModal` copies `origin + "/?clip=" + id`, and nothing
reads `?clip=` (`App.tsx` is a tab shell, no query parsing anywhere in `src/`).
So a user who shares a clip hands the recipient a link that lands on the feed
with the parameter ignored.

The bypass is ~15 lines in `App.tsx`: read `?clip=` on mount, and if present,
switch to the tab that can resolve it and open that clip. No dependency, no
per-page changes, no risk to player continuity. If a real router is wanted later
it is a contained migration from that working state.

## 7. Log

Each phase entry records what was dispatched, what came back, what I verified,
and what I rejected. See `docs/frontend/LOG.md`.

## 8. Definition of done (production MVP)

- `tsc --noEmit`, `vitest run`, `vite build` all green; no regression in the 716-test backend suite.
- No fabricated metric is displayed anywhere a user can see it.
- A share link opens the shared clip.
- No failed request leaves a plausible-looking false state (no `|| 0`, no silent "Copied", no swallowed error that changes nothing).
- Every interactive element is reachable and named; the scrubber is keyboard-operable.
- No agent-introduced band-aid: no widened types, no deleted assertions, no new silent catches.
