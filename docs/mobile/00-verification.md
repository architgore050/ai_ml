# Phase 0 — Verification: what is actually built, and what is only claimed

Date: 2026-09-30. All statements below were checked against the code in this
repo, not inferred from a plan or a previous report. Where something is claimed
but unproven, it says so.

---

## 1. Baseline measurements

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **exit 0, clean** |
| Jest | `npx jest` | **221 passed / 0 failed, 15 suites** |
| iOS bundle | `npx expo export --platform ios` | succeeds |
| Android bundle | `npx expo export --platform android` | succeeds |
| Backend suite | `pytest backend/app/tests/` | **704 passed / 2 failed / 7 skipped** |
| Android emulator | — | **NOT AVAILABLE** (see §6) |

The 2 backend failures are `test_services_interactions.py::TestRecordSkip`
(completion aggregation, `assert 0.25 == 0.5`). They are **not mobile-owned and
not mine**: the last commit to `backend/app/services/counter_store.py` is
`12ceb72`, verified via `git merge-base --is-ancestor 12ceb72 cc1b69f~1` to
predate all mobile Phase 2 work. Another agent is fixing them.

> **Harness warning that will bite again.** A run reported `412 errors` with
> `ProgrammingError('database "echoflow_test" does not exist')` at teardown. Cause:
> two pytest runs against the shared test database; one's teardown drops it while
> the other is using it. The re-run gave 704/2. Before believing any backend
> number, confirm no other suite is running and no container is `Restarting`.

---

## 2. Phase 1 — auth. COMPLETE

| Item | Evidence |
|---|---|
| expo-router route groups, `scheme: echoflow` | `app/(auth)/`, `app/(tabs)/` |
| Register sends `consent_accepted`, `terms_version`, `dob`, `parent_email` if <18 | `app/(auth)/register.tsx` (355 lines) |
| `consent_accepted` unchecked by default | DPDP §11 |
| Login → `SecureStore`; logout → `POST /auth/logout/` | `src/api/tokenStore.ts` |
| Silent restore, proactive refresh, 401 replay-once | `src/api/client.ts` (379 lines) |
| Error boundary at navigator root | `src/components/ErrorBoundary.tsx` |
| `useBackendStatus` on a 30 s timer | `src/hooks/useBackendStatus.ts` |
| https-only base URL, fails the build on `http://` | `app.config.ts` `assertHttps` |

## 3. Phase 2 — feed + player core. TRANSPORT COMPLETE, VISUALS MISSING

### 3.1 Done and tested

| Item | Where | State |
|---|---|---|
| One app-wide `useAudioPlayer`, `createAudioPlayer`, lazy singleton | `src/store/player.ts` | 100% stmt |
| Per-clip token cache, 600 s TTL, 120 s refresh margin | `src/lib/playbackTokenCache.ts` | tested |
| `POST /media/playback-token/{id}/` + `X-EchoFlow-Client: native` | `src/api/endpoints/feed.ts` | tested |
| Token as `X-EchoFlow-Media-Token` request header | `player.ts:loadClip` | verified live |
| `hls_playlist_url` used **verbatim** | `player.ts:280` | never rebuilt/prefixed |
| 4-state error mapping: 409 / 403 / 404 / 200 | `src/lib/playbackDecision.ts` | unit-tested |
| 409 retry at 5 s | `app/(tabs)/index.tsx:232` | tested |
| 202 cold-start parsed, honours `retry_after_ms` | `src/lib/feedBuffer.ts` | tested |
| Destructive-`lpop` discipline, 60-cap dedup buffer | `src/lib/feedBuffer.ts` | tested |
| Measured cell height + `getItemLayout` + momentum scroll-end | `src/lib/feedViewport.ts` | tested |
| Native status is the authority for "playing" | `src/hooks/PlayerHost.tsx` | 100% stmt |
| Lock-screen `setActiveForLockScreen`, no artwork | `PlayerHost.tsx` | wired |
| `interruptionMode: 'duckOthers'` | `src/lib/audioMode.ts` | 100% stmt |

### 3.2 NOT done — the whole of the visual layer

