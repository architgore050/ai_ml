# Mobile — remaining phases plan

Date: 2026-09-30. Read `00-verification.md` first: it establishes what exists,
what is claimed but unproven, and five corrections to the governing plan.

Principle: **one small task per agent, sequential within a phase, verified by me
between tasks.** No agent gets a whole phase. Every agent is told other agents
exist and that a band-aid is worse than an honest stop.

---

## Phase F — Reel visuals  (in progress)

The entire visual layer is missing. Nothing here is a rewrite: the transport
works, the card just has no art.

| # | Task | Output | Depends on |
|---|---|---|---|
| **F0** | Extract `ReelCard` + `CardStatusView` out of `app/(tabs)/index.tsx` into `src/components/reel/ReelCard.tsx`. **No visual change.** Establishes the seam the rest of the phase edits, and gets the card under a test. | `src/components/reel/ReelCard.tsx` | — |
| **F1** | Add gradient tokens to `src/design/tokens.ts`: brand `135°` (terracotta→hover), reel backdrop (`${c}10 0% / ${c}22 50% / #121416 100%`), progress fill `90°` (`${c}`→terracotta), waveform `to top` (`${c}`→sage). Add the missing `tintSteps['10']`. | tokens + a test | F0 |
| **F2** | Pure envelope math in `src/lib/waveform.ts` (covered, testable): deterministic 40-bar heights, **clamped ≥ 0**, seeded from clip id so a given clip always looks the same. No `Math.random()`, anywhere. | lib + tests | F1 |
| **F3** | `src/components/reel/WaveformBars.tsx` — renders the 40 bars with the `scaleY` keyframe envelope, `expo-linear-gradient`, exact source geometry (3 px wide, 2 px gap, 2 px radius, container opacity 0.15). | component | F2 |
| **F4** | `src/components/reel/AmbientOrbs.tsx` — the two source orbs (280×280 @ `08` blur 60 top-right; 200×200 @ `0A` blur 40 bottom-left). RN has no CSS `filter: blur`, so use `expo-blur` or a pre-blurred gradient ring — **agent must verify which actually renders rather than assume.** | component | F1 |
| **F5** | Seekable progress bar: track `#1e2022` h4 r2, fill `90°` gradient, **linear 0.1 s**, click-to-seek via `seekToSeconds(fraction * duration)`. Honours the §13 "reconcile explicitly" warning: `duration` is expo-audio **seconds**; the backend's `duration_ms` is a different measure and must not be used for the scrubber. | component + tests | F1 |
| **F6** | 100 px play/pause overlay + tap-to-toggle-play, 600 ms auto-hide, 7-bar `waveBar` icon when playing and the source's SVG triangle when paused. **Do not port the source's double-tap handler** — its pause branch is an empty block and it adds 250 ms to every single tap. | component + tests | F3, F5 |
| **F7** | Timecode + ±10 s (`RotateCcw`/`RotateCw`, clamped to `[0, duration]`) + hands-free toggle UI. | component + tests | F5 |
| **F8** | Wire the card: extract `handsFree` and the skip/seek handlers into a small `useClipControls` hook so the screen file stays thin. | screen wiring | F5–F7 |
| **F9** | `tsc` clean, Jest green, iOS + Android export. Re-measure coverage. | — | F8 |

**Phase F exit:** the card renders title, category, tags, orbs, waveform, a
working scrubber, a play overlay, timecode and skip controls — and every one of
those is unit-tested except the pure layout.

### Anti-goals for Phase F
No `ActionCluster`, no like/comment/share buttons (Phase 3), no cover art
(decision D1 — `cover_image` is always null and the URL is presigned against the
container-internal endpoint, so it would be a broken image), no dot-matrix
overlay (plan §13: no RN equivalent, dropping is the honest call), no
`Math.random()`, no snapshot tests.

---

## Phase 3 — Feed interactions

Gate: F. This is where the plan's most expensive defect lives — telemetry that
reports natural completion as a skip, which corrupts `avg_completion_rate`, which
is 30% of the ranking composite.

