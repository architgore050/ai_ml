<task id="ses_f0f3c415effe3PDh8g4TGIZtrQ" state="completed">
<task_result>
I did not modify any file. All commands were read-only (`git status`/`log`/`branch` only). Note: `mobile/app/(tabs)/index.tsx` and `mobile/src/components/reel/` are modified/untracked by a concurrent agent — I did not read them and they are out of scope.

---

# Media/Player Reconnaissance Report — EchoFlow React frontend

**Files read in full:** `frontend/src/stores/player.tsx` (401L), `ReelList.tsx` (227L), `MiniPlayer.tsx` (107L), `ReelCard.tsx` (456L, partial), `mediaMock.ts` (158L), `types/echoflow.ts` (93L), `api/client.ts` (448L), `setupTests.ts`; backend `views/interactions.py` (97L), `services/interactions.py` (353L), `views/media.py` (284L), `services/feed_pool.py` (308L), `services/entitlements.py`, `media_urls.py`, `tasks.py` (§555-880, §1195-1420), `serializers.py` (§374-620), `settings.py`; `workers/hls-token-worker/src/token.ts` (205L), `index.ts`; `docs/EXPLAIN/storage/04-hls-token-protection.md`, `docs/FRONTEND-REQUIREMENTS.md` (§1.6, §1.7, §3.5, §4.7, §4.8).

---

## AREA 1 — Telemetry: `watch_time_ms`, `completion_rate`, and reachability

### 1.1 Every call site of the telemetry API, with the exact expression

There are **exactly three** `logTelemetry` call sites in the entire repo, all in `player.tsx`. Verified by reading; `interactionsAPI.logTelemetry` has no other callers.

| # | Site | Exact expression sent | Fires on |
|---|---|---|---|
| 1 | `player.tsx:79-82` | `action_type: "view"`, `watch_time_ms: Math.floor(cur * 1000)` where `const cur = audio.currentTime` (`:68`) | `timeupdate`, throttled to ~1/6 s (`:77`) |
| 2 | `player.tsx:97-100` | `action_type: "view"`, `watch_time_ms: Math.floor(audio.currentTime * 1000)` | `pause` event |
| 3 | `player.tsx:169-172` | `action_type: "view"`, `watch_time_ms: Math.floor(duration * 1000)` where `duration` is **React state** captured from the enclosing render | `handleAutoAdvance` — **dead, see §2** |

`registerSkip` has **exactly one** call site, `player.tsx:332-336`:

```ts
interactionsAPI.registerSkip(currentClip.id, {
  listen_duration_ms: Math.floor(currentTime * 1000),
  reel_position_ms:   Math.floor(currentTime * 1000),   // identical
  reel_id:            currentClip.id,
})
```

All three are **media position**, not watch time. The audit is right about the *shape* of the defect.

### 1.2 What the backend actually reads

**`log-telemetry`** → `views/interactions.py:79-84` → `services/interactions.py:259-291`:

```python
clip_duration = max(clip.duration_ms, 1)                          # :282
completion_rate = min(watch_time_ms / clip_duration, 1.0)          # :283
```

Reads **only** `action_type` and `watch_time_ms` (`serializers.py:555-561`, `IntegerField(min_value=0, max_value=36_000_000)`). The 10-hour cap is a value bound, not a plausibility check.

**`register-skip`** → `views/interactions.py:41-46` → `services/interactions.py:191-256` → `_completion_rate` (`:167-188`):

```python
expected_duration = clip.duration_ms or 0
if expected_duration <= 0:
    expected_duration = 60_000
listened = max(0, min(int(listen_duration_ms or 0), expected_duration))
return min(listened / expected_duration, 1.0)
```

**I confirmed on disk that the divisor is server-side** (`clip.duration_ms`), as the brief stated. Commit `20f6e7e "fix(ranking): stop completion_rate being client-writable and pin-able"` did land and did remove the `reel_position_ms` divisor.

### 1.3 Verdict on the audit's P0-2 — **CONFIRMED on mechanism, IMPRECISE on impact. It names the wrong field.**

The audit says: *"`interactions.py:242` computes `completion_rate = min(watch_time_ms / clip_duration, 1.0)`, and `avg_completion_rate` is **30 % of the recommendation score`. Seek-to-end yields a perfect completion for a clip never watched."*

Three problems with that sentence:

**(a) `interactions.py:242` is the wrong line** — it's inside the `except` block of `record_skip`'s counter-store write. The line the audit is describing is `:283`, in `record_telemetry`.

**(b) `AudioClip.avg_completion_rate` — the field that is 30 % of the score — is *not reachable from the telemetry path at all* under the default configuration.** I traced this exhaustively. `avg_completion_rate` is written in exactly one place, `_apply_completion_deltas` (`tasks.py:1386-1390`), fed only by `counter_store` drain. `counter_store.add_completion` has exactly **two** production callers:

- `services/interactions.py:238` — inside `record_skip`
- `services/interactions.py:313` — inside `record_telemetry`'s **Tier-3 last-resort** `except` handler, reached only when *both* `_xadd_telemetry` and `_rpush_telemetry` have already raised

`record_telemetry` returns at `:295` immediately after a successful `XADD`. `_use_stream()` (`:94-96`) returns True unless `ECHOFLOW_TELEMETRY_STREAM` is `off`/`0`/`false`. I grepped every `.env*` file and all three compose files: **the variable is set nowhere.** The default is the stream path. The stream consumer `flush_telemetry_stream` writes `UserInteraction` rows only (`tasks.py:800-807`) and calls **no** counter-store function.

> **So: `POST /interactions/{id}/log-telemetry/` does not, and under the default config cannot, move `AudioClip.avg_completion_rate`. The only endpoint that writes the 30 %-weighted field is `POST /interactions/{id}/register-skip/`.**

**(c) But the exploit is real — through a different, less-examined channel.** Telemetry's client-derived `completion_rate` *is* persisted to `UserInteraction.completion_rate` (`tasks.py:805`) and that column **is** read by the ranking hot path, as the dwell weight:

```python
# ai_ml/pipelines/recommendation.py:124
comp_weight = interaction.completion_rate if interaction.completion_rate > 0 else 0.1
final_weight = time_weight * comp_weight * intent_weight      # :133
```

feeding `calculate_time_decayed_vectors` → `feed_pool.rebuild_user_explore_pool` (`feed_pool.py:200`) and the SQL fallback (`recommendation.py:229`). Seek-to-end on clip X multiplies X's 384-dim vector by ~1.0 instead of ~0.1, so X dominates the user's blended profile (ALPHA=0.7, `:152`). **A user can pull any clip they can name into their own feed by seeking to its end once.** That is a *personalisation* exploit against the attacker themself, which is a much weaker attack than the cross-user ranking manipulation the audit implies — but it is also completely untested and undocumented.