| Item | Status |
|---|---|
| Ambient orbs | **absent** |
| 40-bar deterministic waveform | **absent** |
| Tap-to-toggle-play | **absent** |
| Play/pause overlay (100 px) | **absent** |
| Seekable progress bar | **absent** — `ProgressBar` in `ui/Button.tsx` is a non-interactive placeholder |
| Timecode, ±10 s skip, hands-free toggle UI | **absent** (store has `handsFree`, nothing renders it) |
| `ReelCard` in its own module | **no** — it is inline in `app/(tabs)/index.tsx:364-420` |
| `ActionCluster`, `LikeButton`, `CommentSheet`, `ShareModal` | **absent** |
| Tag chips as chips (currently a joined string) | not done |
| Gradient tokens | **absent** — `tokens.ts` has no gradient definitions at all |

**Phase 2 exit criterion is therefore NOT met.** It requires "one clip plays
end-to-end in a simulator with a real token, and scrubbing works." No simulator
has been run (§6), and no scrub UI exists.

## 4. Phases 3–7. NOT STARTED

- **Phase 3 (interactions):** no like, no comment, no share, no follow, no
  telemetry. `registerSkip` is deliberately absent — the plan forbids sending
  telemetry before the completion guard lands, because the old app's skip-on-
  completion corrupted `avg_completion_rate` (defect 2).
- **Phase 4 (explore / profile / inbox):** all four are **44-line placeholder
  screens** that render "Coming in Phase 4". `explore.tsx`, `inbox.tsx`,
  `profile.tsx`, `studio.tsx`.
- **Phase 5 (upload):** nothing. No recording, no picker, no progress, no
  moderation poll.
- **Phase 6 (settings / legal / Pro):** nothing.
- **Phase 7 (distribution / E2E / CI):** no `eas.json`, no `e2e/`, no CI.

Total: **5,270 LOC**, of which the feed screen is 512 and the player store 335.

---

## 5. Corrections to the governing plan

Research against the real source produced five inaccuracies in
`docs/mobile-rebuild-plan.md` / the task list. These change what gets built:

1. **Double-tap-to-like and the heart burst have NO source to port.** The plan
   (line 696) lists them under "Ported from `frontend/src`". Exhaustive search
   across all reachable commits finds no `onDoubleClick`, no heart-burst
   animation. The tracked `frontend/src` never had them. They must be designed,
   not ported.
2. **`sample_frontend2` is deleted, not gitignored.** The plan's token-provenance
   comment says "gitignored (.gitignore:26)"; those lines are gone. It survives
   only in commit `20451d3` and is readable via
   `git show 20451d3:frontend/sample_frontend2/...`. The tracked
   `frontend/src/styles/tokens.css` is a faithful port of `globals.css` and is
   the better diffable source — but it does **not** contain the orbs, the 40-bar
   waveform, the play overlay or the 135° gradient.
3. **The 40-bar waveform's height formula can go NEGATIVE.** Source is
   `8 + sin(i*0.4)*12 + Math.random()*10` → theoretical min **−4 px**, which is
   invalid CSS. There is no min/max in any source. The plan already rejects the
   `Math.random()` and specifies a *deterministic* envelope; the tracked web
   already implements one at `frontend/src/stores/player.tsx:139-164`. That is
   the source to use, and it must be clamped.
4. **`active:scale-0.96` never existed in any web frontend.** It is a
   plan-invented value, already implemented in `mobile/src/components/ui/Button.tsx:109`.
   The web uses `-95`. No work needed; the comment claiming provenance is wrong.
5. **`tintSteps` is missing `'10'`.** The reel-card backdrop gradient needs
   `${c}10` (alpha 0.0625); `tokens.ts:185-193` has `08, 0A, 18, 22, 33, 44, 55`.

## 6. Verified backend contracts the client must honour

Confirmed against the code, with citations, because each one fails *silently*
if the client guesses wrong:

| # | Fact | Where |
|---|---|---|
| 1 | **Four** list envelopes coexist: PageNumber `{count,next,previous,results}` (`GET /clips/`, `GET /share/`); Cursor `{next,previous,results}` **no count** (`GET /comments/`, `/suggestions/`, `/profile/{id}/clips/`); hand-rolled `{next:"auto_trigger",…}` (`GET /feed/`); **bare top-level array** (`GET /share/inbox/`, and `liked_clips` inside `/profile/me/`) | `views/_pagination.py`, `feed.py:123`, `social.py:206`, `serializers.py:833` |
| 2 | The 202 cold-start body has **no `next`** — so a feed schema requiring it must make it optional | `feed.py:92-100` |
| 3 | `log-telemetry` accepts **only** `action_type` and `watch_time_ms`. It is a plain `Serializer`, so extra keys are **silently dropped, not 400'd** — sending `position` looks like it works | `serializers.py:555-561` |
| 4 | `log-telemetry` returns **202**, and **403 for minors** | `interactions.py:65-85` |
| 5 | The `position < duration × 0.9` completion guard is **100% client-side**. `record_skip` clamps and never refuses — a client that skips on natural completion really does corrupt the ranker | `interactions.py:167-188, 239` |
| 6 | `SubscriptionStatusSerializer.limits` stringifies everything, including `hd_quality_allowed` → the literal `"True"` / `"False"` | `serializers.py:895` |
| 7 | Upload multipart field is `original_file`, and it is `required=False` — so a title-only POST passes validation and bypasses size, extension, magic-byte and duration checks entirely | `serializers.py:236, 278-364` |
| 8 | Upload returns **202** `{message, clip_id, status}` | `content.py:216-224` |
| 9 | `approve-moderation` returning **400 `{status:"rejected"}` does NOT set `clip.status='rejected'`** — the DB row stays `processing` for ever. That 400 body is the only rejection signal on this path | `content.py:293-299` vs `tasks.py:327` |
| 10 | `moderation_approved` is **not** in `AudioUploadSerializer.Meta.fields`, so it is unreadable from `GET /clips/{id}/` | `serializers.py:236` |
| 11 | Clip `status` values are `processing / ready / failed / rejected`, with **no `choices=`**, so unknown values must be tolerated | `models.py:170` |
| 12 | `mark-read` is **POST**; `toggle-follow` is **POST**; `send-share` is **POST**. Both existing clients got these wrong | `social.py:191, 221, 127` |
| 13 | `SkipActionSerializer.reel_id` is `required=True` but **never read** — omit it and you 400; send it and it is discarded | `serializers.py:507` vs `interactions.py:41-46` |
| 14 | There is **no `/api/v1/` prefix** except the media-worker heartbeat. Several docstrings in `views/subscription.py` are wrong about this | `urls.py:9,13` |

Confirmed absent, so the plan must not build against them: full-text search,
push device registration, follower/following lists, saved/library, native IAP.

## 7. Unproven claims — things that look done but are not verified

1. **"The feed renders."** `tsc`, Jest, and `expo export` all pass, and none of
   them lay out a single pixel. The zero-height-cell failure that `Stage D`
   fixed was invisible to all three.
2. **"Audio plays."** The token transport was verified with real HTTP against
   the live stack, and the HLS manifest fetches. Nothing has decoded audio.
3. **"Lock-screen controls work."** `setActiveForLockScreen` is called, but
   under `duckOthers` **iOS association is not guaranteed** — Expo requires
   `doNotMix`. Android sustained background playback does need the call, which
   is why it is wired.
4. **"iOS is covered."** An iOS Simulator requires macOS. This machine is Linux.
   iOS is unverified and cannot be verified here.
5. **"221 tests"** is a Jest count, not a behavioural count. The coverage config
   deliberately excludes `src/design/**` and `src/components/**`, so component
   render paths are unmeasured.

## 8. Environment facts that will shape Phase G

- `/dev/kvm` **exists** → Android emulator is viable.
- iOS Simulator: **impossible** (Linux).
- `PUBLIC_HLS_ENDPOINT_URL` points at the validating edge, so the HLS token
  **Worker must be running** (`scripts/run-hls-worker-local.sh`) or playback
  returns 502. Currently not running.
- `celery_media_local` / `celery_feed_local` / `celery_beat_local` run a **baked
  image with no `/app` bind mount** — a `backend/` edit is invisible to them
  until a rebuild or `docker cp` + restart.
- `/tmp` is **cleared on reboot** on this machine. Durable work belongs in the
  repo (`docs/mobile/`) or `$HOME`, never `/tmp`.