| # | Task | Notes |
|---|---|---|
| 3a | `src/hooks/useWatchTelemetry.ts` — 5 s heartbeat from `player.currentTime`, **never wall-clock** | wall-clock corrupts on pause/buffer/failed-load |
| 3b | Completion guard as a **pure** function: `shouldRegisterSkip({positionMs, durationMs, userInitiated})` | plan defect 2. The guard is the whole point; it must be exhaustively unit-tested |
| 3c | Flush on pause / skip / background / unmount; 1-per-5 s cap; **drop-oldest** on 429 | `log-telemetry` is 60/min — a sustained 1 Hz client 429s after ~60 s |
| 3d | `403` from `log-telemetry` ⇒ minor. Surface it, never retry | verified contract, `interactions.py:65` |
| 3e | `src/api/endpoints/interactions.ts` — toggle-like, register-skip, log-telemetry, with the **Cursor** envelope for nothing here (all are bare objects) | |
| 3f | `ActionCluster` + like with optimistic + rollback, `Math.max(0,…)` floor, in-flight guard, **re-read the server's `data.status`** | re-POSTing the same state does not re-toggle |
| 3g | Double-tap-to-like + heart burst — **design from scratch**, no source exists | see `00-verification.md` §5.1 |
| 3h | `CommentSheet` — list (Cursor, no `count`), post, reply(`parent`), edit own, delete own (PATCH/DELETE) | 4 backend capabilities, zero client consumers today |
| 3i | `ShareModal` — `find-user` debounce → `send-share` (`POST`) | |
| 3j | Follow/unfollow — **POST**, and the web's `GET` was a silent 405 | |
| 3k | Hands-free auto-advance: `progress ≥ 0.99` → 1000 ms → advance | reuses the F7 toggle |

## Phase 4 — Explore / Profile / Inbox

Replace the four 44-line placeholders. **Gate: 3** (they all need interactions).

4a Explore: category pills over the **11** values in `categories.ts`, paged
`/suggestions/`, pull-to-refresh, empty/error states, and **no search** (no
endpoint). 4b Profile (own) incl. avatar `PATCH /profile/me/update/` and
`liked_clips`; 4c Profile (public) with follow + clips; 4d Inbox with a **bare
array** envelope, 30 s poll, POST mark-read, full-screen playback of a shared
clip. 4e **No follower drill-down** — remove the stat link rather than leave it
inert.

## Phase 5 — Upload

5a `expo-audio` record (`HIGH_QUALITY` → `.m4a`) or library pick; 5b live level
meter; 5c pre-validate duration against the 300 s server bound **and** the 60 s
free cap, which exists **only client-side**; 5d `XMLHttpRequest.upload.onprogress`
+ cancel (`fetch` has no progress); 5e `approve-moderation` — the only enqueue
trigger; 5f poll `GET /clips/{id}/` with the verified trap that a 400 rejection
never changes `status`; 5g my-clips list. Free cap: stop before the round trip.

## Phase 6 — Settings / Legal / Pro

6a theme (dark-only MVP); 6b `GET /subscription/` with **every `limits` value a
string**, including `"True"`/`"False"`; 6c soft-enforce the free cap, "Upgrade"
opens the **web** portal (D8: no native IAP); 6d manual sync — fire-and-forget,
so do not poll for a result; 6e compliance/grievance/nodal + physical address;
6f grievance form; 6g data-access summary (**counts**, not an export); 6h erase
account — two-stage, and **never render "your data is deleted"**; 6i Sentry
init; 6j accessibility sweep: ≥44 pt iOS / ≥48 dp Android on every control.

## Phase 7 — Distribution, E2E, CI

7a `eas.json` with per-profile `EXPO_PUBLIC_API_BASE_URL` + `runtimeVersion`;
7b `eas update` channels; 7c store metadata; 7d Maestro, **3 flows only**;
7e CI typecheck + jest. 7f EAS free tier will not carry production.

## Phase G — Real-device-family verification  (blocked on the SDK)

The only phases that can produce evidence `tsc` cannot. In order:

1. Boot the AVD, install the debug build.
2. `adb reverse tcp:18443 tcp:18443` and `tcp:19443` — the emulator's
   `localhost` is the emulator. `10.0.2.2` is the host alias.
3. Start the HLS Worker first. Without it playback is a **502**, which is the
   correct loud failure.
4. Prove the things §7 of `00-verification.md` lists as unproven: a cell is
   non-zero height; audio actually decodes; scrub moves `currentTime`; the
   process survives a swipe; the lock-screen call behaves on Android.
5. Honest reporting: what passed, what did not, and what **cannot** be tested on
   Linux (iOS).

---

## Per-task definition of done

1. `npx tsc --noEmit` clean.
2. `npx jest` green, and the new tests **verified to fail** when the change is
   reverted. A test never seen red is not evidence.
3. One focused commit. Explicit `git add <paths>` — never `git add .`,
   `git add -A`, or `git add backend/`.
4. `backend/` untouched unless I have cited a `file:line` defect and confirmed
   the other agent's work in that file is committed first.
5. A new backend test for any backend change.
6. A line in `02-phase-log.md`.

## Sequencing rule

Phases F → 3 → 4 → 5 → 6 → 7 are strictly ordered; G runs when the emulator
exists and can interleave. Within a phase, tasks are sequential. If a task's
premise turns out to be wrong when the agent reads the code, **stop and report
it** — do not build on the plan's description. That failure mode has already
cost three cycles in this repo.