**(d) The 30 % field is still client-writable, just bounded.** `_completion_rate` clamps the numerator to `clip.duration_ms`, so a client can no longer produce a ratio > 1 or pin it at 1.0 by sending `listen == reel`. But it can still send `listen_duration_ms = clip.duration_ms` on every single skip and get `completion_rate = 1.0` for every one of them. `SkipActionSerializer` (`serializers.py:504-507`) has **no `max_value`** on either integer. The commit fixed the *ratio* exploit, not the *claim* exploit. The plan's framing ("stop completion_rate being client-writable") overstates what landed.

### 1.4 `watchTimeRef` — audit **CONFIRMED, exactly as stated**

```
frontend/src/stores/player.tsx:47   const watchTimeRef = useRef<number>(0);
frontend/src/stores/player.tsx:72   watchTimeRef.current += 250; // increment watch time
frontend/src/stores/player.tsx:185  watchTimeRef.current = 0;
```

Three occurrences, **zero reads**. It is a dead accumulator that increments a hardcoded 250 ms per `timeupdate`, i.e. it assumes exactly 4 Hz. The HTML spec says `timeupdate` fires 15–250 ms, so this is wrong by up to ±16× on some browsers and it's never transmitted regardless.

### 1.5 Scoring impact — the formula and the weights

`ai_ml/pipelines/recommendation.py:59-61` is the canonical constant; `feed_pool.py:150-155` and `:223-228` mirror it in the ORM `ExpressionWrapper`:

```
composite_score = 0.45 * vector_similarity
                + 0.30 * avg_completion_rate
                + 0.25 * engagement_velocity
```

Cold-start branch (`feed_pool.py:159-161`) drops the formula entirely and ranks on `engagement_velocity` alone.

| Term | Weight | Client-writable? | Path |
|---|---|---|---|
| `vector_similarity` | 0.45 | No (server-side pgvector) | — |
| `avg_completion_rate` | 0.30 | **Yes, bounded to [0,1]** — via `register-skip` only | `record_skip` → `counter_store` → `flush_counters_to_pg` |
| `engagement_velocity` | 0.25 | Indirectly (likes/shares/skips counters) | `counter_store.increment` |

Plus the un-weighted-but-real channel: `UserInteraction.completion_rate` → dwell weight → user vector → 20 % explore pool.

### 1.6 Blast radius (grep-proven)

A correct `watch_time_ms` fix touches:

- `frontend/src/stores/player.tsx` — all 3 telemetry sites (`:79`, `:97`, `:169`), `watchTimeRef` (`:47`, `:72`, `:185`)
- `frontend/src/api/client.ts` — no change needed (`watch_time_ms: number` already, `:307`)
- `docs/FRONTEND-REQUIREMENTS.md:285-286` and `:1229-1234` — **both prescribe the exploit.** FR-TEL-2 says *"on auto-advance at `progress >= 0.99`: send `listen_duration_ms ≈ clip.duration_ms`"*. FR-TEL-1 says *"On `ended` (final value = `clip.duration_ms`)"*. If you fix the client and leave the spec, the next agent re-introduces the bug. `:282-286` also documents the **pre-`20f6e7e`** `expected_duration = reel_position_ms` formula and is now wrong.
- `docs/EXPLAIN/storage/04-hls-token-protection.md` — unaffected
- Backend: **nothing needs to change.** `InteractionTelemetrySerializer` already accepts any `int >= 0`. The server has no way to distinguish real watch time from claimed watch time, and no way ever will.

Unrelated but adjacent: `docs/old_docs/event-driven-architecture-plan.md:62` describes Tier 3 as a "synchronous `UserInteraction.update_or_create`" — also stale.

### 1.7 What a correct fix must preserve

