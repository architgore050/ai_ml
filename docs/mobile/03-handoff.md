# Mobile — execution log, technical findings, and the plan for what comes next

**This file is the hand-off document.** A new agent with no prior context should
be able to continue from it alone. Written 2026-09-30 on branch
`feat/mobile-reel-and-verify`.

Read in this order: §1 what is done → §5 the hard-won technical findings (these
are the expensive part, do not rediscover them) → §7 the next phase → §10 the
operating rules.

---

## 1. Where the work stands

**Phase 0 (verification) and Phase F (reel visuals) are COMPLETE.**

| Metric | Start of this work | Now |
|---|---|---|
| Jest | 221 tests / 15 suites | **669 tests / 26 suites** |
| `tsc --noEmit` | clean | clean |
| Reel visual layer | **absent** | complete (orbs, waveform, scrubber, transport, overlay) |
| `src/components/reel/` | 1 file (inline in a screen) | 6 components + 6 test files |

### Commits on this branch, in order

| Commit | What |
|---|---|
| `af966dd` | Phase-0 verification + remaining-phase plan; extracted `ReelCard` out of `app/(tabs)/index.tsx` as a byte-identical pure move |
| `7579c70` | Five native edge cases in the player store; the Jest worklets resolver |
| `0b51482` | `WaveformBars`, `AmbientOrbs`, `SeekProgressBar` |
| `d049b9f` | `PlayOverlay`, `ClipTransport` (timecode, ±10s, hands-free), directional gesture arbitration, duplications consolidated, lucide jest config |
| `1816688` | The 140 px dead-zone fix in `ClipTransport` |

**Note on branch topology:** another agent is working on the WEB frontend
(`frontend/src`) and has been committing to whatever branch is checked out. Their
commits (`867988f`, `a10fe14`, `0405171`, and others) therefore appear in this
branch's history. That is expected and harmless — do not revert them. Nothing in
`mobile/` has been touched by them.

### The documented phases

- `docs/mobile/00-verification.md` — what exists, what is claimed but unproven,
  **five places the governing plan is wrong**, 14 verified backend contracts
- `docs/mobile/01-plan.md` — Phases F, 3, 4, 5, 6, 7, G with per-task exit
  criteria
- `docs/EXPLAIN/decisions/2026-09-29-mobile-task-list.md` — the task-level
  contract (Phase 1 and 2 items are effectively done; 3.x–8.x are not)
- `docs/mobile-rebuild-plan.md` — the master plan. **Read §5 of `00-verification.md`
  before trusting any of it**; five of its claims are wrong.

---

## 2. What Phase F built, and why each decision was made

Every visual value was transcribed from `frontend/sample_frontend2`, which exists
**only in git commit `20451d3`** (the directory was deleted 9 minutes after being
committed). Read it with:

```
git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx
```

The tracked `frontend/src/styles/tokens.css` is a faithful port of `globals.css`
and is easier to diff, but it does **not** contain the orbs, the 40-bar waveform,
the play overlay or the 135° gradient. Those live only in `20451d3`.

| File | What it is | Notes |
|---|---|---|
| `src/lib/waveform.ts` | Pure deterministic bar maths | 40 bars, bounds `[8,30]`, envelope `[0.6,1]` |
| `src/components/reel/WaveformBars.tsx` | The 40-bar row | `scaleY` envelope on the UI thread |
| `src/components/reel/AmbientOrbs.tsx` | Two blurred blobs | RN 0.86 native `filter`, no `expo-blur` |
| `src/components/reel/SeekProgressBar.tsx` | 4 px bar, 48 dp target, click/drag seek | directional gesture arbitration |
| `src/components/reel/PlayOverlay.tsx` | 100 px overlay + tap-to-toggle | timing lives in `src/lib/playOverlayVisibility.ts` |
| `src/components/reel/ClipTransport.tsx` | Timecode, ±10 s, hands-free | uses `skipBy`, never `seekToSeconds` |
| `src/lib/playOverlayVisibility.ts` | Pure overlay state machine | 600 ms auto-hide, absolute deadlines |
| `src/lib/formatTime.ts` | `m:ss` | one implementation; visible + spoken agree |
| `src/lib/skipSeconds.ts` | The ±10 step | one binding for button + a11y action |

### Why the maths lives in `src/lib/` and not in a component
`jest.config.js` `collectCoverageFrom` **excludes `src/design/**` and
`src/components/**`**. Logic inside a component is therefore unmeasured by
default. `waveform.ts`, `playOverlayVisibility.ts` and `formatTime.ts` are all in
`src/lib/` for this reason. Follow the same rule for any new logic.

---

## 3. Phase-0 corrections to the plan (do not trust the plan over these)

1. **Double-tap-to-like and the heart burst have NO source to port.** The plan
   (line 696) lists them under "Ported from `frontend/src`". An exhaustive search
   across all reachable commits finds no `onDoubleClick` and no heart-burst
   animation. The old mobile app had no double-tap handler either. They must be
   **designed**, not ported. (Phase 3.)
2. **`sample_frontend2` is deleted, not gitignored.** The plan's token-provenance
   comment says "gitignored (.gitignore:26)"; those lines are gone.
3. **The 40-bar waveform's source formula can go NEGATIVE.** `8 + sin(i*0.4)*12
   + Math.random()*10` has a theoretical min of **−4 px**, invalid in CSS and RN.
   There is no clamp in any source.
4. **`active:scale-0.96` never existed in any web frontend.** It is a
   plan-invented value, already implemented in `ui/Button.tsx:109`.
5. **`tintSteps` was missing `'10'`** (0.0625), needed by the reel backdrop.

### The `tintSteps` opacity question — OPEN, needs an owner decision
The seven pre-existing alpha steps transcribe CSS hex suffixes as **decimals**
(`0x18` → `0.18`) where CSS resolves them as **n/255** (`0x18` → `0.094`). So the
mobile app renders roughly **1.65×–2.55× more opaque** than the web design it is
porting. `'10'` is the only step matching its CSS value. This was **deliberately
not changed**: `components/ui/primitives.ts` already consumes these for button
and sheet backgrounds, so re-grading is a visual redesign, and the result cannot
be judged without a device. Two options: re-grade to n/255 (correct, but a look
change), or ratify n/100 and fix the documentation. **This is unresolved and
waiting on the owner.**

Also open: `Object.keys(tintSteps)` returns `10 18 22 33 44 55 08 0A` because
`'10'` is an integer-like key and JS hoists it. Anything iterating must `.sort()`.

---

## 4. The player store: five defects found by reading `expo-audio`'s source

These are the highest-value findings in the whole effort. Each is a behaviour the
**installed** package genuinely produces. They were found by reading
`node_modules/expo-audio/ios/AudioPlayer.swift`, `ios/AudioUtils.swift`,
`android/.../AudioPlayer.kt`, `android/.../BaseAudioPlayer.kt` and
`build/*.d.ts` — **not** the docs, which would not have surfaced any of them.

1. **`releasePlayer()` called `remove()`, which is not a teardown.** On native it
   is a one-line registry delete (`ios/AudioModule.swift:251-253`,
   `AudioModule.kt:544-546`) that never runs `teardownPlayer()`, never removes the
   periodic time observer, never clears the lock screen. The store nulled its
   instance and reset while the native player kept playing and kept pushing
   events; a later `getPlayer()` built a **second** player. The real teardown is
   `release()` (`SharedObject.ts:22`) and it is **TERMINAL** — later native calls
   throw `InvalidSharedObjectIdException` (`SharedObjectRegistry.kt:97-98`), so it
   is guarded and ordered last.

2. **`syncFromPlayer` accepted a `NaN` and out-of-range `currentTime`.** iOS
   merges an unguarded `time.seconds` into the event (`ios/AudioPlayer.swift:488`
   — the *property* at `:62-65` guards, the *event* path does not), so NaN can
   reach the store; a NaN width is an invalid RN style value and would corrupt
   completion telemetry. Android emits the **raw, unclamped** seek target
   (`BaseAudioPlayer.kt:114-122`), so `currentTime > duration` is reachable by
   design. Both are now coerced once, in the store, so every consumer is safe.

3. **`'ended'` survived exactly one 500 ms tick.** `didJustFinish` is a
   single-event pulse on both native platforms (`ios/AudioPlayer.swift:146`,
   `AudioPlayer.kt:211` hardcode `false`; only the end-notification override sets
   it). `PlayerHost` re-syncs every 500 ms, so `playback` flipped to `'paused'`
   and the plan's auto-advance and `progress >= 0.99` pacing **could never fire**.
   Now latched against `playingClipId`, the same technique already used for
   `error`. `playbackStateFrom` stayed pure and unchanged.

4. **iOS reported `isBuffering: true` for the app's whole pre-first-clip life**
   (`ios/AudioUtils.swift:197-209` returns a bare `true` when `currentItem == nil`
   and the player is built with `source: null`). **The first fix was wrong** and
   the way it was caught is worth recording: it gated buffering on native
   `isLoaded`. But `isLoaded` is `currentItem?.status == .readyToPlay` on iOS
   (`ios/AudioPlayer.swift:86-88`) and `playbackState == STATE_READY` on Android
   (`AudioPlayer.kt:197`) — so a **real** stall is `isLoaded:true` on iOS and
   `isLoaded:false` on Android, and that gate would have hidden the spinner
   Android needs. An existing test disagreed, the platform source was checked,
   and the gate became the store's own `playingClipId`. A test now pins that
   specific regression.

5. **`seekToSeconds` clamped nothing**, and on Android a seek issued **before any
   source is loaded is STORED and applied to the NEXT clip** (`Playable.kt:31`).
   `clampSeekTime` is now the single clamp point; `skipBy(±10)` reads the store,
   clamps, and returns `null` to **refuse** rather than seek to 0.

### Two more findings that shape the next phase
- **`updateInterval: 500` must NOT be lowered.** iOS's periodic time observer is
  registered only in `play(at:)` and removed only in `teardownPlayer()`
  (`ios/AudioPlayer.swift:474-491, 326-329`), so it fires at 2 Hz **forever** once
  play is pressed — including when paused and when backgrounded. At 100 ms that is
  a permanent 10 Hz JS-bridge re-render loop. **Interpolate** between samples
  instead; the scrubber already does.
- **A seek emits an immediate status update on all platforms**
  (`ios/AudioPlayer.swift:189-194`, `BaseAudioPlayer.kt:119-121`), so the thumb
  feels responsive at 500 ms sampling with no extra native traffic.
- **An expired token will most likely present as an infinite stall, not an
  error.** If a segment 403s, iOS usually stalls rather than failing the item, so
  `isBuffering: true` forever with `error: null`. **Phase 3 needs a buffering
  timeout** that re-mints a token and retries once. Do not rely on `error` alone.
- **`error: nil` is hardcoded in `currentStatus()` on ALL platforms**
  (`ios/AudioPlayer.swift:153`, `AudioPlayer.kt:218`), not just iOS. But the
  **event** path does carry a real error, merged over the hardcoded nil
  (`ios/AudioPlayer.swift:167-177` + `:218-222`; `BaseAudioPlayer.kt:71-75` +
  `AudioPlayer.kt:158-164`) — and it is a **one-shot pulse**, so it must be
  latched, which the store now does. Two comments in the codebase that said
  "nothing would ever correct it" were corrected.

---

## 5. The Jest/React Native testing traps that will bite Phase 3

Every one of these cost a real debugging cycle. They are not optional knowledge.

1. **reanimated 4 + worklets 0.10 crash at IMPORT time under Jest**:
   `TypeError: Cannot read properties of undefined (reading 'loadUnpackers')` at
   `NativeWorklets.native.ts:411`. jest-expo mocks the legacy `ReanimatedModule`
   but not the worklets TurboModule. Fixed with one line in `jest.config.js`:
   `resolver: 'react-native-worklets/jest/resolver'`. Because it is an
   import-time crash, reanimated's own `setUpTests()` could never help; it is
   still called in `jest.setup.js` because it provides `toHaveAnimatedStyle`.

2. **`element.props.style` is FROZEN at the initial value for any animated
   property.** Asserting on it is a **FALSE PASS**. Use `getAnimatedStyle` /
   `toHaveAnimatedStyle`. Measured: over 1500 ms of a `withRepeat`, `props.style`
   read `0` while the live style moved `0 → 25 → 50 → 100 → 50`.

3. **`jest.useFakeTimers()` must be installed in `beforeEach`, BEFORE `render`.**
   The animation loop schedules its first frame through `requestAnimationFrame`;
   installing timers after render leaves it on real rAF and
   `advanceTimersByTime` moves nothing.

4. **RNTL v14's `render` is async**: `const view = await render(...)`. And
   `unmount()` does not flush cleanups unless awaited. `TestInstance` has neither
   `findAll` nor `findAllByType`.

5. **`fireEvent` becomes unusable when a view declines all responder events.**
   RNTL's `isEventEnabled` (`helpers/pointer-events.js:15-26`) blocks *every*
   event once `onStartShouldSetResponder` and `onMoveShouldSetResponder` both
   return false. `SeekProgressBar`'s tests use a `fire` helper that calls the
   handler without `act` (the handlers set no React state). Chaining `act` calls
   produces "overlapping act() calls" that silently suppress the **next** render.

6. **`PanResponder` reads `event.touchHistory`, not `nativeEvent`,** and RNTL
   never populates it. The test must hand-build a real bank keyed by `identifier`
   with `previousPageX`. Getting it wrong is **silent**: `centroidDimension`
   returns `noCentroid` (-1), `dx` stays 0, and every drag-vs-tap decision reads
   as "the finger never moved".

7. **`lucide-react-native` needed TWO config halves.** Its `react-native` export
   condition resolves to real ESM (`dist/esm/*.mjs`), **and** jest-expo's
   transform pattern is `\.[jt]sx?$`, so an `.mjs` file matches no transform rule.
   Both `transformIgnorePatterns` and `transform: {'\\.mjs$': JEST_EXPO_TRANSFORM}`
   are required. Cost: **73 s → 116 s cold cache** (babel transforms ~1600 icons).
   Accepted rather than `moduleNameMapper`-ing to `dist/cjs`, which is **not** in
   the package's `exports` map and would break on the next version.

8. **A `jest.spyOn` left installed by a failing test corrupts React's scheduler**
   into an opaque `AggregateError` in every later test.

### And the discipline that matters most
**A test that has never been seen red is not evidence.** Every fix in this phase
had its test shown failing by reverting the fix: reverting `release()` and the
`ended` latch together failed **6 distinct tests**; the waveform/overlay/scrubber
agents each ran 8–20 mutations. Keep doing this. Three agents also found that
**their own tests were vacuous** during the process — that is the process working.

---

## 6. Two device-only traps that jest cannot catch

1. **The waveform's maths is NOT workletised.** `waveform.ts`'s exports are
   ordinary functions, so calling `envelope()` from inside a worklet throws
   `[Worklets] Tried to synchronously call a Remote Function` **on device**, while
   **passing under jest** (one runtime). The component therefore pre-samples 64
   envelope values per bar on the JS thread and the worklet does array arithmetic
   only (worst error 1.4e-3 of an envelope = 0.04 px on a 30 px bar). **A future
   agent "optimising" that sampling would ship a crash with CI still green.** This
   needs a prominent comment in the file and is a standing trap.

2. **Jest never runs `processFilter`,** so the orb blur is unverifiable from JS —
   an invalid filter value passes straight through into the rendered style and
   only fails on device. `AmbientOrbs` uses a module-load-time guard that
   **throws** rather than degrading, because `processFilter` is all-or-nothing
   ("If any primitive is invalid then apply none of the filters… return `[]`") and
   a soft failure renders a hard-edged circle with nothing logged.

Also: **Android below API 12 applies no blur at all** —
`BaseViewManager.java:556-558` reaches `setRenderEffect` only inside an
`SDK_INT >= S` branch, with no `else` and no log. No fallback was added
(needs `expo-blur` or assets). Decide before shipping.

---

## 7. Phase 3 — the next phase, and the research it still needs

**Gate: Phase F — done.** This is the highest-risk phase in the rebuild.

### 7a. The research that MUST be done first (and did NOT complete)

Two research agents were dispatched to answer these and **both failed on network
certificate errors**. The answers are not in the repo yet. **Run this research
before writing any Phase 3 code.**

**Backend contract questions** (read the source, not `docs/FRONTEND-REQUIREMENTS.md`
— it is stale):
- Exact accepted/required fields and response codes for
  `POST /interactions/{id}/register-skip/` and `.../log-telemetry/`. Is
  `SkipActionSerializer.reel_id` required-but-never-read? Does the plain
  `Serializer` **silently drop** unknown keys rather than 400 — which would mean a
  client may send `position`/`duration` and have them discarded?
- Units for every field crossing the ms↔s boundary (`expo-audio` is SECONDS,
  the backend is milliseconds).
- Does `_completion_rate` use `clip.duration_ms` (server state) as the divisor?
  What happens when `duration_ms` is 0? (Note: `record_telemetry` uses
  `max(clip.duration_ms, 1)` while `record_skip` falls back to 60,000 — two
  different "unknown duration" answers, one of them catastrophic.)
- Any server-side plausibility check at all? Any per-(user,clip) cap, daily
  aggregate cap, or monotonicity requirement?
- Confirm `UserInteraction.completion_rate` is **write-only** (the ranker reads
  `AudioClip.avg_completion_rate`), so telemetry cannot poison the recommender and
  `register-skip` is the only poison path.
- Throttle scope/rate/cache-key per endpoint. Does `log_telemetry` escape the
  global per-user throttle?
- Minor case: exact response, and is the clip id validated for a minor?

**Two prior-audit claims to verify or refute** (these are the two I most want to
be sure about):
- (a) `redis_cache` runs `maxmemory-policy allkeys-lru` while storing **both**
  throttle keys and 24 h `processed_event:*` dedup keys, so a telemetry flood
  can **evict rate-limit keys for the whole API** — a self-amplifying loop.
- (b) `flush_telemetry_stream` uses `bulk_create` **without** `ignore_conflicts`
  against a real `UNIQUE(user, clip, interaction_type)` constraint (verify in the
  migration), so two duplicate posts in one batch window send the whole batch's
  `processed_ids` to a dead-letter queue and **permanently discard every
  legitimate event in that batch**.

> **NOTE:** the owner has said **do not touch `backend/`**. These are reported
> for the record only. If (b) is true it is a live data-loss bug and the owner
> should decide separately whether someone fixes it.

### 7b. The task list (one task per agent, sequential within the phase)

| # | Task | The trap |
|---|---|---|
| 3a | `useWatchTelemetry` — 5 s heartbeat from `player.currentTime` | **not** wall-clock; pauses/buffering/failed loads corrupted the old measurement |
| 3b | Completion guard as a **pure, exhaustively-tested** function: `shouldRegisterSkip({positionMs, durationMs, userInitiated})` | the guard is the whole point of the phase — it is client-side only, so a client bug is a production incident |
| 3c | Flush on pause/skip/background/unmount; 1-per-5 s cap; **drop-oldest** on 429 | `log-telemetry` is 60/min, so a sustained 1 Hz client 429s after ~60 s |
| 3d | 403 from `log-telemetry` ⇒ minor. Surface it, never retry | |
| 3e | `src/api/endpoints/interactions.ts` | all three actions return bare objects, not envelopes |
| 3f | `ActionCluster` + like with optimistic + rollback, `Math.max(0,…)` floor, in-flight guard, **re-read the server's `data.status`** | re-POSTing the same state does not re-toggle |
| 3g | Double-tap-to-like + heart burst — **design from scratch** | no source exists anywhere in git |
| 3h | `CommentSheet` — list, post, reply(`parent`), edit own, delete own | the list uses the **Cursor** envelope `{next, previous, results}` with **no `count`**; edit is PATCH, delete is DELETE |
| 3i | `ShareModal` — `find-user` debounce → `send-share` | **POST**, not GET |
| 3j | Follow/unfollow — **POST** | the web client sent GET and got a silent 405 |
| 3k | Hands-free auto-advance: `progress >= 0.99` → 1000 ms → advance | now possible because `'ended'` is latched (§4.3) |
| 3l | **Buffering timeout** → re-mint token, retry once | an expired token is a *stall*, not an error (§4) |

### 7c. Verified backend contracts Phase 3 depends on (already confirmed)
- `toggle-like` → `POST /interactions/{clip_uuid}/toggle-like/` → `200 {status:"liked"|"unliked"}`
- `register-skip` → `POST /interactions/{clip_uuid}/register-skip/` → **201**
- `log-telemetry` → `POST /interactions/{clip_uuid}/log-telemetry/` → **202**;
  **403** for a minor
- comments: `GET /comments/?clip={uuid}&parent={uuid}` (Cursor, page 20),
  `POST /comments/`, `PATCH`/`DELETE /comments/{uuid}/` (author-only, 404 for
  others), 60/hour
- `GET /share/find-user/?username=X` → `{id, username}` | 404
  · `POST /share/{clip_uuid}/send-share/` body `{receiver_id}` → 201
- `POST /share/{share_uuid}/mark-read/` → 204 · `GET /share/inbox/` → **bare
  top-level array**
- `POST /follow/{user_id}/toggle-follow/` → `{status:"followed"|"unfollowed"}`
- **No `/api/v1/` prefix** except the media-worker heartbeat
  (`urls.py:9,13`). Several docstrings in `views/subscription.py` are wrong about
  this.

### 7d. The plan itself has a defect to fix first
`docs/EXPLAIN/decisions/2026-09-29-mobile-task-list.md` item **4.8** says the
CommentSheet must support "edit own, delete own" — and `AGENTS.md`'s
"known-failure" note records that `Comment.parent` is client-supplied and never
checked against `parent.clip`, pinned by a strict `xfail`. **Do not build replies
until that is decided**, or a reply can be filed under one clip and read under
another.

---

## 8. Phase G — device verification, and why nothing is proven yet

**No layout, audio decode, gesture, or lock-screen behaviour has been observed on
a real runtime.** `tsc`, Jest and `expo export` lay out no pixels and decode no
audio. The zero-height-cell bug that Stage D fixed was invisible to all three.

Blocker: **iOS Simulator is impossible on Linux** (needs macOS), so only the
**Android emulator** can satisfy the Phase 2 exit criterion.

### SDK status (in `~/android-setup/`, durable across reboots — `/tmp` is NOT)
`4/5` packages installed, **3.0 GB**. Only the **system image** is outstanding;
it was mid-download when the laptop restarted. The machine has restarted at
least twice and `/tmp` was cleared both times.

**To finish:**
```bash
bash ~/android-setup/get-sdk.sh 2>&1 | tee ~/android-setup/get-sdk.log
```
It is idempotent (skips what is installed), so re-running after an interruption
is the correct response. **Expect it to fail on a flaky link and just re-run it.**

Then: `avdmanager create avd -n echoflow -k "system-images;android-36;google_apis;x86_64" -d pixel_6`
and boot with `emulator -avd echoflow -no-window -gpu swiftshader_indirect` (the
host is headless; `Xvfb` was installed as a fallback).

### The verification checklist — what Phase G must actually prove
1. The reel cell is **non-zero height**. Everything else depends on it.
2. **Audio decodes.** A real token over the real HLS edge.
3. A vertical flick starting on the progress bar **scrolls the feed** (the §7
   directional arbitration, which is only tested through a responder model).
4. A tap in the band where `ClipTransport` used to swallow touches reaches
   play/pause.
5. Scrubbing moves `currentTime` and the fill tracks.
6. The orbit blur renders — **unverifiable from jest** (§6).

### Two environment prerequisites for playback
- **The HLS token Worker must be running** or playback is a **502**:
  `bash scripts/run-hls-worker-local.sh`. `PUBLIC_HLS_ENDPOINT_URL` points at
  the validating edge.
- **The emulator's `localhost` is the emulator.** Use
  `adb reverse tcp:18443 tcp:18443` and `adb reverse tcp:19443 tcp:19443`, or
  `10.0.2.2` for the host alias.
- `celery_media_local` / `celery_feed_local` / `celery_beat_local` run a **baked
  image with no `/app` bind mount** — a `backend/` edit is invisible to them
  until a rebuild or `docker cp` + restart.

---

## 9. Open items and unaddressed problems

| Item | Severity | Status |
|---|---|---|
| `tintSteps` opacity 1.65–2.55× off CSS | visual | **awaiting owner decision** (§3) |
| Nothing verified on a device | **blocking** | Phase G (§8) |
| Android < API 12: no orb blur, no fallback | visual | undecided |
| Timecode `Text` is a ~40×14 dead spot | minor | **known and NOT fixed** — `pointerEvents` is not plumbed to native `Text` in RN 0.86, so the obvious fix is a test-passing no-op |
| Waveform worklet constraint | latent | mitigated by pre-sampling; a standing trap (§6) |
| `Comment.parent` never validated against `parent.clip` | **security/data** | pinned by a strict `xfail`; blocks reply support |
| Backend P0s (cache eviction of throttle keys; `bulk_create` batch loss) | **security/data** | reported; owner said do not touch `backend/` |
| Playback-token cache is not cleared on logout | **security** | same-device user switch can reuse the previous user's per-clip tokens for up to the TTL. `mobile/src/store/auth.ts::logout()` does not clear `src/lib/playbackTokenCache.ts` |
| `license_type='Unknown'` gap | legal | documented in `docs/EXPLAIN/compliance/01-license-type-unknown-gap.md`, unfixed by decision |

---

## 10. Operating rules for the agents — these were learned the hard way

### Parallelism
- **Research first, in parallel, across domains, before implementing anything.**
  Three research agents (Reanimated readiness, hostile-client threat model,
  expo-audio semantics) each found defects that would otherwise have been
  written around. Two of them **contradicted the brief** — see below.
- **One small task per agent.** Never hand an agent a phase.
- Give every agent: the source material, the exact files it owns, the files it
  must NOT touch, the house conventions, and the instruction to **gather context
  before changing anything** and to **stop and report if a premise turns out to
  be wrong**.
- **Agents will contradict you, and they are sometimes right.** The
  `transformOrigin` brief said to put it on a parent `View`; the agent refused
  with evidence (it is a per-view native prop, nothing inherits it) and was
  correct. Take that seriously — ask for the citation.

### Concurrency
- Reserve hot files to **one owner per wave**: `src/store/**`, `app/**` and
  `jest.config.js` were each explicitly single-owner.
- Never `git add .`, `git add -A`, or `git add backend/`. **Stage explicit
  paths.** Another agent is active in this repo.
- Never `git commit` from an agent. Review and commit yourself.
- When an agent reports failures in a file it does not own: **wait and re-run.**
  Three agents saw phantom failures from concurrent writes; every one turned out
  to be exactly that.

### Verification (non-negotiable, per the repo's own working agreement)
- `tsc --noEmit` clean, **and** the full Jest suite **run at least twice** with
  identical results.
- **Check the harness is healthy before believing any number.** A concurrent
  pytest run against the shared `echoflow_test` DB makes another suite's teardown
  drop it mid-run and produces hundreds of phantom errors.
- Every new test must be **shown red** by reverting its fix.
- Reanimated assertions use `getAnimatedStyle` + fake timers before render (§5).

### Environment
- **`/tmp` is cleared on reboot on this machine.** The laptop has restarted
  twice mid-task. Durable files go in the repo or `$HOME`
  (`~/android-setup/`), never `/tmp`.
- The network is flaky and has failed agents with certificate errors. **Re-run
  anything that failed on network rather than concluding it is broken.**
- `git gc` reports too many unreachable objects; `git commit` warns but succeeds.
  Do not prune without diagnosing — other agents are active.

---

## 11. Complete document index

| Document | What it is |
|---|---|
| `docs/mobile/00-verification.md` | Phase-0 state audit; the five plan corrections; 14 verified backend contracts; the "claimed but unproven" list |
| `docs/mobile/01-plan.md` | Phases F, 3, 4, 5, 6, 7, G with per-task exit criteria and sequencing rules |
| `docs/mobile/02-phase-log.md` | Per-commit execution log: problem, evidence, rejected alternative, verification, what was not done |
| `docs/EXPLAIN/decisions/2026-09-29-mobile-task-list.md` | Task-level contract with backend citations |
| `docs/mobile-rebuild-plan.md` | Master plan — **verify against §5 of `00-verification.md`** |
| `docs/EXPLAIN/storage/04-hls-token-protection.md` | Token transport and edge validation |
| `AGENTS.md` | Repo-wide quick-start, gotchas, session learnings, working agreement |