1. **The 6 s heartbeat cadence** (`:77`) — the server's `telemetry` scope is `60/min` (`settings.py:763`); the current 1-per-6 s is 10/min, and FR-TEL-1's "cap at 1 call / 5 s" is the stated contract.
2. **Telemetry is non-fatal.** All three sites `.catch(() => {})`. A correct fix must keep that — a 429 or a network blip must not interrupt playback. (It also means 429s are invisible, which is the audit's item 21, a separate problem.)
3. **The payload shape.** `InteractionTelemetrySerializer` accepts only `action_type` and `watch_time_ms`. You cannot add a field without a serializer change; you do not need to.
4. **`watch_time_ms` must be monotonic within a clip and reset on clip switch** — including on seek. A `seeking`/`seeked` handler that adds the jump to the accumulator defeats the whole fix. `mediaMock.ts:104-113` already fires real `seeking`/`seeked`, so the harness can prove this.
5. **Heartbeats must be suppressed while paused.** `timeupdate` does not fire when paused, so this is free — but only if you don't also hook `seeked`.

### 1.8 Tests that would prove the fix

- Seek a 10-minute clip from 0 → 600 and assert the *next* heartbeat reports ≈ the actually-elapsed seconds, not 600 000. `advanceTo(600)` on `MockAudio` then `emitTimeUpdate()`.
- Advance 0 → 10 in 10 one-second steps and assert the reported total is 10 000 ms, not 10 × 250 ms.
- `advanceTo(5, {seek: true})` then `advanceTo(6, {seek: false})` → assert only 1 000 ms is credited for the second step.
- Reset assertion: play clip A for 20 s, `playClip(B)`, play B for 2 s, assert the reported value is ~2 000 and not 22 000.
- Backend invariant test (worth adding even though no backend change is needed): `record_skip(listen_duration_ms=clip.duration_ms)` produces `completion_rate == 1.0` — pin the *bounded* exploit so a future change that removes the clamp is caught.

---

## AREA 2 — Auto-advance: is it dead, and how many advance paths exist?

### 2.1 Enumerating every advance path

| # | Path | Line | Delay | Status |
|---|---|---|---|---|
| **A** | `timeupdate` → `cur/dur >= 0.99` → `handleAutoAdvance()` | `player.tsx:86-88` | — | **DEAD** |
| **B** | `ended` → `handleAutoAdvance()` | `player.tsx:104-106` | — | **DEAD** |
| **C** | `handleAutoAdvance` → `setTimeout(() => nextClip("auto"), 800)` | `player.tsx:175-177` | 800 ms | **UNREACHABLE** (A and B are dead) |
| **D** | `ReelList` effect on `progress >= 0.99` → `setTimeout(scrollIntoView, 1000)` | `ReelList.tsx:98-106` | 1000 ms | **LIVE — the only automatic advance** |
| **E** | `ReelCard` "Next" button → `nextClip("manual")` | `ReelCard.tsx:379-386` | 0 | LIVE |
| **F** | `MiniPlayer` "Next" button → `nextClip("manual")` | `MiniPlayer.tsx:92-102` | 0 | LIVE |
| **G** | IntersectionObserver ≥ 0.6 visible → `playClip(clip, clips)` | `ReelList.tsx:76-95` | 0 | LIVE (this is what makes D feel like auto-play) |

`nextClip("auto")` is called from exactly one place (`:176`) and is therefore **unreachable**. The `reason === "auto"` branch is dead. The audit is right.

### 2.2 Verdict on P0-3 — **CONFIRMED, and the prescribed fix is INCOMPLETE**

`player.tsx:62` is `useEffect(..., [])`. It closes over the mount render's `handleAutoAdvance` (`:166`), which closes over the mount render's `currentClip` — `null` from `useState(null)` at `:35`. `if (!currentClip) return;` at `:167` therefore always returns. The same closure also captures mount-time `duration = 0`, so even if `currentClip` were non-null the completion heartbeat would send `watch_time_ms: 0`.

**The audit's prescribed fix is "Read `currentClip` from `currentClipRef` inside `handleAutoAdvance`". That does not work.** `handleAutoAdvance` calls `nextClip("auto")` at `:176`, and `nextClip` (`:327-343`) has *its own* stale closure:

```ts
const nextClip = (reason) => {
  if (!currentClip || queue.length === 0) return;   // :328 — mount-time values
  ...
}
```

Fixing only `handleAutoAdvance` makes the completion heartbeat fire correctly and leaves `nextClip("auto")` **still dead**. The audit's alternative — "move the listener registration into an effect that depends on `currentClip`" — is the one that actually works, because it re-binds `nextClip` too. **A ref for `currentClip` is not sufficient; `nextClip` needs its own ref, or the whole listener set must be re-created per clip.**

The audit also correctly notes that `:76` uses `currentClipRef` correctly one function up, which is what makes the bug easy to miss. That observation is right and worth keeping.

### 2.3 Would fixing the closure cause a double advance? — **YES, and I can give the exact threshold.**

Mechanism, for a clip of duration `D` seconds:

- ReelList's effect (D) arms its 1000 ms timer at the **first** `timeupdate` where `progress >= 0.99`, i.e. at wall-clock `0.99·D`. Fires at `0.99·D + 1.0`.
- The player's timer (C) arms at `ended`, i.e. at `D`. Fires at `D + 0.8`.

D's timer wins iff `0.99·D + 1.0 < D + 0.8` ⟺ **`D > 20` seconds**.

`MAX_DURATION_SECONDS = 300` (`settings.py:462`, enforced in `serializers.py:338-345`). This product is short-form audio. **For every clip longer than 20 seconds — i.e. essentially the entire catalogue — the ReelList timer fires first, advancing to N+1, and then the player's `nextClip("auto")` fires ~0.4–2.4 s later and advances again to N+2. The user never sees clip N+1.**

For `D <= 20` s the player's timer wins and the outcome is a **skip** instead, because of the stale-`progress` re-arm below.

So the plan's stated risk — *"or the fix yields 1.8 s of dead air per clip"* — is **WRONG**. The real risk is **silently skipping one reel per completion**, which is worse and much harder to spot.

### 2.4 The stale-`progress` re-arm — the mechanism nobody has named

`playClip` (`player.tsx:180-233`) sets `currentClip` (`:184`), `watchTimeRef` (`:185`), `lastTelemetryRef` (`:186`) — and **never resets `currentTime` or `duration`.** Verified: no `setCurrentTime(0)`, no `setDuration(0)` anywhere in the function.

Consequence: between `setCurrentClip(next)` at `:184` and the first `timeupdate` of the new source (a network round trip: token POST + manifest fetch, realistically 50–500 ms), `currentTime` still holds the *previous* clip's final value and `duration` its duration. `progress` (`:360`) is therefore still `>= 0.99`.

`ReelList`'s effect deps are `[currentClip, progress, clips]` (`:106`). `currentClip` changed → effect re-runs → cleanup clears the old timer (`:105`) → the guard `if (!currentClip || progress < 0.99) return;` at `:99` **passes on stale data** → a fresh 1000 ms timer is armed, this time pointing at `index+1` of the *new* clip.

Note also `setCurrentClip` at `:184` runs **before** the `if (!clip.hls_playlist_url) return;` guard at `:191-194`, so even a null-URL clip triggers the re-arm.

### 2.5 Observable symptoms, per variant

| Variant | What the user sees |
|---|---|
| **Current (unfixed)** | Feed auto-advances via ReelList at 99 % + 1 s. **No completion telemetry ever sent** (path C unreachable). On any page without `ReelList` mounted (Inbox, Explore, Profile, and `MiniPlayer`'s context on those routes) a clip **plays to the end and stops dead** — no advance, no error, `isPlaying` goes false via the `pause`/`ended` path, and `playbackError` is `null` so nothing is rendered. The audit's P0-3 symptom is exactly right. |
| **Fix closure, keep both timers** | **Skip one reel per completion** for D ≤ 20 s, **double advance** for D > 20 s. Net: clip N+1 is unplayable. |
| **Fix closure, remove ReelList timer (D)** | Correct single advance at 800 ms — but loses the scroll-snap alignment. `nextClip` advances the *audio*; the scroll position never moves, so after ~5 advances the audio is 5 reels ahead of the viewport and the ReelCard the user is looking at is not the one playing. **The player's path is not a substitute for the scroll: the scroll is what makes the feed a feed.** |
| **Fix closure, remove the player timer (C)** | Correct 1000 ms advance aligned to the scroll — but `logTelemetry` on completion stays dead unless you move it into the `ReelList` effect, and the *only* thing that advances audio is now a component that is not mounted on 4 of 6 routes. |

### 2.6 Two further advance-path defects the audit did not find

**(a) `nextClip` wraps.** `player.tsx:340`: `const nextIndex = (currentIndex + 1) % queue.length;`. With `hasMore={false}` hardcoded (`Feed.tsx:164`), `setQueue(data.results)` (`Feed.tsx:56`) sets a fixed 10-item queue and `loadMore` is never wired. So auto-advance loops the same 10 clips for ever, with no end state. The audit's "wrap vs stop-at-end" question: **it wraps, and there is no stop-at-end anywhere.**

**(b) `nextClip` from a non-Feed route jumps into the feed's queue.** `ReelCard.tsx:130` (`playClip(clip)` with no queue), `Inbox.tsx:52` (`playClip(item.clip)`), `Explore.tsx:50` and `Profile.tsx:277`/`:341` pass a queue, Inbox and ReelCard do not. Because `playClip` only calls `setQueue` when `newQueue` is truthy (`:181-183`), an Inbox clip inherits the last-set queue. `currentIndex = queue.findIndex(...)` is then **-1**, so `nextIndex = 0` and "next" jumps to the feed's first clip. The audit lists this as a minor item 4; it is a correctness bug with a trivial fix (`nextClip` should be a no-op when `currentIndex < 0`).

**(c) `handsFreeMode` is a lie.** `player.tsx:43` declares it; `Header.tsx:137` toggles it; `Feed.tsx:139` renders the label *"Hands-Free Auto-advance: ON"* / *"Manual Navigation Mode"*. **Nothing anywhere reads it as a condition.** `ReelList`'s effect and `nextClip` have no `handsFreeMode` guard. Toggling it off changes a string and nothing else.

### 2.7 Blast radius

- `frontend/src/stores/player.tsx:62-123, 166-178, 180-233, 327-343`
- `frontend/src/components/feed/ReelList.tsx:24, 51, 98-106`
- `frontend/src/components/feed/ReelCard.tsx:126-132, 379-386` (Next acts on `currentClip`, not on its own `clip`)
- `frontend/src/pages/Inbox.tsx:52`, `Explore.tsx:50`, `Profile.tsx:277, 341`, `Feed.tsx:56-61, 164`
- `frontend/src/components/common/Header.tsx:137-148`
- `docs/FRONTEND-REQUIREMENTS.md:880-890` — the requirements doc **prescribes the ReelList 1 s advance as the intended design**. Removing the player timer is a spec change and the doc must move with it.

### 2.8 What a correct fix must preserve

1. **Scroll-snap alignment.** The advance must scroll the container, not just swap the audio.
2. **One advance per completion.** Testable: count `playClip` calls per `ended` event.
3. **The 0.99 threshold and the `clips.length - 1` stop-at-end guard** in `ReelList:101` (which currently silently wraps instead — see 2.6a; note the ReelList path *does* stop at the end, the player path does not).
4. **The manual paths (E, F) must not fire a skip** when the user is past 90 % — `player.tsx:331`.
5. **`playClip` must reset `currentTime`/`duration`** or the re-arm bug recurs in whatever design you pick.

### 2.9 Tests

- Fire `ended` on the mock; advance timers 1200 ms; assert **exactly one** `playClip` call and the expected clip id. This is the test the plan already calls for at §5 and it is the right one.
- Repeat for a 25 s clip and a 15 s clip (straddles the 20 s threshold) — the assertion must hold on both.
- Assert the ReelList effect does not re-arm: after `playClip(N+1)`, assert no second `scrollIntoView` for `N+2` before `N+1` has played.
- Assert that with `currentClip` absent from `queue` (`currentIndex === -1`), `nextClip` is a no-op.
- Assert `handsFreeMode === false` suppresses auto-advance (currently fails).
- Route-level: mount the player with **no** `ReelList` (mirroring Inbox) and assert `ended` still advances. This is the P0-3 symptom and nothing in the current suite covers it.

---

## AREA 3 — HLS resilience: token expiry and retry

### 3.1 Can a clip outlast its token? — **NO. Say so plainly.**

- `MEDIA_TOKEN_TTL_SECONDS = 600` (`settings.py:714`, default, and I confirmed it is not overridden in any `.env*`).
- `MAX_DURATION_SECONDS = 300` (`settings.py:462`), enforced **only** in `AudioUploadSerializer.validate` (`serializers.py:338-345`) — a server-side probe with pydub, rejecting `> max_seconds` with a 400. It is not enforced in the Celery task and not in the serializer's `max_value` sense, but the upload boundary is the right place and it is real.
- Ratio 2:1. A clip cannot outlast its token during continuous playback.

hls.js additionally buffers ahead (default `maxBufferLength` 30 s), so for a 300 s clip every segment is fetched inside the first ~300 s of wall-clock — comfortably inside 600 s.

### 3.2 The *real* expiry path — a pause, not a clip length

Two mechanisms, both real:

1. **The cookie's `Max-Age`.** `views/media.py:264` sets `max_age=ttl`, so the browser **drops the cookie 600 s after issuance regardless of activity**. This is independent of the token's own `exp`. A user who pauses for 11 minutes and hits play gets no cookie at all.
2. **The `exp` check on the edge.** `token.ts:138`: `if (nowSeconds > payload.exp) return null;` → `index.ts:155` → 403.

A correct fix must also note: `playClip` re-mints on **every clip switch** (`:211-213`), so the 600 s clock resets on each advance. In practice the only way to hit expiry is a long pause, a backgrounded tab (mobile Safari suspends timers and often the media element), or a device sleep.

### 3.3 The retry loop is unbounded — audit **CONFIRMED**

```ts
hls.on(Hls.Events.ERROR, (_evt, data) => {
  if (!data.fatal) return;
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    hls.startLoad();                       // player.tsx:258
  } else {
    hls.destroy(); hlsRef.current = null; setPlaybackError("Playback failed");
  }
});
```

There is no counter, no backoff, no ceiling, and — critically — **the token is never re-minted**. `getPlaybackToken` is called only from `playClip` (`:212`).

hls.js's *own* retry policy is finite per load attempt (`fragLoadPolicy.maxRetry` / `playlistLoadPolicy`), but it **escalates to a fatal error when exhausted, and this handler calls `startLoad()` again, resetting the counter.** So the sequence is: retry N times → fatal → `startLoad()` → retry again, forever, for the life of the session. A segment 403 from an expired token is a `NETWORK_ERROR` (non-2xx), so an expired token is precisely the case that lands in the `startLoad()` branch and can never recover.

Cost quantification: each retry round hammers the media edge. It does *not* burn the token-mint budget (no re-mint), but see 3.5 for what does.

### 3.4 The native/Safari path has **no error handling at all**

`player.tsx:265-277`:
```ts
audio.crossOrigin = "use-credentials";
audio.src = url;
audio.playbackRate = playbackRate;
setPlaybackError(null);
audio.play().catch((err) => { console.warn("Auto-play blocked, ...", err); });
```

No `audio.error` listener is ever registered — the mount effect (`:108-111`) registers only `timeupdate`, `play`, `pause`, `ended`. A 403 manifest on Safari/iOS produces a `MediaError` on the element that **nothing observes**. `setPlaybackError(null)` is called unconditionally on the way in, so the state is actively *cleared* right before the failure. Safari users get a silent, permanent, errorless dead player.

Also: `audio.playbackRate = playbackRate` is set here from the closure, but `setRate` (`:353-358`) also writes `audioRef.current.playbackRate` — so the rate survives clip switches on the hls.js path (hls.js manages MSE playbackRate) and on the native path via the setter. That part is fine.

### 3.5 The self-inflicted 429 loop the audit did not find

`playback_token: 300/min` (`settings.py:800`). Now combine 2.4 with 3.4:

1. A clip's load fails (403, network blip, Worker down).
2. `currentTime`/`duration` are never reset, so `progress` is stuck at whatever the previous clip left it — frequently `>= 0.99`.
3. ReelList's effect re-arms on every `currentClip` change and **passes the stale-progress guard**.
4. Each re-arm scrolls to the next reel → `IntersectionObserver` fires → `playClip` → **another `getPlaybackToken` POST**.
5. Within seconds the user is at 300/min. Every subsequent play attempt 429s.
6. `getPlaybackToken` (`client.ts:439-445`) attaches `error.status`, and the player's mapping (`:223-231`) has no 429 branch, so it falls to `"Playback unavailable"` — which is never rendered.

The user is permanently locked out of playback with no message and no recovery. **This is the most likely real-world failure mode in the whole player**, and it is a compound of three separate defects (no `currentTime` reset, unmemoized `playClip` identity churning the effect, unmapped 429).

### 3.6 What the doc gets wrong

`docs/EXPLAIN/storage/04-hls-token-protection.md`, §"Token Refresh" (lines 275-278):

> *"The frontend proactively fetches a new token when the old one is about to expire: If the current token expires in < 120 seconds, request a fresh one … If the user's JWT has expired, the token request returns 401 and the frontend triggers session refresh via the existing `refreshToken` mechanism in `frontend/.../api/client.ts:54-63`."*

**Both sentences describe code that does not exist, and the first is not implementable as written for the web transport.**

- There is no proactive re-mint anywhere. `getPlaybackToken` is called from `playClip:212` only.
- **The web client cannot know its token's expiry at all.** The token is in an `HttpOnly` cookie (`media.py:265`) — script cannot read it. The body token is only returned to native callers (`media.py:128`). So "if the current token expires in < 120 s" is not a thing a browser client can evaluate. The doc's design assumed a readable token.
- `client.ts:54-63` is `setStoredUser`, not `refreshToken`. The real refresh is `refreshAccessToken` at `client.ts:67-109` — and `getPlaybackToken` **does not call it**, because it uses raw `fetch` (audit P0-5, CONFIRMED — see §4). A 401 from the token endpoint therefore does nothing at all: no refresh, no `ef_session_expired` dispatch, no sign-in prompt. The user sees `"Playback unavailable"`.

Also: `04-hls-token-protection.md:736` references `workers/hls-token-worker/src/config.ts`, which **does not exist** (`ls` fails; the directory is `index.ts`, `storage.ts`, `storage.test.ts`, `token.test.ts`, `token.ts`).

### 3.7 The credential transports a correct fix must keep working

From `token.ts:201-205` and `media.py:80-130` — the fix must preserve **all three**:

1. **Cookie** (`ef_hls_token`) — the web path. Requires `xhr.withCredentials = true` in hls.js (`player.tsx:244-246`) and `crossOrigin = "use-credentials"` on the native-Safari path (`player.tsx:270`). Both are load-bearing: the media origin is cross-site in prod, and the comment at `:266-269` is correct that `anonymous` uses same-origin credentials mode.
2. **`X-EchoFlow-Media-Token` header** — the native path, opt-in via `X-EchoFlow-Client: native` on the *mint* request only.
3. **Cookie-first precedence** (`token.ts:202-204`). Do not invert it. A web page's own script can set an arbitrary request header but cannot read the `HttpOnly` cookie, so making the header authoritative would let any script on `app.echoflow.in` choose which credential the edge validates. The comment at `token.ts:189-199` is correct and load-bearing.

Also preserve: **`hls_playlist_url` used verbatim.** No prefixing (`:196-200`, `FRONTEND-REQUIREMENTS.md:1532-1535`). The edge is bucket-less in `edge` url style (`media_urls.py:75-77`) and the Worker rejects any path not starting `/hls/` (`index.ts:126`).

And: **no unauthenticated fallback.** The comment at `player.tsx:207-210` is right. `docs/EXPLAIN/frontend/06-frontend-fix-plan.md:20, 114, 338-346` prescribes *"token-first with graceful fallback to direct HLS"* — the plan's §note at line 175 already correctly rejects that. It must not be implemented.

### 3.8 Tests

- `hls.js` is **not mocked** anywhere in the harness (grepped `frontend/src/test/` and the vitest config — zero hits). A bounded-retry fix is untestable until there is an `hlsMock.ts` alongside `mediaMock.ts`. That is a prerequisite, not a nice-to-have.
- With a mock: emit 20 fatal `NETWORK_ERROR` events; assert `startLoad` was called at most N times and that `getPlaybackToken` was called at most twice.
- Emit a fatal `NETWORK_ERROR` with `response.code === 403`; assert the player re-mints **once** and then surfaces an error state rather than looping.
- Assert the native path registers an `error` listener on the audio element and that a `MediaError` sets `playbackError` (currently fails — nothing listens).
- Assert `err.status === 401` from `getPlaybackToken` calls the same refresh path as `apiRequest` (currently fails).
- `getPlaybackToken` should route through `apiRequest` so the 401 interceptor applies for free — that is the cheapest correct fix and it also picks up 429 `Retry-After` handling if added.

---

## AREA 4 — `playbackError` and the 409 path

### 4.1 `playbackError` has zero consumers — audit **CONFIRMED, exactly**

```
frontend/src/stores/player.tsx:16    playbackError: string | null;              (type)
frontend/src/stores/player.tsx:51    const [playbackError, setPlaybackError] = useState<string|null>(null);
frontend/src/stores/player.tsx:374   playbackError,                              (context value)
frontend/src/test/reelCard.test.tsx:49  playbackError: null,                      (mock)
```

Three production occurrences, all in the store. `ReelCard` and `MiniPlayer` do not destructure it; `ReelCard.tsx` has exactly one error state, `followError` (`:59`, `:237`). The entire 409/403/404 mapping at `:223-231` and both `setPlaybackError` calls (`:223`, `:262`) and the `setPlaybackError(null)` calls (`:252`, `:273`) write into a void.

The audit's sub-item 13 ("the 401 case is documented but not implemented") is also confirmed: the comment at `:220-222` names four mappings, the code at `:223-231` delivers three plus a default, and there is no 429 branch.

### 4.2 What returns 409, and how long the window is open — the audit is **IMPRCISE, and the prescribed fix is WRONG**

`media.py:239-247`:
```python
clip_key = _extract_clip_key(clip.hls_playlist_url)
if clip_key is None:
    return Response({"detail": "Clip media is not ready."}, status=409)
```

`_extract_clip_key` → `clip_storage_key` returns `None` for a falsy `hls_playlist_url` (`media.py:58-70`).

**Window analysis.** In `tasks.py`:
- `clip.moderation_approved = True` at **`:340`**
- `clip.hls_playlist_url = f"{storage_prefix}/master.m3u8"` and `clip.status = 'ready'` at **`:403-404`**

So the 409 window is the HLS encode + object-store upload between `:340` and `:404`. For a 5-minute clip with Whisper + sentence-transformers ahead of it, that is tens of seconds.

**But: can the feed even serve a clip inside that window?** Partially — and this is the important nuance.

- `FastFeedViewSet`'s primary path (`views/feed.py:109-121`) filters on `moderation_approved=True`, `is_noncommercial=False`, `requires_share_alike=False` — and **NOT** on `status='ready'`, and **NOT** on `hls_playlist_url`. The `status='ready'` filter appears only in the degraded fallback (`:135`) and in the pool builders (`feed_pool.py:141`, `:214`).
- In the steady state the queue is populated from `feed_pool`, which *does* filter `status='ready'`, so a 409-window clip cannot get in. The gap is theoretical, not live.
- **Where it IS live: `ShareEventSerializer.clip`** (`serializers.py:563-585`) is a `FeedClipSerializer(read_only=True)` on `obj.clip` with **no status filter whatsoever**. A share created while the clip is between `:340` and `:404` serializes `hls_playlist_url: null`, and `Inbox.tsx:52` hands it straight to `playClip`. Same for `PublicClip` and the profile/liked-clips paths.

### 4.3 Client-side polling for 409 is the wrong fix. Quantified.

Three independent reasons:

1. **The feed does not filter on `hls_playlist_url`, so the feed can serve unencoded clips.** The primary feed query has no readiness predicate. Client polling papers over a server-side queryset bug instead of fixing it. The one-line fix is adding `.filter(status='ready')` to `views/feed.py:111` — which is a **backend** change and belongs in the same commit as any client 409 work.

2. **A 409 is not reliably transient.** It is "no HLS key", which covers: still encoding, **permanently failed** (`status='failed'` at `tasks.py:200/225/259/347/378` — those clips never get a key), or HLS cleaned up out of band. A clip that is `status='failed'` will 409 **forever**. Polling it burns requests and never resolves. A bounded retry (2–3 attempts over ~10 s) is defensible; unbounded polling is not.

3. **There is no cheap way to poll.** `router.register(r'clips', AudioUploadSerializer)` (`urls.py:52`) — the retrieve action inherits from `ModelViewSet`, so `GET /clips/{id}/` does exist and does return `status` (`read_only_fields` includes it). `FRONTEND-REQUIREMENTS.md:621-628` says exactly this, and `:1557` contradicts it ("Clip status (post-upload) | not needed"). So the endpoint exists; the requirements doc is internally inconsistent. But polling it every 1.5 s for an unbounded window is worse than showing an honest error.

**The `hls_playlist_url: null` case does not even reach the 409 branch.** `playClip` at `:191-194`:
```ts
if (!clip.hls_playlist_url) {
  console.warn("Clip has no playable stream URL yet.");
  return;
}
```
It returns **before** `getPlaybackToken` is called — after `setCurrentClip` at `:184` has already run. So the user gets: that clip becomes `currentClip` (`isActive` on the card), `isPlaying` stays false, `playbackError` stays `null`, and a `console.warn` nobody sees. **The information needed to render a correct message is in the client's hands at `:191` and is discarded.** A fix that only touches the 409 branch will not fix this case, which is the one that actually occurs.

### 4.4 Blast radius

- `frontend/src/stores/player.tsx:191-194, 211-232`
- `frontend/src/components/feed/ReelCard.tsx:37-52` (add `playbackError` to the destructure), `MiniPlayer.tsx:10-18`
- `frontend/src/components/common/ErrorBoundary.tsx` — a player-level error surface
- `backend/app/views/feed.py:111` — **add `.filter(status='ready')`**
- `backend/app/serializers.py:563-585` — `ShareEventSerializer.clip` needs a readiness predicate
- `docs/FRONTEND-REQUIREMENTS.md:621-628` and `:1557` — mutually contradictory, pick one

### 4.5 Tests

- 409 → `playbackError === "Still processing…"`, rendered in the DOM (currently fails: nothing renders).
- 403 / 404 / 429 / 401 → four distinct rendered strings; assert the *401* case specifically, since the comment already promises it.
- `hls_playlist_url: null` → rendered error, **not** a silent no-op (currently fails).
- Feed contract test: assert `FastFeedViewSet` never returns a clip whose `hls_playlist_url` is null, with a `processing`+`moderation_approved=True` row in the DB. This is the backend test that would have caught the queryset gap.

---

## AREA 5 — Edge cases and crash surfaces (exhaustive)

### 5.1 The 60 Hz re-render — **the largest defect in the file, and the audit does not mention it**

`player.tsx:138-164`:
```ts
const update = () => {
  if (isPlaying) {
    setAudioFrequencies(PHASES.map((phase, i) => { ... }));   // new array, every frame
  } else {
    setAudioFrequencies(PHASES.map((_, i) => 8 + ...));        // new array, every frame
  }
  raf = requestAnimationFrame(update);
};
raf = requestAnimationFrame(update);
```

`setAudioFrequencies` is called **unconditionally on every animation frame**, always with a fresh array. React compares by `Object.is`, so this is a guaranteed state change: **60 renders/second of the entire provider subtree, for as long as audio is playing.**

The context value at `:364-388` is a plain object literal with **no `useMemo`**, and the eight `usePlayer()` consumers are:

```
pages/Explore.tsx:27   pages/Feed.tsx:27   pages/Profile.tsx:26   pages/Inbox.tsx:16
components/feed/MiniPlayer.tsx:18   components/feed/ReelCard.tsx:52
components/feed/ReelList.tsx:51   components/common/Header.tsx:48
```

`ReelCard` is rendered once per feed item, and the feed is 10 items. So while a clip plays: **10 `ReelCard`s + `ReelList` + `MiniPlayer` + `Header` + the page, 60 times a second.** Each `ReelCard` runs 3 `useEffect`s (`:68-78`) and re-evaluates the fabricated-vector arithmetic at `:149-150`. On a mid-range phone this is the difference between a smooth feed and a hot, janky, battery-draining one.

Compounding it: `handleTimeUpdate` fires ~4 Hz and calls `setCurrentTime` + `setDuration`, so even with the rAF loop fixed the tree re-renders 4×/s.

The comment block at `:125-137` is honest that the envelope is decorative and that a real `AnalyserNode` is out of scope. **But "deterministic and reproducible" was the wrong optimisation target** — a decorative effect that costs 60 full-subtree renders per second is not decorative, it is the app's main thread. At minimum: drive it from `setInterval` at ~10 Hz, or (better) drop the state entirely and compute the bars in `MiniPlayer`'s own render from `currentTime`, which it already receives.

### 5.2 The `playClip` identity churns the ReelList observer 4×/s

`ReelList.tsx:95`: `useEffect(..., [clips, playClip])`. `playClip` is a fresh function identity on every provider render (`:180`, not memoized, not `useCallback`). Combined with 5.1, the autoplay `IntersectionObserver` is **disconnected and rebuilt up to 60 times per second**, each rebuild re-running `itemRefs.current.forEach(ref => ref && observer.observe(ref))` over every feed item. The `currentClipRef` id guard at `:86` prevents re-`playClip`, so it is not *incorrect* — it is a full observer teardown/setup storm.

`itemRefs.current` (`:50`) is indexed by position and **never truncated** when `clips` shrinks. Every position ever rendered keeps a reference in the array, so a long session that pages the feed accumulates detached DOM nodes.

The pagination sentinel (`:61-73`) is inert: `Feed.tsx:164` hardcodes `hasMore={false}` and passes no `loadMore`, so `if (entry.isIntersecting && hasMore && !loading) loadMore()` never fires. `sentinelRef` is also assigned to `clips.length - 2` (`:123`), which is `-1` for a 1-clip feed and never set.

### 5.3 Race conditions on clip switch

**(a) Superseded-mint guard is present and correct** — `player.tsx:214` and `:218` both check `currentClipRef.current?.id !== clip.id`. Good. But the check happens *inside* `.then`, and `currentClipRef` is synced by a `useEffect` (`:53-55`), which runs **after** render. `setCurrentClip` at `:184` and the ref update at `:54` are in the same commit, so by the time a `.then` microtask runs the ref is current. This one is fine — worth stating so nobody "fixes" it.

**(b) `hls.destroy()` on the outgoing instance does not reliably fire `pause`.** `handlePause` (`:92-102`) is the **only** place the final-telemetry heartbeat is sent on a non-completion exit. `hls.destroy()` detaches the media element and resets it, but the HTML spec's `load()` algorithm fires `emptied`/`abort`, not `pause`. So switching clips mid-playback likely **drops the pause telemetry** for the outgoing clip. Not a security issue; a data-quality one.

**(c) The 800 ms timer is never cleared.** `player.tsx:175` — `setTimeout` with no handle, no cleanup. If the component unmounts (route change) inside those 800 ms, the callback still fires and calls `nextClip("auto")` → `playClip` → `setCurrentClip` on an unmounted provider. React 19 no longer warns about this, so it is silent. The provider is hoisted above the tab switch (`frontend_rebuild_plan.md:522`), so unmount is rare — but `ErrorBoundary` recovery and HMR both unmount.

**(d) Rapid scroll.** Each `IntersectionObserver` entry above 0.6 calls `playClip(clip, clips)` (guarded by id, so once per clip). Ten rapid flicks = ten `getPlaybackToken` POSTs in flight. Each mints a cookie; the last one wins in the browser jar, and the earlier nine responses **overwrite `ef_hls_token` with a token scoped to a *different* clip** if they land out of order. The outgoing `hls.startLoad()` for a superseded clip is not cancelled (the guard only skips `loadSource`), so a slow manifest response for clip A can attach to the audio element **after** clip B was loaded. `playback_token` is `300/min`, so ~10 is fine — but there is no `AbortController` anywhere in `client.ts`.

**(e) `togglePlay` on a dead source.** `:287-289`: if `readyState === HAVE_NOTHING`, call `audio.load()`. `load()` on a `use-credentials` cross-origin src re-issues the manifest request. If the token has expired, this produces a 403 that **nothing observes** (see 3.4) and the element sits at `readyState 0` forever, with `play()` resolving (or rejecting silently) and no error state.

### 5.4 `duration_ms: 0` — a silent fail-open

- `record_telemetry`: `clip_duration = max(clip.duration_ms, 1)` (`:282`) → `completion_rate = min(watch_time_ms / 1, 1.0)` = **1.0 for any nonzero heartbeat.** A zero-duration clip grants a perfect completion on the first heartbeat, with no error and no log.
- `_completion_rate`: falls back to `expected_duration = 60_000` (`:186`) with a comment admitting it is "weaker than the clip duration". A 5-second clip reporting `listen=5000` scores 0.083 instead of 1.0.

`duration_ms` defaults to `0` (`models.py:134`) and is only set at `tasks.py:265`, before `status='ready'` at `:404`. So a `ready` clip always has `duration_ms > 0` via the normal path — but the field is **fail-open at the arithmetic level**, and any legacy row, any manually-created row, or any future code path that reaches a non-ready clip (see 4.2, the ShareEvent serializer) turns a data-quality bug into a ranking one. A `max(duration_ms, 1)` should be a `if duration_ms <= 0: return 0.0` or an explicit reject.

### 5.5 Other concrete failure surfaces

| Surface | Evidence | Effect |
|---|---|---|
| **Unhandled promise rejections** | `client.ts:433-437` `fetch(...)` has no `.catch`; `player.tsx:211-232` has a `.catch` on the chain, so covered. But `apiRequest` (`:133`) has **no** `try/catch` around its two `fetch` calls | A network error on any API call rejects to the caller. Every current caller `.catch()`es — except `ReelCard.tsx:91` (has try/catch ✓) and `Feed.tsx:34` (try/catch ✓). Currently safe; one new caller without a catch is an unhandled rejection. |
| **Unbounded timers** | `player.tsx:175` (800 ms, no handle). `ReelList.tsx:102` (1000 ms, **has** cleanup ✓) | The 800 ms one leaks across unmount. |
| **Listener cleanup** | `player.tsx:113-122` removes all four and destroys `hlsRef.current` — correct, and the mount effect is `[]` so it runs once. | ✓ no leak here. But `hlsRef.current = null` is **not** set in the cleanup, so after unmount the ref holds a destroyed instance; harmless because the provider is gone. |
| **Memory: `hls` instance leak** | `player.tsx:202-205` destroys the outgoing instance in `playClip` ✓. But the **native path never clears a previous `hlsRef`**: `loadSource` (`:270-271`) sets `audio.src` without touching `hlsRef` — it *is* cleared at `:202` before the branch, so ✓. | OK. The real leak is `itemRefs` (5.2). |
| **`console.warn` as user feedback** | `player.tsx:192, 275, 291, 304` | Four distinct failure modes communicate only to devtools. In production these are the *only* signal the user gets for a null-URL clip, an autoplay block, and a failed resume. |
| **`prevClip` (`:345-351`) and `volume` (`:41`)** | Exposed on the context; **zero consumers** (grepped all of `frontend/src/`). `volume` has `_setVolume` — an unused setter, so the value can never change. | Dead API surface. Two context fields that can never be non-default. |
| **Scrub to end forces an advance** | `seek` (`:311`) clamps to `audio.duration`. `skipForward(10)` on a clip at `D-5` sets `currentTime = D` → `timeupdate` → `progress = 1.0` → ReelList arms the 1000 ms advance. And `nextClip("manual")`'s skip guard (`:331`) reads `currentTime < (duration || 20) * 0.9` — at `D/D` that is false, so **no skip is recorded**. | A user can run an entire feed with 6 taps of "Skip +10s" per clip and register **zero** skips and **zero** completions. Both `skips` (a `feed_pool` ranking input) and the completion signal are evaded. Ranking-relevant. |
| **Telemetry on `pause` fires even at `currentTime ≈ 0`** | `:96` `if (clip && audio.currentTime > 0)` | A pause immediately after a clip switch still sends the **previous** clip's id with the new clip's position, because `currentClipRef` is updated by a `useEffect` after render. Narrow race; low impact. |
| **No `error` listener on the audio element** | `:108-111` | Safari/native failures are unobservable. See 3.4. |
| **No `stalled` / `waiting` / `canplay` handling** | — | On a slow network the user gets no buffering indicator; `isPlaying` is true (the element is technically playing) while nothing comes out of the speakers. |

---

## Recommended fix order

Ordered by **(severity × certainty) / blast radius**, and deliberately sequenced so that no intermediate commit is left in a worse state than the one before it.

| # | Commit | Why here | Depends on |
|---|---|---|---|
| **1** | `fix(player): memoize the context value and throttle the envelope` | 60 renders/s of the whole app (5.1) is the highest-severity item and touches only `player.tsx:138-164, 362-392`. Purely internal — zero behavioural risk — and it makes every subsequent player test fast. Doing this first means you are not debugging timing-dependent failures through a 60 Hz re-render storm. | — |
| **2** | `fix(player): reset currentTime/duration in playClip; make 409/429/clock errors non-sticky` | The root cause of the self-inflicted 429 lockout (3.5) and of the stale-`progress` re-arm (2.4). Two lines, and it makes any advance fix deterministic. | 1 |
| **3** | `fix(feed): one advance path, with a real stop-at-end` | Pick **one** mechanism. My recommendation: keep `ReelList`'s scroll as the single driver, move the completion telemetry into its effect, and **delete** `player.tsx:166-178` + the two call sites. Reverse of the plan's §1.3, and the reason is in 2.3: the player path cannot hold scroll alignment, and the 20 s threshold makes "fix closure, keep both" a skip machine. If you keep the player path instead, you must also make it scroll — which means it has to reach into `ReelList`, so the split is artificial. | 2 |
| **4** | `fix(telemetry): measure watch time, not media position` | Pure data quality. Also delete `watchTimeRef`. **Update `FRONTEND-REQUIREMENTS.md:285-286, 880-890, 1229-1234` in the same commit** — all three currently prescribe the exploit, and commit 3 changes the ReelList description at :880. | 3 (so the completion-telemetry move lands in the right place) |
| **5** | `fix(player): bound hls retries, re-mint once, observe the native path` | Requires a new `hlsMock.ts`. Independent of everything above. | 1 (harness speed) |
| **6** | `fix(player): render playbackError; map 401/429; route getPlaybackToken through apiRequest` | Now the error states from 3, 4, 5 have somewhere to go. Routing the token mint through `apiRequest` (`client.ts:115`) is a 10-line change that gets the 401 refresh, `ef_session_expired`, and 429 handling for free. | 3, 5 |
| **7** | `fix(backend): filter FastFeedViewSet on status='ready'; scope ShareEventSerializer.clip` | `views/feed.py:111` + `serializers.py:563`. Closes the server-side cause of the 409 so the client never has to guess. Should arguably precede 6, but it is a backend change and this pass is frontend-scoped. | — |
| **8** | `docs: correct 04-hls-token-protection.md §Token Refresh and the FRONTEND-REQUIREMENTS telemetry sections` | The doc currently describes unimplemented, and for the web transport unimplementable, behaviour. If this lands after 4 and 5 it is a description of reality; before, it is a wish. | 4, 5 |

**Do not put 3 before 2.** With the stale-`progress` re-arm live, any advance-path change produces a skip that looks like a logic error in the new code and costs a debugging cycle.

---

## Items I recommend deliberately **NOT** fixing for an MVP

1. **Server-side verification that `watch_time_ms` is honest.** There is no way to do it. The client is the only witness. A server can bound the *rate* (it does: `36_000_000` cap, `60/min` throttle) but cannot distinguish a 600 s position claim from 600 s of playback. **The realistic mitigation is a trust-and-behavioural-signal design** (detect implausible jumps, weight by session history, cap the influence of a single interaction), not a validation. Do not build a "verify watch time" feature; build nothing, and document the residual risk. *This is the one place where I would push back on the plan's framing entirely.*

2. **Making `avg_completion_rate` fully server-derived.** The commit `20f6e7e` fixed the ratio. Going further (dropping the numerator to a server-side estimate) requires the server to know playback, which it does not. The 0.30 weight on a client-asserted-in-[0,1] value is an accepted residual risk, documented in `record_skip`'s own docstring. Not an MVP problem.

3. **`prevClip`, `volume`, `handsFreeMode` gating.** `prevClip` and `volume` are dead API surface (5.5) — delete them or leave them; neither costs anything at runtime. `handsFreeMode` *is* a user-facing lie (2.6c) and the cheapest honest fix is to gate `ReelList`'s effect on it, which is one line and lands naturally inside commit 3. Do it there; do not make it its own commit.

4. **The `harness`-level fix for `IntersectionObserver` churn (5.2).** It is real but the id-guard makes it *incorrect* only in theory. Memoizing `playClip` with `useCallback` (deps: `queue`, `setQueue`, nothing else — all the mutable reads go through refs) fixes it as a side effect of commit 1. Do not treat it as a separate item.

5. **Backend polling for clip status after upload.** `FRONTEND-REQUIREMENTS.md:1557` is right and `:621-628` is wrong: the user can navigate away. Out of scope, and `GET /clips/{id}/` returning a 100 MB-capped `AudioUploadSerializer` payload for a status poll is a poor trade either way.

6. **The fabricated telemetry panels in `ReelCard` (`:149-150`) and the ABR/bitrate readouts.** Correctly identified by the audit, correctly out of scope for a media/player pass, and already scheduled in the plan as commit 12. They are a *truthfulness* problem, not a *player* problem. Do not let them get bundled into a player commit — bundling is how the `progress`-reset fix ends up unreviewable.

---

## Blunt summary of the audit's accuracy

- **P0-2 (watch_time_ms is position):** right about the mechanism, wrong about the blast radius. Telemetry does **not** reach the 30 %-weighted `avg_completion_rate` under the default stream config — I traced it to the two `add_completion` call sites and there are only two. It reaches the *user-vector* dwell weight instead. The `register-skip` path is the one that writes the 30 % field, and it is still fully client-asserted (bounded, but asserted). Wrong line number.
- **P0-3 (auto-advance dead):** right, and the symptom description ("stops dead" off-feed) is exactly correct. **The prescribed fix does not work** — it repairs `handleAutoAdvance` but leaves `nextClip`'s own stale closure, so `nextClip("auto")` stays dead. It also mischaracterises the double-advance risk as "1.8 s of dead air"; the real outcome is a skipped reel per completion, with a 20 s threshold I can derive exactly.
- **P0-5 (token mint bypasses the 401 interceptor):** right, exactly. And `04-hls-token-protection.md:275-278` documents behaviour that does not exist and, for the web transport, cannot.
- **P0-9 (unbounded retry, no re-mint):** right. The Safari/native half of it is *worse* than stated — there is no error listener on the audio element at all, and `setPlaybackError(null)` runs immediately before the failure.
- **Item 11 (`playbackError` has zero consumers):** right, exactly, and the grep is exhaustive.
- **Item 12 (409 sets a message and never retries):** the conclusion is right but the *reason* is wrong. Polling is the wrong fix, because `FastFeedViewSet` does not filter on `status='ready'` and `ShareEventSerializer.clip` has no readiness predicate at all — the feed genuinely can serve unencoded clips, and the 409 is as likely to be permanent as transient.
- **Item 14 (skip guard incoherent):** right that `listen_duration_ms == reel_position_ms`, but the 0.9/0.99 mismatch has a *worse* consequence the audit missed — combined with the seek clamp, a user can skip an entire feed with "Skip +10s" and register zero skips.
- **Missed entirely, and in my judgement the two most severe items in the file:** the 60 Hz full-subtree re-render from the decorative envelope, and the 429 self-lockout that compounds the un-reset `currentTime` with the unmapped 429 and the unmemoised `playClip`.
</task_result>
</task>